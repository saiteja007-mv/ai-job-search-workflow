# linkedin-mcp

LinkedIn as MCP tools, backed by [Unipile](https://www.unipile.com). Connect it to ChatGPT,
Claude, or anything that speaks MCP over Streamable HTTP.

- **URL:** `https://linkedin.<YOUR_DOMAIN>/mcp?token=<token>`
- **Service:** `systemctl --user {status,restart} linkedin-mcp`
- **Port:** `42834` (cloudflared → `linkedin.<YOUR_DOMAIN>`)
- **Token:** `data/mcp-token.txt` (0600, generated once, survives restarts)
- **Config:** `.env` (0600) — `UNIPILE_API_BASE`, `UNIPILE_API_KEY`, `UNIPILE_ACCOUNT_ID`

## The token goes in the URL

Most connector dialogs (ChatGPT's included) offer OAuth or no-auth and give you nowhere to
put a bearer-header. So the token is accepted three ways — `Authorization: bearer-scheme`,
`x-api-key`, or `?token=` — and the URL form is what makes this pasteable as one string.

**The URL is the credential.** Anyone holding it can read and send LinkedIn messages as the
account owner. Rotate by deleting `data/mcp-token.txt` and restarting; every connector then
needs the new URL.

## Tools (22)

**career-ops** — `check_contacted`, `get_invite_budget`, `sync_applications`
**Identity & network** — `list_accounts`, `get_me`, `get_profile`, `list_connections`
**Search** — `search` (people / companies / jobs / posts), `search_parameters`
**Jobs** — `get_job`
**Posts** — `get_post`, `list_user_posts`, `list_post_comments`
**Messaging (read)** — `list_chats`, `list_chat_messages`, `list_recent_messages`
**Write** — `send_message`, `start_chat`, `send_invitation`, `create_post`, `comment_on_post`, `react_to_post`

Set `LINKEDIN_MCP_READONLY=1` to drop the six write tools from the list entirely. They are
*removed*, not merely refused — a tool that is absent cannot be talked into firing by
something the model reads in a job post or an inbound message.

## Responses are trimmed

A single post search returns 25 KB from Unipile. Every list tool returns a compact shape
(id, title, author, url, clipped text) and takes `raw: true` for the full object. Browsing
therefore costs hundreds of tokens, not tens of thousands. Whole tool list: ~10.7 KB.

## career-ops audit logging

Every successful send through `send_invitation`, `send_message` and `start_chat` is mirrored
into `~/career-ops` (`server/careerops.cjs`), so outreach from ChatGPT / Claude Desktop /
Codex is visible to Hermes instead of existing only inside Unipile.

**The send always wins.** Logging runs after Unipile confirms, and can never fail the call or
make the model retry a delivered invitation. If the log is missing or malformed, the event
goes to `reports/unipile-outreach/mcp-log-failures-YYYY-MM-DD.jsonl` for backfill.

Written on each send:

| file | what changes |
|---|---|
| `data/outreach_log.json` | event appended to `.events`; for invites, `.sent_profiles[provider_id]` updated |
| `data/contacts.json` | matched contact gets `dateSent`, `status`, provider_id, and both halves of each alias pair |
| `data/contact-status.json` | the contact's parent `appNumber` set to `Sent` |

`sent_profiles` matters most — it is career-ops' own "already contacted" map (779 entries).
Appending an event without updating it is how the same recruiter gets invited twice from two
different clients.

**Schema notes** (read from the live files, not assumed): `outreach_log.json` is an object
`{version, events, sent_profiles}`, not an array. Contacts are *nested under applications* in
`contacts.json`. `contact-status.json` is keyed by **appNumber**, not by contact, and its
values must come from the dashboard's vocabulary (`Not Started`, `Sent`, `Responded`,
`No Response`, `Details Wrong`, `Skipped`). Timestamps use the local-offset format
(`2026-08-17T16:14:14-05:00`) that recent career-ops events use.

**Dedupe** — invites on `invitation_id`, or `provider_id` + normalised message + same day;
DMs on `message_id`, or `chat_id` + normalised message + same day.

**Concurrency** — an exclusive-create lock file plus temp-file-then-rename writes. Note the
career-ops python scripts and webapp do *not* take this lock; it protects concurrent MCP
sends from each other, not from an unrelated career-ops run writing at the same moment.

**Secrets** — `unipile_response` is whitelisted to `object`, `invitation_id`, `message_id`,
`chat_id`, `id`. Nothing else from a Unipile response is ever written, so a key cannot leak
by default when Unipile adds a field.

**Two tools complete the loop for a cloud client** (ChatGPT can reach tsenta and this MCP, but
has no filesystem access to career-ops):

- `check_contacted` — consults the career-ops outreach log, the failed-attempts log
  (`data/outreach_attempts.json`) AND LinkedIn's own sent-invitation list via Unipile (cached
  ~7 min per account). **The local log alone is not enough**: on 2026-09-01 LinkedIn held 812
  sent invitations of which 175 provider_ids the log had never seen, and two of those were
  re-invited on a local "not contacted" and rejected with 422 `already_invited_recently`.
  If the LinkedIn side is unreachable the answer says `linkedin_check: "unavailable"` — treat
  that as *unknown*, never as "not contacted".
