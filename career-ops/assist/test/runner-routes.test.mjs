// runner-routes.test.mjs — the claude: and omniroute: routes added to runner.mjs 2026-09-25.
//
// NEVER hits the real `claude` CLI, OmniRoute, OpenRouter or Unipile. The claude: route is
// exercised against a tiny fake executable (CLAUDE_BIN env override) that records what it was
// invoked with and prints a canned `claude -p --output-format json` result; the omniroute: route
// is exercised against a local http server (OMNIROUTE_URL env override). Every test that sets a
// process.env var restores it in a finally block — this suite shares one process with every
// other *.test.mjs file.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generate, generateWithTools, RATE_LIMIT_MS, CLAUDE_READ_ALLOWLIST, CLAUDE_WRITE_DENYLIST } from '../runner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');   // must equal callClaude()'s cwd

// ---- fake `claude` executable ------------------------------------------------------------
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
const FAKE_CLAUDE = path.join(fakeDir, 'fake-claude.mjs');
const RECORD_PATH = path.join(fakeDir, 'record.json');
fs.writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', async () => {
  const i = argv.indexOf('--append-system-prompt-file');
  const sysPath = i >= 0 ? argv[i + 1] : null;
  let systemPrompt = null;
  try { if (sysPath) systemPrompt = fs.readFileSync(sysPath, 'utf8'); } catch {}
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
    argv, stdin, cwd: process.cwd(), systemPrompt,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,
      CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX ?? null,
    },
  }));
  if (process.env.FAKE_CLAUDE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLEEP_MS)));
  if (process.env.FAKE_CLAUDE_IS_ERROR) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }));
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: process.env.FAKE_CLAUDE_RESULT || 'fake claude answer', num_turns: 1, total_cost_usd: 0 }));
});
`);
fs.chmodSync(FAKE_CLAUDE, 0o755);

// A second fake binary that ignores SIGTERM on purpose, to prove the SIGKILL escalation
// (2026-09-25 review finding) actually terminates a child that does not honor SIGTERM promptly —
// FAKE_CLAUDE above is a plain Node script with no handler, so Node's default (instant exit on
// SIGTERM) would mask exactly this failure mode.
const FAKE_CLAUDE_STUBBORN = path.join(fakeDir, 'fake-claude-stubborn.mjs');
fs.writeFileSync(FAKE_CLAUDE_STUBBORN, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 20000);
`);
fs.chmodSync(FAKE_CLAUDE_STUBBORN, 0o755);
process.on('exit', () => fs.rmSync(fakeDir, { recursive: true, force: true }));

function resetRecord() { fs.rmSync(RECORD_PATH, { force: true }); }
function readRecord() { return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')); }

const ANTHROPIC_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
/** Every claude: test needs a clean slate: no stray ANTHROPIC_* from the real dev environment. */
function withCleanAnthropicEnv(fn) {
  const prev = {};
  for (const k of ANTHROPIC_VARS) { prev[k] = process.env[k]; delete process.env[k]; }
  return (async () => {
    try { return await fn(); }
    finally { for (const k of ANTHROPIC_VARS) { if (prev[k] !== undefined) process.env[k] = prev[k]; } }
  })();
}

// ---- fake OmniRoute http server -----------------------------------------------------------
let omniServer, omniBase;
const omniRequests = [];
function omniHandler(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    omniRequests.push({ headers: req.headers, body: parsed });
    const tools = parsed.tools?.length;
    const message = tools
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }] }
      : { role: 'assistant', content: 'omni text answer' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { total_tokens: 12 } }));
  });
}
test.before(async () => {
  omniServer = http.createServer(omniHandler);
  await new Promise((resolve) => omniServer.listen(0, '127.0.0.1', resolve));
  omniBase = `http://127.0.0.1:${omniServer.address().port}`;
});
test.after(async () => { await new Promise((r) => omniServer.close(r)); });

