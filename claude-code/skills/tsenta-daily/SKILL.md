---
name: tsenta-daily
description: Daily quality-gated auto-apply routine via the tsenta/AutoJobs connector. Pulls fresh (<=2 day) entry/mid AI-ML jobs from tsenta's recommendation feed, then runs the real career-ops evaluation on each full JD and auto-applies ONLY to genuine >=4.0 fits with an optimized resume (jobId path), mirrors results to the career-ops dashboard. Session-triggered (the tsenta MCP is not reachable in headless cron). Apply-only; no outreach. Run it each morning.
---

# tsenta-daily

Session-triggered daily routine. Applies to a small, quality-gated set of fresh AI/ML jobs
through the **tsenta/AutoJobs** MCP, with an **optimized resume per job**, and syncs the count to
the career-ops dashboard as **🅣 Tsenta apps** beside **🅝 Agency apps**.

## Design decisions (locked by the user 2026-07-13; eval-gate added 2026-07-15)
- **MCP Python pitfall (2026-08-21).** When launching MCP-backed Tsenta scripts from Hermes `terminal(background=true)`, use the Hermes venv Python explicitly (`/home/<SERVER_USER>/.hermes/hermes-agent/venv/bin/python3 ...`). The background shell PATH may not include the Hermes venv, and plain `python3` can make `discover_mcp_tools()` return zero Tsenta tools even when foreground commands work.
- **Career-ops-eval-gated (>=4.0 only).** `matchScore` is just a coarse shortlist prefilter — the real
  apply decision is the full career-ops evaluation on the JD (Step 3.5). Only jobs scoring >=4.0 get
  applied, so tsenta lands "more perfect roles" instead of spraying everything tsenta recommends.
- **Quality-gated (~2-6/day), NOT 50/day.** After the eval gate the survivors are few. Do not spray to
  fill the 1500/mo plan. Honest fit over volume; zero survivors on a given day is a valid outcome.
- **Session-triggered.** The tsenta connector is interactive-auth; a headless cron cannot reach it.
  Run this inside an interactive Claude session (the user opens one each morning).
- **Apply-only. No outreach.** tsenta has no outreach feature (only a reply inbox). LinkedIn outreach
  stays in the career-ops path (Unipile/Codex), separate from this routine.

## Steps

### 1. Preflight
- `get-application-balance` -> confirm `total` remaining > 0.
- `get-profile-status` -> `missingForApplication` must be empty. Note `applyPreferences`.

### 2. Pull candidates (tsenta's own feed)
`get-job-recommendations` with:
`{ autoApplyOnly:true, jobTypes:["ENTRY_LEVEL","MID_LEVEL"], locations:["country:US"], datePosted:"7d", limit:50 }`
Paginate via `hasMore` (`page:2`, `page:3`) up to ~3 pages. Optionally a 2nd pull with `search:"machine learning"`.
Recommendations already exclude jobs you've applied to or skipped.
NOTE: output is large -> it auto-saves to a `tool-results/*.txt` file; parse that file in `ctx_execute`, do not read it raw.

### 3. Cheap pre-filter -> SHORTLIST (parse in ctx_execute; dedup by job id)
This is only a coarse shortlist. **The real apply decision is the career-ops eval in Step 3.5.** Keep a job for the shortlist if ALL hold:
- `datePosted` <= **2 days** ago (fresh)
- `isSupportedAts == true`
- `seniorityLevel` NOT in {Senior, Lead, Staff, Principal, Director}
- title matches ML/AI/DS (machine learning, ml/ai engineer, applied ai, data scien, deep learning,
  nlp, llm, gen ai, mlops, recommendation, applied scien) AND NOT (field application, sales, account,
  support engineer, solutions architect, manager, director, intern, temporary, contract, + any senior token)
