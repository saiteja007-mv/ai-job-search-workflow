---
name: linkedin-rolepost-actions
description: >-
  Triage LinkedIn role-posts and outreach-poller replies.
metadata:
  type: workflow
  version: 1.0.0
  author: hermes-curator
  license: MIT
  hermes:
    tags: [career-ops, linkedin, job-hunt, outreach]
    related_skills: [career-ops, linkedin-poster]
---

# linkedin-rolepost-actions — LinkedIn role-post action shortlist

This handles the **job-hunt** LinkedIn flow where <YOUR_NAME> reviews posts tied to his
target roles (AI/ML Engineer, Applied AI, ML, GenAI/LLM, MLOps, Data/Backend-with-AI)
and decides which to engage: contact a person, comment, or evaluate/apply to a role.

## When to Use

Use this when, in a job-hunt / recruiter thread, <YOUR_NAME> says something like:
"check the LinkedIn posts", "which LinkedIn posts are good to send",
"role-post action shortlist", "go on with your recommendations", "send #1",
or "do all" — and means the career-ops role-post engagement shortlist
(`reports/linkedin-post-engagement-*.md` + `data/linkedin-post-reply-queue.json`),
NOT the Postiz daily-AI-news content shortlist (`/home/<YOU>/postiz/last_shortlist.md`).

## CRITICAL disambiguation — two different "LinkedIn posts"

In <YOUR_NAME>'s setup there are TWO unrelated "LinkedIn posts" concepts. Picking the
wrong one wastes a turn.

| Signal in the user's message | Means | Artifacts |
|---|---|---|
| "LinkedIn posts" in a **job-hunt / recruiter** thread; "good ones to send", "role-post action shortlist", "which to send" | **Career-ops role-post engagement** — posts about his target roles, with a contact/comment/apply action queue | `reports/linkedin-post-engagement-YYYY-MM-DD.md`, `data/linkedin-post-reply-queue.json`, `data/linkedin-post-search-raw-YYYY-MM-DD.json` |
| "LinkedIn posts" in the **content / Postiz** channel; "post 3", "draft the AI-news one", scheduling his feed | **Daily AI-news content shortlist** for his LinkedIn *feed* (drafted + scheduled via Postiz) | `/home/<YOU>/postiz/last_shortlist.md` (use the `linkedin-poster` skill) |

Rule of thumb: if the thread is the job-hunt channel (`<SLACK_CHANNEL_ID>`) or a
recruiter/outreach context, "LinkedIn posts" = the **role-post action shortlist**.
Check `data/linkedin-post-reply-queue.json` first. Do NOT open the Postiz
`last_shortlist.md` for job-hunt triage.

## Where the shortlist lives

- Today's report: `/home/<YOU>/career-ops/reports/linkedin-post-engagement-<today>.md`
- Machine-readable approval queue: `/home/<YOU>/career-ops/data/linkedin-post-reply-queue.json`
  (each post has `id`, `action_type`, `score`, `company`, `title`, `location`,
  `post_url`/`job_url`/`apply_url`, `drafted_reply`/`connection_note`, `status`)
- The upstream cron is `<CRON_JOB_ID>` ("LinkedIn role-post engagement agent").
- The full governing workflow lives in the **user-owned** `career-ops` skill
  (`references/linkedin-role-post-engagement-cron.md`). This skill is a fast-path
  wrapper; defer to career-ops for deep detail.

## What "good / useful" means here

Each shortlist item carries a `score` (0–10) and `action_type`:
- `CONTACT_PERSON` — a recruiter/hiring manager/founder to reach. Highest ROI is
  usually a fit-check connection invite (drafted `connection_note`, <=300 chars).
- `JOB_POSTING` — a concrete role. These are tracked internally (added to
  `data/pipeline.md`); they need career-ops **evaluation + tailored PDF** before
  any application. Do NOT auto-apply.
- `COMMENT` — a public reply adds value (uses `drafted_reply`). Usually lower ROI
  than contacting a person; prefer contacts over generic comments.
