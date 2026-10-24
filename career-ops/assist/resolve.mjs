// resolve.mjs — turn a loose application reference into a specific, confirmed application.
//
// Spec §1: "Number resolution is ambiguous and must be handled explicitly. Report file numbers
// are not tracker row numbers. Resolve in this order: exact reports/{n}-*.md → tracker row →
// company-name match. When more than one candidate matches, return the candidates and ask,
// rather than guessing."
//
// THAT AMBIGUITY IS REAL, NOT THEORETICAL. Measured 2026-08-23 on this repo: report numbers
// 1000, 1001 and 1008 each name TWO different reports (e.g. 1000 is both <TARGET_COMPANY>-2026-08-03
// and <TARGET_COMPANY>-2026-07-15), while tracker row 1000 is <TARGET_COMPANY> alone. Silently picking one would
// ground an application answer in the wrong company's JD — the worst failure this tool can
// have, because the output looks completely plausible.
//
// Read-only: this module opens no file for writing.
import fs from 'node:fs';
import path from 'node:path';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';

const REPORT_RE = /^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slugToName = (slug) => slug.replace(/-/g, ' ').trim();

/** All evaluation reports on disk, parsed from their filenames. */
export function listReports(root) {
  const dir = path.join(root, 'reports');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = REPORT_RE.exec(f);
    if (!m) continue;
    out.push({ num: Number(m[1]), slug: m[2], date: m[3], file: path.join('reports', f), basename: f });
  }
  return out.sort((a, b) => b.num - a.num || b.date.localeCompare(a.date));
}

/** Tracker rows, via the canonical parser so this never drifts from the rest of career-ops. */
export function listTrackerRows(root) {
  const file = path.join(root, 'data', 'applications.md');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    try {
      const r = parseTrackerRow(line, colmap);
      if (r && r.num != null) rows.push(r);
    } catch { /* a malformed row must not hide the other 438 */ }
  }
  return rows;
}

/** Pull the fields the panel shows and the model needs, without loading the whole report. */
export function readReportMeta(root, relFile) {
  const abs = path.join(root, relFile);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const field = (name) => {
    const m = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'im').exec(text);
    return m ? m[1].trim() : null;
  };
  const title = /^#\s*(.+)$/m.exec(text)?.[1]?.trim() || null;
  return {
    file: relFile,
    title,
    score: field('Score'),
    url: field('URL'),
    legitimacy: field('Legitimacy'),
    applied: field('Applied'),
    ats: field('ATS'),
    location: field('Location'),
    bytes: text.length,
  };
}

const candidateFromReport = (root, r) => ({
  kind: 'report',
  num: r.num,
  company: slugToName(r.slug),
  date: r.date,
  file: r.file,
  meta: readReportMeta(root, r.file),
});

const candidateFromRow = (row) => ({
  kind: 'tracker',
  num: row.num,
  company: row.company ?? null,
  role: row.role ?? null,
  date: row.date ?? null,
  score: row.score ?? null,
  status: row.status ?? null,
  file: null,
});

/**
 * Resolve a reference to one application, or to a list of candidates when it is ambiguous.
 *
 * Returns { status: 'resolved' | 'ambiguous' | 'not_found', ... }. It NEVER returns a single
 * result it had to guess at — an ambiguous ref is a question for the user, not a coin flip.
 */
