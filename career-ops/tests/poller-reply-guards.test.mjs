// Guards from the 2026-09-29 <CONTACT_NAME>/Jabil incident and the 2026-10-07 <TARGET_COMPANY> referral miss.
// unipile-poll.mjs only polls when run directly, so its pieces are imported. --no-draft keeps
// draftEvents from contacting the assist server; nothing in this file touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.argv.push('--no-draft');
const { classify, draftEvents, sendStage, detectReferral, referralFrom, PROMISE_RE, STATUS_CLAIM_RE, resumeCompanies, pastEmployerIn, noEmployerInstruction, stillStuck } = await import('../deploy/unipile-poll.mjs');
const { applicationStatusFor, statusInstruction } = await import('../deploy/job-facts.mjs');
const { pickReferralHit } = await import('../deploy/linkedin-send.mjs');

const isCloser = (t) => classify([{ from: 'me', text: 'hi' }, { from: 'them', text: t }], { known: true }) === 'closer';

test('an ask ending in "best of luck" is not a closer', () => {
  assert.equal(isCloser('Hi, <YOUR_NAME>! Please search for suitable roles on the Jabil careers website, apply directly from there and send me the job number. Best of luck!'), false);
  assert.equal(isCloser('Not at this time, but I will let you know if anything comes up. Best of luck!'), true);
  assert.equal(isCloser('Position has been filled, all the best.'), true);
});

test('drafts that promise a future action are held', () => {
  for (const t of [
    "Thanks, Rita. I'll review the attachment and send my responses shortly.",
    'Thanks for flagging this. I’ll email the requested screenshot shortly.',
    'Of course. I will follow up by email once done.',
    "Thanks <CONTACT_NAME>, I'll apply and send you the job numbers.",
  ]) assert.ok(PROMISE_RE.test(t), t);
  for (const t of [
    'The req# is 182066: https://example.com/job_182066',
    'Thanks <CONTACT_NAME>, appreciated. Please do keep me in mind if anything opens up on the AI/ML side.',
    "I'm authorized to work through <WORK_AUTH_DATE> and do not need sponsorship.",
  ]) assert.ok(!PROMISE_RE.test(t), t);
});

// ── <TARGET_COMPANY>, 2026-10-07 — chat <CHAT_ID>, verbatim ───────────────────────────────
const NOTE = 'Hi Kat — I just applied for Data Scientist ll - RiskOS at <TARGET_COMPANY>. I bring ML + experimentation depth, including causal/A-B testing and production forecasting projects. I’d appreciate connecting if this background could fit your team.';
const KAT_1 = 'Heya! If you are fully eligible to work in the US without needing sponsorship now or in the future, it could be a fit! Try <CONTACT_NAME>, he leads the tech recruiting team.';
const KAT_2 = "I'm not privvy to our sponsorship policies on the tech side I'm afraid. I'd recommend applying directly.";
const SENT_1911 = "Thanks Kat, that's helpful. I'll keep my application as submitted and reach out to Josh directly, mentioning you pointed me his way. If I should leave him out of it, tell me and I won't. I appreciate you answering plainly.";

test('<TARGET_COMPANY>: "Try <CONTACT_NAME>, he leads…" is a referral, and its sponsorship condition is flagged', () => {
  assert.equal(detectReferral(KAT_1), '<CONTACT_NAME>');
  const ref = referralFrom([{ from: 'me', text: NOTE }, { from: 'them', text: KAT_1 }]);
  assert.equal(ref.person, '<CONTACT_NAME>');
  assert.match(ref.condition, /without needing sponsorship now or in the future/);
  assert.equal(detectReferral(KAT_2), null);
});

