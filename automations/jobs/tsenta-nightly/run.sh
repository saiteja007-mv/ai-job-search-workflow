#!/usr/bin/env bash
# Tsenta quota-balancing success-loop + LinkedIn outreach.
#
# run_tsenta_nightly_direct.py does the whole job in one process: apply-loop
# until the day's persisted target of COMPLETED applications is reached (or a
# stop condition fires), approve this run's resume reviews, run Unipile
# outreach for this run's COMPLETED rows (shared invite budget), and print the
# report + Slack summary. The day target is computed once per <YOUR_CITY> day and
# reused, so later slots only fill the shortfall.
#
# Slots (systemd timers): 06:00, 11:00, 18:00 (tsenta-slot@HHMM) + 22:00 nightly.
# Usage: run.sh [slot]   slot = 0600 | 1100 | 1800 | (empty = nightly)
set -uo pipefail
slot="${1:-}"
case "$slot" in
  0600) export TSENTA_RUN_TAG=day0600 TSENTA_MAX_RUNTIME_MIN=${TSENTA_MAX_RUNTIME_MIN:-270} ;;  # ends ~10:30
  1100) export TSENTA_RUN_TAG=day1100 TSENTA_MAX_RUNTIME_MIN=${TSENTA_MAX_RUNTIME_MIN:-390} ;;  # ends ~17:30
  1800) export TSENTA_RUN_TAG=day1800 TSENTA_MAX_RUNTIME_MIN=${TSENTA_MAX_RUNTIME_MIN:-210} ;;  # ends ~21:30
  "")   : ;;  # nightly defaults (tag=nightly, 420 min)
  *) echo "unknown slot: $slot" >&2; exit 2 ;;
esac
cd /home/<YOU>/career-ops || exit 1
# One Tsenta run at a time (slots must never double-apply / double-outreach).
# Wait up to 90 min for a still-running earlier slot (e.g. its outreach tail).
exec 9>/home/<YOU>/.cache/tsenta-run.lock
if ! flock -w 5400 9; then
  echo "⏭️ Tsenta ${slot:-nightly} slot skipped: previous Tsenta run still in progress after 90 min wait."
  exit 0
fi
exec /home/<YOU>/.hermes/hermes-agent/venv/bin/python3 scripts/run_tsenta_nightly_direct.py
