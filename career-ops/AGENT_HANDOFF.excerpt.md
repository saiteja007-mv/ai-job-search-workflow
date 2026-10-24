# AGENT_HANDOFF.md (excerpt of the reusable parts)

The working `AGENT_HANDOFF.md` is a ~170 KB rolling diary shared by Claude Code, Codex and the Hermes server agent
(one dated section per session, newest first). It is full of per-company results and contact names, so it is **not** copied.
This excerpt keeps only the operating protocol, retrieval recipes and traps that are independent of any person or employer.
Rules 6-24 of `modes/_custom.md` are the machine-loaded form of the same lessons.

## Why the protocol exists (first Codex batch, 10 roles)

| Failure | Evidence | Cost |
|---|---|---|
| Scored 10 roles without fetching one JD | every Block B match table was generic; one row read "Strong when present in JD"; Block G keywords == the candidate's own skills | all scores inflated 0.4-1.5; zero actually cleared 4.0 |
| No liveness check | a role scored 4.1 while the posting already returned 404 (site root returned 200) | resume + contact + tracker row for a dead job |
| Comp not read from the JD | four postings logged `advertised_comp: null`; all four state comp plainly | one role mis-triaged |
| Garbage comp accepted | a JobSpy scrape artifact like `"6168-13571 USD"` scored on | nonsense salary |
| JD keyword promoted to a CV claim | a JD phrase added to Core Competencies, unbacked | fabrication in a shipped resume |
| Architecture invented in outreach | a recruiter InMail named models the candidate never used | fabrication in a message |
| Wrong resume build path | `generate-pdf.mjs --allow-reorder` | every PDF 2 pages; 8 of 10 leaked the archetype slug into the Summary ("...production applied ai / genai engineer systems") |

What went right and should be kept: employment dates matched the CV verbatim, `mailto` was clean, `data/contacts.json` carried `verify_before_send: true`, tracker rows merged without duplicates.

## Per-listing execution order (never reorder)

1. **Liveness first.** `node check-liveness.mjs <url>` for ATS postings; otherwise fetch the page. 404/expired -> status `Discarded`, no report, no resume, no contact, no score. Confirm the careers-site root returns 200 first so a blocked site is not called "expired".
2. **Fetch the real JD** (recipes below) and cache it to `jds/<batch>/<num>.txt`.
3. **Unfetchable after every recipe:** cap the score at 3.0, write `**Verification:** JD unfetched` in the report header, generate no PDF.
4. **Score against quoted requirements.** Block B's "JD need" column quotes the JD. Extract hard requirements verbatim (degree, years, must-have tech, clearance/citizenship).
5. **Gate honestly.** Hard-reject PhD / publications / 8+ yrs / Staff / Principal / Lead / clearance / citizenship. Data Scientist, Fullstack, Applied Scientist and Research Engineer are adjacent archetypes and cannot reach 4.0 on title alone.
6. **Record real comp** from the JD (`not stated` if silent, never `null` when stated). Reject an "annual" figure outside about $40K-$500K as a scrape artifact.
7. **Gates:** apply >= 4.0, PDF >= 4.1 for batch scans (the daily Tsenta runs use 4.0 for both). Below the gate, document only.

## Resume build (only for roles that pass the gate)

