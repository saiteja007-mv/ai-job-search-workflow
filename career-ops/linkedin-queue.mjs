#!/usr/bin/env node
/**
 * linkedin-queue.mjs — the review queue for LinkedIn acceptances and inbound replies.
 *
 * A detector (deploy/unipile-poll.mjs) appends events here. A human reviews them and
 * decides what happens next. THIS FILE NEVER SENDS ANYTHING and never calls Unipile.
 *
 * The whole point of the queue is that the send stays a human decision. Every message
 * drafted in this project on 2026-09-04 needed a correction that only a human check
 * caught: a claim about an application that did not exist, a relocation offer that
 * contradicted the user's own location tiers, a seven-week-stale "in SF", and a
 * "thanks for connecting" that would have gone to someone who had already declined.
 * So: detect, enrich, queue. A person approves. See reports/linkedin-autodraft-build-plan-2026-09-04.md.
 *
 * Storage is JSONL, one object per line, each line the FULL current state of that event
 * (not a delta). Rewrites go through the same pipeline lock scan.mjs uses.
 *
 * Usage:
 *   node linkedin-queue.mjs list [--status new] [--json]
 *   node linkedin-queue.mjs show <id>
 *   node linkedin-queue.mjs dismiss <id> [--reason "..."]
 *   node linkedin-queue.mjs notify [--dry-run]
 *   node linkedin-queue.mjs stats
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { withPipelineLock } from './pipeline-lock.mjs';
import { notify } from './deploy/telegram-notify.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const QUEUE_PATH = join(ROOT, 'data', 'linkedin-events.jsonl');

/** Status lifecycle. The slice built today stops at `new`; the rest is reserved. */
export const STATUSES = ['new', 'drafted', 'approved', 'sent', 'dismissed'];

export function readQueue(path = QUEUE_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l); } catch { return { _malformed: true, _line: i + 1, raw: l }; }
    })
    .filter((e) => !e._malformed);
}

/**
 * Deterministic id. Two different events from the same person must not collide, and the
 * same event seen twice by two poll runs must. For an acceptance the acceptance time is
 * part of the identity: reconnecting after a disconnect is genuinely a new event.
 */
export function eventId(kind, providerId, stamp) {
  return `${kind}:${String(providerId || 'unknown').slice(0, 24)}:${stamp}`;
}

/**
 * Append events that are not already queued. Returns the ones actually written.
 * Dedup is by id against the whole file, so a poller that re-reports an old
 * acceptance (Unipile's relation list is not strictly ordered under pagination)
 * is a no-op rather than a duplicate ping.
 */
