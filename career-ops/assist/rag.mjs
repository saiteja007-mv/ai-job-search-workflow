// rag.mjs — retrieval over the career-ops corpus.
//
// The agent needs to answer "what does this JD ask for", "have I applied to X", "what does my
// CV say about Y" without the whole corpus in the prompt (98 JDs + a 152 KB tracker + CV files
// is far past any context window worth paying for).
//
// BM25 over locally-built chunks, deliberately — no embedding service, no vector store, no
// network call on the retrieval path, and it works offline. Job hunting is keyword-shaped
// ("Kubernetes", "Snowflake", "H-1B", a company name), which is exactly what lexical scoring
// is good at. ponytail: swap in embeddings only if a real query is observed to fail lexically.
//
// Read-only, and the source boundary is an allowlist of directories — never a denylist — so a
// stray .env or credential file in the repo can't be retrieved into a prompt.
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_SOURCES, readSource } from './grounding.mjs';

const MAX_CHUNK = 4000;      // chars; big enough for a JD section, small enough to cite
const MAX_SNIPPET = 600;

// Strip HTML (JDs are scraped markup) and collapse whitespace.
const detag = (s) => String(s ?? '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// The trailing class keeps real tokens intact — node.js, c++, gpt-4, 3.5 — but that also means
// a word ending a sentence swallows its full stop ("kubernetes." != "kubernetes") and then never
// matches the same word typed as a query. Strip trailing punctuation after matching, not during,
// so the useful interior punctuation survives.
const tokenize = (s) => (String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) || [])
  .map((t) => t.replace(/[.\-+#]+$/, ''))
  .filter((t) => t.length > 1);

// Split long text on blank lines, packing paragraphs up to MAX_CHUNK.
function chunkText(text, max = MAX_CHUNK) {
  const paras = String(text).split(/\n\s*\n/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length > max) { out.push(buf.trim()); buf = ''; }
    buf += (buf ? '\n\n' : '') + p;
    while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

const readFileSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const statMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

// Corpus directories walked recursively. Anything dropped into one of these is picked up on the
// next query — no restart, no reindex command.
//
// `reports` is retrievable but is NOT a content-generation source: per the repo's
// Source-of-Truth Boundary, user-facing text may only draw on cv/profile/article-digest/
// writing-samples/interview-prep. A report is <YOUR_NAME>'s own past *assessment of a job*, which is
// exactly right for "what did I think of Anthropic" and exactly wrong as a CV claim. It is
// tagged as its own kind so the boundary stays visible to the model and to whoever reads this.
const CORPUS_DIRS = [
  { dir: 'jds', kind: 'jd' },
  { dir: 'reports', kind: 'report' },
];
const DOC_EXT = /\.(txt|md)$/i;

/** Every .txt/.md under `rel`, recursively. Returns repo-relative paths. */
function walk(root, rel, out = [], depth = 0) {
  if (depth > 4) return out; // corpus dirs are shallow; this only bounds a pathological tree
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, child, out, depth + 1);
    else if (DOC_EXT.test(e.name)) out.push(child);
  }
  return out;
}

// ---- corpus builders -------------------------------------------------------

// JDs are "Company: / Role: / Location: / URL:" then an HTML body. Reports are markdown with a
// "**Score:** / **URL:**" header. Both are walked recursively — 556 of the 634 JD files live in
// dated subdirectories (jds/fresh-2026-08-11/ and friends), and a flat readdir silently indexed
// only the 78 at the top level.
function dirDocs(root, { dir, kind }) {
  const docs = [];
  for (const rel of walk(root, dir)) {
    const raw = readFileSafe(path.join(root, rel));
    if (!raw) continue;
    const name = rel.split('/').pop();
    const head = Object.fromEntries(
      (raw.slice(0, 1200).match(/^\**(Company|Role|Location|URL|Score|Status)\**:.*$/gim) || [])
        .map((l) => {
          const i = l.indexOf(':');
          return [l.slice(0, i).replace(/\*/g, '').trim().toLowerCase(), l.slice(i + 1).replace(/\*/g, '').trim()];
        }));
    const title = kind === 'report'
      ? `${name.replace(DOC_EXT, '')}${head.score ? ` (${head.score})` : ''}`
      : ([head.company, head.role, head.location].filter(Boolean).join(' — ') || name);
    chunkText(detag(raw)).forEach((text, i) => docs.push({
      id: `${kind}:${rel.slice(dir.length + 1)}#${i}`, kind, title, path: rel,
      company: head.company || null, role: head.role || null, url: head.url || null,
      score: head.score || null, text,
    }));
  }
  return docs;
}

// CV / profile / voice — the same allowlist the drafting guardrail uses, so retrieval can never
// surface a source that drafting is forbidden to cite.
function profileDocs(root) {
  const docs = [];
  for (const src of ALLOWED_SOURCES) {
    const rels = src.endsWith('/')
      ? (() => { try { return fs.readdirSync(path.join(root, src)).map((f) => src + f); } catch { return []; } })()
      : [src];
    for (const rel of rels) {
      const text = readSource(root, rel);
      if (!text) continue;
      chunkText(detag(text)).forEach((t, i) => docs.push({
        id: `profile:${rel}#${i}`, kind: 'profile', title: rel, path: rel, text: t,
      }));
    }
  }
  return docs;
}

// One doc per tracked application, from the canonical tracker parser.
function applicationDocs(root, listTrackerRows) {
  let rows = [];
  try { rows = listTrackerRows(root) || []; } catch { return []; }
  // The canonical parser calls the application number `num` (not appNumber) — reading the wrong
  // field silently produced "#?" titles, which is exactly the detail the agent needs to cite.
  return rows.filter((r) => r && (r.company || r.role)).map((r) => ({
    id: `app:${r.num ?? r.company}`, kind: 'application',
    title: `#${r.num ?? '?'} ${r.company ?? ''} — ${r.role ?? ''}`.trim(),
    path: 'tracker', appNumber: r.num ?? null, company: r.company ?? null, role: r.role ?? null,
    text: [`Application #${r.num ?? '?'}`, `Company: ${r.company ?? ''}`, `Role: ${r.role ?? ''}`,
      r.status ? `Status: ${r.status}` : '', r.score ? `Score: ${r.score}` : '',
      r.date ? `Applied: ${r.date}` : '', r.notes ? `Notes: ${r.notes}` : ''].filter(Boolean).join('\n'),
  }));
}

// ---- index -----------------------------------------------------------------

const cache = new Map(); // root -> { builtAt, sig, docs, df, avgLen }

// How often the corpus is re-walked to look for new or edited documents. A full walk of ~1,300
// files costs ~20ms, which is fine occasionally and wasteful on every keystroke-fast query, so
// the signature itself is cached for this long. In practice: drop a file in, and the next query
// more than SIG_TTL_MS later indexes it. No restart, no reindex command.
const SIG_TTL_MS = Number(process.env.ASSIST_RAG_SIG_TTL_MS ?? 5_000);
const sigCache = new Map(); // root -> { at, sig }

function corpusSignature(root, { force = false } = {}) {
  const hit = sigCache.get(root);
  if (!force && hit && Date.now() - hit.at < SIG_TTL_MS) return hit.sig;

  // Count + newest mtime per corpus dir. Counting catches additions and deletions; the max
  // mtime catches edits to a file that already existed — watching the directory's own mtime
  // (the previous approach) caught neither reliably, since editing a file in place does not
  // change its parent directory's timestamp.
  const parts = [];
  for (const c of CORPUS_DIRS) {
    const files = walk(root, c.dir);
    let newest = 0;
    for (const f of files) { const m = statMs(path.join(root, f)); if (m > newest) newest = m; }
    parts.push(`${c.dir}:${files.length}:${Math.round(newest)}`);
  }
  parts.push(`tracker:${statMs(path.join(root, 'AGENT_HANDOFF.md'))}`);
  for (const s of ALLOWED_SOURCES) {
    if (s.endsWith('/')) {
      const files = walk(root, s.replace(/\/$/, ''));
      let newest = 0;
      for (const f of files) { const m = statMs(path.join(root, f)); if (m > newest) newest = m; }
      parts.push(`${s}${files.length}:${Math.round(newest)}`);
    } else {
      parts.push(`${s}:${statMs(path.join(root, s))}`);
    }
  }
  const sig = parts.join('|');
  sigCache.set(root, { at: Date.now(), sig });
  return sig;
}

export function buildIndex(root, { listTrackerRows, force = false } = {}) {
  const sig = corpusSignature(root, { force });
  const hit = cache.get(root);
  if (!force && hit && hit.sig === sig) return hit;

  const docs = [...CORPUS_DIRS.flatMap((c) => dirDocs(root, c)), ...profileDocs(root)];
  if (listTrackerRows) docs.push(...applicationDocs(root, listTrackerRows));

  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    d.tokens = tokenize(`${d.title} ${d.text}`);
    d.len = d.tokens.length;
    totalLen += d.len;
    d.tf = new Map();
    for (const t of d.tokens) d.tf.set(t, (d.tf.get(t) || 0) + 1);
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const index = { builtAt: Date.now(), sig, docs, df, avgLen: docs.length ? totalLen / docs.length : 1 };
  cache.set(root, index);
  return index;
}

const K1 = 1.5, B = 0.75;

/**
 * Retrieve the best-matching chunks. `kind` narrows to jd | profile | application.
 * Returns snippets, not whole documents — the agent calls get_document when it needs the rest.
 */
export function search(root, query, { kind, limit = 6, listTrackerRows, force = false } = {}) {
  const q = tokenize(query);
  if (!q.length) return { ok: false, error: 'empty query', results: [] };
  const idx = buildIndex(root, { listTrackerRows, force });
  const pool = kind ? idx.docs.filter((d) => d.kind === kind) : idx.docs;
  if (!pool.length) return { ok: true, query, count: 0, results: [] };

  const N = idx.docs.length;
  const scored = [];
  for (const d of pool) {
    let score = 0;
    for (const t of new Set(q)) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (idx.df.get(t) || 0) + 0.5) / ((idx.df.get(t) || 0) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / idx.avgLen))));
    }
    if (score > 0) scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const results = scored.slice(0, limit).map(({ d, score }) => ({
    id: d.id, kind: d.kind, title: d.title, path: d.path, score: Math.round(score * 100) / 100,
    company: d.company ?? null, role: d.role ?? null, url: d.url ?? null,
    appNumber: d.appNumber ?? null,
    snippet: snippetFor(d.text, q),
  }));
  return { ok: true, query, kind: kind || 'all', count: scored.length, returned: results.length, results };
}

