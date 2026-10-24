---
name: hermes-maintenance-ops
description: "Use when maintaining Hermes updates, gateway, or models."
version: 1.0.0
author: Hermes Agent
license: MIT
created_by: agent
metadata:
  hermes:
    tags: [hermes, maintenance, updates, approvals, gateway, systemd, models]
    related_skills: [hermes-agent]
---

# Hermes Maintenance Operations

## When to Use

Use this when the user asks Hermes to maintain itself: checking release/changelog state, updating to the latest version, switching the default model across CLI, Slack, cron, and profiles, tuning command approvals, scheduling unattended updates, or coordinating gateway restarts after config/code changes.

This skill complements the protected `hermes-agent` skill. Always load `hermes-agent` first for authoritative CLI/config references, then use this skill for <YOUR_NAME>-specific maintenance workflow patterns.

## Operating Principles

- Verify before changing: check `hermes --version`, `hermes update --check`, config state, and git state when relevant.
- Prefer official Hermes commands (`hermes update`, `hermes config set`, `hermes gateway restart`) over hand-editing internals.
- Keep secrets out of logs and chat. Redact credentials as `[REDACTED]` if encountered.
- For gateway sessions, remember config/tool/schema changes often require `/restart` or a new session.
- Do not restart the running gateway from a child command owned by that same gateway process; it can kill the command before completion or be blocked by Hermes safety checks.

## Command Approval Preference

<YOUR_NAME> prefers routine agent work to run without repeated command approval prompts. For this environment, use:

```bash
hermes config set approvals.mode off
```

Then verify:

```bash
grep -n '^approvals:' -A20 ~/.hermes/config.yaml
hermes config check
```

Explain that this bypasses command approvals but does not disable secret redaction. Some slash-command or gateway-level safety confirmations may still exist for special operations.

## Nightly Update Workflow

When the user wants Hermes kept current automatically, use an unattended sleep-window updater instead of waiting for manual “update this” prompts.

Recommended shape:

1. Create a small script under `~/.hermes/scripts/` that:
   - sets a stable `PATH`
   - locks with `flock`
   - checks/fetches upstream
   - logs the commits/changelog to be applied
   - runs `hermes update --yes --backup`
   - runs `hermes config check` and `hermes doctor`
   - records before/after version and git HEAD
2. Run it with a user-level `systemd` timer during sleep hours.
3. Use a separate later timer/service for gateway restart if the update is launched outside the active gateway process.
4. Store logs in `~/.hermes/logs/nightly-updates/`.

See `references/nightly-auto-updates.md` for the exact template used in this environment.

## Gateway Restart Pattern

After updates/config/tool changes:

- In Slack/Telegram foreground: ask the user to run `/restart`, or use it if they explicitly requested it and the platform supports it.
- From a separate shell outside the gateway: `hermes gateway restart` or `systemctl --user restart hermes-gateway.service`.
- From a systemd timer/service: a dedicated oneshot service can restart the gateway after the update service exits.

Avoid embedding gateway restart inside a command executed by the current gateway session.

## Session-Store Corruption Recovery

If Slack or another gateway platform receives messages but cannot answer while the service still reports `active`, inspect gateway logs for `database disk image is malformed`, malformed-schema errors, failed session leases, or “session store unavailable.” A green systemd status only proves the process is alive, not that agent turns can persist.

Diagnose and repair `state.db` offline. Stop the gateway first; live connections can produce inconsistent check results and can keep stale broken SQLite handles after an on-disk repair. Start with the official `hermes sessions repair` path. If direct repair fails, use `hermes sessions recover` against the preserved malformed backup, write to a separate output database, review the JSON recovery report, and install it only after integrity/count verification.

See `references/state-db-corruption-recovery.md` for the verified recovery sequence, validation gates, and rollback artifacts.

## Cron Fleet Audit

Auditing scheduled jobs needs three sources, not one. `hermes cron doctor` only surfaces each job's
stored `last_error`, so a job that fails 30% of the time but succeeded most recently looks healthy.
Read all three:

```bash
hermes cron doctor
hermes cron incidents                # open failure incidents; `incidents ack <id>` closes a fixed one
sqlite3 ~/.hermes/cron/executions.db \
  "SELECT job_id, status, COUNT(*) FROM executions
   WHERE started_at >= date('now','-45 day') GROUP BY job_id, status"
```

Then read `~/.hermes/cron/jobs.json` directly for fields the list output hides: `failure_streak`,
`model_snapshot`/`provider_snapshot`, `workdir`, `enabled_toolsets`, `origin`.

### Never schedule two workdir agent jobs on the same minute

Agent jobs with a `workdir` take a `TERMINAL_CWD` lock. Two of them on the same cron expression
make the loser wait out the 660s cron inactivity limit and die with
`TimeoutError: Timed out waiting for the TERMINAL_CWD read/write lock`. This is the single most
common cause of a job with a double-digit failure rate and no obvious bug.

Give each workdir its own lane and leave real headroom between heavy agent jobs — these runs take
tens of minutes, so 20 minutes apart is not separation. Group light script-driven jobs (no workdir)
separately; `no_agent` script jobs do not take the lock and can overlap freely.

### A script must not exit non-zero on partial success

A broadcast script that returns `1` because 1 of 26 targets failed marks the whole cron job failed
and raises an incident for work that actually went out. Exit non-zero only on total failure
(nothing delivered); report per-target failures in stdout instead.

