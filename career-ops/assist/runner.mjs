// runner.mjs — OpenRouter free-model calls for the assist service. Spec §7.
//
// This does NOT import the root openrouter-runner.mjs. That file is a CLI: it exports only
// buildCachedSystemMessage and parsePortals, not its call path, and root *.mjs is system-layer
// per DATA_CONTRACT.md so update-system.mjs can replace it at any time. Reimplementing the
// small part we need keeps the same behaviour (dynamic free-model discovery, fallback across
// models, 2500 ms pacing) without depending on a file that is not ours.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RATE_LIMIT_DELAY_MS = 2500;   // free tier pacing, same as the root runner
// A free model that never answers used to block a draft indefinitely: nemotron-ultra and
// -lightning both hung past 45s on 2026-09-11 while nano-omni answered in 24s. Bound every
// call, and never walk more than a few models per generate() — with discovery on, the list
// is 21 long and the draft pipeline retries it three times.
const CALL_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------------------------------
// Codex provider: <YOUR_NAME>'s ChatGPT/Codex subscription via the same backend the Codex CLI
// uses. Model ids are prefixed "codex:" in models.json (e.g. codex:gpt-5.6-sol). Auth is
// the CLI's own ~/.codex/auth.json (access/refresh tokens + account id); on 401 or a
// near-expiry JWT the refresh token is exchanged at auth.openai.com and written back, so
// `codex login` once is enough. Measured 2026-09-11: 2.8s for a short reply vs 24-45s on
// the OpenRouter free tier. Nothing here is stored server-side (store:false).
// ---------------------------------------------------------------------------------------
const CODEX_PREFIX = 'codex:';
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_PATH = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'auth.json');

function readCodexAuth() {
  const data = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8'));
  const t = data.tokens || {};
  if (!t.access_token || !t.refresh_token) throw new Error('codex auth.json has no tokens — run `codex login`');
  return { data, tokens: t };
}
function jwtExpiresSoon(token, skewMs = 120_000) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp * 1000 - Date.now() < skewMs;
  } catch { return false; }
}
async function refreshCodexTokens() {
  const { data, tokens } = readCodexAuth();
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`codex token refresh failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  data.tokens = { ...tokens, access_token: j.access_token || tokens.access_token, refresh_token: j.refresh_token || tokens.refresh_token, id_token: j.id_token || tokens.id_token };
  data.last_refresh = new Date().toISOString();
  const tmp = CODEX_AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CODEX_AUTH_PATH);
  return data.tokens;
}
/** Chat-style messages → Responses API: system text becomes `instructions`, the rest `input`. */
function toResponsesInput(messages) {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const input = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: String(m.content ?? '') }],
  }));
  return { instructions, input };
}
async function callCodex({ model, messages, signal, onDelta, _retried = false }) {
  let { tokens } = readCodexAuth();
  if (jwtExpiresSoon(tokens.access_token)) tokens = await refreshCodexTokens();
  const { instructions, input } = toResponsesInput(messages);
  const res = await fetch(CODEX_URL, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer\u0020${tokens.access_token}`,
      'chatgpt-account-id': tokens.account_id,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ model: model.slice(CODEX_PREFIX.length), instructions, input, store: false, stream: true, reasoning: { effort: 'low' } }),
  });
  if (res.status === 401 && !_retried) {
    await refreshCodexTokens();
    return callCodex({ model, messages, signal, onDelta, _retried: true });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  // SSE: concatenate response.output_text.delta events until response.completed.
  const decoder = new TextDecoder();
  let buf = '', out = '', done = false, failure = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') { out += ev.delta; if (onDelta) onDelta(ev.delta); }
      else if (ev.type === 'response.completed' || ev.type === 'response.done') done = true;
      else if (ev.type === 'response.failed' || ev.type === 'error') failure = ev.error?.message || ev.response?.error?.message || ev.message || 'codex response failed';
    }
    if (done || failure) break;
  }
  if (failure) throw new Error(`${model}: ${failure}`);
  return out;
}
// ---------------------------------------------------------------------------------------
// Claude provider: <YOUR_NAME>'s Claude Max subscription via `claude -p`, run agentically with
// every configured tool and MCP server loaded (~/.claude.json user scope + the account's
// claude.ai connectors) but restricted at the CLI's own permission layer to READ-type tools —
// it can look things up, but cannot send, post, invite, write or run anything. Model ids are
// prefixed "claude:" in models.json (e.g. claude:sonnet -> `claude -p --model sonnet`).
// Set 2026-09-25: ChatGPT/Codex is being cancelled, so this becomes PRIMARY, ahead of codex:.
// The codex provider above is untouched and still works if models.json ever points at it again.
// ---------------------------------------------------------------------------------------
const CLAUDE_PREFIX = 'claude:';
// systemd's unit PATH lacks ~/.local/bin, so this never relies on a PATH lookup.
function claudeBin() { return process.env.CLAUDE_BIN || path.join(process.env.HOME || '', '.local', 'bin', 'claude'); }
// A function, not a frozen top-level const: read fresh per call so a test (or an operator) can
// override it without the module having already cached the default at import time.
function claudeRouteTimeoutMs() { return Number(process.env.CLAUDE_ROUTE_TIMEOUT_MS) || 150_000; }
// Grace period between SIGTERM and SIGKILL when killing the child (2026-09-25 review finding).
// Same "read fresh, not a frozen const" reasoning as claudeRouteTimeoutMs() — a test overrides it.
function claudeRouteKillGraceMs() { return Number(process.env.CLAUDE_ROUTE_KILL_GRACE_MS) || 5_000; }
const CAREER_OPS_ROOT = process.env.CAREER_OPS_ROOT || path.resolve(import.meta.dirname, '..');
// The Max subscription is billed by `claude -p`'s own logged-in session (~/.claude.json auth).
// Any of these set non-empty would make the CLI bill an API key/Bedrock/Vertex instead —
// refuse outright (never silently switch how this call is paid for).
const ANTHROPIC_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

