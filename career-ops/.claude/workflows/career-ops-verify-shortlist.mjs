export const meta = {
  name: 'career-ops-verify-shortlist',
  description: 'Independently re-score a shortlist of already-evaluated jobs from scratch with two distinct lenses, plus an explicit work-authorization adjudication',
  whenToUse: 'When claimed >=4.0 evaluations need confirming before applying, or when a prior gate discarded candidates on a flag that may have been misread.',
  phases: [{ title: 'Verify', detail: 'Per job: 2 from-scratch re-scorers (requirements lens, realism lens) + 1 work-auth adjudicator' }],
}

const ROOT = '<CAREER_OPS_DIR>'
const FLOOR = 4.0

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !Array.isArray(_args.jobs) || !_args.jobs.length) throw new Error('args.jobs REQUIRED')
const JOBS = _args.jobs
const TODAY = _args.today || 'today'

const BASE = `Project root: ${ROOT}. Today: ${TODAY}.

MANDATORY READS: AGENTS.md, modes/_profile.md, modes/_shared.md, modes/oferta.md, config/profile.yml, cv-aiml.md, article-digest.md.

RULES THAT DECIDE THE SCORE:
- TIER: entry/mid only. A title or JD body that is really Senior/Staff/Lead/Principal/Manager work is out, EVEN IF the posted title says "I" or "II". Read the years and the scope, not the title. Conversely, do not reject a legitimately mid-level role because the URL slug or req system carries a different title than the posting — say which one the JD body supports.
- USA only. Location is a RANKING signal, never a filter: Remote-US & SF Bay 5.0 > Austin 4.7 > other TX 4.5 = <YOUR_CITY> 4.5 > any other state 4.0. Never push a role below 4.0 on location alone.
- SPONSORSHIP FILTER IS OFF (standing user override). A JD saying it will not sponsor H-1B is NOT a bar and NOT a penalty. Only a clause barring the candidate's CURRENT status counts: US-citizen-only, active clearance, ITAR/EAR export control, "US Person", a JD naming F-1/OPT as unaccommodated, or a DOL PERM notice-of-filing block.
- Aggregator/agency postings where the true employer is never named cap below 3.0.
- CALIBRATION: honest ceiling ~4.4; >=4.5 is roughly 1 in 20. Never inflate. Score DOWN for required years well beyond ~3, a non-Python/SQL primary language as a hard requirement, heavy front-end (React/TypeScript) as a core requirement, body-shop staffing posts, comp below $110K, stub JDs, PM-first or internal-IT-first scope, contract/hourly. Score UP for production RAG / vector search / semantic retrieval, recommendation and ranking, transformer NLP, LLM serving and evaluation, MLOps on AWS/K8s, multimodal or edge ML — the candidate's actual shipped work (~3.3 yrs: <CURRENT_EMPLOYER> + <PAST_EMPLOYER>, MS CS Dec 2025).
- If you cannot retrieve the real JD body, return score 0.0 and say so. Never score from a title.`

phase('Verify')
log(`Re-verifying ${JOBS.length} jobs from scratch`)

