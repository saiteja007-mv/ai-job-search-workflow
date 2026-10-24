export const meta = {
  name: 'career-ops-deepscan-tsenta',
  description: 'Deep multi-channel AI/ML scan (tsenta unfiltered + curated ATS + aggregators + Unipile LinkedIn), full-JD career-ops evaluation, adversarial verify of every claimed >=4.0',
  whenToUse: 'Deepscan day: widest fresh-supply sweep across every channel, honest >=4.0 gate, dual-verified. Feeds the apply + outreach + recruiter-email phases that run after it.',
  phases: [
    { title: 'Scan', detail: '5 parallel channels: tsenta unfiltered, tsenta fresh, curated ATS, sweepers+jobspy, aggregator MCPs + Unipile LinkedIn' },
    { title: 'Evaluate', detail: 'Full-JD career-ops rubric per candidate (Blocks A-G), status-bar hard skip, honest score' },
    { title: 'Verify', detail: '2 independent from-scratch re-scorers per claimed >=4.0; mean decides' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const SCORE_FLOOR = 4.0
const FRESH_DAYS = 3
const EVAL_CAP = 26

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) {
  throw new Error('args.today is REQUIRED (YYYY-MM-DD)')
}
const TODAY = _args.today
// No default: a guessed report number is the #749 parallel-collision race. Caller must supply it
// (career-ops-daily-run reads max+1 in preflight), or reserve a range with reserve-report-num.mjs.
const START_NUM = _args.startNum
if (!START_NUM) throw new Error('args.startNum is REQUIRED — read max report number + 1, or reserve a range with `node reserve-report-num.mjs --count N`')

// A prior tsenta run today is the common case but NOT a given. When absent, nothing is pre-excluded.
const PRIOR_RUN = _args.priorRunReport || null
const PRIOR_EXCLUDE = PRIOR_RUN
  ? `Also read ${PRIOR_RUN} — a tsenta run ALREADY fired today. Every company/role in its "Apply outcomes", "Hard skips", "SKIP < 4.0" and "Ashby" tables is ALREADY DONE. Do not return any of them.`
  : `No prior tsenta run has fired today, so nothing is pre-excluded on that basis. Do NOT go looking for a reports/tsenta-daily-*.md for today — it does not exist. Dedup against the tracker and scan history as usual.`
const PRIOR_DEDUP = PRIOR_RUN ? `, and ${PRIOR_RUN}` : ''

// Optional geographic narrowing. Normally location only RANKS; when a scope is passed it FILTERS.
const LOC = _args.locationScope || null
const LOC_RULE = LOC ? `

*** GEOGRAPHIC SCOPE — THIS RUN IS RESTRICTED TO ${String(LOC.label || `${LOC.city}, ${LOC.state}`).toUpperCase()} ***
This OVERRIDES the "location is a ranking signal, never a filter" rule above. For this run only, location IS a hard filter:
- KEEP a role only if it is physically in ${LOC.label || `${LOC.city}, ${LOC.state}`}, OR is Remote-US (remote roles are location-independent and the candidate can hold them from ${LOC.city} — keep them and tag them remote).
- Hybrid/onsite anywhere else is OUT this run, however good the score. A 4.5 in Austin is OUT.
- Read the FULL location string. "${LOC.state}" alone is not enough — a role in a different ${LOC.state} city is OUT unless it is commutable to ${LOC.city} or explicitly remote.
- ${LOC.city} spans two states (KS and MO) if it is <YOUR_CITY> — accept BOTH sides of the metro, plus <YOUR_METRO_SUBURBS>.
- A null/empty location is NOT automatically in scope this run: verify from the JD body, and drop it if the JD names a different metro.
- Say in your notes how many candidates you dropped purely on geography — a thin result is expected and correct here, and a padded one is a failure.` : ''

// ---------------------------------------------------------------- shared prompt blocks
const PROFILE_READS = `MANDATORY READS FIRST (in this order, they define the whole gate):
  AGENTS.md, CLAUDE.md, modes/_profile.md, modes/_shared.md, config/profile.yml, cv-aiml.md.`

const HARD_RULES = `HARD RULES (refuse to violate — these have all burned prior runs):
- TIER: entry/mid only. HARD-REJECT any title containing Senior, Sr., Staff, Lead, Principal, III, IV, Manager, Director, Head, VP, Architect.
- USA ONLY. Reject EU/UK/Canada/India/LatAm/APAC. Careful: ", ca" matches BOTH California and Canada — never blanket-block it, read the full location string.
- ALL WORK MODES in scope (remote, hybrid, onsite). The candidate relocates anywhere in the USA. Location is a RANKING signal, never a filter. Tiers: Remote-US & SF Bay 5.0 > Austin 4.7 > other TX 4.5 = <YOUR_CITY>/MO 4.5 > any other state 4.0.
- SPONSORSHIP FILTER IS OFF (standing user override). Do NOT reject or penalize a role merely for saying it will not sponsor H-1B. Only a clause that bars the candidate's CURRENT status is a hard skip: US-citizen-only, active security clearance, ITAR/EAR export control, "US Person" requirement, or a JD that names F-1/OPT as an unaccommodated permit.
- PERM NOTICE SKIP: a JD containing "permanent alien labor certification" / "Certifying Officer" / a DOL notice-of-filing block is a green-card filing for an existing employee, NOT a real opening. Hard skip.
- FRESHNESS: a KNOWN published date older than ${FRESH_DAYS} days is out. UNDATED postings (Ashby/Lever/GH often return null) are IN — do not reject for a missing date.
- Aggregators (<TARGET_COMPANY>, Lensa, Dice-reposts of the same req, staffing agencies) score <3.0 unless the true employer is named in the JD.${LOC_RULE}`

const CHANNEL_SCHEMA_NOTE = `RETURN FORMAT — CRITICAL — plain text only. Do NOT call StructuredOutput or any schema tool (schema-mode subagents die after long tool chains). The LAST lines of your response MUST be exactly this block, one valid JSON object on ONE line between the markers:

SCAN_JSON_BEGIN
{"channel":"<name>","candidates":[{"url":"<full url>","company":"<name>","role":"<title>","postedDate":"<YYYY-MM-DD or null>","location":"<string or null>","source":"<sub-source>","tsentaJobId":"<id or null>","atsType":"<greenhouse|lever|ashby|workday|icims|dayforce|ultipro|oraclecloud|other|null>","jdFile":"<path written, or null>"}],"notes":"<one line: what ran, what failed, counts>"}
SCAN_JSON_END

If zero: {"channel":"<name>","candidates":[],"notes":"..."}. Double-quoted keys, no trailing commas, must JSON.parse cleanly. Never fabricate a URL — only real fetched postings.`

// ---------------------------------------------------------------- Phase 1: Scan
phase('Scan')
log(`Deepscan ${TODAY} — appNumbers start at ${START_NUM}, floor ${SCORE_FLOOR}, freshness ${FRESH_DAYS}d`)

const CHANNELS = [
  {
    key: 'tsenta-unfiltered',
    prompt: `You are the TSENTA UNFILTERED channel of a career-ops deepscan. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}

${PRIOR_EXCLUDE}

THE POINT OF THIS CHANNEL (this is the single highest-yield lesson of the whole project — do not shortcut it):
tsenta's \`get-job-recommendations\` SILENTLY DROPS rows whose field is null or oddly shaped whenever ANY filter param is passed. A prior run proved that \`locations:["country:US"]\` alone hid **144 never-seen jobs scoring 82-85** — higher than everything the filtered pull returned (68-79). The single best job of that run existed ONLY in the unfiltered pull.${PRIOR_RUN ? ' Assume today\'s earlier run used the FILTERED path, so that hidden inventory is still unseen — this channel is the only thing that will surface it.' : ''}

So: run the UNFILTERED sweep.
  Load the tool first: ToolSearch "select:mcp__claude_ai_Tsenta__get-job-recommendations,mcp__claude_ai_Tsenta__get-jobs-by-ids"
  Call: { datePosted: "all", limit: 50 } — NO locations, NO jobTypes, NO search, NO autoApplyOnly.
  ("search" is BROKEN — it returns 0 whenever combined with any other filter. Never pass it.)
  Paginate page:2 .. page:5 while hasMore. Output is large and auto-saves to a tool-results/*.txt file — parse that file with ctx_execute / a node script, do NOT read it raw into context.

Then screen in POST-PROCESSING (not via API filters):
  - US-eligible location (read the location string yourself; empty/null location is NOT a rejection, keep it and note it)
  - fresh: datePosted within ${FRESH_DAYS} days, or null/absent
  - title matches AI/ML/DS: machine learning, ml engineer, ai engineer, applied ai, applied scien, data scien, deep learning, nlp, llm, gen ai, genai, mlops, recommendation, computer vision, search/relevance/ranking
  - drop the senior tokens and the non-engineering tokens (sales, account, field application, solutions architect, support engineer, intern, temporary, contract-to-hire)
  - isSupportedAts true OR false — keep BOTH, tag atsType; unsupported ones become the manual-apply queue.

${HARD_RULES}

Rank survivors by matchScore desc, cap at 30. Then pull the FULL JD for those with \`get-jobs-by-ids\` ({ descriptionMaxChars: 8000 }) and WRITE them (Write tool) to ${ROOT}\\batch\\_deepscan_tsenta_unfiltered.json as {"jobs":[{"id","company","title","location","datePosted","url","atsType","matchScore","description"}]}. Set jdFile to that path on every candidate you return so the evaluators can read the JD without re-hitting the API.

${CHANNEL_SCHEMA_NOTE}`,
  },
  {
    key: 'tsenta-fresh-delta',
    prompt: `You are the TSENTA FRESH-DELTA channel of a career-ops deepscan. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}

${PRIOR_RUN ? `Read ${PRIOR_RUN} first — today's earlier tsenta run already evaluated a batch of JDs. Everything named in it is DONE; exclude it all.` : 'No prior tsenta run today, so the delta is measured against data/applications.md and data/scan-history.tsv only.'}

Load: ToolSearch "select:mcp__claude_ai_Tsenta__get-job-recommendations,mcp__claude_ai_Tsenta__get-jobs-by-ids"

Run TWO pulls the earlier run did not do, and take the DELTA vs its report:
  A) { autoApplyOnly: false, datePosted: "7d", limit: 50 } — no locations, no jobTypes. autoApplyOnly:false surfaces roles the auto-apply feed suppresses.
  B) { jobTypes: ["ENTRY_LEVEL","MID_LEVEL"], datePosted: "3d", limit: 50 } — no locations.
Paginate each to page 3 while hasMore. Output auto-saves to tool-results/*.txt — parse the FILE with a script, never read it raw.
Do NOT pass \`search\` (broken when combined with any other filter). Do NOT pass \`locations\` (it hides rows).

Screen in post-processing exactly as the unfiltered channel does: US-eligible (null location kept), fresh within ${FRESH_DAYS} days or undated, AI/ML/DS title, no senior tokens, keep supported AND unsupported ATS.

${HARD_RULES}

Cap at 20 after dedup against the earlier report. Pull full JDs with \`get-jobs-by-ids\` ({descriptionMaxChars: 8000}) and Write them to ${ROOT}\\batch\\_deepscan_tsenta_delta.json in the same {"jobs":[...]} shape. Set jdFile accordingly.

${CHANNEL_SCHEMA_NOTE}`,
  },
  {
    key: 'curated-ats',
    prompt: `You are the CURATED-ATS channel of a career-ops deepscan. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}
Also read modes/scan.md and portals.yml.

Run the zero-token scanners:
  1) node scan.mjs            (consult modes/scan.md for current flags; company-first over portals.yml tracked_companies)
  2) node scan-ats-full.mjs   (keyword-first reverse-ATS sweep of the full public job-board dataset)

KNOWN FAILURE MODES — handle, do not panic:
- WORK OUT WHAT DAY ${TODAY} IS before you judge a thin result. If it is a Saturday or Sunday, ~0 matches is legitimate and EXPECTED — the pass rate is ~0.83% and weekend posting volume collapses. A weekend 0 is a REAL result, not a bug: report it as 0 and move on. On a Tuesday-Friday, a 0 is worth one retry before you believe it.
- Greenhouse SELF-WAFs at high concurrency and hides it behind 429s. If scan-ats-full 429-throttles, lower CONCURRENCY (env CONCURRENCY=6) and retry ONCE. If it throttles again, report 0 for that provider and continue. Never let it fail the channel.
- Check discard.log after a thin scan — a us_only allowlist previously killed valid ambiguous-location rows silently. If the discard log shows US-eligible rows dropped for an ambiguous location, RESCUE them into your candidate list.

Then read data/pipeline.md for any un-evaluated backlog URLs and include the AI/ML ones.

${HARD_RULES}

Dedup against data/applications.md (company+role), data/scan-history.tsv${PRIOR_DEDUP}.
Cap at 20.

${CHANNEL_SCHEMA_NOTE}`,
  },
  {
    key: 'sweepers-jobspy',
    prompt: `You are the SWEEPERS + JOBSPY channel of a career-ops deepscan. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}

Run all three sweepers; each already applies positive-title + freshness + tracker-dedup internally, so their output merges verbatim:
  1) node batch/sweep-simplify-gh.mjs ${FRESH_DAYS}      -> then Read batch/_simplify_gh.json and merge candidates[]
  2) node batch/sweep-workday-payers.mjs ${FRESH_DAYS}   -> then Read batch/_workday_payers.json and merge candidates[]
  3) python batch/sweep_jobspy.py ${FRESH_DAYS}          -> then Read batch/_jobspy.json and merge candidates[]
     For jobspy: DROP the \`description\`/\`description_source\` fields from what you RETURN (they bloat the prompt) but set jdFile to "batch/_jobspy.json" so evaluators can read the JD from the file. source values: "jobspy:linkedin" / "jobspy:indeed" / "jobspy:zip_recruiter" / "jobspy:glassdoor".

If a sweeper is missing or errors, log ONE line and continue — never fail the channel over one sweeper.

KNOWN TRAP: the LinkedIn scraper feed at D:\\Projects\\Scrapling has been running STALE Data-Analyst queries, and its postings are frequently expired. Do NOT pull from it here.

${HARD_RULES}

Dedup against data/applications.md, data/scan-history.tsv${PRIOR_DEDUP}. Cap at 20.

${CHANNEL_SCHEMA_NOTE}`,
  },
  {
    key: 'aggregators-linkedin',
    prompt: `You are the AGGREGATOR-MCP + LINKEDIN channel of a career-ops deepscan. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}

Query the aggregator job-search MCPs. Their schemas are DEFERRED — load them in ONE ToolSearch call:
  ToolSearch "select:mcp__claude_ai_Indeed__search_jobs,mcp__claude_ai_ZipRecruiter__search_jobs,mcp__claude_ai_Dice__search_jobs"
(If a name does not resolve, retry with keyword queries "Indeed search_jobs", "ZipRecruiter search_jobs", "Dice search_jobs willing_to_sponsor". ZipRecruiter and Dice may require an interactive auth handshake — if a tool returns an auth/authenticate error, log ONE line and skip that provider. Never fail the channel over a missing aggregator.)

Keyword phrases to sweep (2-3 calls each provider, spread across these):
  "machine learning engineer", "AI engineer", "applied AI engineer", "LLM engineer", "MLOps engineer", "data scientist"

  INDEED: { search: "<phrase>", location: "remote", country_code: "US" } and again with location: "United States". Indeed exposes NO posted-date filter — set postedDate null and let the evaluator live-verify (aggregators report ingestion time, not post time).
  ZIPRECRUITER: { query: "<phrase>", max_posted_minutes_ago: ${FRESH_DAYS * 1440}, seniority_classes: ["NO_EXPERIENCE","JUNIOR","MID"], salary_min: 70000 }; one pass with location_types:["REMOTE"], one nationwide. NEVER pass seniority_classes ["SENIOR"].
  DICE: { keyword: "<phrase>", posted_date: "THREE", workplace_types: ["Remote"] } and again without workplace_types. Do NOT pass employment_types.
    NOTE: Dice's \`willing_to_sponsor\` filter is NOT wanted here — the sponsorship filter is OFF for this candidate (standing override), and passing it needlessly shrinks the pool.

ALSO: Unipile LinkedIn job search — this is the one channel that bypasses LinkedIn's login wall.
  Credentials live in ${ROOT}\\.env as UNIPILE_API_KEY / UNIPILE_API_BASE. Account id: <UNIPILE_ACCOUNT_ID>. NEVER print or echo the key.
  POST {base}/linkedin/search with {"api":"classic","category":"jobs","keywords":"<phrase>"} and account_id.
  Default sort is newest-first and there is NO date param — filter by \`posted_at\` LOCALLY.
  PER-COMPANY keyword search works far better than a broad sweep (a broad search buries real targets under recruiter spam) — so run 3-4 broad phrases, then 3-4 targeted at portals.yml companies.
  Full JD: GET {base}/linkedin/jobs/{id}?account_id=... returns the complete \`description\`. Write the JDs you fetch to ${ROOT}\\batch\\_deepscan_linkedin.json as {"jobs":[{"id","company","title","location","posted_at","url","description"}]} and set jdFile to it.
  PACING: the Unipile account is rate-sensitive (a prior day hit ~40 actions and risked a LinkedIn restriction). Keep this channel under ~25 API calls total.

${HARD_RULES}

Dedup against data/applications.md, data/scan-history.tsv${PRIOR_DEDUP}. Cap at 20.

${CHANNEL_SCHEMA_NOTE}`,
  },
]

const scanRaw = await parallel(CHANNELS.map(ch => () =>
  agent(ch.prompt, { label: `scan:${ch.key}`, phase: 'Scan' })
    .then(text => {
      if (!text || typeof text !== 'string') { log(`${ch.key}: empty response`); return null }
      const m = text.match(/SCAN_JSON_BEGIN\s*([\s\S]*?)\s*SCAN_JSON_END/)
      if (!m) { log(`${ch.key}: no SCAN_JSON block (len ${text.length})`); return null }
      try { return JSON.parse(m[1].trim()) }
      catch (e) { log(`${ch.key}: JSON.parse failed — ${e.message}`); return null }
    })
    .catch(e => { log(`${ch.key}: agent error — ${String(e.message).slice(0, 160)}`); return null })
))

// ---- dedup across channels (plain code, needs all channels — barrier is correct here)
const seen = new Set()
const pool = []
for (const r of scanRaw.filter(Boolean)) {
  log(`${r.channel}: ${(r.candidates || []).length} candidates — ${r.notes || ''}`.slice(0, 300))
  for (const c of (r.candidates || [])) {
    if (!c || !c.url) continue
    const key = `${(c.company || '').toLowerCase().trim()}|${(c.role || '').toLowerCase().trim()}`
    const urlKey = c.url.split('?')[0].toLowerCase()
    if (seen.has(key) || seen.has(urlKey)) continue
    seen.add(key); seen.add(urlKey)
    pool.push({ ...c, channel: r.channel })
  }
}
log(`Deduped pool: ${pool.length} unique candidates across ${scanRaw.filter(Boolean).length}/${CHANNELS.length} channels`)
if (!pool.length) {
  return { today: TODAY, poolSize: 0, evaluated: [], confirmed: [], note: 'All channels dry — nothing to evaluate.' }
}

const shortlist = pool.slice(0, EVAL_CAP)
if (pool.length > EVAL_CAP) log(`CAPPED: evaluating ${EVAL_CAP} of ${pool.length}; ${pool.length - EVAL_CAP} deferred (not silently dropped — listed in the return payload)`)
const deferred = pool.slice(EVAL_CAP).map(c => ({ company: c.company, role: c.role, url: c.url, channel: c.channel }))

// ---------------------------------------------------------------- Phase 2 + 3: Evaluate -> Verify (pipelined)
const numbered = shortlist.map((c, i) => ({ ...c, appNumber: START_NUM + i }))

const results = await pipeline(
  numbered,

  // --- stage 1: honest full-JD evaluation
  (c) => agent(
    `Evaluate ONE job for career-ops. Project root: ${ROOT}. Today: ${TODAY}.

${PROFILE_READS}
Also read modes/oferta.md (the rubric, Blocks A-G) and article-digest.md (proof points).

CANDIDATE:
  appNumber: ${c.appNumber}
  company: ${c.company}
  role: ${c.role}
  url: ${c.url}
  location: ${c.location || 'unknown'}
  postedDate: ${c.postedDate || 'unknown/null'}
  atsType: ${c.atsType || 'unknown'}
  tsentaJobId: ${c.tsentaJobId || 'none'}
  jdFile: ${c.jdFile || 'none'}
  channel: ${c.channel}

STEP 1 — GET THE REAL JD. This is not optional and it is where prior runs went wrong.
  If jdFile is set, Read it and find this job's full \`description\`. Otherwise fetch the URL (WebFetch, or Unipile GET /linkedin/jobs/{id} for a LinkedIn URL).
  A prior batch scored jobs from TITLE + KEYWORDS ALONE and came out ~0.5 too high across the board. If you cannot obtain the real JD body, you MUST return score 0.0 with skipReason "JD unavailable — not scored" rather than guessing from the title.

STEP 2 — HARD-SKIP GREP the JD body before scoring, for: F-1, OPT, CPT, EAD, "US citizen", "U.S. Citizen", clearance, ITAR, "export control", "US Person", "permanent alien labor certification", "Certifying Officer".
  A clause barring the candidate's CURRENT status (citizen-only / clearance / ITAR / US-Person) -> hard skip, score 0.0, skipReason names the exact quoted clause.
  A JD merely saying it will not sponsor H-1B is NOT a skip and NOT a penalty — the sponsorship filter is OFF (standing user override).
  A DOL PERM notice-of-filing block -> hard skip (it is a green-card filing for an existing employee, not an opening).

  FIELD POLARITY — READ THIS TWICE. The return field is \`candidateIsBarred\`. It means "this JD contains a clause that BARS THIS CANDIDATE from the role", NOT "I performed the grep" and NOT "the JD has a work-authorization section". Set it TRUE only together with score 0.0 and a skipReason quoting the barring clause. If you are returning any score above 0.0, \`candidateIsBarred\` MUST be false — a barred role is never also a scoreable role. A prior run set this true on five 4.1-4.4 roles that had no bar at all, and the gate silently discarded every one of them.

STEP 3 — SCORE 0.0-5.0 on the career-ops rubric against cv-aiml.md. Be honest and be specific.
${HARD_RULES}
  CALIBRATION (from 200+ scored JDs — do not drift from it):
  - The HONEST CEILING for this candidate is ~4.4. A >=4.5 happens about once in 20 roles. If you are about to write 4.5+, re-read the JD and justify it against a concrete requirement-by-requirement match, or come down.
  - Never inflate to fill a quota. Zero >=4.0 in a batch is a valid, expected outcome.
  - Score DOWN for: required years beyond the candidate's ~3, a required primary language that is not Python/SQL (C++/Java/C#/Scala as a hard req), heavy front-end requirements (React/Angular/TypeScript as a core req), staff-augmentation/consultancy body-shop postings, comp band below $110K, stub/contentless JDs, PM-first or internal-IT-first roles, contract/hourly.
  - Score UP for: production RAG / vector search / semantic retrieval, recommendation + ranking, transformer NLP, LLM serving and evaluation, MLOps on AWS/K8s, multimodal/edge ML — these are the candidate's actual shipped work.
  - Location is a RANKING signal only, per the tiers above. Never let location alone push a role below 4.0.

STEP 4 — If and ONLY IF the score is >= ${SCORE_FLOOR}: write the full career-ops report to ${ROOT}\\reports\\${c.appNumber}-<company-slug>-${TODAY}.md following modes/oferta.md (Blocks A-F plus Block G Posting Legitimacy), header carrying **Score:**, **URL:**, **Legitimacy:**, and write the tracker TSV line to ${ROOT}\\batch\\tracker-additions\\<num>-<company-slug>.tsv with the 9 tab-separated columns in the AGENTS.md order (num, date, company, role, STATUS, score, pdf, report-link, notes). Use appNumber ${c.appNumber} — it is pre-allocated to you, never recompute it.
  If the score is < ${SCORE_FLOOR}, write NOTHING to disk. Just report the score.

RETURN FORMAT — plain text only, no StructuredOutput. Last lines exactly:

EVAL_JSON_BEGIN
{"appNumber":${c.appNumber},"company":"${c.company}","role":"${c.role}","url":"${c.url}","tsentaJobId":${c.tsentaJobId ? `"${c.tsentaJobId}"` : 'null'},"atsType":"${c.atsType || 'unknown'}","score":<0.0-5.0>,"candidateIsBarred":<true|false>,"skipReason":"<string or null>","reportPath":"<path or null>","comp":"<advertised band or null>","locationTier":"<remote-us|sf-bay|austin|other-tx|kc|other-state|unknown>","jdEmphasize":"<3-6 comma-separated JD keywords a tailored resume should lead with>","evidence":"<2-3 sentences: the concrete requirement-by-requirement basis for this score, quoting the JD>"}
EVAL_JSON_END`,
    { label: `eval:${String(c.company).slice(0, 28)}`, phase: 'Evaluate' }
  ).then(text => {
    const m = typeof text === 'string' && text.match(/EVAL_JSON_BEGIN\s*([\s\S]*?)\s*EVAL_JSON_END/)
    if (!m) { log(`eval ${c.company}: no EVAL_JSON block`); return null }
    try { return { ...JSON.parse(m[1].trim()), channel: c.channel, jdFile: c.jdFile } }
    catch (e) { log(`eval ${c.company}: parse failed — ${e.message}`); return null }
  }).catch(e => { log(`eval ${c.company}: ${String(e.message).slice(0, 140)}`); return null }),

  // --- stage 2: 2 independent from-scratch re-scorers, ONLY for claimed >=4.0
  async (ev) => {
    if (!ev) return null
    // A "barred" verdict is only trustworthy when it comes with score 0.0 and a stated reason.
    // Evaluators have misread the flag as "I ran the grep" and set it true on genuine 4.1-4.4 fits;
    // treating that as a skip silently threw away the best jobs of the run. Require corroboration.
    const genuinelyBarred = ev.candidateIsBarred && ev.score < SCORE_FLOOR && !!ev.skipReason
    if (ev.candidateIsBarred && !genuinelyBarred) {
      log(`${ev.company}: candidateIsBarred=true but score ${ev.score} with skipReason=${JSON.stringify(ev.skipReason)} — contradictory, sending to verify instead of skipping`)
    }
    if (genuinelyBarred || ev.score < SCORE_FLOOR) return { ...ev, verified: false, verdict: genuinelyBarred ? `barred: ${ev.skipReason}` : 'below-floor' }

    const LENSES = [
      { key: 'requirements', angle: 'Score it purely on REQUIREMENT MATCH: walk the JD\'s required-qualifications list line by line against cv-aiml.md and count real hits vs real misses. Years of experience, required languages, required frameworks, degree, domain. Do not be swayed by how exciting the company is.' },
      { key: 'realism', angle: 'Score it on REALISM OF GETTING AN INTERVIEW: comp band vs the candidate\'s <TARGET_COMP_RANGE> target, seniority creep hidden in the body (a JD titled "II" that asks for 5+ years is really senior), whether this is a staffing/consultancy body-shop req, whether the posting is a stub or a repost, and whether the location/work-mode is workable. Also re-check the work-authorization language yourself.' },
    ]

    const votes = await parallel(LENSES.map(L => () =>
      agent(
        `Independently re-score ONE job for career-ops, FROM SCRATCH. Project root: ${ROOT}. Today: ${TODAY}.

You are NOT reviewing someone else's score — you have not been told it, and you must not ask for it. Read the JD and score it yourself.

${PROFILE_READS}
Also read modes/oferta.md and article-digest.md.

JOB: ${ev.company} — ${ev.role}
URL: ${ev.url}
${ev.jdFile ? `JD file (Read it, find this job's description): ${ev.jdFile}` : 'Fetch the JD from the URL.'}

YOUR LENS: ${L.angle}

${HARD_RULES}

CALIBRATION: honest ceiling ~4.4; >=4.5 is ~1 in 20. Do not inflate. Zero-qualifying is a valid outcome.
If you cannot obtain the real JD body, return score 0.0 and say so — never score from the title.

RETURN FORMAT — plain text, last lines exactly:

VERIFY_JSON_BEGIN
{"score":<0.0-5.0>,"statusBar":<true|false>,"factualDefect":<true|false>,"defectDetail":"<string or null>","reason":"<2 sentences>"}
VERIFY_JSON_END

Set factualDefect true ONLY for a hard defect: a work-authorization/clearance bar you found in the JD, a posting that is expired/closed, an invented experience claim, or a JD you could not retrieve at all. A merely-low score is NOT a factual defect.`,
        { label: `verify:${L.key}:${String(ev.company).slice(0, 18)}`, phase: 'Verify', effort: 'high' }
      ).then(t => {
        const m = typeof t === 'string' && t.match(/VERIFY_JSON_BEGIN\s*([\s\S]*?)\s*VERIFY_JSON_END/)
        if (!m) return null
        try { return JSON.parse(m[1].trim()) } catch { return null }
      }).catch(() => null)
    ))

    const good = votes.filter(Boolean)
    if (!good.length) return { ...ev, verified: false, verdict: 'verifiers-failed', finalScore: ev.score }

    // Rule (locked 2026-07-26): the two independent re-scorers DECIDE by mean. A verifier can veto
    // only on a FACTUAL defect — never on "I'd score it lower". Averaging a refuter's low-by-design
    // score nearly killed a legitimate 4.13 in a prior run.
    const defect = good.find(v => v.factualDefect || v.statusBar)
    const mean = good.reduce((a, v) => a + (v.score || 0), 0) / good.length
    const finalScore = Math.round(((ev.score + mean * good.length) / (1 + good.length)) * 100) / 100

    if (defect) return { ...ev, verified: false, verdict: `vetoed: ${defect.defectDetail || 'status bar'}`, finalScore, votes: good.map(v => v.score) }
    if (mean < SCORE_FLOOR) return { ...ev, verified: false, verdict: `verifier mean ${mean.toFixed(2)} < ${SCORE_FLOOR}`, finalScore, votes: good.map(v => v.score) }
    return { ...ev, verified: true, verdict: 'confirmed', finalScore, votes: good.map(v => v.score) }
  }
)

const clean = results.filter(Boolean)
const confirmed = clean.filter(r => r.verified).sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
const nearMiss = clean.filter(r => !r.verified && r.score >= SCORE_FLOOR)
const barred = clean.filter(r => String(r.verdict || '').startsWith('barred:'))

log(`RESULT: ${confirmed.length} confirmed >=${SCORE_FLOOR} · ${nearMiss.length} claimed-but-not-confirmed · ${barred.length} work-auth/clearance barred · ${clean.length} evaluated of ${pool.length} pooled`)

return {
  today: TODAY,
  startNum: START_NUM,
  poolSize: pool.length,
  evaluatedCount: clean.length,
  deferredNotEvaluated: deferred,
  confirmed: confirmed.map(r => ({
    appNumber: r.appNumber, company: r.company, role: r.role, url: r.url,
    tsentaJobId: r.tsentaJobId, atsType: r.atsType,
    score: r.score, finalScore: r.finalScore, votes: r.votes,
    comp: r.comp, locationTier: r.locationTier, reportPath: r.reportPath,
    jdEmphasize: r.jdEmphasize, channel: r.channel,
  })),
  nearMiss: nearMiss.map(r => ({ company: r.company, role: r.role, score: r.score, finalScore: r.finalScore, verdict: r.verdict, url: r.url })),
  barred: barred.map(r => ({ company: r.company, role: r.role, skipReason: r.skipReason })),
  belowFloor: clean.filter(r => !r.statusBar && r.score < SCORE_FLOOR)
    .map(r => ({ company: r.company, role: r.role, score: r.score, why: String(r.evidence || '').slice(0, 160) })),
}
