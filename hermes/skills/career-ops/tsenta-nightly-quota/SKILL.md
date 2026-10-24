---
name: tsenta-nightly-quota
description: Use when Tsenta quota-balancing or a new monthly cycle starts.
---

# tsenta-nightly-quota

User-authorized exception to the morning `tsenta-daily` quality gate. Goal is to even-pace remaining credits until live `monthly.cycleEnd` (do not hardcode the 13th), then Unipile-outreach only `COMPLETED` rows under the invite cap.

**Pack credits do not expire at `monthly.cycleEnd`.** Tsenta credit packs are lifetime (`pack.remaining` / `pack.lifetime`). Monthly unused resets at cycle end; pack sits until used. Pack-only accounts report `monthly.remaining=0` and `cycleEnd=null` (the nightly script already notes this and must not treat null cycleEnd as “dump everything today”). “Will these expire?” → read buckets first. Answer **no** for leftover pack. Job listings expire (`JOB_EXPIRED`); parked resume-review rows do not vanish at cycleEnd. A 3:34 PM CDT dump deadline is a workflow choice, not a pack burn — do not tell him leftover pack credits die today.

**Cycle drain override:**
- Locked 2026-09-09: do **not** pause the 10pm job; spend remaining **monthly** balance before `monthly.cycleEnd` when that field is set. Midday catch-up cron `<CRON_JOB_ID>` (1pm CT Sep 10–13) exists because expired/captcha skips refund. Do not apply <COMPANY_F>/<COMPANY_V>/defense to fill volume. Pack leftover is optional drain, not an expiry race.
- **Superseded 2026-09-12** when <YOUR_NAME> said complete remaining pack credits **across these two days** (~296 Sat+Sun). Stock `run_tsenta_nightly_direct.py` on `drain_days<=1` **sets today = entire remaining** and would dump all 296 Saturday. Do **not** fire it as-is. Split via env: `TSENTA_TARGET_OVERRIDE=<half>`, `TSENTA_RUN_TAG=<wave>`, `TSENTA_SKIP_OUTREACH=1` on afternoon waves. Update 10pm (`<CRON_JOB_ID>`) so it only fills today’s shortfall (or this-run resume reviews + outreach) — never a second full dump. Sunday 10pm is **after** the old monthly cycleEnd; leftover dump is Sunday **1pm**. Half is a **cap**, not a promise (thin US feed yielded 22 then 11). Follow `references/two-day-credit-split.md`.

**“how far it came” / “how far”** after a dump recap = live tally only (`get_application_balance` + this-cutoff COMPLETED / needs / failed / skipped). Do **not** restart the dump unless he says continue / dump / approve.

**Where the nightly actually runs.** The Hermes cron `<CRON_JOB_ID>` can be paused (e.g. provider credits) while the real 10 PM run continues via systemd user timer `tsenta-nightly.timer` → `/home/<YOU>/automations/jobs/tsenta-nightly/run.sh` → `run_tsenta_nightly_direct.py`. Check `systemctl --user list-timers | grep tsenta` before declaring the nightly dead. Ground truth per night: `reports/tsenta-nightly-YYYY-MM-DD.md` + `data/tsenta-applications-YYYY-MM-DD-nightly.json` (fields `target_today`, `pool_size`, `stop_reason`, `filter skip counts`).

**Daytime slots (added 2026-10-02).** Same script also fires at 06:00 / 11:00 / 18:00 CT via `tsenta-slot@0600|1100|1800.timer` → `tsenta-slot@.service` → `run.sh <slot>` (tags `day0600`/`day1100`/`day1800`, runtime caps 270/390/210 min, deliver Slack cron-jobs). All slots + 10pm share one persisted day target and a `flock` on `~/.cache/tsenta-run.lock` (waits ≤90 min, then skips). Later slots fill only the shortfall; a slot report saying `successes_today >= target` with 0 attempts is expected, not a failure. Backup of the old wrapper: `run.sh.bak-20261002`.

