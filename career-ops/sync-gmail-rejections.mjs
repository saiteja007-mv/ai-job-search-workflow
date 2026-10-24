#!/usr/bin/env node
// sync-gmail-rejections.mjs
//
// Cross-channel dedup: pulls Gmail rejection + submission emails via the `gog`
// CLI and writes a normalized shadow log to data/gmail-rejection-shadow-log.json.
// scan/pipeline/oferta modes consult this log before evaluating a new posting
// so they don't waste cycles on jobs already rejected outside career-ops.
//
// Usage:
//   node sync-gmail-rejections.mjs            # sync rejections + submissions
//   node sync-gmail-rejections.mjs --check "Company" "Role"
//                                             # query the shadow log
//
// Idempotent: dedup key = sha1(date|from|subject).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOG = process.env.GOG_BIN || '%USERPROFILE%/bin/gogcli/gog.exe';
const SHADOW_PATH = path.join(__dirname, 'data', 'gmail-rejection-shadow-log.json');
const MAX_FETCH = Number(process.env.GMAIL_SYNC_MAX || 500);

// --- Parsing helpers --------------------------------------------------------

const CORP_SUFFIX = /\s+(inc|inc\.|llc|l\.l\.c\.|corp|corporation|company|co\.|ltd|limited|gmbh|s\.a\.|s\.l\.|plc)$/i;

