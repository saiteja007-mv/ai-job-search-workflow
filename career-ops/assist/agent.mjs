// agent.mjs — the agentic RAG loop behind the chat panel.
//
// Shape: model -> tool_calls -> execute -> feed results back -> repeat, until the model answers
// in prose or the step budget runs out. Streams every step over SSE so the panel shows what is
// happening ("searching your JDs…", "reading that LinkedIn post…") instead of a silent spinner
// for a minute — with a tool loop the wait is several model round-trips, so progress reporting
// stops being a nicety.
//
// Budgets are hard, not advisory. A loop that can call tools forever is a loop that can burn a
// free-tier key in one question.
import { TOOL_SCHEMAS, runTool } from './tools.mjs';
import { generateWithTools } from './runner.mjs';
import { runFilters } from './grounding.mjs';

const MAX_STEPS = 8;              // model turns; each may carry several tool calls
const MAX_TOOL_CALLS = 20;        // total across the whole question
const MAX_RESULT_CHARS = 9_000;   // per tool result fed back into context
const MAX_HISTORY = 12;           // prior chat turns carried in

const SYSTEM = `You are <YOUR_NAME>'s job-search copilot. Today is {TODAY}.

You have tools over his own career data (saved job descriptions, tracked applications, CV and
writing, LinkedIn outreach history and threads) and over the live web (search, page fetch,
LinkedIn post reading).

How to work:
- Look things up. Do not answer from memory about his applications, his CV, a company, or a
  posting — call a tool. If you did not retrieve it, say you don't know.
- Prefer his own data (search_career_ops) for anything about him; use the web for anything
  current or external.
- When the user gives you a JOB link or pastes a job description, call evaluate_job. That runs
  his real career-ops rubric and gates; do not hand-wave an opinion about a role without it.
  Produce the block evaluation and an X.X/5 global score from what it returns, lead with any
  hard bar or blacklist hit, and say plainly that nothing was saved to his tracker.
- When the user pastes a LinkedIn URL, call get_linkedin_post on it before responding.
- Before drafting a follow-up to a person, call get_thread so you answer what they actually
  said, not just what he last sent.
- Run check_draft on any outreach or application answer you write, and fix what it flags.
- Cite what you used: name the document, the application number, or the URL.

Style: direct and specific. No filler openers, no "I hope this finds you well", no em dashes in
drafted messages. If a tool fails or returns nothing, say so plainly rather than guessing.`;

const clip = (s, n) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? t.slice(0, n) + '…[truncated]' : t; };

// A short human label per tool call, for the progress line in the panel.
function describe(name, args = {}) {
  const a = args || {};
  switch (name) {
    case 'search_career_ops': return `searching your ${a.kind || 'career'} data for "${clip(a.query, 60)}"`;
    case 'get_document': return `reading ${clip(a.id, 60)}`;
    case 'get_application': return `looking up application ${clip(a.ref, 40)}`;
    case 'web_search': return `searching the web for "${clip(a.query, 60)}"`;
    case 'fetch_url': return `reading ${clip(a.url, 70)}`;
    case 'get_linkedin_post': return 'reading that LinkedIn post';
    case 'search_people': return `looking up "${clip(a.query, 40)}" in your contacts`;
    case 'get_thread': return `loading the thread with ${clip(a.name || a.provider_id, 40)}`;
    case 'get_person': return `checking your history with ${clip(a.name || a.provider_id, 40)}`;
    case 'get_invite_budget': return 'checking your invite budget';
    case 'company_context': return `checking your history with ${clip(a.company, 40)}`;
    case 'screen_jd': return 'screening that JD against your hard bars';
    case 'evaluate_job': return `evaluating that role against your career-ops rubric${a.url ? '' : ' (pasted JD)'}`;
    case 'check_draft': return 'checking the draft against your rules';
    default: return `running ${name}`;
  }
}

