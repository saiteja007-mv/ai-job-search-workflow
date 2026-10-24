export const meta = {
  name: 'career-ops-deep-scan',
  description: 'Loop fresh scans until N high-fit (>=4.0) jobs found across all work modes (remote/hybrid/onsite), then tailor resume + source real LinkedIn outreach for each, then verify dashboard',
  whenToUse: 'Deep apply-ready batch: USA-wide fresh scan across ALL work modes (user relocates anywhere), >=4.0 floor, JD-tailored resumes + real LinkedIn contacts + dashboard verification.',
  phases: [
    { title: 'Setup', detail: 'Resolve next appNumber from data/applications.md' },
    { title: 'Scan', detail: 'Loop portal scans + Simplify/Workday sweepers + Indeed/ZipRecruiter/Dice MCPs (interactive) until candidate pool fills' },
    { title: 'Evaluate', detail: 'Score each candidate per modes/oferta.md Blocks A-G (all work modes scored equal)' },
    { title: 'Resume', detail: 'JD-tailored Professional Summary + PDF (CLAUDE.md Rule 6, lead with JD ML domain — no default-stamp)' },
    { title: 'Outreach', detail: 'Real, currently-employed LinkedIn HM/Recruiter/Peer per AGENTS.md Outreach Sourcing rules' },
    { title: 'Merge', detail: 'Run merge-tracker.mjs and verify-pipeline.mjs' },
    { title: 'Dashboard', detail: 'Verify webapp /api/* endpoints reflect new data (CLAUDE.md Rule 1 — no rebuild, DATA bind-mount)' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const TARGET = 10
const MAX_ROUNDS = 1
const FRESH_DAYS = 7
const SCORE_FLOOR = 4.0
// args.today is REQUIRED — pass YYYY-MM-DD when invoking. No fallback (yesterday's run defaulted
// to a stale date and stamped 34 rows wrong). Date.now()/new Date() are blocked in workflow scripts.
// Tolerate args arriving as a JSON STRING (some harnesses serialize the object) — parse, never default.
let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = null }
}
if (!_args || !_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) {
  throw new Error('args.today is REQUIRED (YYYY-MM-DD). Invoke: Workflow({scriptPath:"...", args:{today:"2026-MM-DD"}})')
}
const TODAY = _args.today

// ---------- schemas ----------
const SETUP_SCHEMA = {
  type: 'object',
  properties: { maxAppNumber: { type: 'number' } },
  required: ['maxAppNumber'],
  additionalProperties: false,
}

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          company: { type: 'string' },
          role: { type: 'string' },
          postedDate: { type: ['string', 'null'] },
          source: { type: 'string' },
        },
        required: ['url', 'company', 'role'],
        additionalProperties: true,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    appNumber: { type: 'number' },
    slug: { type: 'string' },
    score: { type: 'number' },
    company: { type: 'string' },
    role: { type: 'string' },
    url: { type: 'string' },
    archetype: { type: 'string' },
    reportPath: { type: 'string' },
    jdEmphasizeKeywords: { type: 'string' },
    summaryAnchor: { type: 'string' },
    skipReason: { type: ['string', 'null'] },
  },
  required: ['appNumber', 'slug', 'score', 'company', 'role', 'url', 'archetype', 'reportPath', 'jdEmphasizeKeywords', 'summaryAnchor'],
  additionalProperties: true,
}

const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    appNumber: { type: 'number' },
    pdfPath: { type: 'string' },
    summaryUsed: { type: 'string' },
    pages: { type: ['number', 'null'] },
  },
  required: ['appNumber', 'pdfPath', 'summaryUsed'],
  additionalProperties: true,
}

// OUTREACH_SCHEMA removed 2026-06-04 — Outreach phase migrated to plain-text + sentinel
// (same anti-pattern Scan/Evaluate/Resume already hit: {schema} + long WebSearch+Read+Write
// tool chain -> "subagent completed without calling StructuredOutput after 2 nudges").

// ---------- Concurrency helper (audit 2026-06-10) ----------
// pipeline()/parallel() default to min(16, cpu-2) concurrent agents. Round-1 firing 12-25 evals
// simultaneously tripped Anthropic per-account 429 rate limits on EVERY failed run this week
// (2026-06-08 deep-scan 19 evals all 429, 2026-06-08 mcp-scan 12 evals all 429, 2026-06-10
// mcp-scan 12 evals all 429). Anthropic's limit is per-minute; 3 concurrent agents at ~30-60s
// each stay well under it, and the chunk barrier provides natural backpressure. Doubles the
// wall-clock but actually completes — and a completed 12-min run beats five 4-min crashes.
const EVAL_CONCURRENCY = 3
const RESUME_CONCURRENCY = 3
async function chunked(items, fn, chunkSize = 3) {
  const out = []
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize)
    const batch = await parallel(slice.map(item => () => fn(item)))
    out.push(...batch)
  }
  return out
}

