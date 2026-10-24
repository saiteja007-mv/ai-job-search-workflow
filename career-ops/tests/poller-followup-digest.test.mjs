// Follow-up nudge eligibility and the evening Telegram digest (deploy/unipile-poll.mjs, 2026-10-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followupDue, sendDigest } from '../deploy/unipile-poll.mjs';
import { linkedInHandle } from '../deploy/linkedin-send.mjs';

const NOW = Date.parse('2026-10-20T15:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400_000).toISOString();
const msg = (is_sender, d, text = 'x') => ({ is_sender, timestamp: daysAgo(d), text });

test('followupDue: real conversation, my message last, 7-10 days old', () => {
  assert.equal(followupDue([msg(false, 12), msg(true, 8)], NOW), true);
});

test('followupDue: never for a one-sided thread (accepted-invite DM they never answered)', () => {
  assert.equal(followupDue([msg(true, 14), msg(true, 8)], NOW), false);
});

test('followupDue: not when their message is last, too fresh, or too old', () => {
  assert.equal(followupDue([msg(true, 12), msg(false, 8)], NOW), false);
  assert.equal(followupDue([msg(false, 12), msg(true, 6)], NOW), false);
  assert.equal(followupDue([msg(false, 30), msg(true, 11)], NOW), false);
});

test('sendDigest: waits until 20:00 CT, sends once a day in Telegram-sized parts, keeps the queue on failure', async () => {
  const sent = [];
  const ok = async (t) => { sent.push(t); return true; };
  const state = { digest: ['• A\n\n  SENT ✓ — x', '• B skipped', 'y'.repeat(3700)] };
  assert.equal(await sendDigest(state, new Date('2026-10-20T23:00:00Z'), ok), false);   // 18:00 CT
  assert.equal(await sendDigest({ ...state }, new Date('2026-10-21T01:30:00Z'), async () => false), false); // refused
  assert.equal(await sendDigest(state, new Date('2026-10-21T01:30:00Z'), ok), true);   // 20:30 CT
  assert.ok(sent[0].includes('1 sent automatically, 2 skipped'));
  assert.ok(sent.every((t) => t.length <= 3800) && sent.length === 2);
  assert.deepEqual(state.digest, []);
  assert.equal(await sendDigest({ ...state, digest: ['z'] }, new Date('2026-10-21T02:00:00Z'), ok), false); // same CT day
});

test('linkedInHandle reads the public id from a shared profile link', () => {
  assert.equal(linkedInHandle('https://www.linkedin.com/in/<PROFILE_SLUG>'), 'felipe-gonzalez-99314891');
  assert.equal(linkedInHandle('see linkedin.com/in/<PROFILE_SLUG>?utm=x'), 'jane-doe');
  assert.equal(linkedInHandle('no link here'), null);
});
