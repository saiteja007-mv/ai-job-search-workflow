// grounding.mjs — the safety layer. Spec §3.
//
// Two independent mechanisms, deliberately not sharing a failure mode:
//
//   1. CITE-THEN-VERIFY (verify.mjs) — the model must attach a source quote to each claim, and
//      the server checks that quote really occurs in that file. The model ASSERTING a source is
//      not evidence; the substring check is.
//   2. DETERMINISTIC FILTERS (here) — regex and structural rules that run regardless of what the
//      model returned. A weak free model cannot be talked out of these, because they are not
//      asking it anything.
//
// Read-only: this module opens no file for writing.
import fs from 'node:fs';
import path from 'node:path';

// Spec §3: sources allowed for content generation, and nothing else. Not the tracker notes,
// not memory, not other repos. Mirrors the Source-of-Truth Boundary in AGENTS.md.
export const ALLOWED_SOURCES = [
  'cv-aiml.md',
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'voice-dna.md',
  'writing-samples/',
  'interview-prep/',
];

let RULES = null;
export function loadRules(root = process.cwd(), file) {
  if (RULES && !file) return RULES;
  const p = file || path.join(import.meta.dirname, 'never-claim.json');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!file) RULES = parsed;
  return parsed;
}
export const resetRules = () => { RULES = null; };

