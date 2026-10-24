# Gotchas

Each item below cost at least an hour, usually a day. They're grouped by where they bite.

## Scoring and applying

- **Never score from feed metadata.** Job feeds mislabel seniority (a Director role came through as entry level). Always fetch the full description first (`get-jobs-by-ids` with `descriptionMaxChars 8000`).
- **Query Tsenta by `maxYearsExperience`, not `jobTypes`.** Try 3, then 4. And never pass `search` together with other filters, or you get `FILTERS_NARROW`.
- **Over-queue about 2x.** Roughly 40% of applications come back `JOB_EXPIRED`, because the feed isn't checked for liveness. Those are refunded, but landing 10 means queuing 16 to 18.
- **Apply by `jobIds`, not URL.** A bare URL without `jobDescription` ships an unoptimized resume. Check `isOptimized: true`.
- **Only `COMPLETED` counts.** `READY`, `RUNNING`, `FAILED` and `SKIPPED(JOB_EXPIRED)` don't, and neither do Tsenta's own native auto-applies. Spot-check one `optimizedProfile` per run for invented content.
- **A timed-out `apply-to-job` may have half-worked.** Save the start time before the first apply. After a timeout, never rerun. Instead list live applications and trust the rows created after that timestamp.
- **`scan-ats-full.mjs` needs `--include-undated`.** Without it, about 16,000 live postings with no date field are silently dropped. Check `postingsDroppedNoDate`.
- **Ashby works.** An old rule said Ashby fails; it was wrong and cost a day.
- **Background shells need the venv Python by full path.** Otherwise MCP discovery finds zero tools and the run "succeeds" doing nothing.

## LinkedIn

- **An empty people search means throttling, not "no one".** Unipile returns HTTP 200 with `items: []` for every query during throttle windows. After about 5 empties in a row, wait 90 seconds or skip sourcing for the day. Invites and messages still work while this happens.
- **Restrictions arrived at about 112 invites a week**, well under LinkedIn's published numbers. Hence the shared cap of 170 a week, which only works when sends are spread out.
- **Send only through the MCP wrapper.** Raw API sends bypass the ledger, which then undercounts. Once the ledger said 36, the file had 125, and LinkedIn showed 148. The MCP now reconciles against LinkedIn's own sent list.
- **The ledger read the wrong field.** `invitation_id` was nested inside `unipile_response` for one producer, so its sends counted as zero. Fixed in `lib/invite-ledger.mjs`.
- **Re-read the thread right before sending.** A queued draft may be hours old. If you replied in the meantime, skip it.
- **A late reply is worse than none.** That's why replies aren't capped daily, only per run (25) as a runaway breaker.

## Hermes Agent

- **Config is read only at startup.** After any `hermes config set`, restart the gateway.
- **Context files get truncated silently.** `AGENTS.md` was over 36,000 characters, and the default `context_file_max_chars` of 30,720 dropped the tail on every turn for days. That tail held the tracker format rules. Set the limit to 40,000, and put hard rules in the cron prompt itself.
- **Two workdir jobs on the same minute block each other** (the `TERMINAL_CWD` lock, with a 660-second inactivity limit). Give each its own minute.
- **Run `hermes cron run` detached.** Under a short command timeout the CLI that owns the run is killed, and the run is left as `unknown`.
- **Model pins are per job.** Changing the default model doesn't move existing cron jobs; re-pin each one.
- **Cron jobs remember their delivery thread.** If a job was created inside a Slack thread, it keeps posting there forever. Check `deliver` when a report "didn't arrive".
- **Long Slack messages fail with `msg_too_long`.** Reports of 12,000+ characters need splitting.
- **Don't treat `last_status: ok` as proof.** Check the real artifacts (report file, ledger entries, cron output).
- **Exit non-zero only on total failure.** One failure out of 26 sends shouldn't mark the whole job failed.

## Subscription vs API billing

- **Unset `ANTHROPIC_API_KEY` for headless runs** that are meant to use the subscription. The jobs call `env -u ANTHROPIC_API_KEY claude -p ...`, and warm-outbound refuses to start if any `ANTHROPIC_*` variable is set.
- **An expired Claude login fails every run** with "Claude Code is installed but has no usable login". Run `claude auth login` again as the user the gateway runs as.
- **Don't spend an LLM turn on deterministic jobs.** Apply runs, warm invites and polling moved from Hermes crons to plain systemd timers. That stopped the token spend on work that needs no model.

## Writing

- **No em dashes, no flattery, no "I applied" without proof.** The application-answers skill enforces this, and the connection notes are grepped before sending.
- **Never name a past employer in outreach.** Grep the draft for every company in your CV before it goes out.
- **Count the 300 characters.** LinkedIn cuts a longer note silently.
- **Keep claim-checking sources fresh.** If you use NotebookLM to cross-check claims, delete and re-add a source after every edit. A stale snapshot approves claims your CV no longer makes.