- `matchScore >= 60` (loose — tsenta's title-vector score is a coarse prefilter, NOT the apply gate; it over-selects, so let the real eval decide)
Cap the shortlist at **~25** (highest matchScore first) to bound eval cost.

### 3.5. Career-ops evaluation gate — THE apply gate (added 2026-07-15)
Do NOT apply on `matchScore` alone — it over-selects mediocre roles. Instead run the real career-ops
evaluation on the full JD and only auto-apply to genuine >=4.0 fits ("more perfect roles"):
1. `get-jobs-by-ids` (batch, `descriptionMaxChars: 8000`) to pull the **full JD** for every shortlisted job.
2. **Status-bar grep** each JD for `F-1|OPT|CPT|EAD|citizen|clearance|ITAR|export control|US person`.
   A clause barring the candidate's current status (US-citizen-only / clearance / ITAR) -> hard SKIP.
   Do NOT penalize a role for merely lacking H-1B sponsorship (standing user override).
3. **Evaluate each surviving JD with the career-ops rubric** — the same scoring the `oferta` /
   auto-pipeline mode and reports use (score 0.0-5.0 against `cv-aiml.md`, `article-digest.md`,
   `config/profile.yml`, `modes/_profile.md`, `modes/_shared.md`, `modes/oferta.md`). For more than
   ~8 shortlisted jobs, **fan out with the Workflow tool** (one agent per JD, returning structured
   `{score, decision, statusBar}`) so the gate stays fast. Honest ceiling ~4.4; never inflate to hit a quota.
4. **Keep ONLY jobs scoring `>= 4.0` with no status bar** — that is the apply set. Everything `< 4.0`
   is logged, not applied (quality over volume; expect ~2-6 survivors/day, sometimes 0).
   Reserve report numbers (`node reserve-report-num.mjs --count N`) and write a career-ops report +
   tracker TSV for each >=4.0 job, then `node merge-tracker.mjs`.

### 4. Apply (optimized) — ONLY the >=4.0 survivors
`apply-to-job` with `jobIds:[...]` (batch of the Step 3.5 survivors only). **Applying by jobId carries the
JD -> the optimizer runs -> `isOptimized:true`.** NEVER apply by `url` without also passing `jobDescription`
(from `fetch-job-description`) or the resume ships un-optimized (see memory `tsenta-apply-requires-jobdescription`).
If Step 3.5 yields zero >=4.0 jobs, apply to nothing and report that honestly.
**Email identity (2026-10-03):** the default tsenta profile now carries `<YOUR_EMAIL>`. Before applying,
run `node lib/outreach-email.mjs identity "<Company>"` (in <CAREER_OPS_DIR>) per survivor. If it returns a
`tsenta_resume_profile_id`, the company already has an application under `<YOUR_EMAIL>`: apply that job in
its own `apply-to-job` call with `resumeProfileId` set to it (the "Legacy legacymail" profile) so no duplicate ATS
profile is created. Otherwise omit `resumeProfileId`. Note `email=contact@` / `email=legacymail` in the tracker row.

### 5. Approve + verify
- Poll `get-application-status` for each `applicationId`. Confirm `isOptimized:true`.
- If a job parks at `PENDING_RESUME_REVIEW`, `approve-application` (HONEST mode is a factual rewrite).
  Spot-check one `optimizedProfile`/`resumePdfUrl` per run for fabrication (career-ops integrity rule);
  most runs auto-advance to RUNNING without needing approval.
- Poll to terminal. `COMPLETED` = submitted. `FAILED (UNKNOWN)` cannot be auto-retried (tsenta then
  returns "already applied") -> log it, move on.

### 6. Sync the dashboard
Paginate `list-applications({filter:"all", limit:100, page:N})` through every returned page, then regenerate **`data/tsenta-apps.json`** from the full application history:
`{ updated, summary:{total,submitted,failed,in_flight,today,optimized}, apps:[{appId,company,title,atsType,status,optimized,appliedAt,url}] }`
Do **not** mirror only page 1 / 100 rows: the Submission Trend chart buckets `apps[]`, so a 100-row partial window makes older Tsenta days disappear and undercounts the 30-day chart. Use the API's `counts` object for lifetime summary totals when present, and treat `useOptimizedResume` as an optimized-resume truthy flag in addition to `optimized` / `isOptimized`.
The webapp reads the JSON data live via `/api/tsenta-applications` and `/api/agency-applications` (bind-mounted data; no rebuild needed for data-only refresh).

**Nightly mirror/date pitfall (2026-08-31).** When the cron agent submits through native MCP calls instead of `run_tsenta_nightly_direct.py`, it can successfully create applications but leave `data/tsenta-apps.json` stale. Always finish by paginating `list-applications` and regenerating the mirror, then verify `/api/agency-applications.dailyCountsTsenta`. Also note that the current webapp's `loadTsentaDailyCounts()` uses `appliedAt.slice(0,10)`, which buckets in UTC: a 10:00 PM America/Chicago run appears under the next UTC date. Until the server is changed to Chicago-date bucketing, distinguish the chart's UTC day from the run's local day when auditing declines.

### 7. Tracker (only jobs that match a career-ops report)
For an applied job that maps to an existing report/company, mark it Applied:
`node set-status.mjs <Company> Applied --note "via tsenta ..."`. **Mark by COMPANY name and verify the
resolved `#NNN Company — Role` line** — report-file# != tracker row# (see memory `set-status-tracker-number-drift`).
Feed jobs with no career-ops report are tracked only in tsenta-apps.json; do not invent report rows.

## Guardrails
- **Apply gate = career-ops eval >=4.0, not `matchScore`.** Never apply to a job that hasn't cleared the
  Step 3.5 evaluation on its full JD. `matchScore` alone is banned as an apply criterion.
- Quality only. No Senior/Lead/Staff. No older-than-2-day backfill unless the user explicitly asks.
- Optimized resume mandatory (jobId path). Verify `isOptimized:true` before trusting the resume.
- Never submit outside the gate. Never fabricate (HONEST mode reframes, never invents).
- Report a one-line tally: `N applied (optimized), M completed, K failed, balance X`.

## Nightly quota-balancing cron exception (2026-08-25)
A separate user-authorized 10:00 PM America/Chicago cron may intentionally balance the remaining monthly quota and then run Unipile outreach. This is an explicit exception to the session-triggered, apply-only workflow above. It uses `<CAREER_OPS_DIR>/scripts/run_tsenta_nightly_direct.py` with the Hermes venv Python and `<CAREER_OPS_DIR>/scripts/tsenta_unipile_outreach.py`.

Recovery pitfall: `apply-to-job` may time out after partially creating applications and then trip the MCP circuit breaker. Do not rerun applications blindly. Wait for the stated backoff, call `list-applications`, filter rows at/after the recorded `run_started_at_utc`, save those live rows as ground truth, and outreach only rows whose live `status` is exactly `COMPLETED`. Persist the pre-submit timestamp before the first apply call so exact recovery is possible.

**Late-completion reconciliation:** The nightly runner's bounded initial poll can leave many rows in `RUNNING`, `READY`, or `OPTIMIZING_RESUME` while the first Unipile pass is working. After that pass finishes, call `list-applications` again, replace the nightly applications artifact with the live rows from the same `run_started_at_utc`, and run a second idempotent outreach pass for newly `COMPLETED` rows. Set the second pass `--max-send` to `35 - <HTTP-201 sends already made tonight>` so the cumulative nightly total cannot exceed 35. Save the second pass to a distinct `*-reconcile.json`, treat first-pass contacts as `already in outreach_log`, and report unique final outcomes rather than summing duplicate skips across both passes.

## Reference (first run, 2026-07-13)
Gate over 86 recommendations -> 5 passed: <TARGET_COMPANY> AI Engineer, <TARGET_COMPANY> AI Engineer (FDE),
<TARGET_COMPANY> AI/ML Engineer II, <TARGET_COMPANY> Web Apps AI Engineer (LLM), <TARGET_COMPANY> Gen AI. All `isOptimized:true`.
