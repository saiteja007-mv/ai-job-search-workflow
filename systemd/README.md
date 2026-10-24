# systemd user units (server side)

Everything here is a **user** unit (`systemctl --user ...`) on the home server `<HOME_SERVER>`;
`loginctl enable-linger` is on, so it all runs with nobody logged in. The files in this folder are
the *effective* units as printed by `systemctl --user cat <unit>`, i.e. the unit file **plus its
drop-ins** (the drop-in header comment shows where each part came from). Paths, ids and the Slack
channel are placeholders (`/home/<YOU>`, `slack:<SLACK_CHANNEL_ID>`).

## Table

| unit | schedule / trigger | what it runs | why it exists |
|---|---|---|---|
| `tsenta-slot@.service` + `tsenta-slot@0600.timer`, `@1100.timer`, `@1800.timer` | daily 06:00, 11:00, 18:00 (`OnCalendar`, `RandomizedDelaySec=60`, `Persistent=false`) | `bin/run-job tsenta-slot-%i slack:<SLACK_CHANNEL_ID> -- jobs/tsenta-nightly/run.sh %i` (`TimeoutStartSec=8h`, `Nice=10`) | Daytime Tsenta auto-apply waves: same success-loop as the nightly, tagged `day0600/day1100/day1800` with runtime caps 270/390/210 min. They share one persisted per-day target, so later slots only fill the shortfall. `Persistent=false`: a missed slot is skipped, not replayed late |
| `tsenta-nightly.service` + `.timer` | daily 22:00 (`RandomizedDelaySec=60`, `Persistent=true`) | `bin/run-job tsenta-nightly slack:<SLACK_CHANNEL_ID> -- jobs/tsenta-nightly/run.sh` (`TimeoutStartSec=9h`, `Nice=10`) | The 22:00 quota-balancing apply loop + LinkedIn outreach for the run's COMPLETED applications. 9 h = 7 h apply-loop deadline (`TSENTA_MAX_RUNTIME_MIN=420`) + 1 h Unipile outreach subprocess timeout + 1 h margin for MCP discovery retries, the first full-history pagination, dashboard mirroring and the report |
| `warm-outbound.service` + `.timer` | Mon-Fri 09:37 `<YOUR_TZ>` (`RandomizedDelaySec=300`, `Persistent=true`) | `bin/run-job warm-outbound slack:<SLACK_CHANNEL_ID> -- jobs/warm-outbound/run.sh` with `WARM_OUTBOUND_DRY_RUN=0`, `WARM_OUTBOUND_DAILY_CAP=8` (`TimeoutStartSec=45min`, `Nice=10`; drop-in `node24.conf` puts the nvm Node 24 first on `PATH`) | Weekday "warm" outreach: phase 1 `claude -p` (read-only LinkedIn research from job postings' hiring teams), phase 2 deterministic `send.mjs` (guards + `send_invitation`). Runs before the 11:00 recruiter cron and leaves it 10 invites of headroom |
| `career-ops-linkedin-poll.service` + `.timer` | `OnBootSec=2min`, then `OnUnitActiveSec=5min`, `RandomizedDelaySec=45`, `Persistent=true` (was 20 min until 2026-09-14) | `node deploy/unipile-poll.mjs` (`Type=oneshot`, `TimeoutStartSec=600`, `EnvironmentFile=-deploy/.env`) | Detects LinkedIn invitation acceptances and inbound messages; drafts and (when `LINKEDIN_AUTOSEND=1`) sends replies / first messages through the LinkedIn MCP; pings Telegram. A quiet poll is 2 Unipile list calls and ~1-2 s (longest seen ~28 s), so runs never overlap; floor ~576 list calls/day. The jitter stops the call pattern looking like a metronome. NOTE: the unit file's own comment "never sends" is stale (reply sending was added 2026-09-11); the poller header is authoritative |
| `career-ops-telegram.service` | always on (`Restart=always`, `RestartSec=10`) | `node deploy/telegram-control.mjs` (nvm Node 24; `EnvironmentFile=deploy/.env`) | Phone control bot: poller commands, approve/skip/reply on queued LinkedIn items, `/status`, `/scan`, `/sync` |
| `career-ops-dashboard.service` | always on (`Restart=on-failure`) | `node deploy/outreach-dashboard.mjs` (port `42837`, basic auth, read-only) | Mobile outreach dashboard behind the tunnel/SSO |
| `career-ops-assist.service` | always on (`Restart=always`, `RestartSec=5`) | `node assist/assist-server.mjs` in `~/career-ops/assist` (binds `127.0.0.1:42836` only) | Read-only context/draft API used by the LinkedIn browser extension and by the poller's `draft-reply.mjs`. Never bind `0.0.0.0` |
| `linkedin-mcp.service` | always on (`Restart=always`, `RestartSec=5`) | `node server/index.cjs` in `~/linkedin-mcp` (port `42834`) | The self-hosted Unipile-backed LinkedIn MCP server every agent uses for LinkedIn reads/writes (`../linkedin-mcp/`) |
| `hermes-gateway.service` | always on (`Restart=always`, `RestartSec=5`, exit 75 = planned restart) | `hermes gateway run` | Hermes runtime: Slack/Telegram, cron scheduler, MCP client (`../hermes/README.md`) |
| `nightly-hermes-update.service` + `.timer` | daily 03:30 + up to 30 min random (`Persistent=true`) | `~/.hermes/scripts/nightly-hermes-update.sh` (`TimeoutStartSec=1h`) | Keep Hermes current while nobody is awake |
| `nightly-hermes-gateway-restart.service` + `.timer` | daily 04:20 (`Persistent=true`) | `systemctl --user restart hermes-gateway.service` | Apply the update; separate unit so the restart is never issued from a gateway-owned command |
| `job-failed@.service` | not scheduled; `OnFailure=` target of the units above | `bin/job-failed %I` | Posts the failed unit's last 20 journal lines to Slack (secret-scrubbed), at most once per unit per hour, skipped when `run-job` already alerted |

Units that exist in the career-ops repo (`../career-ops/deploy/systemd/`) but are **not installed**
on this server: `career-ops-scan.{service,timer}` (unattended scan via `deploy/agent-run.sh`) and
`career-ops-sync.{service,timer}` (`deploy/sync-run.sh`). They are included there for completeness.

## Drop-ins

Every timer-driven job unit has `10-poller.conf` with:

```ini
[Unit]
OnFailure=job-failed@<escaped-unit-name>.service.service
```

(`job-failed@.service` is instantiated with the *unit name* as `%I`, hence the doubled `.service`.)
`tsenta-nightly`, `tsenta-slot@`, `warm-outbound` and the two Hermes maintenance units additionally set
their own timeouts as shown. `warm-outbound` has a second drop-in, `node24.conf`, only to put
`~/.nvm/versions/node/v24.x/bin` first on `PATH`.

## Daily timeline (these units only; times are the server's local time)

```
03:30  nightly Hermes update (+0-30 min)          04:20  gateway restart
06:00  tsenta-slot@0600  (cap 270 min)             every 5 min  LinkedIn poll (+0-45 s)
09:37  warm-outbound, Mon-Fri (+0-5 min)           11:00  tsenta-slot@1100 (cap 390 min)
11:00  Hermes cron: recruiter referral target (not systemd)
18:00  tsenta-slot@1800  (cap 210 min)             22:00  tsenta-nightly (cap 420 min)
```

## Operating the units

```bash
systemctl --user list-timers --all --no-pager | grep -Ei 'career|tsenta|warm|hermes'
journalctl --user -u tsenta-nightly.service -n 80 --no-pager
systemctl --user cat <unit>                     # effective unit incl. drop-ins
systemd-analyze --user verify <unit>            # after editing
systemctl --user daemon-reload && systemctl --user enable --now <unit>.timer
```

`automations/bin/pollers` prints a one-screen status of every timer (last result, last/next run)
and every Hermes cron.
