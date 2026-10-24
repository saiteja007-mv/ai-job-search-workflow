#!/usr/bin/env node
/**
 * typesafe-fit.mjs — learn "is this JD worth an Opus evaluation?" from past Opus Global Scores.
 *
 *   node typesafe-fit.mjs dataset   # pair scored reports/ with full JD text (jds/, batch/, data/)
 *   node typesafe-fit.mjs ask       # Jev answers screen + fit questions per JD (cached, resumable)
 *   node typesafe-fit.mjs fit       # screen-policy check, nested CV, save config/typesafe-fit-model.json
 *   node typesafe-fit.mjs all       # the three in order
 *
 * Outputs: batch/_fit_dataset.json, batch/_fit_answers.json, batch/_fit_report.json,
 * config/typesafe-fit-model.json (read by typesafe-screen.mjs; skipping on fit also needs
 * screen.typesafe.fit_reject: true). Only the non-PII profile stub leaves the machine.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { flagValue } from './lib/cli-flags.mjs';
import {
  QUESTIONS, askTypeSafe, buildState, candidateFromJdText, decide, deterministicScreen,
  loadScreenConfig, profileStubFrom, skillsFromCv, TITLE_TIER_RE,
} from './lib/typesafe-screen.mjs';
import {
  FIT_QUESTIONS, FEATURE_NAMES, auc, crossValidate, featuresFrom, fitLogistic, normKey, normUrl,
  parseReport, thresholdForRecall,
} from './lib/typesafe-fit.mjs';

try { const { config } = await import('dotenv'); config(); } catch { /* dotenv optional */ }

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CMD = args[0] || 'all';
const DATASET = join(ROOT, 'batch', '_fit_dataset.json');
const ANSWERS = join(ROOT, 'batch', '_fit_answers.json');
const REPORT = join(ROOT, 'batch', '_fit_report.json');
const MODEL = join(ROOT, 'config', 'typesafe-fit-model.json');
const CONCURRENCY = Number(flagValue(args, '--concurrency')) || 4;
const TARGET_RECALL = Number(flagValue(args, '--target-recall')) || 1;
const log = (m) => console.log(`[fit] ${m}`);

const profile = existsSync(join(ROOT, 'config', 'profile.yml')) ? yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8')) || {} : {};
const screenConfig = loadScreenConfig(profile);
const cvPath = join(ROOT, 'cv-aiml.md');
const stub = profileStubFrom(profile, { skills: existsSync(cvPath) ? skillsFromCv(readFileSync(cvPath, 'utf8')) : [] });

// ---------------------------------------------------------------------------
// dataset: scored report + the JD text Opus evaluated
// ---------------------------------------------------------------------------
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => {
  const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p];
}) : []);