const MESSAGES = [{ role: 'system', content: 'You draft replies.' }, { role: 'user', content: 'hello' }];

// ---- claude: argv / stdin / env / cwd ------------------------------------------------------

test('claude: spawns `claude -p` with dontAsk/none, the read allowlist, the write denylist, no unloading flags, and never puts the prompt on argv', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  try {
    const onDelta = [];
    const r = await generate({ messages: MESSAGES, models: ['claude:sonnet'], onDelta: (t) => onDelta.push(t) });
    assert.equal(r.model, 'claude:sonnet');
    assert.equal(r.text, 'fake claude answer');
    assert.deepEqual(onDelta, ['fake claude answer'], 'onDelta fires exactly once, with the full text');

    const rec = readRecord();
    const argv = rec.argv;
    assert.equal(argv[0], '-p');
    assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'sonnet']);
    assert.ok(argv.includes('--output-format') && argv[argv.indexOf('--output-format') + 1] === 'json');
    assert.ok(argv.includes('--max-turns') && argv[argv.indexOf('--max-turns') + 1] === '12');
    assert.ok(argv.includes('--no-session-persistence'));
    assert.ok(argv.includes('--permission-mode') && argv[argv.indexOf('--permission-mode') + 1] === 'dontAsk');
    assert.ok(argv.includes('--permission-prompts') && argv[argv.indexOf('--permission-prompts') + 1] === 'none');
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], CLAUDE_READ_ALLOWLIST.join(','));
    assert.equal(argv[argv.indexOf('--disallowedTools') + 1], CLAUDE_WRITE_DENYLIST.join(','));
    assert.ok(!CLAUDE_READ_ALLOWLIST.includes('WebFetch') && !CLAUDE_READ_ALLOWLIST.includes('WebSearch'),
      'WebFetch/WebSearch must stay off the allowlist — a prompt-injected thread could use either to exfiltrate data via a query string (2026-09-25 review finding)');

    // --setting-sources 'user,project' (excluding "local") IS expected here (2026-09-25 review
    // finding): this repo's own .claude/settings.local.json carries interactive Write(*)/Edit(*)/
    // Bash(node:*) allow rules that must never load for this call. Only --strict-mcp-config and a
    // blanket --tools '' would unload tools/MCP entirely, which is still forbidden.
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user,project');
    assert.ok(!argv[argv.indexOf('--setting-sources') + 1].includes('local'), '"local" must be excluded so settings.local.json never loads');
    for (const forbidden of ['--strict-mcp-config', '--tools']) {
      assert.ok(!argv.includes(forbidden), `${forbidden} must never be passed — it would unload tools/MCP entirely`);
    }
    assert.ok(!argv.some((a) => String(a).includes('hello')), 'the prompt must never appear on argv, only on stdin');
    assert.equal(rec.stdin, 'hello', 'a single non-system message is sent unlabeled');
    assert.equal(rec.cwd, REPO_ROOT, 'cwd must be the career-ops repo so its CLAUDE.md/AGENTS.md apply');
    for (const k of ANTHROPIC_VARS) assert.equal(rec.env[k], null, `${k} must not reach the child`);
    assert.match(rec.systemPrompt, /You draft replies\./, 'joined system messages reach the CLI');
    assert.match(rec.systemPrompt, /cannot send, post, invite, write or run commands/, 'the read-only line is appended');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
  }
}));

test('claude: writes the system-prompt file for the child to read, then cleans it up', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  try {
    await generate({ messages: MESSAGES, models: ['claude:sonnet'] });
    const rec = readRecord();
    const sysPath = rec.argv[rec.argv.indexOf('--append-system-prompt-file') + 1];
    assert.ok(sysPath, 'the flag was passed');
    assert.equal(fs.existsSync(sysPath), false, 'the temp file (and its temp dir) must not survive the call');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
  }
}));

