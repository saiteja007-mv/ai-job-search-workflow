#!/usr/bin/env node
/**
 * unipile-poll.mjs — detect LinkedIn invitation acceptances and inbound replies.
 *
 * Originally polling instead of a webhook, deliberately: Unipile's own new_relation event
 * can land hours after the real acceptance because LinkedIn exposes no realtime signal for
 * it and Unipile polls internally at randomized intervals. Full reasoning:
 * reports/linkedin-autodraft-build-plan-2026-09-04.md
 *
 * Since 2026-09-11 a webhook path exists (Unipile -> Cloudflare path-only -> Hermes ->
 * deploy/unipile-webhook-filter.mjs -> deploy/linkedin-guarded-send.mjs), see
 * reports/linkedin-webhook-autoreply-runbook-2026-09-11.md. This poller is now the SPARSE
 * FALLBACK sweep (a few randomized runs a day, per the .timer), not the primary detector.
 *
 * SENDS replies (2026-09-11, <YOUR_NAME>'s explicit decision superseding the never-auto-send
 * invariant in reports/linkedin-autodraft-build-plan-2026-09-04.md) — but only:
 *   - a reply in an EXISTING conversation, through the LinkedIn MCP so the ledger records it;
 *     there is no invitation code path anywhere in this process;
 *   - when LINKEDIN_AUTOSEND=1 (deploy/.env kill switch) and never in --dry-run;
 *   - a draft the assist server produced for this thread that passed its relevance check and
 *     a sanity check (length, no placeholders);
 *   - after re-reading the thread at send time: skipped if I already answered or a newer
 *     message arrived (it is redrafted on the next run);
 *   - MESSAGES (replies to a conversation, and the first message after an acceptance) are NOT
 *     daily-capped, by <YOUR_NAME>'s decision 2026-09-14: answering someone who wrote to you is not a
 *     restricted action on LinkedIn, and a reply that arrives a day late is worse than no reply.
 *     Only a per-run runaway breaker applies (LINKEDIN_MAX_SENDS_PER_RUN, default 25) — it exists
 *     to contain a bug, not to ration normal traffic, and has never fired in practice (busiest
 *     real run: 4 sends).
 *   - INVITATIONS are the restricted action and stay capped: LINKEDIN_INVITE_DAILY_CAP (default
 *     10) here, on top of the linkedin MCP's own reconciled budget (safeDaily 30 / safeWeekly 170,
 *     which also counts invites sent by every other agent).
 * Every send and every skip is reported on Telegram with the text that went out.
 *
 *   node deploy/unipile-poll.mjs [--dry-run] [--since-hours N] [--quiet] [--no-draft]
 *
 * --dry-run      print what would be queued, write nothing, notify nobody
 * --since-hours  look back this far on a first run with no state (default 24).
 *                With --dry-run it overrides the saved watermark, so a refinement can be
 *                exercised against real recent traffic without touching state.
 *
 * Drafting policy (2026-09-11 refinement — see classify()):
 *   answered  their message already has a reply from me   -> no draft, no ping
 *   ack       "👍", "thanks!", one-word closers            -> no draft, no ping
 *   closer    "not at this time, will let you know"     -> zero-token courtesy template
 *   cold      first contact from someone not in the ledger -> model draft (template if the
 *             model fails); the prompt decides interest from the profile's target roles
 *   convo     a real conversation or a known contact       -> model draft. If their latest
 *             message asks which posting/requisition this is (req#, job id, posting link),
 *             the answer is looked up from local records first (job-facts.mjs) and handed to
 *             the model as VERIFIED FACTS, so it answers with the real number instead of
 *             "I'll confirm and send it shortly". Nothing is web-guessed: a wrong req number
 *             is worse than an honest deferral, so an unresolvable ask keeps the old fallback.
 *   referral  a convo where they point me to a NAMED person ("X is the recruiter",
 *             "reach out to Y") -> find that person on LinkedIn (employer verified from the
 *             headline), send a connection invite that names who referred me, and reply to
 *             the referrer with thanks. Both go through the linkedin MCP, so the ledger and the
 *             invite budget stay true.
 *   accepted  first message after acceptance, drafted from the invite note + the related
 *             application and SENT via start_chat — unless the ledger already shows a DM to
 *             them or a conversation with them already exists (then dismissed). Acceptances
 *             still queued as `new` from the last 72h are picked up too (self-healing), so a
 *             run that failed mid-way never strands anyone.
 * Model drafts are capped per run (LINKEDIN_POLL_MAX_DRAFTS, default 3) so a burst can never
 * outrun the systemd timeout and loop forever on re-detection.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { unipileConfig, unipileGet } from '../assist/people.mjs';
import { findPerson } from '../assist/person.mjs';
import { ingest, eventId, readQueue, update } from '../linkedin-queue.mjs';
import { notify } from './telegram-notify.mjs';
import { draftReply, assistUp } from './draft-reply.mjs';
import { sendLinkedInMessage, startLinkedInChat, inviteReferredPerson, resumeCompanies, pastEmployers, pastEmployerIn } from './linkedin-send.mjs';
import { jobFactsFor, asksAboutJobId, factsInstruction, applicationStatusFor, statusInstruction } from './job-facts.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { postingUrlsIn, postingFactsFor, postingInstruction } from './posting-facts.mjs';
import { handle, buttonsFor, scorecard } from './linkedin-actions.mjs';

// LINKEDIN_DRAFTER=managed (deploy/.env) hands the decide-and-draft step to the `linkedin-replier`
// Claude Managed Agent (deploy/draft-managed.mjs). Imported lazily so a box without
// deploy/node_modules still runs the default assist drafter.
const MANAGED = process.env.LINKEDIN_DRAFTER === 'managed';
const { draftManaged, managedConfigured, resumeFor } = MANAGED ? await import('./draft-managed.mjs') : {};

/** Apply the agent's send | needs_you | no_reply decision to an event. */
function applyDecision(e, d) {
  if (d.error) { e.draft = { error: d.error }; return; }
  e.agent = { action: d.action, their_ask: d.their_ask, reason: d.reason, session_id: d.session_id };
  if (d.action === 'send' && d.attach_resume) {
    // Resolved here, not by the agent, so the file sent is always one the MCP's output/ guard accepts.
    const r = resumeFor(e.company);
    if (!r) { e.status = 'needs_you'; e.needs_you = `they asked for a resume but none was found to attach\n  suggested: ${d.text}`; return; }
    e.attachment = r.file;
  }
  if (d.action === 'send' && d.refer_to?.name) {
    // sendStage invites (or InMails) this person first and holds the thank-you if that fails.
    e.cls = 'referral';
    e.referral = { person: d.refer_to.name, company: d.refer_to.company || e.company, profile_url: d.refer_to.linkedin_url || null, note: d.refer_to.note || null };
  }
  if (d.action === 'send') e.draft = { text: d.text, model: d.model, drafted_at: now() };
  else if (d.action === 'no_reply') { e.status = 'dismissed'; e.dismiss_reason = `agent: ${d.reason}`; }
  else {
    // `suggested` is what the Telegram Send/Edit buttons act on; `slot` drives the one-tap Confirm.
    e.status = 'needs_you'; e.needs_you = `${d.reason}${d.text ? `\n  suggested: ${d.text}` : ''}`;
    e.suggested = d.text || null; e.slot = d.slot_start || null;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = join(ROOT, 'deploy', 'linkedin-poll-state.json');
// NOTE ON THE "600" IN THE OLD COMMENT HERE (pre-2026-09-25): it was already wrong. The real
// ceiling is deploy/systemd/career-ops-linkedin-poll.service's TimeoutStartSec=300 (the .timer
// file's own comment also says 600, same stale figure) — 3 x 110s = 330s already exceeded 300s
// in a worst case where every draft hit its full timeout. That .service file is out of scope for
// this change, so it is left as-is; flagged for <YOUR_NAME> rather than silently fixed. See
// DRAFT_TIMEOUT_MS below for why the per-draft number had to grow regardless — a legitimate 150s
// claude: call must not be cut off upstream.
const MAX_LLM_DRAFTS = Number(process.env.LINKEDIN_POLL_MAX_DRAFTS || 3);
// draft-reply.mjs defaults its own client-side fetch timeout to 110s, sized for the old
// OpenRouter/codex primaries (seconds, not minutes). The claude: route (assist/runner.mjs, since
// 2026-09-25) can legitimately run its own CLAUDE_ROUTE_TIMEOUT_MS (150s default) before falling
// through to omniroute, and the assist server's own deadline for a message draft is now 165s
// (draft.mjs) to give that fallback a turn — so the client waiting on it must outlast 165s too.
// 175s = that 165s + 10s of network/serialization slack, passed explicitly per call below so
// draft-reply.mjs (out of scope for this file's edits) needs no change.
// 3 x 175s = 525s: safely under the .timer comment's claimed 600s, but OVER the .service file's
// actual 300s TimeoutStartSec if all 3 drafts hit worst case at once — same pre-existing gap as
// above, now wider. claude: measures in seconds on a normal answer (150s is the rare-failure
// ceiling, not the typical run), so this is a tail risk, not a routine one; still worth <YOUR_NAME>
// raising TimeoutStartSec (or accepting the tail risk) rather than this file silently deciding.
const DRAFT_TIMEOUT_MS = Number(process.env.LINKEDIN_POLL_DRAFT_TIMEOUT_MS || 175_000);
// Messages are uncapped per day (see header); this is only a runaway breaker for one run.
const MAX_SENDS_PER_RUN = Number(process.env.LINKEDIN_MAX_SENDS_PER_RUN || 25);
const INVITE_DAILY_CAP = Number(process.env.LINKEDIN_INVITE_DAILY_CAP || 10);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const QUIET = argv.includes('--quiet');
const NO_DRAFT = argv.includes('--no-draft');
const SINCE_GIVEN = argv.includes('--since-hours');
const sinceHours = Number(argv[argv.indexOf('--since-hours') + 1]) || 24;

const log = (...a) => { if (!QUIET) console.log(...a); };
const now = () => new Date().toISOString();

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  try { writeFileSync(STATE_PATH, readFileSync(tmp)); } catch {}
}

/**
 * Enrich from local files only: the outreach ledger and contacts already know who this
 * person is and which application they relate to. No LLM, no extra API call.
 */
function enrich(providerId) {
  try {
    const p = findPerson(ROOT, { providerId });
    return {
      name: p?.identity?.name || null,
      company: p?.identity?.company || null,
      role: p?.identity?.role || p?.relatedApplication?.role || null,
      known: Boolean(p?.history?.length),
      messaged: Boolean(p?.messaged),
      messages_sent: p?.history?.length || 0,
      prior_note: p?.lastContact?.message || p?.priorMessages?.[0] || null,
    };
  } catch {
    return { name: null, company: null, role: null, known: false, messaged: false, messages_sent: 0, prior_note: null };
  }
}

/**
 * Who is on the other side of a chat. /chats gives only a provider id; the attendees call
 * returns name, occupation and profile URL for one cheap GET, and only runs for chats with
 * new activity. Without it every inbound reply was queued as "ACoAA…" and the draft
 * prompt said "thread with unknown", which is why the relevance check could never pass.
 */
async function attendee(cfg, chatId, pid) {
  try {
    const a = await unipileGet(cfg, `/chats/${encodeURIComponent(chatId)}/attendees`, {});
    const items = a.items || [];
    const x = items.find((i) => !i.is_self && (!pid || i.provider_id === pid)) || items.find((i) => !i.is_self);
    if (!x) return {};
    return {
      name: x.name || null,
      headline: x.specifics?.occupation || x.specifics?.headline || null,
      profile_url: x.profile_url || null,
      public_id: x.public_identifier || x.specifics?.public_identifier || null,
    };
  } catch { return {}; }
}

const ACK_RE = /^[\s\p{Extended_Pictographic}\p{P}]*$|^(ok(ay)?|thanks?( you)?( so much)?|sounds good|great|perfect|noted|sure|will do|got it|you too|likewise)[\s!.]*$/iu;
// A polite close ("not at this time, I'll let you know") needs a one-line courtesy, not a model.
const CLOSER_RE = /not at this time|keep you in mind|let you know if|have a great (weekend|day|week)|best of luck|all the best|no longer (open|available)|position (has been|is) filled/i;

const ASK_RE = /\b(please|send (me|over|us)|share|apply|forward|email me|reach out|job (number|id)|req(uisition)?( number| id)?\b|drop me)/i;

/** Cheap, deterministic triage so the model is only asked when there is something to answer. */
function classify(thread, who) {
  const last = thread[thread.length - 1];
  if (!last || last.from === 'me') return 'answered';
  const t = String(last.text || '').trim();
  if (t.length <= 3 || ACK_RE.test(t) || t.split(/\s+/).length <= 2) return 'ack';
  // "Best of luck" after an ask ("apply there and send me the job number") is an instruction,
  // not a close: on 2026-09-29 a Jabil recruiter's next-step got the canned "keep me in mind".
  if (!t.includes('?') && t.split(/\s+/).length <= 40 && CLOSER_RE.test(t) && !ASK_RE.test(t)) return 'closer';
  const conversation = thread.some((m) => m.from === 'me');
  return (who.known || conversation) ? 'convo' : 'cold';
}

/**
 * Referral detector. Looks only at THEIR latest message for a capitalised two-part name near a
 * hand-off phrase. Conservative on purpose: a false positive would invite a stranger.
 */
const HANDOFF_RE = /\b(is|are|would be) (the |our |a )?(recruiter|hiring manager|contact|person|point of contact|lead|manager)\b|\b(reach(ing)? out to|connect(ing)? with|contact(ing)?|speak(ing)? (to|with)|talk(ing)? to|get in touch with|refer(red)? you to|point(ed)? you to|introduce you to|loop(ing)? in|ping)\b|\bbest (person|contact|bet)\b/i;
// Name-adjacent hand-offs, case-SENSITIVE so the name right after the verb must be capitalised:
// "Try <CONTACT_NAME>, he leads the tech recruiting team" (<COMPANY_W>, 2026-10-07) matched nothing above.
const NAME = String.raw`[A-Z][a-z]+(?:[-'][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'][A-Z][a-z]+)?`;
const DIRECT_RES = [
  new RegExp(String.raw`\b(?:[Tt]ry|[Pp]ing|[Aa]sk|[Ll]oop in|[Mm]essage) (${NAME})\b`),
  new RegExp(String.raw`\b(${NAME}),? (?:who |he |she |they )?(?:leads|runs|handles|owns|manages|heads)\b`),
];
const NAME_RE = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?) ([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\b/g;
const NOT_NAMES = new Set(['<YOUR_NAME>','<YOUR_NAME>','Hello <YOUR_NAME>','Hi <YOUR_NAME>','Happy To','Talent Acquisition','<COMPANY_X>','Best Regards','Kind Regards','Thank You','Good Luck','Machine Learning','Data Scientist','Software Engineer','Human Resources','Hiring Manager','Remote Role','United States']);
export function detectReferral(text, selfName = '<YOUR_NAME>') {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  for (const re of DIRECT_RES) {
    const m = t.match(re);
    if (m && !NOT_NAMES.has(m[1]) && !m[1].startsWith(selfName.split(' ')[0])) return m[1];
  }
  if (!HANDOFF_RE.test(t)) return null;
  const names = [...t.matchAll(NAME_RE)].map((m) => m[0]).filter((n) => !NOT_NAMES.has(n) && !n.startsWith(selfName.split(' ')[0]));
  if (!names.length) return null;
  // Prefer the name closest to the hand-off phrase.
  const idx = t.search(HANDOFF_RE);
  names.sort((a, b) => Math.abs(t.indexOf(a) - idx) - Math.abs(t.indexOf(b) - idx));
  return names[0];
}

// A referral that hinges on work authorisation ("if you're eligible without sponsorship now or in
// the future … try <CONTACT_NAME>") is one this candidate fails: modes/_profile.md says <VISA_NEED>.
// Such referrals are never acted on automatically; the condition is shown to <YOUR_NAME> instead.
const CONDITION_RE = /[^.!?\n]*\b(sponsor(ship)?|visa|h-?1b|citizen(ship)?|green card|permanent resident|clearance|authori[sz]ed to work|eligible to work|work authori[sz]ation)\b[^.!?\n]*[.!?]?/i;
/** Their latest message → { person, condition } or null. Pure, so the regression test can drive it. */
export function referralFrom(thread) {
  const theirs = [...(thread || [])].reverse().find((m) => m.from === 'them');
  const person = theirs ? detectReferral(theirs.text) : null;
  if (!person) return null;
  const condition = String(theirs.text).match(CONDITION_RE)?.[0].trim() || null;
  return { person, condition };
}

/** Zero-token reply for a cold inbound pitch. Grounded in what the search actually targets. */
function templateReply(who) {
  const first = (who.name || '').split(/[\s,]+/)[0];
  // ponytail: target role is fixed here; read it from modes/_profile.md if it ever changes.
  return `Hi${first ? ' ' + first : ''}, thanks for reaching out. I'm actively looking at AI/ML engineering roles, so this could be a fit. Could you share the job description, the compensation range, and whether it's remote or hybrid? Happy to set up a short call this week.`;
}

/** New connections: /users/relations carries created_at (epoch ms) = the acceptance time. */
async function pollAcceptances(cfg, since) {
  const res = await unipileGet(cfg, '/users/relations', { account_id: cfg.account, limit: 50 });
  const out = [];
  for (const r of res.items || []) {
    const at = Number(r.created_at);
    if (!at || at <= since) continue;
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    const who = enrich(r.member_id);
    out.push({
      id: eventId('accepted', r.member_id, at),
      kind: 'accepted',
      status: 'new',
      provider_id: r.member_id,
      public_id: r.public_identifier || null,
      profile_url: r.public_profile_url || null,
      headline: r.headline || null,
      occurred_at: new Date(at).toISOString(),
      detected_at: now(),
      ...who,
      name: name || who.name,
    });
  }
  return out;
}

/**
 * Inbound replies: their messages, not ours. is_sender truthy means we wrote it.
 * Only chats whose last activity is newer than the watermark are opened, so a quiet
 * inbox costs one request.
 */
async function pollReplies(cfg, since, chatByPid = new Map()) {
  const chats = await unipileGet(cfg, '/chats', { account_id: cfg.account, limit: 40 });
  for (const c of chats.items || []) if (c.attendee_provider_id && !chatByPid.has(c.attendee_provider_id)) chatByPid.set(c.attendee_provider_id, c.id);
  const out = [];
  for (const c of chats.items || []) {
    const ts = Date.parse(c.timestamp || 0);
    if (!ts || ts <= since) continue;
    let msgs;
    try {
      msgs = await unipileGet(cfg, `/chats/${encodeURIComponent(c.id)}/messages`, { limit: 20 });
    } catch { continue; }
    const theirs = (msgs.items || []).filter((m) => !m.is_sender && m.text && Date.parse(m.timestamp) > since);
    if (!theirs.length) continue;
    // One event per conversation, not per message. Christian sent 4 messages in a row on
    // 2026-09-04; that is one thing to look at, not four pings.
    const latest = theirs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    const pid = c.attendee_provider_id;
    const ledger = enrich(pid);
    const att = await attendee(cfg, c.id, pid);
    const who = { ...ledger, ...Object.fromEntries(Object.entries(att).filter(([, v]) => v)) };

    // Keep the thread on the event, oldest first, both sides: it is the context a draft
    // needs, and storing it means a draft can be regenerated later without another call.
    const fullThread = (msgs.items || [])
      .filter((m) => m.text)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((m) => ({ from: m.is_sender ? 'me' : 'them', text: m.text, at: m.timestamp }));

    out.push({
      id: eventId('replied', pid, Date.parse(latest.timestamp)),
      kind: 'replied',
      status: 'new',
      cls: classify(fullThread, who),
      provider_id: pid,
      chat_id: c.id,
      message_count: theirs.length,
      preview: theirs.map((m) => m.text).join(' | ').slice(0, 400),
      thread: fullThread.slice(-30),
      occurred_at: new Date(Date.parse(latest.timestamp)).toISOString(),
      detected_at: now(),
      draft: null,
      ...who,
    });
  }
  return out;
}

/** Decide, per event, whether the model is asked at all. Mutates e.draft / e.status. */
async function draftEvents(events) {
  const up = !NO_DRAFT && (MANAGED ? managedConfigured() : await assistUp());
  let budget = MAX_LLM_DRAFTS;
  for (const e of events) {
    if (e.kind !== 'replied') continue;   // acceptances are drafted in acceptanceStage()
    let instruction;
    if (e.cls === 'answered' || e.cls === 'ack') { e.status = 'dismissed'; e.dismiss_reason = e.cls; continue; }
    // Referral: their latest message hands me to a named person.
    // With the managed agent, referrals are read from context (it returns refer_to); the regex
    // missed "It would be Felipe to reach out to" + his profile link (<CONTACT_NAME>, 2026-10-15).
    if (e.cls === 'convo' && !MANAGED) {
      const ref = referralFrom(e.thread);
      const person = ref?.person;
      if (person && e.company && ref.condition) {
        e.cls = 'referral'; e.referral = { person, company: e.company, condition: ref.condition };
        e.status = 'needs_you';
        e.needs_you = `referral to ${person} is conditional: "${ref.condition.slice(0, 200)}" — your profile says <VISA_NEED>, so nothing was sent. Decide whether to contact ${person} or reply yourself.`;
        continue;
      }
      if (person && e.company) {
        e.cls = 'referral'; e.referral = { person, company: e.company };
        const first = (e.name || '').split(/[\s,]+/)[0];
        e.draft = { text: `Thanks${first ? ' ' + first : ''}, appreciate the pointer. I'll reach out to ${person} directly.`, model: 'template', drafted_at: now() };
        continue;
      }
    }
    // The managed agent reads closers itself: the template re-pitched people who had said they
    // would come back, and thanked people <YOUR_NAME> had already thanked.
    if (e.cls === 'closer' && !MANAGED) {
      const first = (e.name || '').split(/[\s,]+/)[0];
      e.draft = { text: `Thanks${first ? ' ' + first : ''}, appreciated. Please do keep me in mind if anything opens up on the AI/ML side. Have a good one.`, model: 'template', drafted_at: now() };
      continue;
    }
    const messages = e.thread;
    // Did they ask which req/posting this is? If so, prove the answer from local records.
    const theirLast = [...e.thread].reverse().find((m) => m.from === 'them')?.text || '';
    if (asksAboutJobId(theirLast)) {
      const facts = jobFactsFor({ root: ROOT, providerId: e.provider_id, company: e.company, role: e.role });
      if (facts) {
        e.job_facts = { req: facts.req, url: facts.url, ambiguous: facts.ambiguous, source: facts.source };
        instruction = factsInstruction(facts);
        e.company = e.company || facts.company; e.role = e.role || facts.role;
      } else {
        e.job_facts = { error: 'asked about a req/posting id, but no application URL is on file for this contact' };
      }
    }
    // Did they SEND a posting? Then read it before answering. A recruiter's description of
    // their own req is a sales summary, not the req: on 2026-09-17 one described "AI Software
    // Engineer 3" and the reply, drafted from that line alone, declined it as a generic
    // "Software Engineer 3" while asking the same recruiter for AI/ML roles. The posting was
    // an agentic-AI req the whole time. Fetching it is the difference between a grounded
    // answer and a confident guess, so it happens BEFORE the model is asked anything.
    const postingUrls = postingUrlsIn(theirLast);
    if (postingUrls.length) {
      const facts = await postingFactsFor(postingUrls[0]);
      e.posting = facts
        ? { url: facts.url, title: facts.title, req: facts.req, source: facts.source, closed: facts.closed || false,
            years: facts.years, pay: facts.pay, bars: facts.screen?.bars?.map((b) => b.id) || [] }
        : { url: postingUrls[0], error: 'could not read the posting' };
      const pi = postingInstruction(facts);
      // The posting is the primary source, so it leads; any req-id proof from local records
      // follows it rather than competing with it.
      if (pi) instruction = instruction ? `${pi}\n\n${instruction}` : pi;
      if (facts?.title) e.role = e.role || facts.title;
      if (facts?.company) e.company = e.company || facts.company;
    }
    // Application status is a fact like a req number: only from records, never from the model.
    const status = applicationStatusFor({ root: ROOT, company: e.company });
    e.app_status = status ? { verdict: status.verdict, last_applied: status.last_applied, last_rejected: status.last_rejected } : null;
    const si = statusInstruction(status, e.company);
    instruction = [instruction, si, noEmployerInstruction(e.company)].filter(Boolean).join('\n\n');
    if (!up) { e.draft = { error: MANAGED ? 'managed drafter not configured' : 'assist server not reachable' }; continue; }
    if (budget <= 0) { e.draft = { error: `not drafted: per-run cap of ${MAX_LLM_DRAFTS} reached` }; continue; }
    budget -= 1;
    if (MANAGED) {
      applyDecision(e, await draftManaged({
        kind: 'replied', cls: e.cls, name: e.name, headline: e.headline, company: e.company, role: e.role,
        profileUrl: e.profile_url, providerId: e.provider_id, chatId: e.chat_id, thread: e.thread, instruction,
      }, { timeoutMs: DRAFT_TIMEOUT_MS }));
      continue;
    }
    const d = await draftReply({
      messages, instruction,
      correspondent: e.name || null,
      headline: e.headline || null,
      providerId: e.provider_id,
      publicId: e.public_id || null,
      profileUrl: e.profile_url || null,
      company: e.company || null,
      role: e.role || null,
    }, { timeoutMs: DRAFT_TIMEOUT_MS });
    e.draft = d.text
      ? { text: d.text, model: d.model, drafted_at: now() }
      : (e.cls === 'cold' && !e.posting
          ? { text: templateReply(e), model: 'template', drafted_at: now(), fallback_reason: d.error }
          : { error: d.error, withheld: d.withheld || null });
  }
  // Cold pitches the model never reached (server down / cap) still get the template — UNLESS
  // they sent a posting. The template asks them to share the job description, which is absurd
  // when they already attached it, and auto-sending an ungrounded reply to a message that
  // contains a live req is the exact failure this run is meant to prevent. Those wait for a human.
  // Not with the managed agent: when it fails, a canned reply is the out-of-context answer it replaces.
  for (const e of MANAGED ? [] : events) {
    if (e.kind === 'replied' && e.cls === 'cold' && e.status === 'new' && !e.draft?.text && !e.posting) {
      e.draft = { text: templateReply(e), model: 'template', drafted_at: now(), fallback_reason: e.draft?.error || 'not drafted' };
    }
  }
}

/**
 * Acceptances: draft + send the first message. `existing` = provider ids that already have a
 * chat (from the /chats list) or a queued reply; the ledger's `messaged` flag covers DMs sent
 * by other agents. Returns the events that were touched (fresh or re-opened from the queue).
 */
async function acceptanceStage(cfg, events, chatByPid, repliedPids, state) {
  const up = !NO_DRAFT && (MANAGED ? managedConfigured() : await assistUp());
  let budget = MAX_LLM_DRAFTS;
  for (const e of events) {
    if (e.kind !== 'accepted' || e.status !== 'new' || e.draft?.text) continue;
    const who = enrich(e.provider_id);
    if (who.messaged) { e.status = 'dismissed'; e.dismiss_reason = 'already messaged'; continue; }
    if (repliedPids.has(e.provider_id)) { e.status = 'dismissed'; e.dismiss_reason = 'conversation exists'; continue; }
    // LinkedIn turns an invitation NOTE into a chat the moment they accept. A thread that holds
    // only my note is not a conversation: reply inside it. Anything from them, or a second
    // message from me, means a conversation already exists.
    e.chat_id = chatByPid.get(e.provider_id) || null;
    if (e.chat_id) {
      let msgs = [];
      try { msgs = ((await unipileGet(cfg, `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: 10 })).items || []).filter((m) => m.text); } catch { msgs = null; }
      if (!msgs) { e.draft = { error: 'could not read the existing thread' }; continue; }
      if (msgs.some((m) => !m.is_sender) || msgs.filter((m) => m.is_sender).length >= 2) { e.status = 'dismissed'; e.dismiss_reason = 'conversation exists'; continue; }
    }
    if (!who.prior_note && !who.company) { e.draft = { error: 'no context: not in the ledger' }; continue; }
    if (!up) { e.draft = { error: MANAGED ? 'managed drafter not configured' : 'assist server not reachable' }; continue; }
    if (budget <= 0) { e.draft = { error: `not drafted: per-run cap of ${MAX_LLM_DRAFTS} reached` }; continue; }
    budget -= 1;
    if (MANAGED) {
      const status = applicationStatusFor({ root: ROOT, company: who.company });
      applyDecision(e, await draftManaged({
        kind: 'accepted', name: e.name, headline: e.headline, company: who.company, role: who.role,
        profileUrl: e.profile_url, providerId: e.provider_id, chatId: e.chat_id, priorNote: who.prior_note,
        instruction: [statusInstruction(status, who.company), noEmployerInstruction(who.company)].filter(Boolean).join('\n\n'),
      }, { timeoutMs: DRAFT_TIMEOUT_MS }));
      e.company = e.company || who.company; e.role = e.role || who.role;
      continue;
    }
    const d = await draftReply({
      messages: [{ from: 'me', text: who.prior_note || `Connection request sent to ${e.name} (${who.role || 'role on file'} at ${who.company}).` }],
      instruction: 'They just accepted the connection invitation. Write the first message after acceptance: thank them briefly, '
        + 'one concrete line tying the candidate to the role they applied for (use the related application block when present; '
        + 'when there is none, tie it to the AI/ML roles they recruit for and never claim an application), '
        + 'and one clear ask: a short call this week, or a pointer to the hiring manager. Do not repeat the invitation note. Under 90 words.\n\n'
        + statusInstruction(applicationStatusFor({ root: ROOT, company: who.company }), who.company)
        + (noEmployerInstruction(who.company) ? '\n\n' + noEmployerInstruction(who.company) : ''),
      correspondent: e.name || null, headline: e.headline || null, providerId: e.provider_id, publicId: e.public_id || null,
      profileUrl: e.profile_url || null, company: who.company || null, role: who.role || null,
    }, { timeoutMs: DRAFT_TIMEOUT_MS });
    e.company = e.company || who.company; e.role = e.role || who.role;
    e.draft = d.text ? { text: d.text, model: d.model, drafted_at: now() } : { error: d.error, withheld: d.withheld || null };
  }
}

// One polite nudge when a real conversation goes quiet after <YOUR_NAME>'s message (<YOUR_NAME>, 2026-10-15):
// they replied at least once, <YOUR_NAME> wrote last 7-10 days ago, and the thread was never nudged.
const NUDGE_AFTER_MS = 7 * 86400_000, NUDGE_WINDOW_MS = 3 * 86400_000;
export function followupDue(msgs, nowMs = Date.now()) {
  const m = msgs.filter((x) => x.text).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const last = m.at(-1);
  if (!last?.is_sender || !m.some((x) => !x.is_sender)) return false;
  const age = nowMs - Date.parse(last.timestamp);
  return age >= NUDGE_AFTER_MS && age < NUDGE_AFTER_MS + NUDGE_WINDOW_MS;
}

/** Once a day: let the agent decide a nudge for each due thread. Every thread is evaluated once, ever. */
async function followupStage(cfg, state) {
  if (!MANAGED || NO_DRAFT || !managedConfigured() || (!AUTOSEND && !DRY)) return [];
  const today = new Date().toISOString().slice(0, 10);
  if (!DRY && state.followups?.date === today) return [];
  const nudged = { ...(state.followups?.chats || {}) };
  const nowMs = Date.now();
  let chats;
  try { chats = await unipileGet(cfg, '/chats', { account_id: cfg.account, limit: 100 }); } catch (err) { log(`followups: ${err.message}`); return []; }
  const out = [];
  for (const c of chats.items || []) {
    if (out.length >= MAX_LLM_DRAFTS) break;
    const age = nowMs - Date.parse(c.timestamp || 0);
    if (!(age >= NUDGE_AFTER_MS && age < NUDGE_AFTER_MS + NUDGE_WINDOW_MS) || nudged[c.id]) continue;
    let msgs;
    try { msgs = (await unipileGet(cfg, `/chats/${encodeURIComponent(c.id)}/messages`, { limit: 30 })).items || []; } catch { continue; }
    if (!followupDue(msgs, nowMs)) continue;
    const pid = c.attendee_provider_id;
    const who = { ...enrich(pid), ...Object.fromEntries(Object.entries(await attendee(cfg, c.id, pid)).filter(([, v]) => v)) };
    const thread = msgs.filter((m) => m.text).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((m) => ({ from: m.is_sender ? 'me' : 'them', text: m.text, at: m.timestamp }));
    const last = thread.at(-1);
    const e = {
      id: eventId('followup', pid, Date.parse(last.at)), kind: 'followup', status: 'new', cls: 'followup',
      provider_id: pid, chat_id: c.id, message_count: thread.length,
      preview: `(no reply for ${Math.floor((nowMs - Date.parse(last.at)) / 86400_000)} days) ${last.text}`.slice(0, 400),
      thread: thread.slice(-30), occurred_at: new Date(Date.parse(last.at)).toISOString(), detected_at: now(), draft: null, ...who,
    };
    nudged[c.id] = today;
    applyDecision(e, await draftManaged({
      kind: 'followup', name: e.name, headline: e.headline, company: e.company, role: e.role, profileUrl: e.profile_url,
      providerId: pid, chatId: c.id, thread: e.thread,
      instruction: [statusInstruction(applicationStatusFor({ root: ROOT, company: e.company }), e.company), noEmployerInstruction(e.company)].filter(Boolean).join('\n\n'),
    }, { timeoutMs: DRAFT_TIMEOUT_MS }));
    out.push(e);
  }
  const cutoff = new Date(nowMs - 60 * 86400_000).toISOString().slice(0, 10);   // 60 days of "already nudged"
  state.followups = { date: today, chats: Object.fromEntries(Object.entries(nudged).filter(([, d]) => d >= cutoff)) };
  return out;
}

// <YOUR_NAME>, 2026-10-08: LinkedIn messages never name a company from the resume — experience is
// described by role, years, domain and results. 49 of 157 drafts to date named <PAST_EMPLOYER> or
// <PAST_EMPLOYER_2>. The employer list and detector are shared (deploy/linkedin-send.mjs).
export function noEmployerInstruction(theirCompany, list = resumeCompanies()) {
  const names = pastEmployers(theirCompany, list);
  if (!names.length) return null;
  return `NEVER name a company the candidate has worked for (${names.join(', ')}), even though the sources do. `
    + 'Describe that experience by role, years, domain and results only, e.g. "in my AI/ML Engineer role I built…" or '
    + '"as a Machine Learning Scientist I designed…". Naming the company the recipient works at is fine.';
}
export { resumeCompanies, pastEmployerIn };

/** A stuck item whose current blocker has not been shown yet. `notified_error` is set after Telegram accepted it. */
export const stillStuck = (e) => Boolean(e.draft?.error) && e.draft.error !== e.notified_error;

const AUTOSEND = process.env.LINKEDIN_AUTOSEND === '1';
// Up to 8 words between the subject and the verb, same sentence: "I'll keep my application as
// submitted and reach out to <CONTACT_NAME> directly" (<COMPANY_W>, 2026-10-07) slipped past the old 3-word window.
const PROMISE_RE = /\b(I['’]ll|I will|I am going to|I['’]m going to|let me)\s+([\w'’]+,?\s+){0,8}?(send|share|apply|submit|review|follow up|get back|reach out|forward|email|fill|complete|look into|check|schedule|book|call|update|reply|respond|provide|prepare|message|contact|connect|introduce)\b|\b(shortly|by (tomorrow|tonight|end of day|eod|monday|tuesday|wednesday|thursday|friday))\b/i;
// Nothing local can prove an application is still alive (tsenta only knows it was submitted; the
// mailbox only knows rejections), so a draft that says it is gets held.
const STATUS_CLAIM_RE = /\b(?:my |the )?application (?:is |remains |was )?(?:still )?(?:under review|in review|in process|in progress|active|pending|being reviewed|moving forward)\b|\bkeep(?:ing)? my application (?:as submitted|active|in)\b|\bstill (?:under|in) (?:review|consideration)\b/i;

/** Send what was drafted, after re-reading each thread. Mutates e.status / e.send and state.sends. */
async function sendStage(cfg, events, state) {
  const today = new Date().toISOString().slice(0, 10);
  // `count` is kept for backward compatibility with anything reading the old shape; messages and
  // invitations are now tracked separately because only invitations are rationed.
  if (!state.sends || state.sends.date !== today) state.sends = { date: today, count: 0, messages: 0, invites: 0 };
  if (state.sends.messages == null) state.sends.messages = state.sends.count || 0;
  if (state.sends.invites == null) state.sends.invites = 0;
  let thisRun = 0;
  const bump = (kind) => { state.sends.count += 1; state.sends[kind] += 1; thisRun += 1; };
  for (const e of events) {
    if (e.status !== 'new' || !e.draft?.text) continue;
    if (e.kind === 'replied' && !['convo', 'cold', 'closer', 'referral'].includes(e.cls)) continue;
    if (DRY) { e.send = { skipped: 'dry run' }; continue; }
    if (!AUTOSEND) { e.send = { skipped: 'autosend off (LINKEDIN_AUTOSEND!=1)' }; continue; }
    const text = String(e.draft.text).trim();
    if (text.length < 20 || text.length > 1200 || /\[[^\]]*\]|\bTBD\b|lorem ipsum|\{\{/i.test(text)) { e.send = { skipped: 'draft failed sanity check' }; continue; }
    // A draft that PROMISES a future action ("I'll send the materials shortly", "I'll apply and
    // send the job number") commits <YOUR_NAME> to something nothing here will ever do. Backtest
    // 2026-09-29: 4 of 86 auto-sends in 30 days did this, one promising an ID screenshot. Every
    // path (model, template, acceptance) goes through this gate; only the referral template is
    // exempt because its "I'll reach out" is backed by the invite sent just below.
    if (e.cls !== 'referral' && PROMISE_RE.test(text)) {
      e.send = { skipped: `needs you: draft promises an action ("${text.match(PROMISE_RE)[0]}") — do it, then reply yourself` };
      e.status = 'needs_you';
      continue;
    }
    const employer = pastEmployerIn(text, e.company);
    if (employer) {
      e.send = { skipped: `needs you: draft names a past employer from the resume ("${employer}"); LinkedIn messages describe experience by role only` };
      e.status = 'needs_you';
      continue;
    }
    if (STATUS_CLAIM_RE.test(text)) {
      e.send = { skipped: `needs you: draft asserts application status ("${text.match(STATUS_CLAIM_RE)[0]}") that local records do not show` };
      e.status = 'needs_you';
      continue;
    }
    // Runaway breaker only — not a daily ration. Messages have no daily cap.
    if (thisRun >= MAX_SENDS_PER_RUN) { e.send = { skipped: `runaway guard: ${MAX_SENDS_PER_RUN} sends in one run` }; continue; }
    if (e.kind === 'accepted') {
      // First message to a new connection: no thread to re-read, but never twice.
      if (enrich(e.provider_id).messaged) { e.send = { skipped: 'already messaged' }; e.status = 'dismissed'; e.dismiss_reason = 'already messaged'; continue; }
      const r = e.chat_id
        ? await sendLinkedInMessage({ chat_id: e.chat_id, text, name: e.name, company: e.company, role: e.role, provider_id: e.provider_id, public_id: e.public_id })
        : await startLinkedInChat({ attendee_id: e.provider_id, text, name: e.name, company: e.company, role: e.role });
      if (r.ok) { bump('messages'); e.status = 'sent'; e.sent_at = now(); e.sent_message_id = r.message_id || null; e.chat_id = e.chat_id || r.chat_id || null; e.send = { ok: true }; }
      else e.send = { error: r.error };
      continue;
    }
    // Re-read the thread right now. A draft written minutes ago must not answer a thread that moved.
    let fresh;
    try { fresh = await unipileGet(cfg, `/chats/${encodeURIComponent(e.chat_id)}/messages`, { limit: 5 }); }
    catch (err) { e.send = { skipped: `could not re-read thread: ${err.message}` }; continue; }
    const latest = (fresh.items || []).filter((m) => m.text).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    if (!latest) { e.send = { skipped: 'thread empty on re-read' }; continue; }
    if (e.kind === 'followup') {
      // A nudge is only valid while <YOUR_NAME>'s message is still the last one in the thread.
      if (!latest.is_sender || Date.parse(latest.timestamp) !== Date.parse(e.occurred_at)) { e.send = { skipped: 'thread moved; nudge dropped' }; e.status = 'dismissed'; e.dismiss_reason = 'thread moved'; continue; }
    } else {
      if (latest.is_sender) { e.send = { skipped: 'already answered' }; e.status = 'dismissed'; e.dismiss_reason = 'answered'; continue; }
      if (Date.parse(latest.timestamp) > Date.parse(e.occurred_at)) { e.send = { skipped: 'newer message arrived; redraft next run' }; continue; }
    }
    // Referral: invite the named person FIRST (that is the point), then thank the referrer.
    if (e.cls === 'referral') {
      const { person, company } = e.referral;
      // An invitation IS the restricted action, so this one stays rationed. (The MCP's
      // send_invitation also enforces the reconciled account budget, which counts invites sent
      // by every other agent; this cap just keeps the poller's own share modest.)
      // At the cap the invite is skipped, not the referral: an Open Profile still gets a free InMail.
      const capped = state.sends.invites >= INVITE_DAILY_CAP;
      const first = (e.name || '').split(/[\s,]+/)[0];
      // The managed agent writes the note; it must fit LinkedIn's 300-char limit and name no past
      // employer. Otherwise a fallback that claims nothing (the old one said "I've applied" whether
      // or not that was true).
      const agentNote = String(e.referral.note || '').trim();
      const invNote = agentNote && agentNote.length <= 300 && !pastEmployerIn(agentNote, company) ? agentNote
        : `Hi ${person.split(' ')[0]}, ${first || 'a colleague'} at ${company} suggested I reach out. I build production ML and RAG systems end to end and would value connecting.`.slice(0, 300);
      const inv = await inviteReferredPerson({ person, company, referrer: e.name, role: e.role, note: invNote, profileUrl: e.referral.profile_url, skipInvite: capped });
      e.referral.invite = inv.ok ? { ok: true, name: inv.profile.name, headline: inv.profile.headline, url: inv.profile.url, invitation_id: inv.invitation_id || null, inmail: inv.inmail || false, note: invNote } : { error: inv.error, candidate: inv.candidate || null };
      if (!inv.ok) {
        // Without the invite or InMail, the thank-you would be a lie ("I've reached out"), so hold it for a human.
        e.send = { skipped: `referral invite failed: ${inv.error}` };
        if (inv.needs_you) { e.status = 'needs_you'; e.needs_you = `referral to ${person}: ${inv.error}`; }
        continue;
      }
      if (!inv.inmail) bump('invites');
    }
    const r = await sendLinkedInMessage({ chat_id: e.chat_id, text, name: e.name, company: e.company, role: e.role, provider_id: e.provider_id, public_id: e.public_id, attachment_path: e.attachment || undefined });
    if (r.ok) {
      bump('messages');
      e.status = 'sent'; e.sent_at = now(); e.sent_message_id = r.message_id || null; e.send = { ok: true };
    } else {
      e.send = { error: r.error };
    }
  }
}

const DIGEST_FLAG = join(ROOT, 'deploy', 'linkedin-digest-now.flag');
const ctClock = (at) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: '<YOUR_TZ>', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
  .formatToParts(at).map((x) => [x.type, x.value]));

/** Sunday from 19:00 CT, once a week: the scorecard (what to automate next is its last section). */
export async function sendScorecard(state, at = new Date(), send = notify, rows = readQueue()) {
  const p = ctClock(at);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (p.weekday !== 'Sun' || +p.hour < 19 || state.scorecardSentOn === day) return false;
  if (!(await send(scorecard(rows, 7, at.getTime())))) return false;
  state.scorecardSentOn = day;
  return true;
}

/** First run at or after 20:00 CT (or any run when forced) sends everything queued since the last digest, in Telegram-sized parts. */
export async function sendDigest(state, at = new Date(), send = notify, force = false) {
  const p = ctClock(at);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (!state.digest?.length || (!force && (+p.hour < 20 || state.digestSentOn === day))) return false;
  const sent = state.digest.filter((b) => b.includes('SENT ✓')).length;
  const parts = [`LinkedIn digest ${day}: ${sent} sent automatically, ${state.digest.length - sent} skipped (no reply needed)`];
  for (const b of state.digest) {
    if ((parts.at(-1) + '\n\n' + b).length > 3800) parts.push(b.slice(0, 3800));
    else parts[parts.length - 1] += '\n\n' + b;
  }
  for (const part of parts) if (!(await send(part))) return false;   // keep the queue if Telegram refused
  state.digest = [];
  if (!force) state.digestSentOn = day;   // an early /digest does not cancel tonight's
  return true;
}

function render(e, refreshed) {
  const who = e.name || e.public_id || e.provider_id?.slice(0, 12);
  const at = e.company ? ` @ ${e.company}` : '';
  const head = e.kind === 'accepted'
    ? `• ${who}${at} accepted your invite\n  ${(e.headline || '').slice(0, 90)}`
    : `• ${who}${at} replied (${e.message_count} msg${refreshed ? ', updated thread' : ''}) [${e.cls}]\n  ${(e.headline || '').slice(0, 90)}\n  "${e.preview.slice(0, 200)}"`;
  let block = head;
  if (e.job_facts?.req || e.job_facts?.url) {
    block += `\n  LOOKED UP: ${e.job_facts.req ? 'req ' + e.job_facts.req : 'posting link'}${e.job_facts.ambiguous ? ' (MULTIPLE postings — both named)' : ''}`;
  } else if (e.job_facts?.error) {
    block += `\n  ASKED for a req/posting id but none on file — replied without one`;
  }
  if (e.referral) {
    const inv = e.referral.invite || {};
    block += inv.ok ? `\n  REFERRAL → ${inv.inmail ? 'free InMail to' : 'invited'} ${inv.name} (${(inv.headline || '').slice(0, 60)})\n  ${inv.url}\n  note: ${inv.note}`
                    : `\n  REFERRAL to ${e.referral.person} @ ${e.referral.company} — invite NOT sent: ${inv.error || 'not attempted'}`;
    const c = inv.candidate;
    if (c) block += `\n  candidate: ${c.name} (${(c.headline || '').slice(0, 60)}) ${c.url || ''}${c.is_open_profile ? ' — OPEN profile: a free InMail works' : ''}`;
  }
  if (e.agent) block += `\n  AGENT read: ${e.agent.their_ask}\n  AGENT decided: ${e.agent.action} (${e.agent.reason})`;
  if (e.status === 'needs_you' && e.needs_you) block += `\n  NEEDS YOU: ${e.needs_you}`;
  if (e.draft?.text) {
    const verdict = e.send?.ok ? 'SENT ✓' : e.send?.error ? `SEND FAILED: ${e.send.error}` : e.send?.skipped ? `NOT SENT: ${e.send.skipped}` : 'not sent';
    block += `\n\n  ${verdict} — ${e.draft.model || 'unknown model'}${e.draft.fallback_reason ? ` (template fallback: ${e.draft.fallback_reason})` : ''}:\n  ${e.draft.text.slice(0, 1200)}${e.attachment ? `\n  📎 ${e.attachment}` : ''}`;
  } else if (e.draft?.error) {
    block += `\n  (no draft: ${e.draft.error}) — needs you`;
  }
  return `${block}\n  ref ${handle(e.id)}`;
}

async function main() {
  const cfg = unipileConfig(ROOT);
  if (!cfg) { console.error('Unipile not configured (need UNIPILE_API_BASE/API_KEY/ACCOUNT_ID in .env)'); process.exit(1); }

  const state = readState();
  const fallback = Date.now() - sinceHours * 3600_000;
  const override = DRY && SINCE_GIVEN;
  const sinceRel = override ? fallback : (state.lastRelationAt || fallback);
  const sinceMsg = override ? fallback : (state.lastMessageAt || fallback);

  const chatByPid = new Map();
  const [accepted, replied] = await Promise.all([
    pollAcceptances(cfg, sinceRel).catch((e) => { console.error('relations:', e.message); return []; }),
    pollReplies(cfg, sinceMsg, chatByPid).catch((e) => { console.error('chats:', e.message); return []; }),
  ]);
  log(`accepted=${accepted.length} replied=${replied.length}`);

  // A conversation that already has an open item gets that item refreshed, not a second one.
  const open = new Map(readQueue().filter((e) => e.status === 'new' && e.chat_id).map((e) => [e.chat_id, e]));
  const known = new Set(readQueue().map((e) => e.id));
  // A dry run with an explicit lookback re-examines everything in the window, so a change to
  // classification or drafting can be judged against real recent traffic.
  const fresh = [...accepted, ...replied].filter((e) => override || !known.has(e.id));
  // Still-open items from the last 72h that never got a draft: acceptances stranded by a failed
  // run, the cap or a down server, and replies whose draft was withheld but which the newer
  // triage can now handle (e.g. a referral hand-off). Re-run them like fresh events.
  // An item still `new` is by definition unfinished, so retry it — not only when it never got a
  // draft, but also when it HAS one that was skipped or errored on the way out (a cap, the assist
  // server being down, a thread that had moved). Before this, a drafted-but-blocked reply was
  // never looked at again: one recruiter's answer sat drafted and unsent because the reopen
  // filter required `!e.draft?.text`.
  const retryable = (e) => !e.draft?.text || Boolean(e.send?.skipped || e.send?.error);
  const reopened = override ? [] : readQueue().filter((e) => e.status === 'new' && retryable(e)
    && Date.parse(e.occurred_at) > Date.now() - 72 * 3600_000
    && (e.kind === 'accepted' || (e.kind === 'replied' && e.cls === 'convo' && Array.isArray(e.thread) && e.thread.length)));
  // Only spend a model call when there is nothing usable; a good draft that was merely blocked
  // on the way out is reused as-is.
  for (const e of reopened) { e.send = null; if (e.kind === 'replied' && !e.draft?.text) e.draft = null; }
  await draftEvents([...fresh, ...reopened.filter((e) => e.kind === 'replied')]);
  const repliedPids = new Set([...readQueue().filter((e) => e.kind === 'replied').map((e) => e.provider_id), ...replied.map((e) => e.provider_id)]);
  await acceptanceStage(cfg, [...fresh, ...reopened], chatByPid, repliedPids, state);
  const followups = (await followupStage(cfg, state)).filter((e) => !known.has(e.id));
  await sendStage(cfg, [...fresh, ...reopened, ...followups], state);

  if (DRY) {
    console.log(JSON.stringify([...fresh, ...reopened, ...followups], null, 2));
    return;
  }
  for (const e of reopened) { const { id, ...patch } = e; await update(id, patch); }

  const toRefresh = fresh.filter((e) => e.kind === 'replied' && open.has(e.chat_id));
  const toIngest = [...fresh.filter((e) => !toRefresh.includes(e)), ...followups];
  const written = await ingest(toIngest);
  const refreshed = [];
  for (const e of toRefresh) {
    const prev = open.get(e.chat_id);
    const { id, ...patch } = e;
    const r = await update(prev.id, { ...patch, superseded_event: id });
    if (r) refreshed.push(r);
  }
  const dismissed = written.filter((e) => e.status === 'dismissed').length;
  log(`queued ${written.length - dismissed} new, refreshed ${refreshed.length}, dismissed ${dismissed} (${fresh.length - written.filter((e) => e.kind !== 'followup').length - refreshed.length} already known)`);

  // A reopened item is announced when it got SENT this run, or when its blocker is new. A stuck one
  // (an acceptance with "no context") is retried every run on purpose, but announcing it every run
  // sent the same four profiles to Telegram every ~5 minutes (2026-10-13). See stillStuck().
  const announce = reopened.filter((e) => e.status === 'sent' || stillStuck(e));
  // <YOUR_NAME>, 2026-10-15: anything that needs a human pings at once; auto-sent replies and agent
  // "no reply" skips go into one evening digest instead (still visible, so a wrong skip is caught).
  const items = [...written.filter((e) => e.status === 'new' || e.status === 'sent' || e.status === 'needs_you' || e.agent?.action === 'no_reply').map((e) => [e, false]),
    ...refreshed.map((e) => [e, true]), ...announce.map((e) => [e, false])];
  const quiet = ([e]) => e.status === 'sent' || e.agent?.action === 'no_reply';
  const show = items.filter((i) => !quiet(i));
  state.digest = [...(state.digest || []), ...items.filter(quiet).map(([e, r]) => render(e, r))];
  log(`telegram: ${show.length} item(s) to announce, ${items.filter(quiet).length} to the digest, ${reopened.filter((e) => e.draft?.error).length - announce.filter((e) => e.draft?.error).length} stuck item(s) already announced`);
  if (show.length) {
    // One message per item, each with its own Send / Edit / Skip buttons (telegram-control.mjs acts on them).
    let ok = await notify(`LinkedIn: ${show.length} for you. ` + (AUTOSEND ? 'Auto-send is ON; what went out is in the 8pm digest.' : 'Auto-send is OFF; nothing was sent automatically.'));
    for (const [e, r] of show) ok = (await notify(render(e, r), { buttons: buttonsFor(e) })) && ok;
    // Remember what was shown, only if Telegram took it: the same blocker is not shown again.
    if (ok) for (const e of [...written, ...reopened]) if (e.status === 'new' && e.draft?.error) await update(e.id, { notified_error: e.draft.error });
  }
  // /digest in Telegram drops this flag so the next run sends the digest early.
  const digestNow = existsSync(DIGEST_FLAG);
  if (await sendDigest(state, new Date(), notify, digestNow) || digestNow) { try { unlinkSync(DIGEST_FLAG); } catch { /* already gone */ } }
  await sendScorecard(state);

  // Advance watermarks only over what we actually saw, so a failed leg does not skip events.
  const maxOf = (arr, k) => arr.reduce((m, e) => Math.max(m, Date.parse(e[k])), 0);
  writeState({
    ...state,
    lastRelationAt: Math.max(sinceRel, maxOf(accepted, 'occurred_at')),
    lastMessageAt: Math.max(sinceMsg, maxOf(replied, 'occurred_at')),
    lastRunAt: now(),
  });
}

// Importable: the regression tests drive classify/referralFrom/the gates without running a poll.
export { classify, draftEvents, sendStage, PROMISE_RE, STATUS_CLAIM_RE };
// Health: a failed run is announced on Telegram, not only in the journal (<YOUR_NAME>, 2026-10-15).
if (isMainModule(import.meta.url)) main().catch(async (e) => { console.error(e.message); await notify(`⚠️ LinkedIn poller run failed: ${String(e.message || e).slice(0, 300)}`); process.exit(1); });
