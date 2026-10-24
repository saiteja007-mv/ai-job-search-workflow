#!/usr/bin/env python3
"""Small Unipile sanity-check helper for career-ops outreach.

Loads <CAREER_OPS_DIR>/.env, calls the accounts endpoint, and prints a
redacted account summary. It intentionally does not print the API key.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"


def load_env(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}; expected UNIPILE_API_BASE and UNIPILE_API_KEY")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def request_json(path: str) -> object:
    base = os.environ["UNIPILE_API_BASE"].rstrip("/")
    api_key = os.environ["UNIPILE_API_KEY"]
    req = urllib.request.Request(
        f"{base}{path}",
        headers={"X-API-KEY": api_key, "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def main() -> int:
    load_env(ENV)
    data = request_json("/accounts")
    accounts = data if isinstance(data, list) else data.get("items") or data.get("accounts") or data.get("data") or []
    summary = []
    for account in accounts:
        if not isinstance(account, dict):
            continue
        summary.append(
            {
                "id": account.get("id") or account.get("account_id"),
                "type": account.get("type") or account.get("provider"),
                "name": account.get("name") or account.get("username") or account.get("email"),
                "status": account.get("status") or account.get("connection_status"),
            }
        )
    print(json.dumps({"ok": True, "account_count": len(accounts), "accounts": summary}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, indent=2), file=sys.stderr)
        raise SystemExit(1)