// ---------- Phase 1: Setup ----------
phase('Setup')
const setup = await agent(
  `Compute the next free application number. Project root ${ROOT}. Return the MAX numeric app-id found across ALL THREE sources below, so the workflow never reuses a number that already has a report or posted-date entry even when it lacks a tracker row (sub-4.0 dupes get a report + posted-date but no applications.md row, leaving a gap):
  1. data/applications.md — MAX value in the "#" column (first column of the markdown table; rows like "| 647 | 2026-06-04 | ..."). Ignore the literal "#" header.
  2. reports/ directory — MAX leading integer across filenames. Run: ls reports/ | grep -oE '^[0-9]+' | sort -n | tail -1
  3. data/posted-dates.json — MAX numeric key in the .dates object.
  Return {maxAppNumber: N} where N is the single largest number across all three. If a source is empty/unreadable, treat its max as 0.`,
  { schema: SETUP_SCHEMA, label: 'setup-max-num' }
)
let nextAppNum = (setup?.maxAppNumber || 392) + 1
log(`Start appNumber = ${nextAppNum}`)

// ---------- Phase 2 + 3: Scan + Evaluate loop ----------
const seenUrls = new Set()
const highFits = []
const allEvals = []
let round = 0

const SCAN_ANGLES = [
  'primary: machine learning engineer, ML engineer, AI engineer (USA, remote/hybrid/onsite)',
  'applied AI / GenAI engineer, LLM engineer, RAG engineer (USA)',
  'NLP engineer, computer vision engineer, deep learning engineer (USA)',
  'MLOps engineer, ML platform engineer, ML infrastructure engineer (USA)',
  'applied scientist, data scientist, ML research engineer (USA)',
]

