# automations: non-LLM scheduled jobs (systemd timers + a Slack-delivery wrapper)

Plain `systemd --user` timers for work that does **not** need an LLM turn per run. Output goes
to Slack through `hermes send` (the Hermes Slack bot credentials; no gateway, no model call).
Two of these jobs are part of the job search and are staged here; two others (a Google-Health sync
and a daily mailbox digest, both Slack-only and unrelated to applications) are deliberately left
out. The unit files for these jobs are in `../systemd/` (effective units including drop-ins).

```
automations/
  bin/run-job              wrapper: run a command, deliver stdout / failure to Slack
  bin/job-failed           OnFailure= hook: last 20 journal lines -> Slack (1 alert/unit/hour)
  bin/pollers              one-screen status of every timer + every Hermes cron
  jobs/tsenta-nightly/run.sh        Tsenta apply loop launcher (nightly 22:00 + three day slots)
  jobs/warm-outbound/               weekday LinkedIn "warm outbound": run.sh, prompt.md, extract-phase1.mjs, send.mjs
  tests/test_run_job.py             unit tests for run-job (dry-run mode, redaction, usage errors)
  install.sh                        symlink unit files into ~/.config/systemd/user + enable timers
```

(The `warm-outbound` unit tests, `test/send.test.mjs`, are about 15 KB and not staged; they inject a
fake LinkedIn tool and a fake outreach log into `runWarmOutbound()`, so each guard below is testable
with no network.)

## `bin/run-job <job-name> <deliver-target> -- <command...>`

* Runs the command with stdout and stderr captured separately, then echoes both into the unit's own
  stdout/stderr so `journalctl` has the whole run.
* Exit != 0: `hermes send -t <target> -s "<job> failed (exit N) on <HOME_SERVER>" -f -` with the **last 25
  lines** of combined output, passed through a bounded secret scrub (bearer-style tokens, `token=...`,
  `Authorization:`, `X-API-KEY:`). Not a real secret scanner; swap in gitleaks if one ever leaks.
* Exit 0 and empty stdout: **sends nothing**. A job is silent unless it has something to say.
* Exit 0 and non-empty stdout: stdout is the Slack message (via stdin, never argv).
* If the Slack send itself fails the wrapper exits non-zero so systemd records it.
* `RUN_JOB_DRY_RUN=1 run-job ...` prints what would be sent instead of calling `hermes send`.
* Deliberately no `set -e`: the wrapped command's real exit code must survive.

Typical dry run: `RUN_JOB_DRY_RUN=1 ~/automations/bin/run-job demo slack:<SLACK_CHANNEL_ID> -- ./jobs/tsenta-nightly/run.sh`.

## `bin/notify -t <target>[,<target>...] [-s subject]` (no Hermes needed)

A portable sender in plain Python 3 with no dependencies, for Slack, Telegram, Discord, Teams, Google Chat, ntfy, email, Hermes or stdout. The body is read from stdin. Set `RUN_JOB_SENDER=notify` and `run-job` and `job-failed` deliver through it instead of `hermes send`. `<deliver-target>` then becomes a notify target such as `telegram,email`. Channel variables and setup are in [`../docs/notifications.md`](../docs/notifications.md). Run `bin/notify --self-test` to check message splitting.

## `bin/job-failed <unit>` (the `OnFailure=` target)

Posts the failed unit's last 20 journal lines (same scrub) with subject `<unit> failed (<result>)`.
Skipped when `run-job` already alerted for a plain non-zero exit (a timeout or signal kill still
alerts here, because it takes `run-job` down too). Rate limit: one alert per unit per hour, via a
stamp file in `~/.cache/job-failed/`. Target overridable with `JOB_FAILED_TARGET`.

## `jobs/tsenta-nightly/run.sh [slot]`

Launcher for `career-ops/server-scripts/run_tsenta_nightly_direct.py`, the Tsenta auto-apply loop.
`slot` is `0600 | 1100 | 1800 | (empty = nightly)`:

