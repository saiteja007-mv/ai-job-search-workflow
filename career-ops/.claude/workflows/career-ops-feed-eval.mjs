export const meta = {
  name: 'career-ops-feed-eval',
  description: 'Evaluate a pre-triaged candidate list from batch/_linkedin_feed_triage.json (skip Scan loop). Ship resume + outreach for >=4.0 hits, merge tracker, verify dashboard.',
  whenToUse: 'Use after triage-linkedin-feed.mjs writes batch/_linkedin_feed_triage.json. Faster than deep-scan because the candidate pool is already filtered, no portal sweeping.',
  phases: [
    { title: 'Setup',     detail: 'Resolve next appNumber + load triage artifact' },
    { title: 'Evaluate',  detail: 'A-G score per modes/oferta.md, chunked 3 concurrent' },
    { title: 'Resume',    detail: 'JD-tailored summary + PDF, chunked 3 concurrent' },
    { title: 'Outreach',  detail: 'Real LinkedIn HM/Recruiter/Peer, serial' },
    { title: 'Merge',     detail: 'merge-tracker.mjs + verify-pipeline.mjs' },
    { title: 'Dashboard', detail: 'Verify webapp /api/* reflects new data' },
    { title: 'MarkProcessed', detail: 'Flip processed=true on all evaluated jobs.json ids' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const FEED_PATH = 'D:/Projects/Scrapling/linkedin-job-scraper/data/jobs.json'
const TRIAGE_PATH = '<CAREER_OPS_DIR>/batch/_linkedin_feed_triage.json'
const SCORE_FLOOR = 4.0

// args.today REQUIRED, args.bucket optional ("eval_worthy" | "uncertain").
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) {
  throw new Error('args.today REQUIRED (YYYY-MM-DD)')
}
const TODAY = _args.today
const BUCKET = _args.bucket || 'eval_worthy'
const DEDUP_COMPANY_ROLE = _args.dedupCompanyRole || []  // optional [{company, rolePattern}] to skip

// ---------- schemas ----------
const SETUP_SCHEMA = {
  type: 'object',
  properties: { maxAppNumber: { type: 'number' } },
  required: ['maxAppNumber'],
  additionalProperties: false,
}

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
const SETUP_COMBINED_SCHEMA = {
  type: 'object',
  properties: {
    maxAppNumber: { type: 'number' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, url: { type: 'string' }, company: { type: 'string' },
          role: { type: 'string' }, location: { type: 'string' }, posted_date: { type: ['string', 'null'] },
        },
        required: ['id', 'url', 'company', 'role'],
        additionalProperties: true,
      },
    },
  },
  required: ['maxAppNumber', 'candidates'],
  additionalProperties: false,
}

const setup = await agent(
  `Two tasks. Project root ${ROOT}.

TASK 1 — Compute next free application number across THREE sources, return MAX:
  1. data/applications.md — MAX value in the "#" column. Run: grep -oE "^\\| [0-9]+ " data/applications.md | grep -oE "[0-9]+" | sort -n | tail -1
  2. reports/ — MAX leading integer. Run: ls reports/ | grep -oE "^[0-9]+" | sort -n | tail -1
  3. data/posted-dates.json — MAX numeric key.

TASK 2 — Load LinkedIn-feed candidates:
  Read ${TRIAGE_PATH}.
  Return the candidates array from the "${BUCKET}" bucket — each item has {id, url, company, role, location, posted_date}.
  ALSO filter out any candidate where (company, role) duplicates a row already in data/applications.md. Skip the entry if company name + role title both appear together in that file (case-insensitive substring match). This protects against re-scoring yesterday's high-fits that came back in the LinkedIn feed.

Return {maxAppNumber: N, candidates: [...filtered]}. Empty sources count as 0.`,
  { schema: SETUP_COMBINED_SCHEMA, label: 'setup-and-load' }
)

let nextAppNum = (setup?.maxAppNumber || 849) + 1
const POOL = setup?.candidates || []
log(`Start appNumber = ${nextAppNum}. Loaded ${POOL.length} candidates (bucket=${BUCKET}, after dedup).`)

