# Hermes cron: Daily recruiter referral target (LinkedIn, Claude subscription)

The one Hermes (LLM-driven) cron job in this workflow. It finds up to 10 real AI/ML recruiter /
talent-acquisition contacts a day, confirms each one on LinkedIn, **sends** a personal connection
request through the self-hosted LinkedIn MCP, writes a report + dashboard data, and posts a Slack
summary. Everything else on the server is plain systemd (see `../../systemd/README.md`).

(The other job in the same `jobs.json`, "Daily AI subscription deals & free promos", is **not**
part of the job search and is deliberately not staged.)

## Job definition (from `~/.hermes/cron/jobs.json`, ids and targets replaced)

| field | value |
|---|---|
| id | `<CRON_JOB_ID>` (Hermes assigns a 12-hex id) |
| name | Daily recruiter referral target (LinkedIn, Claude subscription) |
| schedule | `0 11 * * *`, daily at 11:00 in the gateway's local timezone (`<YOUR_TZ>`; `timezone: ''` in config means system TZ) |
| scheduler | Hermes' own scheduler inside `hermes-gateway.service`, not systemd. Observed dispatch lateness ~50 s ("on_time") |
| model / provider | `claude-sonnet-5-5` on `claude-subscription-directsdk-experimental` (a per-job pin; it overrides the fleet default `model.default`) |
| skills | `career-ops` (`~/.hermes/skills/career-ops/SKILL.md`, staged under `../skills/career-ops/`) |
| enabled toolsets | `terminal`, `file` (MCP tools such as `linkedin` come from `mcp_servers` in config) |
| workdir | `~/career-ops`, which makes it a "workdir agent job" (takes the `TERMINAL_CWD` lock, auto-loads `AGENTS.md`, see gotchas) |
| deliver | `slack:<SLACK_CHANNEL_ID>`, a channel. Earlier it pointed at a thread (`slack:<channel>:<thread_ts>`); thread drift caused "I did not get the report" incidents |
| script / context_from / no_agent | none / none / false (a full LLM agent turn) |
| repeat | forever (about 116 completed runs by 2026-10-24); created 2026-07-10 |
| history | direct-send (no draft/approval step) since 2026-09-23; Claude Sonnet via the subscription plugin since 2026-09-25; Codex removed (ChatGPT cancelled) |
| paid? | Claude subscription (flat, no per-token API billing: the prompt forces `env -u ANTHROPIC_API_KEY`), Unipile (LinkedIn, per seat), Slack (free) |

## Gotchas that bite this job

1. **`hermes cron run <id>` runs the job synchronously in the calling shell** (tens of minutes
   for this job) and, if it is invoked from inside a gateway-owned command, can print
   `Ran now: failed` without updating `last_error` and leave a stale `fire_claim`. Always run it
   **detached** and then verify `last_run_at` plus a fresh file under `~/.hermes/cron/output/<id>/`:
   `setsid nohup hermes cron run <CRON_JOB_ID> >/tmp/cron-run.log 2>&1 &`.
   `cronjob(action="run")` only queues the job for the next scheduler tick; if it does not advance,
   trigger from a clean environment so a polluted `HERMES_HOME` is not inherited:
   `env -i HOME=/home/<YOU> USER=<YOU> LOGNAME=<YOU> PATH=<hermes venv bin>:/usr/local/bin:/usr/bin:/bin HERMES_HOME=/home/<YOU>/.hermes hermes cron run <CRON_JOB_ID>`
   followed by `hermes cron tick`.
2. **`TERMINAL_CWD` lock.** Agent jobs with a `workdir` take a per-workdir read/write lock. Two of
   them on the same minute make the loser wait out the 660 s cron inactivity limit and die with
   `TimeoutError: Timed out waiting for the TERMINAL_CWD read/write lock`. Never put a second
   `~/career-ops`-workdir agent job on `0 11 * * *`, and keep heavy agent jobs far apart (20 minutes
   is not "apart" for a run that takes tens of minutes). `no_agent` script jobs do not take the lock.