while (highFits.length < TARGET && round < MAX_ROUNDS) {
  round++
  phase('Scan')
  log(`Round ${round}/${MAX_ROUNDS} — have ${highFits.length}/${TARGET} >=${SCORE_FLOOR} so far`)

  const angle = SCAN_ANGLES[(round - 1) % SCAN_ANGLES.length]
  // Switched from {schema: SCAN_SCHEMA} -> plain-text + sentinel SCAN_JSON_BEGIN/END parse.
  // Same anti-pattern Evaluate/Resume already migrated for: schema-mode subagents fail
  // ("subagent completed without calling StructuredOutput after 2 nudges") after long
  // tool chains (node scan.mjs + 2 sweepers + portal Reads + WebSearch). Plain-text return
  // bulletproof. 2026-06-02 wf_6d9cab17 died here on Scan-r2.
  let scanRes = { candidates: [] }
  try {
    const text = await agent(
      `You are running a fresh career-ops scan. Project root: ${ROOT}.

MANDATORY READS first (in order): AGENTS.md, CLAUDE.md, modes/_profile.md, modes/_shared.md, modes/scan.md, config/profile.yml, portals.yml.

Then run the zero-token portal scanner with USA-wide search scope and ${FRESH_DAYS}-day freshness:
  node scan.mjs   (consult modes/scan.md for current flags)

ALSO run TWO supplementary sweepers — fresh-supply channels the regular scan misses. Both apply positive-title + freshness + tracker-dedup filters internally; their output is ready to merge verbatim:

  1) SimplifyJobs GitHub (public HTML-table scrape of SimplifyJobs/New-Grad-Positions + Summer2026-Internships):
       node batch/sweep-simplify-gh.mjs ${FRESH_DAYS}
       Then Read batch/_simplify_gh.json and MERGE every item from its \`candidates[]\` array.

  2) Workday AI/ML-hiring board (direct hits on the user's PRIMARY archetype — Machine Learning Engineer):
       node batch/sweep-workday-payers.mjs ${FRESH_DAYS}
       Then Read batch/_workday_payers.json and MERGE every item from its \`candidates[]\` array.

  3) JobSpy direct scraper — LinkedIn + Indeed + ZipRecruiter + Glassdoor (linkedin_fetch_description=True):
       python batch/sweep_jobspy.py ${FRESH_DAYS}
       Then Read batch/_jobspy.json and MERGE every item from its \`candidates[]\` array EXCEPT drop the \`description\` and \`description_source\` fields from your SCAN_JSON output (they bloat the prompt; Eval reads them directly from _jobspy.json). Source values are "jobspy:linkedin" / "jobspy:indeed" / "jobspy:zip_recruiter" / "jobspy:glassdoor".

Each item already has {url, company, role, postedDate, location, source} — copy verbatim. Skip any whose url is already in the "already seen this run" set printed below. Do NOT re-filter sweeper candidates; they're already filtered.

ALSO query THREE AGGREGATOR JOB-SEARCH MCPs — Indeed + ZipRecruiter + Dice. These are claude.ai account connectors: available in INTERACTIVE runs, ABSENT in headless/cron. Their schemas are DEFERRED — you MUST load each via ToolSearch before calling. If a tool will not load or it errors (headless run), log ONE line and CONTINUE — never fail the scan over a missing aggregator. They surface fresher inventory than scraping (prior interactive runs found #636 CareSource 4.7 and #637 Vheda 4.5 this way).

  3a) INDEED — tool name: mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs
      Load: ToolSearch "select:mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs" (fallback keyword if the hash changed: "Indeed search_jobs").
      Call across the angle keywords (2-3 calls). Params: { search: "<angle keyword phrase, e.g. machine learning engineer>", location: "remote", country_code: "US" }; also repeat with location: "United States" to catch onsite/hybrid. Indeed exposes NO posted-date filter — set postedDate: null on its hits and let Evaluate live-verify (per profile Rule 8 / Lesson 13: aggregators report ingestion time, not original post time; cross-check the real date at eval).

  3b) ZIPRECRUITER — tool name: mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs (US + Canada only)
      Load: ToolSearch "select:mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs" (fallback keyword: "ZipRecruiter search_jobs").
      Call across the angle keywords (2-3 calls). Params: { query: "<angle keyword phrase>", max_posted_minutes_ago: ${FRESH_DAYS * 1440}, seniority_classes: ["NO_EXPERIENCE","JUNIOR","MID"], salary_min: 70000 }; add location_types: ["REMOTE"] for the remote pass, omit location for a nationwide pass. NEVER pass seniority_classes ["SENIOR"]. max_posted_minutes_ago already enforces the ${FRESH_DAYS}-day window.

  3c) DICE — tool name: mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs (US tech board; best channel for the <YOUR_WORK_AUTH_STATUS> sponsorship filter)
      Load: ToolSearch "select:mcp__<LINKEDIN_CONNECTOR_ID>__search_jobs" (fallback keyword: "Dice search_jobs willing_to_sponsor").
      Call across the angle keywords (2-3 calls). Params: { keyword: "<angle keyword phrase>", workplace_types: ["Remote"] for the remote pass (omit for a nationwide pass), willing_to_sponsor: true, posted_date: "SEVEN" }. willing_to_sponsor: true is the key value of Dice — it pre-filters to H1B-friendly employers, matching the candidate's <YOUR_WORK_AUTH_STATUS> need. posted_date buckets are ONE|THREE|SEVEN only; "SEVEN" is the closest to the ${FRESH_DAYS}-day window (still cross-check the real date at eval). Do NOT pass employment_types (keeps interns + FT in scope).

  For ALL THREE aggregators: extract {url = the apply/details link with ALL query params intact, company, role, postedDate (ISO or null), location}; apply the SAME tier + USA-only + dedup HARD RULES below; tag source "indeed", "ziprecruiter", or "dice".

Scan angle for this round (scan.mjs + aggregator keyword phrase): ${angle}.
Today: ${TODAY}.

HARD RULES:
- Tier filter from config/profile.yml level_filter = entry_mid_intern. HARD-REJECT any title containing: Senior, Sr, Staff, Lead, Principal, III, IV, Manager, Director, Head, VP.
- USA-only. Reject EU, UK, Canada, India, LatAm, APAC.
- ALL WORK MODES IN SCOPE: Remote, Hybrid, AND On-site. User relocates ANYWHERE in USA. Do NOT filter by work mode or city. <YOUR_CITY>-anchored hybrid/relocation penalties are RETIRED for this workflow.
- FRESHNESS: A KNOWN published/updated date within ${FRESH_DAYS} days is in-scope. UNDATED postings (Ashby boards return publishedAt/updatedAt = null; some Lever/GH too) are NOT auto-rejected for a missing date — INCLUDE them (postedDate: null) and let the Evaluate phase live-verify. Reject ONLY when the posting carries a KNOWN date older than ${FRESH_DAYS} days, or shows a positive expired/closed signal.
- Dedup against data/applications.md (company+role exact) AND data/scan-history.tsv.
- Already seen this run (skip): ${JSON.stringify([...seenUrls]).slice(0, 1500)}

Return up to 25 fresh in-scope candidates. If scan.mjs returns fewer, supplement with manual portal queries (Greenhouse/Ashby/Lever boards from portals.yml) using the angle keywords. Refuse to fabricate URLs — only return real, fetched postings.

RETURN FORMAT — CRITICAL — plain text only. Do NOT call StructuredOutput / any schema tool. The LAST lines of your response MUST be exactly this block (one valid JSON object on a single line between the markers):

SCAN_JSON_BEGIN
{"candidates": [{"url": "<full url>", "company": "<name>", "role": "<title>", "postedDate": "<YYYY-MM-DD or null>", "source": "<scan|simplify-gh|workday-payers|jobspy:linkedin|jobspy:indeed|jobspy:zip_recruiter|jobspy:glassdoor|indeed|ziprecruiter|dice|portal-name>"}, ...]}
SCAN_JSON_END

If zero candidates: {"candidates": []}. Use double-quoted keys, no trailing commas. Must JSON.parse cleanly. postedDate may be the string "null" or actual JSON null.`,
      { label: `scan-r${round}`, phase: 'Scan' }
    )
    if (text && typeof text === 'string') {
      const m = text.match(/SCAN_JSON_BEGIN\s*([\s\S]*?)\s*SCAN_JSON_END/)
      if (m) {
        try { scanRes = JSON.parse(m[1].trim()) }
        catch (e) { log(`Scan r${round}: JSON.parse failed — ${e.message}. Raw len ${m[1].length}`) }
      } else {
        log(`Scan r${round}: no SCAN_JSON block in response (len ${text.length})`)
      }
    } else {
      log(`Scan r${round}: empty/non-string response`)
    }
  } catch (e) {
    log(`Scan r${round}: agent error — ${e.message?.slice(0,180)}`)
  }

  const fresh = (scanRes?.candidates || []).filter(c => c.url && !seenUrls.has(c.url))
  fresh.forEach(c => seenUrls.add(c.url))
  log(`Round ${round}: ${fresh.length} fresh candidates`)
  if (!fresh.length) { log(`Round ${round} dry`); continue }

  // Pre-allocate appNumbers to avoid races
  const pairs = fresh.map((c, i) => ({ c, num: nextAppNum + i }))
  nextAppNum += fresh.length

  phase('Evaluate')
  // Switched from parallel({schema}) -> pipeline(plain-text + sentinel-JSON parse).
  // Schema-mode subagents fail ~100% after long Playwright/WebFetch tool chains
  // ("subagent completed without calling StructuredOutput after 2 nudges"), per
  // 2026-05-30 Resume + 2026-06-02 Evaluate failures. Plain-text return is bulletproof.
  // 2026-06-10: Switched from pipeline() to chunked() with EVAL_CONCURRENCY=3 — pipeline's
  // default 16-way parallelism tripped Anthropic 429 on every Round-1 (3 documented kills).
  // chunked() limits to 3 concurrent + waits for batch completion before next batch.
  const evals = await chunked(
    pairs,
    async (item) => {
      const { c, num } = item
      try {
        const text = await agent(
          `Evaluate this job posting per modes/oferta.md (Blocks A-G + G Posting Legitimacy). Project root ${ROOT}.

MANDATORY READS: cv.md, config/profile.yml, modes/_profile.md, modes/_shared.md, modes/oferta.md.

INPUT:
  appNumber: ${num}
  url: ${c.url}
  company: ${c.company}
  role: ${c.role}
  postedDate: ${c.postedDate || 'unknown'}
  today: ${TODAY}

HARD RULES (refuse to violate, even to hit a target):
- JOBSPY PRE-FETCHED JD (CRITICAL — saves a fetch and dodges every aggregator paywall). If the candidate's source starts with "jobspy:" (any of jobspy:linkedin / jobspy:indeed / jobspy:zip_recruiter / jobspy:glassdoor), the real JD body is ALREADY in batch/_jobspy.json. Read that file FIRST, find the entry whose .url matches the candidate URL (also try .url_aggregator as a fallback). Use entry.description as the AUTHORITATIVE JD body for scoring — do NOT re-fetch the URL. Treat the candidate as LIVE and verified (the description being present proves the scrape succeeded within the last few minutes). If batch/_jobspy.json is missing or the URL is not found in it, fall through to the LIVE-verification rule below.
- Verify the posting is LIVE (Playwright preferred per AGENTS.md Offer Verification; WebFetch fallback) — ONLY for non-jobspy sources OR when the JobSpy lookup misses. If dead/closed -> score 1.0, status Discarded.
- UNFETCHABLE JD = NO FABRICATION (CRITICAL — applies when both JobSpy lookup AND direct fetch fail). ZipRecruiter, Tesla/Akamai careers, and many sites return HTTP 403 / login-walls to scraping. If you CANNOT read the ACTUAL JD body, you MUST NOT score it from prior/domain/general knowledge of the company or role family. First try to find the SAME req on the employer's first-party ATS (Greenhouse/Lever/Workday/iCIMS/careers page) or a Google-cache copy and read THAT. If the real JD still cannot be read -> cap score at 2.5, set skipReason "unverified-jd", and state the fetch failure plainly in the report. NEVER return a score >=${SCORE_FLOOR} for a posting whose JD you did not actually read. (This rule exists because 2026-06-08 produced fake 4.0+ scores — CalPERS 4.2, Tesla 4.1, <TARGET_COMPANY> 4.0 — all scored from memory after 403s.)
- NON-SPONSORING GOVERNMENT EMPLOYERS -> hard-reject for <YOUR_WORK_AUTH_STATUS>. US state/county/city/federal agencies and public pension funds (e.g. CalPERS and other state retirement systems, civil-service tracks) generally require US citizenship/permanent residency and do NOT sponsor H1B -> score 2.0, skipReason "no-sponsor". EXCEPTION: public UNIVERSITIES are H1B cap-exempt and ARE valid sponsors — do NOT reject universities under this rule.
- STAFFING-AGENCY / BODY-SHOP HARD-REJECT. Dice and Indeed return many consultancy/staffing listings that are sponsorship-risk + JD-vague + W2-only contracts at undisclosed end-clients. Hard-reject (score 1.5, skipReason "staffing-agency") if the company matches the seen-bad list: <STAFFING_AGENCY_1>, <STAFFING_AGENCY_2>, <STAFFING_AGENCY_3> (maintain your own list). Also reject any JD that says "our client", "end-client", "we're staffing for", or W2-only with multiple unrelated states listed — these are body-shops. EXCEPTIONS: Real direct-employer consultancies (Deloitte, McKinsey, BCG, Capgemini, Cognizant, Wipro, TCS, Slalom, EY, KPMG, PwC) ARE valid employers — do NOT reject these.
- Tier mismatch (Senior/Staff/Lead/Manager/III/IV/Principal/Director/Head/VP) -> hard-reject, return score 1.5 with skipReason.
- Non-USA -> hard-reject, score 1.5 with skipReason.
- WORK MODE: Remote, Hybrid, AND On-site are ALL in scope. User relocates anywhere in USA. OVERRIDE the modes/_profile.md location rubric — score location 5.0 for ANY US location regardless of work mode (remote = 5.0, hybrid = 5.0, onsite-any-metro = 5.0, onsite-requiring-relocation = 5.0). Do NOT penalize on-site or relocation requirements in this workflow.
- FRESHNESS: If postedDate is a KNOWN date >${FRESH_DAYS}d ago -> score caps at 3.0, skipReason "stale". If postedDate is unknown/null, do NOT cap or reject for staleness — rely on the LIVE verification above (Playwright/WebFetch); reject only on a POSITIVE expired/closed signal. Undated + live = treat as fresh.
- NEVER inflate scores. If the truthful Block A-F + G score is <${SCORE_FLOOR} that's fine — downstream filters.

STEPS:
1. Fetch JD content.
2. Score Blocks A-F + G honestly.
3. Compute Global Score (0-5, 1-decimal).
4. Slugify company+role -> kebab slug.
5. Write report to reports/${num}-{slug}-${TODAY}.md with header containing:
     # ${num} — {Company} — {Role}
     **Score:** X.X/5
     **URL:** ${c.url}
     **Legitimacy:** {tier}
     **PDF:** ❌
   Then Blocks A-G content.
6. Write batch/tracker-additions/${num}-{slug}.tsv (9 tab-cols per AGENTS.md TSV format):
     ${num}\\t${TODAY}\\t{company}\\t{role}\\tEvaluated\\t{score}/5\\t❌\\t[${num}](reports/${num}-{slug}-${TODAY}.md)\\t{one-line note}
7. Merge into data/posted-dates.json: { dates: { "${num}": "<postedDate or empty>" } } — read existing, set key, write back.
8. Pick archetype from {Machine Learning Engineer, Applied AI / GenAI Engineer, NLP / LLM Engineer, MLOps Engineer, Data Scientist} matching the JD's actual domain.
9. Extract jdEmphasizeKeywords: 4-7 lowercase comma-separated keywords pulled from the JD (stack + domain).
10. Draft a truthful summaryAnchor (one sentence reframing cv.md facts toward this JD's actual ML domain — lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for; per CLAUDE.md Rule 6).

RETURN FORMAT — CRITICAL — plain text only. Do NOT call StructuredOutput / any schema tool. The LAST lines of your response MUST be exactly this block (one valid JSON object on a single line between the markers):

EVAL_JSON_BEGIN
{"appNumber": ${num}, "slug": "<kebab>", "score": <number 0-5>, "company": "<name>", "role": "<title>", "url": "${c.url}", "archetype": "<one of the 5 archetypes>", "reportPath": "reports/${num}-<slug>-${TODAY}.md", "jdEmphasizeKeywords": "<csv>", "summaryAnchor": "<one truthful sentence>", "skipReason": null}
EVAL_JSON_END

Replace placeholders. skipReason = null on normal pass, else short string ("stale"|"tier"|"location"|"dead"|"dup"). Use double-quoted keys, no trailing commas, must JSON.parse cleanly.`,
          { label: `eval:${c.company}`.slice(0, 50), phase: 'Evaluate' }
        )
        if (!text || typeof text !== 'string') return null
        const m = text.match(/EVAL_JSON_BEGIN\s*([\s\S]*?)\s*EVAL_JSON_END/)
        if (!m) { log(`Eval #${num} ${c.company}: no EVAL_JSON block — dropped`); return null }
        try { return JSON.parse(m[1].trim()) }
        catch (e) { log(`Eval #${num} ${c.company}: JSON.parse failed — ${e.message}`); return null }
      } catch (e) {
        log(`Eval #${num} ${c.company}: agent error — ${e.message?.slice(0,140)}`)
        return null
      }
    },
  )

  const valid = evals.filter(Boolean)
  allEvals.push(...valid)
  const fits = valid.filter(v => typeof v.score === 'number' && v.score >= SCORE_FLOOR)
  highFits.push(...fits)
  log(`Round ${round}: +${fits.length} new >=${SCORE_FLOOR} (running total ${highFits.length}/${TARGET})`)
}