- `get_invite_budget` — `sentToday` / `trailing7` / `remainingToday` / `remainingThisWeek`,
  taking the HIGHER of the career-ops ledger and LinkedIn's own count for each. The ledger only
  knows local sends; on 2026-09-01 it read 36/week while LinkedIn showed 148 — above this
  account's observed restriction threshold of 112.
- `sync_applications` — hand over the tsenta `list-applications` array to regenerate
  `data/tsenta-apps.json`. It is a **mirror, not an append log**: pass the full list.

Pass `company`, `role` and `name` to a send tool to attribute it to an application; pass
`origin` to override client detection (otherwise inferred from User-Agent, or `?client=`).

### `send_invitation` guards and refusals

Before calling Unipile it checks, in order: note length (≤ 300 chars), the reconciled invite
budget, and `check_contacted`. A refusal is **returned, never thrown**:

```
{ sent: false, reason, scope, ... }
```

| `reason`                   | `scope`   | what to do                                    |
|----------------------------|-----------|-----------------------------------------------|
| `note_too_long`            | person    | shorten by `over` chars and retry             |
| `already_contacted`        | person    | skip this person; `via` says who knew         |
| `already_invited_recently` | person    | skip this person, continue the batch          |
| `invalid_parameters`       | person    | fix the input for this person                 |
| `daily_limit`              | global    | **stop the batch** — budget is exhausted      |
| `cannot_resend_yet`        | global    | **stop the batch**                            |
| `account_blocked`          | global    | **stop** — 401/403/restriction from Unipile   |
| `upstream_error`           | global    | stop and retry later                          |
| anything else              | unknown   | treat as global until understood              |

Every refusal is written to `data/outreach_attempts.json`, and `check_contacted` reports it as
`last_failed_attempt` so the next run does not retry the same person into the same 422.
`skip_budget_check: true` bypasses the budget preflight only (never the duplicate check) —
use only on explicit instruction.

3rd-degree contacts (`connection_degree: "DISTANCE_3"`) **can be invited**; verified 2026-09-01.
`search` results carry `employer_from_headline` (parsed from the headline after " at " / " @ "),
plus `headline_other_mentions` and `past_association` for everything *outside* that clause.
Verify the employer from those, never from the name. A company-token search matches three ways
that are not employment, all seen live:

| Miss | Example | Signal |
|---|---|---|
| the token is in their **name** | two people whose surname matches the searched company | `employer_from_headline` disagrees |
| a **past / non-employment** tie | "Talent at Northwind \| Former Globex Cheerleader" | `past_association: true`, company appears only in `headline_other_mentions` |
| a similarly-named **different company** | <COMPANY_A> Solutions vs <COMPANY_A> Technologies; <COMPANY_C> Platforms vs <COMPANY_C>; <COMPANY_D> General vs <COMPANY_D> | `employer_from_headline` is the full, different name |

A fourth signal, `role_qualifier`, catches a *current* non-employment tie: "Student at <COMPANY_Z>"
parses a real employer clause for a company they do not work for. It is present only when set,
and stays out of `past_association` because a student is current, just not employed. Read from
the role side of the clause only, so an engineer at Student Beans is not misflagged.

`headline_other_mentions` is the raw non-employer text, not extracted company names — the caller
already knows the company it wants, so a substring check against verbatim text is exact where an
extractor would invent and drop names. `employer_from_headline: null` means the headline states
no employer, not that there is none.

All four fields are on **`search`, `list_connections` and `get_profile`** alike. `get_profile`
matters most: when a profile URL is already known there is no search call, so it is the only
lookup before a send — it returns the full untrimmed `UserProfile` with the guard fields added
alongside, never a reshaped subset.

## Multi-account

Three LinkedIn seats are connected. `UNIPILE_ACCOUNT_ID` sets the default (<YOUR_NAME>); every
tool takes `account_id` to act as another. `list_accounts` shows the ids.

## Known limits

- **People search may return zero results** while LinkedIn throttles `category: people`
  for this account. Companies, jobs and posts are unaffected. `get_profile` on a known
  identifier still works, so resolve people by public identifier rather than by search.
- **The career-ops ledger undercounted until 2026-09-01.** `lib/invite-ledger.mjs` read only a
  top-level `invitation_id`, while `tsenta_unipile_outreach.py` stores it inside
  `unipile_response` — so every tsenta send counted as zero (36 reported vs 125 in the file vs
  148 on LinkedIn). Fixed in the ledger; the producers were logging correctly all along. This
  server reconciles against LinkedIn's own list regardless, which is what caught it.

## Verify

    node --test                                   # 4 tests
    curl -s https://linkedin.<YOUR_DOMAIN>/healthz
