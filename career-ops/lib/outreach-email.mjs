#!/usr/bin/env node
/**
 * outreach-email.mjs — the ONE path career-ops uses to send recruiter / hiring-manager email.
 *
 * Identity (set 2026-10-03, see modes/_profile.md "Application Email"):
 *   contact   → outreach.from (contact@…), sent through the Unipile PERSONAL Gmail account with
 *               the `from` field ALWAYS set (without it Unipile sends as the personal address).
 *               DMARC on the domain is p=reject, so no other relay works.
 *   legacymail → outreach.legacy_email via the Unipile legacymail account; `from` never set.
 *               Only for companies that already have an application / ATS account under it.
 *
 * Draft-only by construction: the dry run prints the exact message and its sha256; a send needs
 * `--approve <that hash>` (or `approval: hash` in code), so approval is bound to the message
 * <YOUR_NAME> reviewed. A prior email or LinkedIn touch to the same person blocks the send unless
 * --second-touch. Sends are logged to data/email_outreach_log.jsonl (append-only; the LinkedIn
 * MCP owns data/outreach_log.json). Secrets (.env) are never printed; error text is redacted.
 *
 *   node lib/outreach-email.mjs identity "<Company>"
 *   node lib/outreach-email.mjs send --company "<Company>" --to <CONTACT_EMAIL> --name "First Last" \
 *        --subject "..." --body-file body.txt [--attach output/x.pdf] [--cc e] [--bcc e] \
 *        [--reply-to <provider msg id>] [--role R] [--identity contact|legacymail] [--second-touch] \
 *        [--approve <sha256 from the dry run>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLIED_STATES = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);
const EMAIL_LEDGER = 'data/email_outreach_log.jsonl';
const SIGNATURE_FILE = 'config/email-signature.html'; // same HTML as the Gmail send-as signature for contact@

/** contact@ mail carries the signature; legacymail mail does not. The hash and the send both use this. */
export function signedHtml(identity, html, root = ROOT) {
  if (identity !== 'contact') return html;
  let sig = ''; try { sig = fs.readFileSync(path.join(root, SIGNATURE_FILE), 'utf8').trim(); } catch { /* no signature file */ }
  return sig ? `${html}\n${sig}` : html;
}

export function outreachConfig(root = ROOT) {
  const p = yaml.load(fs.readFileSync(path.join(root, 'config/profile.yml'), 'utf8')) || {};
  const o = p.outreach || {};
  if (!o.from || !o.legacy_email) throw new Error('config/profile.yml outreach.from / outreach.legacy_email missing');
  return {
    from: o.from,
    legacy: o.legacy_email,
    displayName: p.candidate?.full_name || o.from,
    tsentaSwitchDate: o.tsenta_switch_date ? String(o.tsenta_switch_date) : null,
    tsentaLegacyProfileId: o.tsenta_legacy_profile_id || null,
  };
}

// "IMDb (Amazon)" → ["imdb", "amazon"]: the parenthesized parent/alias is a name of its own.
const keys = s => {
  const str = String(s || '').toLowerCase();
  const aliases = [...str.matchAll(/\(([^)]*)\)/g)].flatMap(m => m[1].split(/[,/]/));
  return [str.replace(/\([^)]*\)/g, ' '), ...aliases]
    .map(x => x.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
};
const wordIn = (needle, hay) => needle.length >= 3 && new RegExp(`\\b${needle.replace(/ /g, '\\s+')}\\b`).test(hay);

/**
 * Per-company rule. The newest tracker row carrying an explicit `email=contact@|email=legacymail`
 * note decides. Otherwise legacymail if there is legacy evidence: a tracker row past Evaluated,
 * a non-skipped tsenta application (tsenta still submits with the legacy email until
 * outreach.tsenta_switch_date), or a submission confirmation in the legacymail inbox.
 */
