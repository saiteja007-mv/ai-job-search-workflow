---
name: faang-outreach-send
description: Send the 2 drafted big-tech outreach connection notes via Unipile (one-time)
---

Send two LinkedIn connection-request notes via the Unipile API. One-time outreach scheduled from a prior session. Be conservative: these go out under the user's name (<YOUR_NAME>).

STEP 1 — Read the drafts.
Read `<CAREER_OPS_DIR>\data\faang-outreach-drafts.md`: two connection-note drafts (Draft A = <TARGET_COMPANY_A>, Draft B = <TARGET_COMPANY_B>), each with a `{Name}` placeholder.

STEP 2 — Unipile credentials.
Load `<CAREER_OPS_DIR>\.env` (UNIPILE_API_BASE, UNIPILE_API_KEY). LinkedIn account id = `<UNIPILE_LINKEDIN_ACCOUNT_ID>`. All calls use header `X-API-KEY: <UNIPILE_API_KEY>`. Never print the key.

STEP 3 — Find ONE target per message via Unipile people-search.
POST `<UNIPILE_API_BASE>/linkedin/search?account_id=<UNIPILE_LINKEDIN_ACCOUNT_ID>&limit=10` with body `{"api":"classic","category":"people","keywords":"..."}`.
- Company A: keywords "<COMPANY_A> technical recruiter machine learning". Pick a current recruiter or ML engineer on a relevant team (e.g. Ads / Commerce / GenAI). Verify the employer from the headline, never from the name.
- Company B: keywords "<COMPANY_B> machine learning recommendation systems engineer". Pick someone currently at that company on ML / RecSys / Ads-ranking.
Extract each chosen person's `provider_id` (item id) and first name.

STEP 4 — Send.
For each, POST `<UNIPILE_API_BASE>/users/invite` with JSON `{"provider_id":"<id>","account_id":"<UNIPILE_LINKEDIN_ACCOUNT_ID>","message":"<draft with {Name} replaced by their first name>"}`. Each note is already under 300 chars (LinkedIn's note limit); just substitute the name.

SAFETY RULES (do not skip):
- At MOST one invite per company (2 total). Never more.
- If you cannot confidently identify a currently-employed target, DO NOT send to a wrong person. Skip and report "no suitable target found."
- If Unipile returns 403/429 (rate limit) or errors, STOP. Do not retry aggressively. Report the failure. Never fabricate success.
- Confirm each send returned an invitation_id before reporting it sent.

STEP 5 — Report.
State who each note went to (name, company, provider_id) and the invitation_id, or why not sent. Do NOT send any other messages, apply to any jobs, or take any action beyond these two invites.

NOTE (added when staging for the public repo): this one-time task is superseded by the standing rule in modes/_custom.md that every LinkedIn send is human-approved and goes through the `linkedin` MCP (`check_contacted` -> `get_invite_budget` -> `send_invitation`), never raw-API sends from a scheduled task.
