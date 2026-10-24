// node --test deploy/draft-managed.test.mjs   (needs deploy/node_modules; not part of test-all on purpose)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSlots, sameCompany, resumeFor, DEFAULT_WINDOWS } from './draft-managed.mjs';

const ct = (s) => new Intl.DateTimeFormat('en-US', { timeZone: '<YOUR_TZ>', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(s);

test("pickSlots: only inside <YOUR_NAME>'s windows (Mon-Wed 9-17, Thu 9-15), one per day, spread early/midday/late, skips busy", () => {
  const now = new Date('2026-10-16T15:00:00Z');                                  // Fri 10:00 CT
  const busy = [{ start: '2026-10-19T14:00:00Z', end: '2026-10-19T17:00:00Z' }]; // Mon 09:00-12:00 CT
  assert.deepEqual(pickSlots(busy, now, DEFAULT_WINDOWS).map(ct), ['Mon 12:00', 'Tue 12:30', 'Wed 15:00']);
});

test('pickSlots: never Friday or the weekend; Thursday ends by 15:00', () => {
  const thu = pickSlots([], new Date('2026-10-19T15:00:00Z'), { Thu: ['09:00-15:00'] }).map(ct);
  assert.ok(thu.length && thu.every((s) => s.startsWith('Thu') && s.slice(4) <= '14:30'), thu.join());
  assert.ok(pickSlots([], new Date('2026-10-16T15:00:00Z'), DEFAULT_WINDOWS).map(ct).every((s) => !/^(Fri|Sat|Sun)/.test(s)));
});

test('pickSlots: a fully busy calendar gives no slots', () => {
  const now = new Date('2026-10-16T15:00:00Z');
  assert.deepEqual(pickSlots([{ start: '2026-10-16T00:00:00Z', end: '2026-11-30T00:00:00Z' }], now), []);
});

test('pickSlots: DST change (Nov 1) keeps CT wall-clock hours', () => {
  const slots = pickSlots([], new Date('2026-10-30T15:00:00Z'), DEFAULT_WINDOWS).map(ct);   // Fri before the change
  assert.deepEqual(slots, ['Mon 09:00', 'Tue 12:30', 'Wed 15:00']);
});

test('sameCompany matches whole words only', () => {
  assert.equal(sameCompany('Trace', '<COMPANY_L> Labs'), true);
  assert.equal(sameCompany('Meta', 'Metadata Inc'), false);
  assert.equal(sameCompany('AI', 'AI Labs'), false);
});

test('resumeFor falls back to the general resume for an unknown company', () => {
  assert.equal(resumeFor('No Such Company Xyz')?.file, '<YOUR_NAME>-AI-ML-Engineer.pdf');
});

test('resumeFor never returns another company\'s PDF (report-number collision)', () => {
  const r = resumeFor('Google');
  assert.ok(r && /google/i.test(r.file) || r?.file === '<YOUR_NAME>-AI-ML-Engineer.pdf', r?.file);
});