export function identityFor(company, root = ROOT) {
  const q = keys(company);
  if (!q.length) return { identity: null, reasons: ['no company given'] };
  const same = name => { const k = keys(name); return k.some(a => q.some(b => a === b || wordIn(b, a) || wordIn(a, b))); };
  let cfg = {}; try { cfg = outreachConfig(root); } catch { /* evidence still works */ }
  const reasons = [];
  let marker = null;

  try {
    for (const line of fs.readFileSync(path.join(root, 'data/applications.md'), 'utf8').split('\n')) {
      const c = line.split('|').map(s => s.trim());
      if (c.length < 10 || !/^\d+$/.test(c[1]) || !same(c[3])) continue;
      const m = c[9].match(/email=(contact|legacymail)/i);
      if (m && (!marker || c[2] >= marker.date)) marker = { identity: m[1].toLowerCase(), date: c[2], row: c[1] };
      else if (!m && APPLIED_STATES.has(c[6].toLowerCase())) reasons.push(`tracker #${c[1]} ${c[6]}`);
    }
  } catch { /* no tracker */ }
  if (marker) return { identity: marker.identity, reasons: [`tracker #${marker.row} marked email=${marker.identity} (${marker.date})`] };

  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'data/tsenta-apps.json'), 'utf8'));
    const hit = (t.apps || []).find(a => same(a.company) && a.status !== 'SKIPPED'
      && (!cfg.tsentaSwitchDate || String(a.appliedAt || '') < cfg.tsentaSwitchDate)); // ISO strings compare chronologically
    if (hit) reasons.push(`tsenta ${hit.status} ${String(hit.appliedAt || '').slice(0, 10)}`);
  } catch { /* no mirror */ }

  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'agency-applications/_raw/Submissions.json'), 'utf8'));
    const hit = (s.threads || []).find(th => !th.mailbox && q.some(b => wordIn(b, keys(`${th.from} ${th.subject}`)[0] || '')));
    if (hit) reasons.push(`legacymail confirmation ${String(hit.date || '').slice(0, 10)}`);
  } catch { /* no label dump */ }

  return { identity: reasons.length ? 'legacymail' : 'contact', reasons };
}

export function readEnv(root = ROOT) {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* env only */ }
  return env;
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const textToHtml = txt => String(txt).replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)
  .map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');

/** Pure: the Unipile account + form fields for one message. `from` is set iff identity is contact. */
export function buildEmailFields(env, identity, { to, subject, html, cc, bcc, replyTo }, cfg) {
  if (!['contact', 'legacymail'].includes(identity)) throw new Error(`unknown identity: ${identity}`);
  const account = identity === 'contact'
    ? (env.UNIPILE_GMAIL_PERSONAL_ACCOUNT_ID || env.UNIPILE_PERSONAL_GMAIL_ACCOUNT_ID)
    : env.UNIPILE_GMAIL_LEGACY_ACCOUNT_ID;
  if (!account) throw new Error(`missing Unipile account id for identity "${identity}"`);
  const people = list => JSON.stringify(list.map(p => ({ display_name: p.name || p.email, identifier: p.email })));
  const fields = { account_id: account, to: people(to), subject, body: html };
  if (identity === 'contact') fields.from = JSON.stringify({ display_name: cfg.displayName, identifier: cfg.from });
  if (cc?.length) fields.cc = people(cc);
  if (bcc?.length) fields.bcc = people(bcc);
  if (replyTo) fields.reply_to = replyTo;
  return fields;
}

/** Attachments: PDFs under <root>/output only, checked by magic bytes. */
export function checkAttachment(file, root = ROOT) {
  const abs = path.resolve(root, file);
  const out = path.resolve(root, 'output') + path.sep;
  if (!abs.startsWith(out)) throw new Error(`attachment must live under output/: ${file}`);
  if (path.extname(abs).toLowerCase() !== '.pdf') throw new Error(`attachment must be a .pdf: ${file}`);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error(`not a PDF file: ${file}`);
  return { abs, buf };
}

