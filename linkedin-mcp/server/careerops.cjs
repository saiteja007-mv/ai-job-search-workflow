// careerOpsLogger — records LinkedIn sends made through this MCP into the career-ops data
// files, so outreach sent from ChatGPT / Claude Desktop / Codex is visible to Hermes and the
// career-ops dashboard instead of vanishing into Unipile.
//
// THE CARDINAL RULE: the send has already succeeded by the time anything here runs. Logging
// must never throw into the caller and must never turn a delivered invitation into an error
// the model might retry. Every entry point returns a status object; failures land in a
// recovery JSONL for backfill.
//
// Schemas were read from the live files, and differ from the obvious guesses:
//   outreach_log.json  = { version, events: [...], sent_profiles: { <provider_id>: {...} } }
//                        `sent_profiles` is career-ops' existing dedupe map — 779 entries —
//                        so an invite must update it or career-ops will re-invite the person.
//   contacts.json      = { generated_at, candidate, applications: [ { appNumber, contacts: [...] } ] }
//                        Contacts are NESTED under applications; the parent's appNumber is
//                        what links a contact to the dashboard.
//   contact-status.json= { "<appNumber>": "Sent" | ... } — keyed by APPLICATION, not contact,
//                        with a fixed status vocabulary taken from webapp/server.js.
const fs = require('node:fs')
const path = require('node:path')

const CO = process.env.CAREER_OPS_DIR || '/home/<YOU>/career-ops'
const DATA = path.join(CO, 'data')
const LOG_FILE = path.join(DATA, 'outreach_log.json')
const CONTACTS_FILE = path.join(DATA, 'contacts.json')
const STATUS_FILE = path.join(DATA, 'contact-status.json')
const LOCK_FILE = path.join(DATA, '.mcp-outreach.lock')
const FAIL_DIR = path.join(CO, 'reports', 'unipile-outreach')

