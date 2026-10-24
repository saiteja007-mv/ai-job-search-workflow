// Bearer-auth for the assist service.
//
// The service sits behind a PUBLIC Cloudflare Tunnel and, per the design spec §6, Cloudflare
// Access is not configured on any of the 16 existing hostnames. So this token carries the whole
// load today, and it must keep carrying it even after Access lands in front — the app never
// trusts the tunnel alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Read env at CALL time, not module load. Capturing it at import freezes the value before a
// caller (or a test) can set it, which silently ignores configuration and is impossible to
// diagnose from the outside.
const dataDir = () => process.env.ASSIST_DATA || path.join(import.meta.dirname, 'data');
const tokenFile = () => path.join(dataDir(), 'assist-token.txt');

/** Generated once and persisted; regenerating on every boot would break the installed extension. */
export function loadToken() {
  if (process.env.ASSIST_TOKEN) return process.env.ASSIST_TOKEN.trim();
  const file = tokenFile();
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* fall through and mint one */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir(), { recursive: true });
  // mode on write only applies at creation; chmod too so a pre-existing loose file is tightened.
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return t;
}

/**
 * Constant-time compare. Hash both sides to a fixed width first: timingSafeEqual throws on
 * length mismatch, and catching that throw would itself leak the length through timing.
 */
export function tokenEqual(a, b) {
  const h = (v) => crypto.createHash('sha256').update(String(v ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/**
 * Accept the token as `Authorization: bearer-scheme`, `x-assist-token`, or `?token=`.
 * The query form exists because a Chrome extension's EventSource cannot set headers on a
 * streaming GET — not for convenience.
 */
export function extractToken(req, url) {
  const authz = req.headers['authorization'] || '';
  if (authz.startsWith('Bearer ')) return authz.slice(7).trim();
  if (req.headers['x-assist-token']) return String(req.headers['x-assist-token']).trim();
  return url?.searchParams?.get('token') || '';
}

// --- rate limiting -----------------------------------------------------------
// Per-token fixed window. Free models are the real bottleneck, so this exists to stop a runaway
// extension loop hammering the box, not to meter a paying caller.
const WINDOW_MS = 60_000;
const defaultMax = () => Number(process.env.ASSIST_RATE_MAX || 60);
const hits = new Map();

export function rateLimit(key, max = defaultMax(), now = Date.now()) {
  const bucket = hits.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return { ok: true, remaining: max - 1, resetInMs: WINDOW_MS };
  }
  bucket.count += 1;
  const remaining = max - bucket.count;
  return {
    ok: remaining >= 0,
    remaining: Math.max(0, remaining),
    resetInMs: WINDOW_MS - (now - bucket.start),
  };
}

export function resetRateLimits() { hits.clear(); }

/** A stable, non-reversible id for logs — never log the token itself. */
export const tokenFingerprint = (t) =>
  crypto.createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex').slice(0, 8);
