---
name: company-segment-job-research
description: Use when listing hiring companies by area/size as CSV.
---

# Company-segment → live openings → CSV

Trigger: "find tech startups in <area> with <N-M> people, check openings matching our profile, currently hiring, give me a CSV". This is a one-off research deliverable. Do NOT edit `portals.yml` or run `scan.mjs`; offer that afterward.

Work dir: `/home/<YOU>/career-ops/scratch/<segment>/`. Final CSVs go in `/home/<YOU>/career-ops/output/`. Profile source of truth: `config/profile.yml` (`target_roles`, `level_filter`). Unipile creds: `career-ops/.env` (`UNIPILE_API_BASE`, `UNIPILE_API_KEY`, `UNIPILE_LINKEDIN_ACCOUNT_ID`). Never print the key.

## Procedure

1. **Build the company universe with Unipile LinkedIn company search.** Call `POST $BASE/linkedin/search?account_id=$ACC&limit=50`.
   - Resolve the filter IDs first with `GET /linkedin/search/parameters?type=LOCATION|INDUSTRY&keywords=...`. Known IDs:
     - SF Bay Area location: `90000084`
     - Software Development: `4`
     - Technology, Information and Internet: `6`
     - Technology, Information and Media: `1594`
     - Computer & Network Security: `118`
     - Data Security Software: `3130`
   - Example body: `{"api":"classic","category":"companies","location":["90000084"],"industry":["4"],"headcount":[{"min":201,"max":500}],"has_job_offers":true}`.
   - Pass every ID as a **string**, and give `industry` as a plain array. Numeric IDs or `{include:[...]}` return a 400 with a ~90KB schema dump.
   - Headcount min/max must be LinkedIn's bucket values (1, 11, 51, 201, 501, ...).
   - Paginate by re-POSTing `{"cursor": "<cursor>"}`. Pages hold 10 items, so an industry takes about 30 pages. Run one industry per call, sleep about 1.5s between pages, and dedupe by company `id`.
   - The location filter matches any presence in the area, not the HQ. Keep only companies whose `location` field is a city in the target area (about 75% survive).
2. **Map the companies to ATS boards.** Write YAML as `companies:\n  - name: "X"`, using `json.dumps` for the names because system python has no PyYAML. Then run `node discover-ats.mjs --in <file>` from the career-ops root. It is preview-only and writes nothing. It takes about 15 minutes for 300 companies, so run it in the background. The output JSON has `resolved` (with `vendor`, `slug`, `careers_url`, `jobCount`) and `unresolved`.
3. **Pull live postings from the resolved boards** through the public APIs:
   - Greenhouse: `boards-api.greenhouse.io/v1/boards/<slug>/jobs`
   - Ashby: `api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true`
   - Lever: `api.lever.co/v0/postings/<slug>?mode=json`
   - Workable: `apply.workable.com/api/v1/widget/accounts/<slug>`
   - SmartRecruiters: `api.smartrecruiters.com/v1/companies/<slug>/postings`

   Use at most 8 threads, then retry failed boards one at a time. Bursts of parallel requests cause transient DNS `name resolution` failures that clear on a serial retry.
4. **Cover the unresolved companies (Workday or custom career pages) with LinkedIn job search.** Body: `{"api":"classic","category":"jobs","keywords":q,"company":[<=10 company ids>],"date_posted":30}`, run for q = engineer, machine learning, and data scientist. Unipile returns 502/503 under sustained load. Skip those chunks and continue; don't abort.
5. **Match titles and locations to the profile.**
   - Buckets: Strong (AI/ML, applied AI, LLM/agents, recsys/ranking, SWE-ML), Good (SWE new-grad/intern/early-career), Adjacent (Data Science), Adjacent (general SWE/Data).
   - Reject: Senior, Staff, Lead, TLM, Principal, Manager, Director, PhD, research scientist, sales, solutions roles, frontend, hardware, mobile, SRE, and security.
   - Reject non-US-only locations. The block list must cover LATAM and Eastern Europe cities too (São Paulo, Rio, Sofia...), not only Europe and India.
6. **Clean the results.**
   - Drop job-aggregator "companies" that post listing-farm titles like "AI Engineer Jobs in <country>".
   - Collapse postings with the same company and title across cities into one row.
   - Cross-check `data/applications.md`, matching company + title after normalizing both, and fill a Tracker Status column (`#N Status`).
   - Count postings first published more than 3 months ago.
7. **Deliver two CSVs** and attach both with `MEDIA:` lines.
   - Per-role CSV columns: Fit, Company, Role, Job Location(s), Bay Area Role?, Posted, Apply URL, Company HQ, Industry, Headcount, Careers Page, Company LinkedIn, Source, Matching/Strong counts per company, Tracker Status.
   - Per-company summary CSV, sorted by strong-fit count.

## Final report

Keep it short: the method in 3 bullets, the counts per bucket, the top companies with their standout roles, and the easiest early-career openings. Then state the caveats:
- The match is title-level only. <VISA_TYPE>/sponsorship, years of experience, and comp are not screened yet.
- Give the number of stale postings.
- Headcount and the hiring flag are LinkedIn's buckets.
- Workday/custom-page companies are covered only through LinkedIn jobs.

Offer next steps: A-F evaluation of the Strong bucket, or adding the top companies to `portals.yml` with `discover-ats.mjs --write`.
