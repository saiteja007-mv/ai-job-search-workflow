---
name: contact-email-discovery
description: Use when finding or verifying a contact's work email.
---

# Contact email discovery (find + verify work emails)

For recruiter/hiring-contact outreach in career-ops. Self-hosted, SMTP-verified, capped, find-only: never drafts or sends. Sending stays in the Gmail-draft → explicit-approval flow (`/home/<YOU>/.hermes/scripts/send_recruiter_emails.py`).

## Procedure
1. Back up `data/contacts.json` (`/home/<YOU>/career-ops`).
2. Dry run: `python3 scripts/find_recruiter_emails.py --dry` (default = today's `appNumber YYYYMMDD` bucket; `--app N` for another). Check the resolved domains; fix wrong guesses with `--domain-override 'Company=domain.com'`.
3. Real run: `python3 scripts/find_recruiter_emails.py` (default limit 10). One-off lookup without writes: `--name 'First Last' --domain x.com`.
4. Report `verified / checked`, list verified emails, and name catch-all / not_found / skipped contacts separately.
5. The daily recruiter cron `<CRON_JOB_ID>` already runs this as step 3b.

## Rules
- Accept an email only when SMTP-verified at confidence >= 8 on a non-catch-all domain; otherwise record `email_status` = `catch_all_domain` / `not_found` / `inconclusive`. Never hand-guess an address.
- Keep probes <= ~40/day (`EMAIL_SLEUTH_DAILY_CAP`, state in `~/.local/state/email-sleuth/usage.json`) — they come from the residential IP, and RCPT-probing at scale gets it blocklisted.
- Contacts already sent a LinkedIn invite stay off the email queue unless <YOUR_NAME> says otherwise.
- Big-tech domains are usually catch-all → unverifiable; smaller AI companies verify. Keep discovery's company mix tilted toward smaller companies for the email channel.
- Names with only a last initial can't be pattern-matched; skip them rather than guess.

## Pitfalls
- Set a real HELO hostname (`EMAIL_SLEUTH_HELO`, the home IP's PTR, e.g. `<HOME_RDNS_HOSTNAME>`). With `HELO localhost` many MX servers reply 504 on exactly the real mailbox, so every candidate scores 0.
- email-sleuth batch output (`-o out.json`) is a flat list of input fields + `email_discovery_results`; there is no `contact_input` or top-level `email`. Read `email_discovery_results.most_likely_email`, `.confidence_score`, `.verification_log` (`550 … User unknown` = not found, `catch-all` = catch-all) and match back by `(first_name, last_name, domain)`. Test the parser on one real output file before a batch that writes contacts.json.
- Don't mark `inconclusive`/`error` results as done — they should be retried next run.
- Config flag is `--config-file`, not `--config`. Use `-m enhanced`; `comprehensive` needs ChromeDriver.

## References
- `references/tooling-and-infra.md` — install/patch/rebuild of email-sleuth, config values, port-25/VPS notes, and how to evaluate outreach tooling repos for this job hunt.
