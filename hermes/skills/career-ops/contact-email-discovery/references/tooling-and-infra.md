# Tooling and infra

## email-sleuth install
- Source + binary: `~/tools/email-sleuth` (`target/release/email-sleuth`). Local patch in `src/utils/smtp/client.rs`: both `ClientId::Domain("localhost")` sites read `EMAIL_SLEUTH_HELO` env with `localhost` fallback. Re-apply after any upstream pull, then `cargo build --release`.
- Config `~/.config/email-sleuth/config.toml`: `smtp_sender_email = "<YOUR_EMAIL>"`, `enable_headless_checks = false`, `max_concurrency = 2`, `min_sleep = 1.0`, `max_sleep = 3.0`.
- Wrapper `career-ops/scripts/find_recruiter_emails.py`; domain cache `career-ops/data/company_domains.json` (domains guessed as `slug.com/.ai/.io` with an MX record; guesses can be wrong).
- Smoke test: `EMAIL_SLEUTH_HELO=<ptr> email-sleuth --config-file ~/.config/email-sleuth/config.toml -m enhanced --name "Guido van Rossum" --domain python.org --stdout` → `<CONTACT_EMAIL>` 10/10.

## Port 25 / VPS
- Check first: `timeout 6 bash -c 'echo > /dev/tcp/gmail-smtp-in.l.google.com/25'`. Open on the home Google Fiber line, so no VPS is needed at job-hunt volume.
- Oracle Cloud Always Free blocks outbound 25 for tenancies created after June 2021; the exemption needs PAYG and is often refused. AWS/GCP/Azure/DigitalOcean also block by default. If volume outgrows the home IP, use a provider that leaves 25 open (Contabo, RackNerd) and set PTR to match HELO.

## Evaluating outreach tooling repos
When <YOUR_NAME> drops cold-email/outreach repos to inspect: shallow-clone, pull stars/license/last push via the GitHub API, read README + entrypoints, and build/run anything free and self-hostable on one known contact. Judge against job-hunt volume (5–20 personal emails/day from his real Gmail with manual approval):
- Agency cold-email stacks (bulk domains, warmup, EmailBison/AI Ark) and full platforms (e.g. Warmbly) → overkill; if ever adopted, run on a separate domain, never his personal Gmail.
- Paid-API wrappers (Tomba, Enrow) → skip unless a free tier fills a real gap (e.g. company-domain → HR staff list).
- Mine copy doctrine into recruiter-email drafting: offer in the first line, "would X be useful?" framing instead of asking a favour, never gatekeep value behind a call.
Give a verdict per repo (adopt / borrow ideas / park / skip) and a recommended next step.
