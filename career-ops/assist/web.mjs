// web.mjs — live web search and page fetch, via Perplexity's pplx CLI.
//
// pplx is already installed and authenticated on this machine (credentials at
// ~/.config/perplexity/credentials.json), so this needs no key handling of its own. Its failure
// contract is unusual and worth stating: every failure exits non-zero with EMPTY stdout and a
// single JSON error object on STDERR. Parsing stdout on failure yields nothing and looks like
// "no results" — so this module branches on stderr, not on an empty result set.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PPLX = process.env.PPLX_BIN || path.join(os.homedir(), '.local', 'bin', 'pplx');
const TIMEOUT_MS = 90_000;
const MAX_CHARS = 12_000; // what we hand back to the model, per call

function run(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(PPLX, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err || !String(stdout).trim()) {
        let detail = String(stderr || err?.message || 'pplx failed').trim();
        try { const j = JSON.parse(detail); detail = `${j.error?.code || 'error'}: ${j.error?.message || detail}`; } catch { /* plain text */ }
        return resolve({ ok: false, error: detail.slice(0, 400) });
      }
      try { resolve({ ok: true, data: JSON.parse(stdout) }); }
      catch { resolve({ ok: false, error: 'pplx returned unparseable output' }); }
    });
  });
}

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…[truncated]' : t; };

/**
 * Live web search. `domains` narrows to specific sites; `recencyDays` bounds freshness.
 * Note pplx treats extra positional queries as REWORDINGS of one question, not separate
 * searches — so this deliberately passes exactly one query.
 */
export async function webSearch(query, { limit = 5, domains, recencyDays } = {}) {
  if (!String(query || '').trim()) return { ok: false, error: 'empty query' };
  const args = ['search', 'web', String(query), '-n', String(Math.min(Math.max(limit, 1), 10))];
  if (domains?.length) args.push('--domains', domains.join(','));
  // Don't combine recency with date bounds — the server rejects that pairing outright.
  if (recencyDays) args.push('--recency-filter', recencyDays <= 1 ? 'day' : recencyDays <= 7 ? 'week' : recencyDays <= 31 ? 'month' : 'year');

  const r = await run(args);
  if (!r.ok) return r;
  const hits = (r.data?.hits || []).map((h) => ({
    title: h.title, url: h.url, domain: h.domain,
    snippet: clip(h.snippet || h.summary, 700), last_updated: h.last_updated || null,
  }));
  return { ok: true, query, count: hits.length, results: hits };
}

/** Fetch and extract one page's readable content. Always check `paywalled` before trusting text. */
export async function fetchUrl(url, { maxChars = MAX_CHARS } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'url must be http(s)' };
  const r = await run(['content', 'fetch', String(url)]);
  if (!r.ok) return r;
  const d = r.data || {};
  // pplx reports per-page failure INSIDE a successful response — an unchecked `content` here
  // would hand the model an empty string as if the page said nothing.
  if (d.error) return { ok: false, error: String(d.error).slice(0, 300), url };
  const text = String(d.content ?? d.text ?? '');
  return {
    ok: true, url: d.url || url, title: d.title || null,
    paywalled: Boolean(d.is_paywall), chars: text.length,
    content: clip(text, maxChars),
  };
}
