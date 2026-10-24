#!/usr/bin/env python3
"""Invite non-connected LinkedIn users who engaged with <YOUR_NAME>'s posts.

Read-only discovery by default with --dry-run. Real sends use Unipile /users/invite
and are logged to data/linkedin-content-engager-outreach-log.json for de-dupe.
"""
from __future__ import annotations

import argparse
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
ENV = ROOT / ".env"
ACCOUNT_ID_DEFAULT = "<UNIPILE_ACCOUNT_ID>"
LOG_PATH = ROOT / "data" / "linkedin-content-engager-outreach-log.json"
REPORT_DIR = ROOT / "reports" / "linkedin-content-engagers"
OWN_AUTHOR_QUERY = 'author:"<YOUR_NAME>"'
OWN_PROFILE_NAMES = {"<YOUR_NAME>", "<YOUR_NAME>"}


def load_env(path: Path = ENV) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_request(method: str, path: str, body: dict[str, Any] | None = None, timeout: int = 40) -> tuple[int, Any]:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "X-API-KEY": os.environ["UNIPILE_API_KEY"],
        "accept": "application/json",
        "User-Agent": "career-ops-linkedin-content-engager-outreach/1.0",
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
        return exc.code, parsed
    except Exception as exc:
        return 0, {"error": f"{type(exc).__name__}: {exc}"}


def load_log() -> dict[str, Any]:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "sent_profiles": {}, "events": []}


