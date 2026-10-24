// tests/typesafe-screen.test.mjs — policy for the TypeSafe first-pass screen.
//
// No network. Every case feeds canned TypeSafe answers (or a fake fetch) into
// the pure functions in lib/typesafe-screen.mjs. The point of the suite is the
// fail-open contract: the screen may only remove Opus work on a confident hard
// rule, and it must never drop a posting for sponsorship language.
import { pass, fail } from './helpers.mjs';
import {
  DEFAULT_CONFIG, QUESTIONS, MAX_DESCRIPTION_CHARS,
  buildState, decide, deterministicScreen, forwardList, loadScreenConfig,
  profileStubFrom, screenCandidates, skillsFromCv,
} from '../lib/typesafe-screen.mjs';

console.log('\nTypeSafe first-pass screen (lib/typesafe-screen.mjs)');

const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

// A fully benign answer set — the shape the API returns for a good posting.
const benign = () => ({
  jd_is_readable: { type: 'noul', noul: 0.98 },
  leadership_scope: { type: 'noul', noul: 0.05 },
  min_years_required: { type: 'choice', choice: '0_2', confidence: 0.9, probabilities: {} },
  work_authorization: { type: 'choice', choice: 'no_such_requirement', confidence: 0.95, probabilities: {} },
  employer_type: { type: 'choice', choice: 'direct_employer', confidence: 0.9, probabilities: {} },
  location_scope: { type: 'choice', choice: 'usa', confidence: 0.9, probabilities: {} },
  phd_required: { type: 'noul', noul: 0.05 },
  role_fit: { type: 'score', score: 2.7, confidence: 0.8, legend: {} },
});

// --- decide(): the policy -------------------------------------------------
{
  const d = decide(benign());
  check(d.decision === 'pass' && d.reasons.length === 0 && d.rank === 2.7, 'benign answers pass with role_fit as rank');
}
{
  const a = benign(); a.leadership_scope = { noul: 0.9 };
  check(decide(a).decision === 'reject' && decide(a).reasons.includes('leadership_scope'), 'people-management / staff scope rejects at noul >= 0.85');
  a.leadership_scope = { noul: 0.7 };
  check(decide(a).decision === 'pass', 'leadership_scope 0.7 does not reject');
}
// Years alone never gate: 3–5 is the target and 5+ is a stretch Opus still scores ≥4.0 (golden #608/#610/#611).
for (const y of ['6_plus', '3_5', 'not_stated', '0_2']) {
  const a = benign(); a.min_years_required = { choice: y, confidence: 0.99 };
  check(decide(a).decision === 'pass', `untiered title with years ${y} passes`);
}
// modes/_profile.md 2026-07-26: a Senior/Staff/Lead/III/IV/Manager title is evaluated when the JD states 3–5 years.
{
  const a = benign(); a.min_years_required = { choice: '3_5', confidence: 0.95 };
  check(decide(a, {}, { titleTier: true }).decision === 'pass', 'tiered title + stated 3–5 years passes (title-inflation exception)');
  for (const y of ['6_plus', 'not_stated', '0_2']) {
    a.min_years_required = { choice: y, confidence: 0.9 };
    const d = decide(a, {}, { titleTier: true });
    check(d.decision === 'reject' && d.reasons.includes(`title_tier:years_${y}`), `tiered title + confident years ${y} rejects`);
  }
  a.min_years_required = { choice: '6_plus', confidence: 0.4 };
  check(decide(a, {}, { titleTier: true }).decision === 'pass', 'tiered title with an unsure years answer passes (fail-open)');
}
{
  check(!('senior_or_above' in (QUESTIONS.min_years_required.criteria || {})) && !('seniority' in QUESTIONS),
    'no question conflates years with seniority any more');
}
{
  check(!('explicitly_no_sponsorship' in QUESTIONS.work_authorization.criteria),
    'sponsorship is not even an option the model can pick — standing override 2026-07-08');
  const a = benign(); a.work_authorization = { choice: 'no_such_requirement', confidence: 0.5 };
  check(decide(a).decision === 'pass', 'no_such_requirement never rejects, whatever its confidence');
}
// _custom.md rule 22: a clause barring the candidate's current <YOUR_WORK_AUTH_STATUS> status is a hard disqualifier
// (<TARGET_COMPANY> #1305 "no immigration support for <YOUR_WORK_AUTH_STATUS>"; <TARGET_COMPANY> #641 "does not hire F-1's on CPT or EAD").
check(/STEM OPT/.test(QUESTIONS.work_authorization.criteria.f1_opt_or_ead_excluded) && /declining to sponsor/.test(QUESTIONS.work_authorization.criteria.no_such_requirement),
  'OPT/EAD exclusion is its own option; plain no-sponsorship stays under no_such_requirement');
