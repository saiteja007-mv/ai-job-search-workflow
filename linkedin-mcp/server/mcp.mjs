// LinkedIn MCP — exposes a Unipile-connected LinkedIn account as MCP tools over
// Streamable HTTP at /mcp. Token gated (header OR ?token= in the URL, because several
// connector dialogs — ChatGPT's included — offer no header field).
//
// Stateless: one server+transport per request, so there is no session to expire and any
// number of clients (ChatGPT, Claude, a cron) can hold the same URL at once.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import careerOpsShared from './careerops.cjs'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import crypto from 'node:crypto'

// Constant-time compare so a network timing side channel can't leak the token byte by byte.
function tokenEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''))
  const bb = Buffer.from(String(b ?? ''))
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj ?? null, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: 'Error: ' + (e?.message || e) }], isError: true })
const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})) } catch (e) { return fail(e) } }

// LinkedIn payloads are enormous — a single post search came back at 25 KB. Every list tool
// returns a trimmed shape by default and takes `raw: true` to opt back into the full object,
// so browsing costs a few hundred tokens instead of tens of thousands.
const clip = (s, n = 400) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… [${s.length} chars total]` : s)

// The employer guard, as fields. Anything person-shaped that reaches a caller must carry these
// — get_profile shipped without them once, and get_profile is the ONLY lookup on the direct
// path (known profile URL -> confirm -> invite), i.e. the step where a careful caller looks.
const employerFields = (headline) => {
  const h = careerOpsShared.headlineEmployment(headline)
  return {
    employer_from_headline: h.employer,
    headline_other_mentions: h.other_mentions,
    past_association: h.past_association,
    ...(h.past_association ? { past_mentions: h.past_mentions } : {}),
    ...(h.role_qualifier ? { role_qualifier: h.role_qualifier } : {}),
  }
}
// Augment a raw Unipile payload in place rather than reshaping it: get_profile deliberately
// returns the full UserProfile (experience, contact_info, follower_count), and fmtPerson would
// strip exactly the fields the caller opened the profile for.
const withEmployerFields = (p) => (p && typeof p === 'object' && 'headline' in p ? { ...p, ...employerFields(p.headline) } : p)

const fmtPerson = (p) => ({
  id: p.id || p.provider_id || p.member_id,
  name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
  headline: p.headline || null,
  location: p.location || null,
  url: p.profile_url || p.public_profile_url || (p.public_identifier ? `https://www.linkedin.com/in/${p.public_identifier}` : null),
  connection_degree: p.network_distance ?? null,
  // Parsed from the headline, NOT the name — verify the employer here before inviting.
  // past_association / headline_other_mentions are the reject signals: a company that appears
  // only in other_mentions is somewhere this person does NOT work.
  ...employerFields(p.headline),
})
const fmtJob = (j) => ({
  id: j.id, title: j.title, company: j.company?.name || j.company || null,
  location: j.location || null, posted_at: j.posted_at || null,
  benefits: j.benefits || null, url: j.url || (j.id ? `https://www.linkedin.com/jobs/view/${j.id}` : null),
})
const fmtCompany = (c) => ({ id: c.id, name: c.name, industry: c.industry || null, summary: clip(c.summary, 200), url: c.profile_url || null })
const fmtPost = (p) => ({
  id: p.id || p.social_id, author: p.author?.name || p.author || null,
  date: p.date || p.parsed_datetime || null, text: clip(p.text),
  reactions: p.reaction_counter ?? null, comments: p.comment_counter ?? null,
  url: p.share_url || p.permalink || null,
})
const fmtChat = (c) => ({ id: c.id, name: c.name, unread: c.unread, timestamp: c.timestamp, attendee_provider_id: c.attendee_provider_id || null, folder: c.folder })
const fmtMessage = (m) => ({ id: m.id, chat_id: m.chat_id, from: m.sender_attendee_id || m.sender_id || null, is_sender: m.is_sender ?? null, timestamp: m.timestamp, text: clip(m.text, 1200) })

// Pick the right formatter for a search hit — the endpoint mixes types in one `items` array.
const fmtSearchItem = (it) => {
  switch (it.type) {
    case 'JOB': return fmtJob(it)
    case 'COMPANY': return fmtCompany(it)
    case 'POST': return fmtPost(it)
    default: return fmtPerson(it)
  }
}
const listOut = (resp, fmt, raw) => raw
  ? resp
  : { count: (resp?.items || []).length, cursor: resp?.cursor ?? null, items: (resp?.items || []).map(fmt) }

