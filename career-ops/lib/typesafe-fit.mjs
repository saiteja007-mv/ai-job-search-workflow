// lib/typesafe-fit.mjs — "is this JD worth an Opus evaluation?" as a calibrated probability.
//
// Composite scoring (docs.typesafe.ai/patterns/composite-scoring): Jev answers a few narrow
// questions about the posting against the non-PII candidate stub, alongside the screen's own
// questions in the SAME request. Code turns the typed answers into features, and a small
// L2-regularised logistic regression — fitted on past Opus Global Scores (label: score >= 4.0) —
// turns features into P(good). Weights live in config/typesafe-fit-model.json, not in prompts,
// so retuning never needs a new API call: answers are cached per report in batch/_fit_answers.json.
//
// Policy stays fail-open: the fit probability orders the shortlist, and it only skips a posting
// when screen.typesafe.fit_reject is on AND p < the model's threshold, which is chosen by
// cross-validation to keep recall on >=4.0 reports at the target (default 100%).

export const FIT_QUESTIONS = Object.freeze({
  skills_coverage: {
    type: 'score',
    instructions:
      'How much of the technical stack that `posting.description` REQUIRES (languages, frameworks, ' +
      'ML techniques, platforms) is covered by `candidate.skills`? Judge required items, not ' +
      'nice-to-haves.',
    criteria: [
      'Little or none: most required languages, frameworks or techniques are absent from the candidate skills',
      'Partial: the main language is covered but several required frameworks or techniques are missing',
      'Most: the main required stack is covered and only one or two secondary tools are missing',
      'Nearly all: the required stack closely matches the candidate skills',
    ],
  },
  domain_match: {
    type: 'score',
    instructions:
      'How close is the problem domain of `posting.description` (what the ML is used for: search, ' +
      'recommendations, LLM applications, vision, speech, forecasting, fraud, robotics, ...) to ' +
      'the domains in `candidate.strengths`?',
    criteria: [
      'Unrelated: a domain none of the candidate strengths touch',
      'Distant: shares general ML methods but not the application domain',
      'Related: an adjacent domain where most candidate experience transfers',
      'Same: the posting works in a domain the candidate strengths name directly',
    ],
  },
  work_type: {
    type: 'choice',
    instructions: 'What is the day-to-day work in `posting.description` mostly about?',
    criteria: {
      build_deploy_ml: 'Building, training and shipping ML/DL/LLM systems into production products or services',
      applied_research: 'Research: novel methods, papers, benchmarks, or prototypes rather than shipped systems',
      data_science_analytics: 'Data science or analytics: analysis, experimentation, statistics, dashboards, business insights',
      ml_platform_infra: 'ML platform or infrastructure used by other teams: training/serving platforms, pipelines, tooling',
      software_engineering: 'General software, backend, frontend or data engineering where ML is secondary',
      other: 'Anything else: sales engineering, solutions consulting, support, management, or non-engineering work',
    },
  },
  missing_must_have: {
    type: 'noul',
    instructions:
      '`posting.description` lists at least one REQUIRED (not preferred) qualification that the ' +
      'candidate clearly lacks: a specific skill, tool, domain, license, or credential absent from ' +
      '`candidate.skills` and `candidate.strengths`. Years of experience, degree level, and work ' +
      'authorization do NOT count here.',
  },
  genai_llm_core: {
    type: 'noul',
    instructions:
      'The core work of `posting.description` is building LLM or generative-AI applications: RAG, ' +
      'agents, prompt or tool pipelines, fine-tuning, evaluation, or serving LLMs.',
  },
  // Opus's Global Score also weighs pay and company/culture signals (modes/_shared.md Scoring System).
  // These read facts off the posting only; the candidate's own salary target never leaves the machine.
  pay_band: {
    type: 'choice',
    instructions:
      'What annual base salary does `posting.description` state for this role in USD? Use the ' +
      'midpoint of a stated range; convert hourly pay at 2,080 hours per year.',
    criteria: {
      not_stated: 'No salary or pay range is stated',
      under_100k: 'Midpoint below $100,000',
      '100k_130k': 'Midpoint from $100,000 to $130,000',
      '130k_160k': 'Midpoint from $130,000 to $160,000',
      '160k_200k': 'Midpoint from $160,000 to $200,000',
      over_200k: 'Midpoint above $200,000',
    },
  },
  remote_policy: {
    type: 'choice',
    instructions: 'What work arrangement does `posting.description` (and `posting.location`) offer?',
    criteria: {
      remote: 'Fully remote (possibly limited to US time zones or states)',
      hybrid: 'Hybrid: some required days in an office',
      onsite: 'Fully on-site',
      unstated: 'The posting does not say',
    },
  },
  company_stage: {
    type: 'choice',
    instructions: 'What kind of company is hiring in `posting.description` and `posting.company`?',
    criteria: {
      early_startup: 'Seed to Series B startup, or a company describing itself as small and early',
      growth_company: 'Later-stage private or recently public tech company that is still scaling',
      big_tech: 'Large, established technology company (FAANG-scale or a well-known public tech firm)',
      non_tech_enterprise: 'Large company outside tech: bank, insurer, retailer, manufacturer, healthcare, consulting',
      unclear: 'Cannot tell from the text',
    },
  },
});

