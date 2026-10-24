// warm-context.test.mjs — the warm-context toggle added to runner.mjs 2026-09-28.
//
// Same fake-`claude`-executable technique as runner-routes.test.mjs (never hits the real CLI).
// WARM_CONTEXT_FLAG always points at a temp path in this suite — the real flag file
// (deploy/warm-context.on) is never created or touched.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, CLAUDE_READ_ALLOWLIST, CLAUDE_WRITE_DENYLIST, WARM_CONTEXT_TOOLS, warmContextEnabled } from '../runner.mjs';

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-warm-'));
const FAKE_CLAUDE = path.join(fakeDir, 'fake-claude.mjs');
const RECORD_PATH = path.join(fakeDir, 'record.json');
fs.writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const i = argv.indexOf('--append-system-prompt-file');
  const sysPath = i >= 0 ? argv[i + 1] : null;
  let systemPrompt = null;
  try { if (sysPath) systemPrompt = fs.readFileSync(sysPath, 'utf8'); } catch {}
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, systemPrompt }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fake claude answer' }));
});
`);
fs.chmodSync(FAKE_CLAUDE, 0o755);
process.on('exit', () => fs.rmSync(fakeDir, { recursive: true, force: true }));

function resetRecord() { fs.rmSync(RECORD_PATH, { force: true }); }
function readRecord() { return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')); }

// A fresh temp flag path per test — the real WARM_CONTEXT_FLAG default (deploy/warm-context.on)
// must never be created by this suite.
function tempFlagPath() { return path.join(fakeDir, `flag-${Math.random().toString(36).slice(2)}.on`); }

const MESSAGES = [{ role: 'system', content: 'You draft replies.' }, { role: 'user', content: 'hello' }];

test('warmContextEnabled(): false when the flag file is absent (the real, unset default)', () => {
  const flagPath = tempFlagPath();
  process.env.WARM_CONTEXT_FLAG = flagPath;
  try {
    assert.equal(fs.existsSync(flagPath), false, 'sanity: this test never creates the flag');
    assert.equal(warmContextEnabled(), false);
  } finally {
    delete process.env.WARM_CONTEXT_FLAG;
  }
});

test('warmContextEnabled(): true only once the flag file exists', () => {
  const flagPath = tempFlagPath();
  process.env.WARM_CONTEXT_FLAG = flagPath;
  try {
    assert.equal(warmContextEnabled(), false);
    fs.writeFileSync(flagPath, '');
    assert.equal(warmContextEnabled(), true, 'toggles live, no restart needed');
  } finally {
    fs.rmSync(flagPath, { force: true });
    delete process.env.WARM_CONTEXT_FLAG;
  }
});

test('claude: flag ABSENT -> allowedTools is exactly today\'s CLAUDE_READ_ALLOWLIST, no warm block, denylist unchanged', async () => {
  resetRecord();
  const flagPath = tempFlagPath();
  process.env.WARM_CONTEXT_FLAG = flagPath;
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  try {
    await generate({ messages: MESSAGES, models: ['claude:sonnet'] });
    const rec = readRecord();
    assert.equal(rec.argv[rec.argv.indexOf('--allowedTools') + 1], CLAUDE_READ_ALLOWLIST.join(','));
    assert.equal(rec.argv[rec.argv.indexOf('--disallowedTools') + 1], CLAUDE_WRITE_DENYLIST.join(','));
    assert.doesNotMatch(rec.systemPrompt, /optional warm context/);
    for (const t of WARM_CONTEXT_TOOLS) assert.ok(!rec.argv[rec.argv.indexOf('--allowedTools') + 1].includes(t));
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.WARM_CONTEXT_FLAG;
    fs.rmSync(flagPath, { force: true });
  }
});

test('claude: flag PRESENT -> WARM_CONTEXT_TOOLS (now empty) are appended and the warm block is present; denylist unchanged', async () => {
  resetRecord();
  const flagPath = tempFlagPath();
  fs.writeFileSync(flagPath, '');
  process.env.WARM_CONTEXT_FLAG = flagPath;
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_RECORD = RECORD_PATH;
  try {
    await generate({ messages: MESSAGES, models: ['claude:sonnet'] });
    const rec = readRecord();
    const allowed = rec.argv[rec.argv.indexOf('--allowedTools') + 1];
    assert.equal(allowed, [...CLAUDE_READ_ALLOWLIST, ...WARM_CONTEXT_TOOLS].join(','));
    assert.equal(rec.argv[rec.argv.indexOf('--disallowedTools') + 1], CLAUDE_WRITE_DENYLIST.join(','));
    assert.match(rec.systemPrompt, /optional warm context/);
    assert.match(rec.systemPrompt, /never say or imply you looked them up or used a tool/);
    for (const t of WARM_CONTEXT_TOOLS) assert.ok(allowed.includes(t));
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_RECORD;
    delete process.env.WARM_CONTEXT_FLAG;
    fs.rmSync(flagPath, { force: true });
  }
});

test('the real flag file is never created by this suite or by production code merely checking it', () => {
  const realFlag = path.join(path.resolve(import.meta.dirname, '..'), '..', 'deploy', 'warm-context.on');
  assert.equal(fs.existsSync(realFlag), false, 'PART A must never create deploy/warm-context.on');
});