for (const blocker of ['us_person_or_export_control_required', 'security_clearance_required', 'citizenship_required', 'f1_opt_or_ead_excluded']) {
  const a = benign(); a.work_authorization = { choice: blocker, confidence: 0.85 };
  const d = decide(a);
  check(d.decision === 'reject' && d.reasons.includes(`work_authorization:${blocker}`), `${blocker} rejects when confident`);
}
for (const emp of ['staffing_agency_or_consultancy', 'government_or_public_sector']) {
  const a = benign(); a.employer_type = { choice: emp, confidence: 0.75 };
  check(decide(a).decision === 'reject', `${emp} rejects when confident`);
}
{
  const a = benign(); a.employer_type = { choice: 'unclear', confidence: 1.0 };
  check(decide(a).decision === 'pass', 'employer_type unclear passes even at confidence 1.0');
}
{
  const a = benign(); a.location_scope = { choice: 'outside_usa', confidence: 0.7 };
  check(decide(a).decision === 'reject' && decide(a).reasons.includes('location:outside_usa'), 'outside_usa rejects');
}
{
  const a = benign(); a.phd_required = { noul: 0.9 };
  check(decide(a).decision === 'reject' && decide(a).reasons.includes('phd_required'), 'PhD noul >= 0.8 rejects');
  a.phd_required = { noul: 0.5 };
  check(decide(a).decision === 'pass', 'PhD noul 0.5 does not reject');
}
{
  const a = benign(); a.jd_is_readable = { noul: 0.1 };
  const d = decide(a);
  check(d.decision === 'unreadable' && d.reasons.includes('jd_not_readable'), 'unreadable JD is flagged, not rejected');
}
{
  const a = benign(); a.location_scope = { choice: 'outside_usa', confidence: 0.65 };
  check(decide(a, { minConfidence: 0.7 }).decision === 'pass', 'minConfidence override is honoured');
  check(decide(a, { minConfidence: 0.6 }).decision === 'reject', 'default 0.6 still rejects at 0.65');
}
{
  const d = decide({});
  check(d.decision === 'pass' && d.rank === null, 'missing answers pass through with null rank');
}

// --- deterministic rules ----------------------------------------------------
{
  const long = 'x'.repeat(300);
  for (const t of ['Director of Machine Learning', 'Principal ML Engineer', 'VP, AI', 'Head of AI']) {
    check(deterministicScreen({ role: t, description: long })?.reasons[0] === 'title_tier:absolute', `"${t}" rejects without an API call`);
  }
  check(deterministicScreen({ role: 'Senior Machine Learning Engineer', description: long }) === null, 'Senior title goes to the model (3–5 years exception)');
  check(deterministicScreen({ role: 'Staff ML Engineer', description: long }) === null, 'Staff title goes to the model');
  check(deterministicScreen({ role: 'Machine Learning Engineer II', description: long }) === null, 'II is not a tier token');
  check(deterministicScreen({ role: 'ML Engineer', description: 'short' })?.decision === 'unreadable', 'tiny description is unreadable without an API call');
  check(deterministicScreen({ role: 'ML Engineer', description: long }) === null, 'clean posting needs the model');
}

