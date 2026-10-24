export const meta = {
  name: 'career-ops-daily-run',
  description: 'End-to-end career-ops day: preflight, multi-channel deepscan, barred-bucket rescue, gated tsenta apply, tracker land, contact sourcing, LinkedIn invites, hermes recruiter-email queue, review artifact + handoff',
  whenToUse: 'The full daily run, replacing the hand-driven session. Composes career-ops-deepscan-tsenta + career-ops-verify-shortlist + career-ops-recruiter-sourcing and adds the apply/track/outreach/wrap stages around them. args.today is REQUIRED. Nothing is emailed and nothing is applied outside the >=4.0 gate.',
  phases: [
    { title: 'Preflight', detail: 'doctor + update check + pipeline health + tsenta balance + next report number + prior-run detection' },
    { title: 'Scan', detail: 'delegates to career-ops-deepscan-tsenta (5 channels, eval, 2-lens verify)' },
    { title: 'Rescue', detail: 'delegates to career-ops-verify-shortlist over the barred + near-miss buckets — nothing is discarded on one gate alone' },
    { title: 'Apply', detail: 'one agent per confirmed role: tsenta apply with optimizationModeOverride OFF, or manual-apply queue' },
    { title: 'Track', detail: 'tracker TSVs -> merge-tracker.mjs -> verify-pipeline.mjs' },
    { title: 'Source', detail: 'delegates to career-ops-recruiter-sourcing over CONFIRMED-SUBMITTED companies only' },
    { title: 'Outreach', detail: 'Unipile LinkedIn invites + hermes Prospeo/Reoon email enrichment (queue only, never sends)' },
    { title: 'Wrap', detail: 'review artifact, Session_Handoff.md, AGENT_HANDOFF.md, <HOME_SERVER> sync check' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
// Local workflows are NOT name-resolvable — only the built-ins (deep-research, code-review) are.
// Child workflows must be addressed by absolute scriptPath or the run dies at the first delegation.
const WF = `${ROOT}\\.claude\\workflows`
const <HOME_SERVER> = '<SERVER_USER>@<SERVER_IP>'
const REMOTE = '<CAREER_OPS_DIR>'
const SCORE_FLOOR = 4.0

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
_args = _args || {}
if (!_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) throw new Error('args.today is REQUIRED (YYYY-MM-DD)')

const TODAY = _args.today
const MAX_APPLIES = _args.maxApplies || 6
// Outreach defaults are deliberately asymmetric: invites are reversible and were user-approved as a
// standing practice; a cold email is not. Emails are ENRICHED AND QUEUED but never sent from here.
const DO_INVITES = _args.invites !== false
const DO_EMAILS = _args.emails !== false
const INVITE_SCOPE = _args.inviteScope || 'applied-only'   // 'applied-only' | 'all-sourced'
const DRY_RUN = _args.dryRun === true

// Optional geographic narrowing. When set, location stops being a ranking signal and becomes a HARD
// filter in the scan, and the tsenta profile address is switched to match before any apply.
// e.g. { city: '<YOUR_CITY>', state: 'MO', label: '<YOUR_CITY> (KS/MO)' }
const LOC = _args.locationScope || null
let RUN_LOC_CHANGE = null   // records the previous address so the user can revert it

// ---------------------------------------------------------------- shared prompt fragments
const SSH = `SSH TO <HOME_SERVER>: the Bash tool's ssh is socket-blocked inside the Claude MSIX container — a direct \`ssh\` returns "Permission denied" even though the port is open. ALWAYS tunnel through WSL:
  wsl -e bash -lc "ssh ${<HOME_SERVER>} '<remote command>'"
For anything with nested quotes or a python heredoc, write a .sh to the scratchpad and pipe it instead of fighting the quoting:
  wsl -e bash -lc "ssh ${<HOME_SERVER>} 'bash -s'" < /path/to/script.sh`

const TRUTH = `TRUTH BOUNDARY — NON-NEGOTIABLE. Every factual claim about the candidate comes from cv-aiml.md, article-digest.md, config/profile.yml, modes/_profile.md or interview-prep/. Reorder and reframe; never invent. Prior runs injected "<TARGET_COMPANY>", "Content Safety", "LLM-as-a-Judge" and "agent orchestration" into user-facing text when none are on the CV — that is the worst failure mode of this pipeline. Never claim authorship of a repo/tool not attributed to him.`

// ================================================================ Phase 1: Preflight
phase('Preflight')

const pre = await agent(
  `Preflight a career-ops daily run. Project root: ${ROOT}. Today: ${TODAY}.

Run these and report what they actually say — do NOT fix anything, do NOT apply an update, do NOT edit the tracker:
  1. node doctor.mjs --json                 -> onboardingNeeded / missing / warnings
  2. node update-system.mjs check           -> if status is "update-available", SURFACE IT. AGENTS.md requires the user be offered the update; a prior run silently swallowed a 1.20.0 -> 1.24.0 notice.
  3. node verify-pipeline.mjs               -> error and warning counts
  4. Highest existing report number in reports/ (files are {###}-{slug}-{date}.md). nextReportNum = max + 1.
  5. Does reports/tsenta-daily-${TODAY}.md already exist? If so, a run already fired today — read it and list every company/role already applied to or already skipped, so the scan phase can exclude them. If it does not exist, say so plainly; do not invent one.
  6. tsenta balance: ToolSearch "select:mcp__claude_ai_Tsenta__get-application-balance,mcp__claude_ai_Tsenta__get-profile-status" then call both. Report credits remaining and whether the profile is complete.
     NOTE: a clean get-profile-status does NOT mean Workday will succeed — Workday still returns PROFILE_INCOMPLETE and BURNS THE CREDIT with no refund. Just report the numbers.
  7. ${SSH}
     Check the hermes host is reachable and report: systemctl is-active hermes-gateway hermes-webui, and the row count in ${REMOTE}/data/pending_recruiter_emails.json (jq '.emails | length', 0 if the file is absent).

RETURN FORMAT — plain text, last lines exactly:

PRE_JSON_BEGIN
{"onboardingNeeded":<bool>,"updateStatus":"<up-to-date|update-available|other>","updateLocal":"<ver or null>","updateRemote":"<ver or null>","pipelineErrors":<int>,"pipelineWarnings":<int>,"nextReportNum":<int>,"priorRunToday":<true|false>,"priorRunReport":"<path or null>","tsentaCredits":<int or null>,"hermesReachable":<bool>,"emailQueueDepth":<int>,"blockers":"<string or null>"}
PRE_JSON_END`,
  { label: 'preflight', phase: 'Preflight' }
).then(t => {
  const m = typeof t === 'string' && t.match(/PRE_JSON_BEGIN\s*([\s\S]*?)\s*PRE_JSON_END/)
  if (!m) return null
  try { return JSON.parse(m[1].trim()) } catch { return null }
}).catch(() => null)

const startNum = (pre && pre.nextReportNum) || _args.startNum
if (!startNum) throw new Error('preflight could not determine nextReportNum and args.startNum was not supplied — refusing to guess a report number')
if (pre && pre.onboardingNeeded) throw new Error(`doctor.mjs reports onboardingNeeded — missing setup files. Blockers: ${pre.blockers || 'see doctor output'}`)
if (pre && pre.updateStatus === 'update-available') log(`ATTENTION: career-ops update available (${pre.updateLocal} -> ${pre.updateRemote}). AGENTS.md requires offering this to the user — surface it in the final summary.`)
log(`Preflight ok — reports start at ${startNum}, pipeline ${pre ? pre.pipelineErrors : '?'} errors, tsenta credits ${pre ? pre.tsentaCredits : '?'}, prior run today: ${pre ? pre.priorRunToday : 'unknown'}`)

// ================================================================ Phase 2: Scan (delegated)
phase('Scan')

const scan = await workflow({ scriptPath: `${WF}\\career-ops-deepscan-tsenta.mjs` }, {
  today: TODAY,
  startNum,
  priorRunReport: pre && pre.priorRunToday ? (pre.priorRunReport || `reports/tsenta-daily-${TODAY}.md`) : null,
  locationScope: LOC,
})

const confirmed = (scan && scan.confirmed) || []
const nearMiss = (scan && scan.nearMiss) || []
const barred = (scan && scan.barred) || []
log(`Scan returned ${confirmed.length} confirmed, ${nearMiss.length} near-miss, ${barred.length} barred of ${scan ? scan.poolSize : 0} pooled`)

// ================================================================ Phase 3: Rescue (delegated)
// Locked lesson: a gate bug once set the "barred" flag on six roles scoring 4.1-4.4 that had no bar
// at all, and every one was silently discarded. Nothing leaves this pipeline on a single gate's word.
phase('Rescue')

const rescueJobs = [...barred, ...nearMiss]
  .filter(j => j && j.company)
  .map(j => ({ company: j.company, role: j.role, url: j.url, priorScore: j.finalScore || j.score || null, priorVerdict: j.verdict || j.skipReason || null }))

let rescued = []
if (rescueJobs.length) {
  const r = await workflow({ scriptPath: `${WF}\\career-ops-verify-shortlist.mjs` }, { today: TODAY, jobs: rescueJobs.slice(0, 10) })
  rescued = (r && r.confirmed) || []
  log(`Rescue: ${rescued.length}/${rescueJobs.length} re-confirmed on independent re-score`)
} else {
  log('Rescue: nothing in the barred/near-miss buckets — skipping')
}

// Merge, dedupe by company+role, rank. Rescued rows carry no report yet; the apply agent handles that.
const seen = new Set()
const shortlist = [...confirmed, ...rescued]
  .filter(j => {
    const k = `${String(j.company).toLowerCase()}|${String(j.role).toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return (j.finalScore || j.score || 0) >= SCORE_FLOOR
  })
  .sort((a, b) => (b.finalScore || b.score || 0) - (a.finalScore || a.score || 0))

const queue = shortlist.slice(0, MAX_APPLIES)
if (shortlist.length > queue.length) log(`CAPPED: ${shortlist.length} qualified, applying to top ${queue.length} (maxApplies). Dropped: ${shortlist.slice(MAX_APPLIES).map(j => `${j.company} ${j.finalScore || j.score}`).join(', ')}`)
if (!queue.length) log('No role cleared the floor after rescue — no applications this run. That is a valid outcome; never inflate a score to hit a count.')

// ================================================================ Phase 4: Apply
phase('Apply')

// When the run is geographically scoped, the tsenta profile address must match BEFORE any apply —
// the address is global to the account, not a per-application field. Done once here rather than in
// each parallel apply agent. NOTE: this change PERSISTS after the run.
if (LOC && queue.length && !DRY_RUN) {
  const locSet = await agent(
    `Set the tsenta profile address so this run's applications carry the right location. Project root: ${ROOT}.

Load: ToolSearch "select:mcp__claude_ai_Tsenta__set-personal-info,mcp__claude_ai_Tsenta__get-profile-status"

1. Read the CURRENT personal info first (get-profile-status) and REPORT the existing city/state/zip verbatim before changing anything — the user needs the old value recorded so it can be restored.
2. Then set: city "${LOC.city}", state "${LOC.state}"${LOC.zipCode ? `, zipCode "${LOC.zipCode}"` : ''}, country "United States".
   Change ONLY those fields. Do NOT touch firstName, lastName, email, phone, linkedinUrl, githubUrl, website or summary.
3. Confirm from the returned merged object that the new values actually landed.

This address is ACCOUNT-GLOBAL and persists after this run — it will also apply to any application the user submits themselves later. Report that clearly.

RETURN FORMAT — last lines exactly:

LOC_JSON_BEGIN
{"previous":{"city":"<old>","state":"<old>","zipCode":"<old or null>"},"applied":{"city":"<new>","state":"<new>"},"ok":<bool>}
LOC_JSON_END`,
    { label: `set-location:${LOC.city}`, phase: 'Apply' }
  ).then(t => {
    const m = typeof t === 'string' && t.match(/LOC_JSON_BEGIN\s*([\s\S]*?)\s*LOC_JSON_END/)
    if (!m) return null
    try { return JSON.parse(m[1].trim()) } catch { return null }
  }).catch(() => null)
  if (locSet) log(`Profile address ${locSet.previous ? `${locSet.previous.city}, ${locSet.previous.state}` : '?'} -> ${LOC.city}, ${LOC.state} (PERSISTS after this run)`)
  else log(`WARNING: could not set profile address to ${LOC.city} — applications may carry the old location`)
  RUN_LOC_CHANGE = locSet
}

// Report numbers for rescued jobs that arrive WITHOUT a report. The deepscan already consumed
// startNum..startNum+evaluatedCount, so new reports start past that, and each parallel agent gets its
// OWN number — handing every agent the same `startNum` is the #749 collision race.
let _next = startNum + ((scan && scan.evaluatedCount) || 0)
const queueNumbered = queue.map(j => ({ ...j, assignedNum: j.reportPath ? null : _next++ }))

const applied = queue.length ? (await parallel(queueNumbered.map(j => () =>
  agent(
    `Submit ONE application through the user-locked career-ops >=${SCORE_FLOOR} gate. Project root: ${ROOT}. Today: ${TODAY}.

ROLE: ${j.company} — ${j.role}
URL: ${j.url}
SCORE: ${j.finalScore || j.score} (already dual-verified — do NOT re-score it, do NOT second-guess the gate)
${j.tsentaJobId ? `tsenta jobId: ${j.tsentaJobId}` : 'no tsenta jobId — this is a manual-apply candidate unless you can locate it in the tsenta feed'}
ATS: ${j.atsType || 'unknown'}
${j.reportPath ? `report: ${j.reportPath}` : `NO REPORT YET — write reports/${j.assignedNum}-<slug>-${TODAY}.md first, full Blocks A-G per modes/oferta.md, including **URL:** and **Legitimacy:** in the header. Report number ${j.assignedNum} is RESERVED FOR YOU — other agents are writing their own numbers in parallel, so do NOT compute max+1 yourself and do NOT use any other number.`}

LIVENESS: Playwright MCP was NOT detected in preflight, so offer liveness cannot be verified the mandatory way. Per AGENTS.md, fall back to WebFetch and mark the report header **Verification:** unconfirmed. Never claim a posting was verified live when it was not.
${DRY_RUN ? '\n*** DRY RUN — do every step EXCEPT the final apply-to-job call. Report what you would have submitted. ***\n' : ''}

Load: ToolSearch "select:mcp__claude_ai_Tsenta__fetch-job-description,mcp__claude_ai_Tsenta__apply-to-job,mcp__claude_ai_Tsenta__get-application-status"

THE FOUR RULES THAT HAVE EACH COST A CREDIT OR A FABRICATED RESUME:
1. optimizationModeOverride MUST be "OFF". Not AGGRESSIVE, not HONEST. BOTH of the other modes inject
   JD-matched skills the candidate does not have — AGGRESSIVE invented "<TARGET_COMPANY>", HONEST invented
   "Content Safety", "Agent Orchestration" and "LLM-as-a-Judge". OFF is the only mode that ships the
   real CV.
2. apply-to-job MUST be passed jobDescription, taken from fetch-job-description first. Without it the
   resume ships un-optimized (isOptimized=false) and the tailoring silently does nothing.
3. Check the URL before spending the credit. A referral portal (referral-*.icims.com and friends) is
   NOT the public posting: it fails as FAILED (UNKNOWN), the credit is NOT refunded, and the job is
   then PERMANENTLY un-retryable because tsenta dedupes globally. If the URL looks like a referral or
   internal portal, do NOT apply — return status "manual-required" with the public careers URL instead.
4. Workday can return PROFILE_INCOMPLETE and burn the credit even when get-profile-status is clean.
   Greenhouse and Ashby are the reliable channels (Ashby's old "always fails" reputation is RETIRED —
   it has been verified working). oraclecloud has failed every attempt — prefer manual for it.

Then poll get-application-status until terminal. COMPLETED is the only success. Report the true
terminal state — never round a FAILED or an in-flight up to submitted.

${TRUTH}

RETURN FORMAT — plain text, last lines exactly:

APPLY_JSON_BEGIN
{"company":"${j.company}","role":"${j.role}","url":"${j.url}","score":${j.finalScore || j.score},"status":"<COMPLETED|FAILED|manual-required|dry-run>","failReason":"<string or null>","creditBurned":<bool>,"appliedVia":"<tsenta|manual|null>","reportPath":"<path or null>","appNumber":<int or null>,"publicUrl":"<string or null>"}
APPLY_JSON_END`,
    { label: `apply:${String(j.company).slice(0, 22)}`, phase: 'Apply', effort: 'high' }
  ).then(t => {
    const m = typeof t === 'string' && t.match(/APPLY_JSON_BEGIN\s*([\s\S]*?)\s*APPLY_JSON_END/)
    if (!m) return null
    try { return JSON.parse(m[1].trim()) } catch { return null }
  }).catch(e => { log(`${j.company}: apply agent failed — ${String(e.message).slice(0, 120)}`); return null })
))).filter(Boolean) : []

const submitted = applied.filter(a => a.status === 'COMPLETED')
const manualQueue = applied.filter(a => a.status === 'manual-required')
const failedApplies = applied.filter(a => a.status === 'FAILED')
log(`Apply: ${submitted.length} COMPLETED · ${manualQueue.length} manual-required · ${failedApplies.length} failed (${failedApplies.filter(f => f.creditBurned).length} burned a credit)`)

// ================================================================ Phase 5: Track
phase('Track')

const tracked = await agent(
  `Land this run's results in the career-ops tracker. Project root: ${ROOT}. Today: ${TODAY}.

RESULTS (status here is ground truth — the tracker must match it, not the optimistic pre-apply state):
${JSON.stringify(applied.map(a => ({ appNumber: a.appNumber, company: a.company, role: a.role, score: a.score, status: a.status, reportPath: a.reportPath })), null, 1)}

STEPS:
1. Write ONE TSV per row to batch/tracker-additions/{num}-{company-slug}.tsv — single line, 9 tab-separated columns, in this order (status BEFORE score; merge-tracker swaps them):
   {num}\\t{date}\\t{company}\\t{role}\\t{status}\\t{score}/5\\t{pdf_emoji}\\t[{num}](reports/{num}-{slug}-{date}.md)\\t{note}
   - status must be canonical per templates/states.yml: COMPLETED apply -> Applied; manual-required or not-yet-applied -> Evaluated; below floor -> SKIP.
   - the report link is written ROOT-relative here; merge-tracker rewrites it relative to the tracker.
   - no markdown bold, no dates, no extra text in the status column.
   VERIFY EACH TSV BEFORE MERGING: a prior run wrote six TSVs whose status and score disagreed with the
   final outcome and merged them unchecked. Read each file back and confirm the status matches the
   apply result above and the score matches the verified score.
2. node merge-tracker.mjs        — NEVER hand-edit data/applications.md to add rows.
3. node verify-pipeline.mjs      — report errors and warnings.
4. If any existing row needs a status change, use: node set-status.mjs <report#|company> <State> [--note]
   CAUTION: set-status takes the TRACKER ROW number, not the report-file number — they drift. Address
   rows by company name, or verify the resolved row before writing.
5. Mirror the tsenta outcomes into data/tsenta-apps.json (append rows, refresh the summary counters).

RETURN FORMAT — plain text, last lines exactly:

TRACK_JSON_BEGIN
{"tsvsWritten":<int>,"rowsBefore":<int>,"rowsAfter":<int>,"pipelineErrors":<int>,"pipelineWarnings":<int>,"corrections":"<what you had to fix, or null>"}
TRACK_JSON_END`,
  { label: 'track', phase: 'Track' }
).then(t => {
  const m = typeof t === 'string' && t.match(/TRACK_JSON_BEGIN\s*([\s\S]*?)\s*TRACK_JSON_END/)
  if (!m) return null
  try { return JSON.parse(m[1].trim()) } catch { return null }
}).catch(() => null)

// ================================================================ Phase 6: Source (delegated)
// Outreach follows the application, never precedes it: only CONFIRMED-SUBMITTED companies are sourced,
// so every message can honestly say "I applied".
phase('Source')

let sourced = { companies: [], totals: { companies: 0, contacts: 0, recruiters: 0 } }
if (submitted.length) {
  sourced = await workflow({ scriptPath: `${WF}\\career-ops-recruiter-sourcing.mjs` }, {
    today: TODAY,
    companies: submitted.map(a => ({ company: a.company, role: a.role, url: a.url, appNumber: a.appNumber, score: a.score, appliedVia: a.appliedVia || 'tsenta' })),
  }) || sourced
} else {
  log('Nothing was confirmed submitted — skipping outreach sourcing entirely (never source ahead of an application)')
}

const contactCount = (sourced.totals && sourced.totals.contacts) || 0

// ================================================================ Phase 7: Outreach
phase('Outreach')

const outreachTasks = []

if (DO_INVITES && contactCount) {
  outreachTasks.push(() => agent(
    `Send LinkedIn connection invites via Unipile for this run's sourced contacts. Project root: ${ROOT}. Today: ${TODAY}.
${DRY_RUN ? '\n*** DRY RUN — resolve every profile and report who WOULD be invited, but send nothing. ***\n' : ''}

SCOPE: ${INVITE_SCOPE}${INVITE_SCOPE === 'applied-only' ? ' — invite ONLY contacts at companies where an application is CONFIRMED SUBMITTED. This run submitted: ' + submitted.map(a => a.company).join(', ') : ' — every sourced contact'}

CONTACTS:
${JSON.stringify(sourced.companies, null, 1).slice(0, 12000)}

STEPS:
1. Merge these into data/contacts.json under this run's bucket. Back the file up first (data/contacts.json.bak-${TODAY}).
2. For each in-scope contact: resolve the LinkedIn handle to a provider_id, then POST /users/invite.
   - UNIPILE_API_BASE ALREADY ENDS IN /api/v1 — do not re-append it, that is a guaranteed 404.
   - Read the key from the environment/.env. NEVER print the API key, never write it into a report,
     never commit it.
   - Dedupe against data/outreach_log.json BEFORE sending. Anyone already contacted is skipped, not
     re-invited.
   - connectMessage must be <=300 characters — LinkedIn silently rejects longer ones. Count before sending.
3. On success write dateSent: "${TODAY}" back into that contact in data/contacts.json and append to
   data/outreach_log.json.
4. A DRY RUN FIRST is worth it: resolving all handles before sending proves the contacts are real
   people rather than generated handles. Report resolvable vs unresolvable counts either way.

${TRUTH}
The application is already submitted, so "I applied to..." is accurate. Never write "I'm applying" for
a submitted role and never claim an application that was not made.

RETURN FORMAT — plain text, last lines exactly:

INVITE_JSON_BEGIN
{"resolved":<int>,"sent":<int>,"skippedAlreadyContacted":<int>,"unresolvable":<int>,"failed":<int>,"failDetail":"<string or null>"}
INVITE_JSON_END`,
    { label: 'invites:unipile', phase: 'Outreach' }
  ).then(t => {
    const m = typeof t === 'string' && t.match(/INVITE_JSON_BEGIN\s*([\s\S]*?)\s*INVITE_JSON_END/)
    if (!m) return null
    try { return JSON.parse(m[1].trim()) } catch { return null }
  }).catch(() => null))
}

if (DO_EMAILS && contactCount) {
  outreachTasks.push(() => agent(
    `Enrich and QUEUE recruiter emails on the <HOME_SERVER> hermes host. Project root: ${ROOT}. Today: ${TODAY}.

*** THIS PHASE NEVER SENDS. It enriches, verifies, and leaves the queue for the user to send. Do not
run send_recruiter_emails.py without --dry under any circumstance. ***

${SSH}

CONTACTS SOURCED THIS RUN:
${JSON.stringify((sourced.companies || []).map(c => ({ company: c.company, role: c.role, contacts: (c.contacts || []).map(x => ({ name: x.name, title: x.title, type: x.type, linkedin: x.linkedin })) })), null, 1).slice(0, 10000)}

STEPS:
1. Append this run's contacts as blocks in ${REMOTE}/reports/recruiter-outreach-${TODAY}.md.
   Back it up first (.bak-preappend). Both the Unipile pipeline and the email pipeline read this SAME
   file with different regexes, so it is the single integration point and a shape error silently drops
   contacts from one or both.
   THE TITLE-LINE TRAP: the email parser takes the text AFTER THE FINAL COMMA of the title line as the
   company name. "<TARGET_COMPANY> — VP, Strategy & Technology" files her under company "Technology". Normalize
   every title so the company is the LAST comma-separated token: "VP Strategy & Technology, Leatherman".
   After writing, VALIDATE by running the real parsers (python3 -c importing recruiter_email_drafts and
   the unipile script's parse function) and confirm the block count matches what you appended. Do not
   validate with a hand-rolled regex — the point is to test the parser that actually runs.
2. BACK UP THE QUEUE BEFORE ENRICHING:
     cp ${REMOTE}/data/pending_recruiter_emails.json ${REMOTE}/data/pending_recruiter_emails.json.bak-${TODAY}
   The queue depth right now is ${pre ? pre.emailQueueDepth : 'unknown'} — record the exact number.
3. Run the drafter with a wide gap: REC_EMAIL_GAP=25 python3 ~/.hermes/scripts/recruiter_email_drafts.py
   THE REGRESSION THIS GUARDS AGAINST: the script REWRITES THE WHOLE QUEUE from scratch. Prospeo
   rate-limits at the default gap, and a run over ~39 contacts came back with 19 "Rate limit exceeded",
   shrank the queue from 10 verified addresses to 4, and DESTROYED six good ones. The addresses had not
   stopped existing — the limiter won.
   RUN IT IN THE FOREGROUND with a timeout — do NOT background it and poll:
     timeout 900 env REC_EMAIL_GAP=25 python3 ~/.hermes/scripts/recruiter_email_drafts.py 2>&1 | tail -20
   NEVER poll with \`pgrep -f "recruiter_email_drafts.py"\`. The remote shell running that loop has the
   pattern IN ITS OWN COMMAND LINE, so pgrep matches itself, the break never fires, and the loop burns
   its full duration before falsely reporting STILL_RUNNING — a real run wedged 9 minutes this way while
   the drafter had already finished. If you genuinely must poll, use a PID file, or the bracket trick
   \`pgrep -f "[r]ecruiter_email_drafts.py"\`, and cap the wait at 3 minutes.
4. Report the queue depth BEFORE and AFTER. Do not decide whether to restore — return both numbers and
   let the orchestrator decide.
   IF EVERY LOOKUP COMES BACK "Prospeo:Rate limit exceeded", the API QUOTA is exhausted — that is an
   account-level limit, not a per-call spacing problem, and a wider REC_EMAIL_GAP will NOT fix it.
   Report it as a quota exhaustion and stop retrying; do not burn the run waiting.
5. Dry-run the sender to show what would go out: python3 ~/.hermes/scripts/send_recruiter_emails.py all --dry
   Note that --max-send caps a TOP-DOWN WALK of the report, it does not select the best N. If a subset
   should go first, build a filtered report where the ordering IS the selection.
   Redact addresses to <local>@<domain-initial>... in your summary unless the user needs them to approve.

RETURN FORMAT — plain text, last lines exactly:

EMAIL_JSON_BEGIN
{"blocksAppended":<int>,"parserValidated":<bool>,"queueBefore":<int>,"queueAfter":<int>,"backupPath":"<path>","rateLimited":<int>,"wouldSend":<int>,"wouldSkip":<int>,"skipReasons":"<string or null>"}
EMAIL_JSON_END`,
    { label: 'emails:hermes', phase: 'Outreach' }
  ).then(t => {
    const m = typeof t === 'string' && t.match(/EMAIL_JSON_BEGIN\s*([\s\S]*?)\s*EMAIL_JSON_END/)
    if (!m) return null
    try { return JSON.parse(m[1].trim()) } catch { return null }
  }).catch(() => null))
}

const [invites, emails] = outreachTasks.length ? await parallel(outreachTasks) : [null, null]
const inviteRes = DO_INVITES ? invites : null
const emailRes = DO_INVITES ? emails : invites   // when invites are off, the single task is the email one

// Deterministic guard: the drafter rewrites the whole queue, so a shrink means the rate limiter won.
// The script decides this, not the agent that just ran the command.
let queueRestored = false
if (emailRes && typeof emailRes.queueAfter === 'number' && typeof emailRes.queueBefore === 'number' && emailRes.queueAfter < emailRes.queueBefore) {
  log(`QUEUE SHRANK ${emailRes.queueBefore} -> ${emailRes.queueAfter} (${emailRes.rateLimited || '?'} rate-limited). Restoring the backup — a smaller queue means the limiter won, not that the addresses stopped existing.`)
  const restore = await agent(
    `Restore the hermes recruiter-email queue from backup. ${SSH}

The drafter just rewrote ${REMOTE}/data/pending_recruiter_emails.json and the row count DROPPED from ${emailRes.queueBefore} to ${emailRes.queueAfter} — Prospeo rate-limiting, not a real change in who is reachable.

1. Preserve the bad run for evidence: cp the current queue to pending_recruiter_emails.json.bak-ratelimited-${TODAY}
2. Diff first and print it: which addresses does ${emailRes.backupPath} have that the current file lost, and did the new run gain ANY the backup lacked? (compare by the "to" field)
3. Only if the new run gained nothing, restore: cp ${emailRes.backupPath} onto the live queue. If it DID gain something, stop and report — a merge is a human decision.
4. Validate: python3 -m json.tool on the restored file, then re-dry-run send_recruiter_emails.py all --dry.

RETURN FORMAT — last lines exactly:

RESTORE_JSON_BEGIN
{"restored":<bool>,"lost":<int>,"gained":<int>,"finalQueue":<int>,"wouldSend":<int>,"note":"<string>"}
RESTORE_JSON_END`,
    { label: 'restore:queue', phase: 'Outreach' }
  ).then(t => {
    const m = typeof t === 'string' && t.match(/RESTORE_JSON_BEGIN\s*([\s\S]*?)\s*RESTORE_JSON_END/)
    if (!m) return null
    try { return JSON.parse(m[1].trim()) } catch { return null }
  }).catch(() => null)
  queueRestored = !!(restore && restore.restored)
  if (restore) log(`Restore: ${restore.restored ? 'reverted' : 'NOT reverted'} — lost ${restore.lost}, gained ${restore.gained}, final queue ${restore.finalQueue}, would send ${restore.wouldSend}`)
}

// ================================================================ Phase 8: Wrap
phase('Wrap')

const RUN = {
  today: TODAY,
  preflight: pre,
  scan: { pooled: scan && scan.poolSize, evaluated: scan && scan.evaluatedCount, confirmed: confirmed.length, nearMiss: nearMiss.length, barred: barred.length },
  rescued: rescued.map(r => ({ company: r.company, role: r.role, finalScore: r.finalScore })),
  shortlist: shortlist.map(j => ({ company: j.company, role: j.role, score: j.finalScore || j.score })),
  applied, submitted, manualQueue, failedApplies,
  tracker: tracked,
  sourced: sourced.totals,
  invites: inviteRes,
  emails: emailRes,
  queueRestored,
  locationScope: LOC,
  profileAddressChange: RUN_LOC_CHANGE,
}

const wrap = await agent(
  `Close out the career-ops daily run. Project root: ${ROOT}. Today: ${TODAY}.

RUN RESULT (ground truth — report it faithfully, including the failures):
${JSON.stringify(RUN, null, 1).slice(0, 14000)}

1. REVIEW ARTIFACT — build a self-contained HTML page in the scratchpad and publish it with the
   Artifact tool: every LinkedIn message that was sent, every queued email draft, the applications
   with their real terminal status, and anything left manual. Load the artifact-design skill first.
   Denominators must be honest (queued-of-sourced, sent-of-resolvable) — a prior artifact quoted /30
   when the real base was /39.
2. Session_Handoff.md at the project root — overwrite the top block, PREPEND to ## History (never
   rewrite history). Status in-progress/blocked if anything is owed. Include a "Things that will bite
   the next session" section carrying forward: the Prospeo rate-limit rewrite trap, the referral-URL
   apply failure, the set-status row-number drift, and anything new this run hit.
3. AGENT_HANDOFF.md — refresh the "Last updated" line and the FOR HERMES section: what is queued, the
   exact send command, what is still owed, and the standing warning not to re-run the drafter as-is.
4. Sync check: ${SSH} — confirm data/contacts.json and the reports landed on <HOME_SERVER> (Syncthing), and
   that no .sync-conflict file was created today.

Report only what is true. If a step did not happen, say so.

RETURN FORMAT — last lines exactly:

WRAP_JSON_BEGIN
{"artifactUrl":"<url or null>","handoffWritten":<bool>,"agentHandoffWritten":<bool>,"syncOk":<bool>,"owed":["<item>"]}
WRAP_JSON_END`,
  { label: 'wrap', phase: 'Wrap' }
).then(t => {
  const m = typeof t === 'string' && t.match(/WRAP_JSON_BEGIN\s*([\s\S]*?)\s*WRAP_JSON_END/)
  if (!m) return null
  try { return JSON.parse(m[1].trim()) } catch { return null }
}).catch(() => null)

log(`DONE — ${submitted.length} submitted · ${contactCount} contacts sourced · ${inviteRes ? inviteRes.sent : 0} invites · ${emailRes ? emailRes.wouldSend : 0} emails queued (UNSENT)`)

return {
  ...RUN,
  wrap,
  owed: [
    ...manualQueue.map(m => `manual apply: ${m.company} — ${m.publicUrl || m.url}`),
    ...(emailRes && emailRes.wouldSend ? [`send ${emailRes.wouldSend} queued recruiter emails (never auto-sent)`] : []),
    ...(pre && pre.updateStatus === 'update-available' ? [`offer career-ops update ${pre.updateLocal} -> ${pre.updateRemote}`] : []),
    ...((wrap && wrap.owed) || []),
  ],
}