// Read-type tools only — everything here can look something up, nothing here can change
// anything. mcp__claude_ai_Job_hunt_rag__* is the account's claude.ai connector over this repo.
// WebSearch/WebFetch deliberately excluded (2026-09-25 review finding): both are read-classified
// by the CLI, but a prompt-injected LinkedIn thread (AGENTS.md's own "Untrusted External Content"
// section already flags this as a live threat) can still steer either one into fetching an
// attacker-controlled URL with sensitive text folded into the query string — a real exfiltration
// channel dressed up as a permitted read. The drafting flow already grounds itself via
// sourcesBlock()/jdBlock() in draft.mjs, so neither tool is needed here.
export const CLAUDE_READ_ALLOWLIST = [
  'Read', 'Grep', 'Glob', 'ToolSearch',
  'mcp__linkedin__get_me', 'mcp__linkedin__get_profile', 'mcp__linkedin__get_post', 'mcp__linkedin__get_job',
  'mcp__linkedin__list_chats', 'mcp__linkedin__list_chat_messages', 'mcp__linkedin__list_recent_messages',
  'mcp__linkedin__list_user_posts', 'mcp__linkedin__list_post_comments', 'mcp__linkedin__list_connections',
  'mcp__linkedin__search', 'mcp__linkedin__search_parameters', 'mcp__linkedin__check_contacted', 'mcp__linkedin__get_invite_budget',
  'mcp__memory__search_memory', 'mcp__memory__get_memory', 'mcp__memory__list_memories', 'mcp__memory__get_index',
  'mcp__claude_ai_Job_hunt_rag__search_career_ops', 'mcp__claude_ai_Job_hunt_rag__get_application', 'mcp__claude_ai_Job_hunt_rag__get_person',
  'mcp__claude_ai_Job_hunt_rag__get_thread', 'mcp__claude_ai_Job_hunt_rag__company_context', 'mcp__claude_ai_Job_hunt_rag__screen_jd',
  'mcp__claude_ai_Job_hunt_rag__check_draft', 'mcp__claude_ai_Job_hunt_rag__fetch_url', 'mcp__claude_ai_Job_hunt_rag__web_search',
  'mcp__claude_ai_Job_hunt_rag__index_status', 'mcp__claude_ai_Job_hunt_rag__get_document', 'mcp__claude_ai_Job_hunt_rag__get_linkedin_post',
  'mcp__claude_ai_Job_hunt_rag__search_people', 'mcp__claude_ai_Job_hunt_rag__get_invite_budget', 'mcp__claude_ai_Job_hunt_rag__evaluate_job',
];