test('claude: a multi-turn prompt is labeled User:/Assistant: on stdin, still never on argv', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  try {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'draft1' },
      { role: 'user', content: 'second' },
    ];
    await generate({ messages, models: ['claude:sonnet'] });
    const rec = readRecord();
    assert.equal(rec.stdin, 'User: first\n\nAssistant: draft1\n\nUser: second');
    assert.ok(!rec.argv.some((a) => /first|draft1|second/.test(String(a))), 'still nothing on argv');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
  }
}));

test('claude: refuses (throws) without spawning anything when an ANTHROPIC_* var is set in the parent', async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.ANTHROPIC_API_KEY = '<API_KEY>';
  try {
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet'] }),
      (e) => { assert.match(e.attempts[0].error, /ANTHROPIC_API_KEY/); return true; },
    );
    assert.equal(fs.existsSync(RECORD_PATH), false, 'the child must never have been spawned');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('claude: is_error in the CLI JSON result is thrown as a short error', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.FAKE_CLAUDE_IS_ERROR = '1';
  try {
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet'] }),
      (e) => { assert.match(e.attempts[0].error, /claude sonnet/); return true; },
    );
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.FAKE_CLAUDE_IS_ERROR;
  }
}));

test('claude: a non-zero exit is thrown, not silently swallowed', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  // A binary that exits 1 with no JSON on stdout — simulate with a CLAUDE_BIN pointing at
  // /bin/false rather than the fake, no server/network involved.
  process.env.CLAUDE_BIN = '/bin/false';
  try {
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet'] }),
      (e) => { assert.match(e.attempts[0].error, /claude sonnet/); return true; },
    );
  } finally {
    delete process.env.CLAUDE_BIN;
  }
}));

test('claude: CLAUDE_ROUTE_TIMEOUT_MS kills a hung child by its own pid, well before it would finish', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.FAKE_CLAUDE_SLEEP_MS = '5000';
  process.env.CLAUDE_ROUTE_TIMEOUT_MS = '200';
  try {
    const t0 = Date.now();
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet'] }),
      (e) => { assert.match(e.attempts[0].error, /timed out/); return true; },
    );
    assert.ok(Date.now() - t0 < 4000, 'must not wait out the full 5s sleep — the child was killed');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
    delete process.env.CLAUDE_ROUTE_TIMEOUT_MS;
  }
}));

test('claude: escalates to SIGKILL when the child ignores SIGTERM, bounding the real worst case (2026-09-25 review finding)', () => withCleanAnthropicEnv(async () => {
  process.env.CLAUDE_BIN = FAKE_CLAUDE_STUBBORN;
  process.env.CLAUDE_ROUTE_TIMEOUT_MS = '200';
  process.env.CLAUDE_ROUTE_KILL_GRACE_MS = '200';
  try {
    const t0 = Date.now();
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet'] }),
      (e) => { assert.match(e.attempts[0].error, /timed out/); return true; },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `SIGKILL must terminate a SIGTERM-ignoring child well before its own 20s exit (took ${elapsed}ms)`);
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.CLAUDE_ROUTE_TIMEOUT_MS;
    delete process.env.CLAUDE_ROUTE_KILL_GRACE_MS;
  }
}));

test('claude: an outer AbortSignal kills the child too, and generate() stops rather than trying the next model', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.FAKE_CLAUDE_SLEEP_MS = '5000';
  const before = omniRequests.length;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  try {
    const t0 = Date.now();
    await assert.rejects(
      generate({ messages: MESSAGES, models: ['claude:sonnet', 'omniroute:hermes-fallback'], signal: ac.signal }),
      (e) => e.name === 'AbortError',
    );
    assert.ok(Date.now() - t0 < 4000, 'killed promptly, not after the 5s sleep');
    assert.equal(omniRequests.length, before, 'an outer deadline means no time for ANY model, so omniroute must not be tried');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
  }
}));

// ---- omniroute: ------------------------------------------------------------------------