// Best-effort enrichment: an invite carries only a provider_id, but career-ops wants a name
// and public_id to link the send to a contact. One profile read fills that in. Never fatal —
// the message is already delivered, and a throttled lookup must not turn into an error.
async function enrich(uni, { provider_id, account_id, name, public_id, linkedin, title }) {
  if (name && public_id) return { name, public_id, linkedin, title }
  try {
    const p = await uni.getProfile(provider_id, account_id)
    const full = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || null
    return {
      name: name || full,
      public_id: public_id || p.public_identifier || null,
      linkedin: linkedin || (p.public_identifier ? `https://www.linkedin.com/in/${p.public_identifier}` : null),
      title: title || p.headline || null,
    }
  } catch {
    return { name: name || null, public_id: public_id || null, linkedin: linkedin || null, title: title || null }
  }
}

// Confirm the message actually landed in the thread. career-ops events carry this flag, and
// "Unipile returned 201" is not the same claim as "it is in the conversation".
async function verifyInChat(uni, chat_id, message_id) {
  if (!chat_id || !message_id) return null
  try {
    const r = await uni.chatMessages(chat_id, 10)
    return (r?.items || []).some((m) => m.id === message_id)
  } catch { return null }
}

function buildServer({ uni, allowWrites, careerOps, externalOrigin }) {
  const s = new McpServer({ name: 'linkedin-mcp', version: '1.0.0' })
  const T = (name, desc, shape, fn) => s.tool(name, desc, shape, wrap(fn))
  // Context the caller may pass so a send can be attributed to a company/role in career-ops.
  const ctx = {
    name: z.string().optional().describe('target full name, for the career-ops outreach log'),
    company: z.string().optional().describe('company this outreach relates to'),
    role: z.string().optional().describe('role this outreach relates to'),
    origin: z.string().optional().describe('which client is sending: chatgpt | claude_desktop | codex'),
  }
  // Every tool takes an optional account_id so one server can drive several connected seats.
  const account = z.string().optional().describe('Connected LinkedIn account id. Omit to use the default account.')
  const raw = z.boolean().optional().describe('Return the full untrimmed Unipile object instead of the compact summary.')

  // ===================== identity & network =====================
  T('list_accounts', 'List the LinkedIn (and other) accounts connected to Unipile, with their ids and connection status. Use this to find an account_id.', {},
    async () => {
      const r = await uni.listAccounts()
      return {
        default_account_id: uni.defaultAccount() || null,
        accounts: (r?.items || []).map((a) => ({ id: a.id, type: a.type, name: a.name, status: (a.sources || []).map((s) => s.status).join(',') || null })),
      }
    })

  T('get_me', 'The profile of the LinkedIn account this server acts as: name, headline, provider_id, public identifier.',
    { account_id: account }, ({ account_id }) => uni.me(account_id))

  T('get_profile', 'Fetch a LinkedIn profile by public identifier (e.g. "williamhgates" from linkedin.com/in/williamhgates) or by provider id (ACoAA...). Returns headline, location, experience and the provider_id needed to invite or message them, plus the employer guard (employer_from_headline, headline_other_mentions, past_association, role_qualifier). This is usually the LAST lookup before a send — confirm the employer from those fields, never from the name: a company appearing only in headline_other_mentions is somewhere this person does NOT work.',
    { identifier: z.string().describe('public identifier or provider id'), account_id: account },
    async ({ identifier, account_id }) => withEmployerFields(await uni.getProfile(identifier, account_id)))

  T('list_connections', 'List your existing 1st-degree LinkedIn connections.',
    { limit: z.number().optional(), cursor: z.string().optional(), account_id: account, raw },
    async ({ limit, cursor, account_id, raw: r }) => listOut(await uni.listConnections(account_id, limit ?? 25, cursor), fmtPerson, r))

  // ===================== search =====================
  // One tool rather than four: the Unipile endpoint is one endpoint, and four near-identical
  // schemas would sit in the client's context on every single turn for no benefit.
  T('search', 'Search LinkedIn for people, companies, jobs or posts. `category` picks what you are searching for. Location/industry filters take numeric ids — resolve them first with search_parameters. Note: people search may return zero results when LinkedIn throttles the account; company, job and post search are unaffected. Each person carries employer_from_headline — verify the employer from THAT, never from the name, and reject all three miss classes: (1) the token is in their NAME (a search for Globex matching someone surnamed Globex); (2) it is a PAST or non-employment association — check past_association and headline_other_mentions, e.g. a headline reading "Talent at Northwind | Former Globex Cheerleader" is not a Globex employee; (3) it is a similarly-named DIFFERENT company (<COMPANY_A> Solutions vs <COMPANY_A> Technologies, <COMPANY_C> Platforms vs <COMPANY_C>, <COMPANY_D> General vs <COMPANY_D>). 3rd-degree results (connection_degree 3 / DISTANCE_3) are valid invite targets; do not discard them.',
    {
      category: z.enum(['people', 'companies', 'jobs', 'posts']).describe('what to search for'),
      keywords: z.string().describe('free-text query'),
      location: z.array(z.union([z.number(), z.string()])).optional().describe('location ids from search_parameters (type=LOCATION)'),
      company: z.array(z.union([z.number(), z.string()])).optional().describe('company ids from search_parameters (type=COMPANY)'),
      industry: z.array(z.union([z.number(), z.string()])).optional().describe('industry ids from search_parameters (type=INDUSTRY)'),
      api: z.enum(['classic', 'sales_navigator', 'recruiter']).optional().describe('defaults to classic'),
      cursor: z.string().optional().describe('paging cursor from a previous call'),
      account_id: account,
      raw,
    },
    async ({ category, keywords, location, company, industry, api, cursor, account_id, raw: r }) => {
      return listOut(await uni.search(searchParams({ api, category, keywords, location, company, industry }), account_id, cursor), fmtSearchItem, r)
    })

  T('search_parameters', 'Resolve a filter name to the numeric id that `search` expects — e.g. type=LOCATION keywords="texas" returns the id for Texas. Also supports COMPANY, INDUSTRY, SCHOOL, SERVICE.',
    { type: z.enum(['LOCATION', 'COMPANY', 'INDUSTRY', 'SCHOOL', 'SERVICE']), keywords: z.string(), account_id: account },
    async ({ type, keywords, account_id }) => {
      const r = await uni.searchParameters(type, keywords, account_id)
      return (r?.items || []).map((i) => ({ id: i.id, title: i.title }))
    })

  // ===================== jobs =====================
  T('get_job', 'Full detail for one LinkedIn job posting by id (the id from a jobs search), including the description and application URL.',
    { job_id: z.string(), account_id: account }, ({ job_id, account_id }) => uni.getJob(job_id, account_id))

  // ===================== posts =====================
  T('get_post', 'Fetch a single LinkedIn post by its id or social id (urn:li:activity:...).',
    { post_id: z.string(), account_id: account }, ({ post_id, account_id }) => uni.getPost(post_id, account_id))

  T('list_user_posts', "List a person's or company's recent LinkedIn posts. Takes a provider id (ACoAA...) — get one from get_profile.",
    { identifier: z.string().describe('provider id or public identifier'), limit: z.number().optional(), cursor: z.string().optional(), account_id: account, raw },
    async ({ identifier, limit, cursor, account_id, raw: r }) => listOut(await uni.userPosts(identifier, account_id, limit ?? 10, cursor), fmtPost, r))

  T('list_post_comments', 'List the comments on a LinkedIn post.',
    { post_id: z.string(), limit: z.number().optional(), cursor: z.string().optional(), account_id: account, raw },
    async ({ post_id, limit, cursor, account_id, raw: r }) => listOut(await uni.postComments(post_id, account_id, limit ?? 20, cursor), fmtPost, r))

  // ===================== messaging (read) =====================
  T('list_chats', 'List LinkedIn conversations, most recent first. Use `unread: true` for only unread threads.',
    { limit: z.number().optional(), cursor: z.string().optional(), unread: z.boolean().optional(), account_id: account, raw },
    async ({ limit, cursor, unread, account_id, raw: r }) =>
      listOut(await uni.listChats(account_id, limit ?? 20, cursor, unread ? 1 : undefined), fmtChat, r))

  T('list_chat_messages', 'Read the messages in one LinkedIn conversation, given a chat_id from list_chats.',
    { chat_id: z.string(), limit: z.number().optional(), cursor: z.string().optional(), raw },
    async ({ chat_id, limit, cursor, raw: r }) => listOut(await uni.chatMessages(chat_id, limit ?? 30, cursor), fmtMessage, r))

  T('list_recent_messages', 'Recent LinkedIn messages across every conversation — a quick inbox sweep.',
    { limit: z.number().optional(), cursor: z.string().optional(), account_id: account, raw },
    async ({ limit, cursor, account_id, raw: r }) => listOut(await uni.listMessages(account_id, limit ?? 20, cursor), fmtMessage, r))

  // ===================== career-ops =====================
  // Read-only, so it stays available even in READONLY mode — knowing you already contacted
  // someone is exactly as useful when you are not allowed to send.
  T('check_contacted', 'Check whether this person has ALREADY been invited or messaged. Consults the career-ops outreach log, the failed-attempts log, AND LinkedIn\'s own sent-invitation list via Unipile (cached ~7 min), so invites sent from other clients are caught too. send_invitation runs this same check itself before sending, so calling it first is for planning, not safety. If the LinkedIn side is unreachable the answer says linkedin_check: "unavailable" — treat that as unknown, not as "not contacted".',
    { provider_id: z.string().optional(), public_id: z.string().optional(), linkedin: z.string().optional().describe('profile URL'), account_id: account },
    (a) => careerOps.checkContactedFull(uni, a))

  T('get_invite_budget', 'How many connection invitations can still be sent safely: today and this week. Reconciled — takes the HIGHER of the career-ops ledger and LinkedIn\'s own sent-invitation count, because the ledger only knows about local sends. Call before a batch; send_invitation runs this same check itself and refuses at remainingToday 0.',
    { account_id: account },
    ({ account_id }) => careerOps.inviteBudget(uni, account_id))

  T('sync_applications', 'Mirror the tsenta application list into career-ops (data/tsenta-apps.json) so the dashboard shows them. Pass the array from tsenta list-applications; each item needs appId, company, title, atsType, status, optimized, appliedAt, url. This REPLACES the mirror wholesale — always pass the full list, never a single new application.',
    { apps: z.array(z.object({
        appId: z.string().optional(), company: z.string().optional(), title: z.string().optional(),
        atsType: z.string().optional(), status: z.string().optional(), optimized: z.boolean().optional(),
        appliedAt: z.string().optional(), url: z.string().optional(),
      }).passthrough()).describe('the full list from tsenta list-applications'),
    },
    ({ apps }) => careerOps.syncApplications(apps))

  // ===================== write actions =====================
  // These act on the real account under the user's name. LINKEDIN_MCP_READONLY=1 removes them
  // from the tool list entirely rather than failing at call time — a tool that is absent cannot
  // be talked into firing by anything the model reads in a job post or an inbound message.
  if (allowWrites) {
    // Every send below is mirrored into career-ops after Unipile confirms it. Without that,
    // outreach sent from ChatGPT/Codex is invisible to Hermes, which then misses accepted
    // invitations and never follows up. Logging runs after the send and can never fail it.
    const origin = (given) => given || externalOrigin || 'unknown'

    T('send_message', 'Send a message in an EXISTING LinkedIn conversation. This posts publicly to the recipient under the account owner\'s name — confirm the exact text with the user before calling. Automatically recorded in the career-ops outreach log.',
      { chat_id: z.string(), text: z.string(), public_id: z.string().optional(), provider_id: z.string().optional(), account_id: account,
        attachment_path: z.string().optional().describe('Optional PDF to attach, path relative to career-ops/output (e.g. a resume). Anything else is refused.'), ...ctx },
      async ({ chat_id, text, public_id, provider_id, account_id, attachment_path, name, company, role, origin: o }) => {
        const named = careerOps.pastEmployerIn(text, company)
        if (named) return careerOps.pastEmployerRefusal(named)
        const attachment = attachment_path ? careerOps.outputPdfAttachment(attachment_path) : null
        if (attachment?.error) return { sent: false, error: attachment.error }
        const res = await uni.sendMessage(chat_id, text, attachment)
        const message_id = res?.message_id || res?.id || null
        const career_ops = careerOps.logDm({
          chat_id, message_id, message: attachment ? `${text}
[attachment: ${attachment.name}]` : text, account_id: account_id || uni.defaultAccount(),
          name, company, role, public_id, provider_id,
          external_origin: origin(o), unipile_status: 201,
          unipile_response: careerOps.safeResponse(res),
          verified_in_chat: await verifyInChat(uni, chat_id, message_id),
        })
        return { sent: true, message_id, career_ops }
      })

    T('start_chat', 'Start a NEW LinkedIn conversation with someone and send the first message. attendee_id is their provider id (ACoAA...). Sends immediately — confirm recipient and text with the user first. Automatically recorded in the career-ops outreach log.',
      { attendee_id: z.string(), text: z.string(), account_id: account,
        inmail: z.boolean().optional().describe('Send as an InMail (for non-connections). Free only when the recipient has an Open Profile; otherwise uses InMail credits.'),
        subject: z.string().optional().describe('InMail subject line (inmail only).'), ...ctx },
      async ({ attendee_id, text, account_id, inmail, subject, name, company, role, origin: o }) => {
        const named = careerOps.pastEmployerIn(text, company)
        if (named) return careerOps.pastEmployerRefusal(named)
        const res = await uni.startChat([attendee_id], text, account_id, inmail ? { subject } : null)
        const chat_id = res?.chat_id || res?.id || null
        const message_id = res?.message_id || null
        const who = await enrich(uni, { provider_id: attendee_id, account_id, name })
        const career_ops = careerOps.logDm({
          chat_id, message_id, message: text, account_id: account_id || uni.defaultAccount(),
          provider_id: attendee_id, ...who, company, role,
          external_origin: origin(o), unipile_status: 201,
          unipile_response: careerOps.safeResponse(res),
          verified_in_chat: await verifyInChat(uni, chat_id, message_id),
        })
        return { sent: true, chat_id, message_id, career_ops }
      })

    T('send_invitation', 'Send a LinkedIn connection request, optionally with a note (max 300 chars — validated before the call). 3rd-degree (DISTANCE_3) contacts CAN be invited; do not skip them. Before sending this runs, in order: note length, invite budget (refuses when remainingToday is 0, warns at <=3), and a duplicate check against career-ops AND LinkedIn\'s own sent list. It NEVER throws for a LinkedIn refusal — it returns {sent:false, reason, scope}. scope "person" (already_invited_recently, invalid_parameters, already_contacted) means skip THIS person and continue; scope "global" (daily_limit, cannot_resend_yet, account_blocked) means STOP the batch. Successful sends are recorded in the career-ops outreach log; refusals in the attempts log. Sends immediately — confirm with the user first.',
      { provider_id: z.string(), message: z.string().optional().describe('optional note, max 300 chars'), account_id: account, ...ctx,
        skip_budget_check: z.boolean().optional().describe('bypass the budget preflight (not the duplicate check). Only with explicit user instruction.') },
      async ({ provider_id, message, account_id, name, company, role, origin: o, skip_budget_check }) => {
        const attempt = (extra) => careerOps.recordAttempt({ provider_id, name, company, role, origin: origin(o), ...extra })

        // 1. Note length — fail here, not at the API, and say by how much.
        const note = careerOps.validateNote(message)
        if (!note.ok) return { sent: false, reason: 'note_too_long', scope: 'person', length: note.length, limit: note.limit, over: note.over, error: note.error }
        // 1b. No company from the resume in the note (checked before the budget: a rewrite is free).
        const named = careerOps.pastEmployerIn(message, company)
        if (named) return careerOps.pastEmployerRefusal(named)

        // 2. Budget, reconciled against LinkedIn's count so external sends are not invisible.
        let budget = null
        if (!skip_budget_check) {
          budget = await careerOps.inviteBudget(uni, account_id)
          if (budget.available && budget.remainingToday <= 0) {
            attempt({ reason: 'daily_limit', scope: 'global', detail: `remainingToday=0 (sentToday=${budget.sentToday}, trailing7=${budget.trailing7})` })
            return { sent: false, reason: 'daily_limit', scope: 'global', budget, error: `Invite budget exhausted: ${budget.sentToday} sent today, ${budget.trailing7} in the last 7 days. Stop the batch.` }
          }
        }

        // 3. Duplicate — local log, attempts log, then LinkedIn's sent list.
        const dup = await careerOps.checkContactedFull(uni, { provider_id, account_id })
        if (dup.contacted) {
          attempt({ reason: 'already_contacted', scope: 'person', detail: `via ${dup.via} at ${dup.sent_at}` })
          return { sent: false, reason: 'already_contacted', scope: 'person', via: dup.via, sent_at: dup.sent_at, invitation_id: dup.invitation_id, note: dup.note || null }
        }
        const warnings = []
        if (dup.linkedin_check === 'unavailable') warnings.push(dup.warning)
        if (budget?.available && budget.remainingToday <= 3) warnings.push(`only ${budget.remainingToday} invite(s) left today`)

        // 4. Send. A refusal is data for the caller, not an exception.
        let res
        try {
          res = await uni.invite(provider_id, message, account_id)
        } catch (e) {
          const c = careerOps.classifyUnipileError(e)
          attempt({ reason: c.reason, scope: c.scope, status: c.status, detail: c.detail })
          return { sent: false, ...c, warnings: warnings.length ? warnings : undefined,
            error: c.scope === 'global' ? 'Account-level refusal — stop the batch.' : c.scope === 'person' ? 'Refused for this person only — pick a different contact and continue.' : 'Unrecognised refusal — treat as global until understood.' }
        }
        careerOps.invalidateSentIndex() // LinkedIn's list just grew; the next check must see it
        const who = await enrich(uni, { provider_id, account_id, name })
        const career_ops = careerOps.logInvite({
          provider_id, ...who, company, role, message,
          account_id: account_id || uni.defaultAccount(),
          external_origin: origin(o), unipile_status: 201,
          unipile_response: careerOps.safeResponse(res),
          invitation_id: res?.invitation_id || res?.id || null,
        })
        return { sent: true, invitation_id: res?.invitation_id || res?.id || null, career_ops, budget: budget ? { remainingToday: Math.max(0, budget.remainingToday - 1), remainingThisWeek: Math.max(0, budget.remainingThisWeek - 1) } : undefined, warnings: warnings.length ? warnings : undefined }
      })

    T('create_post', 'Publish a post to the LinkedIn feed under the account owner\'s name. Public and hard to undo — always confirm the final text with the user before calling.',
      { text: z.string(), visibility: z.enum(['public', 'connections']).optional(), account_id: account },
      ({ text, visibility, account_id }) => uni.createPost(text, account_id, visibility))

    T('comment_on_post', 'Post a public comment on a LinkedIn post under the account owner\'s name. Confirm the text with the user first.',
      { post_id: z.string(), text: z.string(), account_id: account },
      ({ post_id, text, account_id }) => uni.commentPost(post_id, text, account_id))

    T('react_to_post', 'React to a LinkedIn post (like by default).',
      { post_id: z.string(), reaction_type: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']).optional(), account_id: account },
      ({ post_id, reaction_type, account_id }) => uni.reactPost(post_id, reaction_type, account_id))
  }

  return s
}

// Which client is calling. The transport is stateless — one server per request — so the
// clientInfo from `initialize` is gone by the time a tool runs. The User-Agent is what
// survives, with ?client= and the tool's own `origin` param as more reliable overrides.
export function detectOrigin(req) {
  const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('client')
  if (q) return q
  const ua = String(req.headers['user-agent'] || '').toLowerCase()
  if (!ua) return 'unknown'
  if (ua.includes('openai') || ua.includes('chatgpt')) return 'chatgpt'
  if (ua.includes('claude-desktop') || ua.includes('claude desktop')) return 'claude_desktop'
  if (ua.includes('codex')) return 'codex'
  if (ua.includes('claude')) return 'claude'
  return 'unknown'
}

export function createMcpHandler(deps) {
  const token = deps.token
  return async function handleMcp(req, res, bodyRaw) {
    const authz = req.headers['authorization'] || ''
    // Token may arrive as a bearer-header, x-api-key, or ?token= in the URL. The URL form is
    // what makes this pasteable into connector dialogs that expose no header field.
    const urlToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''
    const provided = authz.startsWith('Bearer ') ? authz.slice(7) : (req.headers['x-api-key'] || urlToken)
    if (!token || !tokenEqual(provided, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer\x20realm="linkedin-mcp"' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: valid token required' }, id: null }))
    }
    const server = buildServer({ ...deps, externalOrigin: detectOrigin(req) })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    let body
    if (bodyRaw) { try { body = JSON.parse(bodyRaw) } catch { /* let the transport 400 it */ } }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

// Unipile validates filter ids as digit strings and 400s on JSON numbers, while callers
// (and the old schema) pass numbers. Normalise here so company/location/industry filters work.
function searchParams({ api, category, keywords, location, company, industry }) {
  const params = { api: api || 'classic', category, keywords }
  const ids = (a) => (a?.length ? a.map(String) : undefined)
  if (ids(location)) params.location = ids(location)
  if (ids(company)) params.company = ids(company)
  if (ids(industry)) params.industry = ids(industry)
  return params
}

export { buildServer, tokenEqual, clip, fmtJob, fmtPost, fmtPerson, listOut, searchParams }