if (!POOL.length) {
  log(`Empty pool. Stopping.`)
  return { bucket: BUCKET, pool: 0, evaluated: 0, highFits: [], shippedStacks: 0 }
}

// Pre-allocate appNumbers (avoid races)
const pairs = POOL.map((c, i) => ({
  c: { url: c.url, company: c.company, role: c.role, postedDate: c.posted_date || null, source: 'linkedin-scraper', id: c.id },
  num: nextAppNum + i,
}))
nextAppNum += POOL.length

// ---------- Phase 2: Evaluate ----------
phase('Evaluate')
const evals = await chunked(
  pairs,
  async ({ c, num }) => {
    try {
      const text = await agent(
        `Evaluate this LinkedIn-scraper job posting per modes/oferta.md (Blocks A-G + G Posting Legitimacy). Project root ${ROOT}.

MANDATORY READS: cv.md, config/profile.yml, modes/_profile.md, modes/_shared.md, modes/oferta.md.

INPUT:
  appNumber: ${num}
  url: ${c.url}
  company: ${c.company}
  role: ${c.role}
  postedDate: ${c.postedDate || 'unknown'}
  source: linkedin-scraper
  today: ${TODAY}

HARD RULES (refuse to violate, even to hit a target):
- LinkedIn JD body is behind a login wall. Try LinkedIn URL first via WebFetch / Playwright; if returns 999/403/login wall, search Google for the same role+company and find the post on the company's first-party ATS (Greenhouse/Lever/Workday/Ashby/iCIMS/SmartRecruiters/careers page) — read THAT instead. The LinkedIn id can be cross-referenced via the job title + company.
- UNFETCHABLE JD = NO FABRICATION. If you cannot read the ACTUAL JD body after first-party ATS lookup, cap score at 2.5, set skipReason "unverified-jd". NEVER return score >=${SCORE_FLOOR} without reading the real JD.
- DEAD/CLOSED -> score 1.0, status Discarded.
- NON-SPONSORING GOVERNMENT -> hard-reject (score 2.0, skipReason "no-sponsor"). EXCEPTION: public universities are H1B cap-exempt — valid sponsors.
- STAFFING-AGENCY / BODY-SHOP HARD-REJECT. Triage already filtered known agencies, but re-check JD body for "our client", "end-client", "we're staffing for", or W2-only with multiple unrelated states. If body-shop -> score 1.5, skipReason "staffing-agency".
- TIER MISMATCH (Senior/Staff/Lead/Manager/III/IV/Principal/Director/Head/VP) -> hard-reject, score 1.5, skipReason "tier".
- DUPLICATE: BEFORE writing the report, grep data/applications.md for "${c.company.replace(/[*+?^$\\.()|[\\]{}]/g, '.')}" — if same company+role already in tracker, score 0 with skipReason "dup". DO NOT write a tracker-additions TSV (the merge will skip).
- WORK MODE: Remote, Hybrid, AND On-site are ALL in scope. Score location 5.0 for ANY US location.
- NEVER inflate scores.

STEPS:
1. Fetch JD content (LinkedIn -> first-party ATS fallback).
2. Score Blocks A-F + G.
3. Compute Global Score (0-5, 1-decimal).
4. Slugify company+role -> kebab slug.
5. Write report to reports/${num}-{slug}-${TODAY}.md with header:
     # ${num} — {Company} — {Role}
     **Score:** X.X/5
     **URL:** ${c.url}
     **Legitimacy:** {tier}
     **PDF:** ❌
   Then Blocks A-G content.
6. Write batch/tracker-additions/${num}-{slug}.tsv (9 tab-cols per AGENTS.md TSV format) UNLESS skipReason == "dup":
     ${num}\\t${TODAY}\\t{company}\\t{role}\\tEvaluated\\t{score}/5\\t❌\\t[${num}](reports/${num}-{slug}-${TODAY}.md)\\t{one-line note}
   IMPORTANT: if role contains "|", replace with "—" in the TSV's role column to avoid breaking merge-tracker column parsing.
7. Merge into data/posted-dates.json: { dates: { "${num}": "<postedDate or empty>" } }.
8. Pick archetype from {Machine Learning Engineer, Applied AI / GenAI Engineer, NLP / LLM Engineer, MLOps Engineer, Data Scientist}.
9. Extract jdEmphasizeKeywords: 4-7 lowercase comma-separated keywords from JD.
10. Draft truthful summaryAnchor (one sentence reframing cv.md facts to lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for).

RETURN FORMAT — plain text only. Do NOT call StructuredOutput. The LAST lines MUST be exactly this block:

EVAL_JSON_BEGIN
{"appNumber": ${num}, "slug": "<kebab>", "score": <number 0-5>, "company": "<name>", "role": "<title>", "url": "${c.url}", "archetype": "<one of 4>", "reportPath": "reports/${num}-<slug>-${TODAY}.md", "jdEmphasizeKeywords": "<csv>", "summaryAnchor": "<one truthful sentence>", "skipReason": null, "feedId": "${c.id}"}
EVAL_JSON_END

skipReason null on normal pass, else short string ("stale"|"tier"|"location"|"dead"|"dup"|"no-sponsor"|"staffing-agency"|"unverified-jd"). Double-quoted keys, no trailing commas.`,
        { label: `eval:${c.company}`.slice(0, 50), phase: 'Evaluate' }
      )
      if (!text || typeof text !== 'string') return null
      const m = text.match(/EVAL_JSON_BEGIN\s*([\s\S]*?)\s*EVAL_JSON_END/)
      if (!m) { log(`Eval #${num} ${c.company}: no EVAL_JSON block`); return null }
      try { return JSON.parse(m[1].trim()) }
      catch (e) { log(`Eval #${num} ${c.company}: JSON.parse failed — ${e.message}`); return null }
    } catch (e) {
      log(`Eval #${num} ${c.company}: agent error — ${e.message?.slice(0, 140)}`)
      return null
    }
  },
  EVAL_CONCURRENCY,
)

