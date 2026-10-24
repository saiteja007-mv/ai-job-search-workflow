#!/usr/bin/env python3
"""Find accepted LinkedIn invites and send follow-up DMs via Unipile.

Safe output only: never prints API keys or raw unrelated chat history.
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
LOG_PATH = ROOT / "data" / "outreach_log.json"
REPORT_DIR = ROOT / "reports" / "unipile-outreach"
DEFAULT_ACCOUNT_ID = "<UNIPILE_ACCOUNT_ID>"


def load_env(path: Path = ENV) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None, timeout: int = 45) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    api_key = os.environ["UNIPILE_API_KEY"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "X-API-KEY": api_key,
        "accept": "application/json",
        "User-Agent": "career-ops-accepted-followups/1.0",
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
            parsed = {"raw": raw[:700]}
        return exc.code, {"error": parsed}


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def get_items(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("items", "data", "chats", "accounts", "messages"):
        val = data.get(key)
        if isinstance(val, list):
            return val
    return []


def account_summary(account_id: str | None) -> dict[str, Any]:
    status, data = api_request("GET", "/accounts")
    if status >= 400:
        raise RuntimeError(f"GET /accounts failed HTTP {status}")
    accounts = get_items(data)
    chosen = None
    for acct in accounts:
        if not isinstance(acct, dict):
            continue
        aid = acct.get("id") or acct.get("account_id")
        typ = acct.get("type") or acct.get("provider")
        if (account_id and aid == account_id) or (not account_id and str(typ).upper() == "LINKEDIN"):
            chosen = acct
            break
    if not chosen:
        raise RuntimeError(f"No matching LinkedIn account; account_count={len(accounts)}")
    return {
        "id": chosen.get("id") or chosen.get("account_id"),
        "type": chosen.get("type") or chosen.get("provider"),
        "name": chosen.get("name") or chosen.get("username") or chosen.get("email"),
        "status": chosen.get("status") or chosen.get("connection_status"),
        "account_count": len(accounts),
    }


def clean_company(title: str | None) -> str:
    if not title:
        return "your team"
    # Common title forms:
    # - "Technical Recruiter, Waymo"
    # - "Senior Technology Recruiter at Optum"
    # - "Applied AI for GTM | Automation, Data & Revenue Systems @ <TARGET_COMPANY>"
    # - "Machine Learning Engineer at Milwaukee Tool | AI at Carnegie Mellon"
    explicit_company = re.search(r"(?:\bat\b|@)\s+([^|/,]+)", title, flags=re.IGNORECASE)
    if explicit_company:
        company = explicit_company.group(1).strip(" .")
        if company:
            return company
    primary = re.split(r"\s+[|/]\s+", title, maxsplit=1)[0].strip()
    pieces = re.split(r"[,@—-]", primary)
    if len(pieces) >= 2:
        company = pieces[-1].strip(" .")
        if company:
            return company
    return "your team"


def followup_message(inv: dict[str, Any]) -> str:
    name_parts = (inv.get("name") or "").split()
    name = name_parts[0] if name_parts else "there"
    title = inv.get("title") or ""
    company = inv.get("company") or clean_company(title)
    role = inv.get("role_applied") or inv.get("role")
    is_recruiter = bool(re.search(r"recruit|talent|sourc", title, flags=re.IGNORECASE))
    if is_recruiter:
        context = f"your work around {company} recruiting"
    elif role:
        context = f"your work at {company} and the {role} role"
    else:
        context = f"your work at {company}"
    return (
        f"Hi {name}, thanks for connecting. I noticed {context} and wanted to follow up briefly. "
        "I’m a <TARGET_ROLE> with <N> years across <YOUR_CORE_SKILLS>. "
        f"If there’s an ML/AI engineering team or current opening at {company} where that background could fit, I’d appreciate any guidance on the best next step."
    )


def normalize_invite(ev: dict[str, Any], storage_key: str | None = None) -> dict[str, Any] | None:
    """Normalize invite records from both legacy events[] and sent_profiles{}.

    sent_profiles historically stored successful invites keyed as provider:<id>,
    sometimes with public_identifier + invitation_id but without channel/status.
    """
    if not isinstance(ev, dict):
        return None
    channel = ev.get("channel")
    has_success_status = int(ev.get("unipile_status") or 0) == 201
    has_invitation = bool(ev.get("invitation_id") or (isinstance(ev.get("unipile_response"), dict) and ev["unipile_response"].get("invitation_id")))
    looks_like_invite = channel in ("linkedin_connection_invite", "linkedin_invite") or has_invitation
    if not looks_like_invite or not (has_success_status or has_invitation):
        return None
    public_id = ev.get("public_id") or ev.get("public_identifier")
    if not public_id:
        return None
    out = dict(ev)
    out["public_id"] = public_id
    if not out.get("provider_id") and storage_key and storage_key.startswith("provider:"):
        out["provider_id"] = storage_key.split(":", 1)[1]
    if not out.get("linkedin"):
        out["linkedin"] = f"https://www.linkedin.com/in/{public_id}"
    if not out.get("message") and out.get("note"):
        out["message"] = out.get("note")
    return out


def invite_events(log: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    seen: set[str] = set()
    sources: list[tuple[str | None, Any]] = [(None, ev) for ev in log.get("events", [])]
    sent_profiles = log.get("sent_profiles", {})
    if isinstance(sent_profiles, dict):
        sources.extend((str(key), ev) for key, ev in sent_profiles.items())
    for storage_key, raw in sources:
        ev = normalize_invite(raw, storage_key)
        if not ev:
            continue
        key = ev.get("provider_id") or f"public:{str(ev['public_id']).lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append(ev)
    return out


def followed_keys(log: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for ev in log.get("events", []):
        if not isinstance(ev, dict):
            continue
        if ev.get("channel") == "linkedin_dm_followup" or ev.get("last_followup_at"):
            if ev.get("provider_id"):
                keys.add(str(ev["provider_id"]))
            if ev.get("public_id"):
                keys.add("public:" + str(ev["public_id"]).lower())
    return keys


def resolve_user(account_id: str, public_id: str) -> tuple[int, Any]:
    path = "/users/{}?account_id={}".format(urllib.parse.quote(public_id, safe=""), urllib.parse.quote(account_id, safe=""))
    return api_request("GET", path)


def is_accepted(profile: dict[str, Any]) -> bool:
    return bool(profile.get("is_relationship")) or str(profile.get("network_distance", "")).upper() == "FIRST_DEGREE"


def next_cursor(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    cur = data.get("cursor") or data.get("next_cursor")
    if cur:
        return str(cur)
    paging = data.get("paging") or data.get("pagination")
    if isinstance(paging, dict):
        for key in ("cursor", "next_cursor", "next"):
            if paging.get(key):
                return str(paging[key])
    return None


def extract_chat_id(chat: dict[str, Any]) -> str | None:
    for key in ("id", "chat_id", "object_id"):
        if chat.get(key):
            return str(chat[key])
    return None


def is_writable(chat: dict[str, Any]) -> bool:
    ro = chat.get("read_only")
    return ro in (0, False, "0", "false", "False", None)


def find_chat(account_id: str, provider_id: str, max_pages: int = 15) -> tuple[str | None, dict[str, Any] | None, int]:
    cursor = None
    pages = 0
    encoded_acct = urllib.parse.quote(account_id, safe="")
    while pages < max_pages:
        qs = f"account_id={encoded_acct}&limit=100"
        if cursor:
            qs += "&cursor=" + urllib.parse.quote(cursor, safe="")
        status, data = api_request("GET", "/chats?" + qs)
        pages += 1
        if status >= 400:
            return None, {"error": f"GET /chats HTTP {status}", "detail": data}, pages
        for chat in get_items(data):
            if not isinstance(chat, dict):
                continue
            blob = json.dumps(chat, sort_keys=True)
            if provider_id in blob and is_writable(chat):
                return extract_chat_id(chat), chat, pages
        cursor = next_cursor(data)
        if not cursor:
            break
    return None, None, pages


def chat_message_count(chat_id: str, limit: int = 10) -> int | None:
    status, data = api_request("GET", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages?limit={limit}")
    if status >= 400:
        return None
    return len(get_items(data))


def readback_message(chat_id: str, text: str, message_id: str | None) -> tuple[bool, int | None]:
    # Unipile can acknowledge MessageSent before the chat messages endpoint is
    # immediately consistent. Retry briefly before declaring verification failed.
    paths = [
        f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages",
        f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages?limit=100",
    ]
    for attempt in range(5):
        for path in paths:
            status, data = api_request("GET", path)
            if status >= 400:
                continue
            for msg in get_items(data):
                if not isinstance(msg, dict):
                    continue
                blob = json.dumps(msg)
                if message_id and str(message_id) in blob:
                    return True, msg.get("delivered_status")
                if text[:80] and text[:80] in blob:
                    return True, msg.get("delivered_status")
        time.sleep(1 + attempt)
    return False, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-send", type=int, default=5)
    args = ap.parse_args()

    load_env()
    log = load_log()
    account = account_summary(args.account_id)
    account_id = str(account["id"])
    invites = invite_events(log)
    already = followed_keys(log)
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")

    report: dict[str, Any] = {
        "ok": True,
        "dry_run": args.dry_run,
        "account": account,
        "checked_invites": len(invites),
        "accepted_count": 0,
        "already_followed": [],
        "attempted": [],
        "sent": [],
        "skipped": [],
        "failed": [],
    }

    sends = 0
    for inv in invites:
        key1 = inv.get("provider_id")
        key2 = "public:" + str(inv.get("public_id", "")).lower()
        if (key1 and key1 in already) or key2 in already or inv.get("last_followup_at"):
            report["already_followed"].append({"name": inv.get("name"), "public_id": inv.get("public_id")})
            continue
        status, profile = resolve_user(account_id, str(inv["public_id"]))
        if status >= 400 or not isinstance(profile, dict):
            report["failed"].append({"name": inv.get("name"), "public_id": inv.get("public_id"), "reason": f"resolve_user HTTP {status}"})
            continue
        provider_id = profile.get("provider_id") or inv.get("provider_id")
        accepted = is_accepted(profile)
        if not accepted:
            continue
        report["accepted_count"] += 1
        if sends >= args.max_send:
            report["skipped"].append({"name": inv.get("name"), "public_id": inv.get("public_id"), "reason": "max_send reached"})
            continue
        if not provider_id:
            report["failed"].append({"name": inv.get("name"), "public_id": inv.get("public_id"), "reason": "accepted but missing provider_id"})
            continue
        chat_id, chat, pages = find_chat(account_id, str(provider_id))
        if not chat_id:
            report["failed"].append({"name": inv.get("name"), "public_id": inv.get("public_id"), "provider_id": provider_id, "reason": "accepted but no writable chat found", "chat_pages": pages})
            continue
        existing_message_count = chat_message_count(chat_id)
        if existing_message_count is not None and existing_message_count > 1:
            report["skipped"].append({"name": inv.get("name"), "public_id": inv.get("public_id"), "provider_id": provider_id, "chat_id": chat_id, "reason": "chat already has conversation beyond original invite", "message_count": existing_message_count})
            continue
        text = followup_message(inv)
        attempt = {"name": inv.get("name"), "title": inv.get("title"), "public_id": inv.get("public_id"), "provider_id": provider_id, "chat_id": chat_id, "message": text}
        report["attempted"].append(attempt)
        if args.dry_run:
            sends += 1
            continue
        send_status, send_resp = api_request("POST", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages", {"text": text})
        if not (200 <= send_status < 300):
            report["failed"].append({**attempt, "reason": f"send HTTP {send_status}", "detail": send_resp})
            continue
        message_id = None
        if isinstance(send_resp, dict):
            message_id = send_resp.get("message_id") or send_resp.get("id")
        verified, delivered_status = readback_message(chat_id, text, str(message_id) if message_id else None)
        if not verified:
            report["failed"].append({**attempt, "reason": "sent but readback verification failed", "unipile_status": send_status, "unipile_response": send_resp})
            continue
        event = {
            "account_id": account_id,
            "channel": "linkedin_dm_followup",
            "sent_at": now,
            "name": inv.get("name"),
            "title": inv.get("title"),
            "linkedin": inv.get("linkedin"),
            "public_id": inv.get("public_id"),
            "provider_id": provider_id,
            "network_distance": profile.get("network_distance") or "FIRST_DEGREE",
            "chat_id": chat_id,
            "source_report": inv.get("source_report"),
            "message": text,
            "unipile_status": send_status,
            "unipile_response": send_resp if isinstance(send_resp, dict) else {},
            "message_id": message_id,
            "verified_in_chat": verified,
            "delivered_status": delivered_status,
        }
        log.setdefault("events", []).append(event)
        # Mark original invite event if this is the matching event object from log.
        inv["last_followup_at"] = now
        inv["last_followup_channel"] = "linkedin_dm_followup"
        report["sent"].append(event)
        sends += 1
        time.sleep(0.5)

    if not args.dry_run and report["sent"]:
        save_log(log)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    report_path = REPORT_DIR / f"accepted-followups-{stamp}.json"
    report["report_path"] = str(report_path.relative_to(ROOT))
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"],
        "dry_run": report["dry_run"],
        "account": report["account"],
        "checked_invites": report["checked_invites"],
        "accepted_count": report["accepted_count"],
        "already_followed_count": len(report["already_followed"]),
        "attempted_count": len(report["attempted"]),
        "sent_count": len(report["sent"]),
        "failed_count": len(report["failed"]),
        "skipped_count": len(report["skipped"]),
        "sent_names": [s.get("name") for s in report["sent"]],
        "attempted_names": [a.get("name") for a in report["attempted"]],
        "failed": [{"name": f.get("name"), "reason": f.get("reason")} for f in report["failed"]],
        "report_path": str(report_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