// Matches webapp/server.js VALID_CONTACT_STATUSES — writing anything else would make the
// dashboard reject the row.
const VALID_STATUS = ['Not Started', 'Sent', 'Responded', 'No Response', 'Details Wrong', 'Skipped']
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Local ISO with offset (…-05:00), matching the convention of the most recent career-ops
// events. A bare Z would still parse but would read as a different wall-clock time to anyone
// scanning the log by eye.
function localIso(d = new Date()) {
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(off / 60)}:${p(off % 60)}`
}
const dayOf = (iso) => String(iso || '').slice(0, 10)

// Normalised for dedupe comparison only — never written back.
const normMsg = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

// --- file primitives ---------------------------------------------------------

// Exclusive-create is atomic on POSIX, so this is a real mutex between processes that honour
// it. NOTE: the career-ops python scripts and webapp do NOT take this lock — it protects
// concurrent MCP sends from each other, not from an unrelated writer mid-run.
function withLock(fn) {
  const start = Date.now()
  let fd
  for (;;) {
    try { fd = fs.openSync(LOCK_FILE, 'wx'); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // A process killed mid-write would otherwise wedge every later send.
      try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); continue } } catch { /* raced; retry */ }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('timed out waiting for the career-ops outreach lock')
      sleepSync(50)
    }
  }
  try {
    fs.writeSync(fd, String(process.pid))
    return fn()
  } finally {
    fs.closeSync(fd)
    try { fs.unlinkSync(LOCK_FILE) } catch { /* already gone */ }
  }
}

// Write to a temp file in the SAME directory, then rename — rename is atomic within a
// filesystem, so a crash can never leave a half-written 888 KB log behind.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// Last-resort sink. If the log itself cannot be written, the event must still survive
// somewhere a backfill can find it.
function recordFailure(kind, event, error) {
  try {
    fs.mkdirSync(FAIL_DIR, { recursive: true })
    const f = path.join(FAIL_DIR, `mcp-log-failures-${dayOf(localIso())}.jsonl`)
    fs.appendFileSync(f, JSON.stringify({ kind, error: String(error?.message || error), event, at: localIso() }) + '\n')
    return f
  } catch { return null }
}

// --- dedupe ------------------------------------------------------------------

function isDuplicateInvite(events, evt) {
  return events.some((e) => {
    if (evt.invitation_id && e.invitation_id && e.invitation_id === evt.invitation_id) return true
    if (!evt.provider_id || e.provider_id !== evt.provider_id) return false
    return dayOf(e.sent_at) === dayOf(evt.sent_at) && normMsg(e.message) === normMsg(evt.message)
  })
}

function isDuplicateDm(events, evt) {
  return events.some((e) => {
    if (evt.message_id && e.message_id && e.message_id === evt.message_id) return true
    if (!evt.chat_id || e.chat_id !== evt.chat_id) return false
    return dayOf(e.sent_at) === dayOf(evt.sent_at) && normMsg(e.message) === normMsg(evt.message)
  })
}

// --- contacts ----------------------------------------------------------------

const lastPathSegment = (u) => String(u || '').replace(/\/+$/, '').split('/').pop().toLowerCase()

// Match on the strongest identifier available. public_id is compared against the tail of the
// stored profile URL because most contacts predate provider_id being captured at all
// (only 39 of 580 carry one).
function findContact(contacts, { provider_id, public_id, linkedin }) {
  const pid = public_id && String(public_id).toLowerCase()
  const link = linkedin && lastPathSegment(linkedin)
  for (const app of contacts.applications || []) {
    for (const c of app.contacts || []) {
      if (provider_id && c.provider_id === provider_id) return { app, contact: c, matched_on: 'provider_id' }
      if (pid && String(c.public_id || '').toLowerCase() === pid) return { app, contact: c, matched_on: 'public_id' }
      const tail = lastPathSegment(c.linkedinProfileLink || c.linkedin)
      if (tail && (tail === pid || (link && tail === link))) return { app, contact: c, matched_on: 'linkedin_url' }
    }
  }
  return null
}

// career-ops stores the same value under two names in several places. Whichever side the
// dashboard or a script happens to read, it must see the update — so set both.
function syncAliases(c, evt) {
  if (evt.name) { c.name = c.name || evt.name; c.profileName = c.profileName || evt.name }
  if (evt.linkedin) { c.linkedin = c.linkedin || evt.linkedin; c.linkedinProfileLink = c.linkedinProfileLink || evt.linkedin }
  if (evt.provider_id) c.provider_id = evt.provider_id
  if (evt.public_id) c.public_id = evt.public_id
  if (evt.invitation_id) c.invitation_id = evt.invitation_id
  if (evt.message) {
    c.connectionNote = c.connectionNote || evt.message
    c.messages = c.messages || {}
    if (!c.messages.linkedinConnect) c.messages.linkedinConnect = evt.message
  }
  c.dateSent = dayOf(evt.sent_at)
  c.sentAt = evt.sent_at
  c.status = 'sent'
  c.sentVia = 'unipile-linkedin-mcp'
  if (evt.unipile_status) c.unipile_status = evt.unipile_status
}

// --- the write ---------------------------------------------------------------

function appendEvent(evt, { isDuplicate, updateSentProfiles }) {
  return withLock(() => {
    const log = readJson(LOG_FILE)
    if (!Array.isArray(log.events)) throw new Error('outreach_log.json has no events array')

    if (isDuplicate(log.events, evt)) {
      return { logged: false, duplicate: true, reason: 'an equivalent event is already in outreach_log.json' }
    }
    log.events.push(evt)

    // sent_profiles is career-ops' own "have we already contacted this person" map. Skipping
    // it is how the same recruiter gets invited twice from two different clients.
    if (updateSentProfiles && evt.provider_id) {
      log.sent_profiles = log.sent_profiles || {}
      const prev = log.sent_profiles[evt.provider_id] || {}
      log.sent_profiles[evt.provider_id] = {
        ...prev,
        name: evt.name || prev.name,
        public_id: evt.public_id || prev.public_id,
        company: evt.company || prev.company,
        role: evt.role || prev.role,
        invitation_id: evt.invitation_id || prev.invitation_id,
        channel: evt.channel || prev.channel,
        sent_at: dayOf(evt.sent_at),
      }
    }
    writeJsonAtomic(LOG_FILE, log)

    const linked = linkContact(evt)
    return { logged: true, duplicate: false, events: log.events.length, ...linked }
  })
}

// Best-effort: a send we cannot attribute to a known contact is still logged, just flagged.
function linkContact(evt) {
  if (!evt.provider_id && !evt.public_id && !evt.linkedin) return { contact_linked: false }
  try {
    const contacts = readJson(CONTACTS_FILE)
    const hit = findContact(contacts, evt)
    if (!hit) return { contact_linked: false }
    syncAliases(hit.contact, evt)
    writeJsonAtomic(CONTACTS_FILE, contacts)

    // contact-status is keyed by the parent application's number, so a contact with no
    // appNumber simply has no status row to update — that is not an error.
    let status_updated = false
    const num = hit.app?.appNumber
    if (num != null) {
      const statuses = fs.existsSync(STATUS_FILE) ? readJson(STATUS_FILE) : {}
      const want = 'Sent'
      if (VALID_STATUS.includes(want) && statuses[String(num)] !== want) {
        statuses[String(num)] = want
        writeJsonAtomic(STATUS_FILE, statuses)
        status_updated = true
      }
    }
    return { contact_linked: true, matched_on: hit.matched_on, contact_name: hit.contact.name || null, appNumber: num ?? null, status_updated }
  } catch (e) {
    // A contacts.json problem must not discard an already-written outreach event.
    recordFailure('contact-link', evt, e)
    return { contact_linked: false, contact_link_error: String(e.message || e) }
  }
}

// --- public API --------------------------------------------------------------

// `needs_backfill` means "this event cannot be acted on without more work". That is not only
// about identity: an invite with no company/role cannot be attributed to an application, which
// is the whole point of logging it here. An explicit value from the caller always wins, so a
// reconstructed event can declare itself incomplete even when every field is populated.
const needsBackfill = (a) => (a.needs_backfill !== undefined
  ? Boolean(a.needs_backfill)
  : !(a.name && a.public_id && a.provider_id && a.company && a.role))

function buildInviteEvent(a) {
  // sent_at is overridable so a historical send can be backfilled at its real time rather
  // than stamped "now", which would corrupt the same-day dedupe window.
  const sent_at = a.sent_at || localIso()
  return {
    channel: 'linkedin_connection_invite',
    action: 'linkedin_invite',
    sent_at,
    origin: 'unipile-linkedin-mcp',
    external_origin: a.external_origin || 'unknown',
    account_id: a.account_id || null,
    name: a.name || null,
    linkedin: a.linkedin || (a.public_id ? `https://www.linkedin.com/in/${a.public_id}` : null),
    public_id: a.public_id || null,
    provider_id: a.provider_id || null,
    company: a.company || null,
    role: a.role || null,
    title: a.title || null,
    message: a.message || null,
    chars: a.message ? String(a.message).length : null,
    unipile_status: a.unipile_status ?? null,
    unipile_response: a.unipile_response || null,
    invitation_id: a.invitation_id || null,
    source: a.source || 'unipile-linkedin-mcp',
    needs_backfill: needsBackfill(a),
  }
}

