// draft.mjs — POST /api/assist/draft and POST /api/assist/chat.
//
// Spec §4: "Message-reply, post and jobs-page flows use the same pipeline with a DOM extractor
// supplying `extracted` instead of a pasted question list, and a different system prompt."
// So the grounding, filters and verification are identical to the answers flow — only the
// prompt and the shape of `extracted` differ.
//
// Read-only.
import fs from 'fs';
import path from 'path';
import { readSource, runFilters, stripEmDashes, availableSources } from './grounding.mjs';
import { verifyClaims, parseModelEnvelope } from './verify.mjs';
import { generate, modelOrder } from './runner.mjs';
import { screenJD } from './bars.mjs';
import { companyContext } from './context.mjs';
import { findPerson, personBlock, checkRelevance } from './person.mjs';


const JSON_CONTRACT = `
OUTPUT FORMAT — return ONLY valid JSON, no prose around it:
{"draft":"<your text>","claims":[{"text":"<factual statement you made>","sourceFile":"<exact source filename given to you>","sourceQuote":"<VERBATIM span of 12+ characters copied from that file>"}]}
The sourceQuote is checked mechanically against the file. A quote that is not verbatim is
discarded and the draft is marked unverified.`;

const PROMPTS = {
  message: `You draft LinkedIn replies for one specific candidate.
Write a short, direct reply in the candidate's voice. No marketing language, no filler openers,
no "I hope this finds you well". Match the register of the incoming message. Under 120 words
unless the thread clearly needs more. Never invent experience. If they ask for a fact the
sources do not contain (dates, counts, IDs, visa or work-status details), do NOT guess it and
do NOT state a value for it, not even zero or "none": say you will confirm and send it shortly.
Every number or date you state must be visible in a source file.
Answer every question they asked. When a RELATED APPLICATION block is present, tie the reply
to that role: name one or two of its requirements the candidate's sources demonstrably meet
(cite them in claims), and make one concrete ask (a short call, the next step, or the right
person). If they pitch a role outside the candidate's target roles in the profile, decline in
one polite line and say what would fit instead. If a message is a mass pitch with no specific
role, ask for the job description, compensation range and location/remote policy. Do not use
em dashes.` + JSON_CONTRACT,

  post: `You draft LinkedIn comments for one specific candidate.
A comment should add something real: a specific observation, a relevant experience, or a
genuine question. Never generic praise. Two to four sentences. Never invent experience.
Do not use em dashes.` + JSON_CONTRACT,

  job: `You assess a LinkedIn job posting for one specific candidate and draft a short note on fit.
State plainly what matches the candidate's background and what does not. Do not oversell, and
do not claim experience the sources do not show. Do not use em dashes.` + JSON_CONTRACT,
};

