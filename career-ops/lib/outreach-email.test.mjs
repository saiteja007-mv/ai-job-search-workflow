/**
 * outreach-email.test.mjs — guards what must never regress:
 *   1. contact@ sends ALWAYS carry `from` on the personal account; legacymail sends never do.
 *   2. Approval is bound to the exact message (hash); prior touches block a send.
 *   3. The per-company rule (markers, aliases, tsenta, legacymail confirmations).
 *   4. A failing ledger write never turns a delivered send into a failure.
 *
 * Run: node lib/outreach-email.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEmailFields, identityFor, messageHash, priorTouches, sendOutreachEmail, textToHtml, checkAttachment, signedHtml } from './outreach-email.mjs';

const env = { UNIPILE_GMAIL_PERSONAL_ACCOUNT_ID: 'P', UNIPILE_GMAIL_LEGACY_ACCOUNT_ID: 'C', UNIPILE_API_KEY: 'KEY', UNIPILE_API_BASE: 'https://u.example/api/v1' };
const cfg = { from: '<CONTACT_EMAIL>', legacy: '<CONTACT_EMAIL>', displayName: 'Test Person' };
const base = { to: [{ name: '<CONTACT_NAME>', email: '<CONTACT_EMAIL>' }], subject: 's', html: '<p>h</p>' };

// 1. sender identity
const c = buildEmailFields(env, 'contact', base, cfg);
assert.equal(c.account_id, 'P');
assert.deepEqual(JSON.parse(c.from), { display_name: 'Test Person', identifier: '<CONTACT_EMAIL>' });
const l = buildEmailFields(env, 'legacymail', base, cfg);
assert.equal(l.account_id, 'C');
assert.equal(l.from, undefined, 'contact@ must never be sent through the legacymail account');
assert.equal(buildEmailFields({ UNIPILE_PERSONAL_GMAIL_ACCOUNT_ID: 'P2' }, 'contact', base, cfg).account_id, 'P2');
assert.throws(() => buildEmailFields({}, 'contact', base, cfg), /missing Unipile account/);
assert.throws(() => buildEmailFields(env, 'other', base, cfg), /unknown identity/);
assert.equal(textToHtml('a <b>\r\nc\r\n\r\nd'), '<p>a &lt;b&gt;<br>c</p>\n<p>d</p>');

// throwaway repo layout
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-'));
for (const d of ['data', 'config', 'output', 'agency-applications/_raw']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'config/profile.yml'), 'candidate:\n  full_name: "Test Person"\noutreach:\n  from: "<CONTACT_EMAIL>"\n  legacy_email: "<CONTACT_EMAIL>"\n  tsenta_switch_date: "2026-10-10"\n');
fs.writeFileSync(path.join(root, 'data/applications.md'), [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-09-01 | <TARGET_COMPANY> | AI/ML Engineer | 4.1/5 | Applied | ❌ | r | n |',
  '| 2 | 2026-09-01 | Evalco | MLE | 3.0/5 | Evaluated | ❌ | r | n |',
  '| 3 | 2026-10-05 | Newco | MLE | 4.0/5 | Applied | ❌ | r | email=contact@ |',
  '| 4 | 2026-09-02 | IMDb (Amazon) | DS | 4.0/5 | Applied | ❌ | r | n |',
  '| 5 | 2026-09-01 | Flipco | MLE | 4.0/5 | Applied | ❌ | r | n |',
  '| 6 | 2026-10-06 | Flipco | MLE II | 4.0/5 | Applied | ❌ | r | email=contact@ |',
].join('\n'));
fs.writeFileSync(path.join(root, 'data/tsenta-apps.json'), JSON.stringify({ apps: [
  { company: '<TARGET_COMPANY>', status: 'COMPLETED', appliedAt: '2026-10-03T04:45:52Z' },
  { company: 'Skipco', status: 'SKIPPED', appliedAt: '2026-09-01' },
  { company: 'Laterco', status: 'COMPLETED', appliedAt: '2026-10-12T00:00:00Z' },
  { company: 'Newco', status: 'COMPLETED', appliedAt: '2026-09-01' },
] }));
fs.writeFileSync(path.join(root, 'agency-applications/_raw/Submissions.json'), JSON.stringify({ threads: [
  { from: 'no-reply@example-company.com', subject: 'Thank you for your interest with <TARGET_COMPANY>' },
  { from: 'Airbnb Recruiting', subject: 'Your application', mailbox: '<CONTACT_EMAIL>' },
] }));

// 3. per-company rule
const id = co => identityFor(co, root).identity;
assert.equal(id('<TARGET_COMPANY>'), 'legacymail');
assert.equal(id('Hello Labs'), 'contact', '"ello" must not match inside "hello"');
assert.equal(id('Evalco'), 'contact', 'Evaluated rows created no ATS account');
assert.equal(id('Newco'), 'contact', 'explicit email=contact@ marker beats tsenta evidence');
assert.equal(id('Flipco'), 'contact', 'newest marker beats an older unmarked applied row');
assert.equal(id('Amazon'), 'legacymail', 'parenthesized parent "IMDb (Amazon)" counts as Amazon');
assert.equal(id('<TARGET_COMPANY>'), 'legacymail');
assert.equal(id('Skipco'), 'contact');
assert.equal(id('Laterco'), 'contact', 'tsenta apps after tsenta_switch_date are not legacy');
assert.equal(id('<TARGET_COMPANY>'), 'legacymail');
assert.equal(id('Airbnb'), 'contact', 'contact@ inbox threads are not legacy evidence');
assert.equal(identityFor('', root).identity, null);

const h4NoSig = messageHash('contact', { ...base, to: [{ name: 'Di', email: '<CONTACT_EMAIL>' }], company: 'Sigco' }, root);

// 2. approval + prior touches + attachments
fs.writeFileSync(path.join(root, 'output/r.pdf'), '%PDF-1.4 test');
fs.writeFileSync(path.join(root, 'output/x.txt'), 'nope');
fs.writeFileSync(path.join(root, 'secret.pdf'), '%PDF-1.4');
assert.throws(() => checkAttachment('secret.pdf', root), /under output/);
assert.throws(() => checkAttachment('output/x.txt', root), /\.pdf/);
const msg = { ...base, company: 'Newco', attachments: ['output/r.pdf'] };
const h = messageHash('contact', msg, root);
assert.notEqual(h, messageHash('contact', { ...msg, subject: 's2' }, root), 'hash covers the subject');
let calls = [];
const okFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, text: async () => '{"object":"EmailSent","tracking_id":"t1"}' }; };
await assert.rejects(sendOutreachEmail({ ...msg, approval: 'deadbeef' }, { root, env, fetchImpl: okFetch }), /approval does not match/);
await assert.rejects(sendOutreachEmail({ ...msg, company: undefined, approval: h }, { root, env, fetchImpl: okFetch }), /give --company/);
assert.equal(calls.length, 0);

const r = await sendOutreachEmail({ ...msg, approval: h }, { root, env, fetchImpl: okFetch });
assert.equal(calls[0].url, 'https://u.example/api/v1/emails', 'base that already ends in /api/v1 is not doubled');
assert.equal(calls[0].init.body.get('account_id'), 'P');
assert.equal(JSON.parse(calls[0].init.body.get('from')).identifier, '<CONTACT_EMAIL>');
assert.deepEqual([r.sent, r.logged, r.identity, r.from], [true, true, 'contact', '<CONTACT_EMAIL>']);
const ledger = fs.readFileSync(path.join(root, 'data/email_outreach_log.jsonl'), 'utf8');
assert.ok(!ledger.includes('KEY') && !ledger.includes('"P"'), 'no secrets in the ledger');
assert.match(priorTouches(msg, root)[0], /^email /);
await assert.rejects(sendOutreachEmail({ ...msg, approval: h }, { root, env, fetchImpl: okFetch }), /already contacted/);

// base without /api/v1; legacymail identity; LinkedIn touch blocks; second-touch allows
fs.writeFileSync(path.join(root, 'data/outreach_log.json'), JSON.stringify({ events: [{ channel: 'linkedin_connection_invite', name: '<CONTACT_NAME>', company: '<TARGET_COMPANY>', sent_at: '2026-10-03' }] }));
const m2 = { to: [{ name: '<CONTACT_NAME>', email: '<CONTACT_EMAIL>' }], subject: 'hi', html: '<p>x</p>', company: '<TARGET_COMPANY>' };
const h2 = messageHash('legacymail', m2, root);
calls = [];
await assert.rejects(sendOutreachEmail({ ...m2, approval: h2 }, { root, env, fetchImpl: okFetch }), /already contacted .*linkedin/);
await sendOutreachEmail({ ...m2, approval: h2, secondTouch: true }, { root, env: { ...env, UNIPILE_API_BASE: 'https://u.example/' }, fetchImpl: okFetch });
assert.equal(calls[0].url, 'https://u.example/api/v1/emails');
assert.equal(calls[0].init.body.get('account_id'), 'C');
assert.equal(calls[0].init.body.get('from'), null, 'legacymail send carries no from');

// errors are redacted; a ledger failure does not fail a delivered send
const badFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key KEY for account P' });
const m3 = { ...base, to: [{ name: 'Cy', email: '<CONTACT_EMAIL>' }], company: 'Zedco' };
await assert.rejects(sendOutreachEmail({ ...m3, approval: messageHash('contact', m3, root) }, { root, env, fetchImpl: badFetch }),
  e => !e.message.includes('KEY') && e.message.includes('<redacted>'));
fs.rmSync(path.join(root, 'data/email_outreach_log.jsonl'));
fs.mkdirSync(path.join(root, 'data/email_outreach_log.jsonl')); // appendFileSync on a directory throws
const origErr = console.error; console.error = () => {};
const r3 = await sendOutreachEmail({ ...m3, approval: messageHash('contact', m3, root) }, { root, env, fetchImpl: okFetch });
console.error = origErr;
assert.deepEqual([r3.sent, r3.logged], [true, false]);

// signature: contact@ mail carries config/email-signature.html, legacymail does not, and the approval hash covers it
fs.writeFileSync(path.join(root, 'config/email-signature.html'), '<table><tr><td>SIG</td></tr></table>\n');
const m4 = { ...base, to: [{ name: 'Di', email: '<CONTACT_EMAIL>' }], company: 'Sigco' };
assert.notEqual(messageHash('contact', m4, root), h4NoSig, 'adding a signature changes the approval hash');
assert.equal(signedHtml('legacymail', '<p>x</p>', root), '<p>x</p>');
calls = [];
console.error = () => {}; // the ledger is still a directory from the step above
await sendOutreachEmail({ ...m4, approval: messageHash('contact', m4, root) }, { root, env, fetchImpl: okFetch });
console.error = origErr;
assert.match(calls[0].init.body.get('body'), /<p>.*<\/p>\n<table><tr><td>SIG<\/td><\/tr><\/table>$/s, 'signature appended after the body');

fs.rmSync(root, { recursive: true, force: true });
console.log('outreach-email: all assertions passed');
