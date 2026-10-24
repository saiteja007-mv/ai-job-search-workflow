/**
 * linkedin-actions.mjs — what <YOUR_NAME> can do to a queued LinkedIn item from Telegram, and the
 * button/scorecard helpers the poller shares with the bot (<YOUR_NAME>, 2026-10-15).
 *
 * Every send goes through the LinkedIn MCP (outreach ledger + employer-name guard), and a thread
 * that moved since the draft is never answered blindly: the same rule sendStage() applies.
 */
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnv, promisify } from 'util';
import { readQueue, update, ingest, eventId } from '../linkedin-queue.mjs';
import { unipileConfig, unipileGet } from '../assist/people.mjs';
import { sendLinkedInMessage, startLinkedInChat, inviteReferredPerson } from './linkedin-send.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
export const ANSWERS_FILE = 'data/linkedin-answers.md';
export const EDITS_FILE = 'data/linkedin-edits.jsonl';
export const CALENDAR = process.env.LINKEDIN_MA_CALENDAR || '<YOUR_EMAIL>';

/** Short, stable reference for an item: fits Telegram's 64-byte callback_data and is easy to type. */
export const handle = (id) => createHash('sha1').update(String(id)).digest('base64url').slice(0, 6);
export const findItem = (h) => readQueue().filter((e) => handle(e.id) === h).at(-1) || null;
/** Text that would go out for this item: the agent's suggestion for a held item, else its draft. */
export const textOf = (e) => e.suggested || e.draft?.text || e.draft?.withheld || '';
export const isOpen = (e) => e.status === 'needs_you' || (e.status === 'new' && Boolean(e.draft?.error || e.send?.skipped || e.send?.error));

export function buttonsFor(e) {
  const h = handle(e.id);
  const skip = { text: '⏭ Skip', callback_data: `skip:${h}` };
  if (e.slot) return [[{ text: '✅ Confirm time', callback_data: `slot:${h}` }, { text: '✏️ Edit', callback_data: `edit:${h}` }, skip]];
  if (e.referral?.invite?.candidate) return [[{ text: '🤝 Invite this person', callback_data: `invc:${h}` }, skip]];
  if (e.cls === 'referral' && !e.referral?.invite?.ok) return [[skip]];   // connect first with /invite <ref> <url>
  if (textOf(e)) return [[{ text: '📤 Send', callback_data: `send:${h}` }, { text: '✏️ Edit', callback_data: `edit:${h}` }, skip]];
  return [[skip]];
}

/**
 * Send `text` for an item as <YOUR_NAME> (<YOUR_NAME> approved it in Telegram, so the poller's draft-quality gates
 * do not apply; the MCP's employer-name guard still does). Refuses if they wrote again since the draft.
 */