test('omniroute: sends an auth token and gets a text answer back', async () => {
  omniRequests.length = 0;
  process.env.OMNIROUTE_URL = `${omniBase}/v1/chat/completions`;
  process.env.OMNIROUTE_API_KEY = 'test-omni-key-123';
  try {
    const r = await generate({ messages: MESSAGES, models: ['omniroute:hermes-fallback'] });
    assert.equal(r.model, 'omniroute:hermes-fallback');
    assert.equal(r.text, 'omni text answer');
    assert.equal(omniRequests.length, 1);
    assert.equal(omniRequests[0].headers.authorization, 'Bearer\u0020test-omni-key-123');
    assert.equal(omniRequests[0].body.model, 'hermes-fallback', 'the omniroute: prefix is stripped before it reaches the gateway');
    assert.ok(!omniRequests[0].body.tools, 'the text path sends no tools');
  } finally {
    delete process.env.OMNIROUTE_URL;
    delete process.env.OMNIROUTE_API_KEY;
  }
});

test('omniroute: the tools path returns OpenAI-shaped tool_calls', async () => {
  omniRequests.length = 0;
  process.env.OMNIROUTE_URL = `${omniBase}/v1/chat/completions`;
  process.env.OMNIROUTE_API_KEY = 'test-omni-key-123';
  const tools = [{ type: 'function', function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } } }];
  try {
    const r = await generateWithTools({ messages: MESSAGES, tools, models: ['omniroute:hermes-fallback'] });
    assert.equal(r.model, 'omniroute:hermes-fallback');
    assert.equal(r.message.tool_calls[0].function.name, 'ping');
    assert.equal(omniRequests[0].body.tools[0].function.name, 'ping');
    assert.equal(omniRequests[0].body.tool_choice, 'auto');
  } finally {
    delete process.env.OMNIROUTE_URL;
    delete process.env.OMNIROUTE_API_KEY;
  }
});

// ---- dispatch / fallback / pacing --------------------------------------------------------

test('generate(): falls through from a failing claude: to omniroute: with no rate-limit pause', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.FAKE_CLAUDE_IS_ERROR = '1';
  process.env.OMNIROUTE_URL = `${omniBase}/v1/chat/completions`;
  process.env.OMNIROUTE_API_KEY = 'test-omni-key-123';
  omniRequests.length = 0;
  try {
    const t0 = Date.now();
    const r = await generate({ messages: MESSAGES, models: ['claude:x', 'omniroute:hermes-fallback'] });
    const elapsed = Date.now() - t0;
    assert.equal(r.model, 'omniroute:hermes-fallback');
    assert.equal(r.attempts, 2);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].model, 'claude:x');
    assert.ok(elapsed < RATE_LIMIT_MS, `no pacing pause expected between claude:/omniroute: attempts (took ${elapsed}ms)`);
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    delete process.env.OMNIROUTE_URL;
    delete process.env.OMNIROUTE_API_KEY;
  }
}));

test('generateWithTools(): skips claude: and codex: instantly (no call, no delay) and reaches omniroute:', () => withCleanAnthropicEnv(async () => {
  resetRecord();
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  process.env.OMNIROUTE_URL = `${omniBase}/v1/chat/completions`;
  process.env.OMNIROUTE_API_KEY = 'test-omni-key-123';
  const tools = [{ type: 'function', function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } } }];
  try {
    const t0 = Date.now();
    const r = await generateWithTools({ messages: MESSAGES, tools, models: ['claude:x', 'codex:y', 'omniroute:hermes-fallback'] });
    const elapsed = Date.now() - t0;
    assert.equal(r.model, 'omniroute:hermes-fallback');
    assert.equal(r.attempts, 3);
    assert.equal(r.errors.length, 2);
    assert.deepEqual(r.errors.map((e) => e.model), ['claude:x', 'codex:y']);
    for (const e of r.errors) assert.match(e.error, /tool-calling is not supported/);
    assert.ok(elapsed < RATE_LIMIT_MS, `claude:/codex: must be skipped with no pacing pause (took ${elapsed}ms)`);
    assert.equal(fs.existsSync(RECORD_PATH), false, 'claude: must never actually be spawned in the tools path');
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.OMNIROUTE_URL;
    delete process.env.OMNIROUTE_API_KEY;
  }
}));

