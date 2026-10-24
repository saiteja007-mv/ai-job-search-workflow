#!/usr/bin/env node
/**
 * typesafe-screen.mjs — first-pass JD screen (TypeSafe System One) for career-ops.
 *
 * Runs between the JobSpy sweep and the Opus A–G evaluation. Reads the
 * candidates (with pre-fetched JD text) the sweeper wrote, asks TypeSafe the
 * hard-rule questions, and writes the same list back with a `screen` record
 * on every entry. The Scan agent then forwards only `screen.decision: "pass"`.
 *
 * Usage:
 *   node typesafe-screen.mjs                       # batch/_jobspy.json -> batch/_screened.json
 *   node typesafe-screen.mjs --file jds/1280-*.md  # one JD, print the decision
 *   node typesafe-screen.mjs --golden              # replay jds/ vs reports/ and grade the screen
 *   node typesafe-screen.mjs --dry-run             # deterministic rules only, no API call
 *
 * Flags: --input <json> --output <json> --limit <n> --concurrency <n> --force --json
 *
 * Off by default. Enable with `screen.typesafe.enabled: true` in config/profile.yml
 * and TYPESAFE_API_KEY in .env. When disabled, or when the key or API is
 * unavailable, every candidate passes through untouched (fail-open) — the
 * screen can only ever remove Opus work, never add a rejection on its own.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import {
  DEFAULT_CONFIG, candidateFromJdText, deterministicScreen, forwardList, loadScreenConfig, profileStubFrom, screenCandidates, skillsFromCv,
} from './lib/typesafe-screen.mjs';
import { FIT_QUESTIONS, applyFitPolicy, loadFitModel } from './lib/typesafe-fit.mjs';

try { const { config } = await import('dotenv'); config(); } catch { /* dotenv optional */ }

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INPUT = flagValue(args, '--input') || join(ROOT, 'batch', '_jobspy.json');
const OUTPUT = flagValue(args, '--output') || join(ROOT, 'batch', '_screened.json');
const LIMIT = Number(flagValue(args, '--limit')) || 0;
const DRY = hasFlag(args, '--dry-run');
const FORCE = hasFlag(args, '--force');
const AS_JSON = hasFlag(args, '--json');

const profile = existsSync(join(ROOT, 'config', 'profile.yml'))
  ? yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8')) || {}
  : {};
const config = loadScreenConfig(profile);
const conc = Number(flagValue(args, '--concurrency'));
if (conc) config.concurrency = conc;
const cvPath = join(ROOT, 'cv-aiml.md');
const stub = profileStubFrom(profile, { skills: existsSync(cvPath) ? skillsFromCv(readFileSync(cvPath, 'utf8')) : [] });
const log = (m) => { if (!AS_JSON) console.log(`[screen] ${m}`); };
// Fit model (typesafe-fit.mjs fit): optional. Unreadable or stale-feature files are ignored (fail-open).
const FIT_PATH = join(ROOT, 'config', 'typesafe-fit-model.json');
let fitModel = null;
try { if (existsSync(FIT_PATH)) fitModel = loadFitModel(JSON.parse(readFileSync(FIT_PATH, 'utf8'))); } catch { fitModel = null; }

function passThrough(candidates, status) {
  return candidates.map((c) => ({ ...c, screen: { decision: 'pass', reasons: [], rank: null, status } }));
}

async function screen(candidates) {
  if (DRY) {
    return {
      candidates: candidates.map((c) => ({ ...c, screen: deterministicScreen(c) || { decision: 'pass', reasons: [], rank: null, status: 'dry-run' } })),
      totals: { calls: 0, input_tokens: 0, output_tokens: 0 },
    };
  }
  if (!config.enabled && !FORCE) {
    log('disabled in config/profile.yml (screen.typesafe.enabled) — passing every candidate through');
    return { candidates: passThrough(candidates, 'disabled'), totals: { calls: 0, input_tokens: 0, output_tokens: 0 } };
  }
  if (!process.env.TYPESAFE_API_KEY) {
    log('TYPESAFE_API_KEY not set — passing every candidate through');
    return { candidates: passThrough(candidates, 'skipped:no_api_key'), totals: { calls: 0, input_tokens: 0, output_tokens: 0 } };
  }
  if (!fitModel) return screenCandidates(candidates, { config, profileStub: stub, log });
  const res = await screenCandidates(candidates, {
    config, profileStub: stub, log, extraQuestions: FIT_QUESTIONS,
    onAnswers: (answers) => ({ fit_probability: fitModel.predict(answers) }),
  });
  res.candidates = res.candidates.map((c) => ({
    ...c, screen: applyFitPolicy(c.screen, c.screen?.fit_probability, { fitReject: config.fitReject, threshold: fitModel.threshold }),
  }));
  return res;
}

