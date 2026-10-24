# MCP servers used by the job-search workflow (Claude Code, workstation)

No tokens are stored here. `mcp-servers.example.json` holds the shape (type, url or command, header names).

| Server | Transport / auth | What the workflow uses it for | Paid? |
|---|---|---|---|
| `tsenta` (AutoJobs) | HTTP, interactive OAuth in the Claude session (a headless cron cannot authenticate; the nightly server runner talks to it through a Hermes MCP client instead) | Job feed + auto-apply: `get-application-balance`, `get-profile-status`, `get-job-recommendations`, `get-jobs-by-ids`, `fetch-job-description`, `apply-to-job`, `get-application-status`, `approve-application`, `list-applications`, plus `list-tracked-applications`, inbox tools. | Yes: monthly plan with an application quota (the daily skill treats the quota as a shared pool). |
| `linkedin` | HTTP to a self-hosted MCP wrapper around the **Unipile** LinkedIn API; token header | `check_contacted`, `get_invite_budget`, `send_invitation`, `send_message`, `start_chat`, `get_profile`, `search`, `search_parameters`, `list_connections`, `list_chats`, `list_chat_messages`, `list_recent_messages`, `list_user_posts`, `list_post_comments`, `get_post`, `get_job`, `get_me`, `list_accounts`, `comment_on_post`, `react_to_post`, `create_post`, `sync_applications`. Every outreach send goes through it with an `origin` label so the ledger and dedupe see it. | Yes: Unipile subscription + LinkedIn Premium on the account. |
| `happenstance` | HTTP, OAuth | Warm-network search (`search-network`, `chat`, `research-person`) to find an introducer before cold outreach. Credits-based. | Yes (credits). |
| `tinyfish` | HTTP, `X-API-Key` header | Free `search` + `fetch_content` for web research and JD fetches. Its paid tools (browser automation, monitors, wallet) are denied in settings. | Search/fetch free; rest denied. |
| `jev-web` | HTTP on `127.0.0.1:8767`, token | Local fast browser agent for web tasks (single page reads, form pre-fill) in the user's own Chrome. Local only. | No |
| `memory` | HTTP, token | Cross-agent notes (optional). Not required by the pipeline. | No |

## Connectors that are *not* in `~/.claude.json`

These come from the claude.ai connector UI (enabled per account, tools appear as `mcp__<uuid>__...`):

* Indeed, Dice, ZipRecruiter job-search connectors (`search_jobs`, `get_job_details`, `get_company_data`, `get_resume`): used by the "broaden" rounds of a fresh scan.
* Gmail connector (`search_threads`, `get_thread`, `create_draft`, ...): inbox reading / draft creation. Rejection and interview-mail syncing is done by a script (`sync-gmail-rejections.mjs`) through the `gog` Gmail CLI instead.
* Firecrawl connector (`firecrawl_scrape`, `firecrawl_search`): fallback page fetch. The standing routing rule is TinyFish first, then agent-reach / Jina Reader, and Firecrawl only as a last resort.
* A second copy of the Tsenta tools via the claude.ai connector (same server, different prefix). Scripts use the `mcp__tsenta__` prefix from `.claude.json`.

## Not an MCP but used like one

* **JobSpy** is a Python library, wrapped by the skill in `claude-code/skills/jobspy` (CLI script `scripts/search_jobs.py`).
* **Unipile REST** is called directly by the server scripts (`POST {UNIPILE_API_BASE}/linkedin/search`, `/users/invite`, `/chats`) with header `X-API-KEY`. `UNIPILE_API_BASE` already ends in `/api/v1`; do not append it again.

## Gotchas collected while using these

* The Tsenta MCP is interactive-auth. Run `tsenta-daily` inside a live session; for unattended runs use the server-side runner (`career-ops/scripts/run_tsenta_nightly_direct.py`) with an MCP client that holds the OAuth session. When launching MCP-backed scripts from a background shell, call the venv Python explicitly or `discover_mcp_tools()` returns zero tools.
* Tsenta `apply-to-job` can time out after partially creating applications and trip the MCP circuit breaker. Do not rerun blindly: wait for the backoff, `list-applications`, filter by the recorded `run_started_at_utc`, and treat only rows whose live status is exactly `COMPLETED` as submitted.
* Apply by `jobIds` (carries the JD, so the resume optimizer runs). Applying by `url` without `jobDescription` ships an un-optimized resume.
* Tsenta `get-job-recommendations`: do not pass `search` together with other filters (returns `FILTERS_NARROW`); query by `maxYearsExperience`, not by `jobTypes` (its seniority taxonomy is unreliable).
* Unipile classic LinkedIn search silently returns `items: []` (HTTP 200) for every query during throttle windows. Count consecutive empties; after about 5, sleep 90 s and retry the same row. Invites and messaging keep working in that state.
* The `linkedin` wrapper is the only sanctioned send path: `check_contacted` -> `get_invite_budget` -> `send_invitation` / `send_message`. Daily and weekly budgets live in `lib/invite-ledger.mjs` (see INVENTORY).