const results = await parallel(JOBS.map(j => () => (async () => {
  const LENSES = [
    { key: 'requirements', angle: 'Walk the JD\'s REQUIRED-qualifications list line by line against cv-aiml.md and count genuine hits vs genuine misses. Years, required languages, required frameworks, degree, domain. Ignore how exciting the company is; a great company with a mismatched requirement list is still a mismatch.' },
    { key: 'realism', angle: 'Judge whether this application realistically converts to a screen: comp band vs the <TARGET_COMP_RANGE> target, seniority creep hidden in the body (a "II" that wants 5+ years is really senior), whether this is a staffing/consultancy body-shop req or an unnamed-employer agency listing, whether the posting is a stub or a repost, and whether location/work-mode is workable.' },
  ]

  const votes = await parallel(LENSES.map(L => () =>
    agent(
      `Score ONE job for career-ops FROM SCRATCH. You have NOT been shown any prior score and must not ask for one.

${BASE}

JOB: ${j.company} — ${j.role}
URL: ${j.url}
Fetch and read the real JD before scoring.

YOUR LENS: ${L.angle}

RETURN — plain text, last lines exactly:
VERIFY_JSON_BEGIN
{"score":<0.0-5.0>,"reason":"<2-3 sentences quoting the JD>","tierConcern":"<string or null: any evidence this is really a senior/staff role>"}
VERIFY_JSON_END`,
      { label: `v:${L.key}:${String(j.company).slice(0, 16)}`, phase: 'Verify', effort: 'high' }
    ).then(t => { const m = typeof t === 'string' && t.match(/VERIFY_JSON_BEGIN\s*([\s\S]*?)\s*VERIFY_JSON_END/); if (!m) return null; try { return JSON.parse(m[1].trim()) } catch { return null } }).catch(() => null)
  ))

  const auth = await agent(
    `Adjudicate WORK AUTHORIZATION for ONE job posting. This is the only question you answer — do not score the role.

${BASE}

JOB: ${j.company} — ${j.role}
URL: ${j.url}

Fetch the real JD. Quote every sentence that touches citizenship, residency, clearance, export control, or work authorization. Then decide:

  barred = true  ONLY if a clause excludes someone on <YOUR_WORK_AUTH_STATUS>: US-citizen-only, active security clearance required, ITAR/EAR export control, "US Person" requirement, a JD naming F-1/OPT as an unaccommodated permit, or a DOL PERM notice-of-filing block.
  barred = false if the JD is silent, OR if it only says the employer will not sponsor H-1B / visas — that is explicitly NOT a bar for this candidate (standing user override) and must not be reported as one.

Be precise. A prior run reported bars on roles that had no such clause at all, which threw away the best jobs of the day.

RETURN — plain text, last lines exactly:
AUTH_JSON_BEGIN
{"barred":<true|false>,"quotes":["<verbatim sentence>", "..."],"verdict":"<1 sentence>"}
AUTH_JSON_END`,
    { label: `auth:${String(j.company).slice(0, 20)}`, phase: 'Verify', effort: 'high' }
  ).then(t => { const m = typeof t === 'string' && t.match(/AUTH_JSON_BEGIN\s*([\s\S]*?)\s*AUTH_JSON_END/); if (!m) return null; try { return JSON.parse(m[1].trim()) } catch { return null } }).catch(() => null)

  const good = votes.filter(Boolean)
  const mean = good.length ? good.reduce((a, v) => a + (v.score || 0), 0) / good.length : 0
  const finalScore = good.length ? Math.round(((j.priorScore + mean * good.length) / (1 + good.length)) * 100) / 100 : null
  const tierConcerns = good.map(v => v.tierConcern).filter(Boolean)

  const barred = auth?.barred === true
  const pass = !barred && good.length >= 1 && mean >= FLOOR

  log(`${j.company}: prior ${j.priorScore} | lenses ${good.map(v => v.score).join('/')} | mean ${mean.toFixed(2)} | barred ${barred} => ${pass ? 'CONFIRMED' : 'REJECTED'}`)

  return {
    ...j, votes: good.map(v => v.score), lensReasons: good.map(v => v.reason),
    mean: Math.round(mean * 100) / 100, finalScore, barred,
    authQuotes: auth?.quotes || [], authVerdict: auth?.verdict || 'adjudicator failed',
    tierConcerns, confirmed: pass,
    verdict: barred ? `BARRED: ${auth?.verdict}` : (mean >= FLOOR ? 'confirmed' : `verifier mean ${mean.toFixed(2)} < ${FLOOR}`),
  }
})()))

const clean = results.filter(Boolean)
const confirmed = clean.filter(r => r.confirmed).sort((a, b) => b.finalScore - a.finalScore)
log(`CONFIRMED ${confirmed.length}/${JOBS.length}`)
return { today: TODAY, confirmed, rejected: clean.filter(r => !r.confirmed) }
