// career-ops Telegram bot: your phone -> the <HOME_SERVER>. Long-polls getUpdates; serves ONLY
// TELEGRAM_ALLOWED_CHAT_ID (it can send LinkedIn messages as you, so there is no open mode).
// Run via the systemd user service career-ops-telegram.service.
//
// LinkedIn (2026-10-15): act on held items (buttons or /send /edit /skip /invite), control the
// poller (/pause /resume /status /run), inspect threads (/thread /draft), /digest /score /slots.
// Background: re-pings items held >24h once, and alerts when the poller stops running.
// Pipeline (original): /pipeline /sync /scan /report.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQueue, update } from '../linkedin-queue.mjs';
import { handle, findItem, textOf, buttonsFor, sendItem, skipItem, recordEdit, saveAnswer, confirmSlot, inviteCandidate,
  openItems, itemFor, threadText, manualDraft, scorecard } from './linkedin-actions.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = String(process.env.TELEGRAM_ALLOWED_CHAT_ID || '');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `https://api.telegram.org/bot${TOKEN}`;
const ENV_FILE = join(REPO, 'deploy', '.env');
const POLL_STATE = join(REPO, 'deploy', 'linkedin-poll-state.json');
const BOT_STATE = join(REPO, 'deploy', 'telegram-bot-state.json');
const DIGEST_FLAG = join(REPO, 'deploy', 'linkedin-digest-now.flag');
const AVAIL_FILE = join(REPO, 'data', 'linkedin-availability.json');
const POLL_UNIT = 'career-ops-linkedin-poll.service';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const bot = readJson(BOT_STATE, { pendingEdits: {}, pendingSave: {}, healthAlerted: false, lastHealth: 0, lastReminders: 0 });
const saveBot = () => writeFileSync(BOT_STATE, JSON.stringify(bot, null, 2));

async function api(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return await r.json();
  } catch { return {}; }
}
const clamp = (t) => { const b = String(t || '(no output)'); return b.length > 3900 ? '…\n' + b.slice(-3900) : b; };
const send = (text, extra = {}) => api('sendMessage', { chat_id: ALLOWED, text: clamp(text), disable_web_page_preview: true, ...extra });

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cmd, args, { cwd: REPO, env: process.env });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve(`[exit ${code}]\n${out}`));
    p.on('error', (e) => resolve('spawn error: ' + e.message));
  });
}

/** Set KEY=value in deploy/.env (the poller reads it at the start of every run). */
export function setEnvLine(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
}
const envValue = (key) => (new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(ENV_FILE, 'utf8')) || [])[1]?.trim();

/** "/slots Mon-Wed 09:00-17:00; Thu 09:00-15:00" -> { Mon: [...], Tue: [...], Wed: [...], Thu: [...] }. */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function parseSlots(spec) {
  const windows = {};
  for (const part of String(spec).split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{3})(?:\s*-\s*([A-Za-z]{3}))?\s+((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)+)$/.exec(part);
    if (!m) throw new Error(`can't read "${part}". Example: Mon-Wed 09:00-17:00; Thu 09:00-15:00`);
    const cap = (d) => d[0].toUpperCase() + d.slice(1, 3).toLowerCase();
    const a = DAYS.indexOf(cap(m[1])), b = m[2] ? DAYS.indexOf(cap(m[2])) : a;
    if (a < 0 || b < a) throw new Error(`bad day range in "${part}"`);
    const ranges = m[3].split(',').map((r) => r.replace(/\s+/g, '')).filter(Boolean).map((r) => r.replace(/\b(\d):/g, '0$1:'));
    for (let i = a; i <= b; i++) windows[DAYS[i]] = [...(windows[DAYS[i]] || []), ...ranges];
  }
  if (!Object.keys(windows).length) throw new Error('no windows given');
  return windows;
}
const slotsText = (w) => DAYS.filter((d) => w[d]).map((d) => `${d} ${w[d].join(', ')}`).join('\n') || '(none)';

