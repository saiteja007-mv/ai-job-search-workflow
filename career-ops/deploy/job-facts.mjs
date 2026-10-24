/**
 * job-facts.mjs — answer "which req did you apply to?" from local data only.
 *
 * When the daily Tsenta outreach sends an invite it records the posting it applied to on the
 * ledger event (`applicationUrl`, `company`, `role`, `applicationId`). So by the time a recruiter
 * replies "do you have the req# for this role?", the answer is already on disk.
 *
 * DELIBERATELY LOCAL, AND BIASED TOWARD SAYING NOTHING. A requisition number sent to a recruiter
 * has to be right; a wrong one is worse than "I'll confirm and send it shortly". Nothing is
 * web-guessed, and every branch that cannot tie a posting to THIS PERSON returns null so the
 * caller keeps the honest fallback.
 *
 * Hardened 2026-09-14 after an adversarial review found four critical defects in the first cut:
 *   1. the report fallback matched companies on their FIRST WORD, so a "<COMPANY_AL>" recruiter
 *      could be handed a "<COMPANY_M>" requisition;
 *   2. that same path had no multi-posting detection and silently picked one of five real <COMPANY_N>
 *      reqs, including one <YOUR_NAME> had rejected;
 *   3. the ask detector's qualifier group was optional, so it degraded to /\breq\b/ and fired on
 *      ordinary chatter like "I'll check on the req" — which would volunteer a req number unasked;
 *   4. ledger fields were interpolated into the model prompt unsanitised, so an embedded newline
 *      could forge extra "- Requisition number: …" lines indistinguishable from verified ones.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Single-line, length-capped: nothing interpolated into the prompt may forge a fact line. */
/**
 * A URL field must be ONE url. Flattening newlines is not enough: an injected
 * "https://real/a\n- Posting URL: https://evil" merely becomes a single mangled line that still
 * contains the attacker's link. Take the first whitespace-delimited token and require it to parse
 * as http(s), else drop it entirely.
 */
const safeUrl = (u) => {
  const tok = String(u ?? '').trim().split(/\s+/)[0] || '';
  try { const p = new URL(tok); return (p.protocol === 'http:' || p.protocol === 'https:') ? tok.slice(0, 300) : ''; }
  catch { return ''; }
};