const valid = evals.filter(Boolean)
const highFits = valid.filter(v => typeof v.score === 'number' && v.score >= SCORE_FLOOR && v.skipReason == null)
log(`Eval done: ${valid.length}/${POOL.length} returned. >=${SCORE_FLOOR}: ${highFits.length}`)

const evaluatedFeedIds = valid.map(v => v.feedId).filter(Boolean)

if (!highFits.length) {
  log(`No >=${SCORE_FLOOR} hits. Will still merge tracker + mark processed.`)
}

// ---------- Phase 3: Resume (only for high-fits) ----------
phase('Resume')
const resumeResults = highFits.length
  ? await chunked(highFits, async (hf) =>
      agent(
        `Generate JD-tailored resume PDF for this >=${SCORE_FLOOR} match. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  archetype: ${hf.archetype}
  emphasize: ${hf.jdEmphasizeKeywords}
  summaryAnchor: ${hf.summaryAnchor}
  reportPath: ${hf.reportPath}

MANDATORY READS: cv.md, config/profile.yml, CLAUDE.md (Rule 6, Rule 8), AGENTS.md Resume Accuracy, config/active-template.txt.

STEPS:
0. Read config/active-template.txt. Branch on content:
   - "html"  -> scripts/build-tailored-cv.mjs       + generate-pdf.mjs
   - "latex" -> scripts/build-tailored-cv-latex.mjs + generate-latex.mjs
1. Craft FULL JD-tailored Professional Summary (3-5 sentences). Per CLAUDE.md Rule 6: lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for. Every metric must trace to cv.md (<YOUR_CV_METRICS>). Reframe, don't fabricate.
2. Build intermediate:
     HTML  -> node scripts/build-tailored-cv.mjs       ${hf.appNumber} {slug} "${hf.role}" "${hf.archetype}" "${hf.jdEmphasizeKeywords}" "" "<summary>"
     LATEX -> node scripts/build-tailored-cv-latex.mjs ${hf.appNumber} {slug} "${hf.role}" "${hf.archetype}" "${hf.jdEmphasizeKeywords}" "" "<summary>"
3. Generate PDF:
     HTML  -> node generate-pdf.mjs   output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-{slug}.html output/${hf.appNumber}-{slug}.pdf
     LATEX -> node generate-latex.mjs output/_tmp_cv/<emitted-tex> output/${hf.appNumber}-{slug}.pdf
4. Edit ${hf.reportPath}: replace "**PDF:** ❌" with "**PDF:** ✅ output/${hf.appNumber}-{slug}.pdf"
5. Edit batch/tracker-additions/${hf.appNumber}-{slug}.tsv: flip 7th col ❌ -> ✅.
6. VERIFY: ls output/${hf.appNumber}-*.pdf, grep "**PDF:** ✅" in report, grep PDF=✅ in TSV.

Return ONE LINE:
  DONE app=${hf.appNumber} pdf=output/${hf.appNumber}-{slug}.pdf
or
  FAIL app=${hf.appNumber} reason=<short>
Plain text only.`,
        { label: `resume:${hf.company}`.slice(0, 50), phase: 'Resume' }
      ),
      RESUME_CONCURRENCY,
    )
  : []
