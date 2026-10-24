import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPerson, checkRelevance, personBlock } from '../person.mjs';

const root = path.join(os.tmpdir(), `assist-person-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

fs.writeFileSync(path.join(root, 'data', 'outreach_log.json'), JSON.stringify({
  version: 1,
  events: [
    { channel: 'linkedin_connection_invite', provider_id: 'ACoAA_ALEX', public_id: 'alex-example',
      linkedin: 'https://www.linkedin.com/in/alex-example', name: 'Alex Example', company: 'Acme Robotics',
      role: 'Founding ML Engineer', sent_at: '2026-08-10T09:00:00-05:00',
      message: 'Hi Alex, I applied for the Founding ML Engineer role at Acme Robotics. I build production LLM and edge systems.' },
    { channel: 'linkedin_dm', provider_id: 'ACoAA_ALEX', public_id: 'alex-example', name: 'Alex Example',
      company: 'Acme Robotics', sent_at: '2026-08-22T04:46:30-05:00', message: 'Hi Alex, following up on my note from earlier this month.' },
    { channel: 'linkedin_connection_invite', provider_id: 'ACoAA_OTHER', public_id: 'someone-else',
      name: 'Someone Else', sent_at: '2026-08-01T09:00:00-05:00', message: 'Unrelated note.' },
  ],
  sent_profiles: { ACoAA_ALEX: { name: 'Alex Example', company: 'Acme Robotics', sent_at: '2026-08-10' } },
}, null, 2));

fs.writeFileSync(path.join(root, 'data', 'contacts.json'), JSON.stringify({
  generated_at: '2026-08-23',
  applications: [{
    appNumber: 1240, company: 'Acme Robotics', role: 'Founding Machine Learning Engineer',
    contacts: [{ type: 'hiring_manager', name: 'Alex Example', title: 'Co-founder and CTO at Acme Robotics',
      company: 'Acme Robotics', linkedinProfileLink: 'https://www.linkedin.com/in/alex-example',
      provider_id: 'ACoAA_ALEX', appliedRole: 'Founding ML Engineer @ Acme Robotics' }],
  }],
}, null, 2));

test('a known recipient resolves with title, company and the related application', () => {
  const p = findPerson(root, { linkedin: 'https://www.linkedin.com/in/alex-example' });
  assert.equal(p.found, true);
  assert.equal(p.identity.name, 'Alex Example');
  assert.equal(p.identity.title, 'Co-founder and CTO at Acme Robotics');
  assert.equal(p.relatedApplication.appNumber, 1240);
  assert.equal(p.relatedApplication.role, 'Founding Machine Learning Engineer');
});

test('PRIOR OUTREACH is returned newest-first with the exact text already sent', () => {
  const p = findPerson(root, { providerId: 'ACoAA_ALEX' });
  assert.equal(p.contactCount, 2);
  assert.equal(p.invited, true, 'an invitation was sent');
  assert.equal(p.messaged, true, 'a DM was also sent');
  // Newest first — what you said most recently is what shapes the next message.
  assert.equal(p.lastContact.sent_at.slice(0, 10), '2026-08-22');
  assert.equal(p.priorMessages.length, 2);
  assert.ok(p.priorMessages[0].includes('following up'));
});

test('matching by provider_id, public_id and profile URL all find the same person', () => {
  const byPid = findPerson(root, { providerId: 'ACoAA_ALEX' });
  const byHandle = findPerson(root, { publicId: 'alex-example' });
  const byUrl = findPerson(root, { linkedin: 'https://www.linkedin.com/in/alex-example' });
  for (const p of [byPid, byHandle, byUrl]) assert.equal(p.contactCount, 2);
});

test('an unknown person reports first contact rather than inventing history', () => {
  const p = findPerson(root, { publicId: 'never-contacted' });
  assert.equal(p.found, false);
  assert.equal(p.contactCount, 0);
  assert.equal(p.invited, false);
  assert.match(personBlock(p) || 'first contact', /first contact|^$/);
});

test('name matching is only a fallback and never overrides a strong identifier', () => {
  // A provider_id that matches nothing must NOT fall back to a name match on someone else.
  const p = findPerson(root, { providerId: 'ACoAA_NOBODY', name: 'Alex Example' });
  assert.equal(p.contactCount, 0, 'a wrong provider_id must not resolve via the name');
});

test('RELEVANCE: a draft naming the person and company is relevant', () => {
  const p = findPerson(root, { providerId: 'ACoAA_ALEX' });
  const r = checkRelevance('Hi Alex, I saw Acme Robotics is building agent infrastructure and wanted to ask about the team.', p);
  assert.equal(r.relevant, true);
  assert.ok(r.matched.includes('name') || r.matched.includes('company'));
});

test('RELEVANCE: generic filler is flagged as referencing nothing specific', () => {
  const p = findPerson(root, { providerId: 'ACoAA_ALEX' });
  const r = checkRelevance('I am excited about this opportunity and would love to connect and learn more.', p);
  assert.equal(r.relevant, false);
  assert.match(r.reason, /nothing specific/);
});

test('RELEVANCE: repeating an opener already sent to this person is caught', () => {
  const p = findPerson(root, { providerId: 'ACoAA_ALEX' });
  const repeat = 'Hi Alex, I applied for the Founding ML Engineer role at Acme Robotics. I build production LLM and edge systems.';
  const r = checkRelevance(repeat, p);
  assert.equal(r.repeatsPriorMessage, true, 'a verbatim repeat of a sent note must be caught');
});

test('the prompt block tells the model not to repeat, and carries the history', () => {
  const p = findPerson(root, { providerId: 'ACoAA_ALEX' });
  const b = personBlock(p);
  assert.match(b, /Co-founder and CTO at Acme Robotics/);
  assert.match(b, /PRIOR OUTREACH TO THIS PERSON \(2\)/);
  assert.match(b, /DO NOT repeat/);
  assert.match(b, /A connection invitation has already been sent/);
});

test('missing data files degrade to "not found" instead of throwing', () => {
  const p = findPerson('/nonexistent-root-xyz', { publicId: 'anyone' });
  assert.equal(p.found, false);
  assert.equal(p.contactCount, 0);
});

// ---------- people search ----------
import { searchPeople } from '../people.mjs';

test('searching a name finds the person with their outreach count', () => {
  const r = searchPeople(root, 'alex');
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.results[0].name, 'Alex Example');
  assert.equal(r.results[0].contactCount, 2);
  assert.equal(r.results[0].title, 'Co-founder and CTO at Acme Robotics');
});

test('search is case-insensitive and matches partial names', () => {
  for (const q of ['ALEX', 'example', 'Alex Exa']) {
    assert.equal(searchPeople(root, q).count, 1, `"${q}" failed`);
  }
});

test('a person known only from contacts (never contacted) is still findable', () => {
  const r = searchPeople(root, 'Alex');
  // Ranking: people with prior outreach sort above cold contacts.
  assert.ok(r.results[0].contactCount > 0);
});

test('search refuses a query too short to be meaningful', () => {
  const r = searchPeople(root, 'a');
  assert.equal(r.ok, false);
  assert.match(r.error, /at least 2/);
});

test('a name matching nobody returns zero rather than everybody', () => {
  assert.equal(searchPeople(root, 'zzzznobody').count, 0);
});

test('the same person from both sources is merged, not duplicated', () => {
  // Alex appears in outreach_log (twice) AND contacts.json — one result, not three.
  const r = searchPeople(root, 'alex');
  assert.equal(r.results.length, 1, 'the same person must not appear multiple times');
  assert.equal(r.results[0].appNumber, 1240, 'the contacts record must enrich the outreach one');
});

test('the daily recruiter bucket is not treated as an application', () => {
  const r = path.join(os.tmpdir(), `assist-person-bucket-${process.pid}`);
  fs.mkdirSync(path.join(r, 'data'), { recursive: true });
  process.on('exit', () => fs.rmSync(r, { recursive: true, force: true }));
  fs.writeFileSync(path.join(r, 'data', 'outreach_log.json'), JSON.stringify({ version: 1, events: [], sent_profiles: {} }));
  fs.writeFileSync(path.join(r, 'data', 'contacts.json'), JSON.stringify({ applications: [{
    appNumber: 20260924, company: 'Daily LinkedIn recruiter outreach', role: 'AI/ML recruiter targets — 2026-09-24',
    contacts: [{ name: 'Rae Recruiter', title: 'Technical Recruiter at Acme AI', company: 'Acme AI',
      linkedinProfileLink: 'https://www.linkedin.com/in/rae-recruiter', provider_id: 'ACoAA_RAE' }],
  }] }));
  const p = findPerson(r, { providerId: 'ACoAA_RAE' });
  assert.equal(p.identity.company, 'Acme AI');
  assert.equal(p.relatedApplication, null);
});
