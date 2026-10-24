#!/usr/bin/env python3
"""Refresh data/tsenta-apps.json from live Tsenta list-applications."""
import json, sys, time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, "/home/<SERVER_USER>/.hermes/hermes-agent")
from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers  # noqa:E402
from tools.registry import registry  # noqa:E402

ROOT = Path("<CAREER_OPS_DIR>")
CH = ZoneInfo("America/Chicago")


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
        raise RuntimeError(name)
    raw = registry._tools[name].handler(args)
    obj = json.loads(raw)
    if "error" in obj:
        raise RuntimeError(obj["error"])
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


def main():
    discover_mcp_tools()
    page = 1
    apps = []
    counts = {}
    while True:
        resp = mcp_call(
            "list_applications",
            {"filter": "all", "limit": 100, "page": page, "includeCounts": True},
        )
        batch = resp.get("applications") or []
        counts = resp.get("counts") or counts
        apps.extend(batch)
        pag = resp.get("pagination") or {}
        total_pages = int(pag.get("totalPages") or 1)
        print(f"page {page}/{total_pages} got {len(batch)} total {len(apps)}", flush=True)
        if page >= total_pages or not batch:
            break
        page += 1

    today = datetime.now(CH).date().isoformat()
    out = []
    today_ct = 0
    opt_ct = 0
    for a in apps:
        created = a.get("createdAt") or a.get("appliedAt") or ""
        # Chicago-date for today count
        day = created[:10]
        try:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone(CH)
            day_ct = dt.date().isoformat()
        except Exception:
            day_ct = day
        if day_ct == today:
            today_ct += 1
        opt = bool(a.get("useOptimizedResume") or a.get("optimized") or a.get("isOptimized"))
        if opt:
            opt_ct += 1
        out.append(
            {
                "appId": a.get("applicationId") or a.get("id"),
                "company": a.get("companyName"),
                "title": a.get("jobTitle"),
                "atsType": a.get("atsType"),
                "status": a.get("status"),
                "optimized": opt,
                "appliedAt": created,
                "url": a.get("url"),
            }
        )
    summary = {
        "total": int(counts.get("all", len(apps))),
        "submitted": int(counts.get("submitted", 0)),
        "failed": int(counts.get("failed", 0)),
        "skipped": int(counts.get("skipped", 0)),
        "in_flight": int(counts.get("in_flight", 0)),
        "needs_approval": int(counts.get("needs", 0)),
        "today": today_ct,
        "optimized": opt_ct,
    }
    data = {
        "updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": summary,
        "apps": out,
    }
    path = ROOT / "data" / "tsenta-apps.json"
    path.write_text(json.dumps(data, indent=2))
    print(json.dumps({"wrote": str(path), "rows": len(out), "summary": summary, "counts": counts}))
    try:
        shutdown_mcp_servers()
    except Exception:
        pass


if __name__ == "__main__":
    main()
