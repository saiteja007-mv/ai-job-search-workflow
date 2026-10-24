#!/usr/bin/env node
// send.mjs — warm-outbound PHASE 2: deterministic Node, no LLM. Takes phase-1's candidate JSON,
// runs each one through validation + LinkedIn checks, and only ever calls send_invitation through
// the self-hosted linkedin MCP (career-ops/deploy/linkedin-send.mjs) — same ledger, same budget,
// same dedupe as every other outreach path. WARM_OUTBOUND_DRY_RUN defaults to "1" (never send).
//
// The core logic (runWarmOutbound) takes its LinkedIn calls and its outreach-log snapshot as
// arguments instead of reaching for them itself, so the test suite can inject a fake tool() and a
// fake outreachLog with no network, no real MCP, and no real file on disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkedInTool, linkedInSendAvailable, pastEmployerIn } from '../../../career-ops/deploy/linkedin-send.mjs';

const CAREER_OPS_ROOT = process.env.CAREER_OPS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'career-ops');
const OUTREACH_LOG_PATH = path.join(CAREER_OPS_ROOT, 'data', 'outreach_log.json');
const REPORTS_DIR = path.join(CAREER_OPS_ROOT, 'reports');
export const ORIGIN = 'superagnt-warm-outbound';

// ---------------------------------------------------------------------------------------
// Small, self-contained validators. Kept as named exports so a test can exercise each one
// directly instead of only through the full loop.
// ---------------------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{|\[name\]|\btodo\b/i;
const URL_RE = /https?:\/\/|www\./i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// ponytail: a naive digit-run phone detector, not a real phone-number parser — good enough to
// catch "call me at <PHONE>" without flagging ordinary prose that happens to contain a
// number (a 300-char connection note is short enough that this rarely matters either way).
const PHONE_RE = /\+?\d[\d .-]{7,}\d/;

/** { ok:true } or { ok:false, reason }. Reasons are short codes, held[].reason in the loop below. */
export function validateNote(note, theirCompany = null) {
  if (typeof note !== 'string') return { ok: false, reason: 'note_missing' };
  // <YOUR_NAME>, 2026-10-08: no company from the resume in LinkedIn text; describe experience by role.
  if (pastEmployerIn(note, theirCompany)) return { ok: false, reason: 'note_past_employer' };
  if (note.length < 20 || note.length > 300) return { ok: false, reason: 'note_length' };
  if (PLACEHOLDER_RE.test(note)) return { ok: false, reason: 'note_placeholder' };
  if (URL_RE.test(note)) return { ok: false, reason: 'note_url' };
  if (EMAIL_RE.test(note)) return { ok: false, reason: 'note_contact_info' };
  if (PHONE_RE.test(note)) return { ok: false, reason: 'note_contact_info' };
  return { ok: true };
}

/** Last non-empty path segment of a LinkedIn profile URL, e.g. .../in/jane-doe-123/ -> jane-doe-123. */
export function tailOfLinkedInUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch { return null; }
}

function normCompany(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
/** "Loosely match": same reasoning as inviteReferredPerson() in linkedin-send.mjs — substring or
 * shared first word, never an exact-string requirement (headlines abbreviate/suffix company names). */
export function employerMatches(employerFromHeadline, candidateCompany) {
  const emp = normCompany(employerFromHeadline);
  const co = normCompany(candidateCompany);
  if (!emp || !co) return false;
  return emp.includes(co) || co.includes(emp) || emp.split(' ')[0] === co.split(' ')[0];
}

// Hiring-team posters at startups are often founders/CTOs/engineering leaders, not recruiters.
export const TITLE_RE = /recruit|talent|sourc|hiring|engineering manager|head of (ai|ml|machine learning|engineering|data)|(co-?)?founder|\bcto\b|chief technology|(director|vp|vice president)( of)? (engineering|ai|ml|machine learning|data science)/i;
const ALREADY_CONNECTED = new Set(['FIRST_DEGREE', 'DISTANCE_1']);

/** YYYY-MM-DD in <YOUR_TZ>, regardless of the machine's own timezone. */
export function chicagoDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: '<YOUR_TZ>', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** How many superagnt-warm-outbound invites outreach_log.json already shows for `todayStr`.
 * origin arg lands in each event's `external_origin` (linkedin-mcp/server/careerops.cjs
 * buildInviteEvent) — `origin` itself is always the fixed 'unipile-linkedin-mcp' string. */
