// lib/typesafe-screen.mjs — first-pass JD screen via TypeSafe System One.
//
// Sits between the JobSpy scan and the full Opus A–G evaluation. One request
// per posting asks the hard-rule questions the evaluator would otherwise spend
// a whole agent run discovering (senior tier, U.S.-Person/clearance gate,
// staffing agency, non-US, unreadable JD, PhD gate) and one ranking Score.
//
// Policy lives here in code, not in the model, and mirrors modes/_profile.md:
//   - Director/Principal/VP/Head titles reject outright; Senior/Sr/Staff/Lead/III/IV/Manager
//     titles reject only when the JD's stated minimum years is confidently NOT 3–5
//     (the 2026-07-26 title-inflation exception);
//   - a years requirement alone never rejects (3–5 yrs is the target, 5+ is a stretch Opus
//     still scores ≥4.0) — it is a fit signal, not a gate;
//   - a Choice only rejects when its confidence >= minConfidence (fail-open);
//   - sponsorship language NEVER rejects (modes/_profile.md standing override,
//     2026-07-08) — the only work-auth blockers are U.S.-Person/export-control,
//     security clearance, and citizenship;
//   - role_fit orders the shortlist and never rejects — fit stays Opus's call;
//   - any transport failure passes the candidate through with a `skipped` status.
//
// Raw answers are kept on every candidate so thresholds can be retuned from
// batch/_screened.json without calling the API again.

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const MAX_DESCRIPTION_CHARS = 12_000;
export const MIN_DESCRIPTION_CHARS = 200;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  model: DEFAULT_MODEL,
  minConfidence: 0.6,   // Choice must be at least this sure before it can reject
  phdThreshold: 0.8,    // Noul probability that "PhD is required" triggers a reject
  leadershipThreshold: 0.85, // Noul probability that the role manages people / owns staff-level scope
  readableThreshold: 0.3, // below this the JD text is treated as not a job description
  maxForward: 25,       // candidates handed to the Opus evaluator per round
  concurrency: 4,
  timeoutMs: 20_000,
});

// modes/_profile.md HARD-REJECT list, split by the 2026-07-26 exception.
// Absolute tiers never qualify, whatever the stated years: no API call needed.
export const ABSOLUTE_TIER_RE = /\b(principal|director|head|vp)\b/i;
// These qualify for evaluation when the JD states 3–5 years, so they need the model's years answer.
export const TITLE_TIER_RE = /\b(senior|sr\.?|staff|lead|iii|iv|manager)\b/i;