* Clone a validated 1-page `.tex`, swap **only** the Professional Summary and Core Competencies (plus bullet/skill order per the report's Customization Plan), then `node generate-latex.mjs <tex> <pdf>` with `export PATH="$PWD/tools/tectonic:$PATH"`.
* Never `generate-pdf.mjs --allow-reorder` for these.
* Every skill/metric/tool must trace to `cv-aiml.md` or `article-digest.md`. A JD keyword that cannot be backed is left out. Emit a `doNotClaim` list and keep those terms out of the resume and the outreach.
* Assert: exactly 1 page; `grep -i "engineer systems\|scientist systems"` empty; exactly one `mailto:` (pass the bare email as `EMAIL_URL`); employment dates read exactly as in the CV.
* A cheap reusable pattern from that session: a script that clones the tex, tailors, compiles and asserts 1 page, and an idempotent tracker/report corrector. When writing report/tracker fields with `String.replace`, pass a **function replacer**: comp strings contain `$`, and `$1` in a string replacement silently eats digits (`$139,000` becomes `39,000`).

## Tracker writes

* New rows: TSV in `batch/tracker-additions/` (9 tab-separated columns: num, date, company, role, status, score/5, pdf-emoji, `[num](reports/...)`, note), then `node merge-tracker.mjs`. Never hand-add rows. Confirm 0 pending TSVs.
* Existing rows: `node set-status.mjs <Company> <State> [--note]`. Mark by **company** and verify the resolved `#NNN Company - Role` line: report-file number != tracker row number. It has no `--score` flag; a score correction is a direct edit of column 5.
* Parallel workers: reserve numbers first with `node reserve-report-num.mjs --count N`. Never let workers compute `max+1`.

## Definition of done (run, paste output, do not self-report)

```bash
node verify-pipeline.mjs                                            # expect: 0 errors
node batch/verify-competency-chips.mjs '^(NUM1|NUM2)-'              # expect exit 0 (guards only the chip line)
node batch/test-competency-guard.mjs                                # proves the guard is not vacuous
for f in output/<new>*.pdf; do pdfinfo "$f" | grep '^Pages'; done  # expect 1 each
grep -li "engineer systems\|agentic workflows" output/<new>*.tex    # expect no matches
ls batch/tracker-additions/*.tsv 2>/dev/null | wc -l                # expect 0
```

## Later additions (each came from a real miss)

* **Disqualifier scan before scoring**: extract Basic/Minimum Qualifications verbatim; a failed basic qual is `skip` however strong the rest. (A role required "2+ years in C#, C++, Java or Perl" for a Python-only candidate and was scored 4.0 anyway.)
* **Never land exactly on the gate.** Six of ten scores sat on 4.0; after the gate moved to 4.1, seven of eight sat on 4.1. A batch whose apply-tier scores are one identical number is tuned, not measured: re-audit it. Round down when borderline.
* **No JD-requirement laundering.** "A, B, or C" is satisfied by whichever the CV backs; an OR-list miss neither lowers nor raises a score. A Block B "CV evidence" cell must contain CV content, not a restatement of the JD.
* **Work-authorization clause scan**, distinct from sponsorship: grep `EAD|OPT|CPT|F-1|F1|citizen|green card|clearance|sponsor` and read each hit. "Does not hire F-1s on CPT or EAD" is a hard bar even at 4.1 skills fit.
* **Contacts:** every apply-ready role needs BOTH a peer and a recruiter/HR-TA. LinkedIn profiles are auth-walled to logged-out fetches, so a title from a search snippet is a lead, not verification: only `profile_read: live-profile-read` earns `verified`; snippet-only is `weak`. Staffing agencies do not count as the employer.
* **Tailor beyond two lines**: if the Technical Skills block is byte-identical across a batch, the resumes are not tailored.

## JD retrieval recipes (verified)

| Board | How |
|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/<company>/jobs/<gh_jid>` -> `.content` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/<company>?includeCompensation=true` -> match `.jobs[].id`; gives `descriptionPlain` **and real comp** |
| Lever | `https://api.lever.co/v0/postings/<company>/<id>` (`createdAt` is ms epoch) |
| Workday | `curl -H "Accept: application/json" https://<tenant>.myworkdayjobs.com/wday/cxs/<co>/<site>/job/<path>` -> `.jobPostingInfo.jobDescription`, `postedOn` |
| Amazon | `https://www.amazon.jobs/en/jobs/<id>` (basic_qualifications + preferred_qualifications + description) |
| Phenom boards | page is JS-rendered but embeds the JD in `<script type="application/ld+json">` -> `JobPosting.description` |
| iCIMS | append `?in_iframe=1` |
| LinkedIn (liveness) | `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<jobId>` (no auth). CLOSED iff body matches `/no longer accepting applications|this job is no longer available/i`. Cross-check `topcard__org-name-link` and the title. A headless page with no visible apply control is **not** evidence of expiry. |
| JobSpy results | the real JD body is already in `batch/_jobspy.json` (match `.url`, fall back to `.url_aggregator`); read it before any fetch |

## Hard stops

* Never submit an application, click Apply, or send a LinkedIn request/InMail from an automated run. Draft only.
* Never claim a role was applied to ("I applied...") unless the application is confirmed `COMPLETED`; if outreach must precede, use present tense ("I'm applying...").
* Never report "N high-fit roles" unless each score came from a fetched, quoted JD.
* An honest `3.0 / JD unfetched` is worth more than a confident `4.3`.

## Unipile LinkedIn sourcing (works headless)

```bash
# people search is POST, not GET (GET 404s)
curl -s -X POST "$UNIPILE_API_BASE/linkedin/search?account_id=<UNIPILE_LINKEDIN_ACCOUNT_ID>" \
  -H "X-API-KEY: $UNIPILE_API_KEY" -H "content-type: application/json" \
  -d '{"api":"classic","category":"people","keywords":"<Name> <Company>"}'
# returns items[] with name, headline, public_profile_url, network_distance, id (the provider_id)
```

* **The throttle:** during throttle windows search silently returns HTTP 200 with `items: []` for **every** query. Track **consecutive** zero-item responses; on a streak of about 5, sleep 90 s and retry the *same* row. Base delay between searches 3 s; do not lower it. (One pass logged ~100 findable people as "not found" because its abort guard only checked whether anything had ever resolved.)
* Try a company-filtered search (`companies-search` -> company id -> `people-search` with `company:[id]`) when a whole company fails: it is a loose match and does **not** check whether the role is current, so verify the top Experience entry reads "Present" before spending a send or an email credit (2 of 7 contacts in one batch had already left).
* Matching rules (each caused a real error): verify the employer from the **headline**, never from the name (a company token matching a surname once invited two unrelated people); drop ambiguous company tokens instead of guessing; truncated surnames need first name + initial + confirmed company; exclude the candidate's own current/former employers on the resolved headline; never invent or expand a name.
* Definition of done for a sourcing pass: row count unchanged, every new URL matches `^https://www\.linkedin\.com/in/`, **zero duplicate URLs** (best single signal you did not guess), auditable `Match Confidence` labels, and an honest "ran out of runway" rather than padding with low-confidence picks.
* The Codex LinkedIn plugin only works inside the interactive Codex app (people search 403s in `codex exec`). Unipile works headless.

## Recruiter email outreach pipeline (Hermes, server side) - traps

* `recruiter_email_drafts.py` **rewrites the whole queue on every run** (it does not merge). A bare re-run destroyed good addresses three times. Required sequence: back up `data/pending_recruiter_emails.json`, run with `REC_EMAIL_GAP=25` (seconds between Prospeo lookups; this removed the rate-limit failures), diff against the backup, **restore if the new queue is smaller** (a shrinking queue means a limiter or verifier won, not that addresses stopped existing).
* `Reoon:verify_error` is a **masked credit failure** (HTTP 403 "Not enough credits"). If it dominates the skip counts, check the verifier balance first; those contacts are recoverable.
* Always dry-run the sender first (`send_recruiter_emails.py all --dry`), then for real. `--max-send N` is a cap on a top-down walk, **not a selector**: write a filtered report and pass `--report`; the ordering is the selection.
* `parse_report` takes the company from the **last comma-separated token of the title line**, so every title must end `, <Company>`. `unipile_auto_outreach.SECTION_RE` needs a real em-dash (U+2014) and the exact literals `**Connect request (<=300 chars):**` and `**Email / InMail (<=120 words):**`, each followed by a `>` quote line; a hyphen or reworded label silently drops the contact. Validate with the real parsers, not a hand-rolled regex.
* Apollo (people lookup) is a **human-only** step: its extension needs a trusted gesture, the internal API returns a Cloudflare Turnstile page with HTTP 200, and keyword search does not match person names. Do not spend turns re-testing it.
* `outreach_log.json` mixes timestamp formats (local-offset and UTC `Z`). Parse dates; never prefix-match a day string (that dropped a run's own sends). LinkedIn outreach and email outreach are **separate ledgers**: do not count one as the other when asked "how many did you send".
* From Windows, Git-bash `ssh` is socket-blocked inside the Claude MSIX container: tunnel via WSL (`wsl -e bash -lc "ssh <user>@<host> '<cmd>'"`); for nested quotes write a `.sh` and pipe it with `ssh ... 'bash -s' < script.sh`.