// Warm context (flag file deploy/warm-context.on) — OFF by default.
// Warm context now uses <YOUR_NAME>'s own Unipile-backed linkedin MCP (get_profile + list_user_posts are
// already on CLAUDE_READ_ALLOWLIST), not superagnt's paid LinkedIn data -- so the flag adds no tools,
// only the prompt block below. Kept as an (empty) export so the flag's shape stays explicit and tested.
export const WARM_CONTEXT_TOOLS = [];
// WARM_CONTEXT_FLAG overridable for tests — never points at the real flag file in a test run.
function warmContextFlagPath() { return process.env.WARM_CONTEXT_FLAG || path.join(CAREER_OPS_ROOT, 'deploy', 'warm-context.on'); }
/** Read fresh per call (a function, not a cached const — same reasoning as claudeRouteTimeoutMs()
 * above) so the flag toggles the next claude-route call with no assist-server restart needed. */
export function warmContextEnabled() {
  try { return fs.existsSync(warmContextFlagPath()); } catch { return false; }
}
// Appended to the system prompt only when warmContextEnabled() — kept short and paraphrase-only
// per the house rule: never quote a post, never reveal that a tool was used.
const WARM_CONTEXT_SYSTEM_BLOCK = '\noptional warm context: you MAY make at most 3 linkedin calls total -- mcp__linkedin__get_profile (from the payload\'s public id / profile URL) to get their provider id, then mcp__linkedin__list_user_posts for their 1-2 most recent posts; reference one specific recent post only if genuinely relevant, in one short clause, paraphrased (never quote more than ~8 words); never say or imply you looked them up or used a tool; if a call fails or returns nothing, write the message without it.';

// Belt and braces on top of --permission-mode dontAsk (which already denies anything NOT on the
// allowlist above): name the obvious write/send tools explicitly, so a future edit to the
// allowlist alone can never silently re-open one of these by omission.
export const CLAUDE_WRITE_DENYLIST = [
  'Bash', 'Edit', 'Write', 'NotebookEdit',
  // Subagents do NOT inherit --disallowedTools: a live test (2026-09-25) had Agent spawn a child
  // that ran Bash. Deny every tool that starts another agent or loop.
  'Agent', 'Task', 'Workflow', 'Skill', 'SendMessage', 'CronCreate', 'RemoteTrigger',
  'mcp__linkedin__send_message', 'mcp__linkedin__send_invitation', 'mcp__linkedin__start_chat',
  'mcp__linkedin__comment_on_post', 'mcp__linkedin__react_to_post', 'mcp__linkedin__create_post', 'mcp__linkedin__sync_applications',
  'mcp__memory__save_memory', 'mcp__memory__delete_memory',
  // Gmail
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__update_draft', 'mcp__claude_ai_Gmail__delete_draft',
  'mcp__claude_ai_Gmail__create_label', 'mcp__claude_ai_Gmail__update_label', 'mcp__claude_ai_Gmail__delete_label',
  'mcp__claude_ai_Gmail__label_message', 'mcp__claude_ai_Gmail__unlabel_message', 'mcp__claude_ai_Gmail__label_thread', 'mcp__claude_ai_Gmail__unlabel_thread',
  'mcp__claude_ai_Gmail__update_message_labels', 'mcp__claude_ai_Gmail__apply_sensitive_message_label', 'mcp__claude_ai_Gmail__apply_sensitive_thread_label',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__untrash_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__untrash_thread',
  'mcp__claude_ai_Gmail__mark_message_spam', 'mcp__claude_ai_Gmail__unmark_message_spam', 'mcp__claude_ai_Gmail__mark_thread_spam', 'mcp__claude_ai_Gmail__unmark_thread_spam',
  // Slack
  'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_schedule_message',
  'mcp__claude_ai_Slack__slack_create_conversation', 'mcp__claude_ai_Slack__slack_create_canvas', 'mcp__claude_ai_Slack__slack_update_canvas', 'mcp__claude_ai_Slack__slack_add_reaction',
  // Google Calendar
  'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event', 'mcp__claude_ai_Google_Calendar__delete_event', 'mcp__claude_ai_Google_Calendar__respond_to_event',
  // Google Drive
  'mcp__claude_ai_Google_Drive__create_file', 'mcp__claude_ai_Google_Drive__update_file', 'mcp__claude_ai_Google_Drive__copy_file',
  'mcp__claude_ai_Google_Drive__trash_file', 'mcp__claude_ai_Google_Drive__share_file',
];

