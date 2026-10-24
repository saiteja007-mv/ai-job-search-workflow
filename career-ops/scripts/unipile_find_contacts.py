#!/usr/bin/env python3
"""Find + verify LinkedIn contacts at a company via Unipile.

Read-only: searches LinkedIn, reads each candidate profile, and verifies the
CURRENT employer from the profile itself. Prints JSON. Sends nothing.

Usage:
  python scripts/unipile_find_contacts.py --company "Reddit" --role "Machine Learning Engineer"
  python scripts/unipile_find_contacts.py --companies-json .run-0719/completed.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT_ID_DEFAULT = "<UNIPILE_ACCOUNT_ID>"

# priority order per modes/_custom.md rule 16 / task step 5
KEYWORD_TIERS = [
    ("recruiter", ["technical recruiter", "recruiter", "talent acquisition"]),
    ("hiring_manager", ["engineering manager machine learning", "director machine learning", "head of ai"]),
    ("peer", ["machine learning engineer", "ai engineer", "ml engineer"]),
]

AGENCY_RE = re.compile(
    r"\b(staffing|recruiting agency|talent solutions|consulting|search firm|headhunt|"
    r"robert half|insight global|teksystems|randstad|adecco|kforce|motion recruitment|"
    r"cybercoders|jobot|hays|apex systems|collabera|infosys|wipro|tcs|cognizant|"
    r"open to work|freelance recruiter|independent recruiter)\b",
    re.I,
)


def load_env() -> None:
    p = ROOT / ".env"
    if not p.exists():
        raise SystemExit("missing .env with UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in p.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def api(method: str, path: str, body: dict | None = None, timeout: int = 40):
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "X-API-KEY": os.environ["UNIPILE_API_KEY"],
        "accept": "application/json",
        "User-Agent": "career-ops-contact-finder/1.0",
    }
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}
    except Exception as e:  # network / timeout
        return 0, {"error": str(e)}


def employer_matches(company: str, *fields: str) -> bool:
    """Loose containment both ways — '<TARGET_COMPANY>, Inc.' vs '<TARGET_COMPANY>'."""
    norm = lambda s: re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    c = norm(company)
    ctoks = [t for t in c.split() if t not in {"inc", "llc", "corp", "the", "co", "ltd"}]
    if not ctoks:
        return False
    head = " ".join(ctoks)
    for f in fields:
        nf = norm(f)
        if head and head in nf:
            return True
        # single distinctive token match (e.g. "reddit", "cloudflare")
        if len(ctoks) == 1 and len(ctoks[0]) >= 4 and ctoks[0] in nf.split():
            return True
    return False


def search_company(company: str, account_id: str, per_tier: int = 6) -> list[dict]:
    out = []
    for ctype, kws in KEYWORD_TIERS:
        for kw in kws:
            status, res = api(
                "POST",
                f"/linkedin/search?account_id={urllib.parse.quote(account_id)}",
                {"api": "classic", "category": "people", "keywords": f"{kw} {company}"},
            )
            if status not in (200, 201):
                out.append({"_search_error": {"status": status, "kw": kw, "body": res}})
                continue
            items = res.get("items") or res.get("data") or []
            for it in items[:per_tier]:
                out.append(
                    {
                        "contact_type": ctype,
                        "keyword": kw,
                        "name": it.get("name") or it.get("full_name"),
                        "headline": it.get("headline"),
                        "public_id": it.get("public_identifier") or it.get("public_id"),
                        "provider_id": it.get("id") or it.get("provider_id"),
                        "network_distance": it.get("network_distance"),
                        "location": it.get("location"),
                    }
                )
            if len(out) >= per_tier * 2:
                break
    return out


def verify(cand: dict, company: str, account_id: str) -> dict:
    """Read the profile and confirm CURRENT employer. Agency recruiters rejected."""
    pid = cand.get("public_id")
    if not pid:
        return {**cand, "verified": False, "reason": "no public_id"}
    status, prof = api("GET", f"/users/{urllib.parse.quote(pid)}?account_id={urllib.parse.quote(account_id)}")
    if status != 200:
        return {**cand, "verified": False, "reason": f"profile read {status}", "body": prof}

    headline = prof.get("headline") or cand.get("headline") or ""
    # current employer can surface in several shapes depending on Unipile version
    exp = prof.get("work_experience") or prof.get("experience") or []
    cur_co = ""
    if isinstance(exp, list) and exp:
        e0 = exp[0] or {}
        cur_co = e0.get("company") or e0.get("company_name") or ""
    cur_co = cur_co or prof.get("current_company") or ""

    ok = employer_matches(company, headline, cur_co)
    agency = bool(AGENCY_RE.search(headline)) and not employer_matches(company, cur_co)
    return {
        **cand,
        "name": prof.get("name") or prof.get("full_name") or cand.get("name"),
        "headline": headline,
        "current_company": cur_co,
        "provider_id": prof.get("provider_id") or prof.get("id") or cand.get("provider_id"),
        "profile_url": f"https://www.linkedin.com/in/{pid}",
        "profile_read": "live-profile-read",
        "verified": bool(ok and not agency),
        "reason": "ok" if (ok and not agency) else ("agency/third-party recruiter" if agency else "employer not confirmed from profile"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--company")
    ap.add_argument("--role", default="")
    ap.add_argument("--companies-json", type=Path, help='[{"company":..,"role":..}]')
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", ACCOUNT_ID_DEFAULT))
    ap.add_argument("--max-per-company", type=int, default=2)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    load_env()

    targets = []
    if a.companies_json:
        targets = json.loads(a.companies_json.read_text())
    elif a.company:
        targets = [{"company": a.company, "role": a.role}]
    else:
        ap.error("need --company or --companies-json")

    results = []
    for t in targets:
        co = t["company"]
        cands = search_company(co, a.account_id)
        errs = [c["_search_error"] for c in cands if "_search_error" in c]
        cands = [c for c in cands if "_search_error" not in c]
        seen, verified = set(), []
        for c in cands:
            pid = c.get("public_id")
            if not pid or pid in seen:
                continue
            seen.add(pid)
            v = verify(c, co, a.account_id)
            if v.get("verified"):
                verified.append(v)
            if len(verified) >= a.max_per_company:
                break
        results.append(
            {
                "company": co,
                "role": t.get("role", ""),
                "searched": len(cands),
                "search_errors": errs[:3],
                "verified_contacts": verified,
            }
        )

    payload = json.dumps(results, indent=2)
    if a.out:
        a.out.write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
