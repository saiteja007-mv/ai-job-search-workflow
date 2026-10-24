#!/usr/bin/env bash
# Symlinks the unit files into ~/.config/systemd/user/, then daemon-reload
# and enable --now both timers. NOT run automatically -- run it yourself
# when ready:  bash ~/automations/install.sh
set -euo pipefail

# NOTE for this staged copy: the unit files it links live in ../systemd/ (they are the effective
# units incl. drop-ins). Copy or symlink them into automations/systemd/ first, or point SRC_DIR there.
UNIT_DIR="$HOME/.config/systemd/user"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/systemd" && pwd)"

mkdir -p "$UNIT_DIR"
for f in "$SRC_DIR"/*.service "$SRC_DIR"/*.timer; do
  ln -sf "$f" "$UNIT_DIR/$(basename "$f")"
done

systemctl --user daemon-reload
# Job-search timers only. (The upstream script also enabled two unrelated non-job-search timers.)
# The tsenta-slot@ timers are installed the same way from ../systemd/ and enabled with:
#   systemctl --user enable --now tsenta-slot@0600.timer tsenta-slot@1100.timer tsenta-slot@1800.timer
systemctl --user enable --now tsenta-nightly.timer warm-outbound.timer

echo "Installed. Check with: systemctl --user list-timers"
