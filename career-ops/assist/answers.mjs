// answers.mjs — POST /api/assist/answers. Spec §4, the primary flow.
//
// Paste-driven, NOT DOM-driven: the user pastes questions and gives an application ref. That is
// what makes this work on every ATS (Greenhouse, Ashby, Workday, a Google Form, an email) with
// no per-site extractor to break, and it gives BETTER context than scraping — the stored report
// already has the JD, the score, the evidence and the disclosed gaps.
//
// Read-only: builds context from Source-of-Truth files, calls a free model, then runs the
// safety layer over the result. Opens no file for writing.
import { resolveApplication, loadReportText } from './resolve.mjs';
import { readSource, runFilters, stripEmDashes, availableSources } from './grounding.mjs';
import { verifyClaims, parseModelEnvelope } from './verify.mjs';
import { generate, modelOrder } from './runner.mjs';

const MAX_QUESTIONS = 12;
const REPORT_BUDGET = 6000;   // chars of report/JD context per question
const CV_BUDGET = 9000;

const SYSTEM = `You answer job-application questions for one specific candidate.

ABSOLUTE RULES:
- Use ONLY facts present in the provided source material. Never invent, embellish or infer
  experience. If the sources do not support an answer, say what IS supported and stop.
- Never claim the candidate authored a tool, library or project unless the CV attributes it.
- Do not use em dashes. Write ranges as "3 to 5", never "3-5".
- Write in first person, plain and specific. No marketing language, no filler openers.

OUTPUT FORMAT — return ONLY valid JSON, no prose around it:
{"draft":"<the answer>","claims":[{"text":"<factual statement from the answer>","sourceFile":"<exact source filename given to you>","sourceQuote":"<a VERBATIM span of at least 12 characters copied from that file>"}]}

The sourceQuote must be copied character-for-character from the source. It is checked
mechanically against the file. A quote that does not appear verbatim is discarded and the
answer is marked unverified.`;

function buildContext(root, app) {
  const cv = readSource(root, 'cv-aiml.md') || readSource(root, 'cv.md') || '';
  const digest = readSource(root, 'article-digest.md') || '';
  // voice-dna.md is optional and absent on this install — degrade, never fail (DATA_CONTRACT).
  const voice = readSource(root, 'voice-dna.md') || '';
  const report = app?.file ? (loadReportText(root, app.file) || '') : '';
  return {
    cv: cv.slice(0, CV_BUDGET),
    digest: digest.slice(0, 4000),
    voice: voice.slice(0, 1500),
    report: report.slice(0, REPORT_BUDGET),
    sourcesUsed: availableSources(root).map((s) => s.rel),
  };
}

function userPrompt(question, app, ctx) {
  const who = app?.company ? `${app.company}${app.role ? ' — ' + app.role : ''}` : 'this role';
  return [
    `APPLICATION: ${who}`,
    app?.meta?.score ? `Evaluation score on file: ${app.meta.score}` : '',
    '',
    ctx.report ? `=== SOURCE: the evaluation report and JD already on file ===\n${ctx.report}` : '',
    '',
    `=== SOURCE FILE cv-aiml.md ===\n${ctx.cv}`,
    ctx.digest ? `\n=== SOURCE FILE article-digest.md ===\n${ctx.digest}` : '',
    ctx.voice ? `\n=== VOICE GUIDE (style only, never a source of facts) ===\n${ctx.voice}` : '',
    '',
    `QUESTION TO ANSWER:\n${question}`,
    '',
    'Cite sourceFile values exactly as the SOURCE FILE headers above name them.',
  ].filter(Boolean).join('\n');
}

/**
 * Draft one answer, then run the safety layer.
 * Spec §3: a draft failing a deterministic filter is regenerated ONCE, then surfaced with the
 * violation named — never silently returned, never silently suppressed.
 */
export async function draftAnswer(root, question, app, ctx, { signal } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(question, app, ctx) },
  ];

  let attempt = 0;
  let last = null;
  let skipModels = [];
  while (attempt < 3) {
    attempt++;
    // A model that just proved it cannot emit JSON does not get another turn at it. Measured:
    // nemotron-3.5-lightning returns its reasoning scratchpad instead of the envelope, every
    // time. Retrying the SAME model would burn the retry budget for nothing.
    // Operator order from models.json, minus any model that already failed to emit JSON.
    const pool = await modelOrder({ exclude: skipModels });
    const gen = await generate({ messages, maxTokens: 1000, signal, models: pool.length ? pool : undefined });
    const env = parseModelEnvelope(gen.text);
    if (!env.ok && attempt < 3) {
      // Spec §7: on parse failure retry once before falling back to an ungrounded draft.
      skipModels.push(gen.model);
      continue;
    }
    const draft = stripEmDashes(env.draft);
    const filters = runFilters(draft, { root, applicationAnswer: true });
    const verification = verifyClaims(root, env.claims);

    last = {
      question,
      draft,
      model: gen.model,
      attempt,
      claims: verification.results,
      sources: verification.sources,
      containsUnverified: verification.containsUnverified,
      citationsAvailable: env.ok,
      warnings: filters.findings,
      rejected: false,
    };

    if (!filters.fatal) {
      // A non-fatal finding is surfaced, not hidden — the user decides.
      if (!env.ok) last.warnings.push({ rule: 'citations', term: 'unparseable', note: 'sources unavailable, verify manually' });
      return last;
    }

    // Fatal: a merged-fact fabrication. Regenerate once with the violation named.
    if (attempt < 2) {
      messages.push({ role: 'assistant', content: draft });
      messages.push({
        role: 'user',
        content: `That answer was rejected: ${filters.findings.filter((f) => f.fatal).map((f) => f.why).join('; ')}. `
          + 'Rewrite it without merging those facts. Keep the claims separate and accurate.',
      });
    }
  }

  last.rejected = true;
  last.draft = '';
  last.rejectionReason = last.warnings.filter((f) => f.fatal).map((f) => f.why).join('; ')
    || 'the draft merged facts that must stay separate';
  return last;
}

/** HTTP handler for POST /api/assist/answers */
export async function handler(ctx) {
  const { ref, questions } = ctx.body || {};
  if (!ref) return ctx.json(400, { ok: false, error: 'ref is required (e.g. "#1228", a company, or the job URL)' });
  if (!Array.isArray(questions) || !questions.length) {
    return ctx.json(400, { ok: false, error: 'questions must be a non-empty array' });
  }
  if (questions.length > MAX_QUESTIONS) {
    return ctx.json(400, { ok: false, error: `too many questions (${questions.length}); the limit is ${MAX_QUESTIONS}` });
  }

  // Spec §4 step 2/3: never generate against an unconfirmed or ambiguous application.
  const resolved = resolveApplication(ctx.root, ref);
  if (resolved.status !== 'resolved') {
    return ctx.json(resolved.status === 'ambiguous' ? 300 : 404, { ok: false, ...resolved });
  }

  const app = resolved.application;
  const context = buildContext(ctx.root, app);
  const answers = [];
  for (const q of questions) {
    try {
      answers.push(await draftAnswer(ctx.root, String(q), app, context));
    } catch (e) {
      // Spec §8: all free models rate-limited is a stated condition, never a silent paid switch.
      answers.push({ question: String(q), draft: '', error: String(e.message || e), attempts: e.attempts || null });
    }
  }

  return ctx.json(200, {
    ok: true,
    application: { num: app.num, company: app.company, role: app.role ?? app.meta?.title ?? null, file: app.file ?? null, score: app.meta?.score ?? app.score ?? null },
    sourcesAvailable: context.sourcesUsed,
    answers,
  });
}
