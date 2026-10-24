# Hermes Agent on the home server: how it is wired for the job search

[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) (open source, Nous Research) is the
always-on agent runtime on the home server `<HOME_SERVER>`. For the job search it does three things:

1. runs the **one LLM cron** (`cron/recruiter-referral-target.md`, daily 11:00),
2. is the **Slack/Telegram front door** (the same bot credentials deliver every job's output through
   `hermes send`, see "Slack delivery"),
3. hosts the **skills** (`skills/`) and **MCP client** config (`config.excerpt.yaml`) those runs use.

Everything deterministic (Tsenta slots, warm outbound, LinkedIn polling) is plain systemd on purpose:
an LLM turn per run was costing money for jobs that need no LLM (`../automations/README.md`).

## Layout of this folder

| path | what |
|---|---|
| `cron/recruiter-referral-target.md` | the cron job: schedule, model, delivery, gotchas, full prompt |
| `config.excerpt.yaml` | the parts of `~/.hermes/config.yaml` the workflow depends on (model/provider, fallbacks, limits, approvals, Slack, MCP) |
| `scripts/nightly-hermes-update.sh` | what `nightly-hermes-update.service` runs at ~03:30 |
| `skills/career-ops/` | the Hermes skill loaded by the cron (`SKILL.md` router + five sub-skills, below) |
| `skills/hermes-maintenance-ops/` | operating notes for updating/restarting Hermes itself |

Sub-skills under `skills/career-ops/`: `tsenta-nightly-quota` (even-pacing Tsenta credits, how the
slots/nightly share one day target), `contact-email-discovery` (SMTP-verified recruiter emails),
`linkedin-rolepost-actions` (approval-queue for LinkedIn role posts), `job-application-submission`
(filling ATS forms by hand), `company-segment-job-research` (hiring companies by area/size).
The skill's other files (modes, templates, scripts, personal profile) are the career-ops repo itself
and are not staged here.

## Process model

```
systemd --user
 +- hermes-gateway.service            long-running: Slack + Telegram + cron scheduler + MCP client
 |    ExecStart  hermes gateway run   (HERMES_HOME=~/.hermes, HERMES_SUPERVISED_CHILD=1)
 |    Restart=always, RestartSec=5
 |    RestartForceExitStatus=75 / SuccessExitStatus=75   exit 75 = "planned restart", systemd restarts it
 |    RestartPreventExitStatus=78                        exit 78 = config error, do NOT restart-loop
 |    KillMode=mixed, TimeoutStopSec=210                 > agent.restart_drain_timeout (180 s) so running agents drain first
 |    ExecStop/ExecStopPost mark the stop and clean the cgroup; ExecReload = SIGUSR1
 +- nightly-hermes-update.timer       03:30 (+ up to 30 min random)  -> pulls + updates Hermes
 +- nightly-hermes-gateway-restart.timer   04:20                      -> restarts the gateway
```

`StartLimitIntervalSec=0` removes systemd's start-rate limit so the gateway always comes back.
Lingering is enabled for the user, so all of this runs with nobody logged in.

### Nightly update and restart (two timers on purpose)

* 03:30 `nightly-hermes-update.service` runs `scripts/nightly-hermes-update.sh`: `flock` on
  `~/.hermes/nightly-hermes-update.lock`, `git fetch origin main`, log the pending changelog, and
  only if behind: `hermes update --yes --backup`, `hermes config check`, `hermes doctor`, then a
  check that the browser CDP endpoint on `127.0.0.1:9333` still answers. Log:
  `~/.hermes/logs/nightly-updates/YYYY-MM-DD.log`. `TimeoutStartSec=1h`.
