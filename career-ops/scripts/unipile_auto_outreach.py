#!/usr/bin/env python3
"""Send daily LinkedIn outreach via Unipile with durable de-dupe.

Default input is the latest reports/recruiter-outreach-YYYY-MM-DD.md file.
The script resolves each LinkedIn public identifier, sends a connection
invitation with the drafted connect request, and records successes/failures in
 data/outreach_log.json so the same profile is never messaged twice by cron.

Use --dry-run to inspect exactly what would be sent without side effects.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
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
REPORTS = ROOT / "reports"
LOG_PATH = ROOT / "data" / "outreach_log.json"
CONTACTS_PATH = ROOT / "data" / "contacts.json"
CONTACT_STATUS_PATH = ROOT / "data" / "contact-status.json"
ACCOUNT_ID_DEFAULT = "<UNIPILE_ACCOUNT_ID>"

SECTION_RE = re.compile(
    r"^(?:#{2,3}\s+|\*\*)(?P<num>\d+)\.\s+(?P<name>.+?)\s+—\s+(?P<title>.+?)(?:\*\*)?(?=\s+\(confidence|$)",
    re.M,
)
LINKEDIN_RE = re.compile(r"^\*\*LinkedIn:\*\*\s+(?P<url>https?://\S+)", re.M)
CONNECT_RE = re.compile(
    r"^\*\*Connect request \(<=300 chars\):\*\*\s*\n>\s*(?P<msg>.+?)(?=\n\*\*|\n\n\*\*\d+\.|\Z)",
    re.M | re.S,
)
INMAIL_RE = re.compile(
    r"^\*\*Email / InMail \(<=120 words\):\*\*\s*\n>\s*(?P<msg>.+?)(?=\n\*\*|\n\n\*\*\d+\.|\Z)",
    re.M | re.S,
)


def load_env(path: Path = ENV) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None, *, timeout: int = 30) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    api_key = os.environ["UNIPILE_API_KEY"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"X-API-KEY": api_key, "accept": "application/json", "User-Agent": "career-ops-unipile-outreach/1.0"}
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
            parsed: Any = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw[:1000]}
        return exc.code, {"error": parsed}


def account_summary(account_id: str | None = None) -> dict[str, Any]:
    status, data = api_request("GET", "/accounts")
    if status >= 400:
        raise RuntimeError(f"GET /accounts failed: HTTP {status}: {data}")
    accounts = data if isinstance(data, list) else data.get("items") or data.get("accounts") or data.get("data") or []
    linkedin = [a for a in accounts if isinstance(a, dict) and (a.get("id") == account_id or a.get("account_id") == account_id or (not account_id and (a.get("type") or a.get("provider")) == "LINKEDIN"))]
    if not linkedin:
        raise RuntimeError(f"No LinkedIn account matched account_id={account_id!r}; account_count={len(accounts)}")
    account = linkedin[0]
    return {
        "id": account.get("id") or account.get("account_id"),
        "type": account.get("type") or account.get("provider"),
        "name": account.get("name") or account.get("username") or account.get("email"),
        "status": account.get("status") or account.get("connection_status"),
    }


def latest_report() -> Path:
    files = sorted(REPORTS.glob("recruiter-outreach-*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        raise SystemExit(f"No recruiter-outreach reports found in {REPORTS}")
    return files[0]


def clean_quoted(text: str) -> str:
    lines = []
    for line in text.strip().splitlines():
        line = line.strip()
        if line.startswith(">"):
            line = line[1:].strip()
        lines.append(line)
    return "\n".join(lines).strip()


def public_id(linkedin_url: str) -> str | None:
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", linkedin_url)
    if not m:
        return None
    return urllib.parse.unquote(m.group(1)).strip("/")


def parse_report(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    sections = list(SECTION_RE.finditer(text))
    contacts: list[dict[str, Any]] = []
    for idx, match in enumerate(sections):
        start = match.start()
        end = sections[idx + 1].start() if idx + 1 < len(sections) else len(text)
        block = text[start:end]
        url_m = LINKEDIN_RE.search(block)
        conn_m = CONNECT_RE.search(block)
        inmail_m = INMAIL_RE.search(block)
        if not url_m or not conn_m:
            continue
        url = url_m.group("url").rstrip(").,")
        pid = public_id(url)
        if not pid:
            continue
        msg = clean_quoted(conn_m.group("msg"))
        contacts.append(
            {
                "source_report": str(path.relative_to(ROOT)),
                "rank": int(match.group("num")),
                "name": match.group("name").strip(),
                "title": match.group("title").strip(),
                "linkedin": url,
                "public_id": pid,
                "connect_message": msg,
                "inmail_message": clean_quoted(inmail_m.group("msg")) if inmail_m else None,
            }
        )
    return contacts


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def sent_date(prior: dict[str, Any] | None, fallback_iso: str) -> str:
    raw = (prior or {}).get("sent_at") or fallback_iso
    return str(raw)[:10]


def sync_dashboard_contacts(report: Path, results: dict[str, Any], fallback_iso: str) -> dict[str, Any]:
    """Reflect durable Unipile send state in the Contacts dashboard data.

    The webapp's contact cards read data/contacts.json dateSent fields; the
    outreach log alone is not enough for the dashboard to show a sent badge.
    """
    summary = {"contacts_path": str(CONTACTS_PATH), "updated_contacts": 0, "status_updated": False, "skipped": ""}
    if not CONTACTS_PATH.exists():
        summary["skipped"] = "contacts.json missing"
        return summary

    contacts_data = json.loads(CONTACTS_PATH.read_text(encoding="utf-8"))
    apps = contacts_data if isinstance(contacts_data, list) else contacts_data.get("applications", [])
    report_key = str(report.relative_to(ROOT) if report.is_relative_to(ROOT) else report)
    date_key_match = re.search(r"recruiter-outreach-(\d{4})-(\d{2})-(\d{2})\.md", report.name)
    app_number = "".join(date_key_match.groups()) if date_key_match else None

    app = None
    for item in apps:
        if app_number and str(item.get("appNumber")) == app_number:
            app = item
            break
        if item.get("url") == report_key or item.get("url") == str(report):
            app = item
            break
    if not app:
        summary["skipped"] = f"no contacts bucket found for {report_key}"
        return summary

    sent_by_url: dict[str, str] = {}
    for item in results.get("sent", []):
        if item.get("status") == "sent" and item.get("linkedin"):
            sent_by_url[item["linkedin"].rstrip("/")] = fallback_iso[:10]
    for item in results.get("skipped", []):
        prior = item.get("prior") or {}
        if item.get("reason") == "already in outreach_log" and item.get("linkedin"):
            sent_by_url[item["linkedin"].rstrip("/")] = sent_date(prior, fallback_iso)

    for contact in app.get("contacts", []):
        url = (contact.get("linkedinProfileLink") or contact.get("linkedin") or "").rstrip("/")
        if not url or url not in sent_by_url:
            continue
        contact["dateSent"] = sent_by_url[url]
        contact["status"] = "sent"
        summary["updated_contacts"] += 1

    if app_number and results.get("candidates_found") and not results.get("failed"):
        contacts = app.get("contacts", [])
        if contacts and all((c.get("dateSent") or (c.get("linkedinProfileLink") or c.get("linkedin") or "").rstrip("/") in sent_by_url) for c in contacts):
            statuses = {}
            if CONTACT_STATUS_PATH.exists():
                statuses = json.loads(CONTACT_STATUS_PATH.read_text(encoding="utf-8")) or {}
            statuses[str(app_number)] = "Sent"
            CONTACT_STATUS_PATH.write_text(json.dumps(statuses, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            summary["status_updated"] = True

    tmp = CONTACTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(contacts_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(CONTACTS_PATH)
    return summary


def normalize_key(contact: dict[str, Any], user_profile: dict[str, Any] | None = None) -> str:
    provider_id = (user_profile or {}).get("provider_id")
    if provider_id:
        return f"provider:{provider_id}"
    return f"linkedin:{contact['public_id'].lower()}"


def resolve_user(account_id: str, public_identifier: str) -> tuple[int, Any]:
    path = "/users/{}?account_id={}".format(
        urllib.parse.quote(public_identifier, safe=""), urllib.parse.quote(account_id, safe="")
    )
    return api_request("GET", path)


def send_invitation(account_id: str, provider_id: str, message: str) -> tuple[int, Any]:
    # Unipile LinkedIn invitation endpoint. Body shape verified against the
    # current career-ops runbook and kept minimal to avoid accidental extras.
    return api_request("POST", "/users/invite", {"account_id": account_id, "provider_id": provider_id, "message": message})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, default=None, help="recruiter-outreach markdown report; defaults to latest")
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", ACCOUNT_ID_DEFAULT))
    ap.add_argument("--max-send", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-unverified", action="store_true", help="reserved; script currently relies on report's verified LinkedIn URLs")
    args = ap.parse_args()

    load_env()
    account = account_summary(args.account_id)
    account_id = account["id"]
    report = args.report or latest_report()
    contacts = parse_report(report)
    log = load_log()
    sent_profiles: dict[str, Any] = log.setdefault("sent_profiles", {})
    events: list[Any] = log.setdefault("events", [])

    today = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    results = {
        "ok": True,
        "dry_run": args.dry_run,
        "account": account,
        "source_report": str(report.relative_to(ROOT) if report.is_relative_to(ROOT) else report),
        "candidates_found": len(contacts),
        "sent": [],
        "skipped": [],
        "failed": [],
    }

    sends = 0
    for contact in contacts:
        if sends >= args.max_send:
            results["skipped"].append({"contact": contact["name"], "reason": "daily max_send reached"})
            continue
        if len(contact["connect_message"]) > 300:
            results["failed"].append({"contact": contact["name"], "reason": f"connect message too long ({len(contact['connect_message'])})"})
            continue

        status, profile = resolve_user(account_id, contact["public_id"])
        if status >= 400 or not isinstance(profile, dict):
            results["failed"].append({"contact": contact["name"], "linkedin": contact["linkedin"], "reason": f"resolve failed HTTP {status}", "detail": profile})
            continue
        key = normalize_key(contact, profile)
        alt_key = f"linkedin:{contact['public_id'].lower()}"
        if key in sent_profiles or alt_key in sent_profiles:
            prior = sent_profiles.get(key) or sent_profiles.get(alt_key)
            results["skipped"].append({"contact": contact["name"], "linkedin": contact["linkedin"], "reason": "already in outreach_log", "prior": prior})
            continue

        preview = {
            "contact": contact["name"],
            "title": contact["title"],
            "linkedin": contact["linkedin"],
            "provider_id": profile.get("provider_id"),
            "network_distance": profile.get("network_distance"),
            "is_relationship": profile.get("is_relationship"),
            "message": contact["connect_message"],
        }
        if args.dry_run:
            results["sent"].append({**preview, "status": "would_send_invitation"})
            sends += 1
            continue

        provider_id = profile.get("provider_id")
        if not provider_id:
            results["failed"].append({**preview, "reason": "missing provider_id after resolve"})
            continue
        send_status, send_resp = send_invitation(account_id, provider_id, contact["connect_message"])
        if 200 <= send_status < 300:
            event = {
                "sent_at": today,
                "channel": "linkedin_connection_invite",
                "account_id": account_id,
                "source_report": contact["source_report"],
                "rank": contact["rank"],
                "name": contact["name"],
                "title": contact["title"],
                "linkedin": contact["linkedin"],
                "public_id": contact["public_id"],
                "provider_id": provider_id,
                "network_distance": profile.get("network_distance"),
                "message": contact["connect_message"],
                "unipile_status": send_status,
                "unipile_response": send_resp,
            }
            sent_profiles[key] = event
            if alt_key != key:
                sent_profiles[alt_key] = {"alias_for": key, "sent_at": today}
            events.append(event)
            save_log(log)
            results["sent"].append({**preview, "status": "sent", "http_status": send_status, "response": send_resp})
            sends += 1
            time.sleep(2)  # small spacing to avoid bursty LinkedIn automation
        else:
            results["failed"].append({**preview, "reason": f"send failed HTTP {send_status}", "detail": send_resp})
            # Do not retry alternate shapes automatically; a valid retry could create duplicates.

    if not args.dry_run:
        results["dashboard_sync"] = sync_dashboard_contacts(report, results, today)
    if results["failed"]:
        results["ok"] = False
    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 0 if results["ok"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, indent=2), file=sys.stderr)
        raise SystemExit(1)
