// assist-server.mjs — read-only career-ops context service for the LinkedIn Copilot extension.
//
// Spec: docs/superpowers/specs/2026-08-23-linkedin-copilot-extension-design.md
//
// WHY THIS EXISTS SEPARATELY FROM webapp/server.js: that server exposes /api/update-status
// (write) and /api/open-pdf-location (local file operation). Tunnelling it would put both on
// the public internet. This service has a deliberately narrow, read-only surface and is the
// only thing on the tunnel.
//
// THE INVARIANT: this process opens no file for writing, and imports nothing that does. `POST`
// here means "I am sending you a body", never "mutate state". A test asserts the route table
// contains no write verbs; keep it that way.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, tokenEqual, extractToken, rateLimit, tokenFingerprint } from './auth.mjs';

export const ROOT = process.env.CAREER_OPS_ROOT || path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.ASSIST_PORT || 42836);
// Bind loopback only. cloudflared connects locally; the port is never directly exposed. Every
// other 428xx service on this box is bound the same way.
const HOST = process.env.ASSIST_HOST || '127.0.0.1';
const MAX_BODY = 512 * 1024;

const TOKEN = loadToken();

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
};

const readRaw = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > MAX_BODY) { req.destroy(); reject(new Error('payload too large')); }
  });
  req.on('end', () => resolve(b));
  req.on('error', reject);
});

const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > MAX_BODY) { req.destroy(); reject(new Error('payload too large')); }
  });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body is not valid JSON')); } });
  req.on('error', reject);
});

/**
 * Route table. Every entry is a read. `write: false` is asserted by the test suite rather than
 * being decorative — a route that mutates anything must not be added here.
 */
export const ROUTES = [
  { method: 'GET', path: '/health', auth: false, write: false },
  { method: 'GET', path: '/api/assist/application/:ref', auth: true, write: false },
  { method: 'POST', path: '/api/assist/answers', auth: true, write: false },
  { method: 'POST', path: '/api/assist/draft', auth: true, write: false },
  { method: 'POST', path: '/api/assist/chat', auth: true, write: false },
  { method: 'GET', path: '/api/assist/context', auth: true, write: false },
  { method: 'GET', path: '/api/assist/person', auth: true, write: false },
  { method: 'GET', path: '/api/assist/people', auth: true, write: false },
  { method: 'GET', path: '/api/assist/thread', auth: true, write: false },
  // The agent loop. Read-only by construction: every tool in tools.mjs is a read or a draft
  // check — nothing sends, applies, or spends an invite.
  { method: 'POST', path: '/api/assist/agent', auth: true, write: false },
  // MCP exposes the same read-only toolset to external chat apps. Its auth is handled inside
  // the handler (token may arrive via ?token=), which is why `auth` is false here — the route
  // is not unauthenticated, it is authenticated differently.
  { method: 'POST', path: '/mcp', auth: false, write: false },
];

const log = (req, extra = {}) => {
  const parts = [new Date().toISOString(), req.method, req.url?.split('?')[0]];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  console.log('[assist] ' + parts.join(' '));
};