function buildDmEvent(a) {
  const sent_at = a.sent_at || localIso()
  return {
    channel: 'linkedin_dm',
    sent_at,
    origin: 'unipile-linkedin-mcp',
    external_origin: a.external_origin || 'unknown',
    account_id: a.account_id || null,
    chat_id: a.chat_id || null,
    name: a.name || null,
    linkedin: a.linkedin || (a.public_id ? `https://www.linkedin.com/in/${a.public_id}` : null),
    public_id: a.public_id || null,
    provider_id: a.provider_id || null,
    company: a.company || null,
    role: a.role || null,
    message: a.message || null,
    chars: a.message ? String(a.message).length : null,
    unipile_status: a.unipile_status ?? null,
    unipile_response: a.unipile_response || null,
    message_id: a.message_id || null,
    verified_in_chat: a.verified_in_chat ?? null,
    source: a.source || 'unipile-linkedin-mcp',
    needs_backfill: needsBackfill(a),
  }
}

// Both of these swallow their own errors on purpose — see the cardinal rule at the top.
function logInvite(args) {
  const evt = buildInviteEvent(args)
  try {
    return { ...appendEvent(evt, { isDuplicate: isDuplicateInvite, updateSentProfiles: true }), needs_backfill: evt.needs_backfill }
  } catch (e) {
    const recovery = recordFailure('invite', evt, e)
    return { logged: false, error: String(e.message || e), recovery_file: recovery, needs_backfill: true }
  }
}