export const QUESTIONS = Object.freeze({
  jd_is_readable: {
    type: 'noul',
    instructions:
      '`posting.description` is an actual job description (it describes a role, responsibilities, ' +
      'or qualifications) rather than an error page, login wall, cookie notice, navigation menu, ' +
      'or unrelated boilerplate.',
  },
  leadership_scope: {
    type: 'noul',
    instructions:
      'The role in `posting.description` manages people or carries staff-level scope: it names ' +
      'direct reports, managing or leading a team of engineers, hiring, or organisation-wide ' +
      'technical ownership as an architect or staff/principal engineer. Mentoring others, ' +
      'collaborating across teams, or owning a model, feature, or service end to end does NOT count, ' +
      'and neither does a years-of-experience requirement on its own.',
  },
  min_years_required: {
    type: 'choice',
    instructions:
      'What is the minimum years of professional experience `posting.description` states as ' +
      'REQUIRED (not preferred or nice-to-have)? When a range is given (e.g. 4–6 years) use its ' +
      'lower bound. When the bar differs by degree, use the bar for a Master\'s degree holder. ' +
      'Ignore years attached only to one specific tool or to a preferred qualification.',
    criteria: {
      not_stated: 'No required years of experience are stated',
      '0_2': '0, 1, or 2 years, or explicitly entry level / new grad / recent graduates',
      '3_5': '3, 4, or 5 years, including "5+ years" and ranges starting at 3, 4, or 5',
      '6_plus': '6 or more years, e.g. "6+", "7+", "8+", or "10 years"',
    },
  },
  work_authorization: {
    type: 'choice',
    instructions:
      'Does `posting.description` impose a work-eligibility requirement the candidate cannot meet? ' +
      'The candidate is authorized to work in the US on <YOUR_WORK_AUTH_STATUS> and <IS_OR_IS_NOT> seeking sponsorship, so ' +
      '"no sponsorship", "must be authorized to work in the US", or H-1B language is NOT a ' +
      'requirement they fail. A clause that bars the candidate\'s CURRENT status is different: ' +
      'excluding F-1 students or OPT/STEM OPT/CPT/EAD holders, or refusing any immigration-related ' +
      'support for <YOUR_WORK_AUTH_STATUS>, IS a requirement they fail. ' +
      'U.S. Person status (8 U.S.C. 1324b) and clearance: <YOUR_US_PERSON_AND_CLEARANCE_STATUS>.',
    criteria: {
      us_person_or_export_control_required: 'Requires U.S. Person status, or cites ITAR, EAR, or export-controlled technical data',
      security_clearance_required: 'Requires an active or obtainable security clearance, TS/SCI, polygraph, or Public Trust',
      citizenship_required: 'Requires US citizenship or lawful permanent residence (green card)',
      f1_opt_or_ead_excluded: 'Explicitly excludes F-1 students or OPT, STEM OPT, CPT, or EAD holders, or refuses any immigration-related support for <YOUR_WORK_AUTH_STATUS> (e.g. "does not hire F-1s on CPT or EAD")',
      no_such_requirement: 'None of the above; declining to sponsor a visa, H-1B, or "authorized to work" language does not count',
    },
  },
  employer_type: {
    type: 'choice',
    instructions:
      'Who is the hiring entity in `posting.description` and `posting.company`?',
    criteria: {
      direct_employer: 'A company hiring for its own team, including a job board or aggregator (e.g. <TARGET_COMPANY>, Dice, Wellfound) reposting a named company\'s own opening',
      staffing_agency_or_consultancy: 'A staffing agency, recruiter, body shop, or IT consultancy placing the hire at an unnamed or third-party client; contract/W2-through-vendor language',
      government_or_public_sector: 'A US federal, state, county, or city agency, public university, public pension fund, or civil-service track',
      unclear: 'Cannot tell from the text',
    },
  },
  location_scope: {
    type: 'choice',
    instructions:
      'Where must the person in `posting.description` be located? Use `posting.location` as a hint ' +
      'but trust the description when they disagree. Remote roles restricted to the US count as ' +
      '"usa". Any US city, state, or hybrid/onsite arrangement counts as "usa".',
    criteria: {
      usa: 'Located anywhere in the United States, including US-only remote',
      outside_usa: 'Must be located outside the United States (Canada, EU, UK, India, LatAm, APAC, or a specific non-US city)',
      unclear: 'No location signal',
    },
  },
  phd_required: {
    type: 'noul',
    instructions:
      '`posting.description` makes a PhD a hard requirement (required / must have), not merely ' +
      'preferred, a plus, or one of several acceptable degrees. The candidate holds an M.S. in ' +
      'Computer Science.',
  },
  role_fit: {
    type: 'score',
    instructions:
      'How closely does the core work in `posting.description` match `candidate.profile` — an ' +
      'AI/ML engineer with 3+ years whose evidence is building and deploying ML/DL/LLM systems ' +
      '(PyTorch, RAG and retrieval, recommendation and ranking, multimodal models, MLOps deployment)?',
    criteria: [
      'A different discipline: sales, analyst, IT support, pure research, hardware, or a role where ML is incidental',
      'Adjacent: data engineering, backend software engineering with some ML, MLOps platform, or analytics with modelling',
      'Core ML/AI engineering, but centred on a specialty the candidate has no evidence for (e.g. robotics control, speech synthesis, chip design ML)',
      'Core ML/AI engineering squarely inside the candidate\'s evidence: recsys/ranking, RAG/LLM systems, multimodal deep learning, or ML deployment/MLOps',
    ],
  },
});

/**
 * Shape profile.yml (and optionally the CV's Technical Skills section) into the non-PII stub the
 * model sees. Skills and strengths are generic capability lists, never names, contacts or employers.
 */
export function profileStubFrom(profile = {}, { skills = [] } = {}) {
  const roles = profile?.target_roles?.primary;
  const strengths = profile?.narrative?.superpowers;
  return {
    target_roles: Array.isArray(roles) ? roles.slice(0, 12) : [],
    level_filter: 'Intern, entry, I/II, and mid-level (3–5 years) roles; Senior/Staff/Lead/III/IV/Manager titles only when the posting states 3–5 years; Director/Principal/VP/Head never',
    experience: '3+ years of professional ML/AI engineering',
    work_authorization: 'Authorized to work in the US on <YOUR_WORK_AUTH_STATUS> without sponsorship; not seeking sponsorship; NOT a U.S. Person for export-control purposes; no security clearance',
    education: '<YOUR_DEGREE>',
    profile: profile?.narrative?.headline || 'AI/ML engineer with 3+ years',
    strengths: Array.isArray(strengths) ? strengths.slice(0, 8) : [],
    skills: skills.slice(0, 12),
  };
}