**"Balance looks too high" = audit pool starvation first.** Submissions usually work; the shortfall is `pool_size` ≪ `target_today` (stop_reason `candidate pool exhausted` / `in-flight stalled`). Read the report's filter-skip counts, then diagnose read-only before touching filters: call `T.source_pool(T.build_pulls())` + `T.fetch_details()` from a script (`import run_tsenta_nightly_direct as T`), and for each reject record the matched pattern text and which job field held it. Do not assume a big `citizenship/clearance` bucket is a false positive — on a real audit nearly all hits were genuine JD requirements (TS/SCI, USC/GC only, active clearance); only license-allowing export-control boilerplate (<COMPANY_AG>/<COMPANY_P>-style) was debatable. The usual root cause is **feed exhaustion**: recommendations hide already-applied jobs, so after thousands of applies the entry/mid US auto-apply feed yields ~10–20 eligible/night regardless of query tweaks. Say so plainly and propose an off-feed source (see “Curated list → Tsenta bulk apply”) rather than loosening safety filters.

**Title queries + relevance gate.** `build_pulls` searches `PROFILE_TITLE_QUERIES` (profile target titles: ML/AI/applied/recsys/ranking/LLM/RAG/agents/MLOps/FDE/backend/data/SWE II/early career). Adding titles widens the raw pool a lot but eligible only slightly, because Tsenta keyword-matches off-profile jobs (paralegal, legal counsel, iOS, clinical). Keep the relevance gate **title-based** (`AI_TERMS`/`SWE_TITLE` on title, plus `OFF_PROFILE_TITLE` block) — an AI mention in the description alone lets legal/clinical jobs through. Validate any filter edit with `TSENTA_DRY_RUN=1 TSENTA_RUN_TAG=<tag> TSENTA_SKIP_OUTREACH=1` (writes `reports/tsenta-<tag>-DATE-dryrun.md`, applies nothing). When patching regexes via a Python heredoc, check the written line: doubled `\\b` becomes a literal backslash and silently never matches. `tests/test_tsenta_nightly_loop.py` has deadline-based stop_reason assertions that fail on the unmodified script too — compare against the backup before blaming your edit.

Overlaps user-owned `tsenta-daily` (`~/.agents/skills`). Prefer this skill for the 10pm run, “new day new cycle”, and any “complete today’s goal” follow-up in a Tsenta nightly thread. Those phrases are **not** career-ops `pipeline` mode. Recommend `hermes curator adopt tsenta-daily` so both live in one place.

## When <YOUR_NAME> says “new day new cycle”

First morning after monthly refresh — **even-pace, not a dump**, and not the `tsenta-daily` ~2–6 quality gate.

1. Preflight live `get_application_balance`. Fingerprint production (~3000 apps, monthly 1500 + leftover pack). Use `monthly.cycleStart` / `cycleEnd`; do not assume the 13th.
2. Today’s target = `ceil(total / days_until_cycleEnd_date)`. Pack leftover is in `total` and spends evenly; it does not expire. Do **not** dump.
3. Start today’s share now (`TSENTA_RUN_TAG=cycle-day1`, Hermes venv Python). Do not wait for 10pm.
4. `TSENTA_SKIP_OUTREACH=1` if the morning recruiter cron already ran or rolling 24h Unipile 201s are near ~35–40.
5. Stock `run_tsenta_nightly_direct.py` subtracts same-calendar-day `attempted_job_ids` from `target_today`, so 10pm fills shortfall only.
6. Leave <COMPANY_B>/old parked queue alone. Do not push submit-review unless he says so.

While `now < monthly.cycleEnd`, the script’s drain branch is **on for the whole cycle**: target = `ceil(total/days_left)` with **no 100 cap**. The `min(100, …)` branch only runs after cycleEnd. `drain_days<=1` still dumps everything — do not fire stock on the last day.

Details: `references/new-cycle-even-pace.md`.