| slot | `TSENTA_RUN_TAG` | `TSENTA_MAX_RUNTIME_MIN` (default) | nominal end |
|---|---|---|---|
| 0600 | `day0600` | 270 | ~10:30 |
| 1100 | `day1100` | 390 | ~17:30 |
| 1800 | `day1800` | 210 | ~21:30 |
| (nightly, 22:00) | `nightly` | 420 (script default) | ~05:00 |

* **One Tsenta run at a time.** `flock -w 5400` on `~/.cache/tsenta-run.lock`: a slot waits up to 90
  minutes for a still-running earlier slot (e.g. its outreach tail) and then exits 0 with a
  "skipped" Slack line, so slots can never double-apply or double-invite.
* The Python process (run with the **Hermes venv's python**, because it imports Hermes' MCP client to
  talk to Tsenta) does the whole job in one go: compute/reuse the **day target** (persisted once per
  local day; later slots only fill the shortfall), apply loop, approve this run's resume reviews,
  run LinkedIn outreach for this run's COMPLETED rows, print report + Slack summary.
* Loop limits (from the script): attempt cap = 3 x target; pool refreshed at most 3 times; poll every
  60 s; stop reasons `target reached | deadline | attempt cap | balance exhausted | candidate pool
  exhausted | in-flight stalled` (stalled = no change for 30 min); outreach subprocess timeout 1 h.
* Target: while a monthly `cycleEnd` is set, `ceil(total_credits / days_left)` with no cap; after
  the cycle, `min(100, ceil(total / days_left))`. On the last day the stock script dumps the entire
  remainder, which is why `TSENTA_TARGET_OVERRIDE` exists.
* Env knobs: `TSENTA_RUN_TAG`, `TSENTA_MAX_RUNTIME_MIN`, `TSENTA_TARGET_OVERRIDE`,
  `TSENTA_SKIP_OUTREACH=1`, `TSENTA_DRY_RUN=1` (writes `reports/tsenta-<tag>-DATE-dryrun.md`,
  applies nothing), `TSENTA_DEADLINE_LOCAL`.
* Outreach step: invites for this run's COMPLETED rows are limited by the **shared LinkedIn invite
  budget** (`get_invite_budget`, cap 35 per run, fallback 10 if the budget cannot be read; skipped
  entirely when the budget is exhausted).
* Safety filters (title/text/company regexes) skip senior/new-grad/intern/contract titles, US
  citizenship or clearance requirements, defense/federal employers, off-profile titles. Details in
  `../hermes/skills/career-ops/tsenta-nightly-quota/`.

## `jobs/warm-outbound/` (weekdays 09:37 `<YOUR_TZ>`)

Two phases, so the LLM never holds a send capability:

**Phase 1, `run.sh` -> `claude -p` (read-only research).**
`claude -p --model sonnet --output-format json --max-turns 60 --no-session-persistence
--permission-mode dontAsk --permission-prompts none --setting-sources user,project
--append-system-prompt-file prompt.md`, under `timeout 1500`, with `env -u ANTHROPIC_API_KEY -u
ANTHROPIC_AUTH_TOKEN` so it bills the Claude subscription. `run.sh` **refuses to start (exit 2)** if any
`ANTHROPIC_*` variable is set in the environment. Tool allow-list: `Read, Grep, Glob, ToolSearch` plus
LinkedIn MCP **read** tools only (`search, search_parameters, get_job, get_post, list_post_comments,
list_user_posts, get_profile, check_contacted`). Explicitly disallowed: shell, edit/write, agents,
workflows, cron/remote triggers, memory writes, and every LinkedIn write tool (`send_invitation`,
`send_message`, `start_chat`, `comment_on_post`, `react_to_post`, `create_post`, `sync_applications`).
Inputs in the user message: `TARGET_COUNT` (= `WARM_OUTBOUND_DAILY_CAP`, default 8) and
`MAX_DATA_CALLS` (`WARM_OUTBOUND_MAX_DATA_CALLS`, default 40) which the model must count itself.
Strategy (`prompt.md`): LinkedIn *post* search does not work through Unipile (0-1 results), so start
from **job postings** (`category: jobs`) and read each posting's `hiring_team` (present on roughly
1 in 8) as the warmest contact; otherwise a recruiter/TA/sourcer at the hiring company. Output is one
fenced JSON block of candidates, each with a 20-300 char plain-text note. `extract-phase1.mjs` pulls
that block out of the CLI's JSON envelope, validates it has a `candidates` array, and
`run.sh` keeps a copy at `data/warm-outbound/YYYY-MM-DD-phase1.json`. Stderr is teed to
`jobs/warm-outbound/logs/YYYY-MM-DD.err` so a failed run is diagnosable.

