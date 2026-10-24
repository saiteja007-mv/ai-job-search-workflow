#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="$HOME/.local/bin:$HOME/.hermes/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
REPO="$HERMES_HOME/hermes-agent"
LOG_DIR="$HERMES_HOME/logs/nightly-updates"
LOCK="$HERMES_HOME/nightly-hermes-update.lock"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%F).log"

# Open the lock FD before redirecting logs. `flock -n 9` needs an open fd 9.
exec 9>"$LOCK"
exec >>"$LOG" 2>&1

echo "===== $(date -Is) nightly Hermes update check ====="

if ! flock -n 9; then
  echo "Another nightly Hermes update is already running; exiting."
  exit 0
fi

if [[ ! -d "$REPO/.git" ]]; then
  echo "Hermes git repo not found at $REPO"
  exit 1
fi

cd "$REPO"
BEFORE_VERSION="$(hermes --version 2>&1 | head -1 || true)"
BEFORE_HEAD="$(git rev-parse --short HEAD 2>/dev/null || true)"
echo "Before: $BEFORE_VERSION"
echo "Before HEAD: $BEFORE_HEAD"

# Fetch first so the log shows the actual upstream changelog.
git fetch --prune origin main
UPSTREAM="origin/main"
BEHIND="$(git rev-list --count HEAD..$UPSTREAM || echo 0)"
AHEAD="$(git rev-list --count $UPSTREAM..HEAD || echo 0)"
echo "Ahead: $AHEAD  Behind: $BEHIND"

if [[ "$BEHIND" == "0" ]]; then
  echo "Already on latest upstream main. No update needed."
  hermes update --check || true
  exit 0
fi

echo "--- Changelog: commits to be applied ---"
git log --oneline --decorate --date=short --pretty='format:%h %ad %s' HEAD..$UPSTREAM || true
echo
echo "--- Running hermes update --yes --backup ---"
hermes update --yes --backup

echo "--- Post-update config check ---"
hermes config check || true

echo "--- Post-update doctor ---"
hermes doctor || true

echo "--- Browser backend verification ---"
grep -n '^browser:' -A12 "$HERMES_HOME/config.yaml" || true
curl -fsS --max-time 5 http://127.0.0.1:9333/json/version | python3 -m json.tool | sed -n '1,40p' || true

AFTER_VERSION="$(hermes --version 2>&1 | head -1 || true)"
AFTER_HEAD="$(git rev-parse --short HEAD 2>/dev/null || true)"
echo "After: $AFTER_VERSION"
echo "After HEAD: $AFTER_HEAD"

echo "Gateway restart intentionally not run from inside the gateway-owned command context."
echo "If this script was launched by a standalone systemd timer, restart the gateway manually or via a separate trusted shell if immediate reload is needed."

echo "===== $(date -Is) nightly Hermes update complete ====="
