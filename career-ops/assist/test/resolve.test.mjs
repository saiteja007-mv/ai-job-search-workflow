import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveApplication, listReports, listTrackerRows, readReportMeta, loadReportText } from '../resolve.mjs';

// A fixture repo shaped like the real one, including the collision that actually exists on
// disk (#1000 = two different reports, tracker row 1000 = only one of them).
const root = path.join(os.tmpdir(), `assist-resolve-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const report = (name, body) => fs.writeFileSync(path.join(root, 'reports', name), body);
report('1000-<TARGET_COMPANY>-2026-08-03.md', `# 1000 — <TARGET_COMPANY> — ML Engineer\n\n**Score:** 4.2/5\n**URL:** https://jobs.example.com/<TARGET_COMPANY>/1\n\n## A. Role\nExample role text.\n`);
report('1000-<TARGET_COMPANY>-2026-07-15.md', `# 1000 — <TARGET_COMPANY> — Data Scientist\n\n**Score:** 3.9/5\n**URL:** https://jobs.example.com/<TARGET_COMPANY>/9\n\n## A. Role\nShipt role text.\n`);
report('1228-<TARGET_COMPANY>-software-engineer-applied-ai-2026-08-22.md', `# 1228 — <TARGET_COMPANY> — Software Engineer, Applied AI\n\n**Score:** 4.2/5\n**URL:** https://job-boards.greenhouse.io/chaosindustries/jobs/5209420007\n**Legitimacy:** Tier 1\n**ATS:** greenhouse\n\n## A. Role\nApplied AI engineering.\n`);
report('1230-acme-corp-2026-08-20.md', `# 1230 — Acme Corp — MLE\n\n**Score:** 4.0/5\n**URL:** https://acme.example.com/jobs/77\n\n## A. Role\nAcme role.\n`);

fs.writeFileSync(path.join(root, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1000 | 2026-07-15 | <TARGET_COMPANY> | Data Scientist | 3.9/5 | Applied | ❌ | [1000](../reports/1000-<TARGET_COMPANY>-2026-07-15.md) | note |
| 1228 | 2026-08-22 | <TARGET_COMPANY> | Software Engineer, Applied AI | 4.2/5 | Applied | ❌ | [1228](../reports/1228-<TARGET_COMPANY>-software-engineer-applied-ai-2026-08-22.md) | note |
| 1230 | 2026-08-20 | Acme Corp | MLE | 4.0/5 | Evaluated | ❌ | [1230](../reports/1230-acme-corp-2026-08-20.md) | note |
| 1231 | 2026-08-21 | Acme Corp | Senior MLE | 4.1/5 | Applied | ❌ | [1231](../reports/1231-nonexistent.md) | second req at same company |
`);

test('the fixture parses: reports and tracker rows both load', () => {
  assert.equal(listReports(root).length, 4);
  const rows = listTrackerRows(root);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => Number(r.num) === 1228).company, '<TARGET_COMPANY>');
});

test('an unambiguous report number resolves and carries its metadata', () => {
  const r = resolveApplication(root, '#1228');
  assert.equal(r.status, 'resolved');
  assert.equal(r.matchedBy, 'report-number');
  assert.equal(r.application.num, 1228);
  assert.equal(r.application.meta.score, '4.2/5');
  assert.equal(r.application.meta.url, 'https://job-boards.greenhouse.io/chaosindustries/jobs/5209420007');
  assert.equal(resolveApplication(root, '1228').status, 'resolved', 'the # prefix is optional');
});

test('A COLLIDING REPORT NUMBER ASKS — it never picks one', () => {
  // This is the failure that would ground an answer in the wrong company's JD while looking
  // entirely plausible. #1000 is <TARGET_COMPANY> AND <TARGET_COMPANY> on disk.
  const r = resolveApplication(root, '#1000');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  const companies = r.candidates.map((c) => c.company).sort();
  assert.deepEqual(companies, ['<TARGET_COMPANY>', '<TARGET_COMPANY>']);
  assert.match(r.reason, /names 2 different reports/);
  assert.equal(r.application, undefined, 'an ambiguous result must not carry a chosen application');
});

test('a company matching several applications asks rather than taking the newest', () => {
  const r = resolveApplication(root, 'Acme Corp');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.matchedBy, 'company');
  // 1230 has a report; 1231 is tracker-only but is still a real application worth offering.
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.some((c) => c.num === 1231 && c.kind === 'tracker'));
});

test('company match is case- and punctuation-insensitive', () => {
  for (const q of ['chaos industries', 'CHAOS INDUSTRIES', '<TARGET_COMPANY>', 'Chaos  Industries']) {
    const r = resolveApplication(root, q);
    assert.equal(r.status, 'resolved', `"${q}" failed to resolve`);
    assert.equal(r.application.num, 1228);
  }
});

test('a URL resolves to exactly one application', () => {
  const r = resolveApplication(root, 'https://job-boards.greenhouse.io/chaosindustries/jobs/5209420007');
  assert.equal(r.status, 'resolved');
  assert.equal(r.matchedBy, 'url');
  assert.equal(r.application.num, 1228);
});

test('a miss says so instead of resolving to something contextless', () => {
  for (const q of ['#9999', 'Nonexistent Company', 'https://nope.example.com/x', '']) {
    const r = resolveApplication(root, q);
    assert.equal(r.status, 'not_found', `"${q}" should not resolve`);
    assert.ok(r.reason, 'a miss must explain itself');
  }
});

test('a tracker row without a report file still resolves', () => {
  const r = resolveApplication(root, '#1231');
  assert.equal(r.status, 'resolved');
  assert.equal(r.matchedBy, 'tracker-row');
  assert.equal(r.application.kind, 'tracker');
  assert.equal(r.application.company, 'Acme Corp');
});

test('a tracker row describing a different company is flagged, not silently merged', () => {
  // Report 1230 is Acme Corp and tracker row 1230 is Acme Corp — these agree, so they attach.
  const ok = resolveApplication(root, '#1230');
  assert.equal(ok.status, 'resolved');
  assert.ok(ok.application.tracker, 'a matching tracker row should attach');
  assert.equal(ok.application.trackerMismatch, undefined);
});

test('loadReportText refuses path traversal and non-report paths', () => {
  assert.ok(loadReportText(root, 'reports/1228-<TARGET_COMPANY>-software-engineer-applied-ai-2026-08-22.md').includes('Applied AI'));
  for (const bad of ['reports/../../../etc/passwd', '../cv.md', '/etc/passwd', 'data/applications.md', 'reports/sub/dir.md', null]) {
    assert.equal(loadReportText(root, bad), null, `traversal not blocked: ${bad}`);
  }
});

test('readReportMeta returns null for a missing file rather than throwing', () => {
  assert.equal(readReportMeta(root, 'reports/does-not-exist.md'), null);
});
