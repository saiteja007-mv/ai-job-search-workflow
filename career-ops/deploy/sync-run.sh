#!/usr/bin/env bash
# career-ops — Agency Gmail sync (gog). Invoked by the systemd timer or Telegram /sync.
set -euo pipefail

REPO="${CAREER_OPS_DIR:-$HOME/career-ops}"
set -a; [ -f "$REPO/deploy/.env" ] && . "$REPO/deploy/.env"; set +a
mkdir -p "$REPO/deploy/logs"
LOG="$REPO/deploy/logs/sync-$(date +%F).log"

cd "$REPO/agency-applications/_raw"
{
  echo "=== $(date -Is) sync start ==="
  GOG_BIN="${GOG_BIN:-gog}" node sync-daily.mjs --quick
  echo "=== $(date -Is) sync done ==="
} 2>&1 | tee -a "$LOG"
