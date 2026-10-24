#!/usr/bin/env python3
"""Finalize one Tsenta run using native Hermes MCP tools."""
import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/<SERVER_USER>/.hermes/hermes-agent")
from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers  # noqa: E402
from tools.registry import registry  # noqa: E402


def parse_dt(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def mcp_call(suffix, args):
    name = "mcp__tsenta__" + suffix
    for _ in range(30):
        if name in registry._tools:
            break
        discover_mcp_tools()
        time.sleep(1)
    if name not in registry._tools:
        raise RuntimeError(f"Tsenta tool not registered: {name}")
    obj = json.loads(registry._tools[name].handler(args))
    if obj.get("error"):
        raise RuntimeError(str(obj["error"]))
    result = (obj.get("structuredContent") or {}).get("result", obj.get("result"))
    if isinstance(result, str):
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            return result
    return result


def list_bucket(bucket):
    rows = []
    page = 1
    counts = {}
    while True:
        data = mcp_call("list_applications", {
            "filter": bucket, "limit": 100, "page": page, "includeCounts": page == 1
        })
        batch = data.get("applications", []) if isinstance(data, dict) else []
        rows.extend(batch)
        if isinstance(data, dict):
            counts = data.get("counts") or counts
            pages = int((data.get("pagination") or {}).get("totalPages") or 1)
        else:
            pages = 1
        if page >= pages or not batch:
            break
        page += 1
    return rows, counts


def option_value(field, want_yes):
    desired = "yes" if want_yes else "no"
    for option in field.get("options") or []:
        label = str(option.get("label", "")).strip().lower()
        if label == desired or label.startswith(desired + " "):
            return option.get("value")
    return None


def review_decision(review):
    fields = review.get("fields") or [] if isinstance(review, dict) else []
    editable = set(review.get("editableFieldIds") or []) if isinstance(review, dict) else set()
    edits = {}
    reasons = []
    for field in fields:
        label = str(field.get("label") or "").strip().lower()
        display = str(field.get("display") if field.get("display") is not None else field.get("value") or "").strip().lower()
        fid = field.get("fieldId")
        hard_terms = ("itar", "export control", "security clearance", "top secret", "ts/sci", "u.s. person", "us person")
        if any(term in label for term in hard_terms):
            reasons.append(f"restricted requirement question: {label[:100]}")
        if ("citizen" in label or "permanent resident" in label) and any(term in label for term in ("must", "required", "only", "requirement")):
            reasons.append(f"citizenship requirement question: {label[:100]}")
        if fid not in editable:
            continue
        want = None
        if "sponsor" in label and any(term in label for term in ("future", "will you require", "now or in the future", "require sponsorship")):
            want = True
        elif "authorized to work" in label or "legally authorized" in label:
            want = True
        elif "citizen" in label:
            want = False
        if want is not None:
            desired = "yes" if want else "no"
            if display not in (desired, desired + "."):
                wire = option_value(field, want)
                if wire is not None:
                    edits[fid] = wire
                else:
                    reasons.append(f"could not safely correct answer for: {label[:100]}")
    return ("reject", {}, reasons) if reasons else ("approve", edits, [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoff", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--polls", type=int, default=12)
    ap.add_argument("--interval", type=int, default=20)
    args = ap.parse_args()
    cutoff = parse_dt(args.cutoff)
    out = Path(args.output)
    approved_resume = set()
    handled_submit = set()
    approval_failures = []
    review_rejections = []
    discover_mcp_tools()
    try:
        for round_no in range(args.polls):
            needs, _ = list_bucket("needs")
            run_needs = [a for a in needs if a.get("createdAt") and parse_dt(a["createdAt"]) >= cutoff]
            for app in run_needs:
                app_id = app["applicationId"]
                status = str(app.get("status") or "").upper()
                if status == "PENDING_RESUME_REVIEW" and app_id not in approved_resume:
                    try:
                        mcp_call("approve_application", {"applicationId": app_id})
                        approved_resume.add(app_id)
                    except Exception as exc:
                        approval_failures.append({"applicationId": app_id, "error": str(exc)})
                elif status == "PENDING_SUBMIT_REVIEW" and app_id not in handled_submit:
                    try:
                        review = mcp_call("get_application_review", {"applicationId": app_id})
                        decision, edits, reasons = review_decision(review)
                        payload = {"applicationId": app_id, "decision": decision}
                        if edits and decision == "approve":
                            payload["edits"] = edits
                        mcp_call("submit_application_review", payload)
                        handled_submit.add(app_id)
                        if decision == "reject":
                            review_rejections.append({"applicationId": app_id, "reasons": reasons})
                    except Exception as exc:
                        approval_failures.append({"applicationId": app_id, "error": str(exc)})
            all_rows, counts = list_bucket("all")
            run_rows = [a for a in all_rows if a.get("createdAt") and parse_dt(a["createdAt"]) >= cutoff]
            statuses = Counter(str(a.get("status") or "UNKNOWN").upper() for a in run_rows)
            print(json.dumps({"poll": round_no + 1, "run_rows": len(run_rows), "statuses": dict(statuses), "resume_approved": len(approved_resume), "submit_handled": len(handled_submit)}), flush=True)
            active = sum(v for k, v in statuses.items() if k not in {"COMPLETED", "FAILED", "SKIPPED"})
            if run_rows and active == 0:
                break
            if round_no + 1 < args.polls:
                time.sleep(args.interval)
        all_rows, counts = list_bucket("all")
        run_rows = [a for a in all_rows if a.get("createdAt") and parse_dt(a["createdAt"]) >= cutoff]
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "run_started_at_utc": args.cutoff,
            "applications": run_rows,
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2))
        summary = {
            "applications": len(run_rows),
            "statuses": dict(Counter(str(a.get("status") or "UNKNOWN").upper() for a in run_rows)),
            "resume_approved": len(approved_resume),
            "submit_reviews_handled": len(handled_submit),
            "review_rejections": review_rejections,
            "failures": approval_failures,
            "counts": counts,
            "output": str(out),
        }
        print("FINAL " + json.dumps(summary), flush=True)
    finally:
        shutdown_mcp_servers()


if __name__ == "__main__":
    main()
