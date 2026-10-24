---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | deep | pdf | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | update]"
---

# career-ops -- Router

## Session learnings / pitfalls (sync + pipeline + tracker + resume PDFs)

- **Recruiter email sending uses `gog` Gmail auth for jobmail. If `send_recruiter_emails.py` fails on keyring/OAuth, use `references/gog-jobmail-oauth-recovery.md` before retrying: restore `GOG_KEYRING_PASSWORD`, avoid Slack-mangled long OAuth URLs with a local helper page, import a top-level `{email, refresh_token}` token when PTY input truncates, dry-run, send, and verify SENT + queue state.
- **Recruiter email draft verification can fail because Reoon has no credits:** If the email draft cron reports `Reoon:verify_error` or queues 0 despite recruiter reports, probe one known email against Reoon and inspect HTTP JSON. HTTP 403 with `Not enough credits available. Please recharge.` means the verification account needs credits; surface that reason, do not misdiagnose as “no emails found.” Apollo-provided work emails can be used as a manual fallback, but still queue drafts and require explicit approval before sending. See `references/recruiter-email-draft-pipeline.md`.

- If you are parsing `config/profile.yml` or other YAML/JSON using Hermes `read_file`, **strip the `LINE|` prefixes first** (see `scripts/strip_read_file_prefix.py`). Otherwise YAML parsing can fail.
- `merge-tracker.mjs` expects TSV files in `batch/tracker-additions/` whose **filename begins with a numeric report id** (e.g., `353-cohere-health.tsv`). Date-prefixed files like `2026-05-22-...tsv` can be skipped as invalid entry number.
- `merge-tracker.mjs` only updates existing tracker rows when the **new score is higher**; it will not flip PDF/status fields just because a PDF was generated later. Ensure the first insert has the correct PDF marker, or do a separate sync step.
- **Scheduled/cron runs can produce misleading summaries** (garbled output, max-turn cutoff, tool-call JSON dumped into the log). When asked how did the pipeline go over the last N days?, **audit via ground-truth artifacts**:
  - cron logs: `~/.hermes/cron/output/<job_id>/...`
  - reports: `career-ops/reports/*-YYYY-MM-DD.md`
  - PDFs: `career-ops/output/*.pdf`
  Also watch for **artifact drift**: report header claims `PDF: ` but the file is missing in `output/`.
