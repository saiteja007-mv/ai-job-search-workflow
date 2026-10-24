#!/usr/bin/env node
/**
 * outreach-dashboard.mjs — one read-only page for the LinkedIn auto-reply pipeline.
 *
 * Shows: what came in, how it was triaged, what was drafted, what was SENT (and why not),
 * acceptances, poll runs, and system health (assist server, Codex auth, LinkedIn MCP, timer).
 * Reads local files + journalctl only. Writes nothing. No action buttons on purpose: this is
 * exposed on the public internet behind HTTP Basic auth (deploy/dashboard.env, scrypt hash).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash, scryptSync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'deploy', 'dashboard.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const PORT = Number(env.DASH_PORT || 42837);
const [SALT, HASH] = String(env.DASH_PASS_SCRYPT || '$').split('$');

// ---- auth: HTTP Basic, constant-time compare, per-IP lockout ----
const fails = new Map();
function clientIp(req) { return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress; }
// Behind Authentik (2026-10-08): after the Google login the outpost adds X-Authentik-Proof (a secret
// only Authentik and this app know, AUTHENTIK_PROOF in dashboard.env) next to X-authentik-email.
// Both must match; the email header alone is forgeable. Basic auth still works without them.
const sha = (s) => createHash('sha256').update(String(s ?? '')).digest();
const viaAuthentik = (req) => Boolean(env.AUTHENTIK_PROOF) && req.headers['x-authentik-email'] === (env.AUTHENTIK_OWNER_EMAIL || '<YOUR_EMAIL>') &&
  timingSafeEqual(sha(req.headers['x-authentik-proof']), sha(env.AUTHENTIK_PROOF));
function authed(req) {
  if (viaAuthentik(req)) return true;
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.count >= 10 && Date.now() - f.at < 15 * 60_000) return 'locked';
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');
  const ok = user === env.DASH_USER && (() => { try { return timingSafeEqual(scryptSync(pass, SALT, 64), Buffer.from(HASH, 'hex')); } catch { return false; } })();
  if (!ok) fails.set(ip, { count: (f?.count || 0) + 1, at: Date.now() }); else fails.delete(ip);
  return ok;
}

// ---- data ----
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); } catch { return ''; } };
const envFile = (p) => Object.fromEntries((() => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })().split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

function events() {
  return readJsonl(path.join(ROOT, 'data', 'linkedin-events.jsonl')).map((e) => ({
    ...e, thread: undefined, thread_len: (e.thread || []).length,
  })).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
}
function eventById(id) { return readJsonl(path.join(ROOT, 'data', 'linkedin-events.jsonl')).find((e) => e.id === id) || null; }

function runs() {
  const out = sh('journalctl', ['--user', '-u', 'career-ops-linkedin-poll.service', '-n', '400', '--no-pager', '-o', 'short-iso']);
  const list = []; let cur = null;
  for (const line of out.split('\n')) {
    const ts = line.slice(0, 25);
    if (/Starting career-ops-linkedin-poll/.test(line)) cur = { started: ts, lines: [] };
    else if (cur && /: (accepted=|queued |relations:|chats:|Error|error|Unipile)/.test(line)) cur.lines.push(line.replace(/^.*?env\[\d+\]: /, ''));
    else if (cur && /Finished career-ops-linkedin-poll|Failed with result|Deactivated/.test(line)) { cur.finished = ts; cur.ok = /Finished/.test(line); list.push(cur); cur = null; }
  }
  if (cur) list.push({ ...cur, running: true });
  return list.reverse().slice(0, 40);
}

function jwtExp(token) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000; } catch { return null; } }
async function system() {
  const pollEnv = envFile(path.join(ROOT, 'deploy', '.env'));
  const state = readJson(path.join(ROOT, 'deploy', 'linkedin-poll-state.json'), {});
  const codex = readJson(path.join(process.env.HOME, '.codex', 'auth.json'), null);
  const models = readJson(path.join(ROOT, 'assist', 'models.json'), {});
  const timers = sh('systemctl', ['--user', 'list-timers', 'career-ops-linkedin-poll.timer', '--no-pager']).split('\n')[1] || '';
  const ping = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } };
  const ledger = readJson(path.join(ROOT, 'data', 'outreach_log.json'), { events: [] }).events || [];
  const since = (d) => Date.now() - d * 86400_000;
  const byChan = (d) => { const m = {}; for (const e of ledger) { if (Date.parse(e.sent_at) > since(d)) m[e.channel || '?'] = (m[e.channel || '?'] || 0) + 1; } return m; };
  return {
    autosend: pollEnv.LINKEDIN_AUTOSEND === '1', invite_cap: Number(pollEnv.LINKEDIN_INVITE_DAILY_CAP || 10), max_drafts: Number(pollEnv.LINKEDIN_POLL_MAX_DRAFTS || 3),
    state, timer_line: timers.trim(),
    assist_up: await ping('http://127.0.0.1:42836/health'), linkedin_mcp_up: await ping('http://127.0.0.1:42834/'),
    codex: codex ? { last_refresh: codex.last_refresh, access_expires_at: jwtExp(codex.tokens?.access_token || '') ? new Date(jwtExp(codex.tokens.access_token)).toISOString() : null } : null,
    models: models.preferred || [],
    ledger_7d: byChan(7), ledger_30d: byChan(30),
    poll_service_active: sh('systemctl', ['--user', 'is-active', 'career-ops-linkedin-poll.timer']).trim(),
  };
}

// ---- http ----
const html = fs.readFileSync(path.join(ROOT, 'deploy', 'outreach-dashboard.html'), 'utf8');
const server = http.createServer(async (req, res) => {
  const a = authed(req);
  res.setHeader('Cache-Control', 'no-store');
  if (a === 'locked') { res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('Too many failed logins. Try again in 15 minutes.'); }
  if (!a) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="outreach", charset="UTF-8"', 'content-type': 'text/plain' }); return res.end('Sign in required.'); }
  const url = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname === '/api/events') return json(events());
    if (url.pathname === '/api/event') return json(eventById(url.searchParams.get('id') || ''));
    if (url.pathname === '/api/runs') return json(runs());
    if (url.pathname === '/api/system') return json(await system());
    if (url.pathname === '/health') return json({ ok: true });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[outreach-dashboard] http://127.0.0.1:${PORT}`));