// --- state: what leaves the machine ------------------------------------------
{
  const profile = {
    candidate: { full_name: 'X', email: 'x@y', phone: '1', home_address: 'somewhere' },
    target_roles: { primary: ['ML Engineer'] },
    narrative: { headline: 'AI/ML Engineer' },
  };
  const stub = profileStubFrom(profile);
  const s = buildState({ role: 'ML Engineer', company: 'Acme', description: 'd'.repeat(20_000) }, stub);
  const json = JSON.stringify(s);
  check(!/full_name|email|phone|home_address|x@y|somewhere/.test(json), 'state carries no candidate PII');
  check(s.posting.description.length === MAX_DESCRIPTION_CHARS, `description capped at ${MAX_DESCRIPTION_CHARS} chars`);
  check(s.candidate.target_roles[0] === 'ML Engineer' && /OPT/.test(s.candidate.work_authorization), 'stub carries roles and the OPT framing');
  check(/3\+ years/.test(s.candidate.experience) && !/early.career/i.test(JSON.stringify(s.candidate)), 'stub says 3+ years, not early career');
}
{
  const cv = '# Name\<CONTACT_EMAIL>\n\n## Technical Skills\n\n- **ML:** PyTorch, RAG\n- **Cloud:** AWS\n\n---\n\n## Experience\n- **Acme:** did things\n';
  const skills = skillsFromCv(cv);
  check(skills.length === 2 && skills[0] === 'ML: PyTorch, RAG' && skills[1] === 'Cloud: AWS', 'skillsFromCv reads only the Technical Skills bullets');
  const stub = profileStubFrom({ narrative: { superpowers: ['RAG pipelines'] } }, { skills });
  check(stub.skills.length === 2 && stub.strengths[0] === 'RAG pipelines' && !/email@x\.com|Acme/.test(JSON.stringify(stub)), 'stub carries skills + strengths but no contact or employer');
  check(skillsFromCv('no skills heading here').length === 0, 'missing Technical Skills section yields []');
}

// --- screenCandidates(): transport failures fail open ----------------------------
const long = 'Responsibilities: build ML systems. Qualifications: 1-3 years, Python, PyTorch. '.repeat(6);
const cands = [
  { url: 'u1', company: 'A', role: 'ML Engineer', description: long },
  { url: 'u2', company: 'B', role: 'Director, Machine Learning', description: long },
  { url: 'u3', company: 'C', role: 'ML Engineer II', description: long },
];
const okBody = (answers) => ({ ok: true, status: 200, json: async () => ({ answers, usage: { input_tokens: 500, output_tokens: 40 } }), text: async () => '' });

