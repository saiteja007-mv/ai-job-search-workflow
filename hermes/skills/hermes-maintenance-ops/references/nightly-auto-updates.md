# Nightly Hermes Auto-Update Pattern

Use this reference when <YOUR_NAME> asks Hermes to update itself automatically, especially during sleep hours.

## Why this pattern

Manual “update this/that” prompts do not scale. A user-level `systemd` timer can check upstream, apply official Hermes updates, and log evidence without depending on an active conversation.

## Installed shape from the working session

Files used on <YOUR_NAME>'s host:

- `~/.hermes/scripts/nightly-hermes-update.sh`
- `~/.config/systemd/user/nightly-hermes-update.service`
- `~/.config/systemd/user/nightly-hermes-update.timer`
- `~/.config/systemd/user/nightly-hermes-gateway-restart.service`
- `~/.config/systemd/user/nightly-hermes-gateway-restart.timer`
- logs: `~/.hermes/logs/nightly-updates/YYYY-MM-DD.log`

Timers:

- update timer: around `03:30` local time with randomized delay
- gateway restart timer: around `04:20` local time

## Update script checklist

The update script should:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$HOME/.hermes/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
REPO="$HERMES_HOME/hermes-agent"
LOG_DIR="$HERMES_HOME/logs/nightly-updates"
LOCK="$HERMES_HOME/nightly-hermes-update.lock"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%F).log"
exec >>"$LOG" 2>&1
flock -n 9 || exit 0
```

Then:

1. `cd "$REPO"`
2. record `hermes --version` and current `git rev-parse --short HEAD`
3. `git fetch --prune origin main`
4. compute `git rev-list --count HEAD..origin/main`
5. if behind, log `git log --oneline HEAD..origin/main`
6. run `hermes update --yes --backup`
7. run `hermes config check` and `hermes doctor`
8. record after-version and after-HEAD

## Service/timer templates

Update service:

```ini
[Unit]
Description=Nightly Hermes auto-update
Documentation=https://hermes-agent.nousresearch.com/docs/

[Service]
Type=oneshot
ExecStart=%h/.hermes/scripts/nightly-hermes-update.sh
```

Update timer:

```ini
[Unit]
Description=Run Hermes auto-update while <YOUR_NAME> is likely asleep

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=30m
Persistent=true
Unit=nightly-hermes-update.service

[Install]
WantedBy=timers.target
```

Gateway restart service:

```ini
[Unit]
Description=Restart Hermes gateway after nightly update window

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl --user restart hermes-gateway.service
```

Gateway restart timer:

```ini
[Unit]
Description=Restart Hermes gateway after nightly update while <YOUR_NAME> is likely asleep

[Timer]
OnCalendar=*-*-* 04:20:00
Persistent=true
Unit=nightly-hermes-gateway-restart.service

[Install]
WantedBy=timers.target
```

Enable:

```bash
chmod +x ~/.hermes/scripts/nightly-hermes-update.sh
bash -n ~/.hermes/scripts/nightly-hermes-update.sh
systemctl --user daemon-reload
systemctl --user enable --now nightly-hermes-update.timer
systemctl --user enable --now nightly-hermes-gateway-restart.timer
systemctl --user list-timers 'nightly-hermes-*' --all --no-pager
```

## Important pitfall

Do not place `systemctl --user restart hermes-gateway.service` inside a command launched from the current gateway session. Hermes may block it, or the gateway may terminate the child process. Use `/restart` in foreground, a separate shell, or the separate systemd restart timer/service pattern above.

## Verification commands

```bash
hermes update --check
systemctl --user list-timers 'nightly-hermes-*' --all --no-pager
systemctl --user status nightly-hermes-update.timer --no-pager -l
systemctl --user status nightly-hermes-gateway-restart.timer --no-pager -l
```