// Only a PDF inside career-ops/output can be attached. This server is reachable by remote MCP
// clients, and an unrestricted path would let one post any file on this box into a LinkedIn chat.
function outputPdfAttachment(p) {
  const root = fs.realpathSync(path.join(CO, 'output'))
  let real
  try { real = fs.realpathSync(path.resolve(root, String(p))) } catch { return { error: `attachment not found: ${p}` } }
  if (!real.startsWith(root + path.sep) || !/.pdf$/i.test(real)) return { error: 'attachment must be a PDF inside career-ops/output' }
  return { name: path.basename(real), data: fs.readFileSync(real), type: 'application/pdf' }
}

function logDm(args) {
  const evt = buildDmEvent(args)
  try {
    return { ...appendEvent(evt, { isDuplicate: isDuplicateDm, updateSentProfiles: false }), needs_backfill: evt.needs_backfill }
  } catch (e) {
    const recovery = recordFailure('dm', evt, e)
    return { logged: false, error: String(e.message || e), recovery_file: recovery, needs_backfill: true }
  }
}

// --- preventive dedupe -------------------------------------------------------
// The log-time duplicate check fires AFTER Unipile has already sent, so on its own it stops
// a double log, not a double invite. This is the read a caller makes BEFORE sending.
function checkContacted({ provider_id, public_id, linkedin } = {}) {
  if (!provider_id && !public_id && !linkedin) throw new Error('provider_id, public_id or linkedin is required')
  const log = readJson(LOG_FILE)
  const pid = public_id && String(public_id).toLowerCase()
  const handle = linkedin && lastPathSegment(linkedin)

  if (provider_id && log.sent_profiles?.[provider_id]) {
    const p = log.sent_profiles[provider_id]
    return { contacted: true, via: 'sent_profiles', sent_at: p.sent_at || null, channel: p.channel || null,
      invitation_id: p.invitation_id || null, name: p.name || null, company: p.company || null, role: p.role || null }
  }
  // sent_profiles only covers invites, and only those with a provider_id — 60 older events
  // have no channel at all — so the event list is still worth scanning.
  const match = log.events.find((e) => {
    if (provider_id && e.provider_id === provider_id) return true
    const ep = String(e.public_id || e.public_identifier || '').toLowerCase()
    if (pid && ep === pid) return true
    const eh = lastPathSegment(e.linkedin)
    return Boolean(eh) && (eh === pid || (handle && eh === handle))
  })
  if (match) {
    return { contacted: true, via: 'outreach_log.events', sent_at: match.sent_at || null, channel: match.channel || null,
      invitation_id: match.invitation_id || null, name: match.name || null, company: match.company || null,
      role: match.role || null, message: match.message || null }
  }
  return { contacted: false }
}

// --- LinkedIn-side reconciliation ----------------------------------------------
// The local log only knows about sends that went through THIS server. Codex, the dashboard
// and scheduled runs all invite people without writing here: on 2026-09-01 LinkedIn's sent
// list held 812 invitations, 175 of whose provider_ids the local log had never seen, and two
// of those (shawnepiper, danielrobinsontu) were re-invited on the strength of a local
// "contacted: false" and rejected with 422 already_invited_recently. Duplicate invites are a
// known path to an account restriction; this account already carries observedBlock=112.
// So the pre-send check must consult LinkedIn's own record, and the local log is a cache.
const SENT_INDEX_TTL_MS = Number(process.env.LINKEDIN_MCP_SENT_TTL_MS || 7 * 60 * 1000)
const sentIndexCache = new Map() // account_id -> { fetchedAt, byPid, byPublic, dates, count }

async function getSentIndex(uni, account_id, { force = false } = {}) {
  const key = account_id || uni.defaultAccount?.() || 'default'
  const hit = sentIndexCache.get(key)
  if (!force && hit && Date.now() - hit.fetchedAt < SENT_INDEX_TTL_MS) return hit
  const items = await uni.allSentInvitations(account_id)
  const byPid = new Map(), byPublic = new Map(), dates = []
  for (const it of items) {
    const rec = {
      provider_id: it.invited_user_id || null,
      public_id: (it.invited_user_public_id || '').toLowerCase() || null,
      name: it.invited_user || null,
      sent_at: it.parsed_datetime || null,
      invitation_id: it.id || null,
      message: it.invitation_text || null,
    }
    if (rec.provider_id) byPid.set(rec.provider_id, rec)
    if (rec.public_id) byPublic.set(rec.public_id, rec)
    if (rec.sent_at) dates.push(rec.sent_at.slice(0, 10))
  }
  const idx = { fetchedAt: Date.now(), byPid, byPublic, dates, count: items.length }
  sentIndexCache.set(key, idx)
  return idx
}
const invalidateSentIndex = () => sentIndexCache.clear()