// Repair a tool call in place when the model's choice is observably worse than one we can
// determine ourselves.
//
// The case this exists for: the user pastes a full job description that happens to contain a
// "URL:" line. The model reliably picks that url over the text it was just given, the fetch
// returns a JavaScript shell, and the evaluation is refused for want of a JD that was in the
// prompt all along. Prompting did not fix it across two attempts; deciding it here does.
function repairArgs(name, args, userMessage) {
  if (name !== 'evaluate_job') return;
  const pasted = String(userMessage || '');
  if (!args.text && pasted.length > 1200) {
    args.text = pasted;
    delete args.url; // the url would only re-enter the thin-fetch path
  }
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // Some models emit arguments with trailing prose or a fenced block; salvage the first object.
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return {};
}

/**
 * Run one question to completion.
 * `emit(event, data)` is called for: step, tool, tool_result, answer, error, done.
 * Returns the final answer plus the trace, so a non-streaming caller gets the same thing.
 */
export async function runAgent(root, { message, history = [], context = null, signal, emit = () => {} } = {}) {
  if (!String(message || '').trim()) return { ok: false, error: 'empty message' };

  const messages = [
    { role: 'system', content: SYSTEM.replace('{TODAY}', new Date().toISOString().slice(0, 10)) },
  ];
  // Page context (the LinkedIn thread/post/JD the panel is looking at) is injected as a system
  // note rather than pasted into the user's words, so the model can tell them apart.
  if (context && String(context.text || '').trim()) {
    messages.push({
      role: 'system',
      content: `The user is currently looking at this ${context.type || 'page'}${context.url ? ` (${context.url})` : ''}:\n\n${clip(context.text, 12_000)}`,
    });
  }
  for (const h of history.slice(-MAX_HISTORY)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      messages.push({ role: h.role, content: clip(String(h.content), 4_000) });
    }
  }
  messages.push({ role: 'user', content: String(message) });

  const trace = [];
  let toolCallsUsed = 0;
  let usedModel = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    emit('step', { step: step + 1, of: MAX_STEPS });

    let turn;
    try {
      // 4000, not the 1400 default: reasoning models spend tokens before emitting any content,
      // and a full A-D evaluation is long. At 1400 a real answer came back cut off mid-sentence
      // at 205 characters, which reads as a broken model rather than a budget that was too low.
      turn = await generateWithTools({ messages, tools: TOOL_SCHEMAS, maxTokens: 4000, signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const detail = e?.attempts?.length ? e.attempts.map((a) => `${a.model}: ${a.error}`).join(' | ') : String(e.message || e);
      emit('error', { error: 'no model could answer', detail: clip(detail, 600) });
      return { ok: false, error: 'no model could answer', detail: clip(detail, 600), trace, model: usedModel };
    }
    usedModel = turn.model;
    const msg = turn.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      // Prose answer — we're done.
      const answer = String(msg.content || '').trim();
      if (!answer) {
        emit('error', { error: 'model returned an empty answer' });
        return { ok: false, error: 'model returned an empty answer', trace, model: usedModel };
      }
      // Safety net: the model is told to self-check drafts, but don't rely on it having done so.
      const filters = runFilters(answer, { root, applicationAnswer: false });
      const warnings = filters.ok ? [] : filters.findings.map((f) => ({
        rule: f.rule, term: f.term || f.id || f.subject || null, fatal: Boolean(f.fatal),
      }));
      // Say when the answer was cut off. A truncated evaluation that ends mid-sentence is worse
      // than a short one, because it looks complete right up to where it stops.
      if (turn.finish === 'length') {
        warnings.unshift({ rule: 'truncated', term: 'hit the output token limit', fatal: false });
      }
      emit('answer', { answer, model: usedModel, warnings });
      emit('done', { steps: step + 1, toolCalls: toolCallsUsed, model: usedModel });
      return { ok: true, answer, model: usedModel, steps: step + 1, toolCalls: toolCallsUsed, warnings, trace };
    }

    // Record the assistant's tool-call turn verbatim — the API requires it to precede the
    // matching tool results, and a reconstructed version breaks the pairing.
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name || 'unknown';
      const args = parseArgs(call.function?.arguments);

      if (toolCallsUsed >= MAX_TOOL_CALLS) {
        messages.push({ role: 'tool', tool_call_id: call.id, name,
          content: JSON.stringify({ error: `tool budget of ${MAX_TOOL_CALLS} calls exhausted; answer with what you already have` }) });
        continue;
      }
      toolCallsUsed++;

      repairArgs(name, args, message);
      const label = describe(name, args);
      emit('tool', { name, args, label, n: toolCallsUsed });

      const started = Date.now();
      const result = await runTool(root, name, args);
      const ms = Date.now() - started;
      const payload = clip(result, MAX_RESULT_CHARS);

      trace.push({ name, args, ms, ok: !result?.error, summary: summarize(name, result) });
      emit('tool_result', { name, ms, ok: !result?.error, summary: summarize(name, result), n: toolCallsUsed });

      messages.push({ role: 'tool', tool_call_id: call.id, name, content: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }
  }

  emit('error', { error: `stopped after ${MAX_STEPS} steps without a final answer` });
  return { ok: false, error: `stopped after ${MAX_STEPS} steps without a final answer`, trace, model: usedModel };
}