function indexJdTexts() {
  const byUrl = new Map(); const byKey = new Map();
  const keep = (map, k, rec) => { if (k && (!map.has(k) || map.get(k).description.length < rec.description.length)) map.set(k, rec); };
  const visit = (o) => {
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (!o || typeof o !== 'object') return;
    const description = o.description || o.job_description || o.descriptionText;
    const urls = [o.job_url, o.url, o.job_url_direct, o.apply_url, o.jobUrl, o.link].filter((u) => typeof u === 'string');
    if (typeof description === 'string' && description.length >= 300) {
      const rec = {
        description, company: o.company || o.company_name || o.companyName || '', role: o.title || o.job_title || o.role || '',
        location: typeof o.location === 'string' ? o.location : '',
      };
      for (const u of urls) keep(byUrl, normUrl(u), rec);
      keep(byKey, normKey(rec.company, rec.role), rec);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  for (const f of [...walk(join(ROOT, 'batch')), ...walk(join(ROOT, 'data'))]) {
    if (!/\.jsonl?$/.test(f) || /[\\/]_fit_/.test(f)) continue;
    const raw = readFileSync(f, 'utf8');
    try { visit(JSON.parse(raw)); } catch { for (const line of raw.split('\n')) { try { visit(JSON.parse(line)); } catch { /* not JSON */ } } }
  }
  return { byUrl, byKey };
}

function buildDataset() {
  const jds = new Map();
  for (const f of walk(join(ROOT, 'jds'))) { const m = f.match(/[\\/](\d+)-[^\\/]*\.md$/); if (m) jds.set(m[1], f); }
  const { byUrl, byKey } = indexJdTexts();
  const items = []; const unmatched = [];
  for (const f of readdirSync(join(ROOT, 'reports')).sort()) {
    if (!/^\d+-.*\.md$/.test(f) || /RESERVED/.test(f)) continue;
    const rep = parseReport(readFileSync(join(ROOT, 'reports', f), 'utf8'), f);
    if (rep.score === null) continue;
    let cand = null; let source = null;
    if (jds.has(rep.num)) {
      const c = candidateFromJdText(readFileSync(jds.get(rep.num), 'utf8'));
      if (c.description.length >= 300) { cand = c; source = 'jds'; }
    }
    if (!cand && rep.url && byUrl.has(normUrl(rep.url))) { cand = byUrl.get(normUrl(rep.url)); source = 'url'; }
    if (!cand && byKey.has(normKey(rep.company, rep.role))) { cand = byKey.get(normKey(rep.company, rep.role)); source = 'company+role'; }
    if (!cand) { unmatched.push(rep.num); continue; }
    items.push({
      num: rep.num, score: rep.score, label: rep.score >= 4 ? 1 : 0, date: rep.date, report: f, source,
      url: rep.url, company: rep.company || cand.company, role: rep.role || cand.role, location: cand.location || '', description: cand.description,
    });
  }
  const bySource = items.reduce((a, i) => ({ ...a, [i.source]: (a[i.source] || 0) + 1 }), {});
  const stats = { items: items.length, positives: items.filter((i) => i.label).length, unmatched: unmatched.length, bySource };
  writeFileSync(DATASET, JSON.stringify({ generated: new Date().toISOString(), stats, items }, null, 2));
  log(`dataset: ${stats.items} JDs paired with a scored report (${stats.positives} >= 4.0); ${stats.unmatched} reports had no JD text; by source ${JSON.stringify(bySource)}`);
  return items;
}

// ---------------------------------------------------------------------------
// ask: one Jev request per JD with screen + fit questions (cached by report number)
// ---------------------------------------------------------------------------
async function askAll() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set in .env');
  const { items } = JSON.parse(readFileSync(DATASET, 'utf8'));
  const cache = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {};
  const all = { ...QUESTIONS, ...FIT_QUESTIONS };
  // Re-ask only questions that are new or whose wording changed since the cached answer.
  const hash = Object.fromEntries(Object.entries(all).map(([k, q]) => [k, createHash('sha1').update(JSON.stringify(q)).digest('hex').slice(0, 12)]));
  const stale = (num) => Object.keys(all).filter((k) => cache[num]?.hashes?.[k] !== hash[k]);
  const todo = items.filter((i) => stale(i.num).length);
  log(`ask: ${items.length - todo.length} up to date, ${todo.length} need answers (concurrency ${CONCURRENCY})`);
  let next = 0; let done = 0; let failed = 0; let tokens = 0;
  const save = () => writeFileSync(ANSWERS, JSON.stringify(cache, null, 2));
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      const ids = stale(it.num);
      const questions = Object.fromEntries(ids.map((k) => [k, all[k]]));
      try {
        const { answers, usage, model } = await askTypeSafe(buildState(it, stub), questions, { model: screenConfig.model, timeoutMs: 45_000 });
        const prev = cache[it.num] || { answers: {}, hashes: {} };
        cache[it.num] = {
          answers: { ...prev.answers, ...answers }, model, at: new Date().toISOString(),
          hashes: { ...(prev.hashes || {}), ...Object.fromEntries(ids.map((k) => [k, hash[k]])) },
        };
        tokens += usage?.input_tokens || 0;
        if (++done % 10 === 0) { save(); log(`  ${done}/${todo.length}`); }
      } catch (err) { failed++; log(`  #${it.num} failed: ${err.message.slice(0, 120)}`); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();
  log(`ask: ${done} answered, ${failed} failed, ~${tokens} input tokens (~$${(tokens * 0.042 / 1e6).toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// fit: screen-policy check on the whole set, then nested CV of the fit model
// ---------------------------------------------------------------------------
function fitModel() {
  const { items } = JSON.parse(readFileSync(DATASET, 'utf8'));
  const cache = JSON.parse(readFileSync(ANSWERS, 'utf8'));
  const rows = items.filter((i) => cache[i.num]).map((i) => {
    const answers = cache[i.num].answers;
    const det = deterministicScreen(i);
    const screen = det || decide(answers, screenConfig, { titleTier: TITLE_TIER_RE.test(i.role || '') });
    return { ...i, answers, screen };
  });
  const pos = rows.filter((r) => r.label);
  const falseRejects = pos.filter((r) => r.screen.decision !== 'pass');
  const negRemoved = rows.filter((r) => !r.label && r.screen.decision !== 'pass');
  log(`screen policy on ${rows.length} JDs: ${falseRejects.length}/${pos.length} >=4.0 wrongly removed; ${negRemoved.length}/${rows.length - pos.length} <4.0 removed`);
  for (const r of falseRejects) log(`  ❌ #${r.num} (${r.score}) ${r.screen.decision} [${(r.screen.reasons || []).join(', ')}] ${r.company} — ${r.role}`);

  // The fit model only ever sees postings the screen lets through.
  const stage = rows.filter((r) => r.screen.decision === 'pass');
  const X = stage.map((r) => featuresFrom(r.answers)); const y = stage.map((r) => r.label);
  const nPos = y.filter(Boolean).length;
  log(`fit stage: ${stage.length} JDs (${nPos} >=4.0, ${stage.length - nPos} <4.0)`);
  if (nPos < 10 || stage.length - nPos < 10) throw new Error('need at least 10 of each class to fit');

  const baseline = auc(X.map((x) => x[FEATURE_NAMES.indexOf('role_fit')]), y);
  const lambdas = [0.3, 1, 3, 10, 30];
  const byLambda = lambdas.map((lambda) => ({ lambda, auc: crossValidate(X, y, { lambda, repeats: 5, targetRecall: TARGET_RECALL }).auc }));
  const best = byLambda.reduce((a, b) => (b.auc > a.auc ? b : a));
  const margins = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  const byMargin = margins.map((margin) => ({ margin, ...pick(crossValidate(X, y, { lambda: best.lambda, repeats: 20, targetRecall: TARGET_RECALL, margin })) }));
  // Most skipping while held-out recall on >=4.0 stays >= 98%; otherwise the most conservative margin.
  const safe = byMargin.filter((m) => m.recall >= 0.98);
  const chosen = safe.length ? safe.reduce((a, b) => (b.negSkipRate > a.negSkipRate ? b : a)) : byMargin[byMargin.length - 1];

  const full = crossValidate(X, y, { lambda: best.lambda, repeats: 20, targetRecall: TARGET_RECALL });
  const baseThreshold = thresholdForRecall(full.oof.filter((_, i) => y[i] === 1), TARGET_RECALL);
  const model = fitLogistic(X, y, { lambda: best.lambda });
  const threshold = baseThreshold * chosen.margin;
  const weights = FEATURE_NAMES.map((f, j) => ({ feature: f, weight: +model.weights[j].toFixed(3) })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  const out = {
    version: 1, trained_at: new Date().toISOString(), model_id: screenConfig.model, features: FEATURE_NAMES,
    n: stage.length, positives: nPos, lambda: best.lambda, target_recall: TARGET_RECALL, margin: chosen.margin, threshold,
    cv: { auc_composite: full.auc, auc_role_fit_only: baseline, heldout_recall: chosen.recall, heldout_neg_skip_rate: chosen.negSkipRate },
    model,
  };
  writeFileSync(MODEL, JSON.stringify(out, null, 2));
  writeFileSync(REPORT, JSON.stringify({
    generated: out.trained_at, screen: { rows: rows.length, falseRejects: falseRejects.map((r) => ({ num: r.num, score: r.score, reasons: r.screen.reasons })), negRemoved: negRemoved.length },
    byLambda, byMargin, chosen, weights,
    oof: stage.map((r, i) => ({ num: r.num, score: r.score, label: r.label, p: +full.oof[i].toFixed(4), company: r.company, role: r.role })),
  }, null, 2));

  log(`AUC (P(good) ranks a >=4.0 JD above a <4.0 one): composite ${full.auc.toFixed(3)} vs role_fit alone ${baseline.toFixed(3)}  [lambda ${best.lambda}]`);
  for (const m of byMargin) log(`  margin ${m.margin.toFixed(1)}: held-out recall ${(m.recall * 100).toFixed(1)}%  |  <4.0 skipped ${(m.negSkipRate * 100).toFixed(1)}%${m === chosen ? '   <- chosen' : ''}`);
  log(`top weights: ${weights.slice(0, 6).map((w) => `${w.feature} ${w.weight > 0 ? '+' : ''}${w.weight}`).join(', ')}`);
  log(`saved ${MODEL} (threshold ${threshold.toFixed(3)}); per-JD probabilities in ${REPORT}`);
}
const pick = (cv) => ({ recall: cv.recall, negSkipRate: cv.negSkipRate, auc: cv.auc });

// ---------------------------------------------------------------------------
async function main() {
  if (CMD === 'dataset' || CMD === 'all') buildDataset();
  if (CMD === 'ask' || CMD === 'all') await askAll();
  if (CMD === 'fit' || CMD === 'all') fitModel();
  if (!['dataset', 'ask', 'fit', 'all'].includes(CMD)) console.log('usage: node typesafe-fit.mjs dataset|ask|fit|all [--concurrency 4] [--target-recall 1]');
}
main().catch((err) => { console.error(`[fit] fatal: ${err.message}`); process.exitCode = 1; });