* 04:20 `nightly-hermes-gateway-restart.service` is a oneshot `systemctl --user restart hermes-gateway.service`.
  It is a **separate unit** because a restart issued from a command the gateway itself owns kills
  that command mid-flight (and Hermes' safety checks can refuse it). Running it from its own timer
  makes the new code/config take effect while nobody is awake.
* Both have an `OnFailure=job-failed@<unit>.service` drop-in that posts the last 20 journal lines
  to Slack (`../systemd/README.md`).

## The Claude-subscription provider (no API billing)

`model.provider: claude-subscription-directsdk-experimental` is a Hermes **model-provider plugin**,
[`NousResearch/hermes-plugin-claude-subscription-directsdk`](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk)
(MIT, v0.3.0 when staged; cloned into `~/.hermes/plugins/`, enabled under `plugins.enabled`). It
drives a **Claude Pro/Max subscription through the official Claude Code CLI**; Hermes still owns
tools, approvals and context compaction. Not staged here because it is third-party code; to
reproduce:

1. `npm install -g @anthropic-ai/claude-code` (the plugin checks `claude --version`).
2. Log in as the **same OS user the gateway runs as**: `claude auth login`. Alternatives: set
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the gateway's environment, or point
   `CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` at a logged-in config dir.
   When the OAuth session expires every run fails with "Claude Code is installed but has no usable
   login in the environment Hermes runs it in" (seen once, 2026-10-13); re-login fixes it.
3. `hermes config set model.provider claude-subscription-directsdk-experimental` and pick a model id
   (`claude-sonnet-5[1m]` is the fleet default here; the cron pins `claude-sonnet-5-5`).
4. Make sure `ANTHROPIC_API_KEY` is **not** what gets billed: the cron prompt and
   `automations/jobs/warm-outbound/run.sh` call `claude -p` with `env -u ANTHROPIC_API_KEY`
   (warm-outbound refuses to start if any `ANTHROPIC_*` variable is set).

Fallback chain on provider error (see `config.excerpt.yaml`): same plugin with `claude-sonnet-5-5` ->
a local OmniRoute free-tier router -> two free Nous-hosted models. A local Gemma server is also
configured as a provider.

## Slack delivery (cron output and every systemd job)

* The gateway connects to Slack over Socket Mode with a bot token + app token (both only in
  `~/.hermes/.env`). `slack.require_mention: true` means in channels the bot answers only when
  @mentioned; `allowed_channels` lists the channels it may speak in, one of which is the
  cron-delivery channel.
* A cron job delivers to `deliver: slack:<channel>` (optionally `slack:<channel>:<thread_ts>`).
  **Thread drift**: if a job was created in a thread its `deliver` points at that thread forever;
  when "I did not get the report", compare `deliver` with the current thread and fix it with
  `cronjob(action="update", job_id=..., deliver="slack:<channel>")`.
* Non-LLM jobs deliver with the CLI: `hermes send -t slack:<channel> [-s subject] -f -` (body on
  stdin). That needs the bot credentials but **not** the running gateway and costs no LLM turn.
  `automations/bin/run-job` and `automations/bin/job-failed` are thin wrappers around it.
* Telegram is configured on the platform too (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`), but
  the job-search Telegram bot is a separate process (`career-ops-telegram.service`, its own token).

## Rules of thumb collected from running this

* **Restart after config/tool/schema changes.** A running gateway session keeps the old config.
  `systemctl --user restart hermes-gateway.service` from outside the gateway, or `/restart` in Slack.
* **Never schedule two workdir agent jobs on the same minute** (`TERMINAL_CWD` lock, 660 s inactivity
  limit); give each workdir its own lane. `no_agent` script jobs are exempt.
* **`hermes cron run` goes detached** and you verify afterwards (`last_run_at` + new file in
  `~/.hermes/cron/output/<id>/`); details in `cron/recruiter-referral-target.md`.
* **A cron script must not exit non-zero on partial success** (1 of 26 failing marks the whole job
  failed and raises an incident for work that mostly went out); exit non-zero only on total failure.
* **Model pins are per job.** Switching `model.default` does not move existing cron jobs; re-pin each
  with `hermes cron edit <id> --model <m> --provider <p>`, paused ones included.
* **`context_file_max_chars: 40000`** truncates `AGENTS.md`-style context files; put hard rules in the
  prompt itself.
* Approvals are `off` for interactive use but `cron_mode: deny`, so a cron run can never be blocked
  waiting for a human; anything that would need approval just fails fast. `security.redact_secrets`
  stays on regardless.
* Audit scheduled runs against ground-truth artifacts (reports, ledger events, cron output), never
  against `last_status: ok` alone.

## Useful read-only commands

```bash
hermes cron list                    # ids, state, schedule, last run
hermes cron show <id>               # full definition of one job
hermes --version ; hermes update --check ; hermes config check ; hermes doctor
systemctl --user list-timers --all | grep -Ei 'hermes|tsenta|career|warm'
journalctl --user -u hermes-gateway.service -n 100 --no-pager
```