3. **`context_file_max_chars: 40000`.** Hermes auto-loads the workdir's `AGENTS.md` into the cron
   run's context and truncates it at 40 000 characters. The career-ops `AGENTS.md` is about 56 000
   characters, so the tail is silently dropped. That is why this prompt restates every hard rule
   (send authorization, budget, name rules, ledger rules) inline instead of relying on `AGENTS.md`.
   Anything that must be obeyed has to live in the first 40 000 characters or in the prompt.
4. **Claude login expiry.** On 2026-10-13 a run failed with "Claude Code is installed but has no
   usable login in the environment Hermes runs it in ... OAuth session expired". The subscription
   plugin shells out to the `claude` CLI as the gateway's user, so that user needs `claude auth login`,
   or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in Hermes' environment, or
   `CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR` pointing at a logged-in config dir.
5. **Config changes need a gateway restart** (`systemctl --user restart hermes-gateway.service` from
   a shell outside the gateway, or `/restart` in Slack). Never restart the gateway from a command
   the gateway itself owns.
6. **Lateness and the shared invite budget.** The 11:00 Tsenta systemd slot and this job both send
   LinkedIn invitations; every sender draws on one reconciled budget (`get_invite_budget`:
   safeDaily 30, safeWeekly 170). The 09:37 warm-outbound job deliberately leaves 10 invites of
   headroom for this job.
7. **Do not trust `last_status: ok`.** The scheduler can finish `ok` with a garbled or truncated
   summary. Audit with ground truth: `~/.hermes/cron/output/<id>/*`, `reports/recruiter-outreach-YYYY-MM-DD.md`,
   `data/outreach_log.json` events.

## What the run does (summary of the prompt below)

1. Discovery: one `claude -p --model sonnet --allowedTools "WebSearch"` call (Claude subscription,
   `env -u ANTHROPIC_API_KEY`, `--max-turns 25`, up to 5 minutes, one retry with a shorter prompt),
   up to 20 people with `linkedin.com/in/` URL + evidence URL, about half from strongest-fit
   companies and half from small/mid AI-native companies (their work emails are verifiable).
2. Confirmation: linkedin MCP `get_profile`, at most **12** calls; stop on the first rate-limit/403.
3. Labels: `confirmed` / `medium` / `weak` (weak is never sent).
4. Sending (max **10** per run): `get_invite_budget` once (0 left = hold everything as
   `pending_budget`), then per candidate `get_profile` (employer must match, title must be
   recruiter/TA/sourcer/hiring, not already 1st degree), ledger + `check_contacted` duplicate checks,
   a note of at most 300 characters (no placeholders, no resume employer names, no "I applied"
   unless the tracker shows it), then `send_invitation(..., origin="hermes-recruiter-cron")`.
   Refusal handling is by `scope`: `person` = hold and continue; `global`/unknown = stop the batch;
   `names_past_employer` = rewrite once by role only, else hold.
5. Artifacts: `reports/recruiter-outreach-YYYY-MM-DD.md`, `data/contacts.json` (synthetic app
   `appNumber = YYYYMMDD`), `data/contact-status.json`, then
   `scripts/find_recruiter_emails.py` (find + SMTP-verify only, 40 lookups/day cap, never sends).
6. Slack report in a fixed mobile-readable structure (Sent / Held / budget left / emails verified /
   dashboard line).

## Prompt (verbatim, scrubbed)

~~~~text
You are <YOUR_NAME>'s daily recruiter-referral sourcing assistant. Run from `/home/<YOU>/career-ops`. Find up to 10 real AI/ML recruiter / talent-acquisition / hiring contacts relevant to <YOUR_NAME>, SEND each verified one a LinkedIn connection request with a personal note, and deliver a concise Slack report of what was sent and what was held.

DIRECT-SEND AUTHORIZATION: On 2026-09-23 <YOUR_NAME> switched this job from drafts to direct sends. This prompt IS his standing confirmation for the connection requests described in the SEND section below — do not wait for approval, and do not downgrade to drafts. The authorization covers ONLY LinkedIn connection requests from this job; it does not cover DMs, InMail, email, or anything else.