/**
 * `claude -p`, agentic and read-only, run from inside this repo so its CLAUDE.md/AGENTS.md
 * context and files are available to Read. Nothing here unloads tools/MCP/settings (no
 * --strict-mcp-config, no --tools '', no --setting-sources '') — the whole point is "everything
 * loaded, only reads executable".
 *
 * Two different things can end this call, and they mean different things to the caller:
 *   - CLAUDE_ROUTE_TIMEOUT_MS (this route's OWN budget, 150s default) firing is an ordinary
 *     failure of THIS model: the child is killed and a plain Error is thrown, so generate()
 *     falls through to omniroute/nemotron with whatever is left of the caller's own deadline.
 *   - the caller's own `signal` aborting means there is no time left for ANY model: the child
 *     is killed and an AbortError is thrown, matching how callModel/callCodex already propagate
 *     an outer deadline (generate() stops trying further models on AbortError).
 * Either way the child is killed by its own handle (`child.kill()`), never by name or pattern —
 * SIGTERM first, then SIGKILL after CLAUDE_ROUTE_KILL_GRACE_MS (5s default) if an agentic run
 * mid network call or mid MCP-client teardown does not honor SIGTERM promptly, so the real worst
 * case stays bounded at routeTimeoutMs + killGraceMs instead of however long the child takes.
 */
async function callClaude({ model, messages, signal, onDelta }) {
  for (const k of ANTHROPIC_ENV_VARS) {
    if (process.env[k]) throw new Error(`claude route refused: ${k} is set — would bill an API key instead of the Max subscription`);
  }
  const modelName = model.slice(CLAUDE_PREFIX.length);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-claude-'));
  try {
    const warmOn = warmContextEnabled();
    const allowedTools = warmOn ? [...CLAUDE_READ_ALLOWLIST, ...WARM_CONTEXT_TOOLS] : CLAUDE_READ_ALLOWLIST;

    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const sysPath = path.join(tmpDir, 'system-prompt.txt');
    fs.writeFileSync(sysPath, `${systemText}\nYou may use read-only tools to gather facts; you cannot send, post, invite, write or run commands; return only the final answer in the format requested.${warmOn ? WARM_CONTEXT_SYSTEM_BLOCK : ''}`);

    // Non-system messages only, via stdin — never argv (argv ends up in `ps`, logs, etc.).
    // A single turn goes through unlabeled; a retried pipeline (draft.mjs pushes assistant+user
    // turns back in) is labeled so the model can tell its own prior turn from the new ask.
    const turns = messages.filter((m) => m.role !== 'system');
    const stdin = turns.length > 1
      ? turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n')
      : String(turns[0]?.content ?? '');

    const childEnv = { ...process.env };
    for (const k of ANTHROPIC_ENV_VARS) delete childEnv[k];

    const child = spawn(claudeBin(), [
      '-p',
      '--model', modelName,
      '--output-format', 'json',
      '--max-turns', '12',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--allowedTools', allowedTools.join(','),
      '--disallowedTools', CLAUDE_WRITE_DENYLIST.join(','),
      // user + project only, never "local" (2026-09-25 review finding): this repo's own
      // .claude/settings.local.json carries interactive-use allow rules (Write(*), Edit(*),
      // Bash(node:*)) that would otherwise load for every call made from this cwd and race the
      // denylist above. Excluding "local" is structural rather than a bet on permission-resolution
      // order: that file simply never loads for this call. CLAUDE.md/AGENTS.md still load (a
      // separate mechanism, not a setting source) and MCP servers still come from the user scope
      // in ~/.claude.json, so "everything loaded, only reads executable" still holds.
      '--setting-sources', 'user,project',
      '--append-system-prompt-file', sysPath,
    ], { cwd: CAREER_OPS_ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '', timedOut = false;
    const routeTimeoutMs = claudeRouteTimeoutMs();
    let killTimer = null;
    const killChild = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), claudeRouteKillGraceMs());
      killTimer.unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; killChild(); }, routeTimeoutMs);
    timer.unref?.();
    const onAbort = () => killChild();
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    // A child that exits before reading all of stdin (a bad binary, a crash) turns the write
    // into an EPIPE — that is reported through `code`/`err` below already, so it must not also
    // surface as an unhandled stream error.
    child.stdin.on('error', () => {});
    try { child.stdin.end(stdin); } catch { /* the child may already be on its way out */ }

    const { code } = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code }));
    });
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);

    if (signal?.aborted) { const e = new Error('deadline reached'); e.name = 'AbortError'; throw e; }
    if (timedOut) throw new Error(`claude ${modelName}: timed out after ${routeTimeoutMs}ms`);
    if (code !== 0) throw new Error(`claude ${modelName}: exited ${code}${err ? ' — ' + err.slice(0, 160) : ''}`);
    let parsed;
    try { parsed = JSON.parse(out); } catch { throw new Error(`claude ${modelName}: non-JSON CLI output`); }
    if (parsed.is_error || typeof parsed.result !== 'string' || !parsed.result) {
      throw new Error(`claude ${modelName}: ${parsed.subtype || (parsed.is_error ? 'is_error' : 'no result')}`);
    }
    if (onDelta) onDelta(parsed.result);
    return parsed.result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// OmniRoute provider: Hermes' own OpenAI-compatible local gateway. Second choice, behind
