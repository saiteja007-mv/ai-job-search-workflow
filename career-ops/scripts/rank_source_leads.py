#!/usr/bin/env python3
"""Rank the priority_a leads from a source-leads import into a genuinely ordered batch.

Why this exists: the importer's `score` saturates — all 152 priority_a companies came out
at 100 — so slicing a "top 60" off that list ordered by nothing but company name. That cut
Groq, Inflection AI, H2O.ai, Harness, Kong, Mercury and Modern Treasury (all strong AI/ML or
explicit H-1B sponsors) while keeping Zuora and Zipline, purely because Z sorts after G.

This re-ranks on the signals that actually differentiate a target for an AI/ML engineer who
needs sponsorship. It reads the importer's output and writes a new batch file; it does not
modify the importer or refetch anything.

    python3 scripts/rank_source_leads.py data/source-leads/dharmvir-x-2026-08-18 [--top 60]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

# Explicit sponsorship beats a vague "Medium" every time — it is the hardest constraint in
# this search, so it carries the most weight.
VISA_WEIGHT = {"h-1b, green card": 4, "h-1b": 4, "high": 3, "medium": 1}

# Terms that mean the company actually does AI/ML work, not merely that a recruiter listed
# "AI" as a buzzword. Weighted so core-model work outranks generic "tech".
CORE_AI = ("machine learning", "ml ", "mlops", "deep learning", "llm", "genai", "generative ai",
           "nlp", "computer vision", "inference", "model", "ai research", "applied ai", "ai/ml")
ADJACENT = ("ai", "data", "developer tools", "devtools", "infrastructure", "platform",
            "analytics", "search", "recommendation", "robotics", "autonomous")

# The candidate's own stack — a company matching several of these is a materially better fit
# than one matching none, per the resume in career-ops.
STACK = ("python", "pytorch", "tensorflow", "spark", "kubernetes", "aws", "docker",
         "airflow", "kafka", "rag", "vector", "snowflake", "databricks")


def norm(s: object) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def count_terms(hay: str, terms) -> int:
    return sum(1 for t in terms if t in hay)


def rank_row(r: dict) -> tuple[int, dict]:
    """Return (score, breakdown). Every component is explainable — no opaque weighting."""
    visa = VISA_WEIGHT.get(norm(r.get("visa_signal")), 0)

    text = " ".join(norm(r.get(k)) for k in ("sector", "roles_or_stack", "source_tab", "company"))
    core = min(count_terms(text, CORE_AI), 4)
    adj = min(count_terms(text, ADJACENT), 3)
    stack = min(count_terms(text, STACK), 3)

    # A careers URL is what makes a lead actionable at all; a LinkedIn URL is what makes the
    # outreach half possible. Both are cheap but decisive for whether this row can be worked.
    actionable = (2 if norm(r.get("careers_url")) else 0) + (1 if norm(r.get("linkedin_url")) else 0)

    # Appearing on more than one of the ten source sheets is weak independent corroboration.
    try:
        occ = min(int(r.get("source_occurrences") or 1) - 1, 2)
    except (TypeError, ValueError):
        occ = 0

    total = visa * 5 + core * 4 + adj * 2 + stack * 2 + actionable * 2 + occ
    return total, {"visa": visa, "core_ai": core, "adjacent": adj, "stack": stack,
                   "actionable": actionable, "multi_source": occ}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--bucket", default="priority_a_add_candidate")
    args = ap.parse_args()

    src = args.run_dir / "deduped_leads.csv"
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 1

    with src.open(newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r.get("bucket") == args.bucket]
    if not rows:
        print(f"error: no rows in bucket {args.bucket}", file=sys.stderr)
        return 1

    ranked = []
    for r in rows:
        total, parts = rank_row(r)
        out = dict(r)
        out["rank_score"] = total
        out["rank_breakdown"] = json.dumps(parts, separators=(",", ":"))
        ranked.append(out)

    # Descending by score; company name only as a deterministic tiebreak so reruns are stable.
    ranked.sort(key=lambda r: (-r["rank_score"], norm(r["company"])))
    for i, r in enumerate(ranked, 1):
        r["rank"] = i

    fields = ["rank", "rank_score", "company", "visa_signal", "sector", "location",
              "careers_url", "linkedin_url", "source_label", "rank_breakdown"]
    out_path = args.run_dir / f"ranked_batch_top{args.top}.csv"
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(ranked[: args.top])

    full_path = args.run_dir / "ranked_all.csv"
    with full_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(ranked)

    scores = [r["rank_score"] for r in ranked]
    print(json.dumps({
        "bucket": args.bucket,
        "ranked": len(ranked),
        "written_top": min(args.top, len(ranked)),
        "score_min": min(scores), "score_max": max(scores),
        "distinct_scores": len(set(scores)),
        "top_batch": str(out_path), "all_ranked": str(full_path),
    }, indent=2))
    print("\ntop 15:")
    for r in ranked[:15]:
        print(f'  {r["rank"]:>2}. {r["rank_score"]:>3}  {r["company"][:34]:<34} {r["visa_signal"][:16]:<16} {r["sector"][:30]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