### Model pinning semantics

- Resolution order at fire time: per-job `--model`/`--provider` pin > `cron.model` /
  `cron.model_provider` fleet default > the main agent model (`model.default`).
- A fleet model switch does not rewrite existing per-job pins. Re-pin each job with
  `hermes cron edit <id> --model <m> --provider <p>` when every scheduled agent must move,
  including paused and `no_agent` jobs so a later resume does not fire the old pin.
- `pinned` is DERIVED from `model`+`provider`, never stored as its own key in `jobs.json`.
- `hermes cron edit <id> --provider <p> --model <m> --pin` is user-owned; the agent's `cronjob`
  tool cannot set it. Run it through the terminal.
- Verify a plugin-provided provider's exact id before pinning (`~/.hermes/plugins/<name>/plugin.yaml`
  for the provider name, its `model_catalog.py` for real model ids). Pinning five jobs to a guessed
  provider string breaks all five at once.
- **Drift-skip is historical.** Hermes once failed closed when an unpinned job's creation snapshot
  drifted from the global model (#44585, Jun 2026); commit `7e4d02fef5` (Sep 2026) removed it —
  unpinned jobs now simply follow the main model. On a tree at or past that commit, do not diagnose
  a `[drift_skip:silent]` error as live behavior; it is a stored `last_error` from older code and
  clears on the next successful run. Check `git log -S` in `~/.hermes/hermes-agent` before
  explaining any cron failure by version behavior, and check the reflog — the running gateway may
  predate a just-merged fix.

### Back up before bulk edits

`cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.bak-preaudit-$(date +%Y%m%d_%H%M%S)` before
removing jobs. `hermes cron remove <id>` takes one id, has no `--yes`, and deletes the job record;
the `executions.db` history survives.

### Dead-job smells

- A calendar-window cron (`0 13 10-13 9 *`) with `repeat: forever` silently re-fires NEXT YEAR.
  One-off campaign jobs must be removed when the window closes, not left enabled.
- `state: completed` jobs and long-paused migration leftovers accumulate; they cost nothing to run
  but hide the live fleet. Audit them out.
- A job whose prompt states a time that disagrees with its cron expression has been rescheduled
  without updating the prompt; fix both together.

## Fleet-wide model switch

A `model.default` write does not move Slack, cron, named profiles, or subagents. Each resolves the model on its own.

1. Load `hermes-agent`, then read the live `model:` block and `hermes profile list`.
2. Set the default route with `hermes config set`, in this order: `model.default`, then `model.provider`, then `model.base_url` and `model.api_mode`, then `model.context_length`. Setting `model.provider` clears `base_url` and `api_mode` that belonged to the previous provider — set those again after the provider switch, or the new provider keeps the old endpoint.
3. Read the new model's context length from the provider catalog (`~/.hermes/cache/endpoint_model_metadata.json` for xAI). Do not leave the previous model's `model.context_length` pin; it shrinks the window.
4. Pin subagents the same way: `delegation.model`, `delegation.provider`, `delegation.base_url`, `delegation.api_mode`. An empty delegation model inherits the parent; a leftover delegation route does not follow `model.default`.
5. Repeat the same `hermes -p <name> config set` writes for every named profile. Profiles do not inherit the default profile's model.
6. Confirm `~/.hermes/auth.json` `active_provider` matches `model.provider` without printing tokens. A stale `active_provider` makes auto-resolution pick a different credential than the config route. Change only that field.
7. Slack has no model key of its own. It uses `model.default` unless `gateway_routing.entry_json` has a `model_override`. Check overrides before claiming Slack is switched. A cached gateway agent keeps the model it started with until `hermes gateway restart` from a shell outside that gateway.
8. Cron pins do not follow `model.default` (see Model pinning semantics). Do not rename a job because its name mentions a CLI the prompt invokes.
9. Leave `fallback_providers` alone unless asked. They are the failure path, not the default.

xAI OAuth (`xai-oauth`) route: base URL `https://api.x.ai/v1`, api mode `codex_responses`, bare model id (`grok-4.7`, not `x-ai/grok-4.7`).

Verify: `hermes profile list` shows the new model, the gateway log contains `Model context warmed: <model>`, and Slack logs `slack connected`.

## Verification Checklist

After maintenance work, verify with real output:

```bash
hermes --version
hermes update --check
hermes config check
hermes doctor
systemctl --user list-timers '*hermes*' --all --no-pager
```

For updated browser/tool schemas, run a live tool smoke test after restart when possible.

## Pitfalls

- `hermes update --check` can reveal commits behind upstream even when the installed version string looks current; check both.
- Do not capture transient install/path/version failures as permanent tool limitations. Capture only the working fix or durable procedure.
- Timers are safer than cron jobs for self-updating the local Hermes gateway because they run outside the conversation loop and can use systemd service boundaries.
- If the gateway restart is required immediately after an update, use a separate process/service. Do not rely on a child command from the active gateway to restart its parent cleanly.
- `hermes model` refuses to run non-interactively; switch models with `hermes config set`, then read `model.default` / `model.provider` from `~/.hermes/config.yaml`.
- Set `model.base_url` and `model.api_mode` only after `model.provider`. The provider switch clears the previous route, so writing them first is discarded.
- The session's active model can differ from `model.default` in config (a runtime switch). Report identity from the live session header, and treat config as the cron/default answer, not the session answer.