Scripts (Hermes venv Python: `/home/<YOU>/.hermes/hermes-agent/venv/bin/python3`):
- `/home/<YOU>/career-ops/scripts/run_tsenta_nightly_direct.py` — env: `TSENTA_TARGET_OVERRIDE` (caps today; blocks last-day full dump), `TSENTA_RUN_TAG` (output suffix, default `nightly`), `TSENTA_SKIP_OUTREACH=1`
- `/home/<YOU>/career-ops/scripts/tsenta_unipile_outreach.py`
- `/home/<YOU>/career-ops/scripts/tsenta_approve_tonight.py` — **do not use for submit-review**; it blob-greps “us citizen” and skips honest <VISA_TYPE> forms. Use answer-based `decide_submit` (see makeup continue scripts / below).
- `/home/<YOU>/career-ops/scripts/tsenta_refresh_dashboard.py`
- `/home/<YOU>/career-ops/scripts/tsenta_finalize_current_run.py` — resume-approve + submit-review by cutoff; still too label-aggressive on citizen/ITAR **questions**. Prefer answer-based decide_submit.

## When <YOUR_NAME> says “N in flight” / “are those done?”

He often means the last recap’s **parked** count, not `filter=in_flight`.

Live Tsenta buckets (do not trust a stale `data/tsenta-apps.json` summary):
- `needs` / dashboard `needs_approval` = `PENDING_RESUME_REVIEW` + `PENDING_SUBMIT_REVIEW` (forms filled, **not submitted**)
- `in_flight` = `READY` / `RUNNING` / `OPTIMIZING_*` (idle `READY` + `jobStatus=FAILED` is dead — do not approve)
- Done = live `status=COMPLETED` only

A 10pm HONEST run commonly parks almost every new row at `PENDING_SUBMIT_REVIEW`. If he quotes N and the dashboard shows `needs_approval: N`, those are **not done**. Poll live `list-applications(filter=needs)` and `filter=in_flight`, split tonight (`createdAt` >= 10pm CT) vs old <COMPANY_B>/<COMPANY_AK>/<COMPANY_AE>/<COMPANY_AJ>, and report that split. Do not start submit-review until he says yes.

**“yes”** after that recap = push **tonight’s** submit-reviews only (leave <COMPANY_B> queue). **“yes and also complete today’s target”** = that plus the remaining apply gap. Same calendar night after 10pm is still tonight’s target.

**“approve these and send these”** / **“send these”** after a recap that quotes **Parked this run (`PENDING_SUBMIT_REVIEW`) | N** (midday drain or 10pm) = push **that run’s** N submit-reviews only (`createdAt` >= that run’s cutoff). Leave the leftover <COMPANY_B> / <COMPANY_AE> / <COMPANY_AF> / <COMPANY_AH> / <COMPANY_AI> queue alone. **Send = `submit-application-review`**, not Unipile. Do not start another apply wave and do not rerun `run_tsenta_nightly_direct.py`. Honest edits only (sponsorship Yes if the worker filled No). First-round approve often completes some immediately and leaves the rest `RUNNING` — poll live status; do not recount those N as still parked.

**“approve them” / “approve all those N”** after you listed leftover `needs` (including <COMPANY_B> / <COMPANY_AK> / <COMPANY_AE> / <COMPANY_AJ>) = push **all current `filter=needs`**. That overrides the default leave-parked rule. Still reject a form that requires a lie (citizenship, clearance, empty required middle name, actual Spanish *fluency*). Do not re-apply a row you just `REVIEW_REJECTED`.

**“continue until you reach the goal”** / “keep going until 186” in this thread = live `COMPLETED` since the 10pm CT cutoff, **not** apply-attempts. Do not rerun `run_tsenta_nightly_direct.py`. Loop HONEST batches + submit-review until that completed count hits the target or the safe US auto-apply feed is empty. Report attempted vs completed vs skipped vs remaining.

Before submitting a parked row, reject+refund on **title** if it is 2027 / new-grad / PhD / fellowship / unpaid / volunteer / intern. As of 2026-09-11, `run_tsenta_nightly_direct.py` and `tsenta_unipile_outreach.py` block these plus student/cohort/visiting/mechanical/recruiting/university-program titles and Penn State ARL; keep this pre-submit check as a backstop.

## When <YOUR_NAME> says “start N applications today”

Treat this as a **one-off N-attempt batch**, not a request to recompute the nightly cycle-drain target and not a promise of N completed submissions.