function sourcesBlock(root, pageType) {
  const cv = readSource(root, 'cv-aiml.md') || readSource(root, 'cv.md') || '';
  const digest = readSource(root, 'article-digest.md') || '';
  const voice = readSource(root, 'voice-dna.md') || '';   // optional; absent on this install
  if (pageType === 'message') {
    // Token diet for replies. The profile (targets, work authorisation, comp floor) is what
    // a reply usually needs; the article digest never is; the top of the CV covers "what I
    // do". The full 8k CV + 3.5k digest was most of the prompt and free models timed out on it.
    const profile = readSource(root, 'modes/_profile.md') || '';
    return [
      profile ? `=== SOURCE FILE modes/_profile.md ===\n${profile.slice(0, 2500)}` : '',
      `=== SOURCE FILE cv-aiml.md ===\n${cv.slice(0, 3500)}`,
      voice ? `\n=== VOICE GUIDE (style only, never a source of facts) ===\n${voice.slice(0, 800)}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    `=== SOURCE FILE cv-aiml.md ===\n${cv.slice(0, 8000)}`,
    digest ? `\n=== SOURCE FILE article-digest.md ===\n${digest.slice(0, 3500)}` : '',
    voice ? `\n=== VOICE GUIDE (style only, never a source of facts) ===\n${voice.slice(0, 1200)}` : '',
  ].filter(Boolean).join('\n');
}

function extractedBlock(pageType, extracted) {
  const e = extracted || {};
  if (pageType === 'message') {
    // Recent turns only: enough to see what was already said or agreed. The old whole-thread
    // dump (24k chars) was the single biggest token cost per draft.
    const all = e.messages || [];
    const recent = all.slice(-16);
    let thread = recent.map((m) => `${m.from || '?'}: ${m.text || ''}`).join('\n');
    if (thread.length > 8000) thread = thread.slice(-8000);
    const who = [e.correspondent || 'unknown', e.headline ? `(${String(e.headline).slice(0, 120)})` : ''].filter(Boolean).join(' ');
    return `=== LINKEDIN THREAD with ${who} (last ${recent.length} of ${all.length} messages) ===\n${thread}`;
  }
  if (pageType === 'post') {
    return `=== LINKEDIN POST by ${e.author || 'unknown'} ===\n${String(e.text || '').slice(0, 4000)}`;
  }
  return `=== LINKEDIN JOB: ${e.title || '?'} at ${e.company || '?'} ===\n${String(e.description || '').slice(0, 6000)}`;
}

/**
 * The job description (or the application report, when no JD file was saved) for the
 * application this person is attached to. Context about the ROLE so a reply can match its
 * requirements to the profile; it is never a source of facts about the candidate.
 */
function jdBlock(root, person, extracted = {}) {
  const a = person?.relatedApplication;
  let n = a?.appNumber;
  const company = a?.company || person?.identity?.company || extracted.company || '';
  const role = a?.role || extracted.role || '';
  const pick = (dir, prefix) => {
    try {
      const f = fs.readdirSync(path.join(root, dir)).find((x) => x.startsWith(prefix));
      return f ? fs.readFileSync(path.join(root, dir, f), 'utf8') : '';
    } catch { return ''; }
  };
  let jd = '', report = '';
  if (n) {
    jd = pick('jds', `${String(n).padStart(3, '0')}-`) || pick('jds', `${n}-`);
    report = jd ? '' : pick('reports', `${n}-`);
  } else if (company) {
    // Most inbound recruiters are in the outreach ledger but not in contacts.json, so there is
    // no app number. Fall back to the newest report whose filename carries the company slug.
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 2).join('-');
    try {
      const f = fs.readdirSync(path.join(root, 'reports')).filter((x) => /^\d+-/.test(x) && slug.length >= 3 && x.includes(`-${slug}`)).sort((x, y) => Number(y.split('-')[0]) - Number(x.split('-')[0]))[0];
      if (f) { report = fs.readFileSync(path.join(root, 'reports', f), 'utf8'); n = Number(f.split('-')[0]); }
    } catch {}
  }
  const text = (jd || report).slice(0, 3000);
  if (!text) return '';
  return `=== RELATED APPLICATION${n ? ' #' + n : ''}: ${role} at ${company} (${jd ? 'job description' : 'application report'}; context about the role, NOT a source of facts about the candidate) ===\n${text}`;
}

/** Shared generate → filter → verify pipeline. Identical safety layer to the answers flow. */
async function pipeline(root, { system, user, applicationAnswer = false, signal, maxTokens = 900 }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let skip = [];
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pool = await modelOrder({ exclude: skip });
    const gen = await generate({ messages, maxTokens, signal, models: pool.length ? pool : undefined });
    const env = parseModelEnvelope(gen.text);
    if (!env.ok && attempt < 3) { skip.push(gen.model); continue; }

    const draft = stripEmDashes(env.draft);
    const filters = runFilters(draft, { root, applicationAnswer });
    const verification = verifyClaims(root, env.claims);
    last = {
      draft, model: gen.model, attempt,
      claims: verification.results,
      sources: verification.sources,
      containsUnverified: verification.containsUnverified,
      citationsAvailable: env.ok,
      warnings: [...filters.findings],
      rejected: false,
    };
    if (!filters.fatal) {
      if (!env.ok) last.warnings.push({ rule: 'citations', term: 'unparseable', note: 'sources unavailable, verify manually' });
      return last;
    }
    if (attempt < 3) {
      messages.push({ role: 'assistant', content: draft });
      messages.push({ role: 'user', content: `Rejected: ${filters.findings.filter((f) => f.fatal).map((f) => f.why).join('; ')}. Rewrite without merging those facts.` });
    }
  }
  last.rejected = true;
  last.rejectionReason = last.warnings.filter((f) => f.fatal).map((f) => f.why).join('; ') || 'merged facts that must stay separate';
  last.draft = '';
  return last;
}

/** HTTP handler for POST /api/assist/draft */
export async function handler(ctx) {
  const { pageType, extracted, instruction } = ctx.body || {};
  if (!['message', 'post', 'job'].includes(pageType)) {
    return ctx.json(400, { ok: false, error: 'pageType must be one of: message, post, job' });
  }
  // Spec §8: extraction finding nothing must NOT produce a draft from empty context.
  const hasContent = pageType === 'message'
    ? Boolean(extracted?.messages?.length)
    : Boolean(String(extracted?.text || extracted?.description || '').trim());
  if (!hasContent) {
    return ctx.json(422, {
      ok: false,
      error: 'could not read this page',
      hint: 'Paste the text into the panel instead — a draft from empty context would be worse than none.',
    });
  }

  // A job posting gets the bars screen regardless of the model — pure mechanism, instant,
  // and it is the single highest-value check on this surface (spec §10).
  const screen = pageType === 'job' ? screenJD(extracted.description || '') : null;
  const company = extracted?.company ? await companyContext(ctx.root, extracted.company) : null;

  // Who am I writing to, and what have I already sent them? Without this a "follow-up" can
  // repeat the original opener verbatim, which is the most visible outreach failure there is.
  const person = findPerson(ctx.root, {
    providerId: extracted?.providerId,
    publicId: extracted?.publicId,
    linkedin: extracted?.profileUrl || extracted?.correspondentUrl,
    name: extracted?.correspondent || extracted?.author,
  });

  const user = [
    extractedBlock(pageType, extracted),
    '',
    personBlock(person),
    '',
    pageType === 'message' ? jdBlock(ctx.root, person, { company: extracted?.company, role: extracted?.role }) : '',
    '',
    sourcesBlock(ctx.root, pageType),
    '',
    instruction ? `INSTRUCTION FROM THE USER: ${instruction}` : '',
    pageType === 'message' ? 'Draft a reply.' : pageType === 'post' ? 'Draft a comment.' : 'Draft a short fit note.',
  ].filter(Boolean).join('\n');

  let result;
  try {
    // A reply is under 120 words plus a small claims envelope; 500 tokens is ample.
    // Replies get a hard budget. The primary route (claude: since 2026-09-25) can legitimately
    // run its own CLAUDE_ROUTE_TIMEOUT_MS (150s default, runner.mjs) before falling through to
    // omniroute/nemotron, so this deadline must outlast that or the fallback never gets a turn:
    // 165s = 150s + 15s for one fallback attempt (omniroute measured 0.4-4.4s) plus filter/verify
    // overhead. The poller (deploy/unipile-poll.mjs) now waits at least that long per draft and
    // caps drafts per run, so a reply nobody reads for hours never grinds the fleet for minutes.
    const MESSAGE_DEADLINE_MS = 165_000;
    result = await pipeline(ctx.root, {
      system: PROMPTS[pageType], user,
      maxTokens: pageType === 'message' ? 500 : 900,
      signal: pageType === 'message' ? AbortSignal.timeout(MESSAGE_DEADLINE_MS) : undefined,
    });
  } catch (e) {
    return ctx.json(200, { ok: true, pageType, screen, company, result: { draft: '', error: String(e.message || e), attempts: e.attempts || null } });
  }
  // Deterministic: is this draft actually about THEM, or generic filler? Same spirit as the
  // other filters — measured, not self-reported by the model.
  const theirLast = pageType === 'message'
    ? [...(extracted.messages || [])].reverse().find((m) => m.from === 'them')?.text || null
    : null;
  // Numbers and URLs we explicitly gave the model in `instruction` count as proof of specificity.
  const verifiedTokens = String(instruction || '').match(/\b\d{4,}\b|https?:\/\/\S+/g) || [];
  const relevance = checkRelevance(result.draft, person, { company: extracted?.company, role: extracted?.title || extracted?.role, theirLast, verifiedTokens });
  if (!relevance.relevant && result.draft) {
    result.warnings.push({ rule: 'relevance', term: 'generic', note: relevance.reason });
  }
  if (relevance.repeatsPriorMessage) {
    result.warnings.push({ rule: 'relevance', term: 'repeats-prior-message', note: 'this repeats an opener you already sent to this person' });
  }

  return ctx.json(200, {
    ok: true, pageType, screen, company, person, relevance, result,
    sourcesAvailable: availableSources(ctx.root).map((s) => s.rel),
  });
}

/** HTTP handler for POST /api/assist/chat — free-form, with career context always loaded. */
export async function chatHandler(ctx) {
  const { message, history } = ctx.body || {};
  if (!message || !String(message).trim()) return ctx.json(400, { ok: false, error: 'message is required' });

  const system = `You are a job-search assistant for one specific candidate. Answer using ONLY the
source material provided. If it does not support an answer, say so rather than guessing. Never
invent experience and never claim the candidate authored a tool the CV does not attribute.
Be concise and concrete. Do not use em dashes.` + JSON_CONTRACT;

  const prior = (Array.isArray(history) ? history : []).slice(-6)
    .map((h) => `${h.role === 'assistant' ? 'You' : 'User'}: ${String(h.content || '').slice(0, 600)}`).join('\n');

  const user = [sourcesBlock(ctx.root), '', prior ? `=== EARLIER IN THIS THREAD ===\n${prior}` : '', '', `USER: ${message}`]
    .filter(Boolean).join('\n');

  try {
    const result = await pipeline(ctx.root, { system, user });
    return ctx.json(200, { ok: true, result });
  } catch (e) {
    return ctx.json(200, { ok: true, result: { draft: '', error: String(e.message || e) } });
  }
}
