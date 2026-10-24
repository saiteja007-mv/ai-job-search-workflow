#!/usr/bin/env python3
"""Batch LinkedIn connection outreach from data/linkedin-suggestions-usa.csv.

Safe defaults:
- dry-run unless --send is passed
- durable de-dupe against data/outreach_log.json
- max batch size defaults to 15
- exact profile resolution via Unipile before send
- one result artifact per run under reports/send-results/
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "linkedin-suggestions-usa.csv"
ENV = ROOT / ".env"
LOG_PATH = ROOT / "data" / "outreach_log.json"
RESULTS_DIR = ROOT / "reports" / "send-results"
ACCOUNT_ID_DEFAULT = "<UNIPILE_ACCOUNT_ID>"


def load_env(path: Path = ENV) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None, *, timeout: int = 30) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    api_key = os.environ["UNIPILE_API_KEY"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "X-API-KEY": api_key,
        "accept": "application/json",
        "User-Agent": "career-ops-linkedin-csv-outreach/1.0",
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
            parsed: Any = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw[:1000]}
        return exc.code, {"error": parsed}


def account_summary(account_id: str | None = None) -> dict[str, Any]:
    status, data = api_request("GET", "/accounts")
    if status >= 400:
        raise RuntimeError(f"GET /accounts failed: HTTP {status}: {data}")
    accounts = data if isinstance(data, list) else data.get("items") or data.get("accounts") or data.get("data") or []
    linkedin = [
        a for a in accounts
        if isinstance(a, dict)
        and (
            a.get("id") == account_id
            or a.get("account_id") == account_id
            or (not account_id and (a.get("type") or a.get("provider")) == "LINKEDIN")
        )
    ]
    if not linkedin:
        raise RuntimeError(f"No LinkedIn account matched account_id={account_id!r}; account_count={len(accounts)}")
    account = linkedin[0]
    return {
        "id": account.get("id") or account.get("account_id"),
        "type": account.get("type") or account.get("provider"),
        "name": account.get("name") or account.get("username") or account.get("email"),
        "status": account.get("status") or account.get("connection_status"),
    }


def public_id(linkedin_url: str) -> str | None:
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", linkedin_url or "")
    if not m:
        return None
    return urllib.parse.unquote(m.group(1)).strip("/")


def load_csv(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, row in enumerate(rows, start=1):
        url = (row.get("LinkedIn Profile") or "").strip().rstrip("/")
        pid = public_id(url)
        if not pid:
            out.append({"row": idx, "raw": row, "skip_reason": "missing_or_invalid_linkedin_url"})
            continue
        key = pid.lower()
        if key in seen:
            out.append({"row": idx, "raw": row, "skip_reason": "duplicate_in_csv", "public_id": pid, "linkedin": url})
            continue
        seen.add(key)
        name = (row.get("Name") or row.get("Card Name") or "").strip()
        title = (row.get("Resolved Headline") or row.get("Job Role") or row.get("Card Headline") or "").strip()
        company = (row.get("Current Company") or "").strip()
        out.append({
            "row": idx,
            "name": name,
            "title": title,
            "company": company,
            "job_role": (row.get("Job Role") or "").strip(),
            "location": (row.get("Location") or "").strip(),
            "us_status": (row.get("US Status") or "").strip(),
            "match_confidence": (row.get("Match Confidence") or "").strip(),
            "linkedin": url,
            "public_id": pid,
            "source_csv": str(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path),
        })
    return out


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        data = json.loads(LOG_PATH.read_text(encoding="utf-8"))
        if "sent_profiles" not in data:
            data["sent_profiles"] = {}
        if "events" not in data:
            data["events"] = []
        return data
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def note_for(contact: dict[str, Any]) -> str:
    name = (contact.get("name") or "there").split()[0]
    role = contact.get("job_role") or contact.get("title") or "AI/ML recruiting"
    company = contact.get("company")
    if company:
        msg = (
            f"Hi {name}, I’m <YOUR_NAME>, an AI/ML Engineer. Saw your {role} work at {company}; "
            "my background is <YOUR_CORE_SKILLS>. Happy to connect."
        )
    else:
        msg = (
            f"Hi {name}, I’m <YOUR_NAME>, an AI/ML Engineer. Saw your {role} background; "
            "my work is <YOUR_CORE_SKILLS>. Happy to connect."
        )
    # LinkedIn connection note hard limit is 300 chars. Keep a conservative margin.
    if len(msg) > 295:
        msg = f"Hi {name}, I’m <YOUR_NAME>, an AI/ML Engineer focused on GenAI/RAG, MLOps, and recsys with Spark/Kafka. Happy to connect."
    return msg[:300]


def normalize_key(public_id: str, user_profile: dict[str, Any] | None = None) -> str:
    provider_id = (user_profile or {}).get("provider_id")
    return f"provider:{provider_id}" if provider_id else f"linkedin:{public_id.lower()}"


def resolve_user(account_id: str, public_id_value: str) -> tuple[int, Any]:
    quoted = urllib.parse.quote(public_id_value, safe="")
    return api_request("GET", f"/users/{quoted}?account_id={urllib.parse.quote(account_id)}", timeout=35)


def send_invitation(account_id: str, provider_id: str, message: str) -> tuple[int, Any]:
    return api_request("POST", "/users/invite", {"account_id": account_id, "provider_id": provider_id, "message": message}, timeout=35)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--account-id", default=ACCOUNT_ID_DEFAULT)
    parser.add_argument("--max-send", type=int, default=15, help="max candidates processed/sent in this run")
    parser.add_argument("--offset", type=int, default=0, help="skip this many unsent sendable candidates after de-dupe")
    parser.add_argument("--send", action="store_true", help="actually send invitations; default is dry-run")
    parser.add_argument("--sleep-min", type=float, default=180.0, help="minimum seconds between real sends")
    parser.add_argument("--sleep-max", type=float, default=420.0, help="maximum seconds between real sends")
    parser.add_argument("--stop-on-failure", action="store_true")
    args = parser.parse_args()

    if args.max_send < 1:
        raise SystemExit("--max-send must be >= 1")
    if args.send and args.sleep_max < args.sleep_min:
        raise SystemExit("--sleep-max must be >= --sleep-min")

    load_env()
    account = account_summary(args.account_id)
    if account.get("type") != "LINKEDIN":
        raise SystemExit(f"Matched account is not LinkedIn: {account}")

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    contacts_all = load_csv(args.csv)
    log = load_log()
    sent_profiles = log.setdefault("sent_profiles", {})

    invalid_or_duplicate = [c for c in contacts_all if c.get("skip_reason")]
    candidates = [c for c in contacts_all if not c.get("skip_reason")]

    pre_skipped = []
    sendable = []
    for c in candidates:
        key = f"linkedin:{c['public_id'].lower()}"
        url_key = c["linkedin"].rstrip("/").lower()
        prior = sent_profiles.get(key) or sent_profiles.get(url_key)
        if prior:
            pre_skipped.append({**c, "reason": "already in outreach_log", "prior": prior})
        else:
            sendable.append(c)

    batch = sendable[args.offset: args.offset + args.max_send]
    result: dict[str, Any] = {
        "ok": True,
        "dry_run": not args.send,
        "source_csv": str(args.csv),
        "account": account,
        "started_at": now,
        "total_rows": len(contacts_all),
        "valid_unique_profiles": len(candidates),
        "invalid_or_duplicate_count": len(invalid_or_duplicate),
        "already_logged_count": len(pre_skipped),
        "sendable_before_offset": len(sendable),
        "offset": args.offset,
        "max_send": args.max_send,
        "batch_count": len(batch),
        "invalid_or_duplicate": invalid_or_duplicate[:25],
        "skipped": pre_skipped[:50],
        "prepared": [],
        "sent": [],
        "failed": [],
    }

    for i, contact in enumerate(batch, start=1):
        note = note_for(contact)
        if len(note) > 300:
            result["failed"].append({**contact, "reason": "note_over_300_chars", "chars": len(note)})
            if args.stop_on_failure:
                break
            continue
        status, user = resolve_user(account["id"], contact["public_id"])
        if status >= 400:
            result["failed"].append({**contact, "reason": "resolve_failed", "http_status": status, "response": user})
            if args.stop_on_failure:
                break
            continue
        provider_id = user.get("provider_id") if isinstance(user, dict) else None
        norm_key = normalize_key(contact["public_id"], user if isinstance(user, dict) else None)
        prior = sent_profiles.get(norm_key)
        prepared = {
            **contact,
            "message": note,
            "chars": len(note),
            "provider_id": provider_id,
            "network_distance": user.get("network_distance") if isinstance(user, dict) else None,
            "is_relationship": user.get("is_relationship") if isinstance(user, dict) else None,
            "headline_verified": user.get("headline") if isinstance(user, dict) else None,
        }
        if prior:
            result["skipped"].append({**prepared, "reason": "already in outreach_log_provider", "prior": prior})
            continue
        if not provider_id:
            result["failed"].append({**prepared, "reason": "missing_provider_id"})
            if args.stop_on_failure:
                break
            continue
        result["prepared"].append(prepared)
        if not args.send:
            continue

        send_status, send_resp = send_invitation(account["id"], provider_id, note)
        event = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "channel": "linkedin_connection_invite",
            "source": "linkedin_csv_outreach",
            "source_csv": str(args.csv.relative_to(ROOT) if args.csv.is_relative_to(ROOT) else args.csv),
            "row": contact["row"],
            "name": contact["name"],
            "title": contact["title"],
            "company": contact["company"],
            "linkedin": contact["linkedin"],
            "public_id": contact["public_id"],
            "provider_id": provider_id,
            "message": note,
            "http_status": send_status,
            "response": send_resp,
        }
        if 200 <= send_status < 300:
            sent_record = {**prepared, "status": "sent", "http_status": send_status, "response": send_resp}
            result["sent"].append(sent_record)
            sent_profiles[norm_key] = {
                "sent_at": event["ts"],
                "channel": event["channel"],
                "name": contact["name"],
                "linkedin": contact["linkedin"],
                "source_csv": event["source_csv"],
                "row": contact["row"],
                "message": note,
            }
            sent_profiles[f"linkedin:{contact['public_id'].lower()}"] = sent_profiles[norm_key]
            log.setdefault("events", []).append(event)
            save_log(log)
        else:
            result["failed"].append({**prepared, "reason": "send_failed", "http_status": send_status, "response": send_resp})
            if args.stop_on_failure:
                break
        if args.send and i < len(batch):
            time.sleep(random.uniform(args.sleep_min, args.sleep_max))

    result["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    result["ok"] = not result["failed"]
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    mode = "send" if args.send else "dryrun"
    out_path = RESULTS_DIR / f"linkedin-csv-outreach-{mode}-{stamp}.json"
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": result["ok"],
        "dry_run": result["dry_run"],
        "account": account,
        "total_rows": result["total_rows"],
        "valid_unique_profiles": result["valid_unique_profiles"],
        "already_logged_count": result["already_logged_count"],
        "sendable_before_offset": result["sendable_before_offset"],
        "batch_count": result["batch_count"],
        "prepared_count": len(result["prepared"]),
        "sent_count": len(result["sent"]),
        "failed_count": len(result["failed"]),
        "result_path": str(out_path),
    }, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