/** A jds/<n>-*.md capture ("# Company — Role", **Location:**, ## Description) as a screen candidate. */
export function candidateFromJdText(text, name = '') {
  const h1 = (text.match(/^#\s+(.+)$/m) || [])[1] || name;
  // "Company — Role" is the jds/ convention; older captures used " - ".
  const [company, role] = h1.split(/\s+—\s+/).length > 1 ? h1.split(/\s+—\s+/) : h1.split(/\s+-\s+/);
  const loc = (text.match(/^\*\*Location:\*\*\s*(.+)$/m) || [])[1] || '';
  const descIdx = text.indexOf('## Description');
  const description = descIdx >= 0 ? text.slice(descIdx + '## Description'.length) : text;
  return { url: name, company: (company || '').trim(), role: (role || h1).trim(), location: loc.trim(), source: 'file', description: description.trim() };
}

/** Pull the "## Technical Skills" bullet lines out of cv-aiml.md (category: items). */
export function skillsFromCv(cvText = '') {
  const m = String(cvText).match(/^##\s*Technical Skills\s*$([\s\S]*?)(?=^##\s|^---\s*$)/m);
  if (!m) return [];
  return m[1].split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.includes(':'));
}

export function buildState(candidate, profileStub) {
  const description = String(candidate.description || '').slice(0, MAX_DESCRIPTION_CHARS);
  return {
    posting: {
      title: candidate.role || candidate.title || '',
      company: candidate.company || '',
      location: candidate.location || '',
      source: candidate.source || '',
      posted_date: candidate.postedDate || null,
      description,
    },
    candidate: profileStub,
  };
}

/** Rules code can settle without the model. Returns a screen record or null. */
export function deterministicScreen(candidate) {
  const title = candidate.role || candidate.title || '';
  if (ABSOLUTE_TIER_RE.test(title)) {
    return { decision: 'reject', reasons: ['title_tier:absolute'], rank: null, status: 'deterministic' };
  }
  const len = String(candidate.description || '').trim().length;
  if (len < MIN_DESCRIPTION_CHARS) {
    return { decision: 'unreadable', reasons: ['description_too_short'], rank: null, status: 'deterministic' };
  }
  return null;
}

/**
 * Turn raw TypeSafe answers into a decision. Pure.
 * `context.titleTier` is true when the title carries a Senior/Sr/Staff/Lead/III/IV/Manager token.
 */
export function decide(answers, config = DEFAULT_CONFIG, context = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const reasons = [];
  const sure = (a) => a && typeof a.confidence === 'number' && a.confidence >= cfg.minConfidence;

  const readable = answers.jd_is_readable?.noul;
  if (typeof readable === 'number' && readable < cfg.readableThreshold) {
    return { decision: 'unreadable', reasons: ['jd_not_readable'], rank: null };
  }

  // Title-inflation exception: a tiered title survives only if the JD states 3–5 years.
  const years = answers.min_years_required;
  if (context.titleTier && years && years.choice !== '3_5' && sure(years)) reasons.push(`title_tier:years_${years.choice}`);

  const lead = answers.leadership_scope?.noul;
  if (typeof lead === 'number' && lead >= cfg.leadershipThreshold) reasons.push('leadership_scope');

  const auth = answers.work_authorization;
  if (auth && auth.choice !== 'no_such_requirement' && sure(auth)) reasons.push(`work_authorization:${auth.choice}`);

  const emp = answers.employer_type;
  if (emp && (emp.choice === 'staffing_agency_or_consultancy' || emp.choice === 'government_or_public_sector') && sure(emp)) {
    reasons.push(`employer_type:${emp.choice}`);
  }

  const loc = answers.location_scope;
  if (loc?.choice === 'outside_usa' && sure(loc)) reasons.push('location:outside_usa');

  const phd = answers.phd_required?.noul;
  if (typeof phd === 'number' && phd >= cfg.phdThreshold) reasons.push('phd_required');

  const rank = typeof answers.role_fit?.score === 'number' ? answers.role_fit.score : null;
  return { decision: reasons.length ? 'reject' : 'pass', reasons, rank };
}

const RETRY_STATUSES = new Set([429, 529, 502, 503]);

/** One System One request. Retries 429/5xx twice with backoff. Throws on final failure. */
export async function askTypeSafe(state, questions, opts = {}) {
  const {
    apiKey = process.env.TYPESAFE_API_KEY,
    fetchImpl = globalThis.fetch,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_CONFIG.timeoutMs,
    retries = 2,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let retryable = false;
    try {
      const res = await fetchImpl(TYPESAFE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer\u0020${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model, questions }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = await res.json();
        return { answers: body.answers || {}, usage: body.usage || null, model: body.model || model };
      }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`TypeSafe HTTP ${res.status}: ${text.slice(0, 200)}`);
      retryable = RETRY_STATUSES.has(res.status);   // 401/400 etc. fail immediately
    } catch (err) {
      // network failure or timeout: worth one more try
      lastErr = err.name === 'AbortError' ? new Error(`TypeSafe timeout after ${timeoutMs}ms`) : err;
      retryable = true;
    } finally {
      clearTimeout(timer);
    }
    if (!retryable) throw lastErr;
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}

/**
 * Screen every candidate. Never throws for a single candidate's failure —
 * that candidate gets decision "pass" with a skipped status so the Opus
 * evaluator still sees it.
 */
export async function screenCandidates(candidates, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const stub = opts.profileStub || profileStubFrom(opts.profile);
  const log = opts.log || (() => {});
  const totals = { input_tokens: 0, output_tokens: 0, calls: 0 };

  const work = candidates.map((c) => ({ c, out: null }));
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const item = work[next++];
      const det = deterministicScreen(item.c);
      if (det) { item.out = det; continue; }
      const t0 = Date.now();
      try {
        const questions = { ...QUESTIONS, ...(opts.extraQuestions || {}) };
        const { answers, usage } = await askTypeSafe(buildState(item.c, stub), questions, {
          apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, model: cfg.model, timeoutMs: cfg.timeoutMs, sleep: opts.sleep,
        });
        totals.calls++;
        if (usage) { totals.input_tokens += usage.input_tokens || 0; totals.output_tokens += usage.output_tokens || 0; }
        const titleTier = TITLE_TIER_RE.test(item.c.role || item.c.title || '');
        item.out = { ...decide(answers, cfg, { titleTier }), status: 'screened', answers, latency_ms: Date.now() - t0 };
        if (opts.onAnswers) Object.assign(item.out, opts.onAnswers(answers, item.c) || {});
      } catch (err) {
        log(`screen skipped for ${item.c.company || '?'} / ${item.c.role || '?'}: ${err.message}`);
        item.out = { decision: 'pass', reasons: [], rank: null, status: `skipped:${err.message.slice(0, 80)}` };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));

  const screened = work.map(({ c, out }) => ({ ...c, screen: out }));
  return { candidates: screened, totals };
}

/** Passing candidates, best fit first; ties keep scan order. */
export function forwardList(screened, maxForward = DEFAULT_CONFIG.maxForward) {
  return screened
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.screen?.decision === 'pass')
    .sort((a, b) => (b.c.screen.rank ?? -1) - (a.c.screen.rank ?? -1) || a.i - b.i)
    .slice(0, maxForward)
    .map(({ c }) => c);
}

export function loadScreenConfig(profile = {}) {
  const raw = profile?.screen?.typesafe || {};
  return {
    ...DEFAULT_CONFIG,
    enabled: Boolean(raw.enabled),
    ...(typeof raw.min_confidence === 'number' ? { minConfidence: raw.min_confidence } : {}),
    ...(typeof raw.phd_threshold === 'number' ? { phdThreshold: raw.phd_threshold } : {}),
    ...(typeof raw.leadership_threshold === 'number' ? { leadershipThreshold: raw.leadership_threshold } : {}),
    fitReject: raw.fit_reject === true,   // skip postings below the fit model's threshold (off by default)
    ...(typeof raw.readable_threshold === 'number' ? { readableThreshold: raw.readable_threshold } : {}),
    ...(typeof raw.max_forward === 'number' ? { maxForward: raw.max_forward } : {}),
    ...(typeof raw.concurrency === 'number' ? { concurrency: raw.concurrency } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
  };
}
