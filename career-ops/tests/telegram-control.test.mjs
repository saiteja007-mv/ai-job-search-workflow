// Telegram control bot helpers and the shared item actions (deploy/telegram-control.mjs, deploy/linkedin-actions.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlots, setEnvLine } from '../deploy/telegram-control.mjs';
import { handle, buttonsFor, scorecard } from '../deploy/linkedin-actions.mjs';
import { sendDigest, sendScorecard } from '../deploy/unipile-poll.mjs';

test('parseSlots reads day ranges and several windows', () => {
  assert.deepEqual(parseSlots('Mon-Wed 09:00-17:00; Thu 9:00-15:00'),
    { Mon: ['09:00-17:00'], Tue: ['09:00-17:00'], Wed: ['09:00-17:00'], Thu: ['09:00-15:00'] });
  assert.deepEqual(parseSlots('fri 10:00-12:00, 13:00-14:00'), { Fri: ['10:00-12:00', '13:00-14:00'] });
  assert.throws(() => parseSlots('weekdays mornings'));
});

test('setEnvLine replaces in place or appends', () => {
  assert.equal(setEnvLine('A=1\nLINKEDIN_AUTOSEND=0\nB=2\n', 'LINKEDIN_AUTOSEND', '1'), 'A=1\nLINKEDIN_AUTOSEND=1\nB=2\n');
  assert.equal(setEnvLine('A=1', 'LINKEDIN_AUTOSEND', '0'), 'A=1\nLINKEDIN_AUTOSEND=0\n');
});

test('handle is short, stable and fits callback_data', () => {
  assert.equal(handle('replied:x:1'), handle('replied:x:1'));
  assert.equal(handle('replied:x:1').length, 6);
  assert.notEqual(handle('replied:x:1'), handle('replied:x:2'));
});

test('buttons: slot confirm, referral needs a connection first, plain send', () => {
  const kinds = (e) => buttonsFor(e)[0].map((b) => b.callback_data.split(':')[0]);
  assert.deepEqual(kinds({ id: 'a', slot: '2026-10-20T20:00:00Z', suggested: 'x' }), ['slot', 'edit', 'skip']);
  assert.deepEqual(kinds({ id: 'b', cls: 'referral', referral: { person: 'P' }, draft: { text: 'thanks' } }), ['skip']);
  assert.deepEqual(kinds({ id: 'c', cls: 'referral', referral: { invite: { candidate: { name: 'P' } } } }), ['invc', 'skip']);
  assert.deepEqual(kinds({ id: 'd', suggested: 'hello' }), ['send', 'edit', 'skip']);
});

test('scorecard counts the week and ranks why items needed <YOUR_NAME>', () => {
  const now = Date.parse('2026-10-25T00:00:00Z'), d = '2026-10-22T00:00:00Z';
  const rows = [
    { kind: 'replied', status: 'sent', detected_at: d },
    { kind: 'replied', status: 'needs_you', agent: { reason: 'Rejection: not moving forward' }, detected_at: d },
    { kind: 'replied', status: 'needs_you', agent: { reason: 'Rejection: filled' }, detected_at: d },
    { kind: 'accepted', status: 'dismissed', detected_at: '2026-10-01T00:00:00Z' },
  ];
  const s = scorecard(rows, 7, now);
  assert.match(s, /Sent automatically: 1/);
  assert.match(s, /Invites accepted: 0/);
  assert.match(s, /2 × Rejection/);
});

test('a forced digest sends early without cancelling the evening one', async () => {
  const st = { digest: ['a'] };
  assert.equal(await sendDigest(st, new Date('2026-10-20T16:00:00Z'), async () => true, true), true);
  assert.equal(st.digestSentOn, undefined);
});

test('scorecard goes out Sunday evening CT, once', async () => {
  const st = {}; let n = 0; const send = async () => { n++; return true; };
  assert.equal(await sendScorecard(st, new Date('2026-10-25T15:00:00Z'), send, []), false);  // Sun 10:00 CT
  assert.equal(await sendScorecard(st, new Date('2026-10-26T00:30:00Z'), send, []), true);   // Sun 19:30 CT
  assert.equal(await sendScorecard(st, new Date('2026-10-26T02:00:00Z'), send, []), false);  // same Sunday
  assert.equal(n, 1);
});
