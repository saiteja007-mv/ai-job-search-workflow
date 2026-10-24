#!/usr/bin/env python3
"""Execute <YOUR_NAME>-approved LinkedIn post action queue via Unipile.

Reads data/linkedin-post-reply-queue.json. Intended only after explicit approval
such as "do all" in the Slack thread. Keeps external side effects conservative:
- COMMENT/JOB_POSTING: public comment using drafted_reply
- CONTACT_PERSON/APPLY_OR_DM: DM if already connected + writable chat exists,
  otherwise send connection invite using drafted_dm/connection_note.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "data" / "linkedin-post-reply-queue.json"
LOG = ROOT / "data" / "linkedin-post-action-log.json"
REPORT_DIR = ROOT / "reports" / "linkedin-post-actions"
ENV = ROOT / ".env"


def load_env() -> None:
    for line in ENV.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    key = os.environ["UNIPILE_API_KEY"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"X-API-KEY": key, "accept": "application/json", "User-Agent": "career-ops-linkedin-post-actions/1.0"}
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return r.status, {"raw": raw}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def get_items(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("items", "data", "accounts", "chats", "messages"):
        val = data.get(key)
        if isinstance(val, list):
            return val
    return []


def next_cursor(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    cur = data.get("cursor") or data.get("next_cursor")
    if cur:
        return str(cur)
    paging = data.get("paging") or data.get("pagination")
    if isinstance(paging, dict):
        cur = paging.get("cursor") or paging.get("next_cursor")
        if cur:
            return str(cur)
    return None


def account_summary(expected_id: str) -> dict[str, Any]:
    status, data = api_request("GET", "/accounts")
    if status >= 400:
        raise RuntimeError(f"GET /accounts failed HTTP {status}: {data}")
    accounts = get_items(data)
    acct = next((a for a in accounts if isinstance(a, dict) and (a.get("id") or a.get("account_id")) == expected_id), None)
    if not acct:
        acct = next((a for a in accounts if isinstance(a, dict) and (a.get("type") or a.get("provider")) == "LINKEDIN" and (a.get("name") or "").lower().startswith("<YOUR_NAME>")), None)
    if not acct:
        raise RuntimeError("<YOUR_NAME> LinkedIn account not found in /accounts")
    return {"id": acct.get("id") or acct.get("account_id"), "type": acct.get("type") or acct.get("provider"), "name": acct.get("name") or acct.get("username") or acct.get("email")}


def post_activity_urn(url: str) -> str | None:
    m = re.search(r"activity-(\d{15,25})", url or "")
    if m:
        return "urn:li:activity:" + m.group(1)
    m = re.search(r"(\d{15,25})", url or "")
    if m:
        return "urn:li:activity:" + m.group(1)
    return None


def public_id(profile_url: str | None) -> str | None:
    if not profile_url:
        return None
    m = re.search(r"linkedin\.com/in/([^/?#]+)", profile_url)
    return urllib.parse.unquote(m.group(1)).strip("/") if m else None


def resolve_user(account_id: str, pid: str) -> tuple[int, dict[str, Any]]:
    return api_request("GET", f"/users/{urllib.parse.quote(pid, safe='')}?account_id={urllib.parse.quote(account_id, safe='')}")


def is_relationship(profile: dict[str, Any]) -> bool:
    if profile.get("is_relationship") is True:
        return True
    dist = str(profile.get("network_distance") or "").upper()
    return dist in {"FIRST_DEGREE", "DISTANCE_1", "1", "1ST"}


def is_writable(chat: dict[str, Any]) -> bool:
    return chat.get("read_only") in (0, False, "0", "false", "False", None)


def extract_chat_id(chat: dict[str, Any]) -> str | None:
    for k in ("id", "chat_id", "provider_id"):
        if chat.get(k):
            return str(chat[k])
    return None


def find_chat(account_id: str, provider_id: str, max_pages: int = 15) -> tuple[str | None, int]:
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
            if isinstance(chat, dict) and provider_id in json.dumps(chat, sort_keys=True) and is_writable(chat):
                return extract_chat_id(chat), pages
        cursor = next_cursor(data)
        if not cursor:
            break
    return None, pages


def readback_comment(post_urn: str, account_id: str, text: str, comment_id: str | None) -> bool:
    path = f"/posts/{urllib.parse.quote(post_urn, safe='')}/comments?account_id={urllib.parse.quote(account_id, safe='')}"
    for attempt in range(5):
        status, data = api_request("GET", path)
        if status < 400:
            for c in get_items(data):
                blob = json.dumps(c)
                if comment_id and str(comment_id) in blob:
                    return True
                if text[:80] in blob:
                    return True
        time.sleep(1 + attempt)
    return False


def readback_message(chat_id: str, text: str, message_id: str | None) -> bool:
    for attempt in range(5):
        for path in (f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages?limit=100"):
            status, data = api_request("GET", path)
            if status < 400:
                for m in get_items(data):
                    blob = json.dumps(m)
                    if message_id and str(message_id) in blob:
                        return True
                    if text[:80] in blob:
                        return True
        time.sleep(1 + attempt)
    return False


def load_log() -> dict[str, Any]:
    if LOG.exists():
        return json.loads(LOG.read_text(encoding="utf-8"))
    return {"events": []}


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def item_profile_url(item: dict[str, Any]) -> str | None:
    contact = item.get("contact") or {}
    if isinstance(contact, dict) and contact.get("profile_url"):
        return str(contact.get("profile_url"))
    for key in ("contact_profile_url", "contact_profile", "profile_url", "linkedinProfileLink"):
        if item.get(key):
            return str(item.get(key))
    return None


def item_author(item: dict[str, Any]) -> str | None:
    return item.get("author") or item.get("author_contact")


def item_post_urn(item: dict[str, Any]) -> str | None:
    explicit = item.get("post_urn") or item.get("social_id")
    if explicit:
        return str(explicit)
    return post_activity_urn(str(item.get("post_url") or ""))


def already_done(log: dict[str, Any], item: dict[str, Any], channel: str) -> bool:
    url = item.get("post_url")
    person = item_profile_url(item)
    text = item.get("drafted_reply") or item.get("drafted_dm") or item.get("connection_note") or ""
    for ev in log.get("events", []):
        if ev.get("channel") == channel and ev.get("post_url") == url and ev.get("text") == text:
            return True
        if channel in {"linkedin_dm", "linkedin_connection_invite"} and ev.get("profile_url") == person and ev.get("text") == text:
            return True
    return False


def parse_item_filter(argv: list[str]) -> set[int] | None:
    """Return explicitly approved queue item IDs, or None for all items.

    Usage examples: `--items 1`, `--items 1,6`, `--items=1,6`.
    The default remains the historical do-all behavior.
    """
    raw: str | None = None
    for i, arg in enumerate(argv):
        if arg == "--items" and i + 1 < len(argv):
            raw = argv[i + 1]
            break
        if arg.startswith("--items="):
            raw = arg.split("=", 1)[1]
            break
    if raw is None:
        return None
    selected = {int(x) for x in re.split(r"[ ,]+", raw.strip()) if x}
    if not selected:
        raise SystemExit("--items was provided but no numeric item IDs were parsed")
    return selected


def main() -> int:
    import sys

    selected_items = parse_item_filter(sys.argv[1:])
    load_env()
    queue = json.loads(QUEUE.read_text(encoding="utf-8"))
    acct = account_summary(queue.get("account_verified", {}).get("id") or (queue.get("account") or {}).get("id") or "<UNIPILE_ACCOUNT_ID>")
    account_id = str(acct["id"])
    log = load_log()
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    report: dict[str, Any] = {"ok": True, "account": acct, "date": queue.get("date"), "selected_items": sorted(selected_items) if selected_items is not None else None, "attempted": [], "sent": [], "failed": [], "skipped": []}

    for idx, item in enumerate(queue.get("posts", []), 1):
        item_id = int(item.get("id") or idx)
        if selected_items is not None and item_id not in selected_items:
            report["skipped"].append({"item": item_id, "author": item_author(item), "reason": "not selected"})
            continue
        if item.get("status") not in ("pending_approval", "partially_done"):
            report["skipped"].append({"item": item_id, "author": item_author(item), "reason": f"status={item.get('status')}"})
            continue
        action_type = item.get("action_type")
        # Public comments for comment/job-posting items only.
        if action_type in {"COMMENT", "JOB_POSTING"}:
            text = item.get("drafted_reply")
            urn = item_post_urn(item)
            if not text or not urn:
                report["failed"].append({"item": item_id, "author": item_author(item), "action": "comment", "reason": "missing text or post urn"})
                continue
            if already_done(log, item, "linkedin_public_comment"):
                report["skipped"].append({"item": item_id, "author": item_author(item), "action": "comment", "reason": "already logged"})
                item["status"] = "done"
                continue
            body = {"account_id": account_id, "text": text}
            path = f"/posts/{urllib.parse.quote(urn, safe='')}/comments"
            report["attempted"].append({"item": item_id, "author": item_author(item), "action": "comment", "post_urn": urn, "text": text})
            status, resp = api_request("POST", path, body)
            if not (200 <= status < 300):
                report["failed"].append({"item": item_id, "author": item_author(item), "action": "comment", "http_status": status, "detail": resp})
                item["status"] = "failed"
                continue
            comment_id = resp.get("comment_id") or resp.get("id") if isinstance(resp, dict) else None
            verified = readback_comment(urn, account_id, text, str(comment_id) if comment_id else None)
            ev = {"channel": "linkedin_public_comment", "sent_at": now, "item": item_id, "author": item_author(item), "post_url": item.get("post_url"), "post_urn": urn, "text": text, "unipile_status": status, "unipile_response": resp if isinstance(resp, dict) else {}, "comment_id": comment_id, "verified": verified}
            log.setdefault("events", []).append(ev)
            report["sent"].append(ev)
            item["status"] = "done" if verified else "sent_unverified"
            time.sleep(1)
            continue

        if action_type in {"CONTACT_PERSON", "APPLY_OR_DM"}:
            contact = item.get("contact") or {}
            profile_url = item_profile_url(item)
            pid = public_id(profile_url)
            text = item.get("drafted_dm") or item.get("connection_note") or item.get("drafted_reply")
            if not pid or not text:
                report["failed"].append({"item": item_id, "author": item_author(item), "action": "contact", "reason": "missing profile public id or text"})
                continue
            status, profile = resolve_user(account_id, pid)
            if status >= 400 or not isinstance(profile, dict):
                report["failed"].append({"item": item_id, "author": item_author(item), "action": "resolve_user", "http_status": status, "detail": profile})
                item["status"] = "failed"
                continue
            provider_id = profile.get("provider_id") or profile.get("id") or contact.get("provider_id")
            if provider_id and is_relationship(profile):
                chat_id, pages = find_chat(account_id, str(provider_id))
                if chat_id:
                    if already_done(log, item, "linkedin_dm"):
                        report["skipped"].append({"item": idx, "author": item.get("author"), "action": "dm", "reason": "already logged"})
                        item["status"] = "done"
                        continue
                    report["attempted"].append({"item": item_id, "author": item_author(item), "action": "dm", "public_id": pid, "chat_id": chat_id, "text": text})
                    send_status, send_resp = api_request("POST", f"/chats/{urllib.parse.quote(chat_id, safe='')}/messages", {"text": text})
                    if not (200 <= send_status < 300):
                        report["failed"].append({"item": idx, "author": item.get("author"), "action": "dm", "http_status": send_status, "detail": send_resp})
                        item["status"] = "failed"
                        continue
                    message_id = send_resp.get("message_id") or send_resp.get("id") if isinstance(send_resp, dict) else None
                    verified = readback_message(chat_id, text, str(message_id) if message_id else None)
                    ev = {"channel": "linkedin_dm", "sent_at": now, "item": item_id, "author": item_author(item), "profile_url": profile_url, "public_id": pid, "provider_id": provider_id, "chat_id": chat_id, "post_url": item.get("post_url"), "text": text, "unipile_status": send_status, "unipile_response": send_resp if isinstance(send_resp, dict) else {}, "message_id": message_id, "verified": verified}
                    log.setdefault("events", []).append(ev)
                    report["sent"].append(ev)
                    item["status"] = "done" if verified else "sent_unverified"
                    time.sleep(1)
                    continue
            # Not connected or no writable chat: send connection invite (<=300 chars).
            invite_text = text[:300]
            if already_done(log, item, "linkedin_connection_invite"):
                report["skipped"].append({"item": idx, "author": item.get("author"), "action": "invite", "reason": "already logged"})
                item["status"] = "done"
                continue
            if not provider_id:
                report["failed"].append({"item": idx, "author": item.get("author"), "action": "invite", "reason": "missing provider_id"})
                item["status"] = "failed"
                continue
            report["attempted"].append({"item": item_id, "author": item_author(item), "action": "invite", "public_id": pid, "provider_id": provider_id, "text": invite_text})
            send_status, send_resp = api_request("POST", "/users/invite", {"account_id": account_id, "provider_id": provider_id, "message": invite_text})
            if not (200 <= send_status < 300):
                report["failed"].append({"item": idx, "author": item.get("author"), "action": "invite", "http_status": send_status, "detail": send_resp})
                item["status"] = "failed"
                continue
            ev = {"channel": "linkedin_connection_invite", "sent_at": now, "item": item_id, "author": item_author(item), "profile_url": profile_url, "public_id": pid, "provider_id": provider_id, "network_distance": profile.get("network_distance"), "post_url": item.get("post_url"), "text": invite_text, "unipile_status": send_status, "unipile_response": send_resp if isinstance(send_resp, dict) else {}, "invitation_id": send_resp.get("invitation_id") if isinstance(send_resp, dict) else None}
            log.setdefault("events", []).append(ev)
            report["sent"].append(ev)
            item["status"] = "done"
            time.sleep(1)
            continue

        report["skipped"].append({"item": idx, "author": item.get("author"), "action_type": action_type, "reason": "unsupported action type"})

    save_json(LOG, log)
    save_json(QUEUE, queue)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    report_path = REPORT_DIR / f"post-actions-{stamp}.json"
    report["report_path"] = str(report_path)
    save_json(report_path, report)
    print(json.dumps({
        "ok": report["ok"],
        "account": acct,
        "attempted_count": len(report["attempted"]),
        "sent_count": len(report["sent"]),
        "failed_count": len(report["failed"]),
        "skipped_count": len(report["skipped"]),
        "sent": [{"item": e.get("item"), "author": e.get("author"), "channel": e.get("channel"), "verified": e.get("verified"), "id": e.get("comment_id") or e.get("message_id") or e.get("invitation_id")} for e in report["sent"]],
        "failed": [{"item": f.get("item"), "author": f.get("author"), "action": f.get("action"), "http_status": f.get("http_status"), "reason": f.get("reason"), "detail_type": (f.get("detail") or {}).get("type") if isinstance(f.get("detail"), dict) else None} for f in report["failed"]],
        "report_path": str(report_path),
    }, indent=2))
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
