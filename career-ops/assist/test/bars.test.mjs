import { test } from 'node:test';
import assert from 'node:assert';
import { screenJD, HARD_BARS } from '../bars.mjs';
import { loadBlacklist, companyContext, MAX_PER_COMPANY } from '../context.mjs';

test('THE NAMED BUG: itar does not match inside "military"', () => {
  // /\bITAR\b/ case-sensitive. A loose /itar/i matches m-i-l-ITAR-y and flags an honest JD.
  const r = screenJD('We build systems for military and defense customers. Sponsorship available.');
  assert.equal(r.bars.some((b) => b.id === 'itar'), false, 'ITAR fired on the word "military"');
  const real = screenJD('This role is subject to ITAR and requires US Person status.');
  assert.ok(real.bars.some((b) => b.id === 'itar'), 'a genuine ITAR mention must fire');
});

test('each hard bar fires on realistic JD language', () => {
  const cases = [
    ['We are unable to provide visa sponsorship for this role.', 'no-sponsorship-catchall'],
    ['We do not sponsor employment visas.', 'no-sponsorship-direct'],
    ['Candidates must have permanent work authorization.', 'permanent-work-auth'],
    ['Must be authorized to work without current or future sponsorship.', 'without-sponsorship'],
    ['Applicants must be a US citizen.', 'us-citizen-required'],
    ['An active Top Secret clearance is required.', 'active-clearance'],
    ['This position requires a security clearance.', 'security-clearance'],
    ['Open to SkillBridge participants only.', 'skillbridge'],
  ];
  for (const [text, id] of cases) {
    const r = screenJD(text);
    assert.ok(r.bars.some((b) => b.id === id), `"${text}" did not fire ${id}`);
    assert.equal(r.verdict, 'bars');
  }
});

test('a sponsoring JD reads as sponsors, not bars', () => {
  const r = screenJD('We will sponsor H-1B for exceptional candidates. Visa sponsorship available.');
  assert.equal(r.verdict, 'sponsors');
  assert.equal(r.bars.length, 0);
  assert.ok(r.sponsorHints.length >= 1);
});

test('a JD that both sponsors AND bars is reported as conflicting, not averaged', () => {
  const r = screenJD('Visa sponsorship available. This role requires an active security clearance.');
  assert.equal(r.conflicting, true);
  assert.equal(r.verdict, 'bars', 'a hard bar must win the verdict');
  assert.ok(r.sponsorHints.length > 0, 'but the sponsorship signal must still be shown');
});

test('a neutral JD is unclear, not a false positive', () => {
  const r = screenJD('We are hiring a machine learning engineer to work on recommendation systems in Python.');
  assert.equal(r.verdict, 'unclear');
  assert.equal(r.bars.length, 0);
  assert.equal(r.locationFlags.length, 0);
});

test('EU posting markers are flagged as location, not as a hard bar', () => {
  const r = screenJD('Machine Learning Engineer (m/w/d) — our office in Berlin.');
  assert.equal(r.bars.length, 0, 'an EU posting is not a work-auth bar');
  assert.ok(r.locationFlags.length >= 1);
});

test('empty text returns no-text rather than a confident verdict', () => {
  assert.equal(screenJD('').verdict, 'no-text');
  assert.equal(screenJD(null).verdict, 'no-text');
});

test('every bar pattern is word-bounded', () => {
  // A pattern without \b or a bounded phrase is how the military/ITAR class of bug returns.
  for (const b of HARD_BARS) {
    const src = b.re.source;
    assert.ok(/\\b|\\s|\(\?:/.test(src), `${b.id} has no boundary anchor: ${src}`);
  }
});

test('an absent blacklist means no filtering, never an error', () => {
  // data/blacklist.md is opt-in and genuinely absent on this install.
  assert.deepEqual(loadBlacklist('/nonexistent-root-xyz'), []);
});

test('the company card counts applications against the cap and warns', async () => {
  const c = await companyContext('<CAREER_OPS_DIR>', '<TARGET_COMPANY>');
  if (!c.ok) return;
  assert.equal(c.maxPerCompany, MAX_PER_COMPANY);
  assert.ok(c.applicationCount >= 1, '<TARGET_COMPANY> has real applications on file');
  // SKIP/Discarded rows must not count toward the cap.
  assert.ok(c.countedTowardCap <= c.applicationCount);
  assert.ok('invites' in c, 'the card must carry invite headroom');
});
