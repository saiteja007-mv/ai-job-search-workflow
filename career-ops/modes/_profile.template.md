# User Profile Context -- career-ops   (TEMPLATE of the user-layer `modes/_profile.md`)

<!-- The real file is gitignored and never auto-updated. This template keeps every RULE and section of the working file
     and replaces every personal value with a placeholder. Sections that were pure personal narrative are reduced to their headings. -->

## Facts for recruiter replies (verbatim, provided by you)
- <YOUR_NAME>, <TARGET_ROLE> (e.g. AI/ML Engineer), ~<N> years, based in <YOUR_CITY>.
- Work authorization: <YOUR_WORK_AUTH_STATUS>. Exact dates (use verbatim when a form asks): start <WORK_AUTH_DATE>, end <WORK_AUTH_DATE>.
- Compensation target: <TARGET_COMP_RANGE>. Open to remote / hybrid / onsite in the US.
- Never state anything here that is not also in `cv-aiml.md` / `article-digest.md` / `config/profile.yml`.

## Your Target Roles
Primary titles (ranked), adjacent titles, hard-reject levels (Senior / Staff / Lead / Principal / Manager / III / IV).
Archetypes with a `fit: primary | adjacent` flag. Adjacent archetypes cannot reach the apply gate on title match alone.

## Your Adaptive Framing / Exit Narrative / Cross-cutting Advantage / Key Proof Points
<YOUR_NARRATIVE> -- keep proof points as exact metrics that also appear in the CV; the evaluator and every outreach draft may only quote these.

## Your Comp Targets
Floor, target range, currency. A posted band topping out below the floor is disqualifying.

## Work Authorization / Visa Framing
Scripted answers for salary and visa questions (see "Negotiation Scripts"). Standing policy used by every agent:
* **Sponsorship is a ranking signal, never a reject.** A plain "no sponsorship" line is not a reject; employers with recent H-1B/LCA filings for the title, E-Verify enrollment, or cap-exempt status rank higher (sponsor targeting switched on <DATE>).
* **A clause barring the candidate's current status is a HARD skip**: F-1 / OPT / CPT / EAD / STEM OPT / I-983 refusal, "US citizens only", clearance, ITAR / export control / "U.S. Person", polygraph, public trust.
* **Sponsorship gate vs US-Person gate are different gates.** The second is a hard block even for non-defense employers that use the language company-wide.
* Keep a list of employer clusters that are always wasted applications (clearance-gated defense / space).

## Your Negotiation Scripts
> "I'm targeting <TARGET_COMP_RANGE> base for this level. The right team, the problems, and a clear sponsorship path matter more than squeezing every dollar right now."
> "I'm authorized to work now (<YOUR_WORK_AUTH_STATUS>). I'd need sponsorship down the line. Is that something your company has done before?"

## Application Email
* Primary email: `<YOUR_EMAIL>` (forwarded alias; DMARC reject, so send only through `lib/outreach-email.mjs` or the mail CLI with an explicit `--from`).
* Legacy email (pre-switch applications): `<LEGACY_EMAIL>`; keep reading its inbox.
* **Rule (set 2026-10-21): every application submitted from career-ops uses the primary email**: CV contact line, ATS form fields, application emails, cover letters, Tsenta applies (default resume profile; never pass the legacy profile id). A second candidate profile at an ATS that already has the legacy one is accepted.
* **Outreach email only:** `identityFor(company)` in `lib/outreach-email.mjs` may pick the legacy mailbox to stay inside an existing thread. It never decides the email on an application or CV.
* Record the email used in the tracker row notes (`email=<primary>`).
* Dedup: before applying, check whether either address already applied (Workday / Greenhouse / Lever block a re-apply from the same email).

## Your Application Velocity Rule
Historical target: 3 applications per weekday, each followed by a Day-1 LinkedIn connect to the primary contact (oldest-first, highest-score tiebreak); Day-3 / Day-7 follow-ups logged to `data/follow-ups.md`. If the >= 4.0 stack is empty, ship 3-4 from the 3.8-4.0 tier where the role is otherwise strong. (Later superseded by the Tsenta-gated daily runs: quality over volume, zero is a valid day.)

