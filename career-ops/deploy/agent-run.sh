#!/usr/bin/env bash
# career-ops — unattended scan + evaluate workflow (invoked by the systemd timer
# or the Telegram /scan command). Headless Claude Code run.
set -euo pipefail

REPO="${CAREER_OPS_DIR:-$HOME/career-ops}"
cd "$REPO"
set -a; [ -f deploy/.env ] && . deploy/.env; set +a
mkdir -p deploy/logs
LOG="deploy/logs/scan-$(date +%F).log"

read -r -d '' PROMPT <<'EOP' || true
Run the career-ops scheduled scan, following AGENTS.md exactly.
Steps: run `node scan.mjs`; for any GENUINELY net-new, in-scope postings (USA; entry/mid AI/ML, Applied AI, GenAI/LLM, NLP or MLOps Engineer; >= comp floor; fresh per modes/_profile.md), evaluate A-G, write the report + a TSV in batch/tracker-additions/, then run `node merge-tracker.mjs` and `node verify-pipeline.mjs`.
Seniority gate: hard-reject Senior/Sr/Staff/Lead/Principal/III/IV/Manager/Director/Head/VP titles. A posting with NO stated years requirement is UNKNOWN, not level-appropriate — confirm at the employer's own listing or hold the score down; job-board reposts strip the years bar.
Eligibility gate: hard-skip US-citizenship-only, active-clearance and ITAR/export-control roles (<VISA_STATUS> does not satisfy US Person). Do NOT penalize a role merely for lacking <VISA_SPONSORSHIP> — that override is active.
Generate a PDF only when Global Score >= 4.0. NEVER submit any application. Every factual claim about the candidate comes from cv-aiml.md, article-digest.md, config/profile.yml or modes/_profile.md — reorder and reframe, never invent a skill, employer, metric or authorship. Do not fabricate scores or contacts. If nothing net-new is accessible, say so honestly. End with a one-paragraph summary of what changed.
EOP

{
  echo "=== $(date -Is) scan start ==="
  # --dangerously-skip-permissions is REQUIRED for unattended runs (no human to approve tool calls).
  # It only executes the prompt above against this repo. Review deploy/logs/ regularly.
  claude -p "$PROMPT" --dangerously-skip-permissions
  echo "=== $(date -Is) scan done ==="
} 2>&1 | tee -a "$LOG"
