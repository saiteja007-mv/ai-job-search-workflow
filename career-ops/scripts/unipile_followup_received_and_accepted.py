#!/usr/bin/env python3
"""Follow up LinkedIn received invites + accepted sent invites via Unipile.

This is intentionally batch-limited because the account already sends outreach daily.
Safe output only; never prints API keys or raw unrelated chat history.
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

# Prioritize high-signal received invitations first; leave placement/spammy/general peers queued.
RECEIVED_PUBLIC_IDS = {
    "shubhankar-agarwal",  # CEO / Co-founder at Synthefy
    "ravi-kiran-80991a217",  # Senior Talent Acquisition Specialist
}

# Prioritize accepted outbound connections with recruiter/talent signal at stronger employers first.
ACCEPTED_PROVIDER_IDS = {
    "<LINKEDIN_PROVIDER_ID>",  # Liliana Ramirez, Talent @ Micron
    "<LINKEDIN_PROVIDER_ID>",  # Vasudevan Kakkat, Senior Technical Recruiter
    "<LINKEDIN_PROVIDER_ID>",  # Shamaila A., Talent Advisor Cisco Engineering
    "<LINKEDIN_PROVIDER_ID>",  # Mark Cherne, recruiter @ Vizient
    "<LINKEDIN_PROVIDER_ID>",  # Morgan Linares, Sr Technical Recruiter at <TARGET_COMPANY>
}


def load_env() -> None:
    if not ENV.exists():
        raise SystemExit(f"Missing {ENV}")
    for raw in ENV.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None, timeout: int = 45) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    key = os.environ["UNIPILE_API_KEY"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"X-API-KEY": key, "accept": "application/json", "User-Agent": "career-ops-followups/1.0"}
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


def next_cursor(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in ("cursor", "next_cursor"):
        if data.get(key):
            return str(data[key])
    for parent_key in ("paging", "pagination"):
        parent = data.get(parent_key)
        if isinstance(parent, dict):
            for key in ("cursor", "next_cursor", "next"):
                if parent.get(key):
                    return str(parent[key])
    return None


def account_summary(account_id: str | None) -> dict[str, Any]:
    status, data = api_request("GET", "/accounts")
    if status >= 400:
        raise RuntimeError(f"GET /accounts HTTP {status}")
    accounts = get_items(data)
    for acct in accounts:
        if not isinstance(acct, dict):
            continue
        aid = acct.get("id") or acct.get("account_id")
        typ = acct.get("type") or acct.get("provider")
        if (account_id and aid == account_id) or (not account_id and str(typ).upper() == "LINKEDIN"):
            return {
                "id": aid,
                "type": typ,
                "name": acct.get("name") or acct.get("username") or acct.get("email"),
                "status": acct.get("status") or acct.get("connection_status"),
                "account_count": len(accounts),
            }
    raise RuntimeError(f"No matching LinkedIn account; account_count={len(accounts)}")


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def first_name(name: str | None) -> str:
    parts = (name or "").strip().split()
    return parts[0].strip(",") if parts else "there"


def company_from_title(title: str | None) -> str:
    if not title:
        return "your team"
    m = re.search(r"(?:\bat\b|@)\s+([^|/,]+)", title, re.I)
    if m and m.group(1).strip():
        return m.group(1).strip(" .")
    pieces = re.split(r"[,@|]", title)
    return pieces[-1].strip(" .") if len(pieces) > 1 and pieces[-1].strip() else "your team"


def outbound_message(name: str | None, title: str | None) -> str:
    company = company_from_title(title)
    return (
        f"Hi {first_name(name)}, thanks for connecting. I wanted to follow up briefly — "
        "I’m a <TARGET_ROLE> with <N> years across <YOUR_CORE_SKILLS>. "
        f"If there’s an ML/AI engineering team or current opening at {company} where that background could fit, I’d appreciate any guidance on the best next step."
    )


def inbound_message(name: str | None, description: str | None) -> str:
    company = company_from_title(description)
    lower = (description or "").lower()
    if company == "your team" or any(word in lower for word in ("recruit", "talent", "placement", "career advisor")):
        opportunity_context = "through your recruiting network"
    else:
        opportunity_context = f"around {company}"
    return (
        f"Hi {first_name(name)}, thanks for reaching out and connecting. "
        "I’m a <TARGET_ROLE> with <N> years across <YOUR_CORE_SKILLS>. "
        f"If you know of ML/AI engineering opportunities {opportunity_context} where that background could fit, I’d be glad to connect and learn more."
    )


def readback_message(chat_id: str, text: str, message_id: str | None) -> tuple[bool, Any]:
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
                if message_id and message_id in blob:
                    return True, msg.get("delivered_status")
                if text[:80] in blob:
                    return True, msg.get("delivered_status")
        time.sleep(1 + attempt)
    return False, None


def find_chat_by_provider(account_id: str, provider_id: str, max_pages: int = 8) -> tuple[str | None, int]:
    cursor = None
    pages = 0
    while pages < max_pages:
        qs = f"account_id={urllib.parse.quote(account_id, safe='')}&limit=100"
        if cursor:
            qs += "&cursor=" + urllib.parse.quote(cursor, safe="")
        status, data = api_request("GET", "/chats?" + qs)
        pages += 1
        if status >= 400:
            return None, pages
        for chat in get_items(data):
            if not isinstance(chat, dict):
                continue
            ro = chat.get("read_only")
            if ro not in (0, False, "0", "false", "False", None):
                continue
            blob = json.dumps(chat, sort_keys=True)
            if provider_id in blob:
                return str(chat.get("id") or chat.get("chat_id") or chat.get("object_id")), pages
        cursor = next_cursor(data)
        if not cursor:
            break
    return None, pages


def message_count(chat_id: str) -> int | None:
    status, data = api_request("GET", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages?limit=20")
    if status >= 400:
        return None
    return len(get_items(data))


def normalized_invites(log: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    def add(raw: Any, storage_key: str | None = None) -> None:
        if not isinstance(raw, dict):
            return
        resp = raw.get("unipile_response") if isinstance(raw.get("unipile_response"), dict) else {}
        if raw.get("channel") not in ("linkedin_connection_invite", "linkedin_invite") and not (raw.get("invitation_id") or resp.get("invitation_id")):
            return
        provider_id = raw.get("provider_id") or (storage_key.split(":", 1)[1] if storage_key and storage_key.startswith("provider:") else None)
        if not provider_id:
            return
        item = dict(raw)
        item.setdefault("provider_id", provider_id)
        item.setdefault("public_id", raw.get("public_id") or raw.get("public_identifier"))
        out.setdefault(str(provider_id), item)
    for ev in log.get("events", []):
        add(ev)
    for key, ev in (log.get("sent_profiles", {}) if isinstance(log.get("sent_profiles"), dict) else {}).items():
        add(ev, str(key))
    return out


def already_followed(log: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for ev in log.get("events", []):
        if not isinstance(ev, dict):
            continue
        if ev.get("channel") == "linkedin_dm_followup" or ev.get("last_followup_at"):
            if ev.get("provider_id"):
                keys.add(str(ev["provider_id"]))
            if ev.get("public_id"):
                keys.add("public:" + str(ev["public_id"]).lower())
            if ev.get("chat_id"):
                keys.add("chat:" + str(ev["chat_id"]))
    return keys


def mark_original_followed(log: dict[str, Any], provider_id: str, public_id: str | None, now: str) -> None:
    def mark(raw: Any, key: str | None = None) -> None:
        if not isinstance(raw, dict):
            return
        prov = raw.get("provider_id") or (key.split(":", 1)[1] if key and key.startswith("provider:") else None)
        pub = raw.get("public_id") or raw.get("public_identifier")
        if prov == provider_id or (public_id and pub == public_id):
            raw["last_followup_at"] = now
            raw["last_followup_channel"] = "linkedin_dm_followup"
    for ev in log.get("events", []):
        mark(ev)
    sent_profiles = log.get("sent_profiles", {})
    if isinstance(sent_profiles, dict):
        for key, raw in sent_profiles.items():
            mark(raw, str(key))


def sent_today_count(log: dict[str, Any]) -> int:
    today = dt.datetime.now().date().isoformat()
    n = 0
    for ev in log.get("events", []):
        if not isinstance(ev, dict):
            continue
        ts = str(ev.get("sent_at") or ev.get("ts") or ev.get("date") or "")
        if ts.startswith(today) and str(ev.get("channel", "")).startswith("linkedin"):
            n += 1
    return n


def list_received(account_id: str) -> list[dict[str, Any]]:
    status, data = api_request("GET", f"/users/invite/received?account_id={urllib.parse.quote(account_id, safe='')}&limit=100")
    if status >= 400:
        raise RuntimeError(f"GET received invites HTTP {status}")
    return [x for x in get_items(data) if isinstance(x, dict)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-actions", type=int, default=7, help="max outbound messages to send")
    args = ap.parse_args()

    load_env()
    log = load_log()
    account = account_summary(args.account_id)
    account_id = str(account["id"])
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    report: dict[str, Any] = {
        "ok": True,
        "dry_run": args.dry_run,
        "account": account,
        "already_linkedin_events_today_before_run": sent_today_count(log),
        "max_actions": args.max_actions,
        "received_checked": 0,
        "received_selected": [],
        "accepted_selected": [],
        "sent": [],
        "skipped": [],
        "failed": [],
    }

    sends = 0
    followed = already_followed(log)

    # 1) Handle selected received invitations.
    received = list_received(account_id)
    report["received_checked"] = len(received)
    for inv in received:
        inviter = inv.get("inviter") if isinstance(inv.get("inviter"), dict) else {}
        public_id = inviter.get("inviter_public_identifier") or inv.get("public_identifier")
        if public_id not in RECEIVED_PUBLIC_IDS:
            report["skipped"].append({"bucket": "received", "name": inviter.get("inviter_name") or inv.get("name"), "public_id": public_id, "reason": "not selected for limited same-day batch"})
            continue
        if sends >= args.max_actions:
            report["skipped"].append({"bucket": "received", "name": inviter.get("inviter_name"), "public_id": public_id, "reason": "max_actions reached"})
            continue
        invitation_id = str(inv.get("id") or inv.get("invitation_id") or "")
        provider_id = inviter.get("inviter_id") or inv.get("provider_id")
        description = inviter.get("inviter_description") or inv.get("description")
        name = inviter.get("inviter_name") or inv.get("name")
        shared_secret = (inv.get("specifics") or {}).get("shared_secret") if isinstance(inv.get("specifics"), dict) else None
        text = inbound_message(name, description)
        target = {"bucket": "received", "name": name, "public_id": public_id, "provider_id": provider_id, "description": description, "message": text}
        report["received_selected"].append(target)
        if args.dry_run:
            sends += 1
            continue
        if not invitation_id or not shared_secret or not provider_id:
            report["failed"].append({**target, "reason": "missing invitation_id/shared_secret/provider_id"})
            continue
        accept_body = {"provider": "LINKEDIN", "shared_secret": shared_secret, "account_id": account_id, "action": "accept"}
        accept_status, accept_resp = api_request("POST", f"/users/invite/received/{urllib.parse.quote(invitation_id, safe='')}", accept_body)
        if not (200 <= accept_status < 300):
            report["failed"].append({**target, "reason": f"accept HTTP {accept_status}", "detail": accept_resp})
            continue
        chat_status, chat_resp = api_request("POST", "/chats", {"account_id": account_id, "attendees_ids": [provider_id], "text": text})
        if not (200 <= chat_status < 300):
            report["failed"].append({**target, "reason": f"start_chat HTTP {chat_status}", "detail": chat_resp})
            continue
        chat_id = chat_resp.get("chat_id") or chat_resp.get("id") if isinstance(chat_resp, dict) else None
        message_id = chat_resp.get("message_id") or chat_resp.get("id") if isinstance(chat_resp, dict) else None
        verified, delivered = readback_message(str(chat_id), text, str(message_id) if message_id else None) if chat_id else (False, None)
        if not verified:
            report["failed"].append({**target, "chat_id": chat_id, "message_id": message_id, "reason": "sent but readback verification failed"})
            continue
        accept_event = {"account_id": account_id, "channel": "linkedin_inbound_invite_accepted", "sent_at": now, "name": name, "title": description, "linkedin": f"https://www.linkedin.com/in/{public_id}" if public_id else None, "public_id": public_id, "provider_id": provider_id, "invitation_id": invitation_id, "unipile_status": accept_status, "unipile_response": accept_resp if isinstance(accept_resp, dict) else {}}
        dm_event = {"account_id": account_id, "channel": "linkedin_dm_followup", "sent_at": now, "name": name, "title": description, "linkedin": f"https://www.linkedin.com/in/{public_id}" if public_id else None, "public_id": public_id, "provider_id": provider_id, "network_distance": "FIRST_DEGREE", "chat_id": chat_id, "source_report": "received_invitation", "message": text, "unipile_status": chat_status, "unipile_response": chat_resp if isinstance(chat_resp, dict) else {}, "message_id": message_id, "verified_in_chat": True, "delivered_status": delivered}
        log.setdefault("events", []).extend([accept_event, dm_event])
        report["sent"].append(dm_event)
        sends += 1
        time.sleep(0.8)

    # 2) Follow up selected accepted outbound invitations.
    invite_map = normalized_invites(log)
    for provider_id in ACCEPTED_PROVIDER_IDS:
        inv = invite_map.get(provider_id)
        if not inv:
            report["skipped"].append({"bucket": "accepted_outbound", "provider_id": provider_id, "reason": "provider not found in outreach log"})
            continue
        public_id = inv.get("public_id") or inv.get("public_identifier")
        if provider_id in followed or (public_id and "public:" + str(public_id).lower() in followed):
            report["skipped"].append({"bucket": "accepted_outbound", "name": inv.get("name"), "public_id": public_id, "provider_id": provider_id, "reason": "already followed"})
            continue
        if sends >= args.max_actions:
            report["skipped"].append({"bucket": "accepted_outbound", "name": inv.get("name"), "public_id": public_id, "provider_id": provider_id, "reason": "max_actions reached"})
            continue
        chat_id, pages = find_chat_by_provider(account_id, provider_id)
        if not chat_id:
            report["failed"].append({"bucket": "accepted_outbound", "name": inv.get("name"), "public_id": public_id, "provider_id": provider_id, "reason": "no writable chat found", "chat_pages": pages})
            continue
        cnt = message_count(chat_id)
        if cnt is not None and cnt > 1:
            report["skipped"].append({"bucket": "accepted_outbound", "name": inv.get("name"), "public_id": public_id, "provider_id": provider_id, "chat_id": chat_id, "reason": "chat already active", "message_count": cnt})
            continue
        text = outbound_message(inv.get("name"), inv.get("title") or inv.get("description"))
        target = {"bucket": "accepted_outbound", "name": inv.get("name"), "title": inv.get("title") or inv.get("description"), "public_id": public_id, "provider_id": provider_id, "chat_id": chat_id, "message": text}
        report["accepted_selected"].append(target)
        if args.dry_run:
            sends += 1
            continue
        send_status, send_resp = api_request("POST", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages", {"text": text})
        if not (200 <= send_status < 300):
            report["failed"].append({**target, "reason": f"send HTTP {send_status}", "detail": send_resp})
            continue
        message_id = send_resp.get("message_id") or send_resp.get("id") if isinstance(send_resp, dict) else None
        verified, delivered = readback_message(chat_id, text, str(message_id) if message_id else None)
        if not verified:
            report["failed"].append({**target, "message_id": message_id, "reason": "sent but readback verification failed"})
            continue
        event = {"account_id": account_id, "channel": "linkedin_dm_followup", "sent_at": now, "name": inv.get("name"), "title": inv.get("title") or inv.get("description"), "linkedin": inv.get("linkedin") or (f"https://www.linkedin.com/in/{public_id}" if public_id else None), "public_id": public_id, "provider_id": provider_id, "network_distance": "FIRST_DEGREE", "chat_id": chat_id, "source_report": inv.get("source_report"), "message": text, "unipile_status": send_status, "unipile_response": send_resp if isinstance(send_resp, dict) else {}, "message_id": message_id, "verified_in_chat": True, "delivered_status": delivered}
        log.setdefault("events", []).append(event)
        mark_original_followed(log, provider_id, public_id, now)
        report["sent"].append(event)
        sends += 1
        time.sleep(0.8)

    report["sent_count"] = len(report["sent"])
    report["failed_count"] = len(report["failed"])
    report["skipped_count"] = len(report["skipped"])
    report["already_linkedin_events_today_after_run"] = sent_today_count(log)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"received-and-accepted-followups-{dt.datetime.now().strftime('%Y-%m-%d-%H%M%S')}.json"
    report["report_path"] = str(report_path.relative_to(ROOT))
    if not args.dry_run and report["sent"]:
        save_log(log)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"],
        "dry_run": report["dry_run"],
        "account": report["account"],
        "already_linkedin_events_today_before_run": report["already_linkedin_events_today_before_run"],
        "received_checked": report["received_checked"],
        "received_selected_names": [x.get("name") for x in report["received_selected"]],
        "accepted_selected_names": [x.get("name") for x in report["accepted_selected"]],
        "sent_count": report["sent_count"],
        "sent_names": [x.get("name") for x in report["sent"]],
        "failed_count": report["failed_count"],
        "failed": [{"bucket": x.get("bucket"), "name": x.get("name"), "reason": x.get("reason")} for x in report["failed"]],
        "skipped_count": report["skipped_count"],
        "report_path": str(report_path),
    }, indent=2))
    return 0 if not report["failed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
