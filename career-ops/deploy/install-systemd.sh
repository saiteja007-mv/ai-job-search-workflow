#!/usr/bin/env bash
# Installs career-ops systemd *user* units (run as your normal user, NOT root).
#   bash deploy/install-systemd.sh
set -euo pipefail

REPO="${CAREER_OPS_DIR:-$HOME/career-ops}"
[ -f "$REPO/deploy/.env" ] || { echo "!! Create deploy/.env first (cp deploy/.env.example deploy/.env)."; exit 1; }

SRC="$REPO/deploy/systemd"
DST="$HOME/.config/systemd/user"
mkdir -p "$DST"

echo "==> Installing units to $DST (REPO=$REPO)"
for f in "$SRC"/*.service "$SRC"/*.timer; do
  sed "s#__REPO__#$REPO#g" "$f" > "$DST/$(basename "$f")"
done

# Run user services without an active login session (headless always-on server).
echo "==> Enabling linger for $USER"
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || true

systemctl --user daemon-reload
systemctl --user enable --now career-ops-dashboard.service
systemctl --user enable --now career-ops-scan.timer
systemctl --user enable --now career-ops-sync.timer
systemctl --user enable --now career-ops-telegram.service

echo
echo "==> Done. Verify:"
echo "    systemctl --user list-timers | grep career-ops"
echo "    systemctl --user status career-ops-telegram --no-pager"
echo "    docker compose -f $REPO/docker-compose.yml ps"
echo "    Trigger a scan now:  systemctl --user start career-ops-scan.service ; journalctl --user -u career-ops-scan -f"
