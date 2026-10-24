#!/usr/bin/env python3
"""Send LinkedIn outreach for recent Tsenta-submitted applications via Unipile.

Discovers contacts at each applied company, verifies current employer from live
LinkedIn profile data, sends a short connection invitation, and records durable
dedupe state in data/outreach_log.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"
LOG_PATH = ROOT / "data" / "outreach_log.json"
ACCOUNT_ID_DEFAULT = "<UNIPILE_LINKEDIN_ACCOUNT_ID>"

KEYWORD_TIERS = [
    ("recruiter", ["technical recruiter", "recruiter", "talent acquisition"]),
    ("hiring_manager", ["engineering manager machine learning", "director machine learning", "head of ai"]),
    ("peer", ["machine learning engineer", "ai engineer", "ml engineer"]),
]

AGENCY_RE = re.compile(
    r"\b(staffing|recruiting agency|talent solutions|search firm|headhunt|"
    r"robert half|insight global|teksystems|randstad|adecco|kforce|motion recruitment|"
    r"cybercoders|jobot|hays|apex systems|collabera|infosys|wipro|tcs|cognizant|"
    r"open to work|freelance recruiter|independent recruiter)\b",
    re.I,
)

BAD_COMPANY_RE = re.compile(r"\b(<AGGREGATOR_A>|<AGGREGATOR_A> srl|the team & role|multiple positions available)\b", re.I)
# Mirrors BAD_TITLE / BAD_COMPANIES in run_tsenta_nightly_direct.py so a leaked
# apply never turns into LinkedIn outreach.
BAD_TITLE_RE = re.compile(
    r"\b(senior|sr\.?|lead|staff|principal|director|manager|architect|sales|account|support|"
    r"solution(s)? architect|field application|intern(ship)?|temporary|contract|"
    r"2027|new[- ]?grad(uate)?|ph\.?d|fellow(ship)?|unpaid|volunteer|student(s)?|cohort|visiting|"
    r"mechanical|recruit(er|ing)|talent acquisition|university program|bilingual|postdoc(toral)?|"
    r"orbit program|gtm|fleet|interview on|hiring event|talent community|expression of interest|campus)\b",
    re.I,
)
DEFENSE_COMPANY_RE = re.compile(
    r"\b(northrop|lockheed|raytheon|nightwing|booz|leidos|general dynamics|general atomics|"
    r"l3harris|anduril|palantir|bae systems|peraton|caci|saic|sierra nevada|<past_employer_2> federal|"
    r"credence|rtx|idt|innovative defense|spacex|nuclear company|nextgen federal systems|"
    r"applied research lab(oratory)?|penn state(\s+university)?\W+arl|arl\W+penn state)\b",
    re.I,
)
BAD_ROLE_RE = re.compile(
    r"\b(ts[/\\\s]*sci|ci\s+poly(graph)?|polygraph\s+(required|needed)|"
    r"active\s+(secret|top secret|security)\s+clearance|secret\s+clearance\s+(required|needed)|"
    r"top\s+secret\s+clearance|itar|export\s+control(led)?|u\.?s\.?\s+person(s)?\s+(only|required)|"
    r"us\s*citizen(ship)?\s*(is\s*)?(required|only)|\busc\s*/\s*gc\b|\busc\s+or\s+gc\b|"
    r"green\s+card\s+(required|only))\b",
    re.I,
)

PROOF_BY_ROLE = [
    # Role, not employer: LinkedIn text never names a company from the resume (<YOUR_NAME>, 2026-10-08).
    (re.compile(r"recommend|ranking|ads?|marketplace", re.I), "As a Machine Learning Scientist I built large-scale recommendation/ranking systems with Spark/Kafka and A/B testing."),
    (re.compile(r"rag|llm|gen(erative)? ai|agent|nlp", re.I), "In my AI/ML Engineer role I ship RAG/LLM and multimodal ML systems with production MLOps."),
    (re.compile(r"mlops|platform|infrastructure|serving", re.I), "I’ve deployed ML systems with FastAPI/Docker, AWS/Kubernetes, drift detection, and model versioning."),
    (re.compile(r"data scientist|forecast|analytics", re.I), "I bring ML + experimentation depth, including causal/A-B testing and production forecasting projects."),
]
DEFAULT_PROOF = "I build and ship ML systems end-to-end across recommendation systems, RAG/LLMs, and MLOps."


def load_env(path: Path = ENV) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api(method: str, path: str, body: dict[str, Any] | None = None, timeout: int = 40) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "X-API-KEY": os.environ["UNIPILE_API_KEY"],
        "accept": "application/json",
        "User-Agent": "career-ops-tsenta-unipile-outreach/1.0",
    }
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            return exc.code, {"raw": raw[:800]}
    except Exception as exc:
        return 0, {"error": f"{type(exc).__name__}: {exc}"}


def account_summary(account_id: str | None = None) -> dict[str, Any]:
    status, data = api("GET", "/accounts")
    if status >= 400 or status == 0:
        raise RuntimeError(f"GET /accounts failed: HTTP {status}: {data}")
    accounts = data if isinstance(data, list) else data.get("items") or data.get("accounts") or data.get("data") or []
    linkedin = [a for a in accounts if isinstance(a, dict) and (a.get("id") == account_id or a.get("account_id") == account_id or (not account_id and (a.get("type") or a.get("provider")) == "LINKEDIN"))]
    if not linkedin:
        raise RuntimeError(f"No LinkedIn account matched account_id={account_id!r}; account_count={len(accounts)}")
    a = linkedin[0]
    return {"id": a.get("id") or a.get("account_id"), "type": a.get("type") or a.get("provider"), "name": a.get("name") or a.get("username") or a.get("email"), "status": a.get("status") or a.get("connection_status")}


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def employer_matches(company: str, *fields: str) -> bool:
    def norm(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    c = norm(company)
    toks = [t for t in c.split() if t not in {"inc", "llc", "corp", "corporation", "the", "co", "company", "ltd", "srl", "us"}]
    if not toks:
        return False
    head = " ".join(toks)
    for f in fields:
        nf = norm(f)
        if head and head in nf:
            return True
        if len(toks) == 1 and len(toks[0]) >= 4 and toks[0] in nf.split():
            return True
    return False


def clean_company(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r"\s+SRL$", "", name, flags=re.I)
    return name


def public_url(public_id: str | None) -> str | None:
    if not public_id:
        return None
    return f"https://www.linkedin.com/in/{public_id}"


def search_candidates(company: str, account_id: str, per_query: int = 5) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    out: list[dict[str, Any]] = []
    errs: list[dict[str, Any]] = []
    for ctype, kws in KEYWORD_TIERS:
        for kw in kws:
            status, res = api("POST", f"/linkedin/search?account_id={urllib.parse.quote(account_id)}", {"api": "classic", "category": "people", "keywords": f"{kw} {company}"})
            if status not in (200, 201):
                errs.append({"status": status, "keyword": kw, "body": res})
                continue
            items = res.get("items") or res.get("data") or [] if isinstance(res, dict) else []
            for it in items[:per_query]:
                out.append({
                    "contact_type": ctype,
                    "keyword": kw,
                    "name": it.get("name") or it.get("full_name"),
                    "headline": it.get("headline"),
                    "public_id": it.get("public_identifier") or it.get("public_id"),
                    "provider_id": it.get("id") or it.get("provider_id"),
                    "network_distance": it.get("network_distance"),
                    "location": it.get("location"),
                })
            time.sleep(0.7)
            if len(out) >= 12:
                break
        if len(out) >= 12:
            break
    return out, errs


def verify_candidate(cand: dict[str, Any], company: str, account_id: str) -> dict[str, Any]:
    pid = cand.get("public_id")
    if not pid:
        return {**cand, "verified": False, "reason": "no public_id"}
    status, prof = api("GET", f"/users/{urllib.parse.quote(pid)}?account_id={urllib.parse.quote(account_id)}")
    if status != 200 or not isinstance(prof, dict):
        return {**cand, "verified": False, "reason": f"profile read {status}", "body": prof}
    headline = prof.get("headline") or cand.get("headline") or ""
    exp = prof.get("work_experience") or prof.get("experience") or []
    cur_co = ""
    if isinstance(exp, list) and exp:
        e0 = exp[0] or {}
        cur_co = e0.get("company") or e0.get("company_name") or ""
    cur_co = cur_co or prof.get("current_company") or ""
    agency = bool(AGENCY_RE.search(headline)) and not employer_matches(company, cur_co)
    ok = employer_matches(company, headline, cur_co)
    return {
        **cand,
        "name": prof.get("name") or prof.get("full_name") or cand.get("name"),
        "headline": headline,
        "current_company": cur_co,
        "provider_id": prof.get("provider_id") or prof.get("id") or cand.get("provider_id"),
        "profile_url": public_url(pid),
        "profile_read": "live-profile-read",
        "verified": bool(ok and not agency),
        "reason": "ok" if (ok and not agency) else ("agency/third-party recruiter" if agency else "employer not confirmed from profile"),
    }


def resume_companies() -> list[str]:
    """Employers from the CVs' Experience headings ("### Role | Company | Place"). Mirrors
    resumeCompanies() in deploy/linkedin-send.mjs; the CV files themselves are never changed."""
    out: list[str] = []
    for name in ("cv-aiml.md", "cv.md"):
        try:
            text = (ROOT / name).read_text(encoding="utf-8")
        except OSError:
            continue
        exp = next((sec for sec in re.split(r"(?m)^## ", text) if re.match(r"Experience\b", sec, re.I)), "")
        for m in re.finditer(r"(?m)^###\s+[^|\n]+\|\s*([^|\n]+?)\s*(?:\||$)", exp):
            if m.group(1).strip() not in out:
                out.append(m.group(1).strip())
    return out


def names_past_employer(text: str, their_company: str) -> str | None:
    """The first resume employer the text names, ignoring the recipient's own company."""
    for c in resume_companies():
        rx = re.compile(r"\b" + re.escape(c) + r"\b", re.I)
        if not rx.search(their_company or "") and rx.search(text or ""):
            return c
    return None