/** Invites LinkedIn shows as sent on `day` (YYYY-MM-DD) and in the 7 days ending on it. */
function sentCountsFromIndex(idx, day) {
  const dayMs = Date.parse(day + 'T00:00:00Z')
  let today = 0, trailing7 = 0
  for (const d of idx.dates) {
    if (d === day) today++
    const t = Date.parse(d + 'T00:00:00Z')
    if (t <= dayMs && dayMs - t < 7 * 86400000) trailing7++
  }
  return { today, trailing7 }
}

// --- attempts that did NOT result in a send ------------------------------------
// A 422 is correctly not logged as a send, but with no record of it the next run retries the
// same person and collects the same 422. This is the memory of those refusals.
const ATTEMPTS_FILE = path.join(DATA, 'outreach_attempts.json')
const readJsonOr = (file, fallback) => { try { return readJson(file) } catch { return fallback } }

function recordAttempt({ provider_id, public_id, name, company, role, reason, scope, status, detail, origin } = {}) {
  const evt = {
    at: new Date().toISOString(), provider_id: provider_id || null,
    public_id: public_id ? String(public_id).toLowerCase() : null, name: name || null,
    company: company || null, role: role || null, reason: reason || 'unknown', scope: scope || null,
    status: status ?? null, detail: detail ? String(detail).slice(0, 300) : null, origin: origin || null,
  }
  try {
    return withLock(() => {
      const log = readJsonOr(ATTEMPTS_FILE, { version: 1, attempts: [] })
      if (!Array.isArray(log.attempts)) log.attempts = []
      log.attempts.push(evt)
      if (log.attempts.length > 5000) log.attempts = log.attempts.slice(-5000)
      writeJsonAtomic(ATTEMPTS_FILE, log)
      return { recorded: true, count: log.attempts.length }
    })
  } catch (e) {
    return { recorded: false, error: String(e.message || e) }
  }
}

/** Most recent failed attempt on this person within `withinDays`, or null. */
function recentAttempt({ provider_id, public_id, linkedin } = {}, withinDays = 30) {
  const log = readJsonOr(ATTEMPTS_FILE, { attempts: [] })
  const pid = public_id ? String(public_id).toLowerCase() : (linkedin ? lastPathSegment(linkedin) : null)
  const cutoff = Date.now() - withinDays * 86400000
  for (let i = (log.attempts || []).length - 1; i >= 0; i--) {
    const a = log.attempts[i]
    if (Date.parse(a.at) < cutoff) break
    if ((provider_id && a.provider_id === provider_id) || (pid && a.public_id === pid)) return a
  }
  return null
}

/**
 * The full pre-send check: local log, then the attempts log, then LinkedIn's sent list.
 * Never throws on a LinkedIn failure — it degrades to the local answer and SAYS so, because a
 * batch that stops on a transient 5xx is annoying, but one that silently trusts a partial
 * answer is how duplicates get sent.
 */
async function checkContactedFull(uni, { provider_id, public_id, linkedin, account_id } = {}) {
  const local = checkContacted({ provider_id, public_id, linkedin })
  if (local.contacted) return { ...local, linkedin_check: 'skipped (local hit)' }

  const attempt = recentAttempt({ provider_id, public_id, linkedin })
  const withAttempt = attempt ? { last_failed_attempt: { at: attempt.at, reason: attempt.reason, scope: attempt.scope } } : {}

  let idx
  try { idx = await getSentIndex(uni, account_id) } catch (e) {
    return {
      contacted: false, ...withAttempt,
      linkedin_check: 'unavailable',
      warning: `LinkedIn's sent-invitation list could not be read (${String(e.message || e).slice(0, 120)}); this answer reflects the local log only, which is known to miss sends from other clients.`,
    }
  }
  const pid = public_id ? String(public_id).toLowerCase() : (linkedin ? lastPathSegment(linkedin) : null)
  const hit = (provider_id && idx.byPid.get(provider_id)) || (pid && idx.byPublic.get(pid)) || null
  if (hit) {
    return {
      contacted: true, via: 'linkedin_sent_invitations', linkedin_check: 'hit',
      sent_at: hit.sent_at, channel: 'linkedin_connection_invite', invitation_id: hit.invitation_id,
      name: hit.name, message: hit.message, ...withAttempt,
      note: 'LinkedIn shows a sent invitation that the local outreach log does not — it was sent from another client.',
    }
  }
  return { contacted: false, linkedin_check: 'miss', linkedin_sent_total: idx.count, ...withAttempt }
}