def save_log(log: dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(log, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(LOG_PATH)


def account_summary(account_id: str) -> dict[str, Any]:
    st, data = api_request("GET", "/accounts")
    if st >= 400 or st == 0:
        raise RuntimeError(f"GET /accounts failed HTTP {st}: {data}")
    accounts = data if isinstance(data, list) else data.get("items") or data.get("accounts") or data.get("data") or []
    for a in accounts:
        if isinstance(a, dict) and (a.get("id") == account_id or a.get("account_id") == account_id):
            return {
                "id": a.get("id") or a.get("account_id"),
                "type": a.get("type") or a.get("provider"),
                "name": a.get("name") or a.get("username") or a.get("email"),
                "status": a.get("status") or a.get("connection_status"),
            }
    raise RuntimeError(f"No LinkedIn account matched {account_id}")


def linkedin_search_posts(account_id: str, query: str, max_posts: int) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    cursor = None
    while len(posts) < max_posts:
        body = {"api": "classic", "category": "posts", "keywords": query}
        if cursor:
            body["cursor"] = cursor
        st, data = api_request("POST", f"/linkedin/search?account_id={urllib.parse.quote(account_id)}", body)
        if st not in (200, 201) or not isinstance(data, dict):
            raise RuntimeError(f"post search failed HTTP {st}: {data}")
        items = data.get("items") or []
        for item in items:
            author = item.get("author") or {}
            if (author.get("name") or "").strip().lower() in OWN_PROFILE_NAMES:
                posts.append(item)
                if len(posts) >= max_posts:
                    break
        cursor = (data.get("paging") or {}).get("cursor") or data.get("cursor")
        if not cursor or not items:
            break
    return posts


def get_list(account_id: str, post_urn: str, kind: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    while True:
        q = f"account_id={urllib.parse.quote(account_id)}"
        if cursor:
            q += "&cursor=" + urllib.parse.quote(cursor)
        st, data = api_request("GET", f"/posts/{urllib.parse.quote(post_urn, safe='')}/{kind}?{q}")
        if st not in (200, 201) or not isinstance(data, dict):
            # Some posts expose reactions by numeric id but comments by URN. Caller passes URN.
            break
        items = data.get("items") or []
        out.extend(items)
        paging = data.get("paging") or {}
        cursor = paging.get("cursor")
        if not cursor or not items:
            break
    return out


def normalize_distance(raw: str | None) -> str:
    s = (raw or "").upper()
    if s in {"FIRST_DEGREE", "DISTANCE_1"}:
        return "FIRST_DEGREE"
    if s in {"SECOND_DEGREE", "DISTANCE_2"}:
        return "SECOND_DEGREE"
    if s in {"THIRD_DEGREE", "DISTANCE_3"}:
        return "THIRD_DEGREE"
    return raw or "UNKNOWN"


def author_from_engagement(item: dict[str, Any]) -> dict[str, Any] | None:
    if "author_details" in item and isinstance(item["author_details"], dict):
        a = dict(item["author_details"])
        a.setdefault("name", item.get("author"))
        return a
    a = item.get("author")
    return a if isinstance(a, dict) else None


def make_invite_text(name: str, post_text: str) -> str:
    first = (name or "there").split()[0]
    topic = "agent safety / AI engineering"
    lower = post_text.lower()
    if "rag" in lower or "llm" in lower:
        topic = "AI engineering and LLM systems"
    if "supply-chain" in lower or "security" in lower or "safety" in lower:
        topic = "AI agent safety"
    msg = f"Hi {first} — thanks for engaging with my LinkedIn post on {topic}. I’m building in AI/ML and agent workflows, and would value connecting."
    return msg[:300]


def profile_key(provider_id: str | None, profile_url: str | None) -> str:
    if provider_id:
        return f"provider:{provider_id}"
    return f"url:{(profile_url or '').rstrip('/')}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--account-id", default=os.getenv("UNIPILE_ACCOUNT_ID", ACCOUNT_ID_DEFAULT))
    ap.add_argument("--max-posts", type=int, default=10)
    ap.add_argument("--max-send", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--delay", type=float, default=45.0)
    args = ap.parse_args()

    load_env()
    acct = account_summary(args.account_id)
    account_id = acct["id"]
    log = load_log()
    sent_profiles = log.setdefault("sent_profiles", {})
    events = log.setdefault("events", [])
    posts = linkedin_search_posts(account_id, OWN_AUTHOR_QUERY, args.max_posts)
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []

    for post in posts:
        post_urn = post.get("social_id") or ("urn:li:activity:" + str(post.get("id")))
        post_text = post.get("text") or ""
        engagements = []
        for kind in ("comments", "reactions"):
            for item in get_list(account_id, post_urn, kind):
                author = author_from_engagement(item)
                if not author:
                    continue
                name = author.get("name") or author.get("author") or ""
                if name.strip().lower() in OWN_PROFILE_NAMES:
                    continue
                provider_id = author.get("id") or author.get("provider_id")
                profile_url = author.get("profile_url")
                key = profile_key(provider_id, profile_url)
                if key in seen:
                    continue
                seen.add(key)
                distance = normalize_distance(author.get("network_distance"))
                engagements.append({"kind": kind, "author": author, "key": key, "distance": distance})
        for e in engagements:
            author = e["author"]
            if e["distance"] == "FIRST_DEGREE":
                continue
            key = e["key"]
            already = key in sent_profiles or any(ev.get("provider_id") == author.get("id") for ev in events)
            candidates.append({
                "name": author.get("name"),
                "headline": author.get("headline"),
                "network_distance": e["distance"],
                "provider_id": author.get("id") or author.get("provider_id"),
                "profile_url": author.get("profile_url"),
                "engagement": e["kind"],
                "post_url": post.get("share_url"),
                "post_urn": post_urn,
                "post_date": post.get("parsed_datetime") or post.get("date"),
                "message": make_invite_text(author.get("name") or "there", post_text),
                "already_logged": already,
            })

    results = {"ok": True, "dry_run": args.dry_run, "account": acct, "posts_checked": len(posts), "candidates_found": len(candidates), "sent": [], "skipped": [], "failed": []}
    sends = 0
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    for c in candidates:
        if c["already_logged"]:
            results["skipped"].append({**c, "reason": "already logged"})
            continue
        if sends >= args.max_send:
            results["skipped"].append({**c, "reason": "max_send cap reached"})
            continue
        if not c.get("provider_id"):
            results["failed"].append({**c, "reason": "missing provider_id"})
            continue
        if args.dry_run:
            results["sent"].append({**c, "status": "would_send_invitation"})
            sends += 1
            continue
        st, resp = api_request("POST", "/users/invite", {"account_id": account_id, "provider_id": c["provider_id"], "message": c["message"]})
        if 200 <= st < 300:
            ev = {**c, "channel": "linkedin_connection_invite", "sent_at": now, "account_id": account_id, "source": "linkedin_content_engager_outreach", "unipile_status": st, "unipile_response": resp, "invitation_id": resp.get("invitation_id") if isinstance(resp, dict) else None}
            sent_profiles[profile_key(c.get("provider_id"), c.get("profile_url"))] = ev
            events.append(ev)
            save_log(log)
            results["sent"].append({**c, "status": "sent", "http_status": st, "invitation_id": ev.get("invitation_id")})
            sends += 1
            time.sleep(args.delay)
        else:
            results["failed"].append({**c, "reason": f"send failed HTTP {st}", "detail": resp})

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    report_path = REPORT_DIR / f"content-engagers-{stamp}.json"
    results["report_path"] = str(report_path)
    report_path.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": results["ok"],
        "dry_run": results["dry_run"],
        "posts_checked": results["posts_checked"],
        "candidates_found": results["candidates_found"],
        "sent_count": len(results["sent"]),
        "skipped_count": len(results["skipped"]),
        "failed_count": len(results["failed"]),
        "sent": [{"name": x.get("name"), "distance": x.get("network_distance"), "status": x.get("status"), "id": x.get("invitation_id"), "message": x.get("message")} for x in results["sent"]],
        "skipped": [{"name": x.get("name"), "reason": x.get("reason")} for x in results["skipped"]],
        "failed": [{"name": x.get("name"), "reason": x.get("reason"), "detail": x.get("detail")} for x in results["failed"]],
        "report_path": str(report_path),
    }, indent=2, ensure_ascii=False))
    return 0 if not results["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