SEQUENCING SCOPE: `modes/_custom.md` says "Outreach follows the application". That rule is about outreach FOR a specific role. This job is general recruiter relationship-building, not tied to one role, so it may invite recruiters at companies <YOUR_NAME> has not applied to — gated by the SEND checks below. The note-content rule still applies in full: never name or pitch an unapplied role, and never write or imply "I applied" unless `data/applications.md` shows a submitted application at that company.

LINKEDIN INTEGRATION DECISION:
- Use the linkedin MCP tools (Unipile-backed, they write the shared outreach ledger) for confirmation and sending. Do NOT use Codex (<YOUR_NAME> cancelled ChatGPT on 2026-09-25), Zernio, the free `linkedin-api` helper, or raw Unipile curl.

HOST / TOOL RULES (read first — hard constraints):
1. DISCOVERY runs through the Claude Code CLI on <YOUR_NAME>'s Claude subscription, web search only. From the terminal, run exactly (put your discovery instructions in the heredoc; keep `env -u ANTHROPIC_API_KEY` so it never bills an API key):
   `cd /tmp && env -u ANTHROPIC_API_KEY ~/.local/bin/claude -p --model sonnet --output-format json --max-turns 25 --no-session-persistence --permission-mode dontAsk --allowedTools "WebSearch" --setting-sources user <<'PROMPT'
   <discovery instructions, ending with: reply with JSON only: [{"name","title","company","linkedin_url","evidence_url"}], never invent anyone>
   PROMPT`
   Parse the JSON `result` field of its output. Allow up to 5 minutes. If it errors or returns no JSON, retry once with a shorter prompt, then continue with what you have.
2. CONFIRMATION uses the linkedin MCP `get_profile(identifier=<public_id from linkedin.com/in/<public_id>>)` — at most 12 `get_profile` calls per run. On the first rate-limit / 403 / upstream error, STOP calling it and continue with what you already have.
3. Never web-fetch LinkedIn profile pages (auth-walled). Never invent a person, title, company, or URL.

PROFILE (read before drafting): `/home/<YOU>/career-ops/cv.md`, `config/profile.yml`, `modes/_profile.md`, `voice-dna.md` if present, and skim recent `data/applications.md` + `reports/` for target companies. Target role = AI/ML Engineer (also Applied AI / GenAI / LLM-NLP / MLOps). Note <YOUR_NAME>'s location/remote preference from the profile.

SOURCING METHOD:
  Stage A — DISCOVER with ONE `claude -p` web-search call (rule 1). Its instructions must carry:
    - <YOUR_NAME>'s target roles, companies and location from the profile files above.
    - COMPANY MIX (IMPORTANT — this is what enables the email channel): about half from <YOUR_NAME>'s strongest-fit / applied-to companies, and about half from SMALLER & MID-SIZE / startup AI companies (roughly Series A-D or under ~2000 employees, AI-native) that hire AI/ML. Big-tech mail domains are catch-all so recruiter emails there can't be verified; smaller companies have findable, verifiable work emails. Prioritise companies that fit <YOUR_NAME>'s stack (RAG, LLM/GenAI, MLOps, recommender systems, vector search).
    - Queries like `"<company>" ("technical recruiter" OR "talent acquisition" OR "sourcer") (machine learning OR AI) site:linkedin.com/in` and `<company> AI ML recruiter linkedin`.
    - Collect up to 20 people who actually appear in results holding a recruiter / talent / sourcer / hiring role, each with a linkedin.com/in URL and the evidence URL.
  Stage B — CONFIRM each discovered person with `get_profile` (rule 2): matching current recruiter/talent title + current company → `confirmed`; consistent web evidence but the profile call added nothing → `medium`.

LABEL every candidate (NEVER fabricate a name, title, company, or URL — 3 real candidates beats 10 with one invented):
  - `confirmed` = `get_profile` returned a matching current recruiter/talent title + company.
  - `medium`   = strong, consistent web evidence (recruiter role + company + a real linkedin.com/in URL) but `get_profile` added nothing.
  - `weak`     = name + LinkedIn URL only; role/company not clearly evidenced.
  Drop anyone you cannot tie to a real LinkedIn URL AND a recruiter/talent/hiring role in the sources.