## Your Location Policy (tiered preference; ranking only, never a filter)
| Tier | Location | Score |
|---|---|---|
| Remote (US) | any US-remote role | 5.0 |
| 1 | <TIER_1_REGION> | 5.0 |
| 2 | <TIER_2_REGION> (+0.2 sector bump for roles where ranking is the product, vertical SaaS adding LLM/RAG, or health-tech clinical AI; capped at 5.0) | 4.7 / 4.5 |
| 3 | <YOUR_CITY> metro (local = no relocation story needed) | 4.5 |
| 4 | any other US state | 4.0 |
* Search scope stays USA-wide. Non-US is a hard reject. Never let the tier alone decide an application (a 4.4-fit role in Tier 4 beats a 3.6-fit role in Tier 1).
* A Tier-4 onsite role requiring relocation to an otherwise unremarkable city may cap at 3.8.
* Prioritising a region with benchmarked-lower pay can cost 20-40% of comp: run a parallel US-remote track.

## Your Freshness Window
Default posted-date threshold: **2 days** (`today - posted_date <= 2`, else `SKIP-STALE` at scan time). Indeed / ZipRecruiter MCP queries use a 24-hour window (`max_posted_minutes_ago: 1440`). Cross-check every API hit's date against the source ATS URL, because aggregators report ingestion time, not original posting time. A one-run override ("use 7-day window for this scan") never edits this file.

## Your PDF Generation Threshold
Generate a PDF only if Global Score >= 4.0 (overrides the upstream >= 3.0 default in `modes/pipeline.md` and `modes/oferta.md`; `_custom.md` fresh-scan uses APPLY_GATE 4.0 and PDF_GATE 4.1 for batch runs).

### Posted-date capture (every eval, no exceptions)
Every JD fetch writes the posting's published/updated date to `data/posted-dates.json` (`{"dates": {"<appNumber>": "YYYY-MM-DD"}}`, merge, never overwrite the object). Sources: Greenhouse API `updated_at`; Greenhouse page `og:updated_time`; Lever API `createdAt` (ms epoch); Ashby GraphQL `publishedAt`; Workday `postedOn`; LinkedIn / unstructured visible date, otherwise blank (never fabricate).

### Report header format (CRITICAL for dashboard wiring)
The dashboard's `/api/pdf-path` regex-extracts the PDF path from the **first 30 lines** of the report. `**PDF:** ✅ output/{NUM}-{slug}.pdf` when generated (number prefix required), `**PDF:** ❌` when skipped.

## Auto-Outreach for High-Fit Roles
For any evaluation scoring >= 4.0 run `contacto` mode and write the plan to BOTH `data/contacts.json` and the report. `contacts.json` schema (merge, never overwrite; replace only the matching `appNumber` entry):
```json
{ "generated_at": "YYYY-MM-DD",
  "candidate": { "name": "<YOUR_NAME>", "linkedin": "<URL>", "email": "<YOUR_EMAIL>" },
  "applications": [ { "appNumber": 1, "company": "...", "role": "...", "url": "...",
    "contacts": [ { "profileName": "...", "linkedinProfileLink": "https://www.linkedin.com/in/<PROFILE_SLUG>",
      "connectionNote": "<=300 chars, personalised from BOTH profiles", "dateSent": null,
      "name": "...", "title": "Title @ Company", "type": "hiring_manager | recruiter | peer | skip_level | interviewer",
      "linkedin": "...", "email": null,
      "messages": { "linkedinConnect": "same as connectionNote", "linkedinInmail": null, "followUpAfterAccept": null, "emailSubject": null, "emailBody": null } } ] } ] }
```
Discovery order per role: peer on the exact team > hiring manager > technical recruiter > skip-level. Searches: `"<Company>" machine learning OR ML OR AI manager OR director`, `"<Company>" recruiter talent acquisition site:linkedin.com/in`, `"<Company>" "machine learning engineer" OR "ML engineer" site:linkedin.com/in`. Draft per `modes/contacto.md`; verify <= 300 chars. **Safe failure:** if search returns nothing useful write `TODO: research contacts manually`; never invent names.