{
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
  const { candidates: out } = await screenCandidates(cands, { apiKey: 'k', fetchImpl, sleep: async () => {}, config: { concurrency: 2 } });
  check(out[0].screen.decision === 'pass' && out[0].screen.status.startsWith('skipped:'), 'HTTP 500 after retries -> pass with skipped status');
  check(out[1].screen.decision === 'reject' && out[1].screen.status === 'deterministic', 'deterministic reject still applies when the API is down');
}
{
  let calls = 0;
  const fetchImpl = async () => (++calls === 1
    ? { ok: false, status: 429, text: async () => 'slow down', json: async () => ({}) }
    : okBody(benign()));
  const { candidates: out, totals } = await screenCandidates([cands[0]], { apiKey: 'k', fetchImpl, sleep: async () => {} });
  check(out[0].screen.decision === 'pass' && out[0].screen.status === 'screened' && calls === 2, '429 is retried once and then succeeds');
  check(totals.calls === 1 && totals.input_tokens === 500, 'usage totals count only successful calls');
}
{
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const { candidates: out } = await screenCandidates([cands[0]], { apiKey: 'k', fetchImpl, sleep: async () => {} });
  check(out[0].screen.decision === 'pass' && /ECONNREFUSED/.test(out[0].screen.status), 'connection error -> pass with the error in status');
}
{
  const { candidates: out } = await screenCandidates([cands[0]], { apiKey: '', fetchImpl: async () => okBody(benign()) });
  check(out[0].screen.decision === 'pass' && /TYPESAFE_API_KEY/.test(out[0].screen.status), 'missing key -> pass, status names the key');
}
{
  const seen = [];
  const fetchImpl = async (_url, init) => { seen.push(JSON.parse(init.body)); return okBody(benign()); };
  await screenCandidates([cands[0]], { apiKey: 'k', fetchImpl });
  const req = seen[0];
  check(req.model === DEFAULT_CONFIG.model && Object.keys(req.questions).length === 8 && req.state.posting.title === 'ML Engineer',
    'request carries model, all 8 questions, and the posting state');
}
{
  // Senior title reaches the model; the years answer decides it.
  const tiered = { url: 's', company: 'S', role: 'Senior ML Engineer', description: long };
  const withYears = (choice) => async () => okBody({ ...benign(), min_years_required: { choice, confidence: 0.9 } });
  const pass35 = (await screenCandidates([tiered], { apiKey: 'k', fetchImpl: withYears('3_5') })).candidates[0].screen;
  const rej6 = (await screenCandidates([tiered], { apiKey: 'k', fetchImpl: withYears('6_plus') })).candidates[0].screen;
  check(pass35.decision === 'pass' && pass35.status === 'screened', 'Senior title + stated 3–5 years is forwarded to Opus');
  check(rej6.decision === 'reject' && rej6.reasons.includes('title_tier:years_6_plus'), 'Senior title + 6+ years is rejected after the model call');
}
{
  const seen = [];
  const fetchImpl = async (_url, init) => { seen.push(JSON.parse(init.body)); return okBody({ ...benign(), extra_q: { noul: 0.7 } }); };
  const { candidates: [c] } = await screenCandidates([cands[0]], {
    apiKey: 'k', fetchImpl, extraQuestions: { extra_q: { type: 'noul', instructions: 'x' } },
    onAnswers: (ans) => ({ extra: ans.extra_q.noul }),
  });
  check(Object.keys(seen[0].questions).length === 9 && c.screen.extra === 0.7, 'extraQuestions ride the same request and onAnswers can annotate the record');
}

// --- forwardList(): ordering + cap -------------------------------------------------
{
  const screened = [
    { url: 'a', screen: { decision: 'pass', rank: 1.0 } },
    { url: 'b', screen: { decision: 'reject', rank: 3.0 } },
    { url: 'c', screen: { decision: 'pass', rank: 2.9 } },
    { url: 'd', screen: { decision: 'pass', rank: null } },
    { url: 'e', screen: { decision: 'unreadable', rank: null } },
  ];
  const fwd = forwardList(screened, 2).map((c) => c.url);
  check(fwd.join(',') === 'c,a', 'forwardList keeps passes only, best fit first, capped');
  check(forwardList(screened).map((c) => c.url).join(',') === 'c,a,d', 'null rank sorts last but is still forwarded');
}

// --- loadScreenConfig(): profile.yml wiring ----------------------------------------
{
  check(loadScreenConfig({}).enabled === false, 'screen is off when profile.yml has no screen block');
  const c = loadScreenConfig({ screen: { typesafe: { enabled: true, min_confidence: 0.75, max_forward: 10, leadership_threshold: 0.9 } } });
  check(c.enabled && c.minConfidence === 0.75 && c.maxForward === 10 && c.phdThreshold === DEFAULT_CONFIG.phdThreshold && c.leadershipThreshold === 0.9,
    'profile.yml overrides merge over defaults');
}
