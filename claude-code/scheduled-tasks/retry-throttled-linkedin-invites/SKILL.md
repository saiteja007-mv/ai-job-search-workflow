---
name: retry-throttled-linkedin-invites
description: Retry two LinkedIn invites that hit a Unipile provider throttle (one-time, scheduled ~hours after the failure)
---

Retry two LinkedIn connection invitations that failed with `Unipile 422 errors/cannot_resend_yet` (an account-level invite throttle) around 11:40 local time on the day of the failure. Nothing was delivered to either person; both are still uncontacted. Work in <CAREER_OPS_DIR>.

Use the LinkedIn MCP server (tool prefix `mcp__<LINKEDIN_CONNECTOR_ID>__`). If those tools are unavailable or permission-denied in this non-interactive run, STOP and report that plainly. Do not attempt any other send channel, and do not send email.

For EACH of the two people below, in order:

1. Call `check_contacted` with the provider_id FIRST. This is mandatory: an invite cannot be recalled, and the send goes out before any duplicate check can run. If `contacted` is true, SKIP that person and report it.
2. If not contacted, call `send_invitation` with exactly the provider_id, message, name, company, role, and origin given below. Do not reword the message; it was reviewed and approved by the user verbatim. Do not add em dashes.

PERSON 1
provider_id: <LINKEDIN_PROVIDER_ID>
name: <CONTACT_NAME>
company: <TARGET_COMPANY>
role: <ROLE_APPLIED_TO>
origin: claude_desktop
message: Hi <FIRST_NAME>, I applied to the <ROLE_APPLIED_TO> role at <TARGET_COMPANY>. <ONE_CONCRETE_HOOK_FROM_JD_MATCHED_TO_YOUR_CV>. <YOUR_DOMAIN>

PERSON 2
provider_id: <LINKEDIN_PROVIDER_ID>
name: <CONTACT_NAME>
company: <TARGET_COMPANY>
role: <ROLE_APPLIED_TO>
origin: claude_desktop
message: Hi <FIRST_NAME>, I applied to the <ROLE_APPLIED_TO> role at <TARGET_COMPANY>. <ONE_CONCRETE_HOOK_FROM_JD_MATCHED_TO_YOUR_CV>. <YOUR_DOMAIN>

(Message rules baked in: <=300 chars, first person, no em dashes, no employer names per modes/_custom.md rule 5a, and "I applied" only because the application is confirmed submitted.)

THROTTLE RULE: If a send returns 422 `cannot_resend_yet` again, do NOT retry it in a loop and do NOT try the second person if the first already threw that error. Stop immediately and report which ones remain pending. Repeated attempts extend the cooldown. (Later finding: `cannot_resend_yet` is also the per-recipient "you already invited this person" error, so a 422 on one person says nothing about a weekly cap. See lib/invite-ledger.mjs.)

Both messages truthfully say "I applied": both applications are confirmed submitted (tracker status Applied). Do not change that wording.

Finally, report a one-line tally: how many sent, how many skipped as already-contacted, how many still throttled, with invitation_ids for any that succeeded.