// claude:. Model ids are prefixed "omniroute:" in models.json (e.g. omniroute:hermes-fallback).
// Verified: the "hermes-fallback" combo supports both plain text and OpenAI tool_calls, 0.4-4.4s.
// ---------------------------------------------------------------------------------------
const OMNIROUTE_PREFIX = 'omniroute:';
function omniRouteUrl() { return process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128/v1/chat/completions'; }
function omniRouteApiKey() {
  if (process.env.OMNIROUTE_API_KEY) return process.env.OMNIROUTE_API_KEY.trim();
  try {
    // Same truncation trap as candidateKeys() below: the character class must include '.' and
    // '-', and the key is never logged.
    const m = /OMNIROUTE_API_KEY=["']?([A-Za-z0-9_.-]+)/.exec(fs.readFileSync(path.join(process.env.HOME || '', '.hermes/.env'), 'utf8'));
    if (m) return m[1];
  } catch { /* no .env */ }
  return null;
}
/** Shared HTTP call for both the text and tool-calling paths; the caller shapes the result. */
async function omniRouteRequest({ model, messages, maxTokens, temperature, signal, tools }) {
  const key = omniRouteApiKey();
  if (!key) throw new Error('no OMNIROUTE_API_KEY — set it or add it to ~/.hermes/.env');
  const res = await fetch(omniRouteUrl(), {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { Authorization: `Bearer\u0020${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.slice(OMNIROUTE_PREFIX.length), messages, max_tokens: maxTokens, temperature, stream: false,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const d = await res.json();
  if (d.error) throw new Error(`${model}: ${String(d.error.message || d.error).slice(0, 200)}`);
  const msg = d.choices?.[0]?.message;
  if (!msg) throw new Error(`${model}: no message in response`);
  return { message: msg, finish: d.choices?.[0]?.finish_reason ?? null, usage: d.usage ?? null };
}

// OpenRouter's free-tier pacing (RATE_LIMIT_DELAY_MS) exists to avoid hammering a shared rate
// limit; it does not apply to our own routes (claude:/omniroute:/codex: are not OpenRouter
// calls), so skipping it there saves real wall-clock time on a drafting deadline for nothing
// lost in return.
const isPacedModel = (model) => !model.startsWith(CLAUDE_PREFIX) && !model.startsWith(OMNIROUTE_PREFIX) && !model.startsWith(CODEX_PREFIX);

const MAX_MODELS_PER_GENERATE = 5;
const MODEL_TTL_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The key lives on <HOME_SERVER> only and never reaches the extension (spec §6.3).
 * Read from the environment, then fall back to the dotfiles the rest of this box uses, so the
 * systemd unit does not need the secret inlined into it.
 */
function candidateKeys() {
  const out = [];
  if (process.env.OPENROUTER_API_KEY) out.push(process.env.OPENROUTER_API_KEY.trim());
  for (const f of [path.join(process.env.HOME || '', '.hermes/.env'), path.join(process.env.HOME || '', '.bashrc')]) {
    try {
      // The character class MUST include '.' — an OpenRouter key can contain one, and a class
      // that omits it silently truncates the key into something that 401s.
      const m = /OPENROUTER_API_KEY=["']?([A-Za-z0-9_.-]+)/.exec(fs.readFileSync(f, 'utf8'));
      if (m && !out.includes(m[1])) out.push(m[1]);
    } catch { /* next */ }
  }
  return out;
}

let validKey = null;

/**
 * Return a key that OpenRouter actually accepts.
 *
 * Trying the first key found is not good enough here: measured 2026-08-23, ~/.bashrc on this
 * box exports a DEAD key which, because .bashrc is sourced for interactive shells, shadows the
 * working key in ~/.hermes/.env for every inherited environment. Every model call then fails
 * with 401 "User not found" and looks like a rate limit or an outage. So validate once, cache
 * the winner, and say so plainly when none work.
 */
export async function apiKey() {
  if (validKey) return validKey;
  const keys = candidateKeys();
  if (!keys.length) return null;
  for (const k of keys) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer\u0020' + k } });
      if (r.ok) { validKey = k; return k; }
    } catch { /* try the next */ }
  }
  return null;
}

let cache = { at: 0, models: [] };

/**
 * The operator's explicit model order (assist/models.json), tried before anything discovered.
 * Judge a model by what it RETURNS, never by its name: the -reasoning nano model emits clean
 * JSON while nemotron-3.5-lightning does not, so a name-pattern filter gets both wrong.
 */
export function preferredModels() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'models.json'), 'utf8'));
    return { list: Array.isArray(cfg.preferred) ? cfg.preferred : [], fallback: cfg.fallbackToDiscovered !== false };
  } catch { return { list: [], fallback: true }; }
}

/** Preferred order first, then discovered free models, de-duplicated. */
export async function modelOrder({ exclude = [] } = {}) {
  const { list, fallback } = preferredModels();
  const out = list.filter((m) => !exclude.includes(m));
  if (fallback) {
    try {
      for (const m of await freeModels()) {
        if (!out.includes(m.id) && !exclude.includes(m.id)) out.push(m.id);
      }
    } catch { /* discovery is best-effort; the preferred list still stands */ }
  }
  return out;
}

/**
 * Free models that support tool calling and have real context. Discovered live because
 * free-tier availability rotates — a hardcoded list goes stale and starts failing silently.
 */
export async function freeModels({ force = false } = {}) {
  if (!force && cache.models.length && Date.now() - cache.at < MODEL_TTL_MS) return cache.models;
  const key = await apiKey();
  const res = await fetch(MODELS_URL, { headers: key ? { Authorization: `Bearer\u0020${key}` } : {} });
  if (!res.ok) throw new Error(`OpenRouter model list failed: HTTP ${res.status}`);
  const data = (await res.json()).data || [];
  const list = data
    .filter((m) => String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0')
    // Zero-priced does NOT mean "a free chat model". Measured: google/lyria-3-*-preview are
    // MUSIC models and stealth/* require special access — both price at 0 and both fail every
    // chat call. Require text out, and prefer the explicit ':free' tier marker.
    .filter((m) => {
      const outs = m.architecture?.output_modalities || m.architecture?.modality || [];
      const textOut = Array.isArray(outs) ? outs.includes('text') : String(outs).includes('text');
      return textOut && !/^stealth\//.test(m.id) && !/lyria|whisper|tts|embed|rerank/i.test(m.id);
    })
    // Prefer bigger context: a thread carrying a JD plus the CV is not small, and silently
    // truncating produces a worse answer than saying the thread is too long (spec §5).
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .map((m) => ({ id: m.id, context: m.context_length || 0 }));
  if (!list.length) throw new Error('no free models available from OpenRouter right now');
  cache = { at: Date.now(), models: list };
  return list;
}

/**
 * Call one model. Returns the raw assistant text.
 * `onDelta` receives token chunks when streaming — free models are slow, so the panel shows
 * progress rather than a spinner (spec §7).
 */
async function callModel({ model, messages, maxTokens = 1200, temperature = 0.4, signal, onDelta }) {
  if (model.startsWith(CODEX_PREFIX)) return callCodex({ model, messages, signal, onDelta });
  if (model.startsWith(CLAUDE_PREFIX)) return callClaude({ model, messages, signal, onDelta });
  if (model.startsWith(OMNIROUTE_PREFIX)) {
    const { message } = await omniRouteRequest({ model, messages, maxTokens, temperature, signal });
    const text = message.content ?? '';
    if (onDelta) onDelta(text);
    return text;
  }
  const key = await apiKey();
  if (!key) throw new Error('no working OPENROUTER_API_KEY — every candidate key was rejected by OpenRouter');
  const stream = typeof onDelta === 'function';
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer\u0020${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'career-ops-assist',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (!stream) {
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? '';
  }
  let full = '';
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* keep-alive or partial frame */ }
    }
  }
  return full;
}

/**
 * Try free models in order until one answers.
 *
 * Spec §8: when all free models are rate-limited, say so — never silently switch to a paid
 * model. This only ever calls models discovered as free.
 */
export async function generate({ messages, maxTokens, temperature, signal, onDelta, models }) {
  const list = (models || (await freeModels()).map((m) => m.id)).slice(0, MAX_MODELS_PER_GENERATE);
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) { const e = new Error('deadline reached'); e.name = 'AbortError'; e.attempts = errors; throw e; }
    const model = list[i];
    try {
      const text = await callModel({ model, messages, maxTokens, temperature, signal, onDelta });
      if (text && text.trim()) return { text, model, attempts: i + 1, errors };
      errors.push({ model, error: 'empty response' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push({ model, error: String(e.message || e).slice(0, 160) });
    }
    // Pace between attempts; hammering the free tier is what gets the key limited. Not for
    // claude:/omniroute:/codex: — see isPacedModel().
    if (i < list.length - 1 && isPacedModel(model)) await sleep(RATE_LIMIT_DELAY_MS);
  }
  const err = new Error('all free models failed or are rate-limited');
  err.attempts = errors;
  throw err;
}

export const RATE_LIMIT_MS = RATE_LIMIT_DELAY_MS;

/**
 * One tool-calling turn. Returns the raw assistant message so the caller can branch on
 * `tool_calls` vs `content` and drive its own loop.
 *
 * Non-streaming on purpose: assembling tool_call deltas across SSE frames is fiddly and buys
 * nothing here — the agent loop streams its own step events, which is what the panel shows.
 */
async function callModelTools({ model, messages, tools, maxTokens = 1400, temperature = 0.3, signal }) {
  // claude: runs its own tool loop inside `claude -p` and returns a finished answer, never
  // OpenAI-shaped tool_calls; codex: has no tools wiring here at all. Fail fast — no network,
  // no rate-limit pacing (isPacedModel() also covers this) — so generateWithTools() moves
  // straight to the next model in the list instead of waiting on a call that can't work.
  if (model.startsWith(CLAUDE_PREFIX) || model.startsWith(CODEX_PREFIX)) {
    throw new Error(`${model}: tool-calling is not supported by this route`);
  }
  if (model.startsWith(OMNIROUTE_PREFIX)) return omniRouteRequest({ model, messages, maxTokens, temperature, signal, tools });
  const key = await apiKey();
  if (!key) throw new Error('no working OPENROUTER_API_KEY — every candidate key was rejected by OpenRouter');
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer\u0020${key}`, 'Content-Type': 'application/json', 'X-Title': 'career-ops-assist' },
    body: JSON.stringify({
      model, messages, max_tokens: maxTokens, temperature,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const d = await res.json();
  if (d.error) throw new Error(`${model}: ${String(d.error.message || d.error).slice(0, 200)}`);
  const msg = d.choices?.[0]?.message;
  if (!msg) throw new Error(`${model}: no message in response`);
  return { message: msg, finish: d.choices?.[0]?.finish_reason ?? null, usage: d.usage ?? null };
}

/** Tool-calling counterpart to generate(): tries models in preference order until one answers. */
export async function generateWithTools({ messages, tools, maxTokens, temperature, signal, models }) {
  const list = models || (await modelOrder());
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const model = list[i];
    try {
      const r = await callModelTools({ model, messages, tools, maxTokens, temperature, signal });
      return { ...r, model, attempts: i + 1, errors };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push({ model, error: String(e.message || e).slice(0, 160) });
    }
    if (i < list.length - 1 && isPacedModel(model)) await sleep(RATE_LIMIT_DELAY_MS);
  }
  const err = new Error('all models failed or are rate-limited');
  err.attempts = errors;
  throw err;
}
