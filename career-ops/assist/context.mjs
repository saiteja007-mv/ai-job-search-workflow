// context.mjs — the company card. Spec §10: tracker status, blacklist, duplicate guard,
// invite budget. All read-only, all pure lookup, no model call.
import { unipileConfig, unipileGet } from './people.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { listTrackerRows, listReports } from './resolve.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Spec §10 and the tracker rules: at most 2 applications per company.
export const MAX_PER_COMPANY = 2;

/** data/blacklist.md is opt-in and absent by default — absence means no filtering, never an error. */
export function loadBlacklist(root) {
  const f = path.join(root, 'data', 'blacklist.md');
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
  return text.split('\n')
    .map((l) => l.replace(/^[-*|\s]+/, '').split('|')[0].trim())
    .filter((l) => l && !l.startsWith('#') && !/^-+$/.test(l));
}

/**
 * Invite headroom. Reuses lib/invite-ledger.mjs, which DOES export a clean API — unlike
 * scan-filter.mjs and openrouter-runner.mjs, so this one is a real import.
 */
// LinkedIn's own record of sent invitations, counted for today and the trailing 7 days.
// The ledger only sees sends that were logged locally; on 2026-09-01 it read 36 (a parsing
// bug, since fixed) and then 121, while LinkedIn reported 148 — the remainder is clients that
// log nowhere. For a number that decides whether the account is about to be restricted, the
// conservative source wins. Bounded (max 12 pages) and time-limited; failure degrades to the
// ledger and says so rather than throwing.
async function linkedinSentCounts(root, { maxPages = 12 } = {}) {
  const cfg = unipileConfig(root);
  if (!cfg) return null;
  const today = new Date().toISOString().slice(0, 10);
  const dayMs = Date.parse(today + 'T00:00:00Z');
  let cursor; let sentToday = 0; let trailing7 = 0; let total = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await unipileGet(cfg, '/users/invite/sent', { account_id: cfg.account, limit: 100, cursor });
    const items = page?.items || [];
    for (const it of items) {
      total++;
      const d = String(it.parsed_datetime || '').slice(0, 10);
      if (!d) continue;
      const t = Date.parse(d + 'T00:00:00Z');
      if (d === today) sentToday++;
      if (t <= dayMs && dayMs - t < 7 * 86400000) trailing7++;
    }
    cursor = page?.cursor;
    if (!cursor || !items.length) break;
    // No early exit on "this page looks old": ordering is not strictly by parsed_datetime
    // across page boundaries, and stopping early undercounted by 7 on 2026-09-01 (141 vs 148).
    // 12 pages of 100 covers the ~800 invitations this account holds in about a second.
  }
  return { sentToday, trailing7, total };
}

export async function inviteBudget(root) {
  let s = null;
  let ledgerError = null;
  try {
    const m = await import(path.join(root, 'lib', 'invite-ledger.mjs'));
    s = m.summarize(root);
  } catch (e) {
    ledgerError = String(e.message || e).slice(0, 140);
  }
  let li = null; let linkedinError = null;
  try { li = await linkedinSentCounts(root); } catch (e) { linkedinError = String(e.message || e).slice(0, 140); }
  if (!s && !li) return { available: false, reason: ledgerError || linkedinError || 'no source' };

  const safeWeekly = s?.safeWeekly ?? 80, safeDaily = s?.safeDaily ?? 20, observedBlock = s?.observedBlock ?? 112;
  const sentToday = Math.max(s?.sentToday ?? 0, li?.sentToday ?? 0);
  const trailing7 = Math.max(s?.trailing7 ?? 0, li?.trailing7 ?? 0);
  const status = trailing7 >= observedBlock ? 'BLOCKED' : trailing7 >= safeWeekly ? 'OVER BUDGET' : trailing7 >= safeWeekly * 0.75 ? 'WARNING' : 'OK';
  return {
    available: true,
    trailing7, sentToday, status, safeWeekly, safeDaily, observedBlock,
    remainingThisWeek: Math.max(0, safeWeekly - trailing7),
    remainingToday: Math.max(0, Math.min(safeDaily - sentToday, safeWeekly - trailing7)),
    lastSend: s?.lastSend ?? null,
    sources: {
      ledger: s ? { sentToday: s.sentToday, trailing7: s.trailing7 } : null,
      linkedin: li,
    },
    ...(ledgerError ? { ledger_warning: ledgerError } : {}),
    ...(linkedinError ? { linkedin_warning: `LinkedIn count unavailable (${linkedinError}); ledger-only figures may undercount` } : {}),
  };
}

/**
 * Everything known about a company, for the card shown on a LinkedIn page.
 * Spec §10: "have I applied, when, what status, what score, is it on the blacklist, is this a
 * repost" plus the duplicate-application guard.
 */
export async function companyContext(root, companyRaw) {
  const company = String(companyRaw ?? '').trim();
  if (!company) return { ok: false, error: 'company is required' };
  const q = norm(company);

  const rows = listTrackerRows(root).filter((r) => norm(r.company).includes(q) || q.includes(norm(r.company)));
  const reports = listReports(root).filter((r) => norm(r.slug.replace(/-/g, ' ')).includes(q));

  const applications = rows.map((r) => ({
    num: r.num, company: r.company, role: r.role, date: r.date, score: r.score, status: r.status,
  })).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const blacklist = loadBlacklist(root);
  const blacklisted = blacklist.find((b) => norm(b) && (norm(b).includes(q) || q.includes(norm(b)))) || null;

  // Applied-or-beyond states count against the cap; SKIP and Discarded do not.
  const counted = applications.filter((a) => !/^(skip|discarded)$/i.test(String(a.status || '')));
  const atCap = counted.length >= MAX_PER_COMPANY;

  return {
    ok: true,
    company,
    applications,
    applicationCount: applications.length,
    countedTowardCap: counted.length,
    maxPerCompany: MAX_PER_COMPANY,
    duplicateWarning: atCap
      ? `Already ${counted.length} active application(s) at ${company}; the cap is ${MAX_PER_COMPANY}.`
      : null,
    // A company appearing repeatedly in reports without a tracker row is the repost signal.
    reportCount: reports.length,
    blacklisted: Boolean(blacklisted),
    blacklistEntry: blacklisted,
    invites: await inviteBudget(root),
  };
}

/** HTTP handler for GET /api/assist/context?company=... */
export async function handler(ctx) {
  const company = ctx.url.searchParams.get('company');
  if (!company) {
    // With no company, still return the invite budget — it is useful on its own before any send.
    return ctx.json(200, { ok: true, company: null, invites: await inviteBudget(ctx.root) });
  }
  return ctx.json(200, await companyContext(ctx.root, company));
}