// One-line result summary for the panel — enough to see it worked, not a data dump.
function summarize(name, r) {
  if (!r || r.error) return `failed: ${clip(r?.error || 'no result', 120)}`;
  switch (name) {
    case 'search_career_ops': return `${r.returned ?? 0} of ${r.count ?? 0} matches`;
    case 'get_document': return r.ok ? `${(r.text || '').length} chars` : clip(r.error, 100);
    case 'get_application': return r.status === 'resolved' ? `#${r.application?.num ?? '?'} ${r.application?.company ?? ''}` : r.status;
    case 'web_search': return `${r.count ?? 0} results`;
    case 'fetch_url': return r.ok ? `${r.chars} chars${r.paywalled ? ' (paywalled)' : ''}` : clip(r.error, 100);
    case 'get_linkedin_post': return r.ok ? `${r.author || 'post'} · ${(r.text || '').length} chars` : clip(r.error, 100);
    case 'search_people': return `${r.count ?? 0} people`;
    case 'get_thread': return r.bothSides ? `${r.messageCount} messages (both sides)` : `${r.messageCount} sent only — ${clip(r.reason, 80)}`;
    case 'get_person': return r.found ? `${r.contactCount} prior contacts` : 'no record';
    case 'get_invite_budget': return `${r.used ?? '?'}/${r.cap ?? '?'} used`;
    case 'company_context': return `${r.applications ?? 0} apps, ${r.contacts ?? 0} contacts`;
    case 'screen_jd': return r.blocked ? `BLOCKED: ${clip((r.hits || []).join(', '), 100)}` : 'no hard bars hit';
    case 'evaluate_job':
      if (r.stopped === 'closed') return 'posting says it is closed';
      if (r.stopped === 'unreachable') return `could not fetch — ${clip(r.liveness?.reason, 60)}`;
      if (r.stopped === 'thin') return `only ${r.liveness?.chars} chars — JD not readable from the page`;
      return [r.company || 'role', `${(r.jd || '').length} chars`,
        r.gates?.hardBars?.bars?.length ? 'HARD BAR HIT' : 'bars clear',
        r.gates?.blacklist?.hit ? 'BLACKLISTED' : null,
        r.gates?.companyHistory?.atCap ? 'at company cap' : null].filter(Boolean).join(' · ');
    case 'check_draft': return r.ok ? 'clean' : `${(r.findings || []).length} findings${r.fatal ? ' (FATAL)' : ''}`;
    default: return 'done';
  }
}

/** POST /api/assist/agent — SSE when the client accepts it, plain JSON otherwise. */
export async function agentHandler(ctx) {
  const body = ctx.body || {};
  const wantsStream = String(ctx.req.headers.accept || '').includes('text/event-stream');
  if (!String(body.message || '').trim()) return ctx.json(400, { error: 'message is required' });

  if (!wantsStream) {
    const r = await runAgent(ctx.root, { message: body.message, history: body.history, context: body.context });
    return ctx.json(r.ok ? 200 : 502, r);
  }

  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    try { ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };
  const ac = new AbortController();
  ctx.req.on('close', () => ac.abort());

  try {
    await runAgent(ctx.root, {
      message: body.message, history: body.history, context: body.context,
      signal: ac.signal, emit: send,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') send('error', { error: String(e?.message || e).slice(0, 300) });
  }
  try { ctx.res.end(); } catch { /* already closed */ }
  return undefined;
}
