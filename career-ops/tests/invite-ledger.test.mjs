import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInvites, summarize, toDay } from '../lib/invite-ledger.mjs';

const root = path.join(os.tmpdir(), `invite-ledger-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const today = toDay(Date.now());
const write = (sent_profiles) => fs.writeFileSync(path.join(root, 'data', 'outreach_log.json'), JSON.stringify({ version: 1, events: [], sent_profiles }));

test('a tsenta-style record with the id nested in unipile_response is a confirmed send', () => {
  // This exact shape was invisible to the ledger on 2026-09-01: 89 confirmed sends counted as 0.
  write({ 'provider:ACoAA_T1': { sent_at: `${today}T22:05:35-05:00`, unipile_status: 201, unipile_response: { object: 'InvitationSent', invitation_id: '7498' } } });
  assert.equal(loadInvites(root).invites.length, 1);
  assert.equal(summarize(root, today).sentToday, 1);
});

test('a top-level invitation_id (MCP / scan shape) still counts', () => {
  write({ ACoAA_M1: { sent_at: today, invitation_id: '7499' } });
  assert.equal(loadInvites(root).invites.length, 1);
});

test('a 422 refusal never counts, even if a response object is present', () => {
  write({ 'provider:ACoAA_X': { sent_at: today, unipile_status: 422, unipile_response: { type: 'errors/already_invited_recently', status: 422 } } });
  assert.equal(loadInvites(root).invites.length, 0);
});

test('alias_for pointers are not sends', () => {
  write({ 'linkedin:someone': { alias_for: 'provider:ACoAA_T1', sent_at: today } });
  assert.equal(loadInvites(root).invites.length, 0);
});

test('"provider:" and bare keys for the same person dedupe to one send', () => {
  write({ 'provider:ACoAA_SAME': { sent_at: today, unipile_status: 201, unipile_response: { invitation_id: 'a' } },
          ACoAA_SAME: { sent_at: today, invitation_id: 'a' } });
  assert.equal(loadInvites(root).invites.length, 1);
});

test('all three observed sent_at formats land on the same day', () => {
  write({ A: { sent_at: `${today}T10:43:26-05:00`, invitation_id: '1' },
          B: { sent_at: `${today}T14:04:18.049490Z`, invitation_id: '2' },
          C: { sent_at: `${today}T19:12:33.640Z`, invitation_id: '3' } });
  assert.equal(summarize(root, today).sentToday, 3, 'format drift must not drop rows');
});