test('<TARGET_COMPANY>: a conditional referral raises needs_you and never reaches the invite step', async () => {
  const e = { kind: 'replied', status: 'new', cls: 'convo', company: '<TARGET_COMPANY>', name: '<CONTACT_NAME>',
    provider_id: '<LINKEDIN_PROVIDER_ID>', chat_id: '<CHAT_ID>',
    occurred_at: '2026-10-07T14:18:52.096Z', thread: [{ from: 'me', text: NOTE }, { from: 'them', text: KAT_1 }] };
  await draftEvents([e]);
  assert.equal(e.cls, 'referral');
  assert.equal(e.status, 'needs_you');
  assert.equal(e.draft, undefined);
  assert.match(e.needs_you, /conditional.*H-1B/s);
  const state = {};
  await sendStage({}, [e], state);
  assert.equal(e.send, undefined);            // skipped before any invite or message
  assert.equal(e.referral.invite, undefined);
  assert.equal(state.sends.invites, 0);
});

test('<TARGET_COMPANY>: the 19:11 reply would now be held twice over (promise + false status)', () => {
  assert.match(SENT_1911.match(PROMISE_RE)[0], /keep my application as submitted and reach out/);
  assert.ok(STATUS_CLAIM_RE.test(SENT_1911));
  for (const t of ['My application is still under review.', 'Happy to keep my application active.'])
    assert.ok(STATUS_CLAIM_RE.test(t), t);
  for (const t of ['I applied for Data Scientist II - RiskOS on 2026-09-18.', "I'd recommend applying directly."])
    assert.ok(!STATUS_CLAIM_RE.test(t), t);
});