- `APPLY_OR_DM` — post says apply/DM; treat like CONTACT_PERSON.
- `SKIP` — stale/spam/off-location/US-work-auth-blocked.

Recommendation pattern that worked well: send the top `CONTACT_PERSON` fit-checks,
evaluate/PDF the top `JOB_POSTING` roles, hold the rest, skip off-location ones
(e.g. a Pune/on-site role when the user wants US/remote).

## Autonomous mode (since 2026-09-11)

The daily cron `<CRON_JOB_ID>` now sends by itself: comments at score >= 7.5 through the runner
below, invitations/DMs at score >= 8 through the linkedin MCP (`get_invite_budget` →
`check_contacted` → `send_invitation` / `send_message`), 3 of each per run max. Held items carry
`pending_budget` and are retried for 3 days. The commands below remain for the case where
<YOUR_NAME> asks to act on a held item by hand.

## Acting on a held item (selective execution)

The queue runner is
`/home/<YOU>/career-ops/scripts/linkedin_post_queue_do_all.py`.
It sends ONLY approved items — run it from `/home/<YOU>/career-ops`:

```bash
# Send ONE approved item (preferred — never blast the whole queue):
python3 scripts/linkedin_post_queue_do_all.py --items 1
# Multiple approved items:
python3 scripts/linkedin_post_queue_do_all.py --items 1,6
# Legacy "do everything pending" (only when user explicitly says do all):
python3 scripts/linkedin_post_queue_do_all.py
```

Behavior:
- `COMMENT`/`JOB_POSTING` → posts public comment via `drafted_reply`.
- `CONTACT_PERSON`/`APPLY_OR_DM` → DM if already connected + writable chat, else
  sends a connection invite (<=300 chars, `connection_note`).
- Idempotent: re-runs skip already-logged items.
- Output: prints `sent`/`failed` with IDs; writes
  `reports/linkedin-post-actions/post-actions-*.json` and appends
  `data/linkedin-post-action-log.json`.

**Always pass `--items` for a subset.** Without it the script sends every
`pending_approval` item at once — dangerous for a shortlist of 8.

**Queue-schema and post-URN compatibility:** Current queues may use
`contact_profile_url` / `author_contact` rather than older `contact_profile` /
`author`, so the runner must support both. LinkedIn share URLs can contain a number
that differs from the authenticated search result's actual `raw.social_id`; if a
comment fails with `errors/invalid_post`, recover the matching raw post from
`data/linkedin-post-search-raw-YYYY-MM-DD.json`, store its authoritative
`urn:li:activity:...` as `post_urn` on the queue item, reset only that approved
item to `pending_approval`, and rerun it. Never substitute another post.

## Mixed-action split (the usual approval case)

When the user says "go on with your recommendations" on a shortlist mixing
`CONTACT_PERSON` and `JOB_POSTING`:
1. **CONTACT_PERSON items** → send the connection invite via the runner with
   `--items <ids>` (external action; only after explicit approval).
2. **JOB_POSTING items** → do NOT apply. Run career-ops evaluation/PDF in a tracked
   worker and report score/PDF/blockers for the user's manual or Tsenta apply:
   ```bash
   claude --settings '{"ultracode": true}' -p "Evaluate <company> <role> from the
   YYYY-MM-DD role-post shortlist against cv-aiml.md and config/profile.yml; generate
   a tailored PDF only if it clears the 4.0/5 gate; update data/applications.md;
   write reports/<slug>.md. Do NOT submit applications. Verify PDF with pdftotext
   for no '<YOUR_CITY>' and no markdown artifacts." \
     --workdir /home/<YOU>/career-ops   # background=true + notify_on_complete=true
   ```
3. Report: sent-invite IDs, evaluation scores, PDF paths, and any blockers.

## Outreach-poller replies that need you (recruiter asks for resume by email)