1. Preflight `get_application_balance`, `get_profile_status`, `get_apply_preferences`, plus live `needs` and `in_flight`. Confirm profile completeness and preserve a new UTC cutoff before creating rows.
2. Select up to N new safe US entry/mid auto-apply jobs; keep the full-JD status-bar, title, seniority, and defense filters. Deduplicate against current/previous-run job IDs.
3. Apply by `jobIds` using `HONEST`; approve only `PENDING_RESUME_REVIEW` rows created at or after this batch cutoff (including null-`jobId` fresh rows matched by saved URL/company/title).
4. Do **not** send Unipile outreach and do **not** push `PENDING_SUBMIT_REVIEW` applications unless <YOUR_NAME> separately tells you to send/approve them after form review. Leave older pending rows untouched.
5. Verify via live `list-applications` and balance readback; report attempts, statuses, and post-run balance. State plainly that parked submit-reviews are not submitted.

## When <YOUR_NAME> says “complete these N in these two days”

N is remaining **credits** (`get_application_balance.total`), not a completed-count target.

Do **not** run stock `run_tsenta_nightly_direct.py` when `days_left<=1` — it dumps all N today. Do **not** pause 10pm.

1. Lock `cycleEnd`. Last dump = last midday job **before** cycleEnd (if 10pm is after cycleEnd, it cannot dump).
2. Today’s ceiling = `ceil(N/2)` via `TSENTA_TARGET_OVERRIDE`, `TSENTA_RUN_TAG`, `TSENTA_SKIP_OUTREACH=1` for extra afternoon waves. Stamp cutoff before apply. Dedupe `jobId` from `data/tsenta-applications-{TODAY}-*.json`.
3. Update tonight’s 10pm prompt: if today already hit the half-cap, only this-run resume reviews + outreach; else fill toward the cap only.
4. After each wave, re-query `filter=needs` for this cutoff. The script footer can say `completed: 0` / `in-flight: N` while those rows are `PENDING_RESUME_REVIEW` — approve this-run resumes, leave <COMPANY_B> parked.
5. Thin-feed is allowed to undershoot the cap. Report attempted vs cap.

See `references/two-day-credit-split.md`.

## When <YOUR_NAME> says “complete the goal for today”

In the job-hunt Tsenta nightly thread this means **finish tonight’s apply target**.

1. Same-calendar-day reruns of `run_tsenta_nightly_direct.py` subtract already-attempted job IDs from `target_today` (`data/tsenta-applications-{TODAY}-*.json`). After a morning `cycle-day1` run, 10pm fills shortfall only — do not also set `TSENTA_TARGET_OVERRIDE` to a second full target. Still do not fire stock when `drain_days<=1` (that path dumps remaining).
2. If the gap is **submit-review / completed-count** rather than applies, do not rerun the stock script. Persist a continuation cutoff and finish parked rows from this cutoff. Apply gap = even-pace target minus today’s `attempted_job_ids` count (not dashboard submitted).
3. Dedup by job id against tonight’s attempted ids. Recommendations already exclude applied/skipped, but expired-listing backfill still returns stale cards.

## When <YOUR_NAME> says “complete that N skipped” / “how many completed yesterday”

In a job-hunt Tsenta thread, **completed** means live `status=COMPLETED` (submitted), not attempted rows and not LinkedIn outreach.

**Count yesterday from live Tsenta, <YOUR_CITY> time.** After any re-login, fingerprint the user first (`hermes-mcp-troubleshooting` / `references/oauth-account-identity.md`): production has ~3000 apps and pack credits in the hundreds; a fresh AutoJobs user is 0 apps / 25 free / onboarding incomplete — do not report yesterday as 0 from that account. `hermes mcp list` `✓ enabled` is config-only; prove with `hermes mcp test tsenta`. `list-applications(filter=submitted)` newest-first; convert `createdAt` to <YOUR_TZ>. A 10pm CT run has UTC `createdAt` on the next calendar day. Do **not** trust `data/tsenta-apps.json` alone — the dashboard mirror can be hours stale (a 1:30pm CT file will miss the 10pm run). Nightly snapshot JSON is a point-in-time; re-check in-flight IDs because captcha rows often flip SKIPPED after the recap. A morning snapshot can miss late completions the same <YOUR_CITY> day (2026-09-11: 57 at 5:40am CDT snapshot vs 62 live after old-account login).