def message_for(contact: dict[str, Any], app: dict[str, Any]) -> str:
    first = (contact.get("name") or "there").split()[0]
    role = app_role(app) or "AI/ML role"
    company = clean_company(app_company(app) or "your team")
    proof = DEFAULT_PROOF
    for rx, p in PROOF_BY_ROLE:
        if rx.search(role):
            proof = p
            break
    msg = f"Hi {first} — I just applied for {role} at {company}. {proof} I’d appreciate connecting if this background could fit your team."
    if len(msg) <= 300 and not names_past_employer(msg, company):
        return msg
    msg = f"Hi {first} — I just applied for {role} at {company}. I build ML systems end-to-end across RAG/LLMs, recommendations, and MLOps. I’d appreciate connecting."
    if len(msg) <= 300:
        return msg
    return f"Hi {first} — I just applied for an AI/ML role at {company}. My background spans production RAG/LLMs, recommendation systems, and MLOps. I’d appreciate connecting."


def normalize_key(contact: dict[str, Any]) -> str:
    if contact.get("provider_id"):
        return f"provider:{contact['provider_id']}"
    return f"linkedin:{str(contact.get('public_id','')).lower()}"


def app_company(app: dict[str, Any]) -> str:
    return app.get("companyName") or app.get("company") or app.get("company_name") or ""