- **Nightly job submissions sync OAuth recovery:** If `job_tracker_sync.py` or the cron fails with `oauth2: "unauthorized_client"`, do not trust `gog auth list` alone. Verify direct Gmail + Sheets calls, delete only the stale token, re-run `gog auth add ... --manual --force-consent`, then verify Gmail search, Sheets read, and `job_tracker_sync.py` before saying fixed. Details: `references/gog-oauth-job-sync-recovery.md`.
- Some job aggregators (ZipRecruiter/Indeed redirects) may block automated fetches. Prefer the ATS canonical source (e.g., Greenhouse Boards API) or mark as BLOCKED and request the JD text.
- **LinkedIn role-post → Workday JD recovery:** When a recruiter LinkedIn post links through `lnkd.in` and the browser/shortlink lands on login, CAPTCHA, or Microsoft/MyApps auth, do not stop at the LinkedIn post text. Resolve the role by searching the employer's Workday CXS API directly: `POST https://<tenant>.wd5.myworkdayjobs.com/wday/cxs/<org>/<site>/jobs` with JSON `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"<distinct role terms>"}`, then fetch the selected posting at `GET https://<tenant>.wd5.myworkdayjobs.com/wday/cxs/<org>/<site><externalPath>` to read `jobPostingInfo` (title, req ID, locations, salary, full HTML JD, externalUrl). Use this to evaluate fit and produce grounded outreach without relying on blocked shortlinks.
- When auditing career/job-submission cron jobs, **do not trust cron `last_status: ok` alone**. Read the latest report under `~/.hermes/cron/output/<job_id>/` and inspect the response JSON; the scheduler can finish `ok` while the underlying Google sync reports `success: false`.
- For `gog` OAuth failures in the nightly submissions sync (`unauthorized_client`, `deleted_client`), fix auth first: run a direct `gog gmail messages search ... --account <YOUR_EMAIL> --json` probe, then use `gog auth add <YOUR_EMAIL> --services gmail,sheets,drive --manual --force-consent` and submit the user's redirected localhost URL to the waiting PTY process. See `references/gog-oauth-cron-troubleshooting.md`.
- **Deep-scan recovery after stalls:** If a Claude Code/deep-scan continuation times out or hangs after producing reports, do not blindly rescan. Audit ground-truth artifacts (`reports/`, `batch/tracker-additions/`, `output/`, `data/contacts.json`), finish missing phases manually, then run merge + verification. Dashboard API quirks and exact verification probes are in `references/2026-06-27-deep-scan-verification.md`.
- **Terse “complete the pipeline” requests:** Treat this as career-ops `pipeline` mode in `/home/<YOU>/career-ops`, not as a generic status note. First run the repo health checks (`node update-system.mjs check`, `node cv-sync-check.mjs`) and count pending `- [ ]` lines. If the pending set is large or needs Claude Code, start a tracked `claude --settings '{"ultracode": true}'` worker in the career-ops workdir with a self-contained prompt, `background=true`, and `notify_on_complete=true`. Do not claim the pipeline is complete while the worker is still running; report it as “started/running” with the process/session id, current verified counts, and the artifact/report path expected on completion. If Playwright/liveness setup is missing, do not silently install during the job; either get approval for the setup fix or instruct the worker to use deterministic ATS/direct-HTTP triage and explicitly log the Playwright blocker in the completion report.
- **Company/search inventory reports:** When <YOUR_NAME> asks what companies career-ops has or is searching for, report separate buckets from ground truth: configured direct search targets (`portals.yml`), companies actually found by scans (`data/scan-history.tsv`), and companies in tracker/applied (`data/applications.md`). Use `node stats.mjs --json` for canonical counts. Do not collapse these buckets; <YOUR_NAME> is asking about both search coverage and current pipeline. Runbook: `references/company-and-nb-reporting.md`.
- **Constrained fresh scans (tier/freshness/company subset):** `node scan.mjs --help` is not a help command; unrecognized args are ignored and can trigger a real full scan/write. For requests like “Tier 1 companies with freshness 2 days,” do **not** run raw `node scan.mjs` unless the requested filters are represented in config/flags. First resolve the tier list from `reports/company-tiers-*.md` or `portals.yml` notes, then use provider APIs/`postedAt` metadata to filter by posting age before appending to `pipeline.md`/`scan-history.tsv`. Exclude undated postings when the user explicitly asks for freshness. If an accidental overbroad scan writes rows, immediately back up and remove only the rows from that run before doing the constrained scan. Detailed runbook: `references/constrained-fresh-scans.md`.
- **Company database expansion:** When <YOUR_NAME> asks to widen the companies database or find stronger lead sources, research a source stack instead of adding random companies: official ATS feeds first, then AIStackJobs, OnlyNerds, Simplify visa/new-grad lists, USCIS/DOL <FUTURE_VISA> data, and Reddit/community signals via `agent-reach`/`last30days`. Canonicalize leads to official ATS/career URLs before adding to `portals.yml`; for stronger inclusion requests, require companies to pass at least 3 quality gates and treat Gate 1 (official ATS/career source) + Gate 5 (direct employer, not staffing/consultancy) as mandatory. After editing, verify `portals.yml` parses, run dry scans for representative added companies, and tune title/content filters for discovered false negatives/positives (e.g. include AI software-engineering title variants; exclude postdoc variants for non-target roles). Report net-new companies vs already tracked. Runbook: `references/company-database-expansion-sources.md`.
- **Agency/consultancy app reports:** For "Agency apps" short reports, refresh with `CAREER_OPS_DIR=/home/<YOU>/career-ops bash deploy/sync-run.sh` when currentness matters, then parse `agency-applications/_raw/records_clean.json`. Emphasize interviews/assessments and recent status counts; treat raw `Submitted` as dedupe/background signal, not recruiter interest. Runbook: `references/company-and-nb-reporting.md`.
- **Outreach contacts must be verifiable:** For LinkedIn/contact sourcing, never invent names, titles, or profile URLs. If public search cannot verify current real profiles, write an honest empty `contacts: []` entry with notes/manual sourcing targets and say so in the final summary.
- **Unipile LinkedIn messaging integration:** When <YOUR_NAME> provides Unipile credentials for autonomous outreach, store them only in `/home/<YOU>/career-ops/.env` (`UNIPILE_API_BASE`, `UNIPILE_API_KEY`), set `chmod 600`, ensure `.env` is gitignored, and verify with a read-only `GET /accounts` probe before any sending. Do not print the API key. Current known account id is `<UNIPILE_LINKEDIN_ACCOUNT_ID>`, but re-verify before sends. Full runbook: `references/unipile-linkedin-outreach-api.md`.
- **After Unipile sends, sync the dashboard state immediately:** The Career-Ops webapp outreach badge is driven by `data/contact-status.json` (`appNumber` → `Sent`/`Skipped`/etc.), not by `data/outreach_log.json` alone. After sending or skipping already-sent recruiter outreach, update the relevant app numbers to `Sent` and verify via `/api/contact-statuses` if the dashboard is running. Also update matching contacts in `data/contacts.json` with `dateSent: YYYY-MM-DD` only when the actual send date is known from Unipile/outreach_log; if Unipile returns `422 errors/already_invited_recently`, set the app/contact badge to `Sent` but leave `dateSent` blank unless the real invite date can be verified. The `/api/contact-statuses` response may be wrapped as `{ "statuses": { ... } }`; check `data.get("statuses", data)` instead of assuming top-level app keys.
- **Unipile auto-outreach partial success semantics:** `scripts/unipile_auto_outreach.py` can exit non-zero / return `ok:false` even after successfully sending some invitations, commonly when later candidates hit `errors/already_invited_recently`. Do not discard the run as failed. Parse the JSON body first: count `sent[]` with HTTP 201 as real sends, treat `skipped[]` as idempotent skips, treat `failed[]` entries with `errors/already_invited_recently` as handled-but-date-unverified, then sync/validate `contacts.json`, `contact-status.json`, and `outreach_log.json` from the parsed outcome.
- **Zernio LinkedIn integration boundary:** If <YOUR_NAME> asks whether Zernio can manage career outreach, verify the account read-only but do not assume it can send LinkedIn DMs. Zernio is useful for LinkedIn posting/scheduling/media/first-comment workflows; LinkedIn DMs are blocked for third-party apps, so recruiter outreach should still use Unipile first and the LinkedIn Gateway backup second. Store `ZERNIO_API_KEY` only in `/home/<YOU>/career-ops/.env`, `chmod 600`, never print it, and recommend rotation if the key was pasted in chat. Details: `references/zernio-linkedin-api.md`.
- **LinkedIn role-post engagement cron:** When <YOUR_NAME> asks to search LinkedIn posts for his target roles, analyze them, and reply accordingly, set up an approval-queue cron rather than auto-commenting. Search/analyze posts, draft concise public replies from career-ops source-of-truth facts only, save `data/linkedin-post-reply-queue.json` plus `reports/linkedin-post-engagement-YYYY-MM-DD.md`, and deliver numbered items with `reply N` approval instructions. Never publish comments without explicit item approval. Runbook: `references/linkedin-role-post-engagement-cron.md`.
- **Manual “run it now” for LinkedIn role-post engagement cron:** `cronjob(action="run", job_id="<CRON_JOB_ID>")` only queues the job for the next scheduler tick; do not claim it ran until `last_run_at` and a new output file under `~/.hermes/cron/output/<CRON_JOB_ID>/` confirm it. If the gateway scheduler does not pick it up promptly, trigger from a clean environment to avoid polluted `HERMES_HOME`: `env -i HOME=/home/<YOU> USER=<YOU> LOGNAME=<YOU> PATH=/home/<YOU>/.hermes/hermes-agent/venv/bin:/home/<YOU>/.local/bin:/usr/local/bin:/usr/bin:/bin HERMES_HOME=/home/<YOU>/.hermes /home/<YOU>/.hermes/hermes-agent/venv/bin/hermes cron run <CRON_JOB_ID>` then run the same command prefix with `hermes cron tick`; verify status/output afterward.
- **Recruiter outreach cron maintenance:** Since 2026-09-23 the daily recruiter/referral cron `<CRON_JOB_ID>` SENDS its verified connection invites itself via the linkedin MCP `send_invitation` (<YOUR_NAME>'s decision; no approval step, invites only — no DMs/InMail/email). Since 2026-09-25 it runs on Claude Sonnet via the claude-subscription plugin; discovery is one `claude -p --allowedTools WebSearch` call (Claude subscription, `env -u ANTHROPIC_API_KEY`), confirmation is linkedin MCP `get_profile` — Codex is gone (ChatGPT cancelled), do not reintroduce it. When updating the target count, update the report target, connector-call cap, and no-fabrication guardrails together (e.g. up to 10 candidates, 12 connector confirmations, “3 real beats 10 invented”). Trigger-now requests use `cronjob(action="run")`, which queues the job for the next scheduler tick; verify live execution via new cron output (or a running `claude -p` discovery process) before claiming completion. If <YOUR_NAME> reports he did not receive the cron response, audit `last_status`, `last_delivery_error`, and `~/.hermes/cron/output/<CRON_JOB_ID>/`, then compare the job's `deliver` target to the current Slack thread; thread drift is common, and fixing it is usually `cronjob(action="update", job_id="<CRON_JOB_ID>", deliver="slack:<channel>:<current_thread_ts>")` followed by `cronjob(action="list")` verification. Do not silently move sibling jobs such as recruiter-email drafts (`<CRON_JOB_ID>`) unless he asks, but mention if they still point to the old thread. Runbook: `references/recruiter-outreach-cron.md`.
- **Approval wording “approved for all” can mean both queued recruiter emails and LinkedIn recruiter invites:** First run `/home/<YOU>/.hermes/scripts/send_recruiter_emails.py all` to drain the explicit email queue if present. The queue is `/home/<YOU>/career-ops/data/pending_recruiter_emails.json`; only Prospeo-VERIFIED + Reoon-safe pending emails send via the configured jobmail/gog account after explicit approval. If sending fails with `GOG_KEYRING_PASSWORD`, do not mark sent; tell <YOUR_NAME> the queue is still pending and restore gog keyring auth before retrying. Then, for the daily LinkedIn recruiter report, run a dry-run first (`python3 scripts/unipile_auto_outreach.py --report /home/<YOU>/career-ops/reports/recruiter-outreach-YYYY-MM-DD.md --max-send 20 --dry-run`) to identify new sends vs `already in outreach_log`; if clean, run the same command without `--dry-run` from `/home/<YOU>/career-ops` (use an absolute `--report` path; the script can throw `ValueError` with relative paths). Treat HTTP 201 as sent, `already in outreach_log` as safely skipped, and `errors/already_invited_recently` as handled but without inventing a `dateSent`. As of 2026-07-27, `scripts/unipile_auto_outreach.py` auto-syncs `data/contacts.json` `dateSent` fields and sets `data/contact-status.json[YYYYMMDD] = "Sent"` when every contact is sent/skipped as already logged; still validate `data/contacts.json`, `data/contact-status.json`, and `data/outreach_log.json` with `python3 -m json.tool` and verify `/api/contact-statuses` when the dashboard is running. Do not rely on `git diff` as the verifier because deployed career-ops copies may not be inside a Git checkout.
- **Outreach status audit (LinkedIn + recruiter email):** If <YOUR_NAME> asks for the status of LinkedIn/email/recruiter outreach over the last N days, report separate evidence-backed buckets: LinkedIn sends from `data/outreach_log.json`, daily targets surfaced from `reports/recruiter-outreach-YYYY-MM-DD.md`, recruiter emails queued/sent from `data/pending_recruiter_emails.json` plus `~/.hermes/cron/output/<CRON_JOB_ID>/*.md`, and unread/actionable inbox replies via Unipile when available. Do not count surfaced recruiter targets as sent, and do not answer “emails sent” with LinkedIn invite counts. For “today” before scheduled runs, say the runs have not happened yet; for “yesterday,” audit the previous calendar day explicitly and separate **sourced/drafted targets** from **actual external sends** using timestamped `outreach_log.json` events (`ts` prefix) rather than `contacts.json.generated_at` or contact-bucket creation alone. If the recruiter email cron says `Couldn't parse any recruiters from the latest report` while the report visibly has `## N. Name — Title` sections, treat that as a parser/report-format bug to fix in `recruiter_email_drafts.py` (support both old bold headings and current `##` headings), not as “no recruiters found.” Runbook: `references/outreach-status-audit.md`.
- **Recruiter email sent-count audit + pipeline debugging:** If <YOUR_NAME> asks “how many mails did you send?” or “check Gmail sent box” about recruiter emails, answer actual Gmail/email sends, not LinkedIn outreach and not queue status. Ground truth is: (1) Gmail Sent per-recipient searches via `gog gmail messages search 'in:sent to:<email> newer_than:30d' --account <YOUR_EMAIL> --client jobmail --json --no-input`, (2) `data/pending_recruiter_emails.json` statuses/sent_at for the current queue, (3) `~/.hermes/cron/output/<CRON_JOB_ID>/*.md` for how many verifiable emails were queued by the draft cron, and (4) session/send-script traces for `/home/<YOU>/.hermes/scripts/send_recruiter_emails.py` approvals. The draft cron only queues/prints approvals; it never sends. Distinguish “0 verifiable emails queued,” “N pending approval,” “N actually sent,” and “N skipped due to prior LinkedIn outreach.” If <YOUR_NAME> explicitly says “check Gmail sent; if not sent, send them,” do not let `skipped_prior_outreach` block the requested email send: verify Gmail Sent one recipient at a time and send only missing addresses, then mark them sent. If the draft cron repeatedly reports 0 queued emails, debug provider/parser drift before assuming there are no emails: parse the clean `career-ops/reports/recruiter-outreach-YYYY-MM-DD.md` artifact, inspect `pending_recruiter_emails.json`, probe a small Prospeo/Reoon sample with secrets redacted, and verify the send script with `--dry`. Prospeo `enrich-person` may return `person.email` rather than legacy `response.person.email`; support both shapes. Reoon HTTP 403 can mean “Not enough credits available”; parse/surface the JSON `reason` instead of generic `verify_error`. Apollo-provided/manual emails can be queued with `verified: APOLLO_PROVIDED_BY_<YOU>` after backing up the queue and building normal first-person bodies from the daily report. Runbook: `references/recruiter-email-draft-pipeline.md`.- **Recruiter email body quality / <PROOF_POINT> hook:** <YOUR_NAME> does not want recruiter email bodies to read like generic keyword dumps. When maintaining `/home/<YOU>/.hermes/scripts/recruiter_email_drafts.py`, keep the body interesting and evidence-backed: include the <PROOF_POINT> from `config/profile.yml` when relevant (<HOME_LAB_DETAILS>), preserve safe <VISA_STATUS> wording, and transform direct report-draft phrasing like `Hi Name, I’m <YOUR_NAME>...` into clean third-person email copy before wrapping it in the agent voice. Verify changes with `python3 -m py_compile /home/<YOU>/.hermes/scripts/recruiter_email_drafts.py` plus a sample `build_email(...)` run before claiming the cron will use the new body.
- **Queued recruiter email approval hygiene:** When <YOUR_NAME> approves pending recruiter emails, do not blindly send `data/pending_recruiter_emails.json`. First dry-run `/home/<YOU>/.hermes/scripts/send_recruiter_emails.py all --dry`, then inspect representative queued `body` fields for voice/framing defects. A known failure mode is an agent wrapper (`I'm <YOUR_NAME>'s agent`, `His fit:`) around first-person candidate copy (`I applied...`, `I'm an AI/ML engineer...`), which reads unprofessional. If already queued, back up the queue, rewrite the pending bodies to one consistent voice (usually direct first-person from <YOUR_NAME> for that batch), remove typos introduced by automated substitutions, then run a small text scan for forbidden wrapper fragments (`<YOUR_NAME>'s agent`, `His fit:`, `<YOUR_NAME> is interested`, third-person pronouns) before sending. After the real send, verify with three concrete checks: rerun `send_recruiter_emails.py all --dry` and expect `Nothing to send`; count queue statuses in `data/pending_recruiter_emails.json` so `sent` and `skipped_prior_outreach` are separated; run `python3 -m json.tool data/pending_recruiter_emails.json >/dev/null`. Report actual emails sent, not the total queue size, and explicitly list skips caused by prior outreach so <YOUR_NAME> does not think they failed. Also patch the drafter/script so the defect does not recur.
- **Terse recommendation approval:** If <YOUR_NAME> replies with wording like “go on according to your recommendation,” “do what is feasible for us,” or similar in context of the daily recruiter/referral list, treat it as approval to execute the recommended LinkedIn recruiter connection-request path for the current/latest recruiter report. Resolve the exact report from today’s `reports/recruiter-outreach-YYYY-MM-DD.md` or the latest `<CRON_JOB_ID>` output, run the Unipile dry-run first, then send only unsent LinkedIn invites. Do **not** infer approval for recruiter emails unless the current context explicitly includes queued emails or the user says email/send all approvals. If a dry-run returns `candidates_found: 0` but the report visibly has candidates, do not stop; inspect/fix the parser/report format mismatch (recent reports may use `## 1. Name — Title` headings instead of old bold `**1. ...**` headings), rerun dry-run until it resolves candidates, then proceed only after explicit approval for the external send. After sending, validate `data/contacts.json`, `data/contact-status.json`, and `data/outreach_log.json`; verify `/api/contacts` contains the daily app bucket and contact count, since `/api/contact-statuses` may not expose the expected key even when the JSON file is updated.
- **Missed recruiter cron / “send them and update” recovery:** If the daily LinkedIn outreach cron did not run but targets were drafted, recover from ground-truth artifacts instead of rerunning blindly: identify the daily app bucket in `data/contacts.json`, dry-run the Unipile sender, send only contacts missing from `data/outreach_log.json`, then sync `data/contact-status.json` and verified `dateSent` values. Keep actual new sends separate from duplicates/already-invited contacts in the final. Runbook: `references/recruiter-outreach-missed-run-recovery.md`. 
- **Unipile recruiter replies + resume attachments:** When a LinkedIn contact replies, read the chat first, resolve any JD against `data/applications.md` / `reports/` / `output/`, and reply with verified application context. If <YOUR_NAME> says “send it” after offering a tailored resume, send the role-specific PDF from `output/` to the same writable chat using multipart `POST /chats/{chat_id}/messages` with `-F text=...` and `-F attachments=@/absolute/path.pdf;type=application/pdf`; then read back the message and verify the attachment object exists. Before sending or re-sending any resume, verify the contact/location line against `config/profile.yml` and run `pdftotext` QA to confirm outdated locations (especially `<YOUR_CITY>`) are absent. If a previously sent attachment had bad profile data and was deleted, regenerate/verify the corrected PDF but do **not** resend until <YOUR_NAME> explicitly approves. Detailed runbooks: `references/unipile-linkedin-replies-and-attachments.md`, `references/resume-location-correction-qa.md`.
- **Recruiter screening checks across email + LinkedIn:** When <YOUR_NAME> says a recruiter emailed about scheduling/screening and asks to check mail plus LinkedIn, use Unipile’s connected `GOOGLE_OAUTH` mail source and `LINKEDIN` chat source as the preferred integrated path if local Gmail CLIs/keyring are unavailable. Account ids are in `/home/<YOU>/career-ops/.env`: jobmail Gmail `UNIPILE_GMAIL_JOBMAIL_ACCOUNT_ID=<UNIPILE_GMAIL_ACCOUNT_ID>`, personal Gmail `UNIPILE_GMAIL_PERSONAL_ACCOUNT_ID=<ID>`, LinkedIn `UNIPILE_LINKEDIN_ACCOUNT_ID=<UNIPILE_LINKEDIN_ACCOUNT_ID>`. Search `/emails?account_id=$UNIPILE_GMAIL_JOBMAIL_ACCOUNT_ID&query=<recruiter/company>` and `/chats?account_id=$UNIPILE_LINKEDIN_ACCOUNT_ID&limit=100`, then read `/chats/{chat_id}/messages`; report only actionable facts (role, recruiter, date/time with verified timezone conversion, call/meeting format, and whether a reply is needed). Do not send anything unless explicitly approved. Runbook: `references/recruiter-screening-email-linkedin-checks.md`.
- **Availability reply + JD prep:** When <YOUR_NAME> explicitly asks to reply to a labeled availability/scheduling email and find the JD, treat it as an end-to-end recruiter-screening task: read the full email, choose only from the recruiter’s offered slots, convert timezones, preserve safe <VISA_STATUS>/future-sponsorship wording, reply in-thread, verify `SENT`, then recover the authoritative JD from the employer/ATS and save an interview-prep artifact under `interview-prep/`. If <YOUR_NAME>’s shorthand says something like `12am CDT` but the recruiter’s matching offered slot is `12pm CDT`, use the valid offered slot and report that assumption afterward rather than inventing a midnight slot. Runbook: `references/recruiter-availability-reply-and-jd-prep.md`.
- **LinkedIn inbound invitation triage:** When <YOUR_NAME> says someone sent a LinkedIn connection invite and asks to “check profile / recent posts / do what is good,” use read-only Unipile checks first and do **not** accept/reject/DM/comment unless explicitly approved. For same-name disambiguation, resolve likely public identifiers with `GET /users/<public_identifier>?account_id=...` and prefer the one showing `invitation.type == RECEIVED`; search recent posts with `POST /linkedin/search?account_id=...` body `{ "api": "classic", "category": "posts", "keywords": "\"Name\"" }`, then filter by `author.public_identifier`. Flag paid-placement wording, wrong seniority/geography, staffing/C2C-only, and work-authorization constraints; final response should say what action was or was not taken. Runbook: `references/linkedin-inbound-invitation-triage.md`.
- **Outreach database schema + personalization:** `data/contacts.json` contacts must carry the dashboard-facing fields `profileName`, `linkedinProfileLink`, `connectionNote`, and `dateSent` in addition to legacy aliases. Keep aliases synchronized (`name` = `profileName`, `linkedin` = `linkedinProfileLink`, `messages.linkedinConnect` = `connectionNote`). `dateSent` stays `null` until the request is actually sent (by the user, or by the daily recruiter cron `<CRON_JOB_ID>`, which sends its own invites since 2026-09-23), then becomes `YYYY-MM-DD`. Connection notes must be personalized from both sides: at least one verified fact from the contact’s profile/title/team/company plus one backed <YOUR_NAME> CV/profile proof point; no generic notes. If schema changes, update the producer rules (`modes/_profile.md`, `modes/_custom.md`, cron prompt) and consumers (`webapp/public/app.js`, `build-daily-dms.mjs`) together, then validate JSON and run `node --check` on changed JS files.
- **Contacts added by Codex/Claude → send LinkedIn connection requests:** When <YOUR_NAME> says “send the connection requests for contacts added now by Codex” or similar, do not assume the source is a daily recruiter markdown report. Compare `data/contacts.json` with the newest backup to identify newly added/changed application contact buckets, inspect `connectionNote`/`messages.linkedinConnect`, dry-run Unipile resolution/de-dupe against `data/outreach_log.json`, then send only the intended unsent contacts. After HTTP 2xx/201 sends, update `contacts.json` `dateSent/status`, set `contact-status.json[appNumber] = "Sent"` when complete, validate JSON, and verify dashboard APIs if running. Detailed runbook: `references/contacts-json-connection-request-send.md`.
- **Bulk CSV LinkedIn suggestions → safe batched connection outreach:** If <YOUR_NAME> references `data/linkedin-suggestions-usa.csv` or another CSV of LinkedIn profiles, use `/home/<YOU>/career-ops/scripts/linkedin_csv_outreach.py`. It reads CSV columns like `Name`, `Job Role`, `Current Company`, `LinkedIn Profile`, resolves each `/in/<public_id>` through Unipile, enforces 300-char notes, de-dupes against `data/outreach_log.json`, and writes run artifacts to `reports/send-results/linkedin-csv-outreach-{dryrun|send}-*.json`. Always run a dry-run first (for example `python3 scripts/linkedin_csv_outreach.py --max-send 5`) and use small real batches (recommended 10–15/day; stay well under ~40/day) with multi-minute sleeps. Do not start a real `--send` campaign until <YOUR_NAME> explicitly approves the batch size/schedule.

### Resume PDF generation quality (do not regress)
- Use the standard pipeline + template: `templates/cv-template.html`  `output/_tmp_cv/cv-{candidate}-{company}.html`  `node generate-pdf.mjs ... output/{NUM}-{slug}.pdf`.
- **Resume location/profile QA:** Before sending a generated resume externally, compare the PDF text against `config/profile.yml`, especially the contact/location line. If <YOUR_NAME> updates location or flags stale location data, regenerate the affected PDF, verify via `pdftotext`, and wait for explicit approval before re-sending a corrected attachment. Runbook: `references/resume-location-correction-qa.md`.
- **Never leak markdown into PDFs**: strip `**`, `*`, `_`, backticks from any text pulled out of `cv.md`, and drop divider lines like `---`.
- Add a **JD-anchored closing sentence** in the Professional Summary (specific to the current JD; sourced from JD text; no invention).
- Quick QA: run `pdftotext -layout` and confirm Experience bullets exist and there are no literal `**`/`---` artifacts.

References:
- `references/2026-05-22-pipeline-pdf-tracker-learnings.md`
- `references/2026-05-22-resume-pdf-quality-regression.md`
- `references/cron-run-audit-and-artifact-integrity.md` — how to audit the last N days of scheduled pipeline runs using cron logs + repo artifacts (reports/PDFs), and detect mismatches (e.g., report claims PDF but file is missing).
- `references/2026-06-27-deep-scan-verification.md` — deep-scan stall recovery, no-fabrication outreach handling, PDF QA, and dashboard/API verification quirks.
- `references/company-database-expansion-sources.md` — source hierarchy and gating rules for widening the career-ops company database using ATS-first discovery, AIStackJobs, OnlyNerds, Simplify, USCIS/DOL, and Reddit/community leads.
- `references/jobmail-email-digest-cron.md` — daily Slack digest pattern for the `<YOUR_EMAIL>` Gmail mailbox using `gog --client jobmail` + a deterministic JSON fetch script.
- `references/unipile-linkedin-outreach-api.md` — storing, verifying, and safely using Unipile LinkedIn messaging credentials for career-ops outreach.
- `references/recruiter-outreach-cron.md` — maintaining and triggering the Unipile-backed daily recruiter/referral cron, including 10-profile target updates and verification after `cronjob(action="run")`.
- `references/recruiter-outreach-missed-run-recovery.md` — recovering when the daily recruiter cron misses a run: dry-run/send only unsent contacts, preserve Unipile idempotency, sync dashboard/contact state, and report actual sends vs duplicates.
- `references/linkedin-role-post-engagement-cron.md` — LinkedIn role-post search/analyze/draft-reply cron pattern with approval queue and no auto-public-comments boundary.
- `references/unipile-linkedin-replies-and-attachments.md` — replying to accepted LinkedIn contacts, resolving recruiter-sent JD links against tracker artifacts, and sending/verifying tailored resume PDF attachments via Unipile multipart chat messages.
- `references/recruiter-email-draft-pipeline.md` — debugging and verifying the Prospeo+Reoon recruiter email draft queue, including Prospeo response-shape drift, skip-reason reporting, dry-run send checks, and cron delivery thread drift.

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /career-ops pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-ops oferta    → Evaluation only A-F (no auto PDF)
  /career-ops ofertas   → Compare and rank multiple offers
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
  /career-ops deep      → Deep research prompt about company
  /career-ops pdf       → PDF only, ATS-optimized CV
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops scan      → Scan portals and discover new offers
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Operational notes (real-world workflow)

These are the patterns that make career-ops usable day-to-day (and prevent stalls when the market is dry).

### 0) Use a synced live working directory (recommended)

If the user keeps this repo synced (e.g., Syncthing over Tailscale), treat the synced folder as the **live source of truth** so Windows + Linux stay consistent.

### 1) First-run checklist (repo health)

Run once per machine (or after pulling updates):

```bash
cd /home/<YOU>/career-ops
npm install
npm run doctor
```

### 1b) Resume/profile mastery sprint planning

When <YOUR_NAME> asks for learning, simulation, project mastery, interview-prep, or “get perfect in everything in my resume/profile,” treat it as a career-ops training artifact, not a generic study plan. Load the user-layer source files (`cv-aiml.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, plus relevant `interview-prep/` notes), preserve his exact time blocks, and save the detailed schedule under `interview-prep/`. Each block should pair “from scratch” learning with spoken recall, mock-interview simulation, metric-defense, tradeoffs/failure modes, and a concrete deliverable. Use `references/resume-profile-mastery-sprints.md` for the current AI/ML proof-point map and planning pattern.

### 1c) Experience implementation labs — office-style, not bullet-by-bullet

When <YOUR_NAME> wants to understand or implement the Experience section, do **not** proceed bullet-by-bullet or start with dense technical concepts. He explicitly prefers seeing the experiences as **two separate real-office projects** and implementing them step by step from basics:

- <PAST_EMPLOYER>-style AI Operations Lab: applied AI, operations signals, edge inference, RAG, MLOps.
- <PAST_EMPLOYER_2>-style Recommendation Systems Lab: clickstream data, recommendations, streaming features, CTR/revenue, A/B testing.

For this workflow, create/maintain separate private repos, include a beginner-friendly `docs/project-guide.pdf`, and make each step feel like office work: project brief → data intake → implementation → run output → written submission → review/rating. Start with plain-English business context and data flow before local tools, production tools, concepts, and code. Use `references/experience-office-labs-workflow.md` for the repo structure, PDF contents, and grading rubric.

**Experience implementation labs preference:** If <YOUR_NAME> wants to understand the Experience section by implementing it, do **not** proceed bullet-by-bullet. Treat the entire Experience as connected systems first, then divide into parts by architecture/component: what we are doing, required concepts, tools used locally, production equivalents, how components connect, then real coding, verification, and interview explanation. If he wants code reviewed, use a private GitHub repo workflow where he pushes lab code and Hermes grades both code and explanation. Runbook: `references/experience-implementation-labs-workflow.md`.

If he says he wants to “implement these” / “implement step by step” to understand Experience bullets, create small runnable labs under `interview-prep/experience-labs/` and verify them with real execution. Each lab should map a resume claim to a simplified implementation, metric, tradeoff, and interview explanation. Use `references/resume-profile-mastery-sprints.md` for the current AI/ML proof-point map, planning pattern, and Experience-lab sequence.

### 2) Fresh scan can yield 0 new offers (and that’s not a failure)

**<YOUR_NAME> workflow preference:** When <YOUR_NAME> asks to “scan jobs”, “scan any jobs”, or similar from the job-hunt channel, run the scan through a Claude Code session in `/home/<YOU>/career-ops` rather than doing an ad-hoc local scan. Claude Code is the primary integrated agent for this repo. Use non-interactive mode when possible, e.g. `claude -p "<career-ops scan prompt>"`, or a tracked background/PTY session for long-running scans.

Because scan is dedup-heavy (scan-history.tsv + pipeline.md + applications.md), it’s common for a scan to return **0 new** on some days.

When that happens, do **not** stop. Switch to one of these productive paths:

- **Pipeline processing:** `/career-ops pipeline` (process any unchecked `- [ ]` URLs in `data/pipeline.md`).
- **Ship-the-stack execution pack:** if the user’s goal is “10 jobs ≥ 4.5”, select the top scored jobs already in `reports/` and pair them with existing PDFs in `output/` for immediate applications + outreach.

### 3) Outreach is an artifact, not a vibe

Prefer generating/maintaining outreach drafts in a structured file (e.g., `data/contacts.json`) so it’s easy to send, track, and iterate.

### References

- `references/ops-notes.md` — session-tested runbook: scan → pipeline → PDFs → outreach, plus common gotchas.
- `references/resume-profile-mastery-sprints.md` — plan learning/simulation/interview-prep sprints around <YOUR_NAME>’s resume/profile source-of-truth files, with current AI/ML proof-point coverage.

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
