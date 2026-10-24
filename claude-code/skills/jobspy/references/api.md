# JobSpy API Reference

Source: https://github.com/speedyapply/JobSpy · PyPI package `python-jobspy` · Python >= 3.10.

## Install

```bash
pip install -U python-jobspy
```

## scrape_jobs() parameters

```python
from jobspy import scrape_jobs

jobs = scrape_jobs(
    site_name,               # list|str: which boards to scrape (default: all)
    search_term,             # str: role / keywords
    google_search_term,      # str: exact query for Google Jobs (see gotcha)
    location,                # str: "City, ST" or "City, Country"
    distance=50,             # int: radius in miles
    job_type,                # str: fulltime | parttime | internship | contract
    is_remote,               # bool
    results_wanted,          # int: jobs per site (hard cap ~1000/query)
    hours_old,               # int: only postings within N hours
    country_indeed,          # str: REQUIRED for indeed + glassdoor
    linkedin_fetch_description,  # bool: full LinkedIn descriptions (slow, O(n) requests)
    linkedin_company_ids,    # list[int]: restrict LinkedIn to these company IDs
    offset,                  # int: start from this offset
    proxies,                 # list[str]: ['user:pass@host:port', 'localhost']
    ca_cert,                 # str: path to a CA cert (corporate TLS)
    description_format="markdown",  # markdown | html
    enforce_annual_salary,   # bool: normalize salary to annual
    easy_apply,              # bool: LinkedIn easy-apply only
    user_agent,              # str: override default UA
    verbose=2,               # int: 0 (errors) | 1 (+warnings) | 2 (all)
)  # -> pandas.DataFrame
```

`site_name` accepted values: `indeed`, `linkedin`, `glassdoor`, `google`, `zip_recruiter`, `bayt`, `naukri`, `bdjobs`.

## Returned DataFrame

Core columns: `SITE, TITLE, COMPANY, CITY, STATE, JOB_TYPE, INTERVAL, MIN_AMOUNT, MAX_AMOUNT, JOB_URL, DESCRIPTION`.

Additional JobPost fields when available: `company_url`, `location` (country/city/state), `is_remote`, `job_function`, `date_posted`, `emails`, `job_level` (LinkedIn), `company_industry`, and site-specific fields. Column names arrive lower-case in the DataFrame (e.g. `jobs["title"]`, `jobs["job_url"]`).

## Per-site notes & gotchas

- **Indeed** — the most reliable scraper, effectively **no rate limiting**. Best default. Requires `country_indeed`. Only **one** of these constraint groups per search: `hours_old` OR (`job_type` + `is_remote`) OR `easy_apply`.
- **Glassdoor** — also requires `country_indeed`. Same one-constraint rule as Indeed.
- **LinkedIn** — most restrictive; rate-limits around page ~10 on a single IP (≈ HTTP 429). Only **one** of `hours_old` OR `easy_apply`. `linkedin_fetch_description=True` fires an extra request per job (slow on large `results_wanted`).
- **Google Jobs** — `google_search_term` must match the **exact** phrasing Google's job search box produces after you apply filters in a browser. Copy that box value verbatim; a plain keyword often returns little.
- **country_indeed** — supports 60+ countries (e.g. `USA`, `UK`, `India`, `Canada`, `Germany`). Needed only for Indeed/Glassdoor; harmless for others.
- **Rate limits / bans** — HTTP 429 = blocked. Space out scrapes, lower `results_wanted`, or pass `proxies`.
- **Proxies** — `proxies=['user:pass@host:port', 'localhost']`, round-robin across the list.
- **Cap** — ~1000 jobs per query regardless of `results_wanted`; paginate with `offset` for more.
- **ca_cert** — set to a CA bundle path behind corporate TLS-inspection proxies.

## Recipes

Remote US software roles, last 3 days, Indeed + LinkedIn:
```python
scrape_jobs(site_name=["indeed","linkedin"], search_term="software engineer",
            location="United States", is_remote=True, hours_old=72,
            results_wanted=50, country_indeed="USA")
```

India data-science roles with full LinkedIn descriptions:
```python
scrape_jobs(site_name=["linkedin","naukri"], search_term="data scientist",
            location="Bengaluru, India", results_wanted=40,
            linkedin_fetch_description=True, country_indeed="India")
```

Google Jobs (exact box phrasing):
```python
scrape_jobs(site_name=["google"],
            google_search_term="software engineer jobs near San Francisco, CA since yesterday",
            results_wanted=30)
```

Export:
```python
jobs.to_csv("jobs.csv", index=False)      # or .to_json(orient="records") / .to_excel(...)
```
