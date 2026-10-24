// people.mjs — search the outreach database by name, and pull a full LinkedIn thread.
//
// Why this exists: the "read this page" flow requires you to be sitting on the LinkedIn thread.
// This lets you search a name from anywhere, pick the right person, and load the WHOLE
// conversation — both sides — before drafting the next message.
//
// Two sources, and they answer different questions:
//   data/outreach_log.json + data/contacts.json — who they are, and what WE sent (701 events).
//   Unipile /chats/{id}/messages                — the real LinkedIn thread INCLUDING THEIR
//                                                 REPLIES, which career-ops never records.
// Drafting a follow-up from our sent messages alone means answering someone without reading
// what they said back.
//
// Read-only: no local file is opened for writing, and every Unipile call here is a GET.
import fs from 'node:fs';
import path from 'node:path';
import { findPerson } from './person.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const handleOf = (u) => String(u ?? '').replace(/\/+$/, '').split('/').pop().toLowerCase();
const readJson = (root, rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; }
};

/**
 * Search people we have contacted or catalogued.
 * Ranks exact-name matches above partial ones, and people with prior outreach above cold
 * contacts — when you search a name you almost always mean someone you already talked to.
 */
export function searchPeople(root, query, limit = 20) {
  const q = norm(query);
  if (q.length < 2) return { ok: false, error: 'query must be at least 2 characters' };

  const log = readJson(root, 'data/outreach_log.json') || { events: [], sent_profiles: {} };
  const contacts = readJson(root, 'data/contacts.json');
  const byKey = new Map();

  const keyFor = (providerId, publicId, name) =>
    providerId || (publicId ? 'h:' + publicId : 'n:' + norm(name));

  for (const e of log.events || []) {
    const name = e.name;
    if (!name || !norm(name).includes(q)) continue;
    const publicId = String(e.public_id || e.public_identifier || '').toLowerCase() || handleOf(e.linkedin);
    const k = keyFor(e.provider_id, publicId, name);
    const prev = byKey.get(k) || {
      name, providerId: e.provider_id || null, publicId: publicId || null,
      linkedin: e.linkedin || (publicId ? `https://www.linkedin.com/in/${publicId}` : null),
      company: e.company || null, role: e.role || null, title: e.title || null,
      contactCount: 0, lastContact: null, source: 'outreach',
    };
    prev.contactCount += 1;
    if (!prev.lastContact || String(e.sent_at) > String(prev.lastContact)) prev.lastContact = e.sent_at;
    prev.company = prev.company || e.company || null;
    byKey.set(k, prev);
  }

  for (const app of contacts?.applications || []) {
    for (const c of app.contacts || []) {
      if (!c.name || !norm(c.name).includes(q)) continue;
      const publicId = String(c.public_id || '').toLowerCase() || handleOf(c.linkedinProfileLink || c.linkedin);
      const k = keyFor(c.provider_id, publicId, c.name);
      const prev = byKey.get(k);
      if (prev) {
        prev.title = prev.title || c.title || null;
        prev.company = prev.company || c.company || null;
        prev.appNumber = app.appNumber ?? prev.appNumber ?? null;
        continue;
      }
      byKey.set(k, {
        name: c.name, providerId: c.provider_id || null, publicId: publicId || null,
        linkedin: c.linkedinProfileLink || c.linkedin || null,
        company: c.company || app.company || null, role: app.role || null, title: c.title || null,
        appNumber: app.appNumber ?? null,
        contactCount: 0, lastContact: c.dateSent || null, source: 'contacts',
      });
    }
  }

  const results = [...byKey.values()].sort((a, b) => {
    const ax = norm(a.name) === q ? 1 : 0, bx = norm(b.name) === q ? 1 : 0;
    if (ax !== bx) return bx - ax;                                   // exact name first
    if ((b.contactCount > 0) !== (a.contactCount > 0)) return (b.contactCount > 0) - (a.contactCount > 0);
    return String(b.lastContact || '').localeCompare(String(a.lastContact || ''));
  });

  return { ok: true, query, count: results.length, results: results.slice(0, limit), truncated: Math.max(0, results.length - limit) };
}