function itemText(e, prefix = '') {
  const who = `${e.name || '?'}${e.company ? ' @ ' + e.company : ''}`;
  const lines = [`${prefix}${who}`, e.agent?.their_ask ? `They: ${e.agent.their_ask}` : `They: ${String(e.preview || '').slice(0, 200)}`];
  if (e.needs_you) lines.push(`Needs you: ${String(e.needs_you).split('\n  suggested:')[0]}`);
  else if (e.draft?.error) lines.push(`Problem: ${e.draft.error}`);
  if (e.slot) lines.push(`Time they picked: ${new Date(e.slot).toLocaleString('en-US', { timeZone: '<YOUR_TZ>', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT`);
  if (textOf(e)) lines.push(`Draft: ${textOf(e)}`);
  if (e.attachment) lines.push(`📎 ${e.attachment}`);
  lines.push(`ref ${handle(e.id)}`);
  return lines.join('\n');
}
const showItem = (e, prefix) => send(itemText(e, prefix), { reply_markup: { inline_keyboard: buttonsFor(e) } });

async function statusText() {
  const s = readJson(POLL_STATE, {});
  const age = s.lastRunAt ? Math.round((Date.now() - Date.parse(s.lastRunAt)) / 60000) : null;
  const unit = (await run('systemctl', ['--user', 'show', POLL_UNIT, '-p', 'Result', '--value'])).split('\n')[1] || '?';
  return [
    `Auto-send: ${envValue('LINKEDIN_AUTOSEND') === '1' ? 'ON' : 'OFF'}   Drafter: ${envValue('LINKEDIN_DRAFTER') || 'assist'}`,
    `Last poll: ${age == null ? 'never' : `${age} min ago`} (result: ${unit.trim()})`,
    `Today: ${s.sends?.date === new Date().toISOString().slice(0, 10) ? `${s.sends.messages || 0} messages, ${s.sends.invites || 0} invites sent` : 'nothing sent yet'}`,
    `Waiting on you: ${openItems().length}   In tonight's digest: ${(s.digest || []).length}`,
  ].join('\n');
}

const HELP = `LinkedIn
/queue - items waiting on you (with buttons)
/send <ref> [new text] - send the draft (or your text)
/edit <ref> <text> - send your text instead of the draft
/skip <ref> - drop it
/invite <ref> <linkedin url> - connect with the right person, then thank the referrer
/thread <name> - show the conversation
/draft <name>: <instruction> - have the agent write a reply for you to approve
/pause, /resume - auto-send off/on
/status, /run - poller state, poll now
/digest - send today's digest now
/score - last 7 days scorecard
/slots [Mon-Wed 09:00-17:00; Thu 09:00-15:00] - show or set call windows (CT)
Pipeline: /pipeline /sync /scan /report`;

async function afterSend(e, r, text, offerSave) {
  if (!r.ok) return send(`Not sent: ${r.error}`);
  await send(`Sent to ${e.name || 'them'} ✓${r.hold === true ? ' · calendar hold added' : r.hold === false ? ` · calendar hold failed: ${r.hold_error}` : ''}${r.invited ? ` · connected with ${r.invited}` : ''}`);
  if (offerSave) {
    bot.pendingSave[handle(e.id)] = text; saveBot();
    await send('Save your answer so the agent reuses it next time?', { reply_markup: { inline_keyboard: [[{ text: '💾 Save answer', callback_data: `save:${handle(e.id)}` }, { text: 'No', callback_data: `nosave:${handle(e.id)}` }]] } });
  }
}

/** Your own text for an item: recorded as a voice example, sent, then offered as a reusable answer. */
async function sendEdited(e, text) {
  recordEdit(e, text);
  const r = e.slot ? await confirmSlot(e, text) : await sendItem(e, text);
  return afterSend(e, r, text, true);
}

