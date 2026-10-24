---
name: jobspy
description: This skill should be used when the user asks to "find jobs", "search for jobs", "scrape jobs", "scrape job listings", "get job postings", "pull jobs from LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter/Naukri", "job listings for [role]", "remote [role] jobs", "build a job list/board", or mentions "jobspy". It scrapes structured job postings from multiple job boards into a CSV/JSON/DataFrame via the JobSpy (python-jobspy) library.
version: 0.1.0
---

# JobSpy — multi-board job scraping

Scrape real job postings from **LinkedIn, Indeed, Glassdoor, Google Jobs, ZipRecruiter, Bayt, Naukri, and BDJobs** into a structured table (title, company, location, salary, URL, description) using the JobSpy library (`python-jobspy`). Use this whenever a task needs *actual current job listings* — job hunts, market/salary research, building a job board, sourcing leads, or feeding downstream analysis. It returns clean tabular data, not prose, so prefer it over generic web search when structured listings are wanted.

For research on *what people say* about a company/role (reviews, sentiment) use other tools; JobSpy is for the listings themselves.

## Prerequisite (bootstrap once)

Confirm the library is present, install if missing:

```bash
python -c "import jobspy" 2>NUL || pip install -U python-jobspy
```

Requires Python >= 3.10. The bundled script exits with code 2 and prints the install command if the import fails — install, then re-run.

## Primary workflow — use the bundled CLI

Do **not** hand-write `scrape_jobs()` calls each time. Run the wrapper in `scripts/search_jobs.py`; it forwards only the flags set (preserving JobSpy's defaults and each board's constraints) and writes CSV/JSON/XLSX plus a summary.

```bash
python "%USERPROFILE%\.claude\skills\jobspy\scripts\search_jobs.py" \
  --search "software engineer" \
  --location "San Francisco, CA" \
  --sites indeed,linkedin \
  --results 25 \
  --country USA \
  --hours-old 72 \
  --output jobs.csv
```

Key flags: `--search/-q`, `--location/-l`, `--sites` (csv), `--results/-n`, `--country` (Indeed/Glassdoor, default USA), `--hours-old`, `--job-type {fulltime,parttime,internship,contract}`, `--remote`, `--distance`, `--linkedin-descriptions`, `--offset`, `--proxies` (csv of `user:pass@host:port`), `--format {csv,json,xlsx}`, `--output/-o`. Run with `--help` for the full list.

After it writes the file, read/aggregate the CSV to answer the user (top matches, salary ranges, dedupe, filter). Deliver the file path plus a short summary; attach or preview the results as fits the request.

## Quick reference

| Board | Reliability | Must-know |
|---|---|---|
| **indeed** | best, no rate limit | needs `--country`; **one** of `--hours-old` / (`--job-type`+`--remote`) / easy-apply per search |
| **glassdoor** | good | needs `--country`; same one-constraint rule |
| **linkedin** | rate-limited ~page 10 (429) | one of `--hours-old` / easy-apply; `--linkedin-descriptions` is slow (extra request per job) |
| **google** | exact query only | pass `--google-search` with the *verbatim* Google jobs-box phrasing after filtering |
| zip_recruiter / bayt / naukri / bdjobs | varies | regional; combine with the majors |

Defaults to `indeed,linkedin` when `--sites` is omitted. Hard cap ~1000 jobs/query — paginate with `--offset`. HTTP 429 = blocked → lower `--results`, wait, or add `--proxies`.

## When to reach for the script directly

For logic the CLI does not cover (custom column joins across multiple searches, `linkedin_company_ids`, `enforce_annual_salary`, `ca_cert`), call `scrape_jobs()` directly following `references/api.md` — it has the full signature, every parameter, the DataFrame schema, and per-site gotchas with worked recipes.

## Resources

- **`scripts/search_jobs.py`** — the CLI wrapper to run for every scrape.
- **`references/api.md`** — complete `scrape_jobs()` signature, DataFrame columns, per-site constraints, and recipes. Load it when a request needs parameters beyond the CLI flags.
