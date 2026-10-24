---
name: application-answers
description: >-
  Answer job-application questions in the candidate's own first-person voice for a career-ops
  job already in the database. Use when the user gives a job/report ID (e.g. "#622", "622"),
  a company name, or a job URL, PLUS a list of application questions (Experience Summary, Cover
  Letter, technical or behavioral short-answers), and wants ready-to-paste answers. Every claim is
  grounded ONLY in cv-aiml.md / article-digest.md / config/profile.yml / modes/_profile.md and the
  job's own report/JD. Nothing is fabricated, and NO em dashes are used. Trigger phrases like
  "#<num> answer these questions", "answer the application questions for <company>", "write my
  application answers for job <id>".
---

# Application Answers

Write answers to a job application's questions in the candidate's own voice, tailored to one job in
the career-ops database, grounded strictly in the candidate's source-of-truth files. Never submit or
send anything. These are drafts for the user to review and paste.

## Inputs the user gives
- A **job identifier**: a career-ops report number (`reports/{num}-*.md`), a company name, or a job URL.
- One or more **application questions** (numbered or freeform). Common ones:
  - "Experience Summary"
  - "Cover Letter"
  - Technical / behavioral short-answer prompts (CI/CD, deployment, cross-team collaboration, hardest
    problem, LLM evaluation/monitoring, etc.)

## Steps

1. **Resolve the job.**
   - Number `N` (e.g. `#622`): read `reports/N-*.md`. Use its **company, role, location, compensation,
     Block B (JD-need to CV-evidence table), Customization Plan, and Interview Plan.** If the Machine
     Summary has a `jd_cache:` path, read that cached JD for the exact wording of the posting.
   - Company name or URL with no report: ask the user to paste the JD, or fetch it (see the JD-fetch
     recipes in `AGENT_HANDOFF.md` / `modes/_custom.md`). Do **not** invent the JD.

2. **Load the source of truth** (the ONLY allowed basis for claims):
   `cv-aiml.md` (or `cv.md` if that is the active CV), `article-digest.md`, `config/profile.yml`,
   `modes/_profile.md`, plus anything the user states directly in the conversation.
   - Every metric, tool, employer, title, date, and project **must trace to these files**. Keywords may
     be reframed or emphasised, **never invented** (career-ops Source-of-Truth Boundary). If it is not
     backed, do not claim it.

3. **Write each answer in the candidate's voice.**
   - First person, natural, as if the candidate wrote it themselves. Plain and direct, not polished-AI.
   - Tailor to **this** job: mirror the JD's language and priorities (from Block B / the cached JD) and
     lead with the candidate experience that matches best.
   - Question-type handling:
     - **Experience Summary** -> one short first-person paragraph (~80 to 120 words): years of
       experience, current + prior role, core stack, degree.
     - **Cover Letter** -> a tailored letter (~200 to 280 words): why this role and company, one or two
       concrete matches from the CV, the stack, an honest early-career note if the role is junior, and
       any real constraint stated plainly (e.g. onsite relocation). Sign with the full name from
       `config/profile.yml`.
     - **Technical / behavioral** -> ~120 to 180 words each, concrete, using real metrics from the CV.
       Pick the single strongest source-backed story for prompts like "most challenging problem" or
       "a project where you collaborated with Product/Design/Engineering".
   - If a question asks about something the CV cannot back, answer from the nearest genuinely-backed
     experience, or say honestly what is and is not in scope. Never fabricate a tool, framework, metric,
     domain, or authorship.

## STYLE RULES (hard)
- **NO em dashes** (the `—` character) anywhere. Use commas, periods, parentheses, or "and". Ordinary
  hyphens in compound words (real-time, end-to-end, click-through) are fine.
- Write ranges with **"to"** (e.g. "0 to 2 years"), not en dashes.
- **Avoid AI-slop:** leverage, delve, seamless, robust, cutting-edge, "passionate about", heavy
  parallelism, and rigid "Furthermore / Moreover" scaffolding. Sound like a real person; a little
  plainness is good.
- Keep every **metric exactly** as written in `cv-aiml.md` / `article-digest.md`.
- Match **employment dates verbatim** from the CV (read them; do not infer or round to close a gap).

## Output
- Present each answer under its **question label**, in order, ready to paste. No preamble.
- After the answers, add **one short line** for any honesty caveat you had to keep (e.g. onsite
  relocation, a required tool the CV cannot back), and offer to shorten or fit a character limit.
- Never claim an application was submitted; never click Apply/Send.

## Example
Input: `#622 answer these: 1. Experience Summary 2. Cover Letter 3. Describe your CI/CD experience ...`
Action: read `reports/<NUM>-<company-slug>-*.md` (+ its cached JD) and `cv-aiml.md` / `article-digest.md`,
then write first-person, em-dash-free answers tailored to <TARGET_COMPANY>'s Jr. AI Engineer posting, using only
CV-backed facts (<CURRENT_EMPLOYER> RAG/NLP + AWS/K8s MLOps, <PAST_EMPLOYER> recsys, exact metrics), signed
"<YOUR_NAME>".