export function countTodaySends(outreachLog, todayStr) {
  const events = outreachLog?.events;
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const e of events) {
    if (!e || e.external_origin !== ORIGIN || !e.sent_at) continue;
    const d = new Date(e.sent_at);
    if (!Number.isNaN(d.getTime()) && chicagoDateStr(d) === todayStr) n++;
  }
  return n;
}

/**
 * The whole phase-2 decision loop, deterministic and network-free except through `tool`.
 *
 * @param {object[]} candidates - phase-1's candidate list.
 * @param {(name:string, args:object) => Promise<any>} tool - linkedInTool()-shaped MCP caller.
 * @param {object} outreachLog - parsed outreach_log.json (or {} / missing fields — handled).
 * @param {Date} now
 * @param {number} cap - this job's own daily cap (WARM_OUTBOUND_DAILY_CAP).
 * @param {boolean} dryRun
 */
/**
 * Shared-pool allowance (<YOUR_NAME>'s decision 2026-09-28): every LinkedIn sender draws from one reconciled
 * budget (30/day, 170/week). Warm outbound runs first each weekday (09:37), so it leaves `reserve` for
 * the recruiter cron (11:00, up to 10) and takes at most a third of the week's remaining room, so
 * Tsenta's nightly outreach still gets a share. A budget that can't be read allows nothing.
 */
export function poolAllowance(budget, { reserve = 10, weekShare = 3 } = {}) {
  if (!budget || budget.available === false) return 0;
  const today = Number(budget.remainingToday ?? 0) - reserve;
  const week = budget.remainingThisWeek == null ? Infinity : Math.floor(Number(budget.remainingThisWeek) / weekShare);
  return Math.max(0, Math.min(today, week));
}

export async function runWarmOutbound({ candidates, tool, outreachLog, now = new Date(), cap = 8, dryRun = true, reserve = 10 }) {
  const todayStr = chicagoDateStr(now);
  const sentToday = countTodaySends(outreachLog, todayStr);
  let startBudget = null;
  try { startBudget = await tool('get_invite_budget', {}); } catch { startBudget = null; }
  const pool = poolAllowance(startBudget, { reserve });
  let remaining = Math.max(0, Math.min(cap - sentToday, pool));
  const sent = [], wouldSend = [], held = [];
  let stopReason = null;

  for (const candidate of candidates || []) {
    if (remaining <= 0) { stopReason = pool < cap - sentToday ? 'shared_pool_limit' : 'daily_cap_reached'; break; }

    // ponytail: guard the WHOLE candidate body, not just the tool() calls — phase-1 is an LLM's
    // fenced JSON, so a malformed element (bare null, a string, missing fields) must be held and
    // skipped, never allowed to throw out of the loop and lose the summary/report for everyone
    // already sent this run (that's the whole point of accumulating sent/wouldSend/held below).
    try {
      const noteCheck = validateNote(candidate.note, candidate.company);
      if (!noteCheck.ok) { held.push({ ...candidate, reason: noteCheck.reason }); continue; }

      const identifier = candidate.public_id || candidate.provider_id || tailOfLinkedInUrl(candidate.linkedin_url);
      if (!identifier) { held.push({ ...candidate, reason: 'no_identifier' }); continue; }

      let profile;
      try { profile = await tool('get_profile', { identifier }); }
      catch { profile = null; }
      if (!profile) { held.push({ ...candidate, reason: 'profile_not_found' }); continue; }

      if (ALREADY_CONNECTED.has(profile.network_distance) || profile.is_relationship) {
        held.push({ ...candidate, reason: 'already_connected' }); continue;
      }
      if (!TITLE_RE.test(profile.headline || '')) { held.push({ ...candidate, reason: 'wrong_title' }); continue; }
      if (!profile.employer_from_headline || !employerMatches(profile.employer_from_headline, candidate.company)) {
        held.push({ ...candidate, reason: 'employer_mismatch' }); continue;
      }

      const providerId = candidate.provider_id || profile.provider_id;
      if (!providerId) { held.push({ ...candidate, reason: 'no_provider_id' }); continue; }

      // A failed check is "unknown", not "not contacted": an unattended sender must not treat a
      // transient MCP error as clearance to invite someone the ledger may already cover.
      let contacted;
      try { contacted = await tool('check_contacted', { provider_id: providerId }); }
      catch { held.push({ ...candidate, reason: 'contacted_check_failed' }); continue; }
      if (contacted?.contacted) { held.push({ ...candidate, reason: 'already_contacted' }); continue; }

      let budget;
      try { budget = await tool('get_invite_budget', {}); }
      catch { budget = null; }
      if (!budget || typeof budget.remainingToday !== 'number' || budget.remainingToday <= 0) {
        stopReason = 'shared_budget_exhausted'; break;
      }

      const record = { ...candidate, providerId };
      if (dryRun) { wouldSend.push(record); remaining--; continue; }

      let res;
      try {
        res = await tool('send_invitation', {
          provider_id: providerId, message: candidate.note, name: candidate.name, company: candidate.company,
          role: 'Warm outbound (post engagement)', origin: ORIGIN,
        });
      } catch (e) { held.push({ ...candidate, reason: 'send_failed', error: String(e.message || e).slice(0, 160) }); continue; }

      if (res?.sent) { sent.push({ ...record, invitation_id: res.invitation_id || null }); remaining--; continue; }
      if (res?.scope && res.scope !== 'person') { stopReason = 'global_refusal'; break; }
      held.push({ ...candidate, reason: res?.reason || 'send_failed' });
    } catch (e) {
      held.push({ ...candidate, reason: 'candidate_error', error: String(e?.message || e).slice(0, 160) });
    }
  }

  return { sent, wouldSend, held, stopReason, sentToday, cap, dryRun, date: todayStr };
}