def app_role(app: dict[str, Any]) -> str:
    return app.get("jobTitle") or app.get("title") or app.get("job_title") or app.get("role") or ""


def app_created_at(app: dict[str, Any]) -> str:
    return app.get("createdAt") or app.get("created_at") or app.get("appliedAt") or app.get("applied_at") or ""


def app_application_id(app: dict[str, Any]) -> str | None:
    return app.get("applicationId") or app.get("app_id") or app.get("application_id")


def app_job_id(app: dict[str, Any]) -> str | None:
    return app.get("jobId") or app.get("job_id")


def app_url(app: dict[str, Any]) -> str | None:
    return app.get("url") or app.get("applicationUrl") or app.get("jobUrl")


def send_invitation(account_id: str, provider_id: str, message: str) -> tuple[int, Any]:
    return api("POST", "/users/invite", {"account_id": account_id, "provider_id": provider_id, "message": message})


def unipile_error_type(resp: Any) -> str:
    return resp.get("type") if isinstance(resp, dict) else ""


def eligible_apps(apps: list[dict[str, Any]], since: str | None) -> list[dict[str, Any]]:
    out = []
    seen_companies = set()
    for a in sorted(apps, key=app_created_at):
        if since and str(app_created_at(a)) < since:
            continue
        if a.get("status") != "COMPLETED":
            continue
        if BAD_ROLE_RE.search(app_role(a)) or BAD_TITLE_RE.search(app_role(a)):
            continue
        co = clean_company(app_company(a))
        if not co or BAD_COMPANY_RE.search(co) or DEFENSE_COMPANY_RE.search(co):
            continue
        # One outreach per company per run to reduce spam if multiple apps landed.
        k = re.sub(r"[^a-z0-9]+", "", co.lower())
        if k in seen_companies:
            continue
        seen_companies.add(k)
        out.append(a)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apps-json", type=Path, required=True, help="JSON list of Tsenta applications or object containing applications")
    ap.add_argument("--since", default=None, help="ISO createdAt lower bound")
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", ACCOUNT_ID_DEFAULT))
    ap.add_argument("--max-send", type=int, default=35, help="LinkedIn daily safety cap")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--delay", type=float, default=75.0, help="Seconds between real sends")
    ap.add_argument("--out", type=Path, default=ROOT / "reports" / f"tsenta-unipile-outreach-{dt.date.today().isoformat()}.json")
    args = ap.parse_args()

    load_env()
    account = account_summary(args.account_id)
    account_id = account["id"]
    raw = json.loads(args.apps_json.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        apps = raw.get("applications") or raw.get("apps") or []
    else:
        apps = raw
    apps = eligible_apps(apps, args.since)
    log = load_log()
    sent_profiles: dict[str, Any] = log.setdefault("sent_profiles", {})
    events: list[Any] = log.setdefault("events", [])
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    results: dict[str, Any] = {
        "ok": True,
        "dry_run": args.dry_run,
        "account": account,
        "since": args.since,
        "eligible_applications": len(apps),
        "max_send": args.max_send,
        "sent": [],
        "skipped": [],
        "failed": [],
    }
    sends = 0
    for app in apps:
        company = clean_company(app_company(app))
        if sends >= args.max_send:
            results["skipped"].append({"company": company, "role": app_role(app), "reason": "daily max_send safety cap reached"})
            continue
        candidates, errs = search_candidates(company, account_id)
        verified = []
        seen = set()
        for cand in candidates:
            pid = cand.get("public_id")
            if not pid or pid in seen:
                continue
            seen.add(pid)
            v = verify_candidate(cand, company, account_id)
            if v.get("verified"):
                verified.append(v)
                break
            time.sleep(0.5)
        if not verified:
            results["failed"].append({"company": company, "role": app_role(app), "reason": "no verified current-company contact found", "search_errors": errs[:2]})
            continue
        contact = verified[0]
        key = normalize_key(contact)
        alt_key = f"linkedin:{str(contact.get('public_id','')).lower()}"
        if key in sent_profiles or alt_key in sent_profiles:
            results["skipped"].append({"company": company, "role": app_role(app), "contact": contact.get("name"), "linkedin": contact.get("profile_url"), "reason": "already in outreach_log"})
            continue
        msg = message_for(contact, app)
        preview = {
            "company": company,
            "role": app_role(app),
            "applicationId": app_application_id(app),
            "contact": contact.get("name"),
            "contact_type": contact.get("contact_type"),
            "headline": contact.get("headline"),
            "linkedin": contact.get("profile_url"),
            "provider_id": contact.get("provider_id"),
            "message": msg,
        }
        if args.dry_run:
            results["sent"].append({**preview, "status": "would_send_invitation"})
            sends += 1
            continue
        provider_id = contact.get("provider_id")
        if not provider_id:
            results["failed"].append({**preview, "reason": "verified contact missing provider_id"})
            continue
        st, resp = send_invitation(account_id, provider_id, msg)
        if 200 <= st < 300:
            event = {
                "sent_at": now,
                "channel": "linkedin_connection_invite",
                "account_id": account_id,
                "source": "tsenta_application_outreach",
                "applicationId": app_application_id(app),
                "jobId": app_job_id(app),
                "company": company,
                "role": app_role(app),
                "applicationUrl": app_url(app),
                "name": contact.get("name"),
                "title": contact.get("headline"),
                "linkedin": contact.get("profile_url"),
                "public_id": contact.get("public_id"),
                "provider_id": provider_id,
                "network_distance": contact.get("network_distance"),
                "message": msg,
                "unipile_status": st,
                "unipile_response": resp,
            }
            sent_profiles[key] = event
            if alt_key != key:
                sent_profiles[alt_key] = {"alias_for": key, "sent_at": now}
            events.append(event)
            save_log(log)
            results["sent"].append({**preview, "status": "sent", "http_status": st})
            sends += 1
            time.sleep(args.delay)
        else:
            err_type = unipile_error_type(resp)
            if err_type == "errors/already_invited_recently":
                event = {
                    "sent_at": now,
                    "channel": "linkedin_connection_invite",
                    "account_id": account_id,
                    "source": "tsenta_application_outreach",
                    "applicationId": app_application_id(app),
                    "jobId": app_job_id(app),
                    "company": company,
                    "role": app_role(app),
                    "applicationUrl": app_url(app),
                    "name": contact.get("name"),
                    "title": contact.get("headline"),
                    "linkedin": contact.get("profile_url"),
                    "public_id": contact.get("public_id"),
                    "provider_id": provider_id,
                    "network_distance": contact.get("network_distance"),
                    "message": msg,
                    "unipile_status": st,
                    "unipile_response": resp,
                    "handled_as": "already_invited_recently_date_unverified",
                }
                sent_profiles[key] = event
                if alt_key != key:
                    sent_profiles[alt_key] = {"alias_for": key, "sent_at": now}
                events.append(event)
                save_log(log)
                results["skipped"].append({**preview, "reason": "already_invited_recently", "detail": resp})
                continue
            results["failed"].append({**preview, "reason": f"send failed HTTP {st}", "detail": resp})
            if st in (429, 999) or err_type == "errors/cannot_resend_yet":
                results["ok"] = False
                results["stopped_reason"] = f"rate/LinkedIn block HTTP {st}" if err_type != "errors/cannot_resend_yet" else "temporary provider limit: cannot_resend_yet"
                break
    # Missing verified contacts are normal for this workflow: do not make the
    # whole cron fail when successful sends were recorded. Keep non-zero exits
    # for real send failures/rate blocks so the scheduler surfaces them.
    hard_failures = [
        f for f in results["failed"]
        if f.get("reason") != "no verified current-company contact found"
    ]
    if hard_failures or results.get("stopped_reason"):
        results["ok"] = False
    else:
        results["ok"] = True
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": results["ok"],
        "dry_run": args.dry_run,
        "eligible_applications": results["eligible_applications"],
        "sent": len(results["sent"]),
        "skipped": len(results["skipped"]),
        "failed": len(results["failed"]),
        "hard_failures": len(hard_failures),
        "stopped_reason": results.get("stopped_reason"),
        "out": str(args.out),
    }, indent=2))
    return 0 if results["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