async function onCallback(q) {
  await api('answerCallbackQuery', { callback_query_id: q.id });
  const [verb, h] = String(q.data || '').split(':');
  const e = findItem(h);
  if (verb === 'nosave') { delete bot.pendingSave[h]; saveBot(); return send('Not saved.'); }
  if (!e) return send(`Item ${h} not found.`);
  if (verb === 'save') {
    const t = bot.pendingSave[h];
    if (!t) return send('Nothing to save for that item.');
    saveAnswer(e, t); delete bot.pendingSave[h]; saveBot();
    return send('Saved to data/linkedin-answers.md. The agent will reuse it.');
  }
  if (e.status === 'sent' || e.status === 'dismissed') return send(`Already ${e.status}: ${e.name || h}.`);
  if (verb === 'send') return afterSend(e, await sendItem(e, textOf(e)), textOf(e), false);
  if (verb === 'slot') return afterSend(e, await confirmSlot(e, textOf(e) || `Thanks ${String(e.name || '').split(' ')[0]}, that time works for me. Talk then!`), null, false);
  if (verb === 'invc') return afterSend(e, await inviteCandidate(e), null, false);
  if (verb === 'skip') { await skipItem(e); return send(`Skipped ${e.name || h}.`); }
  if (verb === 'edit') {
    const m = await send(`Reply to this message with the text to send to ${e.name || 'them'} (ref ${h}).`, { reply_markup: { force_reply: true, input_field_placeholder: 'Your reply' } });
    if (m.result?.message_id) { bot.pendingEdits[m.result.message_id] = h; saveBot(); }
  }
}

async function onMessage(text, replyTo) {
  // A reply to an "Edit" prompt is the new text for that item.
  if (replyTo && bot.pendingEdits[replyTo]) {
    const h = bot.pendingEdits[replyTo]; delete bot.pendingEdits[replyTo]; saveBot();
    const e = findItem(h);
    return e ? sendEdited(e, text) : send(`Item ${h} not found.`);
  }
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase().replace(/@\w+$/, '')) {
    case '/start': case '/help': return send(HELP);
    case '/queue': {
      const items = openItems();
      if (!items.length) return send('Nothing is waiting on you.');
      await send(`${items.length} waiting on you${items.length > 10 ? ' (showing 10)' : ''}:`);
      for (const e of items.slice(0, 10)) await showItem(e);
      return;
    }
    case '/send': case '/edit': {
      const [h, ...t] = rest; const e = h && findItem(h);
      if (!e) return send(`Usage: ${cmd} <ref>${cmd === '/edit' ? ' <text>' : ' [text]'}`);
      if (t.length) return sendEdited(e, t.join(' '));
      if (cmd === '/edit') return send('Add the text after the ref.');
      return afterSend(e, e.slot ? await confirmSlot(e, textOf(e)) : await sendItem(e, textOf(e)), textOf(e), false);
    }
    case '/skip': { const e = findItem(arg); if (!e) return send('Usage: /skip <ref>'); await skipItem(e); return send(`Skipped ${e.name || arg}.`); }
    case '/invite': { const [h, url] = rest; const e = h && findItem(h); if (!e || !url) return send('Usage: /invite <ref> <linkedin.com/in/... url>'); return afterSend(e, await inviteCandidate(e, url), null, false); }
    case '/pause': case '/resume': {
      writeFileSync(ENV_FILE, setEnvLine(readFileSync(ENV_FILE, 'utf8'), 'LINKEDIN_AUTOSEND', cmd === '/resume' ? '1' : '0'));
      return send(cmd === '/resume' ? 'Auto-send ON from the next poll.' : 'Auto-send OFF. Drafts still arrive here.');
    }
    case '/status': return send(await statusText());
    case '/run': await run('systemctl', ['--user', 'start', '--no-block', POLL_UNIT]); return send('Poll started.');
    case '/thread': {
      const e = arg && itemFor(arg);
      if (!e) return send('Usage: /thread <name> (someone already in the LinkedIn queue)');
      return send(`${e.name}${e.company ? ' @ ' + e.company : ''}\n\n${await threadText(e)}`);
    }
    case '/draft': {
      const m = /^([^:]+):\s*(.+)$/s.exec(arg) || /^(\S+)\s+(.+)$/s.exec(arg);
      const e = m && itemFor(m[1]);
      if (!e) return send('Usage: /draft <name>: <what you want to say>');
      await send(`Drafting a reply to ${e.name}…`);
      const { draftManaged } = await import('./draft-managed.mjs');
      const r = await manualDraft(e, m[2].trim(), draftManaged);
      return r.error ? send(`Draft failed: ${r.error}`) : showItem(r.item, 'Draft for your OK: ');
    }
    case '/digest': writeFileSync(DIGEST_FLAG, new Date().toISOString()); await run('systemctl', ['--user', 'start', '--no-block', POLL_UNIT]); return send('Digest coming in a moment (if anything is queued).');
    case '/score': return send(scorecard(readQueue()));
    case '/slots': {
      const cur = readJson(AVAIL_FILE, { timezone: '<YOUR_TZ>', windows: {} });
      if (!arg) return send(`Call windows (CT):\n${slotsText(cur.windows)}\n\nChange: /slots Mon-Wed 09:00-17:00; Thu 09:00-15:00`);
      try { cur.windows = parseSlots(arg); } catch (err) { return send(err.message); }
      writeFileSync(AVAIL_FILE, JSON.stringify(cur, null, 2) + '\n');
      return send(`Call windows set (CT):\n${slotsText(cur.windows)}`);
    }
    case '/pipeline': return send((await run('node', ['verify-pipeline.mjs'])) + '\n--- dashboard ---\n' + (await run('docker', ['compose', '-f', `${REPO}/docker-compose.yml`, 'ps'])));
    case '/sync': await send('Syncing Gmail…'); return send(await run('bash', [`${REPO}/deploy/sync-run.sh`]));
    case '/scan': await send('Starting scan + eval — I will reply when done (minutes).'); return send(await run('bash', [`${REPO}/deploy/agent-run.sh`]));
    case '/report': await send('Rebuilding report…'); return send(await run('node', ['scripts/build-report-html.mjs']));
    default: return send(`Unknown command.\n\n${HELP}`);
  }
}