**Do not retry the skipped rows.** `JOB_EXPIRED` / `JOB_CLOSED` / `CAPTCHA_*` / `MANUAL_APPLY_REQUIRED` cannot be finished. `REVIEW_REJECTED` may show `canReapply: true` but was rejected for a reason — do not blindly re-apply (often senior titles or status-bar).

**Makeup = N replacement applies, not another nightly 100, and not spray-until-N-completed.**
1. Do **not** rerun `run_tsenta_nightly_direct.py` (it will target another ~100).
2. Persist a new `run_started_at_utc` before the first extra `apply-to-job`. Exclude last night’s `jobId`s.
3. Attempt **N** new HONEST `jobIds` batches (10–20). Push resume + submit review for **this cutoff only**. Leave the old <COMPANY_B> queue alone.
4. Stop after those N attempts unless <YOUR_NAME> explicitly says keep going until N **completed** (“Yes go on” after you offered a completed-target wave counts). Then count live `COMPLETED` with `createdAt >= makeup cutoff`, not attempts and not <YOUR_CITY>-today. Retry MCP 3–4 times; after a script crash, recount and recover this cutoff’s reviews — do not re-apply the same ids.
5. Report attempted vs completed vs skipped/failed vs still running, plus balance before/after. Ask before a second wave unless he already said keep going to N completed.

See `references/skipped-row-makeup.md`.
See `references/two-day-credit-split.md` for splitting remaining credits across the last two days of a cycle.

## Thin-feed recovery

The stock nightly pulls (`7d` + `roleFamilies` SWE/DS + `maxYearsExperience: 5`) can return ~16 eligible US auto-apply jobs. If that happens and the user wants the cap filled:

- Keep `autoApplyOnly: true`, `locations: ["country:US"]`, `jobTypes: [ENTRY_LEVEL, MID_LEVEL]`.
- Broaden `datePosted` to `14d` / `30d` / `all` and paginate `hasMore`. Drop `maxYearsExperience` and `roleFamilies` if still short.
- Extra `search:` combined with the tight filters often returns `FILTERS_NARROW` — loosen filters first, then search.
- Still hard-skip on **title** (do not let a JD that mentions AI rescue a bad title): senior/sr/lead/staff/principal/director/manager/architect/intern/PhD/SMTS/LMTS; recruiting/recruiter/talent acquisition; student/fellow/visiting/cohort; mechanical; sales/account/support; contract/temporary; `secret clearance` / clearance-in-title; LATAM/non-US in the title; **2027 / new grad / unpaid / volunteer / fellowship** (blocked in the nightly and outreach scripts as of 2026-09-11; still verify at submit-review). Defense/federal companies (<COMPANY_F>, <COMPANY_V>, <COMPANY_K> Nevada, <COMPANY_T>, <COMPANY_U>, <COMPANY_J>, Booz, <COMPANY_H>, CACI, SAIC, SpaceX, Credence, <PAST_EMPLOYER_2> Federal, RTX, IDT). Keep that full list in any continuation-script regex — a shortened copy will apply <COMPANY_F>/<COMPANY_V>. `JOB_EXPIRED` is common on `datePosted: all` — expect refunds, not completions. Do not treat `software engineer`/`backend`/`full stack` in the JD as enough if the title is recruiting, student, or mechanical.
- Volume-drain title fallback (2026-09-12): if AI/ML-only starves far below a remaining-credit cap, extra `search` pages (`page=4+`) and extra queries (`data scientist`) are allowed. Accept a US role whose **title** matches SWE/data even when the JD is not AI-heavy. Still skip citizenship/clearance/export-control, defense primes, and junk (`fleet`, `GTM`, `postdoc`, `campus`, `interview on`). `BAD_TITLE` is title-only — also reject a company name containing `campus` (<COMPANY_AB> Campus is not a safe fill). `BAD_TITLE` must be **case-insensitive** — literal `manager` misses `Managers`.
- Fetch JDs (`get-jobs-by-ids`, batches of 20) and skip citizenship/clearance/ITAR/US-person **in the JD**, not merely those words appearing in a questionnaire.