test('<TARGET_COMPANY>: status facts come from records, so the rejection blocks any "still under review" claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'co-status-'));
  try {
    mkdirSync(join(root, 'data')); mkdirSync(join(root, 'agency-applications', '_raw'), { recursive: true });
    writeFileSync(join(root, 'data', 'tsenta-apps.json'), JSON.stringify({ apps: [
      { company: '<TARGET_COMPANY>', title: 'Data Scientist ll - RiskOS', status: 'COMPLETED', appliedAt: '2026-09-18T03:04:38.955Z' },
      { company: '<TARGET_COMPANY>', title: 'Data Scientist II, Client Analysis', status: 'COMPLETED', appliedAt: '2026-09-17T03:06:18.099Z' }] }));
    writeFileSync(join(root, 'agency-applications', '_raw', 'Rejections.json'), JSON.stringify({ threads: [
      { date: '2026-09-18 18:30', from: '<TARGET_COMPANY> Talent Acquisition Team <no-reply@example-company.com>', subject: 'An Update On Your Application from <TARGET_COMPANY>' }] }));
    const s = applicationStatusFor({ root, company: '<TARGET_COMPANY>' });
    assert.equal(s.verdict, 'rejected');
    assert.equal(s.last_rejected, '2026-09-18');
    const block = statusInstruction(s);
    assert.match(block, /Do NOT say or imply that any application there is submitted.*still under review/);
    assert.match(block, /An Update On Your Application from <TARGET_COMPANY>/);
    // no record at all: the block still forbids status claims
    assert.match(statusInstruction(applicationStatusFor({ root, company: 'Nowhere' }), 'Nowhere'), /nothing verified.*Do not mention application status/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('<TARGET_COMPANY>: a unique exact-name hit with no employer in the headline is surfaced, not invited', () => {
  const josh = { id: '<LINKEDIN_PROVIDER_ID>', name: '<CONTACT_NAME>', headline: 'Technology Recruiting Expert',
    url: 'https://www.linkedin.com/in/<PROFILE_SLUG>', location: 'Austin', employer_from_headline: null, past_association: false };
  const r = pickReferralHit([josh], '<CONTACT_NAME>', '<TARGET_COMPANY>');
  assert.equal(r.hit, undefined);
  assert.equal(r.unverified.url, 'https://www.linkedin.com/in/<PROFILE_SLUG>');
  // two exact-name strangers: neither is singled out
  assert.equal(pickReferralHit([josh, { ...josh, id: 'x' }], '<CONTACT_NAME>', '<TARGET_COMPANY>').unverified, null);
});

test('hand-off phrasing stays conservative: a capitalised two-part name is still required', () => {
  for (const [t, want] of [
    ['Talk to <CONTACT_NAME> on our team.', '<CONTACT_NAME>'],
    ['Ping Dana Whitfield, she runs ML hiring.', 'Dana Whitfield'],
    ['The best person is <CONTACT_NAME>.', '<CONTACT_NAME>'],
    ["I'd recommend reaching out to <CONTACT_NAME>.", '<CONTACT_NAME>'],
    ['Try applying through our careers page.', null],
    ['Try again next quarter, we may have openings.', null],
  ]) assert.equal(detectReferral(t), want, t);
});

// ── 2026-10-08: no company names from the resume in LinkedIn messages ─────────────────────────
test('past employers come from the CV Experience headings', () => {
  const root = mkdtempSync(join(tmpdir(), 'co-cv-'));
  try {
    writeFileSync(join(root, 'cv-aiml.md'), '# X\n## Experience\n### AI/ML Engineer | <CURRENT_EMPLOYER> | Richmond, VA\n- built\n### Machine Learning Scientist | <PAST_EMPLOYER> | India\n## Projects\n### Traffic | PyTorch, LSTM\n');
    assert.deepEqual(resumeCompanies(root), ['<CURRENT_EMPLOYER>', '<PAST_EMPLOYER>']);   // project headings are not employers
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('drafts that named a past employer are caught (three that were actually sent)', () => {
  const L = ['<CURRENT_EMPLOYER>', '<PAST_EMPLOYER>'];
  for (const t of [
    'Thanks for connecting, Michael. At <CURRENT_EMPLOYER>, I build multimodal models for edge devices and orchestrate production MLOps pipelines on AWS and Kubernetes',
    'Thanks for connecting, <CONTACT_NAME>. On the San Jose MLE role: my <PAST_EMPLOYER> work designed <YOUR_PROJECT_DESCRIPTION>',
    'Roy, thanks for connecting. On the Perception Software Engineer, Autonomous Driving role, my <CURRENT_EMPLOYER> work lines up directly',
  ]) assert.ok(pastEmployerIn(t, 'PayPal', L), t);
  assert.equal(pastEmployerIn('In my AI/ML Engineer role I built multimodal models for edge devices.', 'PayPal', L), null);
  assert.equal(pastEmployerIn('As a Machine Learning Scientist I designed a recommendation engine.', 'Lucid Motors', L), null);
});

test('the recipient\'s own company may be named, and the drafter is told the rule', () => {
  const L = ['<CURRENT_EMPLOYER>', '<PAST_EMPLOYER>'];
  assert.equal(pastEmployerIn('Great to hear from someone at <CURRENT_EMPLOYER>.', '<CURRENT_EMPLOYER>', L), null);
  assert.equal(pastEmployerIn('Great to hear from someone at <CURRENT_EMPLOYER>. At <PAST_EMPLOYER> I built…', '<CURRENT_EMPLOYER> Aerospace', L), '<PAST_EMPLOYER>');   // their company is fine, the other employer is not
  assert.equal(pastEmployerIn('My <CURRENT_EMPLOYER> work lines up.', '<CURRENT_EMPLOYER> Aerospace', L), null);
  assert.match(noEmployerInstruction('PayPal', L), /NEVER name a company.*<CURRENT_EMPLOYER>, <PAST_EMPLOYER>/s);
  assert.doesNotMatch(noEmployerInstruction('<CURRENT_EMPLOYER>', L), /<CURRENT_EMPLOYER>,/);
});

// ── 2026-10-13: a stuck acceptance was re-announced to Telegram on every run ───────────────────
test('a stuck item is announced once, not every run', () => {
  const stuck = { kind: 'accepted', status: 'new', draft: { error: 'no context: not in the ledger' } };
  assert.equal(stillStuck(stuck), true);                                              // first time: announce
  assert.equal(stillStuck({ ...stuck, notified_error: 'no context: not in the ledger' }), false);   // same blocker: quiet
  assert.equal(stillStuck({ ...stuck, notified_error: 'assist server not reachable' }), true);      // new blocker: announce
  assert.equal(stillStuck({ kind: 'accepted', status: 'new', draft: { text: 'hi there' } }), false); // nothing wrong: nothing to say
  assert.equal(stillStuck({ kind: 'accepted', status: 'new' }), false);
});