/** Is this path inside the allowed set? Used before any file is read for grounding. */
export function isAllowedSource(rel) {
  const clean = String(rel ?? '').replace(/^\.\//, '');
  if (clean.includes('..')) return false;
  return ALLOWED_SOURCES.some((a) => (a.endsWith('/') ? clean.startsWith(a) : clean === a));
}

/** Load an allowed source. Returns null for anything outside the boundary, or missing. */
export function readSource(root, rel) {
  if (!isAllowedSource(rel)) return null;
  const abs = path.join(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/**
 * Which allowed sources actually exist. voice-dna.md is documented optional in DATA_CONTRACT.md
 * and is genuinely absent on this install, so its absence must degrade, never throw.
 */
export function availableSources(root) {
  const out = [];
  for (const rel of ALLOWED_SOURCES) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const files = fs.readdirSync(abs).filter((f) => /\.(md|txt|ya?ml)$/.test(f));
        if (files.length) out.push({ rel, kind: 'dir', entries: files.length });
      } else {
        out.push({ rel, kind: 'file', bytes: st.size });
      }
    } catch { /* absent is fine — report what exists, not what is missing */ }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a word-boundary matcher for a term.
 *
 * WORD BOUNDARIES ARE THE POINT. The known-bug reference in the spec is `itar` matching inside
 * "military" — a substring check flags an honest sentence and trains the user to ignore
 * warnings. \b on both ends, and for terms whose first/last char is not a word character
 * (e.g. "Node.js"), \b would never fire there, so guard with a non-word lookaround instead.
 */
export function termMatcher(term, caseSensitive = false) {
  const e = escapeRe(term);
  const left = /^\w/.test(term) ? '\\b' : '(?<![\\w])';
  const right = /\w$/.test(term) ? '\\b' : '(?![\\w])';
  return new RegExp(left + e + right, caseSensitive ? 'g' : 'gi');
}

const sentences = (text) =>
  String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/**
 * NEVER-CLAIM scan. Returns one finding per distinct term, with the sentence it appeared in so
 * the panel can show the user exactly what to change.
 */
export function scanNeverClaim(text, rules = loadRules()) {
  const findings = [];
  for (const entry of rules.neverClaim || []) {
    const re = termMatcher(entry.term, entry.caseSensitive);
    for (const s of sentences(text)) {
      re.lastIndex = 0;
      if (!re.test(s)) continue;
      // Ambiguous short words ("Go", "Ray", "Claude") only count when programming context is
      // nearby — otherwise every honest sentence containing "go" trips the filter.
      const lower = s.toLowerCase();
      if (entry.requireContext?.length) {
        if (!entry.requireContext.some((c) => lower.includes(c.toLowerCase()))) continue;
      }
      // A banned term can be a substring of a DIFFERENT, legitimate thing. Measured on the real
      // CV: banning "Llama" (the model family) also flagged "llama.cpp", which is the local
      // serving runtime the CV genuinely documents. Word boundaries do not help — llama.cpp is
      // a real word boundary. Only an explicit exclusion distinguishes them.
      if (entry.exclude?.length && entry.exclude.some((x) => lower.includes(x.toLowerCase()))) continue;
      findings.push({ rule: 'never-claim', term: entry.term, sentence: s.slice(0, 240), note: entry.note || null });
      break; // one finding per term is enough to act on
    }
  }
  return findings;
}

/**
 * The three facts that must never merge. Spec §3: a draft that merges them is REJECTED, not
 * warned. Scoped to a single sentence — mentioning <CURRENT_EMPLOYER> in one sentence and edge work in
 * another is accurate; asserting them as one fact is the fabrication.
 */
export function scanNeverMerge(text, rules = loadRules()) {
  const findings = [];
  for (const m of rules.neverMerge || []) {
    for (const s of sentences(text)) {
      const lower = s.toLowerCase();
      const hasA = m.groupA.some((t) => termMatcher(t).test(lower));
      const hasB = m.groupB.some((t) => termMatcher(t).test(lower));
      if (!hasA || !hasB) continue;
      // When `forbidden` is set, the merge is only a violation if a forbidden qualifier is
      // also present (<CURRENT_EMPLOYER> + LLM is fine; <CURRENT_EMPLOYER> + LLM + "edge" is not).
      if (m.forbidden?.length) {
        const bad = m.forbidden.filter((t) => termMatcher(t).test(lower));
        if (!bad.length) continue;
        findings.push({ rule: 'never-merge', id: m.id, why: m.rule, offending: bad, sentence: s.slice(0, 240), fatal: true });
      } else {
        findings.push({ rule: 'never-merge', id: m.id, why: m.rule, sentence: s.slice(0, 240), fatal: true });
      }
      break;
    }
  }
  return findings;
}

/** Spec §3: no em dashes in application-answer output; ranges written "to". */
export function scanStyle(text, { applicationAnswer = true } = {}) {
  const findings = [];
  if (!applicationAnswer) return findings;
  if (/[—–]/.test(text)) {
    findings.push({ rule: 'style', term: 'em-dash', sentence: (sentences(text).find((s) => /[—–]/.test(s)) || '').slice(0, 240) });
  }
  return findings;
}

/** Apply the style rule rather than only reporting it — ranges become "to", dashes become commas. */
export function stripEmDashes(text) {
  return String(text ?? '')
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')   // 3–5 years -> 3 to 5 years
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([.,;:])/g, '$1');
}

/**
 * Authorship guard. Spec §3 and AGENTS.md: never claim the user authored a tool unless it is
 * attributed to them in the CV. Tool-of-trade conflation (uses X -> built X) is named in
 * AGENTS.md as the most common fabrication pattern.
 */
export function scanAuthorship(text, cvText = '') {
  const findings = [];
  const re = /\bI\s+(?:built|created|authored|developed|wrote|designed|invented|founded)\s+([A-Z][\w.+-]*(?:\s+[A-Z][\w.+-]*){0,3})/g;
  let m;
  while ((m = re.exec(text))) {
    const subject = m[1].trim().replace(/[.,;:]$/, '');
    // Ignore generic objects — the guard is about named artefacts, not "I built a pipeline".
    if (/^(A|An|The|My|This|That|We|It)\b/i.test(subject)) continue;
    if (!cvText) { findings.push({ rule: 'authorship', subject, sentence: m[0], unverifiable: true }); continue; }
    if (!termMatcher(subject.split(/\s+/)[0]).test(cvText)) {
      findings.push({ rule: 'authorship', subject, sentence: m[0].slice(0, 240) });
    }
  }
  return findings;
}

/**
 * Run every deterministic filter.
 *
 * `fatal` means the draft is rejected outright (spec: never-merge is "rejected, not warned").
 * Anything else is surfaced as a warning the user can see and judge.
 */
export function runFilters(text, { root, cvText, applicationAnswer = true, rules } = {}) {
  const r = rules || loadRules();
  const cv = cvText ?? (root ? (readSource(root, 'cv-aiml.md') || readSource(root, 'cv.md') || '') : '');
  const findings = [
    ...scanNeverClaim(text, r),
    ...scanNeverMerge(text, r),
    ...scanStyle(text, { applicationAnswer }),
    ...scanAuthorship(text, cv),
  ];
  return {
    ok: findings.length === 0,
    fatal: findings.some((f) => f.fatal),
    findings,
    summary: findings.length ? findings.map((f) => `${f.rule}:${f.term || f.id || f.subject}`).join(', ') : 'clean',
  };
}
