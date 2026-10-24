#!/usr/bin/env bash
# warm-outbound run.sh — PHASE 1 (claude -p, read-only) then PHASE 2 (send.mjs, deterministic).
#
# PHASE 1 finds candidates via the Unipile linkedin MCP using the superagnt playbook (read tools only, see prompt.md); PHASE 2 decides who
# actually gets invited and, unless WARM_OUTBOUND_DRY_RUN=0, never sends anything for real.
set -uo pipefail
# ponytail: no `set -e` -- every step below checks its own exit code explicitly so the right
# message reaches stderr/Slack instead of a bare "run.sh: line N: ..." trace.

JOB_DIR="/home/<YOU>/automations/jobs/warm-outbound"
CAREER_OPS_ROOT="/home/<YOU>/career-ops"

# Refuse before touching anything else: any ANTHROPIC_* var set would make `claude -p` bill an
# API key instead of <YOUR_NAME>'s Max subscription (same refusal reasoning as assist/runner.mjs's
# callClaude()). Checked here too, not only inside `claude` itself, so a misconfigured
# environment fails loudly at the top of this script rather than mid-run.
anthropic_vars=$(env | grep '^ANTHROPIC_' | cut -d= -f1)
if [ -n "$anthropic_vars" ]; then
  echo "refused: ANTHROPIC_* env var(s) set ($anthropic_vars) -- would bill an API key instead of the Max subscription" >&2
  exit 2
fi

cd "$CAREER_OPS_ROOT" || exit 1
# keep a per-day stderr log so a failed run is diagnosable (journal showed only "sent" on 2026-09-29)
mkdir -p "${JOB_DIR}/logs"
exec 2> >(tee -a "${JOB_DIR}/logs/$(TZ=<YOUR_TZ> date +%F).err" >&2)

today=$(TZ=<YOUR_TZ> date +%F)
target_count=${WARM_OUTBOUND_DAILY_CAP:-8}
max_data_calls=${WARM_OUTBOUND_MAX_DATA_CALLS:-40}

# Discovery runs on <YOUR_NAME>'s own Unipile-backed linkedin MCP (LinkedIn Premium), NOT superagnt's
# paid data -- superagnt contributes only its playbook files (read via Read). Read-only tools only.
allowed_tools="Read,Grep,Glob,ToolSearch,\
mcp__linkedin__search,mcp__linkedin__search_parameters,mcp__linkedin__get_job,mcp__linkedin__get_post,\
mcp__linkedin__list_post_comments,mcp__linkedin__list_user_posts,\
mcp__linkedin__get_profile,mcp__linkedin__check_contacted"

disallowed_tools="mcp__plugin_superagnt_superagnt,Bash,Edit,Write,NotebookEdit,Agent,Task,Workflow,Skill,SendMessage,CronCreate,RemoteTrigger,\
mcp__linkedin__send_invitation,mcp__linkedin__send_message,mcp__linkedin__start_chat,\
mcp__linkedin__comment_on_post,mcp__linkedin__react_to_post,mcp__linkedin__create_post,mcp__linkedin__sync_applications,\
mcp__memory__save_memory,mcp__memory__delete_memory"

user_message="Today's date: ${today} (<YOUR_TZ>).
TARGET_COUNT=${target_count}
MAX_DATA_CALLS=${max_data_calls}
Find warm LinkedIn outbound candidates per the appended system prompt. Respect the MAX_DATA_CALLS
budget and count your own linkedin calls. Output ONLY the fenced \`\`\`json block described at
the end of the system prompt -- nothing else."

tmp_cli_out=$(mktemp) || exit 1
tmp_phase1=$(mktemp) || exit 1
cleanup() { rm -f "$tmp_cli_out" "$tmp_phase1"; }
trap cleanup EXIT

printf '%s' "$user_message" | env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN timeout 1500 \
  "${HOME}/.local/bin/claude" -p --model sonnet --output-format json --max-turns 60 \
  --no-session-persistence --permission-mode dontAsk --permission-prompts none \
  --setting-sources user,project \
  --append-system-prompt-file "${JOB_DIR}/prompt.md" \
  --allowedTools "$allowed_tools" \
  --disallowedTools "$disallowed_tools" \
  > "$tmp_cli_out"
claude_exit=$?
if [ "$claude_exit" -ne 0 ]; then
  echo "phase 1: claude exited ${claude_exit}" >&2
  exit 1
fi

if ! node "${JOB_DIR}/extract-phase1.mjs" "$tmp_cli_out" "$tmp_phase1"; then
  echo "phase 1: failed to extract a valid candidates JSON from claude's output" >&2
  exit 1
fi

mkdir -p "${CAREER_OPS_ROOT}/data/warm-outbound"
cp "$tmp_phase1" "${CAREER_OPS_ROOT}/data/warm-outbound/${today}-phase1.json"

node "${JOB_DIR}/send.mjs" "$tmp_phase1"
exit $?