Apply with `optimizationModeOverride: HONEST` and `jobIds` (not URL-only).

## Curated list → Tsenta bulk apply (URL path)

Also the way to spend credits when the feed is exhausted: pull entry/mid AI/ML/SWE roles straight from company ATS boards (career-ops `portals.yml` + discovered boards) and push them by URL.

When <YOUR_NAME> hands over a list of already-evaluated roles (e.g. career-ops batch roles below 4.0) to "send to bulk apply":
1. Drop hard mismatches first (explicit senior scope, 5+ yrs, GPA-gated new-grad, citizenship/clearance).
2. Canonicalize career-site wrappers to the ATS URL (`company.com/careers?gh_jid=N` → `job-boards.greenhouse.io/<slug>/jobs/N`).
3. `fetch_job_description(url)` each; only `status=success` is appliable (LinkedIn-only and custom career pages return `unsupported`).
4. Persist a UTC cutoff, then `apply_to_job({url, jobDescription, optimizationModeOverride:'HONEST'})` one at a time. `already applied to this job` costs no credit — report separately.
5. Rows park at `PENDING_RESUME_REVIEW` (`autoApproveResume:false`). Spot-read one `get_application_status(include optimizedProfile)` against the `resumeInstructions` never-used list, then `approve_application` each returned id. Poll to `COMPLETED`.
6. `node set-status.mjs <report#> Applied --note "via Tsenta ..."` (back up applications.md first), then `scripts/tsenta_refresh_dashboard.py`.
Call Tsenta tools from scripts via `from run_tsenta_nightly_direct import mcp_call` with the Hermes venv Python.

## SSE timeout is not a failed apply

`apply-to-job` can return `SSE stream ended without a response` after the worker created the rows. Check `get-application-balance` (credit drop) and `list-applications` before retrying. Do not re-apply the same ids.

## HONEST resume review (this is the bottleneck)

`get-apply-preferences` often has `autoApproveResume: false` and `reviewBeforeSubmit: true`. HONEST batches then park at `PENDING_RESUME_REVIEW` (can be 80+).

- `approve-application` takes **one** `applicationId`. Loop it from Hermes venv (`discover_mcp_tools` + registry), not 80 interactive MCP clicks.
- Only approve **tonight’s** rows (`createdAt` >= cutoff). Leave old <COMPANY_B>/`PENDING_SUBMIT_REVIEW` queue alone.
- **Fresh-row null-jobId pitfall (2026-09-10):** `list-applications(filter=needs)` can expose a newly created `PENDING_RESUME_REVIEW` row with `jobId: null`; it is still a real application. Do not use `jobId in attempted_ids` as the sole continuation guard or it will strand those rows. Before applying, persist selected `{url, company, title}` plus the cutoff. Match a fresh row by `jobId` **or** this saved URL/company/title snapshot and `createdAt >= cutoff`; approve only those exact rows. After approval, call `get-application-status` to recover the job ID, then use that ID for later polling/deduplication. Never loosen the cutoff to sweep unrelated rows.
- After approve, poll `filter=needs` + `filter=in_flight`. Do not `approve-application` idle `READY` rows whose `jobStatus` is already `FAILED`.
- After `run_tsenta_nightly_direct.py` exits, do not trust the footer alone. Its bounded poll can report `completed: 0` / `in-flight: N` while live `list-applications(filter=needs)` shows those N as `PENDING_RESUME_REVIEW` from this cutoff (seen 2026-09-12 afternoon-drain2: 11 in-flight in the footer, 11 parked on resume review). Re-query needs, approve **this-run resumes only**, then recount.

## Submit-review: read fields, do not blob-grep

Call `get-application-review` **before** `submit-application-review`.

Do **not** skip just because the form JSON contains “us citizen” / “export control” — that is usually the question text and will skip every honest <VISA_TYPE> form.

