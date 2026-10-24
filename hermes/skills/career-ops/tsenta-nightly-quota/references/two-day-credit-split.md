# Two-day remaining-credit split

When <YOUR_NAME> says complete remaining Tsenta pack credits across the last two days of a cycle (“complete these N in these two days”):

**Last-day override (2026-09-13):** if he later says today is the last day / dump remaining / complete all leftover credits until successful submission, drop the half-cap. Loop HONEST apply + this-cutoff resume approve + answer-based submit-review until `get_application_balance.total` is 0 or the safe US feed is empty. Do not rerun stock `run_tsenta_nightly_direct.py` on top of an in-progress dump (`scripts/tsenta_dump_remaining_2026-09-12.py`, stamp `data/tsenta-dump-remaining-{date}-stamp.json`). 1pm may only fill leftover refunds after that dump exits. Successful submission = live `COMPLETED`, not parked review.

**Pack vs monthly expiry (2026-09-13):** leftover `pack` credits do **not** expire at 3:34 PM / `monthly.cycleEnd`. That stamp is the old monthly cycle. Pack-only live balance has `cycleEnd: null`. If he asks “will these expire,” answer no for pack remaining; listings expire, credits do not. Parked this-run resumes stay until approve/reject. Do not invent a burn deadline.

## Do not

- Run stock `run_tsenta_nightly_direct.py` when `drain_days<=1` — it sets `target_today = remaining` and dumps the whole pack today.
- Pause the 10pm cron to save credits. Update tonight’s prompt instead.
- Treat the half-cap (e.g. 148 of 296) as a promise. It is a **ceiling**. Thin honest US feed can yield ~22 then ~11 attempts.
- Start Unipile on afternoon extra waves unless asked. Set `TSENTA_SKIP_OUTREACH=1`.
- Touch the <COMPANY_B>/old parked `needs` queue. Only approve this-run cutoff resumes.

## Do

1. Lock `cycleEnd` from `get_application_balance`. Last dump must be the **last midday job before cycleEnd**, not 10pm if 10pm is after cycleEnd (example: cycleEnd 2026-09-13 15:34 CDT — Sunday 10pm is too late; Sunday 1pm is the dump).
2. Half today via env, not by editing the drain formula ad hoc:
   - `TSENTA_TARGET_OVERRIDE=<half>`
   - `TSENTA_RUN_TAG=<wave-name>` (writes `data/tsenta-applications-{date}-{tag}.json` and `reports/tsenta-{tag}-{date}.md`)
   - `TSENTA_SKIP_OUTREACH=1` for afternoon waves
3. Persist a stamp **before** apply (`data/tsenta-{tag}-{date}-stamp.json`) with target, balance, UTC cutoff.
4. Update 10pm (`<CRON_JOB_ID>`) so if today’s completed+in_flight already hit the half-cap, it only does this-run resume reviews + outreach — no second drain. If under the cap, it may fill toward the cap only.
5. Leave midday (`<CRON_JOB_ID>`) to dump leftovers before cycleEnd.
6. Cross-wave dedupe: union `jobId` from `data/tsenta-applications-{TODAY}-*.json` into `already_attempted` so a later wave does not re-apply earlier IDs.

## After the script exits

The script’s bounded poll can report `Applications completed: 0` / `in-flight: N` while live `list-applications(filter=needs)` shows those N as `PENDING_RESUME_REVIEW` created after the stamp cutoff. Re-query needs, approve **this cutoff only**, then recount submitted.

Live tally = <YOUR_CITY>-today `list-applications(filter=submitted)` plus this-run needs you just approved — not the script footer alone.

## Thin-feed fallback (volume drain only)

If AI/ML-only `search` starves far below the cap:

- Extra `autoApply=true` pages (`page=4+`) and extra queries (`data scientist`, SWE titles).
- Accept a US role when the **title** matches SWE/data even if the JD is not AI-heavy. Still skip citizenship/clearance/export-control, defense primes, and junk (`fleet`, `GTM`, `postdoc`, `campus`, `interview on`).
- `BAD_TITLE` must be **case-insensitive**. Literal `manager` misses `Managers`.
