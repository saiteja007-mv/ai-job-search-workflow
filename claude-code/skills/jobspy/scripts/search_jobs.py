#!/usr/bin/env python3
"""Thin, deterministic CLI wrapper around JobSpy's scrape_jobs().

Scrapes jobs from LinkedIn / Indeed / Glassdoor / Google / ZipRecruiter / Bayt /
Naukri / BDJobs into a pandas DataFrame and writes CSV/JSON/XLSX.

Usage:
  python search_jobs.py --search "software engineer" --location "San Francisco, CA" \
      --sites indeed,linkedin --results 20 --country USA --hours-old 72 --output jobs.csv

Only flags the caller sets are forwarded to scrape_jobs(), so JobSpy's own
defaults and per-site constraints are preserved. Import fails -> prints the
install command and exits 2 (non-fatal signal for the agent to bootstrap).
"""
import argparse
import sys


def csv_list(v):
    return [x.strip() for x in v.split(",") if x.strip()]


def main():
    p = argparse.ArgumentParser(description="Scrape jobs via JobSpy.")
    p.add_argument("--search", "-q", help="Search term (role/keywords).")
    p.add_argument("--google-search", help="Exact Google Jobs query (copy from the search box after filtering).")
    p.add_argument("--location", "-l", help='e.g. "San Francisco, CA" or "Bengaluru, India".')
    p.add_argument("--sites", type=csv_list, default=["indeed", "linkedin"],
                   help="Comma list: indeed,linkedin,glassdoor,google,zip_recruiter,bayt,naukri,bdjobs (default: indeed,linkedin).")
    p.add_argument("--results", "-n", type=int, default=20, help="Jobs wanted per site (default 20). ~1000 cap.")
    p.add_argument("--country", default="USA", help="country_indeed — REQUIRED for Indeed/Glassdoor (default USA).")
    p.add_argument("--hours-old", type=int, help="Only jobs posted within N hours.")
    p.add_argument("--job-type", choices=["fulltime", "parttime", "internship", "contract"])
    p.add_argument("--remote", action="store_true", help="Remote only.")
    p.add_argument("--distance", type=int, help="Radius in miles (default 50).")
    p.add_argument("--linkedin-descriptions", action="store_true",
                   help="Fetch full LinkedIn descriptions (much slower, O(n) extra requests).")
    p.add_argument("--offset", type=int, help="Start search from this offset.")
    p.add_argument("--proxies", type=csv_list, help="Comma list of user:pass@host:port (round-robin).")
    p.add_argument("--description-format", choices=["markdown", "html"], default="markdown")
    p.add_argument("--format", dest="fmt", choices=["csv", "json", "xlsx"], default="csv")
    p.add_argument("--output", "-o", default="jobspy_results.csv", help="Output file path.")
    p.add_argument("--verbose", type=int, default=1, choices=[0, 1, 2])
    args = p.parse_args()

    try:
        from jobspy import scrape_jobs
    except ImportError:
        sys.stderr.write("JobSpy not installed. Run:\n    pip install -U python-jobspy\n")
        sys.exit(2)

    # Forward only explicitly-set args -> preserve JobSpy defaults + per-site constraints.
    kw = dict(site_name=args.sites, results_wanted=args.results,
              country_indeed=args.country, description_format=args.description_format,
              verbose=args.verbose)
    if args.search: kw["search_term"] = args.search
    if args.google_search: kw["google_search_term"] = args.google_search
    if args.location: kw["location"] = args.location
    if args.hours_old is not None: kw["hours_old"] = args.hours_old
    if args.job_type: kw["job_type"] = args.job_type
    if args.remote: kw["is_remote"] = True
    if args.distance is not None: kw["distance"] = args.distance
    if args.linkedin_descriptions: kw["linkedin_fetch_description"] = True
    if args.offset is not None: kw["offset"] = args.offset
    if args.proxies: kw["proxies"] = args.proxies

    jobs = scrape_jobs(**kw)
    n = len(jobs)

    out = args.output
    if args.fmt == "csv":
        jobs.to_csv(out, index=False)
    elif args.fmt == "json":
        jobs.to_json(out, orient="records", indent=2, date_format="iso")
    else:
        jobs.to_excel(out, index=False)

    print(f"Found {n} jobs -> {out}")
    if n:
        cols = [c for c in ["site", "title", "company", "location", "job_url"] if c in jobs.columns]
        with_pd_opts(jobs[cols].head(15))


def with_pd_opts(df):
    import pandas as pd
    with pd.option_context("display.max_columns", None, "display.width", 200,
                           "display.max_colwidth", 60):
        print(df.to_string(index=False))


if __name__ == "__main__":
    main()