/** sha256 over everything that leaves the machine; approval must quote it. */
export function messageHash(identity, msg, root = ROOT) {
  const h = crypto.createHash('sha256');
  const emails = l => (l || []).map(p => p.email.toLowerCase()).join(',');
  h.update([identity, emails(msg.to), emails(msg.cc), emails(msg.bcc), msg.replyTo || '', msg.subject, signedHtml(identity, msg.html, root)].join('\u0000'));
  for (const f of msg.attachments || []) h.update(checkAttachment(f, root).buf);
  return h.digest('hex');
}

/** Earlier email (ledger) or LinkedIn touch (outreach_log.json) to the same person. */
export function priorTouches(msg, root = ROOT) {
  const hits = [];
  const to = new Set(msg.to.map(p => p.email.toLowerCase()));
  try {
    for (const line of fs.readFileSync(path.join(root, EMAIL_LEDGER), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if ((e.to || []).some(x => to.has(String(x).toLowerCase()))) hits.push(`email ${String(e.sent_at).slice(0, 10)} "${e.subject}"`);
    }
  } catch { /* no ledger yet */ }
  const name = String(msg.to[0]?.name || '').toLowerCase().trim();
  const co = keys(msg.company)[0];
  if (name && co) {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(root, 'data/outreach_log.json'), 'utf8'));
      for (const e of log.events || []) {
        if (String(e.name || '').toLowerCase().trim() === name && (keys(e.company)[0] || '') === co) hits.push(`${e.channel || e.action} ${String(e.sent_at || '').slice(0, 10)}`);
      }
    } catch { /* no linkedin log */ }
  }
  return hits;
}

function resolveIdentity(msg, root) {
  if (msg.identity) return msg.identity;
  const id = identityFor(msg.company, root);
  if (!id.identity) throw new Error('give --company (or an explicit --identity) so the per-company email rule can run');
  return id.identity;
}

/** Send one approved message. Returns { sent, logged, identity, from, response }. */
export async function sendOutreachEmail(msg, { root = ROOT, env = readEnv(root), fetchImpl = fetch } = {}) {
  if (!msg.to?.length || !msg.subject || !msg.html) throw new Error('to, subject and html are required');
  const identity = resolveIdentity(msg, root);
  const hash = messageHash(identity, msg, root);
  if (msg.approval !== hash) throw new Error('refusing to send: approval does not match this exact message (run the dry run and approve its hash)');
  const touches = priorTouches(msg, root);
  if (touches.length && !msg.secondTouch) throw new Error(`refusing to send: already contacted (${touches.join('; ')}); pass --second-touch if intended`);

  const cfg = outreachConfig(root);
  const fields = buildEmailFields(env, identity, { ...msg, html: signedHtml(identity, msg.html, root) }, cfg);
  const base = String(env.UNIPILE_API_BASE || '').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (!base || !env.UNIPILE_API_KEY) throw new Error('missing UNIPILE_API_BASE / UNIPILE_API_KEY');

  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of msg.attachments || []) form.append('attachments', new Blob([checkAttachment(f, root).buf], { type: 'application/pdf' }), path.basename(f));

  const redact = s => [env.UNIPILE_API_KEY, fields.account_id].filter(Boolean).reduce((a, sec) => a.split(sec).join('<redacted>'), String(s));
  let res, text;
  try {
    res = await fetchImpl(`${base}/api/v1/emails`, { method: 'POST', headers: { 'X-API-KEY': env.UNIPILE_API_KEY, accept: 'application/json' }, body: form, signal: AbortSignal.timeout(60_000) });
    text = await res.text();
  } catch (e) {
    throw new Error(redact(`send outcome UNKNOWN (${e.name || 'error'}): check the Sent folder before retrying`));
  }
  if (!res.ok) throw new Error(redact(`Unipile HTTP ${res.status}: ${String(text).slice(0, 300)}`));

  const from = identity === 'contact' ? cfg.from : cfg.legacy;
  const entry = {
    channel: 'email', action: 'email_sent', sent_at: new Date().toISOString(), origin: 'lib/outreach-email.mjs',
    from, identity, company: msg.company || null, role: msg.role || null,
    to: msg.to.map(p => p.email), name: msg.to[0]?.name || null, subject: msg.subject,
    attachments: (msg.attachments || []).map(f => path.basename(f)), message_sha256: hash,
  };
  let logged = true;
  try { fs.appendFileSync(path.join(root, EMAIL_LEDGER), JSON.stringify(entry) + '\n'); }
  catch (e) { logged = false; console.error(`WARNING: email SENT but not logged (${e.code || e.message}); add this line to ${EMAIL_LEDGER} by hand:\n${JSON.stringify(entry)}`); }
  let response = null; try { response = JSON.parse(text); } catch { /* non-JSON ok */ }
  return { sent: true, logged, identity, from, response: response && { tracking_id: response.tracking_id, object: response.object } };
}

