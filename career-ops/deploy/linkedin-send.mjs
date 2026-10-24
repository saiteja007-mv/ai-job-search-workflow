/**
 * linkedin-send.mjs — send ONE message in an EXISTING LinkedIn conversation through the local
 * LinkedIn MCP (~/linkedin-mcp, port 42834). Going through the MCP rather than Unipile directly
 * is deliberate: the MCP writes the outreach ledger server-side, so check_contacted and the
 * career-ops contact history stay true (raw Unipile sends bypass the ledger — memory
 * `raw-unipile-send-bypasses-ledger`). There is intentionally NO invitation path here.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.LINKEDIN_MCP_PORT || 42834);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

function token() {
  if (process.env.LINKEDIN_MCP_TOKEN) return process.env.LINKEDIN_MCP_TOKEN.trim();
  return readFileSync(join(process.env.HOME || '', 'linkedin-mcp', 'data', 'mcp-token.txt'), 'utf8').trim();
}

let id = 0;
async function rpc(method, params) {
  const res = await fetch(`${URL_}?token=${encodeURIComponent(token())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  const line = text.split('\n').map((l) => l.replace(/^data: /, '')).find((l) => l.startsWith('{'));
  if (!line) throw new Error(`linkedin-mcp HTTP ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(line);
  if (j.error) throw new Error(`linkedin-mcp ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

/** Read-only connectivity check: does the MCP answer and expose send_message? */
export async function linkedInSendAvailable() {
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'career-ops-poller', version: '1' } });
    const r = await rpc('tools/list', {});
    return (r.tools || []).some((t) => t.name === 'send_message');
  } catch { return false; }
}

/** Returns { ok, message_id, raw } or { ok:false, error }. Never throws. */
// attachment_path: a PDF relative to career-ops/output (the MCP refuses anything else).
export async function sendLinkedInMessage({ chat_id, text, name, company, role, provider_id, public_id, attachment_path }) {
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'career-ops-poller', version: '1' } });
    const r = await rpc('tools/call', {
      name: 'send_message',
      arguments: { chat_id, text, name: name || undefined, company: company || undefined, role: role || undefined,
                   provider_id: provider_id || undefined, public_id: public_id || undefined,
                   attachment_path: attachment_path || undefined, origin: 'career-ops-poller' },
    });
    const body = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) return { ok: false, error: body.slice(0, 200) };
    let message_id = null, parsed = null;
    try { parsed = JSON.parse(body); message_id = parsed.message_id || null; } catch { message_id = (/"message_id"\s*:\s*"([^"]+)"/.exec(body) || [])[1] || null; }
    // A refusal (e.g. a bad attachment path) comes back as { sent: false, error }, not isError.
    if (parsed?.sent === false) return { ok: false, error: String(parsed.error || 'not sent').slice(0, 200) };
    return { ok: true, message_id, raw: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

/** First message to a NEW connection (no chat yet). Returns { ok, chat_id, message_id } or { ok:false, error }. */
export async function startLinkedInChat({ attendee_id, text, name, company, role }) {
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'career-ops-poller', version: '1' } });
    const r = await rpc('tools/call', { name: 'start_chat', arguments: { attendee_id, text, name: name || undefined, company: company || undefined, role: role || undefined, origin: 'career-ops-poller' } });
    const body = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) return { ok: false, error: body.slice(0, 200) };
    let j = {}; try { j = JSON.parse(body); } catch {}
    return { ok: true, chat_id: j.chat_id || (/"chat_id"\s*:\s*"([^"]+)"/.exec(body) || [])[1] || null, message_id: j.message_id || null, raw: body.slice(0, 300) };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}