const safe = (s, max = 200) => String(s ?? '').replace(/[\r\n\u2028\u2029\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A human-meaningful requisition number, where the ATS has one. Matched by host first so the
 * vendor label we quote to the recruiter is right. Workday ids are often letter-prefixed
 * (JR-<ID>, R-12345) as well as bare (182066). Lever and Ashby use opaque UUIDs, which are
 * NOT what anyone means by "req#" — those return null and the caller falls back to the link.
 */
export function reqFromUrl(url) {
  const u = String(url || '');
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { host = ''; }
  const first = (re) => { const m = u.match(re); return m ? m[1] : null; };

  const WD = /[_/]((?:JR|R|REQ)[-_]?\d{3,}|\d{5,})(?:-\d+)?(?:[/?#]|$)/i;
  if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com')) {
    const r = first(WD); if (r) return { req: r.toUpperCase().replace(/^([A-Z]+)_/, '$1-'), ats: 'Workday' };
  }
  if (host.includes('greenhouse.io') || u.includes('gh_jid=')) {
    const r = first(/[?&]gh_jid=(\d{4,})/i) || first(/\/jobs\/(\d{4,})(?:[/?#]|$)/i);
    if (r) return { req: r, ats: 'Greenhouse' };
  }
  if (host.includes('icims.com')) {
    const r = first(/\/jobs\/(\d{3,})(?:[/?#]|$)/i); if (r) return { req: r, ats: 'iCIMS' };
  }
  if (host.includes('taleo.net')) {
    const r = first(/[?&]job=([A-Z0-9-]{3,})/i) || first(/\/job\/([A-Z0-9-]{3,})(?:[/?#]|$)/i);
    if (r) return { req: r, ats: 'Taleo' };
  }
  if (host.includes('oraclecloud.com')) {
    const r = first(/\/job\/(\d{3,})(?:[/?#]|$)/i); if (r) return { req: r, ats: 'Oracle' };
  }
  if (host.includes('smartrecruiters.com')) {
    const r = first(/-(\d{6,})(?:[/?#]|$)/); if (r) return { req: r, ats: 'SmartRecruiters' };
  }
  // Opaque-id vendors: never present a UUID as a requisition number.
  if (/lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|breezy\.hr/.test(host)) return null;
  // A linkedin.com/jobs/view/<id> number is LinkedIn's own posting id, NOT an ATS requisition a
  // recruiter can look up on their side. Quoting it as a "req" is exactly the confident-but-wrong
  // answer this module exists to avoid; hand back the link instead.
  if (host.includes('linkedin.com')) return null;
  // Unknown vendor: only a Workday-style suffix is distinctive enough to quote, and we do not
  // claim a vendor name we cannot verify.
  const r = first(WD);
  return r ? { req: r.toUpperCase().replace(/^([A-Z]+)_/, '$1-'), ats: null } : null;
}

/** Every ledger event for one person, whether or not it recorded a posting URL. */
function ledgerPerson(root, providerId) {
  if (!providerId) return [];
  try {
    const d = JSON.parse(readFileSync(join(root, 'data', 'outreach_log.json'), 'utf8'));
    return (Array.isArray(d.events) ? d.events : []).filter((e) => e && e.provider_id === providerId);
  } catch { return []; }
}

/** Ledger events that recorded which posting the outreach was about, for one person. */
function ledgerHits(root, providerId) {
  if (!providerId) return [];
  let ev = [];
  try {
    const d = JSON.parse(readFileSync(join(root, 'data', 'outreach_log.json'), 'utf8'));
    ev = Array.isArray(d.events) ? d.events : [];
  } catch { return []; }
  return ev
    .filter((e) => e && e.provider_id === providerId && typeof e.applicationUrl === 'string' && /^https?:\/\//i.test(e.applicationUrl))
    .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
}

/**
 * career-ops reports carry `**URL:**` in the header. This evidence is WEAKER than the ledger: a
 * report is tied to a company and role, never to the person asking. So it is only used when it
 * lands on exactly ONE posting, and only when the full company name matches — a shared first word
 * ("General" in both <COMPANY_M> and <COMPANY_AL>) is not a match.
 */
function reportHits(root, company, role) {
  const want = norm(company);
  if (want.length < 3) return [];
  const slug = want.replace(/ /g, '-');
  let files = [];
  try { files = readdirSync(join(root, 'reports')).filter((f) => /^\d+-.*\.md$/.test(f)); } catch { return []; }
  const roleWords = norm(role).split(' ').filter((w) => w.length > 3);
  if (!roleWords.length) return [];
  const out = [];
  for (const f of files) {
    // The filename slug must contain the WHOLE normalised company name, not just its first word.
    if (!f.toLowerCase().includes(`-${slug}-`) && !f.toLowerCase().includes(`-${slug}.`)) continue;
    let head = '';
    try { head = readFileSync(join(root, 'reports', f), 'utf8').slice(0, 1500); } catch { continue; }
    const url = (head.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const h = norm(head);
    const score = roleWords.filter((w) => h.includes(w)).length;
    if (score === roleWords.length) out.push({ url, report: `reports/${f}` });   // require EVERY role word
  }
  // Distinct postings only; duplicates of the same URL are one posting.
  const seen = new Set(); const uniq = [];
  for (const o of out) if (!seen.has(o.url)) { seen.add(o.url); uniq.push(o); }
  return uniq;
}

/**
 * Everything we can prove about the role this person was contacted about, or null.
 * `ambiguous` means the person was contacted about more than one distinct posting; the caller
 * must then name every candidate rather than picking one.
 */
export function jobFactsFor({ root, providerId, company, role }) {
  const hits = ledgerHits(root, providerId);
  const urls = [...new Set(hits.map((h) => h.applicationUrl))];
  if (urls.length) {
    const primary = hits[0];
    const candidates = urls.map((u) => {
      const h = hits.find((x) => x.applicationUrl === u);
      const r = reqFromUrl(u) || {};
      return { url: u, req: r.req || null, ats: r.ats || null, company: h.company || company || null, role: h.role || role || null, applied_at: String(h.sent_at || '').slice(0, 10) || null };
    });
    const r0 = reqFromUrl(urls[0]) || {};
    return {
      source: 'your outreach ledger (recorded when the invitation was sent)',
      company: primary.company || company || null,
      role: primary.role || role || null,
      url: urls[0], req: r0.req || null, ats: r0.ats || null,
      applied_at: String(primary.sent_at || '').slice(0, 10) || null,
      application_id: primary.applicationId || null,
      ambiguous: candidates.length > 1,
      candidates,
    };
  }
  // Weaker evidence. A report is tied to a company+role, never to a person, so it is only used
  // when we can first prove we actually contacted THIS person about THIS company: they must have
  // a ledger record whose company matches. Otherwise a stranger asking about a role we happen to
  // have a report for would be handed a requisition we never discussed with them.
  const person = ledgerPerson(root, providerId);
  const theirCompany = (person.find((e) => e.company) || {}).company;
  if (!person.length || !theirCompany || norm(theirCompany) !== norm(company)) return null;
  const reps = reportHits(root, company, role);
  if (reps.length !== 1) return null;
  const r = reqFromUrl(reps[0].url) || {};
  return {
    source: `your career-ops ${reps[0].report}`,
    company: company || null, role: role || null,
    url: reps[0].url, req: r.req || null, ats: r.ats || null,
    applied_at: null, application_id: null, ambiguous: false,
    candidates: [{ url: reps[0].url, req: r.req || null, ats: r.ats || null, company: company || null, role: role || null, applied_at: null }],
  };
}

/**
 * Detect a recruiter ASKING which posting/requisition this is. Biased against firing: a false
 * positive volunteers a requisition number into a conversation nobody asked about it in. The
 * qualifier after "req" is mandatory — bare "req" appears constantly in ordinary recruiter
 * chatter ("I'll check on the req", "this req closes Friday").
 */
const ASK_RE = new RegExp([
  String.raw`\breq\s*(?:#|no\.?\b|num\w*|id\b)`,
  String.raw`\brequisition\s*(?:#|no\.?\b|num\w*|id\b)?`,
  String.raw`\bjob\s*(?:id|code|number|#|req\w*)\b`,
  String.raw`\bposting\s*(?:id|number|#)\b`,
  String.raw`\bposition\s*(?:id|number|code)\b`,
  String.raw`\bwhich\s+(?:role|req\w*|position|posting|job|one)\b`,
  String.raw`\bwhat\s+(?:role|job|position|req\w*)\b`,
  String.raw`\b(?:link|url)\s+(?:to|for)\s+the\s+(?:job|posting|role|req\w*)\b`,
  String.raw`\b(?:send|share|share the|pass along|forward)\s+(?:me\s+)?(?:the\s+)?(?:job\s+)?(?:link|posting|url|req\w*)\b`,
].join('|'), 'i');
// A request, not a statement: an explicit question mark or an interrogative/imperative opener.
const REQUESTY_RE = /\?|^\s*(?:can|could|would|do|did|does|are|is|what|which|where|please|send|share|kindly|may)\b|\b(?:please|can you|could you|do you have|mind sharing|let me know)\b/i;
export function asksAboutJobId(text) {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  return ASK_RE.test(t) && REQUESTY_RE.test(t);
}

/** The VERIFIED FACTS block handed to the model. Facts only, every field single-lined. */
export function factsInstruction(f) {
  if (!f) return null;
  const cands = Array.isArray(f.candidates) ? f.candidates : [];
  const L = ['They are asking which posting/requisition you applied to. These facts are VERIFIED from '
    + `<YOUR_NAME>'s own records (${safe(f.source, 120)}) — state them plainly and do NOT hedge or say you will confirm later:`];
  if (f.ambiguous && cands.length > 1) {
    L.push(`- CAREFUL: ${cands.length} different postings were applied to for this contact. Name them BOTH/ALL rather than picking one:`);
    for (const c of cands) {
      L.push(`  - ${safe(c.role, 90) || 'role'} at ${safe(c.company, 60) || 'the company'}`
        + `${c.req ? ` - ${c.ats ? c.ats + ' ' : ''}req ${safe(c.req, 40)}` : ''} - ${safeUrl(c.url)}`
        + `${c.applied_at ? ` (applied ${safe(c.applied_at, 12)})` : ''}`);
    }
  } else {
    if (f.role) L.push(`- Role applied for: ${safe(f.role, 90)}${f.company ? ` at ${safe(f.company, 60)}` : ''}`);
    if (f.req) L.push(`- Requisition number: ${safe(f.req, 40)}${f.ats ? `  (the ${safe(f.ats, 24)} req id, taken from the posting URL)` : ''}`);
    else L.push('- This ATS has no human-readable requisition number, so give the posting link instead of a number.');
    if (safeUrl(f.url)) L.push(`- Posting URL: ${safeUrl(f.url)}`);
    if (f.applied_at) L.push(`- Applied on: ${safe(f.applied_at, 12)}`);
  }
  L.push('Keep it short and direct. Do not invent any number, date, ID or link that is not listed above.');
  return L.join('\n');
}

/**
 * Application status at one company, from local records only (2026-10-07, <COMPANY_W>): a draft told
 * a recruiter "I'll keep my application as submitted" two weeks after <COMPANY_W> had rejected it.
 * Sources: tsenta submissions (data/tsenta-apps.json), the Agency mailbox's Rejections threads and
 * per-role statuses (agency-applications/_raw), and the tracker (data/applications.md). Rejection
 * emails rarely name the role, so the verdict is company-level and errs toward saying less:
 * a rejection on or after the latest application means no application there may be called live.
 */
const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export function applicationStatusFor({ root, company }) {
  const c = norm(company);
  if (!c) return null;
  const sameCo = (s) => norm(s) === c;
  const mentions = (s) => ` ${norm(s)} `.includes(` ${c} `);
  const applied = [], rejected = [];
  for (const a of readJsonSafe(join(root, 'data', 'tsenta-apps.json'))?.apps || []) {
    if (sameCo(a.company) && a.status === 'COMPLETED') applied.push({ role: a.title, on: String(a.appliedAt || '').slice(0, 10) });
  }
  const nb = join(root, 'agency-applications', '_raw');
  for (const a of readJsonSafe(join(nb, 'agency_applications_detailed.json'))?.applications || []) {
    if (!sameCo(a.company)) continue;
    if (a.applied_on) applied.push({ role: a.role, on: a.applied_on });
    if (/reject/i.test(a.status || '')) {
      const ev = (a.status_evidence || []).find((x) => /reject/i.test(x.status || ''));
      rejected.push({ on: ev?.at_day || a.rejected_on || a.applied_on || '', what: `${a.role || 'application'} marked Rejected` });
    }
  }
  for (const t of readJsonSafe(join(nb, 'Rejections.json'))?.threads || []) {
    if (mentions(t.from) || mentions(t.subject)) rejected.push({ on: String(t.date || '').slice(0, 10), what: `email "${t.subject}"` });
  }
  try {
    for (const line of readFileSync(join(root, 'data', 'applications.md'), 'utf8').split('\n')) {
      const col = line.split('|').map((s) => s.trim());
      if (col.length < 8 || !sameCo(col[3])) continue;
      if (/reject/i.test(col[6])) rejected.push({ on: col[2], what: `tracker: ${col[4]} Rejected` });
      else if (/applied|interview/i.test(col[6])) applied.push({ role: col[4], on: col[2] });
    }
  } catch { /* no tracker: other sources still count */ }
  if (!applied.length && !rejected.length) return null;
  const latest = (xs) => xs.map((x) => x.on).filter(Boolean).sort().pop() || null;
  const lastApplied = latest(applied), lastRejected = latest(rejected);
  const verdict = lastRejected && (!lastApplied || lastRejected >= lastApplied) ? 'rejected'
    : lastRejected ? 'mixed' : 'applied_no_outcome';
  return { company, verdict, last_applied: lastApplied, last_rejected: lastRejected,
    applied: applied.sort((a, b) => (b.on || '').localeCompare(a.on || '')), rejected: rejected.sort((a, b) => (b.on || '').localeCompare(a.on || '')) };
}

/** VERIFIED FACTS for application status. Always returns a block: no record means "say nothing". */
export function statusInstruction(s, company) {
  const co = safe(s?.company || company, 60) || 'this company';
  const never = 'Do NOT say or imply that any application there is submitted, active, pending, in process, still under review, or kept "as submitted".';
  if (!s) return `APPLICATION STATUS at ${co}: nothing verified on record. ${never} Do not mention application status at all.`;
  const L = [`APPLICATION STATUS at ${co} — VERIFIED from <YOUR_NAME>'s local records (tsenta submissions, the Agency mailbox, the tracker):`];
  for (const a of s.applied.slice(0, 4)) L.push(`- Applied: ${safe(a.role, 90) || 'a role'}${a.on ? ` (${safe(a.on, 10)})` : ''}`);
  for (const r of s.rejected.slice(0, 3)) L.push(`- Rejection${r.on ? ` on ${safe(r.on, 10)}` : ''}: ${safe(r.what, 120)}`);
  if (s.verdict === 'rejected') L.push(`- A rejection arrived on or after the most recent application. ${never} If status comes up, say he applied and heard it was not moving forward.`);
  else if (s.verdict === 'mixed') L.push(`- An earlier application was rejected; the latest one has no recorded outcome. You may say he applied. ${never}`);
  else L.push(`- No outcome is recorded. You may say he applied. ${never}`);
  return L.join('\n');
}