// ---------------------------------------------------------------------------
// Report + posting identity
// ---------------------------------------------------------------------------

/** host+path, lowercased, www/apply stripped, plus a job id from common query keys. */
export function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    const id = x.searchParams.get('gh_jid') || x.searchParams.get('jk') || x.searchParams.get('currentJobId');
    const path = x.pathname.replace(/\/(apply|application)\/?$/i, '').replace(/\/+$/, '');
    return (x.hostname.replace(/^www\./, '') + path + (id ? `#${id}` : '')).toLowerCase();
  } catch { return null; }
}

/** Company + role as a loose join key: lowercase alphanumerics, punctuation and suffixes dropped. */
export function normKey(company, role) {
  const clean = (s) => String(s || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const c = clean(company); const r = clean(role);
  return c && r ? `${c}|${r}` : null;
}

/** "# 901 - DoorDash - Software Engineer, ML" + **Score:** 3.7/5 + **URL:** ... */
export function parseReport(text, filename = '') {
  const num = (String(filename).match(/^(\d+)-/) || [])[1] || null;
  const score = Number((text.match(/\*\*Score:\*\*\s*([0-9.]+)/) || [])[1]);
  const url = (text.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1] || null;
  const h1 = (text.match(/^#\s+(.+)$/m) || [])[1] || '';
  const parts = h1.split(/\s+[-—]\s+/);
  const [company, ...roleParts] = /^\d+$/.test(parts[0]) ? parts.slice(1) : parts;
  const date = (String(filename).match(/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1] || null;
  return { num, score: Number.isFinite(score) ? score : null, url, company: (company || '').trim(), role: roleParts.join(' - ').trim(), date };
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

const prob = (a, key) => (a?.probabilities && typeof a.probabilities[key] === 'number' ? a.probabilities[key] : (a?.choice === key ? 1 : 0));
const noul = (a, dflt = 0.5) => (typeof a?.noul === 'number' ? a.noul : dflt);
const score = (a, dflt = 1.5) => (typeof a?.score === 'number' ? a.score : dflt);

export const FEATURES = Object.freeze([
  ['role_fit', (a) => score(a.role_fit)],
  ['skills_coverage', (a) => score(a.skills_coverage)],
  ['domain_match', (a) => score(a.domain_match)],
  ['missing_must_have', (a) => noul(a.missing_must_have)],
  ['genai_llm_core', (a) => noul(a.genai_llm_core)],
  ['leadership_scope', (a) => noul(a.leadership_scope, 0)],
  ['phd_required', (a) => noul(a.phd_required, 0)],
  ['years_0_2', (a) => prob(a.min_years_required, '0_2')],
  ['years_3_5', (a) => prob(a.min_years_required, '3_5')],
  ['years_6_plus', (a) => prob(a.min_years_required, '6_plus')],
  ['work_build_deploy', (a) => prob(a.work_type, 'build_deploy_ml')],
  ['work_research', (a) => prob(a.work_type, 'applied_research')],
  ['work_data_science', (a) => prob(a.work_type, 'data_science_analytics')],
  ['work_platform', (a) => prob(a.work_type, 'ml_platform_infra')],
  ['work_swe', (a) => prob(a.work_type, 'software_engineering')],
  ['employer_staffing', (a) => prob(a.employer_type, 'staffing_agency_or_consultancy')],
  ['employer_government', (a) => prob(a.employer_type, 'government_or_public_sector')],
  ['location_outside_usa', (a) => prob(a.location_scope, 'outside_usa')],
  ['work_auth_blocked', (a) => (a.work_authorization ? 1 - prob(a.work_authorization, 'no_such_requirement') : 0)],
  ['pay_stated', (a) => (a.pay_band ? 1 - prob(a.pay_band, 'not_stated') : 0)],
  ['pay_under_100k', (a) => prob(a.pay_band, 'under_100k')],
  ['pay_130k_plus', (a) => prob(a.pay_band, '130k_160k') + prob(a.pay_band, '160k_200k') + prob(a.pay_band, 'over_200k')],
  ['remote', (a) => prob(a.remote_policy, 'remote')],
  ['onsite', (a) => prob(a.remote_policy, 'onsite')],
  ['early_startup', (a) => prob(a.company_stage, 'early_startup')],
  ['big_tech', (a) => prob(a.company_stage, 'big_tech')],
  ['non_tech_enterprise', (a) => prob(a.company_stage, 'non_tech_enterprise')],
]);
export const FEATURE_NAMES = FEATURES.map(([n]) => n);

/** Typed answers -> numeric vector (missing answers fall back to neutral values). */
export function featuresFrom(answers = {}) {
  return FEATURES.map(([, f]) => Number(f(answers)) || 0);
}

// ---------------------------------------------------------------------------
// Model: standardised L2 logistic regression, fitted by full-batch gradient descent
// ---------------------------------------------------------------------------

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function fitLogistic(X, y, { lambda = 1, iters = 3000, lr = 0.1 } = {}) {
  const n = X.length; const d = X[0].length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0); let b = Math.log((y.reduce((s, v) => s + v, 0) + 0.5) / (n - y.reduce((s, v) => s + v, 0) + 0.5));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const e = sigmoid(Z[i].reduce((s, v, j) => s + v * w[j], b)) - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda / n) * w[j]);
    b -= lr * (gb / n);
  }
  return { mean, std, weights: w, bias: b };
}

export function predictProba(model, x) {
  const z = x.reduce((s, v, j) => s + ((v - model.mean[j]) / model.std[j]) * model.weights[j], model.bias);
  return sigmoid(z);
}

/** Lowest threshold t such that at least `target` of the positives score >= t. */
export function thresholdForRecall(posProbs, target = 1) {
  if (!posProbs.length) return 0;
  const s = [...posProbs].sort((a, b) => a - b);
  const drop = Math.floor((1 - target) * s.length + 1e-9);
  return s[Math.min(drop, s.length - 1)];
}

/** Rank-based AUC (probability a random positive outranks a random negative; ties count half). */
export function auc(probs, labels) {
  const pos = probs.filter((_, i) => labels[i] === 1); const neg = probs.filter((_, i) => labels[i] === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// Seeded PRNG so a CV report is reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Stratified k-fold assignment: returns fold index per sample. */
export function stratifiedFolds(y, k, seed = 1) {
  const r = rng(seed); const fold = new Array(y.length);
  for (const cls of [0, 1]) {
    const idx = y.map((v, i) => (v === cls ? i : -1)).filter((i) => i >= 0);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    idx.forEach((i, n) => { fold[i] = n % k; });
  }
  return fold;
}

/** Out-of-fold probabilities for every sample (one k-fold pass). */
export function oofProbs(X, y, { k = 5, seed = 1, ...fitOpts } = {}) {
  const fold = stratifiedFolds(y, k, seed); const out = new Array(y.length);
  for (let f = 0; f < k; f++) {
    const tr = y.map((_, i) => i).filter((i) => fold[i] !== f);
    const m = fitLogistic(tr.map((i) => X[i]), tr.map((i) => y[i]), fitOpts);
    y.forEach((_, i) => { if (fold[i] === f) out[i] = predictProba(m, X[i]); });
  }
  return out;
}

/**
 * Nested, repeated CV of the whole policy: in each outer split the skip-threshold is chosen from
 * inner out-of-fold probabilities on the training part only, then applied to the unseen fold.
 */
// `margin` scales the chosen threshold down (e.g. 0.8) to buy held-out recall with skip rate:
// a threshold tuned on training folds cannot guarantee the target on unseen postings.
export function crossValidate(X, y, { folds = 5, repeats = 10, targetRecall = 1, lambda = 1, seed = 7, margin = 1 } = {}) {
  let posKept = 0; let posTotal = 0; let negSkipped = 0; let negTotal = 0;
  const oofSum = new Array(y.length).fill(0); const oofCnt = new Array(y.length).fill(0);
  for (let rep = 0; rep < repeats; rep++) {
    const fold = stratifiedFolds(y, folds, seed + rep);
    for (let f = 0; f < folds; f++) {
      const tr = y.map((_, i) => i).filter((i) => fold[i] !== f);
      const te = y.map((_, i) => i).filter((i) => fold[i] === f);
      const Xtr = tr.map((i) => X[i]); const ytr = tr.map((i) => y[i]);
      const inner = oofProbs(Xtr, ytr, { k: folds, seed: seed * 31 + rep * 7 + f, lambda });
      const t = thresholdForRecall(inner.filter((_, i) => ytr[i] === 1), targetRecall) * margin;
      const m = fitLogistic(Xtr, ytr, { lambda });
      for (const i of te) {
        const p = predictProba(m, X[i]); oofSum[i] += p; oofCnt[i]++;
        if (y[i] === 1) { posTotal++; if (p >= t) posKept++; } else { negTotal++; if (p < t) negSkipped++; }
      }
    }
  }
  const oof = oofSum.map((s, i) => s / (oofCnt[i] || 1));
  return { recall: posTotal ? posKept / posTotal : null, negSkipRate: negTotal ? negSkipped / negTotal : null, auc: auc(oof, y), oof };
}

/**
 * Validate a saved config/typesafe-fit-model.json. Returns a predictor or null (fail-open) when the
 * file was trained on a different feature set than this code computes.
 */
export function loadFitModel(json) {
  const m = json?.model;
  const ok = m && Array.isArray(json.features) && json.features.join(',') === FEATURE_NAMES.join(',')
    && [m.mean, m.std, m.weights].every((a) => Array.isArray(a) && a.length === FEATURE_NAMES.length)
    && typeof m.bias === 'number' && typeof json.threshold === 'number';
  if (!ok) return null;
  return { threshold: json.threshold, predict: (answers) => predictProba(m, featuresFrom(answers)) };
}

/** Attach P(good) and, only when enabled, turn a low probability into a skip. Pure. */
export function applyFitPolicy(screen, pGood, { fitReject = false, threshold = null } = {}) {
  if (!screen || typeof pGood !== 'number') return screen;
  const out = { ...screen, fit_probability: pGood, rank: pGood };
  if (fitReject && typeof threshold === 'number' && screen.decision === 'pass' && pGood < threshold) {
    out.decision = 'reject'; out.reasons = [...(screen.reasons || []), `low_fit:${pGood.toFixed(3)}<${threshold.toFixed(3)}`];
  }
  return out;
}