Decide from **answers**:
- Reject + refund: ITAR / TSA citizen-or-GC required / employer states <VISA_CLASS> <VISA_EXTENSION> ineligible (<COMPANY_Y>; <COMPANY_X> “does not participate in the <VISA_CLASS> <VISA_EXTENSION> extension program”) / required fields you would have to invent (middle name, current-job end date). <COMPANY_I> forms often have required empty `application.applicant.middleName` — reject and refund; do not invent a middle name. `submit-application-review` can return `{success: true}` while the row stays `PENDING_SUBMIT_REVIEW` (empty required field, or a follow-on <VISA_EXTENSION> attestation that appears after “need assistance = Yes”). Re-get the review and re-poll status; do not count it completed until `status=COMPLETED`.
- Language-skill reject only on fluency questions (`spanish speaking`, `fluent in spanish`, `language proficiency`). **Never** match EEO ethnicity: “Are you Hispanic, Latino, or of Spanish origin?” — the substring `spanish` falsely rejected <COMPANY_B> **AI Quality Assurance Consultant** on 2026-09-09. Skip EEO labels containing `hispanic` / `latino` / `spanish origin` / `ethnicity` / `race`.
- Edit then approve: <VISA_STATUS> **does** need future sponsorship — if the worker filled “Will you require sponsorship? = No”, change it to Yes. Citizenship = non-citizen authorized to work (<VISA_STATUS>), not US citizen.
- Never fabricate US citizenship, clearance, or “no sponsorship needed”.

`OTP_FAILED` (Workday/Oracle) cannot be finished without <YOUR_NAME>’s code — report it, do not retry in a loop.

`submit-application-review` returning `success: false` / `Answer all required fields before submitting` means the row did **not** move. Re-read empty required fields and fill only known facts (laptop=Yes, no relatives=`None`, US-located role=Yes, immigration support=`<VISA_STATUS> now; <VISA_NEED>`). Do not count that call as sent.

Brassring/<COMPANY_B> state selects often echo only the currently selected option (seen: only `California`). An edit to `<YOUR_STATE>` is rejected as an invalid option. Do **not** submit a stale non-<YOUR_CITY> address (<STREET_ADDRESS>) just to clear the queue. Leave those rows parked and say the state list cannot be corrected. Also flip sponsorship `No`→`Yes` only on a submit that also has a correct address.

`FAILED` + `UNKNOWN` after a resume approve is refunded and cannot be retried (`already applied`). `PROFILE_INCOMPLETE`, `JOB_EXPIRED`, and `CAPTCHA_REQUIRED` are the same: report and stop.

## Unipile cap (rolling 24h, not just <YOUR_CITY> midnight)

Nightly `--max-send` remaining = `35 - HTTP-201 already sent this nightly run`.
Daily / rolling cap ~35–40 (LinkedIn soft-blocks above that). Count `data/outreach_log.json` events with `unipile_status == 201` for the last 24h **and** <YOUR_CITY> today. Morning recruiter sends plus nightly 4 can already exceed 40 before continuation. If over cap, skip extra invites and say so. Outreach only live `status == COMPLETED`. One company per script invocation. `outreach_log` de-duplicates profiles, **not companies**: never rerun outreach against the whole run artifact to catch late completions, because it can choose a second contact at an already-outreached company. Build a late-only artifact containing only newly completed application IDs/companies, subtract current rolling-24h HTTP-201 sends from 35, and run outreach only on that subset.

`--apps-json` accepts either native application fields (`applicationId` / `companyName` / `jobTitle` / `createdAt`) or the dashboard mirror's `apps` array (`appId` / `company` / `title` / `appliedAt`). The outreach script normalizes both shapes.

## Dashboard mirror

Always paginate `list-applications({filter:"all", limit:100})` through every page into `data/tsenta-apps.json`. A 10pm CT run buckets as the **next UTC date** in the webapp (`appliedAt.slice(0,10)`). After <YOUR_CITY> midnight, `datetime.now(<YOUR_CITY>).date()` as `summary.today` will be 0 for that run — report <YOUR_CITY>-local night counts separately from the UTC chart.

## Report shape

One tally: attempted tonight, completed, skipped (reason buckets), failed, still running, balance before/after, Unipile 201 tonight vs cap, whether extra outreach was skipped.