log(`Scan loop complete. ${round} rounds. ${allEvals.length} total evals. ${highFits.length} >=${SCORE_FLOOR} hits.`)

if (!highFits.length) {
  log(`No >=${SCORE_FLOOR} hits found. Honest stop — no inflation.`)
  return { rounds: round, totalEvaluated: allEvals.length, highFits: 0, shipped: 0 }
}

// ---------- Phase 4: Resume (chunked to RESUME_CONCURRENCY=3 — yesterday's parallel-resume failed
// StructuredOutput for 9/9 after long tool chains; plain-text return is bulletproof. 2026-06-10:
// added the same 3-concurrent throttle as Eval to dodge Anthropic 429 when 10+ high-fits land.) ----------
phase('Resume')
const resumeResults = await chunked(highFits, async (hf) =>
  agent(
    `Generate a JD-tailored resume PDF for this >=${SCORE_FLOOR} match. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  archetype: ${hf.archetype}
  emphasize: ${hf.jdEmphasizeKeywords}
  summaryAnchor (truthful): ${hf.summaryAnchor}
  reportPath: ${hf.reportPath}

MANDATORY READS: cv.md, config/profile.yml, CLAUDE.md (Rule 6 + Rule 8 in particular), AGENTS.md Resume Accuracy section, config/active-template.txt.

STEPS:
0. Read config/active-template.txt — its single-line content is "html" or "latex" (default "html"). Per CLAUDE.md Rule 8, branch the build pipeline on this value:
   - active = "html"  -> use scripts/build-tailored-cv.mjs       then generate-pdf.mjs
   - active = "latex" -> use scripts/build-tailored-cv-latex.mjs then generate-latex.mjs   (one-page ATS template)
   Both builders accept the SAME 7 positional args + optional 8th overrides.json. The slug + final PDF path stay identical between the two; only the intermediate (HTML vs TEX) differs.
1. Craft a FULL JD-tailored Professional Summary (3-5 sentences). Per CLAUDE.md Rule 6:
   - Lead with the JD's actual ML domain/archetype (CV, NLP, recsys, GenAI/LLM, MLOps). Never default-stamp a domain the JD doesn't call for.
   - Every metric must trace to cv.md (<YOUR_CV_METRICS>).
   - Reframe, don't fabricate.
2. Build CV intermediate (HTML or TEX per active-template):
     HTML  -> node scripts/build-tailored-cv.mjs       ${hf.appNumber} {slug} "${hf.role}" "${hf.archetype}" "${hf.jdEmphasizeKeywords}" "" "<full summary>"
     LATEX -> node scripts/build-tailored-cv-latex.mjs ${hf.appNumber} {slug} "${hf.role}" "${hf.archetype}" "${hf.jdEmphasizeKeywords}" "" "<full summary>"
   ({slug} = company-role kebab consistent with the report path)
3. Generate PDF (path is identical for both pipelines):
     HTML  -> node generate-pdf.mjs   output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-{slug}.html output/${hf.appNumber}-{slug}.pdf
     LATEX -> node generate-latex.mjs output/_tmp_cv/<emitted-tex-path>               output/${hf.appNumber}-{slug}.pdf
   (LATEX builder prints its emitted .tex path to stdout — use that path.)
4. Edit ${hf.reportPath}: replace the line "**PDF:** ❌" with "**PDF:** ✅ output/${hf.appNumber}-{slug}.pdf"
5. Edit batch/tracker-additions/${hf.appNumber}-{slug}.tsv: flip the 7th tab-col (pdf) from ❌ to ✅.
6. MANDATORY VERIFICATION before returning — run these and confirm ALL three pass:
   - ls output/${hf.appNumber}-*.pdf  (PDF exists)
   - grep "**PDF:** ✅" ${hf.reportPath}  (report header flipped)
   - grep -P "^${hf.appNumber}\\t[^\\t]*\\t[^\\t]*\\t[^\\t]*\\t[^\\t]*\\t[^\\t]*\\t✅" batch/tracker-additions/${hf.appNumber}-*.tsv  (TSV PDF cell flipped)
   If ANY check fails, re-do the failed step.

Return ONE LINE of plain text:
  DONE app=${hf.appNumber} pdf=output/${hf.appNumber}-{slug}.pdf
or
  FAIL app=${hf.appNumber} reason=<short clause>
Plain text only. Do NOT call StructuredOutput.`,
    { label: `resume:${hf.company}`.slice(0, 50), phase: 'Resume' }
  ),
  RESUME_CONCURRENCY
)
log(`Resume chunked (concurrency=${RESUME_CONCURRENCY}): ${resumeResults.filter(Boolean).length}/${highFits.length} returned`)

