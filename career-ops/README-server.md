# career-ops on the home server: what runs where

These are the **server-side** pieces of the career-ops repo (the version actually running on the
home server `<HOME_SERVER>`, scrubbed). They overlap with the repo copy staged under `career-ops/` by the
Windows-side export; the copies here are what systemd executes, so diff them before publishing and
keep one. Paths below are relative to `career-ops/`.

```
deploy/                        the "operations" layer (systemd units point here)
  unipile-poll.mjs               LinkedIn acceptance/inbound-message poller + guarded auto-reply (5-min timer)
  telegram-control.mjs           Telegram bot: held items, /pause /resume /status /run, /scan /sync /report
  telegram-notify.mjs            one-way Telegram push (4096-char clamp, keeps the tail)
  linkedin-send.mjs              the ONLY outbound LinkedIn path for replies/DMs: via the local LinkedIn MCP (port 42834)
  linkedin-actions.mjs           what a human can do to a queued item from Telegram (send/edit/skip/invite)
  autoreply-guards.mjs           pure functions: "is this text safe to say / safe to trust" (comp, scheduling, SSN, injection...)
  draft-reply.mjs                draft via the local "assist" server (free local models), a STARTING POINT only
  draft-managed.mjs              draft via a Claude Managed Agent (LINKEDIN_DRAFTER=managed), spend-capped per conversation
  job-facts.mjs / posting-facts.mjs   answer "which req?" from LOCAL records, or OPEN the posting a recruiter linked before replying
  outreach-dashboard.mjs/.html   read-only mobile dashboard (basic auth, port 42837)
  agent-run.sh                   headless `claude -p` scan + evaluate run (career-ops-scan.timer, not installed on this box)
  sync-run.sh                    application-mail sync (career-ops-sync.timer, not installed on this box)
  install-systemd.sh, bootstrap-ubuntu.sh, README-deploy.md   original deploy kit
  .env.server.example, dashboard.env.example, .env.example      env variable names + the real operational values

assist/                        deps of deploy/: assist-server.mjs (127.0.0.1:42836), people.mjs, person.mjs, auth.mjs
lib/invite-ledger.mjs          the reconciled invite budget (safeDaily 30/day, safeWeekly 170/week, all senders)
server-scripts/                scripts the units/cron call:
  run_tsenta_nightly_direct.py   Tsenta apply loop (launched by automations/jobs/tsenta-nightly/run.sh)
  tsenta_unipile_outreach.py     LinkedIn outreach for a Tsenta run's COMPLETED rows
  find_recruiter_emails.py       called at the end of the daily recruiter cron: SMTP-verify only, 40 lookups/day
.env.server.example            repo-root .env variable names (Unipile account ids, paid-API keys)
```

Not staged because they belong to the repo core covered elsewhere (or are personal): `linkedin-queue.mjs`
(the on-disk review queue `deploy/` imports), `lib/is-main-module.mjs`, the other `assist/*.mjs`
modules (`ats-fetch`, `bars`, `web`, and what they pull in: `rag`, `evaluate`, `resolve`, ...),
`data/` and `reports/` (state), the CV/profile files, and every `*.pre-*` / `*.bak*` backup.

## Poller behavior to know (`deploy/unipile-poll.mjs`, every 5 minutes)

* Detects invitation acceptances and inbound messages through Unipile list calls (a quiet run is two
  calls), keeps a watermark in `linkedin-poll-state.json` (not staged), and classifies each event:
  `answered` (no draft, no ping) / `ack` (no draft) / `closer` ("not at this time", zero-token template)
  / `cold` (first contact from an unknown person) / `convo` / `referral` (they name a person to contact:
  find them, invite with a note naming the referrer, thank the referrer) / `accepted` (first message
  after acceptance; acceptances still `new` within 72 h are re-picked so a failed run strands nobody).
* **Sends only into existing conversations and only through the LinkedIn MCP** (so the outreach ledger
  stays true); there is no invitation path in the poller except the referral flow, which goes through
  the same MCP and the shared invite budget. Master kill switch: `LINKEDIN_AUTOSEND=1` in `deploy/.env`
  (anything else = draft + Telegram ping only). `--dry-run` writes nothing and notifies nobody.
* Before any send it re-reads the thread: skipped if the user already answered or something newer
  arrived (it redrafts next run). Drafts must pass a relevance check and a sanity check (length, no
  placeholders), plus `autoreply-guards.mjs`. A model never decides alone to answer comp, scheduling,
  identity numbers or work-authorization questions.
* Caps: messages are not daily-capped by design (a late reply is worse than none), only a per-run
  runaway breaker `LINKEDIN_MAX_SENDS_PER_RUN` (25; busiest real run: 4). **Invitations** are
  capped: `LINKEDIN_INVITE_DAILY_CAP` (10) here, on top of the MCP's reconciled shared budget.
  Model drafts per run: `LINKEDIN_POLL_MAX_DRAFTS` (5 here, code default 3) with a per-draft timeout of
  175 s, so a burst cannot outrun `TimeoutStartSec=600`.
* Nudges: one polite follow-up when a real conversation goes quiet (they replied at least once, the
  user wrote last 7-10 days ago, never nudged before).
* Every send and every skip is reported on Telegram with the text that went out. The unit is
  `OnFailure=` wired to the Slack alert.

## Shared invite budget (why several jobs can all send invitations safely)

`get_invite_budget` (LinkedIn MCP) returns `sentToday / trailing7 / remainingToday / remainingThisWeek`,
taking the HIGHER of the career-ops ledger and LinkedIn's own sent-invitation count. Limits used:
**30 per day, 170 per week** across every sender (recruiter cron, warm outbound, Tsenta outreach,
poller referrals, any MCP client). Observed account restriction threshold: about 112 per rolling week,
which is why raw counts matter more than the nominal cap. Each sender also has its own sub-cap:
recruiter cron up to 10/run, warm outbound 8/day (+ reserves 10 for the recruiter cron, at most a third of
the week's remainder), Tsenta outreach up to 35/run when budget allows, poller 10/day.

## Environment

See `.env.server.example`, `dashboard.env.example`, `../linkedin-mcp/.env.example` for variable names.
Secrets (Unipile key/DSN/account ids, Telegram token, Slack tokens, Anthropic key for the managed
drafter, paid email-verification keys) are never in the repo.
