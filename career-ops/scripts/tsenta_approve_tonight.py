#!/usr/bin/env python3
"""Approve tonight's Tsenta PENDING_RESUME_REVIEW apps and poll to terminal."""
import json, sys, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/<SERVER_USER>/.hermes/hermes-agent")
from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers  # noqa:E402
from tools.registry import registry  # noqa:E402

ROOT = Path("<CAREER_OPS_DIR>")
CUTOFF = datetime.fromisoformat("2026-09-08T03:00:00+00:00")
OUT = ROOT / "data" / "tsenta-applications-2026-09-07-continuation.json"


def mcp_call(tool_suffix, args):
    name = "mcp__tsenta__" + tool_suffix
    for _ in range(30):
        if name in registry._tools:
            break
        try:
            discover_mcp_tools()
        except Exception:
            pass
        time.sleep(1)
    if name not in registry._tools:
        available = sorted(n for n in registry._tools.keys() if "tsenta" in n.lower())
        raise RuntimeError(f"{name} missing; tsenta={available[:20]}")
    raw = registry._tools[name].handler(args)
    obj = json.loads(raw)
    if "error" in obj:
        raise RuntimeError(f"{name}: {obj['error']}")
    sc = obj.get("structuredContent")
    if isinstance(sc, dict) and "result" in sc:
        return sc["result"]
    res = obj.get("result")
    if isinstance(res, str):
        try:
            return json.loads(res)
        except Exception:
            return res
    return res


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def list_filter(filt, limit=100):
    page = 1
    rows = []
    counts = {}
    while True:
        resp = mcp_call(
            "list_applications",
            {"filter": filt, "limit": limit, "page": page, "includeCounts": True},
        )
        if isinstance(resp, dict):
            counts = resp.get("counts") or counts
            batch = resp.get("applications") or []
            pag = resp.get("pagination") or {}
        else:
            batch = []
            pag = {}
        rows.extend(batch)
        total_pages = int(pag.get("totalPages") or 1)
        if page >= total_pages or not batch:
            break
        page += 1
    return rows, counts


def is_tonight(app):
    dt = parse_dt(app.get("createdAt"))
    return dt is not None and dt >= CUTOFF


def main():
    discover_mcp_tools()
    needs, counts = list_filter("needs")
    tonight_needs = [a for a in needs if is_tonight(a)]
    print(
        "preflight needs",
        len(needs),
        "tonight",
        len(tonight_needs),
        Counter(a.get("status") for a in tonight_needs),
        "counts",
        counts,
        flush=True,
    )

    resume_ids = [
        a["applicationId"]
        for a in tonight_needs
        if a.get("status") == "PENDING_RESUME_REVIEW"
    ]
    approved = []
    failed = []
    for i, app_id in enumerate(resume_ids, 1):
        try:
            resp = mcp_call("approve_application", {"applicationId": app_id})
            approved.append({"id": app_id, "resp": resp})
            print(f"approve {i}/{len(resume_ids)} {app_id} ok", flush=True)
        except Exception as e:
            failed.append({"id": app_id, "error": str(e)})
            print(f"approve {i}/{len(resume_ids)} {app_id} FAIL {e}", flush=True)
        time.sleep(0.4)

    print("approved", len(approved), "failed", len(failed), flush=True)

    # bounded poll
    last_counts = {}
    for round_i in range(8):
        time.sleep(20)
        inflight, last_counts = list_filter("in_flight")
        needs2, last_counts = list_filter("needs")
        t_in = [a for a in inflight if is_tonight(a)]
        t_needs = [a for a in needs2 if is_tonight(a)]
        print(
            f"poll {round_i+1}",
            "tonight_in_flight",
            len(t_in),
            Counter(a.get("status") for a in t_in),
            "tonight_needs",
            len(t_needs),
            Counter(a.get("status") for a in t_needs),
            "counts",
            last_counts,
            flush=True,
        )
        submit_ids = [
            a["applicationId"]
            for a in t_needs
            if a.get("status") == "PENDING_SUBMIT_REVIEW"
        ]
        for app_id in submit_ids:
            try:
                review = mcp_call("get_application_review", {"applicationId": app_id})
                blob = json.dumps(review, ensure_ascii=False).lower()
                risky = any(
                    k in blob
                    for k in (
                        "us citizen",
                        "u.s. citizen",
                        "security clearance",
                        "export control",
                    )
                )
                if risky:
                    print(f"submit-review SKIP risky {app_id}", flush=True)
                    continue
                resp = mcp_call(
                    "submit_application_review",
                    {"applicationId": app_id, "decision": "approve"},
                )
                print(f"submit-review {app_id} ok {resp}", flush=True)
            except Exception as e:
                print(f"submit-review {app_id} FAIL {e}", flush=True)
        if not t_in and not t_needs:
            break

    all_apps, last_counts = list_filter("all")
    tonight = [a for a in all_apps if is_tonight(a)]
    OUT.write_text(json.dumps({"cutoff": CUTOFF.isoformat(), "counts": last_counts, "apps": tonight}, indent=2))
    print("tonight total", len(tonight), Counter(a.get("status") for a in tonight), flush=True)
    print("wrote", OUT, flush=True)
    try:
        shutdown_mcp_servers()
    except Exception:
        pass


if __name__ == "__main__":
    main()