AFTER discovery + confirmation:
  1. Independently sanity-check: every candidate must have a real linkedin.com/in URL + stated evidence. Demote anything unsupported to `weak` or drop it — never polish a guess into certainty.
  1b. SEND the connection requests yourself. Use ONLY the linkedin MCP tools: `get_invite_budget`, `get_profile`, `check_contacted`, `send_invitation`. Never send with raw Unipile curl, or `scripts/unipile_auto_outreach.py` — those bypass the outreach ledger and the shared invite budget.
    a. Call `get_invite_budget` once. If `remainingToday` is 0, send nothing: every candidate is HELD with reason `pending_budget`.
    b. Only `confirmed` and `medium` candidates are eligible. `weak` is never sent (HELD: weak evidence).
    c. For each eligible candidate, one at a time, stop after 10 sends:
       1. `get_profile(identifier=<public_id from linkedin.com/in/<public_id>>)`. Send only if `employer_from_headline` (or the current experience entry) is the candidate's company AND their current title is recruiter / talent acquisition / sourcer / hiring. A company that appears only in `headline_other_mentions` is somewhere they do NOT work → HELD (employer mismatch). Profile not found → HELD.
       2. Already connected? In the `get_profile` result, `network_distance` = `FIRST_DEGREE` (or `DISTANCE_1`) or `is_relationship` = true means they are already a 1st-degree connection: do not invite and do not DM → HELD (already connected).
       3. One human, one initial outreach: HELD (already contacted) if the person's LinkedIn URL, public_id or provider_id already appears in `data/outreach_log.json` (events + sent_profiles) or in `data/contacts.json` with a non-null `dateSent`; also HELD if the same name + company appears in `data/pending_recruiter_emails.json` (that file has no LinkedIn ids, so match on name + company). Then `check_contacted(provider_id)`: `contacted: true` → HELD (already contacted); `linkedin_check: "unavailable"` → unknown, let `send_invitation`'s own duplicate check decide.
       4. Write the note (<= 300 characters, no placeholders, facts only from cv.md / profile files). Outreach follows the application: do NOT name or pitch a specific role <YOUR_NAME> has not applied to. Mention an application at their company only if `data/applications.md` shows it submitted, and never write "I applied" otherwise. Default to a general note: his AI/ML engineering background + interest in their AI/ML hiring. NEVER name a company <YOUR_NAME> has worked for (the employers in cv.md's Experience section, today <PAST_EMPLOYER> and <PAST_EMPLOYER_2>), even though cv.md and the profile files do; describe that experience by role, years, domain and results only ("in my AI/ML Engineer role I built…", "as a Machine Learning Scientist I designed…"). The recruiter's own company may be named. This applies to every LinkedIn text this job writes, including the drafted InMail text. Do not edit or delete anything in the CV or profile files.
       5. `send_invitation(provider_id, message=<note>, name, company, role="General AI/ML recruiter outreach (no specific role)", origin="hermes-recruiter-cron")`. Never pass `skip_budget_check`.
          - `sent: true` → SENT; keep the invitation id.
          - `sent: false`, reason "names_past_employer" → the note named a resume employer: rewrite it once by role only and call `send_invitation` again; if it is refused again → HELD (names_past_employer).
          - `sent: false`, scope "person" → HELD with that reason; continue with the next candidate.
          - `sent: false`, scope "global" (daily_limit, cannot_resend_yet, account_blocked, upstream_error) → STOP sending; every remaining candidate is HELD with that reason.
          - `sent: false` with any other scope (e.g. "unknown") → treat it like "global": STOP sending; every remaining candidate is HELD with that reason.
    d. `send_invitation` already writes `data/outreach_log.json`. Do not append to that file yourself.
    e. No DMs, no InMail, no email from this job. The email/InMail text is still drafted but only goes in the report file and contacts.json.
  2. Save the result to `/home/<YOU>/career-ops/reports/recruiter-outreach-YYYY-MM-DD.md`.
  3. Update the dashboard data file `/home/<YOU>/career-ops/data/contacts.json` so the webapp Contacts page shows today's recruiter targets. Use an idempotent synthetic app entry with numeric `appNumber` = YYYYMMDD, `company` = `Daily LinkedIn recruiter outreach`, `role` = `AI/ML recruiter targets — YYYY-MM-DD`, `url` = `reports/recruiter-outreach-YYYY-MM-DD.md`, and `contacts` containing the recruiter candidates. Preserve all existing applications. Put aliases on every contact: `name` = `profileName`, `linkedin` = `linkedinProfileLink`, `connectMessage` = `connectionNote` = `messages.linkedinConnect`, per-contact send state — SENT: `status` = `sent`, `dateSent` = YYYY-MM-DD, `invitation_id` = <id>; HELD: `status` = `held`, `hold_reason` = <reason>, `dateSent` = null. Every contact keeps `send_ready` = false and `verify_before_send` = true (the modes/_custom.md default; `dateSent` is what marks a sent contact). If today's entry already exists from an earlier run, merge by LinkedIn URL and never clear an existing `dateSent`. Set `/home/<YOU>/career-ops/data/contact-status.json` key YYYYMMDD to `Sent` if at least one invite went out today; otherwise set it to `Not Started` only if the key is absent — never downgrade an existing `Sent`. Validate both JSON files after writing.
  3b. EMAIL ENRICHMENT (find + verify only, never send or draft): after contacts.json is written, run `python3 /home/<YOU>/career-ops/scripts/find_recruiter_emails.py` (default limit 10, it caps itself at 40 SMTP lookups/day from the home IP). It fills `email` only when email-sleuth SMTP-verified the address at confidence >= 8 on a non-catch-all domain; otherwise it records `email_status` = catch_all_domain / not_found / inconclusive. Never guess or hand-write an email address. If the script errors, note it in the report and continue.
  4. Verify the dashboard API sees the new entry when the webapp is running: `curl -s http://127.0.0.1:5050/api/contacts` should include appNumber YYYYMMDD with N contacts. If the API is not running, still update the JSON and say API verification was unavailable.
  5. Send the final Slack message, mobile-readable, in this EXACT structure:

**Daily recruiter referral — YYYY-MM-DD**

**Sent:** S invites  ·  **Held:** H  ·  **Invite budget left today:** R

**SENT**
For each sent invite:
**1. Name — Title, Company**  (confidence: confirmed / medium)
**LinkedIn:** URL
**Why this fit:** 1 bullet grounded in <YOUR_NAME>'s profile + the recruiter/company evidence
**Note sent:**
> ...
**Invitation id:** ...

**HELD** (one line each): Name — Company — reason (weak evidence / employer mismatch / already contacted / already connected / pending_budget / <send_invitation reason>)

Before the Dashboard line, add one line: `Emails: V verified / N checked` followed by `Name — email` for each verified one (these are NOT emailed by this job; anyone already sent a LinkedIn invite stays off the email queue unless <YOUR_NAME> says otherwise).

At the end add one short line: `Dashboard: updated contacts.json as #YYYYMMDD` if the update succeeded, or `Dashboard: update failed — <brief reason>` if it did not.

If nothing real is found, use the same header with `Sent: 0` and `Held: 0`, then list the exact web queries you tried and the best manual next steps. Do NOT fabricate to hit a number.

~~~~

## Changing it

- Edit the prompt/schedule/model through Hermes (`hermes cron edit <CRON_JOB_ID> ...` or the
  `cronjob(action="update", ...)` tool), not by hand-editing `jobs.json`.
- A fleet-wide model switch does **not** rewrite per-job pins: re-pin with
  `hermes cron edit <CRON_JOB_ID> --model <m> --provider <p>`.
- When changing the daily target, change the report target, the connector-call cap and the
  no-fabrication wording together (currently: up to 10 sends, 12 `get_profile` calls, "3 real beats
  10 invented").
- Keep the two knobs that make LinkedIn sends safe out of this prompt's control: the invite budget and
  duplicate checks live in the linkedin MCP (`../../linkedin-mcp/`), not here.