// ---------------------------------------------------------------------------------------
// Slack-ready markdown summary + report file. Pure formatting — no network, easy to eyeball.
// ---------------------------------------------------------------------------------------
export function formatSummary(result) {
  const { date, sent, wouldSend, held, stopReason, dryRun } = result;
  const lines = [];
  lines.push(`### Warm outbound — ${date}`);
  lines.push('');
  lines.push(dryRun
    ? `Dry run. ${wouldSend.length} would-send, ${held.length} held.`
    : `${sent.length} sent, ${held.length} held.`);
  if (stopReason) lines.push(`Batch stopped early: \`${stopReason}\`.`);
  lines.push('');
  const list = dryRun ? wouldSend : sent;
  if (list.length) {
    lines.push(dryRun ? '**Would send:**' : '**Sent:**');
    for (const c of list) {
      lines.push(`- ${c.name} — ${c.title || '?'} at ${c.company || '?'} (${c.post_url || 'no post url'})`);
      lines.push(`  note: ${c.note}`);
    }
    lines.push('');
  }
  if (held.length) {
    lines.push('**Held:**');
    for (const c of held) lines.push(`- ${c.name || '?'} at ${c.company || '?'} — ${c.reason}`);
  }
  return lines.join('\n');
}

function appendReport(dateStr, markdown) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `warm-outbound-${dateStr}.md`);
  const prefix = fs.existsSync(file) ? `${fs.readFileSync(file, 'utf8')}\n\n---\n\n` : '';
  fs.writeFileSync(file, prefix + markdown + '\n');
  return file;
}

// ---------------------------------------------------------------------------------------
// CLI entry point — real MCP, real outreach log, real cap/dry-run from the environment.
// ---------------------------------------------------------------------------------------
async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) { console.error('usage: node send.mjs <phase1.json>'); process.exit(2); }
  const phase1 = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const candidates = Array.isArray(phase1.candidates) ? phase1.candidates : [];

  let outreachLog = { events: [] };
  try { outreachLog = JSON.parse(fs.readFileSync(OUTREACH_LOG_PATH, 'utf8')); } catch { /* missing/unreadable — treat as empty */ }

  const cap = Number(process.env.WARM_OUTBOUND_DAILY_CAP) || 8;
  let dryRun = (process.env.WARM_OUTBOUND_DRY_RUN ?? '1') !== '0' && (process.env.WARM_OUTBOUND_DRY_RUN ?? '1') !== 'false';

  // Fail safe, not fail loud: if live mode is requested but the MCP's send_invitation tool
  // doesn't answer, drop to dry-run rather than either crashing or silently skipping every
  // candidate as "send_failed" one at a time.
  if (!dryRun && !(await linkedInSendAvailable())) {
    console.error('linkedin MCP send_invitation unavailable — running as dry-run instead');
    dryRun = true;
  }

  const result = await runWarmOutbound({ candidates, tool: linkedInTool, outreachLog, now: new Date(), cap, dryRun });
  const summary = formatSummary(result);
  console.log(summary);
  const reportFile = appendReport(result.date, summary);
  console.error(`report written: ${reportFile}`); // stderr — never mixed into the Slack-bound stdout
  process.exit(0);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // "Exit 0 on normal completion even if 0 sent" (spec) — main() already exits 0 on that path.
  // An uncaught exception here is a real bug (bad input JSON, a thrown MCP call, ...), so it
  // still exits non-zero for run-job's own failure detection to catch.
  main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
}