// ---------- CLI ----------
const FLAGS = new Set(['company', 'to', 'name', 'subject', 'body-file', 'attach', 'cc', 'bcc', 'reply-to', 'role', 'identity', 'approve']);
function parseArgs(argv) {
  const a = { attach: [], cc: [], bcc: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--second-touch') { a.secondTouch = true; continue; }
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const f = k.slice(2);
    if (!FLAGS.has(f)) throw new Error(`unknown flag: ${k}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${k}`);
    if (Array.isArray(a[f])) a[f].push(v); else a[f] = v;
  }
  return a;
}

async function cli() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'identity') {
    const id = identityFor(a._.slice(1).join(' '));
    // tsenta: apply with this resume profile (null = default profile, which carries contact@).
    const legacy = id.identity === 'legacymail' ? outreachConfig().tsentaLegacyProfileId : null;
    console.log(JSON.stringify({ ...id, tsenta_resume_profile_id: legacy }, null, 2));
    return;
  }
  if (cmd !== 'send') { console.error('usage: identity "<Company>" | send --company C --to EMAIL --name N --subject S --body-file F [--attach output/x.pdf] [--cc E] [--bcc E] [--reply-to ID] [--identity contact|legacymail] [--second-touch] [--approve SHA256]'); process.exit(2); }
  if (a.identity && !['contact', 'legacymail'].includes(a.identity)) throw new Error(`unknown identity: ${a.identity}`);
  const body = fs.readFileSync(a['body-file'], 'utf8');
  const html = /\.html?$/i.test(a['body-file']) ? body : textToHtml(body);
  const person = e => ({ email: e });
  const msg = { company: a.company, role: a.role, to: [{ name: a.name, email: a.to }], cc: a.cc.map(person), bcc: a.bcc.map(person),
    replyTo: a['reply-to'], subject: a.subject, html, attachments: a.attach, identity: a.identity, secondTouch: !!a.secondTouch };
  const identity = resolveIdentity(msg, ROOT);
  const why = a.identity ? ['--identity override'] : identityFor(a.company).reasons;
  const hash = messageHash(identity, { ...msg, identity }, ROOT);
  if (!a.approve) {
    const cfg = outreachConfig();
    console.log(JSON.stringify({ dry_run: true, would_send_from: identity === 'contact' ? cfg.from : cfg.legacy, identity, why,
      to: msg.to, cc: msg.cc, bcc: msg.bcc, reply_to: msg.replyTo || null, subject: msg.subject, attachments: msg.attachments,
      prior_touches: priorTouches(msg), body, signature: signedHtml(identity, '', ROOT) ? SIGNATURE_FILE : 'none' }, null, 2));
    console.log(`\nTo send exactly this message: --approve ${hash}`);
    return;
  }
  console.log(JSON.stringify(await sendOutreachEmail({ ...msg, identity, approval: a.approve }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  cli().catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
