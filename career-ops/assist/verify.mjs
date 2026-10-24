// verify.mjs — cite-then-verify. Spec §3.
//
// The model returns `claims: [{text, sourceFile, sourceQuote}]`. This checks each sourceQuote
// actually occurs in that file.
//
// The whole point: THE MODEL ASSERTING A SOURCE IS NOT EVIDENCE. A free model will happily
// produce a confident, well-formatted citation to a quote that does not exist. The substring
// check is mechanical and cannot be argued with.
import { isAllowedSource, readSource } from './grounding.mjs';

/**
 * Normalize for comparison only — never for storage.
 * Models reflow whitespace, swap quote characters and normalize dashes when they echo a
 * quote, so a raw === would reject genuine citations and train the user to ignore the flag.
 * This is deliberately lenient about FORM and strict about CONTENT.
 */
export function normalizeForMatch(s) {
  return String(s ?? '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const MIN_QUOTE_CHARS = 12;

/**
 * Verify one claim.
 *
 * Failure modes are reported distinctly, because they mean different things:
 *   disallowed_source — the model cited a file outside the Source-of-Truth Boundary
 *   missing_source    — cited an allowed file that does not exist here
 *   quote_not_found   — the quote is not in the file (the hallucination case)
 *   quote_too_short   — too short to be evidence of anything
 */
export function verifyClaim(root, claim) {
  const out = { ...claim, verified: false, reason: null };
  const file = claim?.sourceFile;
  const quote = claim?.sourceQuote;

  if (!file || !quote) { out.reason = 'missing_citation'; return out; }
  if (!isAllowedSource(file)) { out.reason = 'disallowed_source'; return out; }

  const text = readSource(root, file);
  if (text == null) { out.reason = 'missing_source'; return out; }

  const q = normalizeForMatch(quote);
  if (q.length < MIN_QUOTE_CHARS) { out.reason = 'quote_too_short'; return out; }

  if (normalizeForMatch(text).includes(q)) { out.verified = true; return out; }
  out.reason = 'quote_not_found';
  return out;
}

/** Verify a list of claims and summarize. */
export function verifyClaims(root, claims = []) {
  const results = (Array.isArray(claims) ? claims : []).map((c) => verifyClaim(root, c));
  const verified = results.filter((r) => r.verified);
  const unverified = results.filter((r) => !r.verified);
  return {
    results,
    verifiedCount: verified.length,
    unverifiedCount: unverified.length,
    // Spec §3: an unverified claim does not suppress the draft — it flags it red and marks the
    // draft "contains unverified claims". Hiding the draft would push the user to a worse tool.
    containsUnverified: unverified.length > 0,
    sources: [...new Set(verified.map((r) => r.sourceFile))],
  };
}

/**
 * Parse the model's JSON envelope.
 *
 * Spec §7: structured output is unreliable on free models. Ask for JSON; on parse failure the
 * caller retries once; on the second failure fall back to a plain draft marked "sources
 * unavailable, verify manually" — never silently drop the guardrails.
 */
export function parseModelEnvelope(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty', draft: '', claims: [] };

  const attempts = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) attempts.push(fenced[1].trim());
  const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (braced.length > 2) attempts.push(braced);

  for (const a of attempts) {
    try {
      const o = JSON.parse(a);
      if (o && typeof o === 'object' && typeof o.draft === 'string') {
        return { ok: true, draft: o.draft, claims: Array.isArray(o.claims) ? o.claims : [] };
      }
    } catch { /* try the next shape */ }
  }
  // Not JSON at all: keep the prose as the draft and say the citations are unavailable, so the
  // panel shows "verify manually" rather than pretending it was grounded.
  return { ok: false, reason: 'unparseable', draft: text, claims: [] };
}
