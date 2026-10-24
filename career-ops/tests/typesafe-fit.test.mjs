// tests/typesafe-fit.test.mjs — the "worth an Opus run?" fit model. No network.
import { pass, fail } from './helpers.mjs';
import {
  FIT_QUESTIONS, FEATURE_NAMES, featuresFrom, normUrl, normKey, parseReport,
  fitLogistic, predictProba, thresholdForRecall, auc, stratifiedFolds, crossValidate, applyFitPolicy, loadFitModel,
} from '../lib/typesafe-fit.mjs';
import { QUESTIONS, candidateFromJdText, loadScreenConfig } from '../lib/typesafe-screen.mjs';

console.log('\nTypeSafe fit model (lib/typesafe-fit.mjs)');
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

// --- identity + report parsing ------------------------------------------------------
check(normUrl('https://example-company.com/company/careers/roles/7491153?gh_jid=7491153') === 'example-company.com/company/careers/roles/7491153#7491153', 'normUrl keeps gh_jid and drops www');
check(normUrl('https://apply.workable.com/acme/j/ABC/apply') === normUrl('https://apply.workable.com/acme/j/ABC/'), 'normUrl strips /apply and trailing slash');
check(normUrl('not a url') === null, 'normUrl returns null for junk');
check(normKey('Acme, Inc.', 'ML Engineer II') === normKey('acme', 'ML engineer II') && normKey('', 'x') === null, 'normKey is case/punctuation/suffix insensitive and needs both parts');
{
  const r = parseReport('# 901 - DoorDash - Software Engineer - ML Infra\n\n**Score:** 3.7/5\n**URL:** https://x.io/j/1\n', '<NUM>-<company-slug>-<date>.md');
  check(r.num === '901' && r.score === 3.7 && r.url === 'https://x.io/j/1' && r.company === 'DoorDash' && r.role === 'Software Engineer - ML Infra' && r.date === '2026-07-15', 'parseReport reads number, score, URL, company, role, date');
  check(parseReport('# x\nno score', '5-x.md').score === null, 'parseReport: missing score is null');
}

// --- questions -----------------------------------------------------------------------
check(!Object.keys(FIT_QUESTIONS).some((k) => k in QUESTIONS), 'fit question ids never collide with screen question ids');
check(Object.values(FIT_QUESTIONS).every((q) => ['score', 'choice', 'noul'].includes(q.type) && q.instructions.length > 40), 'every fit question is a typed primitive with real instructions');
check(/do NOT count/.test(FIT_QUESTIONS.missing_must_have.instructions), 'missing_must_have excludes years/degree/work-auth (those are policy, not fit)');

// --- features ------------------------------------------------------------------------
{
  const answers = {
    role_fit: { score: 2.9 }, skills_coverage: { score: 2.5 }, domain_match: { score: 3 },
    missing_must_have: { noul: 0.1 }, genai_llm_core: { noul: 0.8 }, leadership_scope: { noul: 0.02 },
    min_years_required: { choice: '3_5', probabilities: { '0_2': 0, '3_5': 0.9, '6_plus': 0.1, not_stated: 0 } },
    work_type: { choice: 'build_deploy_ml', probabilities: { build_deploy_ml: 0.7, applied_research: 0.2 } },
    work_authorization: { choice: 'no_such_requirement', probabilities: { no_such_requirement: 0.97 } },
  };
  const x = featuresFrom(answers);
  const at = (n) => x[FEATURE_NAMES.indexOf(n)];
  check(x.length === FEATURE_NAMES.length && x.every(Number.isFinite), 'featuresFrom returns one finite number per feature');
  check(at('role_fit') === 2.9 && at('years_3_5') === 0.9 && at('work_research') === 0.2, 'features read scores and choice probabilities');
  check(Math.abs(at('work_auth_blocked') - 0.03) < 1e-9, 'work_auth_blocked = 1 - P(no_such_requirement)');
  check(featuresFrom({}).every(Number.isFinite), 'empty answers still give a finite vector (neutral defaults)');
}