export async function sendItem(e, text, { attachment = e.attachment } = {}) {
  if (!String(text || '').trim()) return { ok: false, error: 'nothing to send' };
  // The thank-you to a referrer says <YOUR_NAME> reached out, so it waits until the connection really happened.
  if (e.cls === 'referral' && !e.referral?.invite?.ok) return { ok: false, error: `connect with ${e.referral?.person || 'the referred person'} first: /invite ${handle(e.id)} <linkedin url>` };
  if (e.kind === 'accepted' && !e.chat_id) {
    const r = await startLinkedInChat({ attendee_id: e.provider_id, text, name: e.name, company: e.company, role: e.role });
    if (r.ok) await update(e.id, { status: 'sent', sent_at: new Date().toISOString(), sent_by: '<YOU>-telegram', sent_text: text, chat_id: r.chat_id || null, send: { ok: true } });
    return r;
  }
  if (!e.chat_id) return { ok: false, error: 'this item has no LinkedIn conversation' };
  const fresh = await unipileGet(unipileConfig(ROOT), `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: 5 });
  const latest = (fresh.items || []).filter((m) => m.text).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (latest && Date.parse(latest.timestamp) > Date.parse(e.occurred_at)) {
    return { ok: false, error: latest.is_sender ? 'you already replied in this thread' : `${e.name || 'They'} wrote again since this draft: "${latest.text.slice(0, 160)}". Not sent; the next poll drafts a new reply.` };
  }
  const r = await sendLinkedInMessage({ chat_id: e.chat_id, text, name: e.name, company: e.company, role: e.role, provider_id: e.provider_id, public_id: e.public_id, attachment_path: attachment || undefined });
  if (r.ok) await update(e.id, { status: 'sent', sent_at: new Date().toISOString(), sent_by: '<YOU>-telegram', sent_text: text, send: { ok: true } });
  return r;
}

export const skipItem = (e) => update(e.id, { status: 'dismissed', dismiss_reason: 'skipped by <YOUR_NAME> (Telegram)' });

/** Learn-from-edits: the draft and what <YOUR_NAME> sent instead become a voice example. */
export function recordEdit(e, final) {
  appendFileSync(join(ROOT, EDITS_FILE), JSON.stringify({ at: new Date().toISOString(), name: e.name || null, company: e.company || null,
    their_ask: e.agent?.their_ask || e.preview || '', draft: textOf(e), final }) + '\n');
}

/** Answers-that-compound: an answer <YOUR_NAME> wrote becomes a fact the agent reuses (only on <YOUR_NAME>'s tap). */
export function saveAnswer(e, text) {
  const file = join(ROOT, ANSWERS_FILE);
  if (!existsSync(file)) appendFileSync(file, '# Saved LinkedIn answers\n\nWritten by <YOUR_NAME> in Telegram and saved for reuse by the LinkedIn agent. Edit or delete lines freely.\n\n');
  const q = String(e.agent?.their_ask || e.preview || 'a recruiter question').replace(/\s+/g, ' ').slice(0, 200);
  appendFileSync(file, `- ${new Date().toISOString().slice(0, 10)}, when asked "${q}": ${String(text).replace(/\s+/g, ' ').trim()}\n`);
}

function gogEnv() {
  const env = { ...process.env };
  if (!env.GOG_KEYRING_PASSWORD) { try { env.GOG_KEYRING_PASSWORD = parseEnv(read('.env')).GOG_KEYRING_PASSWORD || ''; } catch { /* none */ } }
  return env;
}

/** One-tap slot confirm: send the confirmation, then put a 30-minute hold on the calendar. */
export async function confirmSlot(e, text) {
  const r = await sendItem(e, text);
  if (!r.ok) return r;
  const from = new Date(e.slot), to = new Date(from.getTime() + 30 * 60_000);
  try {
    await promisify(execFile)('gog', ['calendar', 'create', 'primary', '--client', 'default', '--account', CALENDAR, '--summary', `LinkedIn call: ${e.name || '?'}${e.company ? ` (${e.company})` : ''}`,
      '--from', from.toISOString(), '--to', to.toISOString(), '--description', `Time confirmed in the LinkedIn chat with ${e.name || 'them'}. Watch for their invite.`], { env: gogEnv(), timeout: 30_000 });
    return { ok: true, hold: true };
  } catch (err) {
    return { ok: true, hold: false, hold_error: String(err.stderr || err.message || err).split('\n')[0].slice(0, 160) };
  }
}

/** Invite the candidate a referral search surfaced (or a profile <YOUR_NAME> pasted), then thank the referrer. */
export async function inviteCandidate(e, profileUrl) {
  const c = e.referral?.invite?.candidate || {};
  const url = profileUrl || (c.url && /linkedin\.com\/in\//.test(c.url) ? c.url : c.provider_id ? `https://www.linkedin.com/in/${c.provider_id}` : null);
  if (!url) return { ok: false, error: 'no profile to invite; use /invite <ref> <linkedin url>' };
  const person = c.name || e.referral?.person;
  const note = e.referral?.invite?.note || e.referral?.note || `Hi ${String(person || '').split(' ')[0]}, ${String(e.name || '').split(' ')[0] || 'a colleague'} at ${e.referral?.company || e.company} suggested I reach out. I build production ML and RAG systems end to end and would value connecting.`.slice(0, 300);
  const inv = await inviteReferredPerson({ person, company: e.referral?.company || e.company, referrer: e.name, role: e.role, note, profileUrl: url });
  if (!inv.ok) return { ok: false, error: inv.error };
  await update(e.id, { referral: { ...e.referral, invite: { ok: true, name: inv.profile.name, url: inv.profile.url, inmail: inv.inmail || false, note } } });
  const thanks = textOf(e);
  if (!thanks) return { ok: true, invited: inv.profile.name, sent: false };
  const r = await sendItem({ ...e, referral: { ...e.referral, invite: { ok: true } } }, thanks);
  return { ...r, invited: inv.profile.name };
}

/** Open items, newest first, for /queue and reminders. */
export const openItems = (days = 7) => readQueue().filter((e) => isOpen(e) && Date.parse(e.detected_at || e.occurred_at) > Date.now() - days * 86400_000)
  .sort((a, b) => Date.parse(b.detected_at || b.occurred_at) - Date.parse(a.detected_at || a.occurred_at));

/** The newest queued item for someone whose name contains `q`. */
export const itemFor = (q) => readQueue().filter((e) => e.chat_id && String(e.name || '').toLowerCase().includes(String(q).toLowerCase().trim())).at(-1) || null;

export async function threadText(e, n = 12) {
  const msgs = ((await unipileGet(unipileConfig(ROOT), `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: n })).items || [])
    .filter((m) => m.text).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return msgs.map((m) => `${String(m.timestamp).slice(5, 16).replace('T', ' ')} ${m.is_sender ? 'You' : (e.name || 'Them').split(' ')[0]}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
}

/** A reply <YOUR_NAME> asked for in Telegram: drafted by the agent, queued as needs_you, never auto-sent. */
export async function manualDraft(e, instruction, draftManaged) {
  const msgs = ((await unipileGet(unipileConfig(ROOT), `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: 30 })).items || [])
    .filter((m) => m.text).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const thread = msgs.map((m) => ({ from: m.is_sender ? 'me' : 'them', text: m.text, at: m.timestamp }));
  const d = await draftManaged({ kind: 'replied', cls: 'convo', name: e.name, headline: e.headline, company: e.company, role: e.role, profileUrl: e.profile_url,
    providerId: e.provider_id, chatId: e.chat_id, thread, userInstruction: instruction }, { timeoutMs: 175_000 });
  if (d.error) return { error: d.error };
  const last = thread.at(-1);
  const item = { id: eventId('manual', e.provider_id, Date.now()), kind: 'replied', cls: 'convo', status: 'needs_you', chat_id: e.chat_id, provider_id: e.provider_id,
    name: e.name, headline: e.headline, company: e.company, role: e.role, public_id: e.public_id, occurred_at: last ? new Date(Date.parse(last.at)).toISOString() : new Date().toISOString(),
    detected_at: new Date().toISOString(), preview: `(your request: ${instruction})`, thread: thread.slice(-30),
    suggested: d.text, agent: { action: d.action, their_ask: d.their_ask, reason: d.reason, session_id: d.session_id }, needs_you: `drafted on your request: ${d.reason}` };
  await ingest([item]);
  return { item };
}

/** Weekly scorecard from the queue. Pure over rows so it is testable. */
export function scorecard(rows, days = 7, now = Date.now()) {
  const since = now - days * 86400_000;
  const win = rows.filter((e) => Date.parse(e.detected_at || e.occurred_at) > since);
  const count = (f) => win.filter(f).length;
  const reasons = {};
  for (const e of win.filter((x) => x.status === 'needs_you' || x.agent?.action === 'needs_you')) {
    const r = String(e.agent?.reason || e.needs_you || 'other');
    const k = r.includes(':') && r.indexOf(':') <= 40 ? r.slice(0, r.indexOf(':')) : 'other';
    reasons[k] = (reasons[k] || 0) + 1;
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `  ${v} × ${k}`).join('\n');
  return [
    `LinkedIn scorecard, last ${days} days`,
    `Replies received: ${count((e) => e.kind === 'replied' && !String(e.id).startsWith('manual:'))}`,
    `Invites accepted: ${count((e) => e.kind === 'accepted')}`,
    `Sent automatically: ${count((e) => e.status === 'sent' && !e.sent_by)}`,
    `Sent by you from Telegram: ${count((e) => e.sent_by === '<YOU>-telegram')}`,
    `Skipped as no-reply-needed: ${count((e) => e.agent?.action === 'no_reply')}`,
    `Referrals connected: ${count((e) => e.referral?.invite?.ok)}`,
    `Follow-up nudges sent: ${count((e) => e.kind === 'followup' && e.status === 'sent')}`,
    `Still needing you: ${count(isOpen)}`,
    ...(top ? ['Most common reasons it needed you (automate these next):', top] : []),
  ].join('\n');
}