export function resolveApplication(root, rawRef) {
  const ref = String(rawRef ?? '').trim();
  if (!ref) return { status: 'not_found', ref, reason: 'empty reference' };

  const reports = listReports(root);
  const rows = listTrackerRows(root);

  // --- 1. a URL, which is the least ambiguous thing a user can paste ---
  if (/^https?:\/\//i.test(ref)) {
    const hits = reports
      .map((r) => ({ r, meta: readReportMeta(root, r.file) }))
      .filter(({ meta }) => meta?.url && (meta.url === ref || meta.url.startsWith(ref) || ref.startsWith(meta.url)));
    if (hits.length === 1) return { status: 'resolved', ref, matchedBy: 'url', application: candidateFromReport(root, hits[0].r) };
    if (hits.length > 1) {
      return { status: 'ambiguous', ref, matchedBy: 'url', candidates: hits.map(({ r }) => candidateFromReport(root, r)) };
    }
    return { status: 'not_found', ref, reason: 'no report carries that URL' };
  }

  // --- 2. a number: "#1230", "1230" ---
  const numMatch = /^#?(\d{1,6})$/.exec(ref);
  if (numMatch) {
    const n = Number(numMatch[1]);
    const reportHits = reports.filter((r) => r.num === n);
    const rowHits = rows.filter((r) => Number(r.num) === n);

    // Spec order: report files first. Several files can share a number, and when they do the
    // tracker row only accounts for one of them — so this is a question, never a default.
    if (reportHits.length === 1 && rowHits.length <= 1) {
      const application = candidateFromReport(root, reportHits[0]);
      const row = rowHits[0];
      // Only attach the tracker row when it plausibly describes the same application.
      if (row && norm(row.company) && norm(application.company).includes(norm(row.company).split(' ')[0])) {
        application.tracker = candidateFromRow(row);
      } else if (row) {
        application.trackerMismatch = candidateFromRow(row);
      }
      return { status: 'resolved', ref, matchedBy: 'report-number', application };
    }
    if (reportHits.length > 1) {
      return {
        status: 'ambiguous', ref, matchedBy: 'report-number',
        reason: `report number ${n} names ${reportHits.length} different reports`,
        candidates: reportHits.map((r) => candidateFromReport(root, r)),
      };
    }
    if (rowHits.length === 1) return { status: 'resolved', ref, matchedBy: 'tracker-row', application: candidateFromRow(rowHits[0]) };
    if (rowHits.length > 1) return { status: 'ambiguous', ref, matchedBy: 'tracker-row', candidates: rowHits.map(candidateFromRow) };
    return { status: 'not_found', ref, reason: `no report or tracker row numbered ${n}` };
  }

  // --- 3. a company name ---
  const q = norm(ref);
  if (!q) return { status: 'not_found', ref, reason: 'reference normalized to nothing' };

  const byReport = reports.filter((r) => norm(slugToName(r.slug)).includes(q));
  const byRow = rows.filter((r) => norm(r.company).includes(q));

  const merged = [];
  const seen = new Set();
  for (const r of byReport) {
    merged.push(candidateFromReport(root, r));
    seen.add(`${r.num}`);
  }
  // A tracker row with no report of its own is still a real application worth offering.
  for (const row of byRow) if (!seen.has(`${row.num}`)) merged.push(candidateFromRow(row));

  if (merged.length === 1) return { status: 'resolved', ref, matchedBy: 'company', application: merged[0] };
  if (merged.length > 1) {
    return {
      status: 'ambiguous', ref, matchedBy: 'company',
      reason: `"${ref}" matches ${merged.length} applications`,
      candidates: merged.slice(0, 25),
      truncated: merged.length > 25 ? merged.length - 25 : 0,
    };
  }
  return { status: 'not_found', ref, reason: `nothing matches "${ref}"` };
}

/** Full JD/report text — loaded only after the user confirms the match. */
export function loadReportText(root, relFile) {
  if (!relFile || !/^reports\/[A-Za-z0-9._-]+\.md$/.test(relFile)) return null;
  const abs = path.join(root, relFile);
  // Defence in depth against a traversal-shaped ref reaching the filesystem.
  if (!abs.startsWith(path.join(root, 'reports') + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/** HTTP handler for GET /api/assist/application/:ref */
export function handler(ctx) {
  const result = resolveApplication(ctx.root, ctx.ref);
  const code = result.status === 'resolved' ? 200 : result.status === 'ambiguous' ? 300 : 404;
  return ctx.json(code, { ok: result.status === 'resolved', ...result });
}