log(`Resume: ${resumeResults.filter(Boolean).length}/${highFits.length} returned`)

// ---------- Phase 4: Outreach (serial) ----------
phase('Outreach')
const outreachResults = []
for (const hf of highFits) {
  let r = null
  try {
    const text = await agent(
      `Source real, currently-employed LinkedIn outreach contacts for #${hf.appNumber} at ${hf.company}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: ${hf.reportPath}

MANDATORY READS: AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md, modes/_profile.md "Auto-Outreach".

SERIAL — take time, write data/contacts.json atomically.

AGGREGATOR DETECTION: If company == "<TARGET_COMPANY>" or undisclosed employer, set contacts=[], gaps="Aggregator listing — employer undisclosed pre-application." Write empty entry + gap note, emit sentinel.

HARD RULES:
- Every contact = REAL human, real https://www.linkedin.com/in/<handle>/ URL. No TODO, no placeholder.
- Currently employed at ${hf.company}. NO "Former" or other employer.
- 3 contacts MAX: hiring_manager, recruiter, peer.
- Message framework per type:
  · HM: Hook/Proof/CTA — anchor on something only that person did. ONE stat max. <=300 chars.
  · Recruiter: Fit/Proof/CTA — screening data (stack, comp, <YOUR_WORK_AUTH_STATUS>, location). <=300 chars.
  · Peer: Interest/Connection/CTA — reference THEIR work. NO job pitch, NO referral ask. <=300 chars.
- Email = <YOUR_EMAIL>. No phone.
- Char count <=300 verified per message.
- Missing role type -> document in gaps, DO NOT save placeholder.

STEPS:
1. WebSearch 3 queries:
   - "${hf.company}" machine learning engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" OR "AI engineer" site:linkedin.com/in
2. Confirm current employment via LinkedIn snippets.
3. Draft + verify <=300-char messages.
4. ATOMIC merge data/contacts.json: Read FULL, remove existing entry with appNumber == ${hf.appNumber}, append new, sort by appNumber, Write FULL back.
5. Append "## Outreach Targets (LinkedIn)" section to ${hf.reportPath}.

RETURN FORMAT — plain text. Do NOT call StructuredOutput.

OUTREACH_JSON_BEGIN
{"appNumber": ${hf.appNumber}, "company": "${hf.company}", "contacts": [{"type": "hiring_manager|recruiter|peer", "name": "<full>", "title": "<title @ company>", "linkedin": "https://www.linkedin.com/in/<handle>/", "currentlyEmployed": true, "connectMessage": "<<=300 chars>", "chars": <number>, "notes": null}], "gaps": "<short string or null>"}
OUTREACH_JSON_END

Double-quoted keys, no trailing commas.`,
      { label: `outreach:${hf.company}`.slice(0, 50), phase: 'Outreach' }
    )
    if (text && typeof text === 'string') {
      const m = text.match(/OUTREACH_JSON_BEGIN\s*([\s\S]*?)\s*OUTREACH_JSON_END/)
      if (m) {
        try { r = JSON.parse(m[1].trim()) }
        catch (e) { log(`Outreach #${hf.appNumber}: JSON.parse failed — ${e.message}`) }
      } else { log(`Outreach #${hf.appNumber}: no OUTREACH_JSON block`) }
    }
  } catch (e) { log(`Outreach #${hf.appNumber}: agent error — ${e.message?.slice(0, 160)}`) }
  if (!r) r = { appNumber: hf.appNumber, company: hf.company, contacts: [], gaps: 'Outreach agent failed — sourcing deferred.' }
  outreachResults.push(r)
  log(`Outreach #${hf.appNumber}: ${r?.contacts?.length || 0} contacts`)
}