export function createServer(handlers = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      // MCP front door. Handled before the bearer-check because it carries its own auth (a
      // ?token= query param as well as headers — connector dialogs often have no header field),
      // and because it speaks JSON-RPC, so a 401 has to be shaped as a JSON-RPC error rather
      // than this service's plain {ok:false} body or clients report it as a protocol fault.
      if (p === '/mcp') {
        if (req.method !== 'POST') {
          // A connector probing with GET must not be left holding a stream that never closes —
          // that hangs the dialog instead of failing it cleanly.
          res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'This MCP endpoint accepts POST only.' }, id: null }));
        }
        log(req, { mcp: 1 });
        if (!handlers.mcp) return json(res, 501, { ok: false, error: 'MCP handler unavailable' });
        let raw = '';
        try { raw = await readRaw(req); } catch { /* transport will reject an empty body */ }
        return handlers.mcp(req, res, raw);
      }

      // Liveness is unauthenticated on purpose: it reports nothing about the user, and an
      // uptime check that needs a secret is a check nobody runs.
      if (p === '/health') {
        log(req);
        return json(res, 200, { ok: true, app: 'career-ops-assist', version: 1, root: ROOT });
      }

      const provided = extractToken(req, url);
      if (!provided || !tokenEqual(provided, TOKEN)) {
        log(req, { auth: 'reject' });
        res.setHeader('WWW-Authenticate', 'Bearer\x20realm="career-ops-assist"');
        return json(res, 401, { ok: false, error: 'valid token required' });
      }

      const fp = tokenFingerprint(provided);
      const rl = rateLimit(fp);
      if (!rl.ok) {
        log(req, { token: fp, rate: 'limited' });
        res.setHeader('Retry-After', Math.ceil(rl.resetInMs / 1000));
        return json(res, 429, { ok: false, error: 'rate limit exceeded', retry_in_ms: rl.resetInMs });
      }

      const body = req.method === 'POST' ? await readBody(req) : {};
      const ctx = { req, res, url, body, json: (c, b) => json(res, c, b), root: ROOT };

      const appMatch = /^\/api\/assist\/application\/(.+)$/.exec(p);
      if (appMatch && req.method === 'GET') {
        log(req, { token: fp });
        if (!handlers.application) return json(res, 501, { ok: false, error: 'not implemented yet' });
        return handlers.application({ ...ctx, ref: decodeURIComponent(appMatch[1]) });
      }

      for (const name of ['answers', 'draft', 'chat', 'agent']) {
        if (p === `/api/assist/${name}` && req.method === 'POST') {
          log(req, { token: fp });
          if (!handlers[name]) return json(res, 501, { ok: false, error: 'not implemented yet' });
          return handlers[name](ctx);
        }
      }

      for (const [route, key] of [['/api/assist/people', 'people'], ['/api/assist/thread', 'thread']]) {
        if (p === route && req.method === 'GET') {
          log(req, { token: fp });
          if (!handlers[key]) return json(res, 501, { ok: false, error: 'not implemented yet' });
          return handlers[key](ctx);
        }
      }

      if (p === '/api/assist/person' && req.method === 'GET') {
        log(req, { token: fp });
        if (!handlers.person) return json(res, 501, { ok: false, error: 'not implemented yet' });
        return handlers.person(ctx);
      }

      if (p === '/api/assist/context' && req.method === 'GET') {
        log(req, { token: fp });
        if (!handlers.context) return json(res, 501, { ok: false, error: 'not implemented yet' });
        return handlers.context(ctx);
      }

      // A known path reached with the wrong verb is a client bug worth naming, and it keeps
      // "no write verbs" observable: PUT/PATCH/DELETE can never match a route above.
      const known = ROUTES.some((r) => r.path.replace(/:\w+/, '') === p || p.startsWith('/api/assist/application/'));
      if (known) {
        res.setHeader('Allow', ROUTES.filter((r) => p.startsWith(r.path.replace(/:\w+/, ''))).map((r) => r.method).join(', ') || 'GET');
        return json(res, 405, { ok: false, error: `${req.method} not allowed on ${p}` });
      }
      return json(res, 404, { ok: false, error: `no route for ${req.method} ${p}` });
    } catch (e) {
      const msg = String(e?.message || e);
      log(req, { error: msg.slice(0, 80) });
      if (!res.headersSent) json(res, msg.includes('JSON') || msg.includes('too large') ? 400 : 500, { ok: false, error: msg });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const handlers = {};
  // Feature modules attach as they land (build order steps 2 and 4). Absent ones return 501
  // rather than 404, so the extension can tell "not built yet" from "wrong URL".
  for (const [name, mod, exp] of [
    ['application', './resolve.mjs', 'handler'],
    ['answers', './answers.mjs', 'handler'],
    ['draft', './draft.mjs', 'handler'],
    ['chat', './draft.mjs', 'chatHandler'],
    ['context', './context.mjs', 'handler'],
    ['person', './person.mjs', 'handler'],
    ['people', './people.mjs', 'searchHandler'],
    ['thread', './people.mjs', 'threadHandler'],
    ['agent', './agent.mjs', 'agentHandler'],
  ]) {
    try {
      const m = await import(mod);
      if (m[exp]) handlers[name] = m[exp];
    } catch (e) { console.warn(`[assist] ${name} handler unavailable: ${e.message}`); }
  }
  // MCP is wired separately: it needs the token and root, not the ctx shape the others take.
  try {
    const { createMcpHandler } = await import('./mcp.mjs');
    handlers.mcp = createMcpHandler({ root: ROOT, token: TOKEN });
  } catch (e) { console.warn(`[assist] MCP unavailable: ${e.message}`); }

  createServer(handlers).listen(PORT, HOST, () => {
    console.log(`[assist] listening on http://${HOST}:${PORT}`);
    console.log(`[assist] career-ops root: ${ROOT}`);
    console.log(`[assist] handlers: ${Object.keys(handlers).join(', ') || '(none — /health only)'}`);
    console.log(`[assist] token fingerprint: ${tokenFingerprint(TOKEN)}`);
    if (handlers.mcp) console.log('[assist] MCP at POST /mcp?token=… (connect a chat app here)');
  });
}