**Phase 2, `send.mjs` (deterministic Node, no LLM).** Defaults to dry run
(`WARM_OUTBOUND_DRY_RUN` unset = `1`); the unit sets `0`. If live mode is requested but the MCP's
`send_invitation` does not answer it drops to dry run instead of failing every candidate. For each
candidate, in order, any failure holds the candidate with a reason code and the loop continues:

1. **Note** (`note_*`): present, no resume employer named (`note_past_employer`), 20-300 chars, no
   `{{`/`[name]`/`todo`, no URL, no email or phone.
2. Identifier (`public_id` / `provider_id` / tail of the profile URL).
3. `get_profile`: found; not already 1st degree (`already_connected`); headline matches the
   recruiter/hiring-manager/founder title regex (`wrong_title`); `employer_from_headline` loosely
   matches the candidate's company (`employer_mismatch`).
4. `check_contacted` (a failed check = unknown = hold, `contacted_check_failed`; contacted = `already_contacted`).
5. `get_invite_budget`: `remainingToday <= 0` stops the batch (`shared_budget_exhausted`).
6. `send_invitation(..., origin="superagnt-warm-outbound")`. A refusal with `scope` other than
   `person` stops the batch (`global_refusal`).

Caps: this job's own `WARM_OUTBOUND_DAILY_CAP` (8, counting today's earlier `superagnt-warm-outbound`
events in `outreach_log.json`) **and** a shared-pool allowance: `min(remainingToday - 10 reserved for the
11:00 recruiter cron, floor(remainingThisWeek / 3))`. An unreadable budget allows nothing. Output:
a Slack-ready markdown summary on stdout (Sent / Held with reasons) plus an appended
`reports/warm-outbound-YYYY-MM-DD.md`. Exit 0 even when nothing was sent. The only source of
playbook ideas is a third-party "warm outbound" skill pack read as plain files; none of its paid tools
are used (discovery runs on the user's own LinkedIn Premium seat through the MCP).

## Not staged

* `jobs/health-sync` (Google Health sync, 05:45 and 17:45, Slack only on failure) and
  a daily job-mailbox Slack digest (06:00, deterministic formatter, no LLM): mailbox plumbing, not part of
  the apply/outreach flow.
* Logs (`jobs/*/logs/`), `.pytest_cache`, `*.pre-*` backups.

## Adding a job

1. `mkdir jobs/<name>` with a `run.sh` entrypoint (stdout = the Slack message; empty = stay silent;
   non-zero = failure alert).
2. Copy a `.service`/`.timer` pair, change name/WorkingDirectory/ExecStart/OnCalendar, add the
   `10-poller.conf` `OnFailure=job-failed@...` drop-in.
3. `bash -n` the scripts, `systemd-analyze --user verify`, test with `RUN_JOB_DRY_RUN=1`, then `install.sh`.

## Logs and manual runs

```bash
journalctl --user -u tsenta-nightly.service -u 'tsenta-slot@*.service' -u warm-outbound.service
systemctl --user start warm-outbound.service        # run once now (sends for real when DRY_RUN=0)
WARM_OUTBOUND_DRY_RUN=1 jobs/warm-outbound/run.sh   # phase 1 for real, phase 2 dry
```