// ---------- Phase 5: Outreach (SERIAL — parallel writes to data/contacts.json raced and
// 6/9 entries were lost in prior runs. Serial for-await guarantees write ordering.
// 2026-06-04: migrated {schema:OUTREACH_SCHEMA} -> plain-text + OUTREACH_JSON_BEGIN/END
// sentinel + try/catch. Same anti-pattern as Scan/Evaluate/Resume — long WebSearch+Read+
// Write chain timed out StructuredOutput on prior runs. Plain-text return is bulletproof.) ----------
phase('Outreach')
const outreachResults = []
for (const hf of highFits) {
  let r = null
  try {
    const text = await agent(
      `Source real, currently-employed LinkedIn outreach contacts. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: ${hf.reportPath}

MANDATORY READS: AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md, modes/_profile.md "Auto-Outreach for High-Fit Roles" template.

You are running SERIALLY — no other agent is writing to data/contacts.json concurrently. Take your time and write the FULL file back atomically.

AGGREGATOR DETECTION: If the company name is "<TARGET_COMPANY>" (or any aggregator listing where the real employer is undisclosed in the JD), skip WebSearch entirely. Set contacts=[] and gaps="Aggregator listing — employer undisclosed pre-application. Manual outreach deferred until employer reveals identity in recruiter screen." Still write the empty entry to contacts.json and the gap-note section to the report. Then emit the sentinel block below.

HARD RULES (real employer case — refuse to violate):
- Every contact = REAL human, real https://www.linkedin.com/in/<handle>/ URL. No TODO, no {firstName}, no search-URL placeholders.
- Currently employed at ${hf.company} (LinkedIn snippet shows current role at this company, not "Former" or another employer).
- 3 contacts MAX, types: hiring_manager (or direct team manager), recruiter (TA/sourcing), peer (similar IC on same team).
- Message framework per type per modes/contacto.md:
  · HM: Hook/Proof/CTA — anchor on something only that person did. ONE stat max. <=300 chars.
  · Recruiter: Fit/Proof/CTA — screening data (stack, comp band, work-auth <YOUR_WORK_AUTH_STATUS>, location). <=300 chars.
  · Peer: Interest/Connection/CTA — reference THEIR work; NO job pitch, NO referral ask. <=300 chars.
- No phone in messages. Email = <YOUR_EMAIL>.
- Verify char count <=300 on every connect message.
- If a role type can't be found, document in gaps — do NOT save a placeholder contact.

STEPS:
1. WebSearch (3 queries):
   - "${hf.company}" machine learning manager OR AI engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" OR "AI engineer" OR "applied scientist" site:linkedin.com/in
2. Confirm current employment via LinkedIn snippets.
3. Draft + verify <=300-char messages.
4. ATOMIC merge into data/contacts.json:
   - Read FULL existing JSON.
   - REMOVE any existing entry with appNumber == ${hf.appNumber} (idempotency).
   - APPEND new entry: { appNumber, company, role, url, contacts: [...], notes: <optional> }.
   - Sort applications[] by appNumber.
   - Write FULL JSON back via Write tool.
5. Append "## Outreach Targets (LinkedIn)" section to ${hf.reportPath}.

RETURN FORMAT — CRITICAL — plain text only. Do NOT call StructuredOutput / any schema tool. The LAST lines of your response MUST be exactly this block (one valid JSON object on a single line between the markers):

OUTREACH_JSON_BEGIN
{"appNumber": ${hf.appNumber}, "company": "${hf.company}", "contacts": [{"type": "hiring_manager|recruiter|peer", "name": "<full>", "title": "<title @ company>", "linkedin": "https://www.linkedin.com/in/<handle>/", "currentlyEmployed": true, "connectMessage": "<<=300 chars>", "chars": <number>, "notes": null}], "gaps": "<short string or null>"}
OUTREACH_JSON_END

Aggregator case: {"appNumber": ${hf.appNumber}, "company": "${hf.company}", "contacts": [], "gaps": "Aggregator listing — employer undisclosed pre-application."}. Use double-quoted keys, no trailing commas, must JSON.parse cleanly.`,
      { label: `outreach:${hf.company}`.slice(0, 50), phase: 'Outreach' }
    )
    if (text && typeof text === 'string') {
      const m = text.match(/OUTREACH_JSON_BEGIN\s*([\s\S]*?)\s*OUTREACH_JSON_END/)
      if (m) {
        try { r = JSON.parse(m[1].trim()) }
        catch (e) { log(`Outreach #${hf.appNumber} ${hf.company}: JSON.parse failed — ${e.message}`) }
      } else {
        log(`Outreach #${hf.appNumber} ${hf.company}: no OUTREACH_JSON block in response (len ${text.length})`)
      }
    } else {
      log(`Outreach #${hf.appNumber} ${hf.company}: empty/non-string response`)
    }
  } catch (e) {
    log(`Outreach #${hf.appNumber} ${hf.company}: agent error — ${e.message?.slice(0,180)}`)
  }
  if (!r) r = { appNumber: hf.appNumber, company: hf.company, contacts: [], gaps: 'Outreach agent failed — sourcing deferred for manual follow-up.' }
  outreachResults.push(r)
  log(`Outreach #${hf.appNumber}: ${r?.contacts?.length || 0} contacts`)
}
const shipped = highFits.map((hf, i) => ({ hf, resume: resumeResults[i], outreach: outreachResults[i] }))

