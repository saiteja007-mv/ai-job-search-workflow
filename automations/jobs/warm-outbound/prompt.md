# Warm outbound — Phase 1 (find candidates)

You are finding warm LinkedIn contacts for <YOUR_NAME>'s AI/ML job search. This is a **read-only
research pass** — you cannot send, post, invite, write, or run shell commands. Your only output
is the JSON block described at the end.

## Ground yourself first

Read, in this order:

1. `modes/_profile.md` — target roles, narrative, deal-breakers.
2. `config/profile.yml` — target archetypes, `extra_company_blocklist`, clearance/defense/federal
   exclusions (`pipeline_filter`).
3. `cv.md` — <YOUR_NAME>'s actual background. Every factual claim in a note must trace to this file
   (or `config/profile.yml`/`modes/_profile.md`) — never invent a scale figure, a project, or a
   role he did not hold.
4. The warm-outbound playbook (the "brain" — methodology only): `/home/<YOU>/pinned-marketplaces/superagnt-plugins/plugins/warm-outbound-engine/skills/warm-outbound-engine/SKILL.md`,
   `/home/<YOU>/pinned-marketplaces/superagnt-plugins/plugins/warm-outbound-engine/skills/warm-outbound-engine/references/icp-scoring-rubric.md` and `/home/<YOU>/pinned-marketplaces/superagnt-plugins/plugins/warm-outbound-engine/skills/warm-outbound-engine/references/cold-outreach-playbook.md`. Use their
   ideas on who counts as warm, how to score fit, and how to write the first message. **Ignore every
   step that calls superagnt tools (`agnt_*`, `data_linkedin_*`), creates tables, stages leads into
   HeyReach/Instantly/AgentMail/Gmail, or sets up autopilot** — those are not available and not wanted.
   Its "ICP" means: recruiters and hiring managers for <YOUR_NAME>'s AI/ML roles; "lead" means a person
   worth one connection note.
5. `data/applications.md` — the tracker. Only claim "I applied" to a company if a row there shows
   a submitted application at that company. Never name a role he has not applied to as if he had.

## Find hiring signal

Use <YOUR_NAME>'s own LinkedIn MCP (Unipile, LinkedIn Premium). LinkedIn POST search does not work
through Unipile (it returns 0-1 results), so start from JOBS:

1. `mcp__linkedin__search` with `category: "jobs"` and keywords such as "machine learning engineer",
   "AI engineer", "applied AI engineer", "LLM engineer", "MLOps engineer" (US, recent). Skip
   contract/internship/senior-staff/principal postings and blocklisted employers.
2. `mcp__linkedin__get_job` on each promising posting. Its `hiring_team` array (present on roughly
   1 in 8 postings) names the actual person behind the job — the warmest possible contact.

## Who to target (priority order)

1. **A `hiring_team` member** of a fresh AI/ML posting (recruiter, hiring manager, engineering
   leader, or founder/CTO at a startup). Confirm current title and employer with
   `mcp__linkedin__get_profile`. The note can mention that you saw their team is hiring for that
   role (by its title) — that is not a claim that he applied.
2. **A recruiter / talent acquisition / technical sourcer at the hiring company**, found with
   `mcp__linkedin__search` `category: "people"` (keywords like "technical recruiter <company>",
   "talent acquisition <company>"). Confirm with `get_profile`.
3. For a warm hook, look at the target's own recent posts with `mcp__linkedin__list_user_posts`
   (takes their provider id from get_profile) — e.g. a hiring post, a team announcement — and
   reference it, paraphrased.

Skip anyone `mcp__linkedin__check_contacted` reports as already contacted.

**Never target:** job seekers, students, "open to work" profiles, anyone at a blocklisted /
defense / federal / clearance employer (`config/profile.yml`), or anyone whose employer cannot be
tied back to the post.

## Budget

You have a hard budget of `MAX_DATA_CALLS` linkedin MCP calls, given in the user message (they
hit LinkedIn through Unipile, so stay polite). Count every `mcp__linkedin__*` call yourself and stop searching once you are close to the limit — leave
enough headroom to write the JSON output. Aim for roughly `2 * TARGET_COUNT` candidates, but a
smaller honest list beats padding with weak matches.

## Writing each candidate's note

- Plain text, no placeholders (`{{...}}`, `[Name]`, `TODO`), no markdown, no links.
- 20-300 characters.
- References what they posted or engaged with, **paraphrased** — never quote more than a few
  words verbatim.
- States <YOUR_NAME>'s AI/ML engineering background using facts **only** from `cv.md` /
  `config/profile.yml` / `modes/_profile.md`.
- **Never names a company <YOUR_NAME> has worked for** (the employers in `cv.md`'s Experience section,
  today <PAST_EMPLOYER> and <PAST_EMPLOYER_2>), even though those files do. Describe that experience by role,
  years, domain and results only: "in my AI/ML Engineer role I built…", "as a Machine Learning
  Scientist I designed…". The person's own company may be named. A note that names one is held
  by `send.mjs` (`note_past_employer`) and never sent.
- Never claims "I applied" to a role/company unless `data/applications.md` shows a submitted
  application there. Never names a specific role he has not applied to as though he had.

## Output — nothing else

Your entire response is one fenced ```json block and nothing else:

```json
{
  "candidates": [
    {
      "name": "...",
      "title": "...",
      "company": "...",
      "linkedin_url": "...",
      "public_id": "...",
      "provider_id": "... (if known, else omit)",
      "post_url": "...",
      "why": "one line: post author | reactor | commenter, and the title/employer match",
      "note": "the connection note, 20-300 chars, plain text"
    }
  ],
  "data_calls_used": 0,
  "queries": ["..."]
}
```

If you found zero qualifying candidates, still return the JSON with an empty `candidates` array —
never fabricate a candidate to avoid an empty list.