// --- model ---------------------------------------------------------------------------
{
  // separable: label = x0 > 0
  const X = []; const y = [];
  for (let i = 0; i < 80; i++) { const v = (i - 40) / 10; X.push([v, (i * 7) % 5]); y.push(v > 0 ? 1 : 0); }
  const m = fitLogistic(X, y, { lambda: 0.1 });
  const acc = X.filter((x, i) => (predictProba(m, x) >= 0.5 ? 1 : 0) === y[i]).length / X.length;
  check(acc >= 0.97, `logistic fit separates a separable set (acc ${acc.toFixed(2)})`);
  check(predictProba(m, [3, 0]) > predictProba(m, [-3, 0]), 'probability rises with the informative feature');
  // Held-out recall can't be guaranteed at exactly the target; a margin trades skips for recall.
  const cv = crossValidate(X, y, { folds: 5, repeats: 2, targetRecall: 1, lambda: 0.1 });
  check(cv.recall >= 0.9 && cv.negSkipRate > 0.8 && cv.auc > 0.97, `nested CV: high held-out recall and skips negatives (recall ${cv.recall.toFixed(2)}, skip ${cv.negSkipRate.toFixed(2)})`);
  const safe = crossValidate(X, y, { folds: 5, repeats: 2, targetRecall: 1, lambda: 0.1, margin: 0.5 });
  check(safe.recall >= cv.recall && safe.negSkipRate <= cv.negSkipRate, `margin < 1 never lowers recall and never raises skips (recall ${safe.recall.toFixed(2)}, skip ${safe.negSkipRate.toFixed(2)})`);
}
check(thresholdForRecall([0.9, 0.2, 0.5, 0.7], 1) === 0.2 && thresholdForRecall([0.9, 0.2, 0.5, 0.7], 0.75) === 0.5, 'thresholdForRecall picks the lowest kept positive');
check(auc([0.9, 0.8, 0.3, 0.1], [1, 1, 0, 0]) === 1 && auc([0.1, 0.9], [1, 0]) === 0 && auc([0.5], [1]) === null, 'auc is rank-based and null without both classes');
{
  const y = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const f = stratifiedFolds(y, 5, 3);
  check([0, 1, 2, 3, 4].every((k) => f.filter((v, i) => v === k && y[i] === 1).length === 1), 'stratifiedFolds puts one positive in each of 5 folds');
}

// --- saved model file ----------------------------------------------------------------
{
  const n = FEATURE_NAMES.length;
  const good = { features: FEATURE_NAMES, threshold: 0.2, model: { mean: new Array(n).fill(0), std: new Array(n).fill(1), weights: new Array(n).fill(0), bias: 0 } };
  const fm = loadFitModel(good);
  check(fm && fm.threshold === 0.2 && Math.abs(fm.predict({}) - 0.5) < 1e-9, 'loadFitModel returns a predictor for a well-formed file');
  check(loadFitModel({ ...good, features: [...FEATURE_NAMES].reverse() }) === null, 'stale feature order -> null (fail-open, never mis-scores)');
  check(loadFitModel({ ...good, threshold: undefined }) === null && loadFitModel(null) === null, 'missing threshold or file -> null');
}
{
  const c = candidateFromJdText('# Acme — ML Engineer II\n**Location:** Austin, TX\n\n## Description\nBuild RAG systems.', 'x.md');
  check(c.company === 'Acme' && c.role === 'ML Engineer II' && c.location === 'Austin, TX' && c.description === 'Build RAG systems.', 'candidateFromJdText parses the jds/ capture layout');
  check(loadScreenConfig({}).fitReject === false && loadScreenConfig({ screen: { typesafe: { fit_reject: true } } }).fitReject === true, 'fit_reject is off unless profile.yml turns it on');
}

// --- policy --------------------------------------------------------------------------
{
  const s = { decision: 'pass', reasons: [], rank: 2.5 };
  const a = applyFitPolicy(s, 0.1, { fitReject: false, threshold: 0.3 });
  check(a.decision === 'pass' && a.fit_probability === 0.1 && a.rank === 0.1, 'fit_reject off: probability attached and used as rank, never rejects');
  const b = applyFitPolicy(s, 0.1, { fitReject: true, threshold: 0.3 });
  check(b.decision === 'reject' && /^low_fit:/.test(b.reasons[0]), 'fit_reject on: below threshold is skipped');
  check(applyFitPolicy(s, 0.5, { fitReject: true, threshold: 0.3 }).decision === 'pass', 'fit_reject on: above threshold passes');
  check(applyFitPolicy({ decision: 'reject', reasons: ['x'] }, 0.9, { fitReject: true, threshold: 0.3 }).reasons.length === 1, 'an existing reject is not re-labelled');
  check(applyFitPolicy(s, undefined, { fitReject: true, threshold: 0.3 }) === s, 'no probability (API skipped) -> record untouched, fail-open');
}