// ---------- Phase 6: Merge + Verify ----------
phase('Merge')
const mergeRes = await agent(
  `Project root ${ROOT}. Run these two commands in sequence and report results:
1. node merge-tracker.mjs
2. node verify-pipeline.mjs

Return {merged: <number of rows merged>, errors: <number>, warnings: <number>, summary: "<one-line>"}.`,
  {
    schema: {
      type: 'object',
      properties: { merged: { type: 'number' }, errors: { type: 'number' }, warnings: { type: 'number' }, summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: true,
    },
    label: 'merge-verify',
  }
)

const shippedClean = (shipped || []).filter(Boolean)
log(`Tracker merge done. Rounds=${round}. Evals=${allEvals.length}. >=${SCORE_FLOOR}=${highFits.length}. Shipped stacks=${shippedClean.length}.`)

// ---------- Phase 7: Dashboard verify ----------
phase('Dashboard')
const firstHighFitNum = highFits[0]?.appNumber || null
const newAppNumStart = nextAppNum - allEvals.length
const newAppNumEnd = nextAppNum - 1
const dashboard = await agent(
  `Verify the webapp dashboard reflects the new data. Project root ${ROOT}. Per CLAUDE.md Rule 1: dashboard = webapp at port 5050, repo bind-mounted at /career-ops for DATA only — data changes reflect WITHOUT docker rebuild. Per CLAUDE.md Rule 5: only diagnose stale-frontend if the API serves wrong data (browser cache is the user's hard-refresh problem, not yours).

CHECKS (use http://127.0.0.1:5050):
1. Docker container health: docker ps --filter name=career-ops-dashboard --format "{{.Status}}"
2. curl -s http://127.0.0.1:5050/api/applications | jq 'length' — report total. Confirm appNumbers ${newAppNumStart}..${newAppNumEnd} (this run's evals) appear in the response.
3. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | length' — confirm new entries for all >=${SCORE_FLOOR} appNumbers: ${highFits.map(h => h.appNumber).join(', ') || '(none)'}.
4. curl -s http://127.0.0.1:5050/api/posted-dates | jq '.dates | length' — confirm new keys for this run.
5. ${firstHighFitNum ? `curl -s "http://127.0.0.1:5050/api/pdf-path?appNumber=${firstHighFitNum}" — verify PDF path is returned (not 404).` : 'Skip PDF endpoint check (no high-fits this run).'}
6. ${firstHighFitNum ? `curl -s "http://127.0.0.1:5050/api/report?appNumber=${firstHighFitNum}" — verify report markdown is served.` : 'Skip report endpoint check.'}

If the container is unhealthy: report exact "docker ps" output and recommend \`docker compose up -d career-ops-dashboard\` (NOT --build, since this is DATA-only).
If an API returns 404 for new data: that IS a backend bug — report which endpoint and which appNumber.
Tell the user to hard-refresh the browser (Ctrl+Shift+R) per CLAUDE.md Rule 5.

Return { dockerStatus, applicationsCount, contactsAppsCount, postedDatesCount, newAppsVisible (bool), newContactsVisible (bool), pdfEndpointOk (bool|null), reportEndpointOk (bool|null), needsHardRefresh: true, issues: "<none | description>" }.`,
  {
    schema: {
      type: 'object',
      properties: {
        dockerStatus: { type: 'string' },
        applicationsCount: { type: ['number', 'null'] },
        contactsAppsCount: { type: ['number', 'null'] },
        postedDatesCount: { type: ['number', 'null'] },
        newAppsVisible: { type: 'boolean' },
        newContactsVisible: { type: 'boolean' },
        pdfEndpointOk: { type: ['boolean', 'null'] },
        reportEndpointOk: { type: ['boolean', 'null'] },
        needsHardRefresh: { type: 'boolean' },
        issues: { type: 'string' },
      },
      required: ['dockerStatus', 'issues'],
      additionalProperties: true,
    },
    label: 'dashboard-verify',
  }
)

log(`Dashboard: ${dashboard?.issues === 'none' ? 'all green' : dashboard?.issues}`)

return {
  rounds: round,
  totalEvaluated: allEvals.length,
  highFits: highFits.map(h => ({ appNumber: h.appNumber, company: h.company, role: h.role, score: h.score, url: h.url })),
  shippedStacks: shippedClean.length,
  mergeSummary: mergeRes?.summary || null,
  dashboard,
}
