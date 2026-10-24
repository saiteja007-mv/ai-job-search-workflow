#!/usr/bin/env node

/**
 * followup-shortlist.mjs — turn followup-cadence.mjs's overdue list into a list you act on.
 *
 * WHY: after the #1430 seeding hook was wired, the cadence dashboard reported 159 overdue at
 * once — the backlog from never having run. That is not a to-do list, it is noise: most of
 * those rows are ungated tsenta auto-applies that were never career-ops scored and are not
 * worth a follow-up. This joins the cadence output against each row's score and buckets it,
 * so the handful of gated, high-fit applications are separable from the spray.
 *
 * Read-only. Sends nothing, writes nothing.
 *
 * Usage:
 *   node followup-shortlist.mjs [--min 4.0] [--all] [--json]
 *
 *   --min N   floor for the CHASE bucket (default 4.0, the apply gate)
 *   --all     also print the below-floor and unscored buckets in full
 *   --json    machine-readable
 */

import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  all: args.includes('--all'),
  min: 4.0,
  maxAge: 30,
};
const numFlag = (name, key) => {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) {
    const v = Number(args[i + 1]);
    if (Number.isFinite(v)) flags[key] = v;
  }
};
numFlag('--min', 'min');
numFlag('--max-age', 'maxAge');

let cadence;
try {
  // followup-cadence.mjs emits JSON by DEFAULT and has no --json flag (--summary is the
  // human table), so it is invoked bare here.
  const raw = execFileSync(process.execPath, [`${HERE}/followup-cadence.mjs`, '--overdue-only'], {
    encoding: 'utf-8', maxBuffer: 1 << 26,
  });
  cadence = JSON.parse(raw);
} catch (err) {
  const msg = err.stderr?.toString().trim() || err.message;
  if (flags.json) console.log(JSON.stringify({ error: msg, code: 'cadence-failed' }));
  else console.error(`Error: could not read followup-cadence.mjs — ${msg}`);
  process.exit(1);
}

// "4.2/5" -> 4.2 ; "N/A", "—", "-", "" -> null (backfilled rows carry a sentinel by design, #1799)
const parseScore = (s) => {
  const m = /^\s*(\d(?:\.\d)?)\s*\/\s*5/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
};

const entries = (cadence.entries || [])
  .filter((e) => String(e.urgency || '').toLowerCase() === 'overdue')
  .map((e) => ({
    num: e.num,
    company: e.company,
    role: e.role,
    score: parseScore(e.score),
    scoreRaw: e.score ?? null,
    appliedDate: e.appliedDate || e.date || null,
    nextDue: e.nextFollowupDate ?? null,
    daysSinceApplied: e.daysSinceApplication ?? null,
    followUpsSent: e.followupCount ?? 0,
    contacts: (e.contacts || []).length,
    reportPath: e.reportPath || null,
  }));

// Score alone does NOT discriminate here, and assuming it did was the original mistake:
// followup-cadence.mjs only sees rows in the tracker, and tracker rows are almost all
// career-ops evaluated, so ~97% of the overdue list is already >=4.0. The tsenta spray never
// reached the tracker and is not in this list at all. AGE is the axis that separates a
// follow-up worth sending from one that just annoys a recruiter about a closed req.
const byScore = (a, b) => b.score - a.score;
const scored = entries.filter((e) => e.score != null && e.score >= flags.min);
const fresh = (e) => e.daysSinceApplied != null && e.daysSinceApplied <= flags.maxAge;

const chase = scored.filter(fresh).sort(byScore);
const stale = scored.filter((e) => !fresh(e)).sort(byScore);
const marginal = entries.filter((e) => e.score != null && e.score < flags.min).sort(byScore);
const unscored = entries.filter((e) => e.score == null);

if (flags.json) {
  console.log(JSON.stringify({
    analysisDate: cadence.metadata?.analysisDate,
    min: flags.min,
    maxAge: flags.maxAge,
    counts: { overdue: entries.length, chase: chase.length, stale: stale.length, marginal: marginal.length, unscored: unscored.length },
    chase, stale: flags.all ? stale : undefined, marginal: flags.all ? marginal : undefined, unscored: flags.all ? unscored : undefined,
  }, null, 2));
  process.exit(0);
}

const row = (e) =>
  `  ${String(e.num).padEnd(5)} ${(e.scoreRaw || '—').padEnd(7)} ${String(e.daysSinceApplied ?? '?').padStart(3)}d  ` +
  `${String(e.company).slice(0, 24).padEnd(24)} ${String(e.role).slice(0, 42).padEnd(42)} ` +
  `${e.contacts ? `${e.contacts} contact` : '—'}`;

console.log('='.repeat(112));
console.log(`  Overdue follow-ups — ${cadence.metadata?.analysisDate || ''}`);
console.log(`  ${entries.length} overdue · ${chase.length} actionable (>=${flags.min.toFixed(1)}, <=${flags.maxAge}d) · ${stale.length} stale · ${marginal.length} below floor · ${unscored.length} never scored`);
console.log('='.repeat(112));

console.log(`\n🟢 CHASE — scored >=${flags.min.toFixed(1)} and applied within ${flags.maxAge} days (${chase.length})\n`);
console.log(`  #     score    age  company                  role                                       contact`);
console.log(`  ${'-'.repeat(108)}`);
if (chase.length) chase.forEach((e) => console.log(row(e)));
else console.log('  (none)');

console.log(`\n🔵 STALE — scored >=${flags.min.toFixed(1)} but older than ${flags.maxAge} days (${stale.length})`);
if (flags.all && stale.length) { console.log(); stale.forEach((e) => console.log(row(e))); }
else console.log('  Req is likely closed and the recruiter has moved on. Chasing these reads as noise. --all to list.');

console.log(`\n🟡 BELOW FLOOR — scored under ${flags.min.toFixed(1)} (${marginal.length})`);
if (flags.all && marginal.length) { console.log(); marginal.forEach((e) => console.log(row(e))); }
else console.log('  Not worth a follow-up unless something changed. --all to list.');

console.log(`\n⚪ NEVER SCORED (${unscored.length})`);
if (flags.all && unscored.length) { console.log(); unscored.forEach((e) => console.log(row(e))); }
else console.log('  Backfilled rows with a score sentinel. --all to list.');

console.log(`\n${'─'.repeat(112)}`);
console.log(`Act on CHASE. Log a sent follow-up as a TABLE ROW in data/follow-ups.md — a row means SENT, a "- next #N" pin means SCHEDULED.`);
