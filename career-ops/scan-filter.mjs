#!/usr/bin/env node
/**
 * scan-filter.mjs — Pre-filter pipeline URLs by visa/sponsorship eligibility.
 *
 * Reads `data/pipeline.md` Pendientes section, fetches each URL's JD text,
 * checks for sponsorship-block language, and marks failing URLs as
 * `[x] #--- ... SKIP-VISA | reason: ...` so they don't waste eval cycles.
 *
 * Usage:
 *   node scan-filter.mjs              # filter all current Pendientes
 *   node scan-filter.mjs --dry        # report only, don't write
 *   node scan-filter.mjs --url=...    # check one URL
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = __dirname;
const PIPELINE  = join(ROOT, 'data', 'pipeline.md');
const HISTORY   = join(ROOT, 'data', 'scan-history.tsv');
const TODAY     = new Date().toISOString().split('T')[0];

const args = process.argv.slice(2);
const DRY  = args.includes('--dry');
const ONE  = args.find(a => a.startsWith('--url='))?.split('=')[1];

// ─── Sponsorship-block phrase detector ────────────────────────────────────────

const VISA_BLOCKERS = [
  // Hard sponsorship denials — broad proximity match catches all real-world phrasings
  /\bnot\s+eligible\s+for\s+(?:visa\s+|work\s+)?sponsorship\b/i,
  /\bsponsorship\s+is\s+not\s+(?:available|offered|provided)\b/i,
  /\bdo\s+not\s+require\s+(?:visa\s+)?sponsorship\s+now\s+or\s+in\s+the\s+future\b/i,
  /\bno\s+(?:future|current)?\s*(?:visa\s+)?sponsorship\s+(?:available|provided)\b/i,
  /\b(?:future\s+)?sponsorship\s+(?:is\s+)?unavailable\b/i,
  /\bvisa\s+sponsorship\s+(?:is\s+)?(?:not|unavailable|unsupported)/i,

  // The catch-all "[subject] [negative-verb] [action-verb] ... visa/sponsor"
  // Handles: "unable to support work visas", "not able to sponsor", "cannot provide sponsorship",
  //          "we do not sponsor", "will not offer visa sponsorship", etc.
  /\b(?:unable|not\s+able|cannot|will\s+not|do(?:es)?\s+not|are\s+not)\s+(?:to\s+)?(?:offer|provide|support|sponsor|extend)\b[^.]{0,40}(?:visa|sponsor|work\s+permit|h-?1b)/i,

  // Direct "we don't/cannot sponsor" without preceding action verb
  /\b(?:we|company|employer|this\s+(?:role|position|company))\s+(?:does\s+not|do\s+not|cannot|are\s+unable|is\s+unable|won'?t)\s+(?:offer\s+|provide\s+|support\s+)?sponsor/i,

  // Indefinite/permanent work auth (= no <YOUR_WORK_AUTH_STATUS>) — proximity match
  /\bindefinite(?:ly)?\b[^.]{0,20}(?:work\s+auth|authoriz)/i,
  /\bpermanent\s+work\s+auth/i,
  /\bunrestricted\s+work\s+auth/i,
  /\bauthorized\s+to\s+work\s+in\s+the\s+US\s+(?:without|on\s+a\s+permanent)/i,
  /\bwithout\s+(?:current\s+or\s+future\s+)?sponsorship\b/i,

  // Citizenship-only roles
  /\bmust\s+be\s+(?:a\s+)?US\s+citizen\b/i,
  /\bUS\s+citizenship\s+(?:required|is\s+required|is\s+a\s+requirement)/i,
  /\bonly\s+US\s+citizens\b/i,
  /\bUS\s+citizens\s+only\b/i,

  // Federal / clearance / export control (citizen-only proxies)
  /\bsecurity\s+clearance\b/i,
  /\bactive\s+(?:secret|top\s+secret|TS\/?SCI)\b/i,
  /\b(?:TS\/?SCI|SECRET\s+clearance)\b/i,
  /\bpublic\s+trust\s+clearance\b/i,
  /\bITAR\b/,
  /\bexport[ -]controlled\s+(?:role|technology|information)/i,
  /\bexport\s+control\s+regulations\b/i,

  // SkillBridge etc (military-only)
  /\bSkillBridge\b/i,
  /\btransitioning\s+(?:service\s+)?member\b/i,

  // EU posting markers — German/French job-board formatting suffixes
  // (These appear in titles or JD bodies of EU-only roles even when "US Remote" is in metadata)
  /\(m\/f\/d\)/i,
  /\(m\/w\/d\)/i,
  /\(h\/f\)/i,
  /\(w\/m\/x\)/i,
  /\(m\/v\)/i,

  // EU/non-US city names that strongly imply non-US-only roles
  // Conservative list — only flag when paired with "based in" / "office in" / "located in"
  /\b(?:based|office|located|HQ)\s+in\s+(?:Berlin|Frankfurt|Munich|Hamburg|Paris|London|Dublin|Amsterdam|Madrid|Barcelona|Rome|Milan|Tel\s*Aviv|Bangalore|Hyderabad|Mumbai|Pune|Singapore|Tokyo|Sydney|Sao\s*Paulo)\b/i,

  // Country exclusions where US is NOT in the list
  // (this is harder — we just flag "eligible countries:" or "we hire in:" if US absent later)
];

const VISA_FRIENDLY_HINTS = [
  /\bsponsor\s+h-?1b\b/i,
  /\bvisa\s+sponsorship\s+available\b/i,
  /\bwill\s+sponsor\s+(?:visa|h-?1b)\b/i,
  /\bsponsorship\s+(?:is\s+)?(?:available|provided|offered)\b/i,
];

// Country eligibility check — flag when JD lists countries and US is missing
function checkCountryExclusion(text) {
  // Look for "eligible countries: X, Y, Z" or "we hire in: A, B, C"
  const patterns = [
    /eligible\s+countries?\s*:?\s*([^.]{10,200})/i,
    /(?:we\s+)?hire\s+(?:in|from)\s*:?\s*([^.]{10,200})/i,
    /this\s+role\s+is\s+open\s+to\s+candidates\s+(?:in|from)\s*:?\s*([^.]{10,200})/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) {
      const list = m[1].toLowerCase();
      // If the list mentions specific countries and not US/USA/United States
      const hasCountries = /\b(uk|england|britain|germany|deutschland|france|spain|portugal|brazil|canada|argentina|estonia|italy|netherlands|ireland|japan|singapore|australia|india|mexico|colombia|poland|romania|sweden|denmark|norway|finland|switzerland|austria|belgium|israel)\b/.test(list);
      const hasUS = /\b(us|usa|united states|u\.s\.)\b/.test(list);
      if (hasCountries && !hasUS) return `Eligible countries listed but US not included: "${m[1].trim().slice(0,80)}..."`;
    }
  }
  return null;
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────

async function fetchJDText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (career-ops scan-filter)' },
      signal:  AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, text: '' };
    const html = await res.text();
    // Strip tags + scripts/styles to plain text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message, text: '' };
  }
}

// ─── Main check function ──────────────────────────────────────────────────────

function classifyJD(text) {
  if (!text || text.length < 200) {
    return { sponsorFriendly: null, reason: 'JD text empty or too short — could not classify' };
  }

  const blockers = [];
  for (const rx of VISA_BLOCKERS) {
    const m = text.match(rx);
    if (m) blockers.push(m[0].slice(0, 100));
  }
  const country = checkCountryExclusion(text);
  if (country) blockers.push(country);

  if (blockers.length > 0) {
    return { sponsorFriendly: false, reason: blockers.slice(0, 2).join(' | ') };
  }

  const friendly = VISA_FRIENDLY_HINTS.some(rx => rx.test(text));
  return {
    sponsorFriendly: true,
    reason: friendly ? 'Sponsorship language present' : 'No visa-block phrases detected (neutral)',
  };
}

// ─── Pipeline.md surgery ──────────────────────────────────────────────────────

function readPipelinePending() {
  const txt = readFileSync(PIPELINE, 'utf-8');
  const idx = txt.indexOf('## Procesadas');
  const head = idx > -1 ? txt.slice(0, idx) : txt;
  const items = [];
  const lineRegex = /^- \[ \] (https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)$/gm;
  let m;
  while ((m = lineRegex.exec(head)) !== null) {
    items.push({ raw: m[0], url: m[1], company: m[2].trim(), title: m[3].trim() });
  }
  return items;
}

function rewritePipeline(updates) {
  if (DRY || updates.length === 0) return;
  let txt = readFileSync(PIPELINE, 'utf-8');
  for (const u of updates) {
    const replacement = `- [x] #--- | ${u.url} | ${u.company} | ${u.title} | SKIP-VISA | ${u.reason}`;
    txt = txt.replace(u.raw, replacement);
  }
  writeFileSync(PIPELINE, txt, 'utf-8');
}

function appendHistory(updates) {
  if (DRY || updates.length === 0) return;
  const lines = updates.map(u =>
    `${u.url}\t${TODAY}\tvisa-filter\t${u.title}\t${u.company}\tskipped_visa: ${u.reason.slice(0, 80)}`
  ).join('\n') + '\n';
  appendFileSync(HISTORY, lines);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function checkOneUrl(url) {
  const { ok, text, error } = await fetchJDText(url);
  if (!ok) return { sponsorFriendly: null, reason: `Fetch failed: ${error}` };
  return classifyJD(text);
}

async function main() {
  if (ONE) {
    const r = await checkOneUrl(ONE);
    console.log(JSON.stringify({ url: ONE, ...r }, null, 2));
    return;
  }

  const items = readPipelinePending();
  if (items.length === 0) {
    console.log('No pending URLs in pipeline.md to filter.');
    return;
  }

  console.log(`Visa filter — ${items.length} pending URLs (${DRY ? 'DRY' : 'LIVE'})\n`);
  const blocked = [];
  const passed  = [];
  const errored = [];

  for (const it of items) {
    process.stdout.write(`  ${it.company.padEnd(24).slice(0,24)} | ${it.title.slice(0, 40).padEnd(40)} `);
    const { sponsorFriendly, reason } = await checkOneUrl(it.url);
    if (sponsorFriendly === false) {
      console.log(`❌ BLOCKED: ${reason.slice(0, 60)}`);
      blocked.push({ ...it, reason });
    } else if (sponsorFriendly === true) {
      console.log(`✅ ok`);
      passed.push(it);
    } else {
      console.log(`⚠ skip-classify (${reason.slice(0, 40)})`);
      errored.push({ ...it, reason });
    }
  }

  rewritePipeline(blocked);
  appendHistory(blocked);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Total checked:        ${items.length}`);
  console.log(`Passed (apply):       ${passed.length}`);
  console.log(`Visa-blocked:         ${blocked.length}${DRY ? ' (DRY — not written)' : ' (marked SKIP-VISA in pipeline.md)'}`);
  console.log(`Could not classify:   ${errored.length}`);
  if (blocked.length > 0) {
    console.log(`\nBlocked details:`);
    for (const b of blocked.slice(0, 20)) {
      console.log(`  - ${b.company} | ${b.title}`);
      console.log(`    reason: ${b.reason.slice(0, 120)}`);
    }
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
