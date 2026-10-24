# What this setup costs

These are the amounts actually paid to run this workflow, checked against card statements in October 2026. Prices are in USD.

| Service | Plan | How it's billed | Per month | What it does here |
|---|---|---|---|---|
| Claude (Anthropic) | Max 5x | $100 / month | **$100.00** | Runs Claude Code on the workstation and Hermes Agent on the home server, through the subscription login (no API key). Shared with other projects, so the job-search share is smaller. |
| Tsenta | Pro, quarterly | $79 / quarter | **≈ $26.33** | Auto-applies to ATS job postings. The plan allows 1,500 applications a month and 1,000 chat messages a day. |
| Unipile | Monthly | $55 / month | **$55.00** | LinkedIn API: connection invites, messages, replies and profile lookups. I split it with a friend who uses the same account type, so my share is $27.50. |
| ChatGPT | Plus | $20 / month | **$0 now** | Used for Codex batch runs and a ChatGPT scheduled task until September 2026, then cancelled. The workflow now runs on Claude only. |

**Total: about $181 a month**, or about $154 with the Unipile split.

## Free parts

| Service | Used for | Cost |
|---|---|---|
| OpenRouter free models | Fallback model for the LinkedIn poller | $0 |
| TinyFish search and fetch | Web search and page reads | $0 (free tier; paid tools are blocked) |
| jobspy (python-jobspy) | Scraping LinkedIn, Indeed and Google job listings | $0 (open source) |
| career-ops | The pipeline itself (scan, score, tailor, track) | $0 (open source, MIT) |
| Slack and Telegram | Approval prompts and run reports | $0 (free plans) |
| Tailscale | Private network between the workstation and the home server | $0 (personal plan) |
| Gmail | Recruiter mail and confirmations | $0 |
| Home server | An old laptop running Linux | Electricity only |

## How the cost changed over time

| Month (2026) | Claude | Tsenta | Unipile | ChatGPT | Total |
|---|---|---|---|---|---|
| July | $100 | $29.25 (monthly plan) | — | $20 | $149.25 |
| August | $100 | $39.00 (monthly plan) | $55 | $20 | $214.00 |
| September | $100 | $79.00 (switched to quarterly) | $55 | $20 | $254.00 |
| October | $100 | — (covered by the quarter) | $55 | — (cancelled) | $155.00 |

## Where to save

- **Claude:** Pro ($20/month) is enough for light use. Max is what lets the scheduled scans and the Hermes crons run every day without hitting limits.
- **Tsenta:** the quarterly plan is cheaper per month than the monthly one. Without Tsenta, career-ops still produces tailored resumes and you apply by hand.
- **Unipile:** this is the only way here to automate LinkedIn safely through an API. Without it, the outreach drafts still get written and you send them yourself.
- **ChatGPT:** not needed. Image generation for this repo's diagrams is the only remaining use.