function summarize(screened, totals) {
  const by = {};
  for (const c of screened) by[c.screen.decision] = (by[c.screen.decision] || 0) + 1;
  const reasons = {};
  for (const c of screened) for (const r of c.screen.reasons || []) reasons[r] = (reasons[r] || 0) + 1;
  return { decisions: by, reasons, calls: totals.calls, tokens: { in: totals.input_tokens, out: totals.output_tokens } };
}

// ---------------------------------------------------------------------------
// --file: one JD from disk (jds/<n>-*.md layout or raw text)
// ---------------------------------------------------------------------------
function candidateFromJdFile(path) {
  return { ...candidateFromJdText(readFileSync(path, 'utf8'), basename(path)), url: path };
}

// ---------------------------------------------------------------------------
// --golden: replay past JDs against their reports
// ---------------------------------------------------------------------------
const HARD_STOP_MARKERS = [
  ['seniority', /tier mismatch|senior\/staff|senior-level|staff-level|principal-level/i],
  ['employer_type', /staffing|body.?shop|consultanc(y|ies)|agency-sourced/i],
  ['work_authorization', /clearance|\bITAR\b|\bEAR\b|U\.?S\.? Person|citizenship required|citizens only/i],
  ['phd_required', /PhD (is )?required|requires a PhD|PhD gate/i],
  ['location', /non-US|outside the US|not in the US|Canada-only|UK-only|EU-only/i],
];

function goldenSet() {
  const jdsDir = join(ROOT, 'jds');
  const repDir = join(ROOT, 'reports');
  const reports = new Map();
  for (const f of readdirSync(repDir)) {
    const m = f.match(/^(\d+)-/);
    if (m && !/RESERVED/.test(f)) reports.set(m[1], join(repDir, f));
  }
  const items = [];
  for (const f of readdirSync(jdsDir).sort()) {
    const m = f.match(/^(\d+)-/);
    if (!m || !reports.has(m[1])) continue;
    const rep = readFileSync(reports.get(m[1]), 'utf8');
    const score = Number((rep.match(/\*\*Score:\*\*\s*([0-9.]+)/) || [])[1]);
    if (!Number.isFinite(score)) continue;
    const markers = HARD_STOP_MARKERS.filter(([, re]) => re.test(rep)).map(([k]) => k);
    items.push({ num: m[1], cand: candidateFromJdFile(join(jdsDir, f)), score, markers, report: basename(reports.get(m[1])) });
  }
  return items;
}

