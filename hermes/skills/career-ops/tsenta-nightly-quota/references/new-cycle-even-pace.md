# New-cycle even-pace (not a dump)

Trigger: <YOUR_NAME> says **new day new cycle** (or equivalent) on the first morning after Tsenta monthly refresh.

## Live buckets, not the 13th

Read `get_application_balance` before computing a target:

- `monthly.remaining` / `monthly.limit` / `cycleStart` / `cycleEnd` — billing window from the API.
- `pack.remaining` — lifetime; does not expire at `cycleEnd`.
- `total` = monthly remaining + pack remaining (+ free if any).

Days left = <YOUR_CITY> date of `cycleEnd` minus today, minimum 1. Example observed 2026-09-14: cycle `2026-09-14T04:24Z` → `2026-10-14T04:24Z`, 29 days, total 1638 → target 57.

## Script target math (`run_tsenta_nightly_direct.py`)

While `now_utc < monthly.cycleEnd` the **drain branch is active for the whole cycle**:

- `drain_days <= 1` → `target_today = total` (full dump — last day only).
- else → `target_today = ceil(total / drain_days)` with **no 100 cap**.

The `min(100, ceil(total / days_left))` branch runs only **after** cycleEnd. `LOCKED_CYCLE_END` is a past-cycle fallback for null `cycleEnd`; do not treat it as the current window.

Same-calendar-day reruns (morning `cycle-day1` + 10pm `nightly`) load `attempted_job_ids` from `data/tsenta-applications-{TODAY}-*.json` and **subtract that count from `target_today`** so 10pm cannot start a second full target.

## Morning invocation

```bash
export TSENTA_RUN_TAG=cycle-day1 TSENTA_SKIP_OUTREACH=1
/home/<YOU>/.hermes/hermes-agent/venv/bin/python3 \
  /home/<YOU>/career-ops/scripts/run_tsenta_nightly_direct.py
```

Skip Unipile on this pass when the daily recruiter cron already sent, or `outreach_log.json` HTTP 201s in the last 24h are near ~35–40. Recruiter “send them” is LinkedIn invites from today’s report, not Tsenta job outreach and not recruiter email unless he says email.

Stamp: `data/tsenta-{RUN_TAG}-{TODAY}-stamp.json` (`target_today`, `run_started_at_utc`). Leave <COMPANY_B>/old `needs` parked.
