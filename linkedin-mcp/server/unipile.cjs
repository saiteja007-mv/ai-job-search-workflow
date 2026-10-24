// Thin Unipile REST client. Unipile holds the LinkedIn session cookies; we never touch
// LinkedIn directly, so there is no scraping, login flow or cookie refresh to maintain here.
//
// Config comes from the environment. UNIPILE_API_BASE already includes the /api/v1 suffix
// and a non-standard port (Unipile shards customers across api<N>.unipile.com:1<port>), so
// it is stored whole rather than reassembled from parts.
const DEFAULT_TIMEOUT_MS = 45_000

function config() {
  const base = (process.env.UNIPILE_API_BASE || '').replace(/\/+$/, '')
  const key = process.env.UNIPILE_API_KEY || ''
  if (!base || !key) throw new Error('UNIPILE_API_BASE and UNIPILE_API_KEY must be set (see .env)')
  return { base, key }
}

// A LinkedIn account id is required by nearly every endpoint. The default is the account
// this server is "acting as"; individual tools may override it to use another connected seat.
const defaultAccount = () => process.env.UNIPILE_ACCOUNT_ID || ''

async function call(method, path, { query, body, form, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { base, key } = config()
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-API-KEY': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      // A FormData body sets its own multipart content-type (with boundary); never set it by hand.
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let parsed
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    if (!res.ok) {
      // Unipile returns {status,type,title,detail}. Surface title+detail — the generic
      // "Request failed" an HTTP status alone gives is useless to an agent deciding what to retry.
      const d = parsed || {}
      const err = new Error(`Unipile ${res.status} ${d.type || ''}: ${d.title || ''}${d.detail ? ' — ' + d.detail : ''}`.trim())
      // Machine-readable fields so a caller can branch on WHAT failed without parsing the
      // message. `type` is Unipile's stable error id (e.g. errors/already_invited_recently);
      // the sentence after it is prose and changes between API versions.
      err.status = res.status
      err.unipileType = d.type || null
      err.title = d.title || null
      err.detail = d.detail || null
      throw err
    }
    return parsed
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Unipile request timed out after ${timeoutMs}ms: ${method} ${path}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

const acct = (given) => {
  const id = given || defaultAccount()
  if (!id) throw new Error('No LinkedIn account_id given and UNIPILE_ACCOUNT_ID is not set. Call list_accounts to see the options.')
  return id
}

module.exports = {
  config,
  defaultAccount,
  call,
  acct,

  // --- accounts & identity ---
  listAccounts: () => call('GET', '/accounts'),
  me: (account_id) => call('GET', '/users/me', { query: { account_id: acct(account_id) } }),

  // --- people ---
  // `identifier` accepts a public identifier ("williamhgates") or a provider id (ACoAA...).
  getProfile: (identifier, account_id) =>
    call('GET', `/users/${encodeURIComponent(identifier)}`, { query: { account_id: acct(account_id) } }),
  listConnections: (account_id, limit, cursor) =>
    call('GET', '/users/relations', { query: { account_id: acct(account_id), limit, cursor } }),
  invite: (provider_id, message, account_id) =>
    call('POST', '/users/invite', { body: { account_id: acct(account_id), provider_id, message: message || undefined } }),

  // --- invitations the account has SENT, per LinkedIn's own record ---
  // This is the only ground truth for "did anyone, from any client, already invite this
  // person". The local outreach log misses every send that did not go through this server.
  // Cursor-paginated, 100 per page; ~800 invites on this account = 8-9 pages.
  sentInvitations: (account_id, limit = 100, cursor) =>
    call('GET', '/users/invite/sent', { query: { account_id: acct(account_id), limit, cursor } }),
  async allSentInvitations(account_id, { maxPages = 20 } = {}) {
    const items = []
    let cursor
    for (let i = 0; i < maxPages; i++) {
      const page = await this.sentInvitations(account_id, 100, cursor)
      items.push(...(page?.items || []))
      cursor = page?.cursor
      if (!cursor || !(page?.items || []).length) break
    }
    return items
  },

  // --- search ---
  // One endpoint covers people / companies / jobs / posts; `category` selects which.
  search: (params, account_id, cursor) =>
    call('POST', '/linkedin/search', { query: { account_id: acct(account_id), cursor }, body: params }),
  searchParameters: (type, keywords, account_id) =>
    call('GET', '/linkedin/search/parameters', { query: { account_id: acct(account_id), type, keywords } }),

  // --- jobs ---
  getJob: (job_id, account_id) =>
    call('GET', `/linkedin/jobs/${encodeURIComponent(job_id)}`, { query: { account_id: acct(account_id) } }),

  // --- posts ---
  getPost: (post_id, account_id) =>
    call('GET', `/posts/${encodeURIComponent(post_id)}`, { query: { account_id: acct(account_id) } }),
  userPosts: (identifier, account_id, limit, cursor) =>
    call('GET', `/users/${encodeURIComponent(identifier)}/posts`, { query: { account_id: acct(account_id), limit, cursor } }),
  postComments: (post_id, account_id, limit, cursor) =>
    call('GET', `/posts/${encodeURIComponent(post_id)}/comments`, { query: { account_id: acct(account_id), limit, cursor } }),
  createPost: (text, account_id, visibility) =>
    call('POST', '/posts', { body: { account_id: acct(account_id), text, visibility: visibility || undefined } }),
  commentPost: (post_id, text, account_id) =>
    call('POST', `/posts/${encodeURIComponent(post_id)}/comment`, { body: { account_id: acct(account_id), text } }),
  reactPost: (post_id, reaction_type, account_id) =>
    call('POST', `/posts/${encodeURIComponent(post_id)}/reaction`, { body: { account_id: acct(account_id), reaction_type: reaction_type || 'like' } }),

  // --- messaging ---
  listChats: (account_id, limit, cursor, unread) =>
    call('GET', '/chats', { query: { account_id: acct(account_id), limit, cursor, unread } }),
  chatMessages: (chat_id, limit, cursor) =>
    call('GET', `/chats/${encodeURIComponent(chat_id)}/messages`, { query: { limit, cursor } }),
  listMessages: (account_id, limit, cursor) =>
    call('GET', '/messages', { query: { account_id: acct(account_id), limit, cursor } }),
  // attachment = { name, data: Buffer, type } from careerOps.outputPdfAttachment(); multipart only then.
  sendMessage: (chat_id, text, attachment) => {
    if (!attachment) return call('POST', `/chats/${encodeURIComponent(chat_id)}/messages`, { body: { text } })
    const form = new FormData()
    form.append('text', text)
    form.append('attachments', new Blob([attachment.data], { type: attachment.type }), attachment.name)
    return call('POST', `/chats/${encodeURIComponent(chat_id)}/messages`, { form })
  },
  // inmail: { subject } sends a LinkedIn InMail (multipart, verified 2026-07-14). Free only to Open Profiles.
  startChat: (attendees_ids, text, account_id, inmail) => {
    if (!inmail) return call('POST', '/chats', { body: { account_id: acct(account_id), attendees_ids, text } })
    const form = new FormData()
    form.append('account_id', acct(account_id))
    for (const id of attendees_ids) form.append('attendees_ids', id)
    form.append('text', text)
    if (inmail.subject) form.append('subject', inmail.subject)
    form.append('linkedin[api]', 'classic')
    form.append('linkedin[inmail]', 'true')
    return call('POST', '/chats', { form })
  },
}