async function runGolden() {
  let items = goldenSet();
  if (LIMIT) items = items.slice(0, LIMIT);
  log(`golden set: ${items.length} JDs with a scored report`);
  if (!items.length) return;
  const { candidates: screened, totals } = await screen(items.map((i) => i.cand));
  const rows = items.map((it, i) => ({ ...it, screen: screened[i].screen }));

  const highFit = rows.filter((r) => r.score >= 4.0);
  const falseRejects = highFit.filter((r) => r.screen.decision === 'reject');
  const lowWithMarkers = rows.filter((r) => r.score < 3.0 && r.markers.length);
  const caught = lowWithMarkers.filter((r) => r.screen.decision !== 'pass');

  const out = rows.map((r) => ({
    num: r.num, report: r.report, score: r.score, markers: r.markers,
    decision: r.screen.decision, reasons: r.screen.reasons, rank: r.screen.rank, status: r.screen.status,
    answers: r.screen.answers || null,
  }));
  writeFileSync(join(ROOT, 'batch', '_screen_golden.json'), JSON.stringify({ generated: new Date().toISOString(), totals, rows: out }, null, 2));

  console.log('\nGolden replay — TypeSafe first-pass screen');
  console.log(`  JDs replayed:                ${rows.length}   (API calls ${totals.calls}, tokens in/out ${totals.input_tokens}/${totals.output_tokens})`);
  console.log(`  ≥4.0 reports:                ${highFit.length}   false rejects: ${falseRejects.length}  ${falseRejects.length ? '❌ MUST BE 0' : '✅'}`);
  console.log(`  <3.0 reports w/ hard marker: ${lowWithMarkers.length}   caught by screen: ${caught.length}`);
  console.log(`  decisions: ${JSON.stringify(summarize(screened, totals).decisions)}`);
  for (const r of falseRejects) console.log(`   ❌ #${r.num} score ${r.score} rejected for ${r.screen.reasons.join(', ')} — ${r.report}`);
  for (const r of lowWithMarkers.filter((x) => x.screen.decision === 'pass')) console.log(`   · missed #${r.num} score ${r.score} markers [${r.markers.join(', ')}] — ${r.report}`);
  console.log(`  details: batch/_screen_golden.json`);
  if (falseRejects.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
async function main() {
  if (hasFlag(args, '--golden')) return runGolden();

  const file = flagValue(args, '--file');
  if (file) {
    const cand = candidateFromJdFile(file);
    const { candidates: [res] } = await screen([cand]);
    if (AS_JSON) console.log(JSON.stringify(res.screen, null, 2));
    else {
      console.log(`${cand.company} — ${cand.role}`);
      console.log(`  decision: ${res.screen.decision}  reasons: [${(res.screen.reasons || []).join(', ')}]  rank: ${res.screen.rank ?? '-'}  status: ${res.screen.status}`);
      if (typeof res.screen.fit_probability === 'number') console.log(`  P(Opus >= 4.0): ${res.screen.fit_probability.toFixed(3)}  (skip threshold ${fitModel.threshold.toFixed(3)}, fit_reject ${config.fitReject ? 'on' : 'off'})`);
      if (res.screen.answers) for (const [k, v] of Object.entries(res.screen.answers)) {
        const val = v.choice ?? v.noul ?? v.score;
        console.log(`    ${k.padEnd(20)} ${String(val).padEnd(38)} ${typeof v.confidence === 'number' ? `conf ${v.confidence.toFixed(2)}` : ''}`);
      }
    }
    return;
  }

  if (!existsSync(INPUT)) {
    log(`input not found: ${INPUT} — writing an empty screened list`);
    writeFileSync(OUTPUT, JSON.stringify({ screened_at: new Date().toISOString(), source: INPUT, candidates: [] }, null, 2));
    return;
  }
  const payload = JSON.parse(readFileSync(INPUT, 'utf8'));
  let candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  const t0 = Date.now();
  const { candidates: screened, totals } = await screen(candidates);
  const forward = forwardList(screened, config.maxForward);
  const summary = summarize(screened, totals);
  writeFileSync(OUTPUT, JSON.stringify({
    ...payload,
    screened_at: new Date().toISOString(),
    screen_config: { enabled: config.enabled, model: config.model, min_confidence: config.minConfidence, max_forward: config.maxForward, dry_run: DRY },
    screen_summary: summary,
    forward_urls: forward.map((c) => c.url),
    candidates: screened,
  }, null, 2));

  if (AS_JSON) console.log(JSON.stringify({ output: OUTPUT, ...summary, forwarded: forward.length }));
  else {
    log(`${screened.length} candidates -> ${forward.length} forwarded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    log(`decisions ${JSON.stringify(summary.decisions)} reasons ${JSON.stringify(summary.reasons)}`);
    if (summary.calls) log(`${summary.calls} API calls, ${summary.tokens.in} in / ${summary.tokens.out} out tokens`);
    log(`wrote ${OUTPUT}`);
  }
}

main().catch((err) => { console.error(`[screen] fatal: ${err.message}`); process.exitCode = 1; });
