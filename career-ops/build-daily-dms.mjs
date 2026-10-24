#!/usr/bin/env node
/**
 * build-daily-dms.mjs
 *
 * Generates `data/daily-dms.md` — a copy-paste-ready batch of LinkedIn
 * outreach DMs for the highest-priority applied roles where the contact
 * outreach status is NOT yet "Sent".
 *
 * Reads:
 *   - data/applications.md       (which apps are status=Applied + their score)
 *   - data/contacts.json         (drafted Connect/InMail messages)
 *   - data/contact-status.json   (which app outreach has been sent)
 *
 * Writes:
 *   - data/daily-dms.md          (markdown with copy-paste blocks, top 10 priority)
 *
 * Usage:
 *   node build-daily-dms.mjs
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = __dirname;
const APPS      = join(ROOT, 'data', 'applications.md');
const CONTACTS  = join(ROOT, 'data', 'contacts.json');
const STATUS    = join(ROOT, 'data', 'contact-status.json');
const OUTPUT    = join(ROOT, 'data', 'daily-dms.md');
const TOP_N     = 10;

// ─── Parse applications.md → { number → {company, role, score, status, pdf} }
function parseApplications() {
  const txt = readFileSync(APPS, 'utf-8');
  const apps = {};
  for (const line of txt.split('\n')) {
    if (!line.startsWith('|') || !/^\|\s*\d/.test(line)) continue;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    if (!num) continue;
    const scoreMatch = (parts[5] || '').match(/(\d+\.\d+)/);
    apps[num] = {
      number:  num,
      date:    parts[2],
      company: parts[3],
      role:    parts[4],
      score:   scoreMatch ? parseFloat(scoreMatch[1]) : 0,
      status:  parts[6],
      pdf:     parts[7].includes('✅'),
    };
  }
  return apps;
}

// ─── Parse contact-status.json → set of app numbers already Sent
function loadSentSet() {
  if (!existsSync(STATUS)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(STATUS, 'utf-8'));
    return new Set(
      Object.entries(obj)
        .filter(([_, v]) => v === 'Sent' || v === 'Responded')
        .map(([k]) => parseInt(k, 10))
    );
  } catch { return new Set(); }
}

// ─── Main
const apps    = parseApplications();
const sent    = loadSentSet();
const cdata   = JSON.parse(readFileSync(CONTACTS, 'utf-8'));
const cmap    = {};
for (const a of (cdata.applications || [])) {
  cmap[a.appNumber] = a;
}

// Pick top-priority candidates: status=Applied, has contacts with messages, NOT yet Sent,
// sorted by score DESC. Then fall back to high-score Evaluated with PDFs ready.
const candidates = [];
for (const num of Object.keys(cmap)) {
  const app = apps[num];
  const c   = cmap[num];
  if (!app) continue;
  if (sent.has(parseInt(num, 10))) continue;
  if (!c.contacts || c.contacts.length === 0) continue;
  if (!c.contacts.some(x => {
    const m = x.messages || {};
    return x.connectionNote || x.connectMessage || m.linkedinConnect || m.linkedinInmail;
  })) continue;

  // Priority scoring: Applied > Evaluated, then by score
  const priority = (app.status === 'Applied' ? 100 : 0) + app.score * 10 + (app.pdf ? 1 : 0);
  candidates.push({ ...app, priority, contacts: c.contacts });
}

candidates.sort((a, b) => b.priority - a.priority);
const top = candidates.slice(0, TOP_N);

// ─── Build the markdown
const today = new Date().toISOString().split('T')[0];
const lines = [];
lines.push(`# Daily Outreach DMs — ${today}`);
lines.push('');
lines.push(`Top ${top.length} priority LinkedIn DMs to send today.`);
lines.push(`All apps below are: **${top.filter(t => t.status === 'Applied').length} already-Applied + ${top.filter(t => t.status !== 'Applied').length} pending Apply**, score ≥4.0, contact drafted, **not yet sent**.`);
lines.push('');
lines.push(`**Workflow:** Open each LinkedIn URL → click Connect → paste the **Connection Request** message → send. After sending, flip the Outreach badge for that # to **Sent** in the dashboard so this script skips it tomorrow.`);
lines.push('');
lines.push('---');
lines.push('');

let i = 1;
for (const app of top) {
  // Pick the best contact (recruiter > hiring_manager > team_member > peer)
  const typeOrder = { recruiter: 4, hiring_manager: 3, team_member: 2 };
  const best = [...app.contacts].sort((a, b) =>
    (typeOrder[b.type] || 1) - (typeOrder[a.type] || 1)
  )[0];
  const m = best.messages || {};
  const connectionNote = best.connectionNote || m.linkedinConnect || best.connectMessage || '';

  lines.push(`## ${i}. #${app.number} — ${app.company} — ${app.role}`);
  lines.push('');
  lines.push(`**Score:** ${app.score}/5 · **Status:** ${app.status} · **PDF:** ${app.pdf ? '✅' : '❌'}`);
  lines.push('');
  lines.push(`**Contact:** ${best.profileName || best.name || '(unknown)'} — ${best.title || ''} (\`${best.type || 'peer'}\`)`);
  if (best.linkedinProfileLink || best.linkedin) lines.push(`**LinkedIn:** ${best.linkedinProfileLink || best.linkedin}`);
  if (best.dateSent) lines.push(`**Date sent:** ${best.dateSent}`);
  if (best.email)    lines.push(`**Email:** ${best.email}`);
  lines.push('');
  if (connectionNote) {
    lines.push('### 📋 LinkedIn Connection Request (≤300 chars)');
    lines.push('```');
    lines.push(connectionNote);
    lines.push('```');
    lines.push('');
  }
  if (m.linkedinInmail) {
    lines.push('### 📋 LinkedIn InMail / Message');
    lines.push('```');
    lines.push(m.linkedinInmail);
    lines.push('```');
    lines.push('');
  }
  if (m.emailSubject || m.emailBody) {
    lines.push('### 📋 Email');
    lines.push(`**Subject:** ${m.emailSubject || ''}`);
    lines.push('```');
    lines.push(m.emailBody || '');
    lines.push('```');
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  i++;
}

if (top.length === 0) {
  lines.push('## No DMs queued');
  lines.push('');
  lines.push('Either all your applied roles already have outreach marked Sent, or no contacts are drafted yet. Run `/career-ops contacto` to draft messages, or apply to more roles first.');
}

writeFileSync(OUTPUT, lines.join('\n'), 'utf-8');

// Console summary
console.log(`✓ Wrote ${OUTPUT}`);
console.log(`  Top ${top.length} priority DMs queued.`);
console.log(`  Already Sent (skipped): ${sent.size}`);
console.log(`  Total contacts available: ${(cdata.applications || []).length}`);
console.log('');
console.log('Sample priorities:');
for (const t of top.slice(0, 5)) {
  console.log(`  #${t.number} ${t.company.padEnd(28)} ${t.role.slice(0,40).padEnd(40)} ${t.score}/5 ${t.status}`);
}