/** Generic MCP tool call. Returns parsed JSON when the tool returns JSON text, else the raw text. */
export async function linkedInTool(name, args) {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'career-ops-poller', version: '1' } });
  const r = await rpc('tools/call', { name, arguments: args });
  const body = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`${name}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return body; }
}

/**
 * Referral hand-off: someone in a thread pointed me to a named person at their company.
 * Find that person, verify the employer from the headline (never the name), and send a
 * connection invitation that names who referred me. Returns a result object; never throws.
 * Guardrails: the MCP's send_invitation runs check_contacted + the invite budget itself.
 */
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * Pick the referred person out of a people search. `hit` = name matches AND the headline names
 * the employer. Otherwise `unverified` = the ONE result whose name is exactly the referred name,
 * when its headline names no employer at all (<CONTACT_NAME>, <COMPANY_W> 2026-10-07: "Technology
 * Recruiting Expert"). Never invited automatically, but surfaced instead of silently dropped.
 */
export function pickReferralHit(items, person, company) {
  const want = normName(person).split(' ');
  const comp = normName(company);
  const nameMatch = (n) => { const h = normName(n); return want.every((w) => w.length < 2 || h.includes(w)); };
  const employerOk = (it) => !it.past_association && comp && normName(it.employer_from_headline).includes(comp.split(' ')[0]);
  const hit = items.find((it) => nameMatch(it.name) && employerOk(it));
  if (hit) return { hit };
  const exact = items.filter((it) => normName(it.name) === normName(person));
  const unverified = exact.length === 1 && !exact[0].employer_from_headline ? exact[0] : null;
  return { unverified, near: items.filter((it) => nameMatch(it.name)).map((it) => `${it.name} — ${it.headline}`).slice(0, 3) };
}

/** The public id in a linkedin.com/in/<id> URL, or null. */
export const linkedInHandle = (url) => { const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url || '')); return m ? decodeURIComponent(m[1]) : null; };

/**
 * profileUrl: the exact profile the referrer shared. That IS the identity, so no name search or
 * employer guess is needed. skipInvite: the poller's own daily invite cap is used up.
 * When the invite is refused (already pending, budget used up, the cap), an Open Profile gets the
 * same note as a free InMail instead (<YOUR_NAME>, 2026-10-15); anything else is held for a human.
 */
export async function inviteReferredPerson({ person, company, referrer, role, note, profileUrl, skipInvite = false }) {
  try {
    let hit;
    const handle = linkedInHandle(profileUrl);
    if (handle) {
      const p = await linkedInTool('get_profile', { identifier: handle });
      if (!p?.provider_id) return { ok: false, needs_you: true, error: `could not open the shared profile ${profileUrl}` };
      hit = { id: p.provider_id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || person, headline: p.headline || '', url: profileUrl, is_open_profile: p.is_open_profile };
    } else {
      const q = [person, company].filter(Boolean).join(' ');
      const res = await linkedInTool('search', { category: 'people', keywords: q });
      const picked = pickReferralHit(res.items || [], person, company);
      if (!picked.hit) {
        const { unverified, near } = picked;
        if (unverified) {
          let open = null;
          try { open = Boolean((await linkedInTool('get_profile', { identifier: unverified.id })).is_open_profile); } catch { /* unknown */ }
          return { ok: false, needs_you: true, candidate: { name: unverified.name, headline: unverified.headline, url: unverified.url, provider_id: unverified.id, location: unverified.location || null, is_open_profile: open },
            error: `found exactly one ${person} but the headline names no employer ("${unverified.headline}") — check it is ${company}` };
        }
        return { ok: false, needs_you: true, error: near.length ? `found ${person} but employer did not verify: ${near.join(' | ')}` : `no LinkedIn match for ${person} at ${company}` };
      }
      hit = picked.hit;
    }
    const contacted = await linkedInTool('check_contacted', { provider_id: hit.id });
    if (contacted && contacted.contacted) return { ok: false, error: `${hit.name} already contacted`, profile: hit };
    let refused = skipInvite ? 'poller daily invite cap reached' : null;
    if (!refused) {
      const inv = await linkedInTool('send_invitation', { provider_id: hit.id, message: note, name: hit.name, company, role: role || undefined, origin: 'career-ops-poller' });
      // send_invitation never throws for a LinkedIn refusal: it returns { sent: false, reason }.
      if (inv?.sent === false) refused = inv.reason || 'invitation refused';
      else {
        const id = inv?.invitation_id || inv?.career_ops?.invitation_id || (inv?.unipile_response || {}).invitation_id || null;
        return { ok: true, profile: hit, invitation_id: id };
      }
    }
    let open = hit.is_open_profile;
    if (open == null) { try { open = Boolean((await linkedInTool('get_profile', { identifier: hit.id })).is_open_profile); } catch { open = false; } }
    if (!open) return { ok: false, needs_you: true, candidate: { name: hit.name, headline: hit.headline, url: hit.url, provider_id: hit.id, is_open_profile: false }, error: `invite not sent (${refused}) and the profile is not Open, so no free InMail` };
    const first = String(referrer || '').split(/\s+/)[0];
    const m = await linkedInTool('start_chat', { attendee_id: hit.id, text: note, inmail: true, subject: first ? `${first} suggested I reach out` : 'Introduction',
      name: hit.name, company, role: role || undefined, origin: 'career-ops-poller' });
    if (m?.sent) return { ok: true, profile: hit, inmail: true, chat_id: m.chat_id || null };
    return { ok: false, needs_you: true, candidate: { name: hit.name, headline: hit.headline, url: hit.url, provider_id: hit.id, is_open_profile: true }, error: `invite not sent (${refused}) and the InMail failed` };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

// ── No company names from the resume in LinkedIn text (<YOUR_NAME>, 2026-10-08) ──────────────────────
// Employers come from the CVs' Experience headings ("### Role | Company | Place"), read on every call
// so a CV edit applies at once. The recipient's own company — or one whose name contains it
// ("<PAST_EMPLOYER> Aerospace" for <PAST_EMPLOYER>) — may still be named. Shared by the poller and warm-outbound;
// the linkedin MCP enforces the same rule server-side, and tsenta_unipile_outreach.py in Python.
const CO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export function resumeCompanies(root = CO_ROOT) {
  const out = new Set();
  for (const f of ['cv-aiml.md', 'cv.md']) {
    let t = '';
    try { t = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const exp = t.split(/^## /m).find((sec) => /^Experience\b/i.test(sec)) || '';
    for (const m of exp.matchAll(/^###\s+[^|\n]+\|\s*([^|\n]+?)\s*(?:\||$)/gm)) out.add(m[1].trim());
  }
  return [...out];
}
const nameRe = (c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
export const pastEmployers = (theirCompany, list = resumeCompanies()) => list.filter((c) => !nameRe(c).test(String(theirCompany || '')));
/** The first resume employer the text names, or null. */
export function pastEmployerIn(text, theirCompany, list = resumeCompanies()) {
  return pastEmployers(theirCompany, list).find((c) => nameRe(c).test(String(text || ''))) || null;
}