// ---------- Phase 5: Merge + Verify ----------
phase('Merge')
const mergeRes = await agent(
  `Project root ${ROOT}. Run in sequence:
1. node merge-tracker.mjs
2. node verify-pipeline.mjs
Return {merged: <int>, errors: <int>, warnings: <int>, summary: "<one-line>"}.`,
  {
    schema: {
      type: 'object',
      properties: { merged: { type: 'number' }, errors: { type: 'number' }, warnings: { type: 'number' }, summary: { type: 'string' } },
      required: ['summary'], additionalProperties: true,
    },
    label: 'merge-verify',
  }
)
log(`Merge: ${mergeRes?.summary}`)

// ---------- Phase 6: Dashboard ----------
phase('Dashboard')
const evalAppNums = valid.map(v => v.appNumber)
const dashboard = await agent(
  `Verify webapp dashboard reflects new data. Project root ${ROOT}. http://127.0.0.1:5050.

CHECKS:
1. docker ps --filter name=career-ops-dashboard --format "{{.Status}}"
2. curl -s http://127.0.0.1:5050/api/applications | jq 'length' — confirm appNumbers ${evalAppNums.slice(0,5).join(',')}... present.
3. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | length' — confirm new entries for >=${SCORE_FLOOR}: ${highFits.map(h => h.appNumber).join(', ') || '(none)'}.
4. curl -s http://127.0.0.1:5050/api/posted-dates | jq '.dates | length' — confirm new keys.

Return {dockerStatus, applicationsCount, contactsAppsCount, postedDatesCount, newAppsVisible (bool), newContactsVisible (bool), issues: "<none|description>"}.`,
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
        issues: { type: 'string' },
      },
      required: ['dockerStatus', 'issues'], additionalProperties: true,
    },
    label: 'dashboard-verify',
  }
)

// ---------- Phase 7: MarkProcessed ----------
phase('MarkProcessed')
const idsJson = JSON.stringify(evaluatedFeedIds)
const markRes = await agent(
  `Flip processed=true on these LinkedIn scraper job IDs in ${FEED_PATH}. Use a Node one-liner that READS the FULL file, mutates matching ids, writes back the FULL file pretty-printed.

IDS = ${idsJson}

Run:
  node -e "const fs=require('fs');const p='${FEED_PATH.replace(/\\/g,'\\\\')}';const ids=new Set(${idsJson});const j=JSON.parse(fs.readFileSync(p,'utf8'));let n=0;const s='${TODAY}T23:59:59Z';for(const x of (j.jobs||[])){if(ids.has(x.id)&&x.processed!==true){x.processed=true;x.updated_at=s;n++;}}fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('flipped',n);"

Return {flipped: <int>, total: ${evaluatedFeedIds.length}, summary: "<one-line>"}.`,
  {
    schema: {
      type: 'object',
      properties: { flipped: { type: 'number' }, total: { type: 'number' }, summary: { type: 'string' } },
      required: ['summary'], additionalProperties: true,
    },
    label: 'mark-processed',
  }
)
log(`MarkProcessed: ${markRes?.summary}`)

return {
  bucket: BUCKET,
  pool: POOL.length,
  evaluated: valid.length,
  highFits: highFits.map(h => ({ appNumber: h.appNumber, company: h.company, role: h.role, score: h.score, url: h.url })),
  shippedStacks: resumeResults.filter(Boolean).length,
  mergeSummary: mergeRes?.summary || null,
  dashboard,
  markedProcessed: evaluatedFeedIds.length,
}
