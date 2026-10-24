# Claude Code scheduled tasks (workstation side)

These are the prompt files behind Claude Code "scheduled tasks" (`~/.claude/scheduled-tasks/<task>/SKILL.md`,
registered through the `scheduled-tasks` MCP: `create_scheduled_task`, `list_scheduled_tasks`, `run_scheduled_task`).
Each task is just a frontmatter block (`name`, `description`) plus a long prompt that a fresh Claude Code
session runs unattended. Placeholders like `<CAREER_OPS_DIR>`, `<UNIPILE_API_KEY>`, `<YOUR_EMAIL>` replace personal values.

All four registered tasks were **disabled** at staging time (`enabled: false`), last fired 2026-10-11 (daily scans)
and on their one-off dates (outreach tasks). Cron values are as reported by `list_scheduled_tasks`.

| Task id | Schedule (local time, America/Chicago) | Purpose | Applies? | Sends? |
|---|---|---|---|---|
| `career-ops-scan-0415` | cron `15 4 * * *` (scheduler adds up to ~11 min random jitter; recorded jitter 651 s) | "Tsenta daily run": scan, JD-grounded gate at 4.0, apply via Tsenta, stage outreach drafts, refresh dashboard. Target 10 confirmed (COMPLETED) applications. | Yes (Tsenta MCP) | No. Outreach is drafted to `reports/runs/{date}-outreach-staged.md` only (send disabled 2026-09-09). |
| `career-ops-scan-1400` | cron `0 14 * * *` (jitter 49 s) | Afternoon twin of 0415. Adds STEP -1: read what the morning run already did, exclude it, respect the shared daily ceilings (about 40 Unipile actions/day across both runs; Tsenta credits are one shared pool). Adds a note that Unipile search can silently return total=0 when throttled. | Yes | No |
| `career-ops-scan-0515` | named for 05:15 (not in the scheduler registry at staging time) | Older scan-only variant: scan, evaluate JD-first, build 1-page LaTeX resume for every role >= 4.0, never submit anything. | No | No |
| `career-ops-scan-0615`, `career-ops-scan-0815` | named for 06:15 and 08:15 | **Byte-identical to 0515** except `name` and the time in `description`. Not staged separately. | No | No |
| `career-ops-scan-0715` | named for 07:15 | A one-line `/goal` prompt: fresh scan using career-ops + JobSpy, evaluate, resume for >= 4.0, find real LinkedIn contacts, draft connect note + email + follow-up, update the dashboard, "continue until 10 high fits". This is the style the later tasks explicitly moved away from (no quota of high fits; see `modes/_custom.md`). | n/a | n/a |
| `faang-outreach-send` | one-time, 2026-07-26 09:00 | Send two drafted connection notes through the Unipile REST API (search, pick one current employee per company, invite). Rewritten generically here. | No | Yes (raw Unipile API) |
| `retry-throttled-linkedin-invites` | one-time, 2026-08-20 13:53 | Retry two invites that hit Unipile `422 cannot_resend_yet`. Always `check_contacted` first; stop at the first 422. Rewritten generically here. | No | Yes (LinkedIn MCP) |

## Differences between the near-identical scans

* `0415` vs `1400`: identical pipeline text. `1400` additionally has STEP -1 (exclude morning work, shared ceilings),
  one extra NOTE in the outreach step (Unipile search throttle returns total=0 for every term; invites and messaging
  still work in that state), and its report must be labeled "AFTERNOON".
* `0515` / `0615` / `0815`: same file, no Tsenta, no outreach sending. Older "evaluate and build resumes, user applies" flow.
* `0415` / `1400` are the *current* design (apply through Tsenta behind a >= 4.0 evaluation gate). Their step list:
  load rules -> scan (Tsenta feed by `maxYearsExperience`, `scan.mjs --since 3`, `scan-ats-full.mjs --since 5 --include-undated`) ->
  shortlist -> gate (full JD, disqualifier grep, 0-5 rubric, fan out with the Workflow tool above ~8 JDs) ->
  apply only >= 4.0 (over-queue about 2x because ~40% come back JOB_EXPIRED and are refunded) -> outreach staged, not sent ->
  dashboard + tracker -> honest report.

## Conventions worth copying

* Every prompt begins with "Load the rules" and names the exact files that are the only source of truth for claims.
* Every prompt ends with an honest-report step that forbids padding the count. "Zero survivors" is a valid result.
* Sends are never done from a scheduled task. A human approves each LinkedIn send, which then goes through the `linkedin` MCP in an interactive session.
* The Workflow tool is configured so every `agent()` call is `model: 'sonnet'` (see `career-ops/CLAUDE.md.patch`).