// --- send-time guards -----------------------------------------------------------
const NOTE_LIMIT = 300
// <YOUR_NAME>'s rule (2026-10-08): LinkedIn text never names a company from his resume — the employers
// in the CVs' Experience headings ("### Role | Company | Place"). Experience is described by role.
// Read on every call (two small files), so a CV edit applies without a restart. The recipient's own
// company — or one whose name contains it ("<PAST_EMPLOYER> Aerospace" for <PAST_EMPLOYER>) — may be named.
function resumeCompanies() {
  const out = new Set()
  for (const f of ['cv-aiml.md', 'cv.md']) {
    let t = ''
    try { t = fs.readFileSync(path.join(CO, f), 'utf8') } catch { continue }
    const exp = t.split(/^## /m).find((sec) => /^Experience\b/i.test(sec)) || ''
    for (const m of exp.matchAll(/^###\s+[^|\n]+\|\s*([^|\n]+?)\s*(?:\||$)/gm)) out.add(m[1].trim())
  }
  return [...out]
}
const nameRe = (c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
function pastEmployerIn(text, theirCompany, list = resumeCompanies()) {
  for (const c of list) {
    if (nameRe(c).test(String(theirCompany || ''))) continue
    if (nameRe(c).test(String(text || ''))) return c
  }
  return null
}
const pastEmployerRefusal = (named) => ({ sent: false, reason: 'names_past_employer', scope: 'person',
  error: `The text names "${named}", a company from <YOUR_NAME>'s resume. LinkedIn messages describe that experience by role, years, domain and results only (e.g. "in my AI/ML Engineer role I built…"). Rewrite it without the company name and send again.` })

function validateNote(message) {
  if (message == null) return { ok: true, length: 0, limit: NOTE_LIMIT }
  const length = String(message).length // final string, after any interpolation the caller did
  return length <= NOTE_LIMIT
    ? { ok: true, length, limit: NOTE_LIMIT }
    : { ok: false, length, limit: NOTE_LIMIT, over: length - NOTE_LIMIT,
        error: `note is ${length} chars, ${length - NOTE_LIMIT} over the ${NOTE_LIMIT} limit` }
}

// Which failures are about THIS person (skip them, keep going) versus the whole ACCOUNT (stop
// the batch now). Getting this wrong in the safe direction wastes the day's budget; getting it
// wrong in the unsafe direction keeps hammering a throttled account, which is how restrictions
// happen. Unknown types are reported as scope "unknown" rather than guessed.
function classifyUnipileError(err) {
  const type = String(err?.unipileType || '').replace(/^errors\//, '')
  const status = err?.status ?? null
  const base = { status, unipile_type: err?.unipileType || null, detail: err?.detail || err?.message || null }
  if (type === 'already_invited_recently') return { ...base, reason: 'already_invited_recently', scope: 'person' }
  if (type === 'invalid_parameters') return { ...base, reason: 'invalid_parameters', scope: 'person' }
  if (type === 'cannot_resend_yet') return { ...base, reason: 'cannot_resend_yet', scope: 'global' }
  if (status === 429 || /limit|too_many|rate|quota|throttl/i.test(type)) return { ...base, reason: 'daily_limit', scope: 'global' }
  if (status === 401 || status === 403 || /restrict|disconnect|credential|unauthori/i.test(type)) return { ...base, reason: 'account_blocked', scope: 'global' }
  if (status && status >= 500) return { ...base, reason: 'upstream_error', scope: 'global' }
  return { ...base, reason: type || 'unknown', scope: 'unknown' }
}

/**
 * Budget, reconciled. career-ops' ledger counts only local sends, so `sentToday` there can read
 * 5 while LinkedIn has actually sent 11. Take the higher of the two for every counter — the
 * conservative side is the one that protects the account.
 */
async function inviteBudget(uni, account_id) {
  let ledger = null
  try {
    const m = await import(path.join(CO, 'lib', 'invite-ledger.mjs'))
    ledger = m.summarize(CO)
  } catch (e) {
    ledger = { unavailable: String(e.message || e).slice(0, 120) }
  }
  let li = null
  try {
    const idx = await getSentIndex(uni, account_id)
    li = sentCountsFromIndex(idx, new Date().toISOString().slice(0, 10))
  } catch { /* fall through with local only */ }

  const safeDaily = ledger.safeDaily ?? 20, safeWeekly = ledger.safeWeekly ?? 80
  const sentToday = Math.max(ledger.sentToday ?? 0, li?.today ?? 0)
  const trailing7 = Math.max(ledger.trailing7 ?? 0, li?.trailing7 ?? 0)
  // LINKEDIN_INVITE_UNCAPPED=1 (2026-10-06, <YOUR_NAME>'s call): no local daily/weekly cap. LinkedIn's
  // own refusal (429 / limit -> reason daily_limit, scope global) is then the only stop. Remaining
  // is a large FINITE number: Infinity serialises to null in JSON and every consumer
  // (warm-outbound, Tsenta) reads null as "no budget" and would stop instead.
  const uncapped = process.env.LINKEDIN_INVITE_UNCAPPED === '1'
  const UNCAPPED_REMAINING = 9999
  return {
    available: !ledger.unavailable || Boolean(li),
    sentToday, trailing7, safeDaily, safeWeekly, capped: !uncapped,
    observedBlock: ledger.observedBlock ?? 112,
    remainingToday: uncapped ? UNCAPPED_REMAINING : Math.max(0, Math.min(safeDaily - sentToday, safeWeekly - trailing7)),
    remainingThisWeek: uncapped ? UNCAPPED_REMAINING : Math.max(0, safeWeekly - trailing7),
    sources: { local: ledger.unavailable ? null : { sentToday: ledger.sentToday, trailing7: ledger.trailing7 }, linkedin: li },
    ...(ledger.unavailable ? { ledger_warning: ledger.unavailable } : {}),
  }
}

// --- employer verification --------------------------------------------------------
// Three live failure modes, all from real invites that went to the wrong person:
//   1. NAME collision      — two people whose SURNAME matched the searched company (2026-08-12).
//   2. PAST association    — a headline like "Talent at Northwind | Former Globex Cheerleader"
//                            matched a Globex search; they never worked there (2026-09-02).
//                            (Entities fictionalised: the real headline identified one person.)
//   3. SIMILAR company     — <COMPANY_A> Solutions vs <COMPANY_A> Technologies, <COMPANY_C> Platforms vs
//                            <COMPANY_C>, <COMPANY_D> General vs <COMPANY_D> (2026-09-01).
// The current employer lives in the headline after " at " / " @ " and nowhere else. Everything
// outside that clause is returned verbatim as `other_mentions` rather than run through a
// company-name extractor: the caller already knows the company it is looking for, so a
// substring check against the raw text is exact, while an extractor invents and drops names.
const PAST_MARKER = /\b(?:former(?:ly)?|ex|previously|alum(?:ni|nus|na)?|retired|past)\b/i
// A NON-EMPLOYMENT current role. "Student at <COMPANY_Z>" parses an employer they do not work for
// — same bad send as a past association, but it is not past, so it gets its own field rather
// than being folded into past_association and losing the distinction. Deliberately narrow:
// advisor, consultant and contractor ARE employment relationships and are not listed.
const ROLE_QUALIFIER = /\b(student|intern|internship|trainee|apprentice|volunteer|candidate|fellow|scholar)\b/i
const SEGMENT = /\s*[|•·\n]+\s*/
const EMPLOYER_CLAUSE = /\s(?:at|@)\s+([^,(\n]+?)(?:\s*[(,]|\s+-\s|$)/i

function headlineEmployment(headline) {
  const h = String(headline || '').trim()
  const empty = { employer: null, other_mentions: [], past_association: false, past_mentions: [], role_qualifier: null }
  if (!h) return empty

  const segs = h.split(SEGMENT).map((s) => s.trim()).filter(Boolean)
  let employer = null, empSeg = -1, staleEmployer = false
  for (let i = 0; i < segs.length; i++) {
    const m = segs[i].match(EMPLOYER_CLAUSE)
    if (!m) continue
    const e = m[1].trim().replace(/[.\s]+$/, '')
    if (e.length <= 1) continue
    employer = e
    empSeg = i
    // "Former Analyst at Broncos" parses an employer they have already left. The qualifier sits
    // before the "at", so only the prefix is tested — a marker after it belongs to the company.
    staleEmployer = PAST_MARKER.test(segs[i].slice(0, m.index))
    break
  }

  const other = segs.filter((_, i) => i !== empSeg)
  const past = other.filter((s) => PAST_MARKER.test(s))
  // Only the role side of the clause is tested — "Intern at X" is a non-employment role,
  // "Engineer at Student Beans" is a job at a company that happens to contain the word.
  const rq = empSeg >= 0 ? segs[empSeg].slice(0, segs[empSeg].search(EMPLOYER_CLAUSE)).match(ROLE_QUALIFIER) : null
  return {
    employer,
    other_mentions: other,
    past_association: staleEmployer || past.length > 0,
    past_mentions: staleEmployer ? [segs[empSeg], ...past] : past,
    role_qualifier: rq ? rq[1] : null,
  }
}

// Back-compat: the employer alone, for callers that only need the one string.
function employerFromHeadline(headline) { return headlineEmployment(headline).employer }

// --- tsenta application mirror -----------------------------------------------
// tsenta-apps.json is a REGENERATED mirror of tsenta's own application list, not an append
// log — the tsenta-daily skill rebuilds it wholesale each run. This exists because a cloud
// client (ChatGPT) can reach the tsenta MCP but has no filesystem access to career-ops, so it
// has to hand the list over to be written. Shape is fixed by the skill and by the webapp's
// /api/tsenta-applications reader; do not "improve" it.
const APP_FIELDS = ['appId', 'company', 'title', 'atsType', 'status', 'optimized', 'appliedAt', 'url']

function syncApplications(apps) {
  if (!Array.isArray(apps)) throw new Error('apps must be an array of tsenta applications')
  const today = dayOf(localIso())
  const clean = apps.map((a) => {
    const o = {}
    for (const k of APP_FIELDS) o[k] = a?.[k] ?? null
    return o
  })
  const count = (p) => clean.filter(p).length
  const payload = {
    updated: new Date().toISOString(),
    summary: {
      total: clean.length,
      submitted: count((a) => a.status === 'COMPLETED'),
      failed: count((a) => a.status === 'FAILED'),
      skipped: count((a) => a.status === 'SKIPPED'),
      in_flight: count((a) => a.status && !['COMPLETED', 'FAILED', 'SKIPPED'].includes(a.status)),
      today: count((a) => dayOf(a.appliedAt) === today),
      optimized: count((a) => a.optimized === true),
    },
    apps: clean,
  }
  return withLock(() => {
    writeJsonAtomic(path.join(DATA, 'tsenta-apps.json'), payload)
    return { synced: true, ...payload.summary }
  })
}

// Only the shape of a Unipile response is kept — never headers, never anything carrying the
// API key. Whitelist rather than blacklist so a new Unipile field cannot leak by default.
function safeResponse(r) {
  if (!r || typeof r !== 'object') return null
  const out = {}
  for (const k of ['object', 'invitation_id', 'message_id', 'chat_id', 'id']) if (r[k] !== undefined) out[k] = r[k]
  return out
}

module.exports = {
  CO, outputPdfAttachment, LOG_FILE, CONTACTS_FILE, STATUS_FILE, FAIL_DIR, VALID_STATUS,
  localIso, dayOf, normMsg, withLock, writeJsonAtomic, recordFailure,
  isDuplicateInvite, isDuplicateDm, findContact, syncAliases,
  buildInviteEvent, buildDmEvent, logInvite, logDm, safeResponse,
  checkContacted, syncApplications,
  // LinkedIn reconciliation + send-time guards
  checkContactedFull, getSentIndex, invalidateSentIndex, sentCountsFromIndex,
  recordAttempt, recentAttempt, validateNote, classifyUnipileError, inviteBudget,
  employerFromHeadline, headlineEmployment, NOTE_LIMIT, resumeCompanies, pastEmployerIn, pastEmployerRefusal,
}
