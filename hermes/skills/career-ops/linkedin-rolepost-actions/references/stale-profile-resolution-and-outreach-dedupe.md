# Recover stale LinkedIn profiles before career outreach

Use this when a career-outreach report contains named LinkedIn profiles but direct Unipile resolution (`GET /users/<public_identifier>`) returns HTTP 422 `errors/invalid_recipient`, or when the requested batch count differs from the report.

## Validated recovery path

1. Treat the report/queue as the approved set. Count its actual named targets; do not invent replacement recipients merely to reach a requested round number.
2. Run the normal outreach helper in dry-run mode first. Preserve every HTTP 201 send already completed even if later candidates fail.
3. For each stale vanity URL, use authenticated LinkedIn people search:
   - `POST /linkedin/search?account_id=<linkedin-account-id>`
   - body: `{"api":"classic","category":"people","keywords":"<Full Name> <Company>"}`
4. Select only an exact-name result whose headline/company matches the approved person. Record its current `public_identifier`, profile URL, and `id` (provider ID). Do not choose a same-name result without matching evidence.
5. Update the report/queue to the current canonical profile URL, then rerun the sender in dry-run mode. This is important: canonical URLs may expose older outreach-log events that the stale URL failed to match.
6. Send only entries the second dry run labels as unsent. The expected clean final dry run is `sent: []`, every intended target skipped as already logged, and `failed: []`.

## State reconciliation

After the send:

- Treat `data/outreach_log.json` HTTP 201 events as ground truth for actual invitation dates and IDs.
- Update the daily bucket in `data/contacts.json`:
  - synchronize `profileName`/`name`
  - synchronize `linkedinProfileLink`/`linkedin`
  - synchronize `connectionNote`/`connectMessage`/`messages.linkedinConnect`
  - set `status: sent`
  - set `dateSent` to the real event date, including prior dates for deduped contacts
- Set `data/contact-status.json[appNumber] = "Sent"` only when every approved target is sent or safely deduped.
- Validate all JSON files and, when the dashboard is running, verify `/api/contact-statuses` exposes the daily key as `Sent`.

## Reporting

Separate:

- approved targets actually present in the source report
- newly sent now
- already contacted earlier
- unresolved failures

Never say “sent 10” when the report contains 8, or when only 4 were new sends.