export function normCompany(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[.,'!?()]/g, '')
    .replace(/&/g, 'and')
    .replace(CORP_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normRole(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\(\)\[\]]/g, ' ')
    .replace(/[^\w\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stopwords for role token overlap
const ROLE_STOP = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff',
  'i', 'ii', 'iii', 'iv', 'v',
  'remote', 'hybrid', 'onsite', 'contract', 'full-time', 'part-time',
  'analyst', 'engineer', 'specialist', 'manager', 'associate',
  'and', 'or', 'the', 'a', 'an', 'of', 'at', 'for', 'with', 'to',
]);

export function roleTokens(s) {
  return new Set(
    normRole(s)
      .split(/[\s/-]+/)
      .filter(t => t.length >= 3 && !ROLE_STOP.has(t)),
  );
}

// Extract company + role + reqId from subject/from
export function parseRow({ id, date, from, subject, labels }) {
  const subj = subject || '';
  const fromStr = from || '';
  let company = null;
  let role = null;
  let reqId = null;

  // 1) Workday: "Update on your application for {REQ_ID} - {ROLE}"
  //    or       "Update on your application: {ROLE} at {Company}"
  let m = subj.match(/application for\s+([A-Z0-9_-]{4,20})\s*[-–]\s*(.+?)\s*$/i);
  if (m) {
    reqId = m[1];
    role = m[2].trim();
  }
  m = subj.match(/Update on your application:\s*(.+?)\s+at\s+(.+?)\s*$/i);
  if (m) {
    role = role || m[1].trim();
    company = company || m[2].trim();
  }

  // 2) LinkedIn / Greenhouse: "Your application to {ROLE} at {Company}"
  m = subj.match(/[Yy]our application to\s+(.+?)\s+at\s+(.+?)(?:\s*[-–,]|\s*$)/);
  if (m) {
    role = role || m[1].trim();
    company = company || m[2].trim();
  }

  // 3) Greenhouse generic: "Regarding your application to {Company} ({Role})"
  //                       or "... to {Company}"
  m = subj.match(/application to\s+(.+?)\s*\((.+?)\)\s*$/i);
  if (m) {
    company = company || m[1].trim();
    role = role || m[2].trim();
  }
  if (!company) {
    m = subj.match(/application to\s+([A-Z][A-Za-z0-9 &.,'\-]{2,50}?)(?:\s+(?:was|for|regarding|has)|\s*[-–,]|\s*$)/i);
    if (m) company = m[1].trim();
  }

  // 4) "Thank you for your interest in {Company}" / "... applying to {Company}"
  m = subj.match(/(?:interest in|applying to|considering)\s+(.+?)\s*[!.]?\s*$/i);
  if (m) company = company || m[1].trim();

  // 5) iCIMS: "Application Status - {Role} ({REQ_ID})"
  m = subj.match(/Application Status[\s-]+([^-(]+?)\s*\(([A-Z0-9_\-]+)\)/i);
  if (m) {
    role = role || m[1].trim();
    reqId = reqId || m[2];
  }

  // 6) Generic req id at start: "R1050367 Data Analyst II"
  m = subj.match(/^([A-Z]{1,2}\d{5,10})\s+(.+)$/);
  if (m) {
    reqId = reqId || m[1];
    role = role || m[2].trim();
  }

  // 7) "{Company} Hiring Update - {Role}" / "{Company} | Update"
  m = subj.match(/^(.+?)\s+Hiring Update\s*[-–]\s*(.+?)\s*$/i);
  if (m) {
    company = company || m[1].trim();
    role = role || m[2].trim();
  }
  m = subj.match(/^(.+?)\s*\|\s*Update\s*$/i);
  if (m) company = company || m[1].trim();

  // Fallback A: ATS sender — company is the local-part for myworkday-style senders.
  //   Examples: <CONTACT_EMAIL>, <CONTACT_EMAIL>, <CONTACT_EMAIL>,
  //             <CONTACT_EMAIL>, <CONTACT_EMAIL>
  if (!company) {
    const ats = fromStr.match(/<?\s*([a-z0-9._+-]+)@(?:[a-z0-9-]+\.)*?(myworkday|greenhouse-mail|lever|ashbyhq|icims|workday|smartrecruiters|recruitee|jobvite|workable|breezy|teamtailor)\.(?:com|io|net|us|co)/i);
    if (ats) {
      const local = ats[1].split(/[+]/)[0]; // strip subaddress
      if (!['no-reply', 'noreply', 'donotreply', 'recruiting', 'careers', 'jobs', 'hr', 'team', 'mail', 'info', 'principal', 'admin'].includes(local.toLowerCase())) {
        company = local;
      }
    }
  }
  // Fallback B: subdomain ATS — asml.myworkdayjobs.com → asml
  if (!company) {
    const md = fromStr.match(/@([a-z0-9-]+)\.(myworkday|myworkdayjobs|greenhouse|lever|ashbyhq|icims|workday|smartrecruiters)/i);
    if (md) company = md[1];
  }
  // Fallback C: top-level domain root
  if (!company) {
    const md = fromStr.match(/@(?:[\w-]+\.)*([a-z0-9-]+)\.(?:com|io|net|org|co|tech|ai|us)/i);
    if (md && !['linkedin', 'gmail', 'google', 'mail', 'noreply', 'amazonses', 'myworkday', 'greenhouse-mail', 'applytojob'].includes(md[1].toLowerCase())) {
      company = md[1];
    }
  }
  if (!company) company = 'unknown';

  // Strip trailing junk from company
  company = company
    .replace(/[.,;:!?]+$/, '')
    .replace(/\s+\(.*?\)\s*$/, '')
    .trim();

  // FROM domain only
  const fromDomainM = fromStr.match(/@([a-z0-9.-]+)/i);
  const fromDomain = fromDomainM ? fromDomainM[1] : '';

  // Date: gog gives "YYYY-MM-DD HH:MM" — keep date only
  const dateOnly = (date || '').slice(0, 10);

  const labelSet = (labels || '').split(',').map(s => s.trim());
  const isRejection = labelSet.includes('Rejections');
  const isSubmission = labelSet.includes('Submissions');

  const hash = createHash('sha1')
    .update(`${dateOnly}|${fromStr}|${subj}`)
    .digest('hex')
    .slice(0, 16);

  return {
    hash,
    msgId: id,
    date: dateOnly,
    company: company || 'unknown',
    companyNorm: normCompany(company),
    role: role || '',
    reqId: reqId || '',
    subject: subj,
    fromDomain,
    isRejection,
    isSubmission,
  };
}

// --- gog fetch --------------------------------------------------------------

function fetchTSV(query, max = MAX_FETCH) {
  const out = execFileSync(
    GOG,
    ['-p', 'gmail', 'search', query, '--max', String(max), '-p'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const lines = out.trim().split(/\r?\n/);
  // first row = header
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 4) continue;
    rows.push({
      id: parts[0],
      date: parts[1],
      from: parts[2],
      subject: parts[3] || '',
      labels: parts[4] || '',
      thread: parts[5] || '',
    });
  }
  return rows;
}

// --- Shadow log read/write --------------------------------------------------

export function loadShadowLog() {
  if (!fs.existsSync(SHADOW_PATH)) {
    return { generatedAt: null, rejections: [], submissions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
  } catch {
    return { generatedAt: null, rejections: [], submissions: [] };
  }
}

function mergeByHash(existing, incoming) {
  const seen = new Map();
  for (const e of existing) seen.set(e.hash, e);
  for (const e of incoming) seen.set(e.hash, e); // incoming wins (re-parse)
  return [...seen.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// --- Public API: isAlreadyRejected ------------------------------------------

/**
 * Returns { hit: boolean, match?: object, daysAgo?: number, reason?: string }.
 * `company` required; `roleHint` optional. Matches within `windowDays` days.
 */
export function isAlreadyRejected(company, roleHint = '', windowDays = 90, log = null) {
  if (!company) return { hit: false };
  log = log || loadShadowLog();
  const cn = normCompany(company);
  if (!cn) return { hit: false };
  const cnNospace = cn.replace(/\s+/g, '');
  const today = new Date();
  const hintTokens = roleHint ? roleTokens(roleHint) : null;

  for (const r of log.rejections || []) {
    const rn = r.companyNorm || normCompany(r.company);
    if (!rn) continue;
    const rnNospace = rn.replace(/\s+/g, '');
    // Company match: exact OR substring either direction (with and without spaces,
    // so "<TARGET_COMPANY>" matches "trinityhealth" from a workday sender).
    const cMatch =
      rn === cn ||
      rnNospace === cnNospace ||
      (rn.length >= 4 && cn.includes(rn)) ||
      (cn.length >= 4 && rn.includes(cn)) ||
      (rnNospace.length >= 5 && cnNospace.includes(rnNospace)) ||
      (cnNospace.length >= 5 && rnNospace.includes(cnNospace));
    if (!cMatch) continue;

    // Date window
    const d = r.date ? new Date(r.date) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    const daysAgo = Math.floor((today - d) / 86400000);
    if (daysAgo > windowDays) continue;

    // Role overlap (optional). If no hint, company-only match is enough.
    if (hintTokens && hintTokens.size > 0 && r.role) {
      const rt = roleTokens(r.role);
      let overlap = 0;
      for (const t of hintTokens) if (rt.has(t)) overlap++;
      // require at least one significant token overlap, OR exact reqId match
      if (overlap === 0) continue;
    }

    return {
      hit: true,
      match: r,
      daysAgo,
      reason: `Rejected ${daysAgo}d ago by ${r.company}${r.reqId ? ` (req ${r.reqId})` : ''}`,
    };
  }
  return { hit: false };
}

// --- Main sync --------------------------------------------------------------

async function sync() {
  if (!fs.existsSync(GOG)) {
    console.error(`gog CLI not found at ${GOG}. Set GOG_BIN env var.`);
    process.exit(2);
  }

  console.log(`Fetching gmail label:Rejections (max ${MAX_FETCH}) via gog...`);
  const rejRows = fetchTSV('label:Rejections', MAX_FETCH);
  console.log(`  got ${rejRows.length} rejection rows`);

  console.log(`Fetching gmail label:Submissions (max ${MAX_FETCH}) via gog...`);
  let subRows = [];
  try {
    subRows = fetchTSV('label:Submissions', MAX_FETCH);
  } catch (e) {
    console.error(`  submissions fetch failed (continuing): ${e.message}`);
  }
  console.log(`  got ${subRows.length} submission rows`);

  const parsedRej = rejRows.map(parseRow).filter(r => r.isRejection);
  // Rows tagged ONLY as Submissions (not also Rejections) = pending applied
  const parsedSub = subRows.map(parseRow).filter(r => r.isSubmission && !r.isRejection);

  const existing = loadShadowLog();
  const merged = {
    generatedAt: new Date().toISOString(),
    rejections: mergeByHash(existing.rejections || [], parsedRej),
    submissions: mergeByHash(existing.submissions || [], parsedSub),
  };

  fs.mkdirSync(path.dirname(SHADOW_PATH), { recursive: true });
  fs.writeFileSync(SHADOW_PATH, JSON.stringify(merged, null, 2));

  // Cross-check against applications.md tracker
  const appsPath = path.join(__dirname, 'data', 'applications.md');
  let trackerHits = 0;
  let alreadyDocumented = 0;
  const evalCollisions = [];
  if (fs.existsSync(appsPath)) {
    const apps = fs.readFileSync(appsPath, 'utf8');
    const tracker = [];
    for (const line of apps.split('\n')) {
      const m = line.match(/^\|\s*(\d+)\s*\|\s*([\d-]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (m) {
        tracker.push({
          num: m[1],
          date: m[2],
          company: m[3].trim(),
          role: m[4].trim(),
          score: m[5].trim(),
          status: m[6].trim(),
          cnorm: normCompany(m[3]),
        });
      }
    }

    for (const t of tracker) {
      if (t.status === 'Rejected') { alreadyDocumented++; continue; }
      const r = isAlreadyRejected(t.company, t.role, 90, merged);
      if (!r.hit) continue;
      // Skip if tracker row is OLDER than rejection (means we already knew)
      const tDate = new Date(t.date);
      const rDate = new Date(r.match.date);
      if (tDate < rDate) continue;
      // Skip if tracker explicitly notes it (#259 <TARGET_COMPANY>)
      trackerHits++;
      evalCollisions.push({
        trackerNum: t.num,
        trackerDate: t.date,
        trackerCompany: t.company,
        trackerRole: t.role,
        trackerStatus: t.status,
        rejDate: r.match.date,
        rejReq: r.match.reqId,
        rejSubject: r.match.subject,
        daysGap: Math.floor((tDate - rDate) / 86400000),
      });
    }
  }

  console.log('');
  console.log('==== SYNC SUMMARY ====');
  console.log(`Rejections synced:  ${merged.rejections.length}`);
  console.log(`Submissions synced: ${merged.submissions.length}`);
  console.log(`Shadow log:         ${path.relative(__dirname, SHADOW_PATH)}`);
  console.log('');
  console.log('==== CAREER-OPS COLLISIONS ====');
  console.log(`Tracker rows already marked Rejected: ${alreadyDocumented}`);
  console.log(`Tracker rows evaluated AFTER a rejection (new collisions): ${trackerHits}`);
  for (const c of evalCollisions.slice(0, 20)) {
    console.log(
      `  #${c.trackerNum.padStart(3)} ${c.trackerDate} ${c.trackerStatus.padEnd(10)} ` +
      `${c.trackerCompany.slice(0, 25).padEnd(25)} | rej ${c.rejDate}` +
      (c.rejReq ? ` (req ${c.rejReq})` : '') +
      ` | gap ${c.daysGap}d`,
    );
  }
  if (evalCollisions.length > 20) {
    console.log(`  ... and ${evalCollisions.length - 20} more`);
  }
}

// --- CLI dispatch -----------------------------------------------------------

const argv = process.argv.slice(2);
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1].endsWith('sync-gmail-rejections.mjs');

if (isMain) {
  if (argv[0] === '--check') {
    const company = argv[1];
    const role = argv[2] || '';
    if (!company) {
      console.error('Usage: sync-gmail-rejections.mjs --check "Company" ["Role"]');
      process.exit(2);
    }
    const r = isAlreadyRejected(company, role);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.hit ? 0 : 1);
  } else {
    sync().catch(e => {
      console.error('SYNC ERROR:', e.message);
      console.error(e.stack);
      process.exit(1);
    });
  }
}
