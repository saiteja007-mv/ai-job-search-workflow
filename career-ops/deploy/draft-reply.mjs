/**
 * draft-reply.mjs — ask the local assist server for a grounded reply draft.
 *
 * Calls POST /api/assist/draft, which already does the work that matters: it pulls prior
 * outreach so a reply cannot repeat an opener, pulls company context, runs the local model
 * fleet from assist/models.json (so this costs nothing per draft), and refuses outright to
 * draft from empty context rather than inventing one.
 *
 * A draft produced here is a STARTING POINT, never an approved message. Nothing in this file
 * sends anything, and the thread must be re-read at send time: a draft written at detection
 * and read hours later has not seen whatever arrived in between.
 */
import { loadToken } from '../assist/auth.mjs';

const HOST = process.env.ASSIST_HOST || '127.0.0.1';
const PORT = Number(process.env.ASSIST_PORT || 42836);
const BASE = `http://${HOST}:${PORT}`;

/**
 * Returns { text, model } on success, or { error } — never throws and never blocks the queue.
 * A missing assist server is an ordinary outcome here, not a failure worth losing an event over:
 * the notification still goes out, just without a draft.
 */
export async function draftReply({ messages, correspondent, headline, providerId, publicId, profileUrl, company, role, instruction }, { timeoutMs = 110_000 } = {}) {
  if (!messages?.length) return { error: 'no thread to draft from' };
  let token;
  try { token = loadToken(); } catch (e) { return { error: `no assist token: ${e.message}` }; }

  try {
    const res = await fetch(`${BASE}/api/assist/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageType: 'message',
        instruction: instruction || undefined,
        extracted: { messages, correspondent, headline, providerId, publicId, profileUrl, company, role },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `assist ${res.status}: ${body.error || 'unknown'}` };

    // The draft is NESTED under `result`, alongside model and claims. Reading body.draft
    // returns undefined on a perfectly successful generation, which reports as "no draft"
    // and hides a working server behind a client bug.
    const text = body.result?.draft || body.result?.text || null;
    if (!text) return { error: 'assist returned no draft' };

    // The server runs its own relevance check. WITHHOLD rather than pass a draft it failed.
    // Verified 2026-09-04: asked what team was hiring and for a job link, the model answered
    // with an unrelated GitHub repo and invented an org structure ("<COMPANY_AD> sits
    // under AI/ML Engineering") with no source. The server flagged it relevant:false and this
    // client ignored the field, so it would have reached the phone looking authoritative.
    // A draft that confidently answers the exact question it cannot answer is worse than none.
    // FAIL CLOSED: withhold unless the server AFFIRMS relevant === true. Withholding only on
    // an explicit `false` passes every draft through whenever the field is absent — a server
    // error path, a response-shape change, a refactor — which is precisely the day the check
    // is load-bearing. An absent verdict is not a pass.
    const relevance = body.relevance || body.result?.relevance || null;
    if (relevance?.relevant !== true) {
      const why = relevance ? (relevance.reason || 'failed relevance check') : 'no relevance verdict returned';
      return { error: `withheld: ${why}`, withheld: String(text).trim() };
    }

    return {
      text: String(text).trim(),
      model: body.result?.model || body.model || null,
      claims: body.result?.claims || null,
    };
  } catch (e) {
    // Timeout, connection refused, server down. Say which, so a silent absence of drafts
    // is diagnosable rather than mysterious.
    return { error: String(e.message || e).slice(0, 120) };
  }
}

/** True if the assist server is up. Cheap, unauthenticated, used to skip drafting fast. */
export async function assistUp() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