// ---- upstream timeout chain (draft.mjs / unipile-poll.mjs) --------------------------------
// These never import unipile-poll.mjs — it runs main() unconditionally at module load (it is a
// systemd oneshot script, not guarded by an isMain check), which would hit live Unipile. Read
// the source text instead, the same technique agent.test.mjs already uses for ordering checks.

function numberConst(src, name) {
  const m = new RegExp(`${name}\\s*=[^\\d]*([\\d_]+)`).exec(src);
  assert.ok(m, `${name} not found`);
  return Number(m[1].replace(/_/g, ''));
}

test('the message-draft deadline chain outlasts a full-length claude: call at every hop, and stays well under the ~8min/event ceiling', () => {
  const runnerSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'runner.mjs'), 'utf8');
  const draftSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'draft.mjs'), 'utf8');
  const pollSrc = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'deploy', 'unipile-poll.mjs'), 'utf8');

  // claudeRouteTimeoutMs() is a function (read fresh per call, so CLAUDE_ROUTE_TIMEOUT_MS is
  // overridable in a test — see the timeout test above), not a NAME = NUMBER const, hence its
  // own pattern rather than numberConst().
  const claudeTimeoutMatch = /claudeRouteTimeoutMs\(\)\s*\{\s*return\s*Number\(process\.env\.CLAUDE_ROUTE_TIMEOUT_MS\)\s*\|\|\s*([\d_]+)/.exec(runnerSrc);
  assert.ok(claudeTimeoutMatch, 'claudeRouteTimeoutMs() default not found');
  const claudeRouteTimeout = Number(claudeTimeoutMatch[1].replace(/_/g, ''));
  const messageDeadline = numberConst(draftSrc, 'MESSAGE_DEADLINE_MS');
  const draftTimeout = numberConst(pollSrc, 'DRAFT_TIMEOUT_MS');

  assert.equal(claudeRouteTimeout, 150_000, 'runner.mjs default (sanity, so the rest of this test means what it says)');
  assert.ok(messageDeadline > claudeRouteTimeout, 'assist server must outlast a full-length claude: call, or it kills a healthy request');
  assert.ok(draftTimeout > messageDeadline, "unipile-poll.mjs's client-side wait must outlast the server's own deadline");
  assert.ok(draftTimeout < 8 * 60_000, 'a single event must stay well under the ~8 minute ceiling');

  // The 3-attempt retry loop in draft.mjs's pipeline() shares ONE AbortSignal across all 3
  // attempts (built once in the handler, passed through unchanged) — it cannot multiply the
  // deadline above. Pin that shape down explicitly so a future refactor cannot reintroduce a
  // fresh signal per attempt without this test noticing.
  assert.match(draftSrc, /for \(let attempt = 1; attempt <= 3; attempt\+\+\)/, 'the 3-attempt loop is still where the deadline sharing was verified');
  const pipelineFn = draftSrc.slice(draftSrc.indexOf('async function pipeline'), draftSrc.indexOf('async function pipeline') + 1200);
  assert.equal((pipelineFn.match(/AbortSignal\.timeout/g) || []).length, 0, 'pipeline() must not mint its own per-attempt signal — one shared deadline comes in from the caller');

  // The old "TimeoutStartSec=600" this comment used to cite was already wrong (the real unit
  // has TimeoutStartSec=300) even before this change widened the gap further; that is a known,
  // flagged, out-of-scope follow-up (deploy/systemd/*.service is not in this task's edit list),
  // not something a passing test should paper over by asserting a number this file cannot fix.
  assert.match(pollSrc, /TimeoutStartSec=300/, 'the real systemd ceiling must stay documented, not silently dropped');
});