/** Every ~10 min: poller health. Hourly: re-ping items held more than 24h, once each. */
async function background() {
  const now = Date.now();
  if (now - bot.lastHealth > 10 * 60_000) {
    bot.lastHealth = now;
    const last = Date.parse(readJson(POLL_STATE, {}).lastRunAt || 0);
    const stale = now - last > 30 * 60_000;
    if (stale && !bot.healthAlerted) { await send(`⚠️ The LinkedIn poller hasn't finished a run for ${Math.round((now - last) / 60000)} min. /status for details.`); bot.healthAlerted = true; }
    if (!stale && bot.healthAlerted) { await send('✅ The LinkedIn poller is running again.'); bot.healthAlerted = false; }
    saveBot();
  }
  if (now - bot.lastReminders > 60 * 60_000) {
    bot.lastReminders = now; saveBot();
    for (const e of openItems().filter((x) => x.status === 'needs_you' && !x.reminded_at && now - Date.parse(x.detected_at || x.occurred_at) > 24 * 3600_000)) {
      await showItem(e, '⏰ Still waiting on you (24h+): ');
      await update(e.id, { reminded_at: new Date().toISOString() });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!TOKEN || !ALLOWED) { console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID must be set in deploy/.env'); process.exit(1); }
  let offset = 0;
  console.log('career-ops telegram bot up (chat', ALLOWED, ')');
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`, { signal: AbortSignal.timeout(65_000) });
      const j = await r.json();
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const chat = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
        if (chat !== ALLOWED) continue;   // never answer strangers, not even "not authorized"
        try {
          if (u.callback_query) await onCallback(u.callback_query);
          else if (u.message?.text) await onMessage(u.message.text, u.message.reply_to_message?.message_id);
        } catch (err) { await send(`Error: ${String(err.message || err).slice(0, 300)}`); }
      }
      await background();
    } catch {
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