// Centre the snippet on the densest run of query terms, so the agent sees the matching passage
// rather than whichever boilerplate happens to open the document.
function snippetFor(text, qTokens) {
  const body = String(text);
  if (body.length <= MAX_SNIPPET) return body;
  const want = new Set(qTokens);
  const low = body.toLowerCase();
  let best = 0, bestHits = -1;
  for (let i = 0; i < body.length - MAX_SNIPPET; i += 200) {
    // Uses the same tokenizer as the index — a snippet scorer that tokenizes differently
    // centres the excerpt on the wrong passage.
    const hits = tokenize(low.slice(i, i + MAX_SNIPPET))
      .reduce((n, t) => n + (want.has(t) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; best = i; }
  }
  return (best ? '…' : '') + body.slice(best, best + MAX_SNIPPET).trim() + '…';
}

/** Full text of one retrieved chunk, or the whole file when the caller wants context around it. */
export function getDocument(root, id, { whole = false, listTrackerRows } = {}) {
  const idx = buildIndex(root, { listTrackerRows });
  const doc = idx.docs.find((d) => d.id === id);
  if (!doc) return { ok: false, error: `no document ${id}` };
  if (!whole || doc.kind === 'application') {
    return { ok: true, id, kind: doc.kind, title: doc.title, path: doc.path, text: doc.text };
  }
  const siblings = idx.docs.filter((d) => d.path === doc.path).sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, id, kind: doc.kind, title: doc.title, path: doc.path, whole: true,
    text: siblings.map((d) => d.text).join('\n\n') };
}

export function stats(root, opts = {}) {
  const idx = buildIndex(root, opts);
  const byKind = {};
  for (const d of idx.docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  return { chunks: idx.docs.length, terms: idx.df.size, byKind };
}