export async function ingest(events, path = QUEUE_PATH) {
  if (!events?.length) return [];
  mkdirSync(dirname(path), { recursive: true });
  let written = [];
  await withPipelineLock(path, () => {
    const seen = new Set(readQueue(path).map((e) => e.id));
    written = events.filter((e) => e.id && !seen.has(e.id));
    if (written.length) {
      appendFileSync(path, written.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  });
  return written;
}

/** Locked read/mutate/rewrite. Atomic via write-temp-then-rename. */
export async function update(id, patch, path = QUEUE_PATH) {
  let result = null;
  await withPipelineLock(path, () => {
    const rows = readQueue(path);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) return;
    rows[i] = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
    result = rows[i];
    const tmp = path + '.tmp';
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(tmp, path);
  });
  return result;
}

function fmt(e) {
  const who = [e.name, e.company && `(${e.company})`].filter(Boolean).join(' ');
  const kind = e.kind === 'accepted' ? 'accepted your invite' : 'replied';
  return `[${e.status}] ${e.id}\n  ${who || e.provider_id} ${kind}\n  ${e.headline || ''}\n  seen ${e.detected_at}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : rest[i + 1]; };
  const has = (n) => rest.includes(`--${n}`);

  if (cmd === 'list' || !cmd) {
    const want = flag('status');
    const rows = readQueue().filter((e) => !want || e.status === want);
    if (has('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('queue empty'); return; }
    for (const e of rows) console.log(fmt(e) + '\n');
    return;
  }
  if (cmd === 'show') {
    const e = readQueue().find((r) => r.id === rest[0]);
    if (!e) { console.error('not found:', rest[0]); process.exit(1); }
    console.log(JSON.stringify(e, null, 2));
    return;
  }
  if (cmd === 'dismiss') {
    const r = await update(rest[0], { status: 'dismissed', dismiss_reason: flag('reason') || null });
    if (!r) { console.error('not found:', rest[0]); process.exit(1); }
    console.log('dismissed', r.id);
    return;
  }
  if (cmd === 'notify') {
    // Re-push everything still open. The poller only pings on FIRST sight, so this is how
    // you replay the flow, and how you get a nudge about items you left sitting.
    const rows = readQueue().filter((e) => e.status === 'new');
    if (!rows.length) { console.log('nothing open to notify about'); return; }

    // Fill in drafts that could not be made at detection time (assist server down, or the
    // poll ran on a machine without it). The thread was stored on the event precisely so
    // this needs no second Unipile call.
    if (!has('no-draft')) {
      const { draftReply, assistUp } = await import('./deploy/draft-reply.mjs');
      if (await assistUp()) {
        for (const e of rows) {
          if (e.kind !== 'replied' || e.draft?.text) continue;
          let thread = e.thread;
          // Events queued before threads were stored, or whose fetch was partial, have no
          // context to draft from. One read-only GET recovers it. Opt-in via --refetch-thread
          // because the whole point of storing the thread was to avoid a second Unipile call:
          // this is the fallback, not the path.
          if (!thread?.length && has('refetch-thread') && e.chat_id) {
            try {
              const { unipileConfig, unipileGet } = await import('./assist/people.mjs');
              const cfg = unipileConfig(ROOT);
              const msgs = await unipileGet(cfg, `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: 30 });
              thread = (msgs.items || []).filter((m) => m.text)
                .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
                .map((m) => ({ from: m.is_sender ? 'me' : 'them', text: m.text }));
              if (thread.length) { await update(e.id, { thread }); console.log(`refetched thread for ${e.id} (${thread.length} msgs)`); }
            } catch (err) { console.log(`refetch failed for ${e.id}: ${err.message}`); }
          }
          if (!thread?.length) { console.log(`no thread for ${e.id} (try --refetch-thread)`); continue; }
          const d = await draftReply({
            messages: thread, correspondent: e.name || null,
            providerId: e.provider_id, company: e.company || null,
          });
          if (d.text) {
            e.draft = { text: d.text, model: d.model, drafted_at: new Date().toISOString() };
            await update(e.id, { draft: e.draft });
            console.log(`drafted for ${e.id}`);
          } else {
            console.log(`no draft for ${e.id}: ${d.error}`);
          }
        }
      }
    }

    const lines = rows.map((e) => {
      const who = e.name || e.public_id || String(e.provider_id).slice(0, 12);
      const at = e.company ? ` @ ${e.company}` : '';
      if (e.kind === 'accepted') {
        return `• ${who}${at} accepted your invite\n  ${(e.headline || '').slice(0, 90)}\n  ${e.id}`;
      }
      let block = `• ${who}${at} replied (${e.message_count || 1} msg)\n  "${(e.preview || '').slice(0, 200)}"`;
      // Name the model. Verified 2026-09-04: the same thread drafted twice, 6 minutes apart,
      // gave a fabricated repo link from one free model and a careful "I don't know, can you
      // tell me?" from another. Which model wrote it is real signal about how hard to check it.
      if (e.draft?.text) block += `\n\n  DRAFT by ${e.draft.model || 'unknown model'} (unreviewed, not sent):\n  ${e.draft.text.slice(0, 1200)}`;
      else if (e.draft?.error) block += `\n  (no draft: ${e.draft.error})`;
      return `${block}\n  ${e.id}`;
    });
    const text = `LinkedIn: ${rows.length} open to review\n\n${lines.join('\n\n')}\n\n` +
      `Drafts are unverified starting points, not approved messages. Nothing sends until you say so.`;
    if (has('dry-run')) { console.log(text); return; }
    const ok = await notify(text);
    console.log(ok ? `notified (${rows.length} open)` : 'notify FAILED: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_ID not set or unreachable');
    if (!ok) process.exit(1);
    return;
  }
  if (cmd === 'stats') {
    const rows = readQueue();
    const by = {};
    for (const e of rows) by[e.status] = (by[e.status] || 0) + 1;
    console.log(JSON.stringify({ total: rows.length, byStatus: by, path: QUEUE_PATH }, null, 2));
    return;
  }
  console.error('usage: list [--status S] [--json] | show <id> | dismiss <id> [--reason R] | stats');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('linkedin-queue.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