The accepted/replied poller writes events to `data/linkedin-events.jsonl`, keyed by
`provider_id`, `chat_id`, `kind` (`accepted`/`replied`), `status`, `thread`, `draft`.
When a `replied` event has `status: needs_you` with
`send.skipped: "draft promises an action ..."`, the LinkedIn reply promised an off-LinkedIn
action (usually "I'll send my profile to <email>"). Once <YOUR_NAME> says he replied, the promise
is still open until the email actually exists. Close it:

1. `grep <provider_id or name> data/linkedin-events.jsonl` for the thread and the promised
   address, and read the live chat back (`GET /chats/{chat_id}/messages`) to confirm what he sent.
2. Check nothing already went out: Unipile `GET /emails?account_id=<UNIPILE_GMAIL_ACCOUNT_ID>&folder=SENT&limit=8`
   (jobmail, the job-hunt address), plus the personal Gmail if unsure.
3. Create a **Gmail draft only** (never send directly):
   `gog gmail drafts create --account <YOUR_EMAIL> --client jobmail --to <addr> --subject "<YOUR_NAME> - Profile (<YOUR_CITY> | <VISA_STATUS>) - <role>" --body-file <scratch.txt> --attach <resume.pdf> --json --no-input --force`.
   Body answers exactly what the recruiter asked (location: <YOUR_CITY>, remote/hybrid/onsite,
   can relocate; work auth: <VISA_STATUS> with EAD dates, sponsorship need as per profile;
   availability), a 2-line proof summary including the self-hosted AI home lab, the role applied
   for, a short-call ask, and a signature with phone, jobmail email, `linkedin.com/in/<YOUR_LINKEDIN_ID>`,
   and `<YOUR_DOMAIN>` (take links from `cv-aiml.md`, not memory).
   Resume: newest general AI/ML PDF in `output/` (`ls -t output/*.pdf | grep -v '^output/[0-9]'`);
   say which one you attached and offer the MLOps / AI Engineer variants.
4. <YOUR_NAME> sends it himself from Gmail or says "send it". Verify via the Unipile SENT folder
   (subject, recipient, attachment name); it is the read-back that works without a TTY, since
   `gog gmail search` can require an interactive keyring password.
5. Offer a LinkedIn follow-up reminder ~2 business days later if there's no reply.

## Stale profile URLs and count mismatches

The same LinkedIn career-outreach machinery is also used by daily recruiter lists. If
an approved named profile returns Unipile HTTP 422 `errors/invalid_recipient`, do
not discard the target or substitute an arbitrary person to hit a round batch
count. Recover the current profile through authenticated LinkedIn people search,
verify exact name + matching headline/company, replace the stale canonical URL,
and rerun the normal dry-run. The corrected URL can reveal an older invitation in
`data/outreach_log.json`, preventing a duplicate send. Reconcile the daily contacts
bucket from real HTTP 201 log events and report actual source count, new sends, and
prior sends separately.

Full runbook: `references/stale-profile-resolution-and-outreach-dedupe.md`.

## Pitfalls

- **Don't confuse the two "LinkedIn posts"** (see table above). Job-hunt thread →
  role-post queue; content channel → Postiz shortlist + `linkedin-poster`.
- **Never auto-apply** `JOB_POSTING` items. Comments/DMs/invites are the only
  external actions the queue runner takes. Applying is a separate gated step
  (evaluate → PDF → manual/Tsenta apply; check Tsenta quota first).
- **Verify location/work-auth** before recommending. A Bay Area/remote role is a
  strong send; a Pune/on-site role is usually skip unless the user wants a
  clarification DM.
- **Account id** for Unipile sends: `<UNIPILE_LINKEDIN_ACCOUNT_ID>` (<YOUR_NAME>).
  Re-verify if the queue file is old.
- **Don't expose API keys** or message history in the summary.

## Overlap note

This skill overlaps the user-owned `career-ops` skill (its
`references/linkedin-role-post-engagement-cron.md` is the canonical source). It
exists because career-ops is protected from autonomous edits; the disambiguation
and `--items` selective-execution lessons should be merged into career-ops via
`hermes curator adopt career-ops` so there is one source of truth.