// --- Unipile: the real thread, both sides ------------------------------------

export function unipileConfig(root) {
  let env = '';
  try { env = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return null; }
  const get = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  const base = get('UNIPILE_API_BASE');
  const key = get('UNIPILE_API_KEY');
  const account = get('UNIPILE_LINKEDIN_ACCOUNT_ID') || get('UNIPILE_ACCOUNT_ID');
  if (!base || !key || !account) return null;
  return { base: base.replace(/\/+$/, ''), key, account };
}

export async function unipileGet(cfg, pathPart, params = {}) {
  const url = new URL(cfg.base + pathPart);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': cfg.key,
      accept: 'application/json',
      // Without a normal UA the edge returns Cloudflare 1010, which looks exactly like an
      // auth failure and sends you hunting for the wrong bug.
      'User-Agent': 'career-ops-assist/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Unipile ${res.status} on ${pathPart}`);
  return res.json();
}

/**
 * The full LinkedIn conversation with one person, newest last.
 * Falls back to our own sent-message history when Unipile is unavailable, and says which
 * source it used — a follow-up drafted without their replies is a different, weaker thing.
 */
export async function loadThread(root, { providerId, publicId, linkedin, name } = {}) {
  const person = findPerson(root, { providerId, publicId, linkedin, name });
  const pid = providerId || person.identity.providerId;

  const cfg = unipileConfig(root);
  if (!cfg || !pid) {
    return {
      ok: true, source: 'career-ops', bothSides: false,
      reason: !cfg ? 'Unipile is not configured' : 'no provider_id for this person',
      person,
      messages: (person.history || []).slice().reverse().map((h) => ({
        from: 'me', text: h.message, sent_at: h.sent_at, channel: h.channel,
      })).filter((m) => m.text),
    };
  }

  try {
    // Find the chat with this attendee, then read it in full.
    const chats = await unipileGet(cfg, '/chats', { account_id: cfg.account, limit: 60 });
    const chat = (chats.items || []).find((c) => c.attendee_provider_id === pid);
    if (!chat) {
      return {
        ok: true, source: 'career-ops', bothSides: false,
        reason: 'no LinkedIn conversation found with this person (invitation may be pending)',
        person,
        messages: (person.history || []).slice().reverse().map((h) => ({ from: 'me', text: h.message, sent_at: h.sent_at, channel: h.channel })).filter((m) => m.text),
      };
    }
    const msgs = await unipileGet(cfg, `/chats/${encodeURIComponent(chat.id)}/messages`, { limit: 100 });
    const messages = (msgs.items || [])
      .map((m) => ({ from: m.is_sender ? 'me' : (person.identity.name || 'them'), text: m.text, sent_at: m.timestamp, id: m.id }))
      .filter((m) => m.text)
      .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
    return { ok: true, source: 'unipile', bothSides: true, chatId: chat.id, person, messages, messageCount: messages.length };
  } catch (e) {
    return {
      ok: true, source: 'career-ops', bothSides: false,
      reason: `Unipile unavailable: ${String(e.message || e).slice(0, 120)}`,
      person,
      messages: (person.history || []).slice().reverse().map((h) => ({ from: 'me', text: h.message, sent_at: h.sent_at, channel: h.channel })).filter((m) => m.text),
    };
  }
}

/** GET /api/assist/people?q=name */
export function searchHandler(ctx) {
  const q = ctx.url.searchParams.get('q') || '';
  const r = searchPeople(ctx.root, q, Number(ctx.url.searchParams.get('limit')) || 20);
  return ctx.json(r.ok ? 200 : 400, r);
}

/** GET /api/assist/thread?provider_id=…&public_id=…&name=… */
export async function threadHandler(ctx) {
  const q = ctx.url.searchParams;
  const r = await loadThread(ctx.root, {
    providerId: q.get('provider_id') || undefined,
    publicId: q.get('public_id') || undefined,
    linkedin: q.get('linkedin') || undefined,
    name: q.get('name') || undefined,
  });
  return ctx.json(200, r);
}
