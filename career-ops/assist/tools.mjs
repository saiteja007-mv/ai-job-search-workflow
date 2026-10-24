// tools.mjs — what the agent can actually do.
//
// Every tool here is READ-ONLY or DRAFT-ONLY. Nothing sends a message, submits an application,
// or spends an invite. That is a deliberate boundary, not an oversight: the panel's promise is
// "draft-only, never fills or sends", and an agent that can act autonomously on LinkedIn is a
// different product with a different risk profile. Sending stays a human keystroke.
import { search as ragSearch, getDocument, stats as ragStats } from './rag.mjs';
import { webSearch, fetchUrl } from './web.mjs';
import { getPost } from './linkedin-post.mjs';
import { resolveApplication, listTrackerRows, loadReportText } from './resolve.mjs';
import { searchPeople, loadThread } from './people.mjs';
import { findPerson, checkRelevance } from './person.mjs';
import { inviteBudget, companyContext } from './context.mjs';
import { screenJD } from './bars.mjs';
import { runFilters } from './grounding.mjs';
import { evaluateJob } from './evaluate.mjs';

const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const fn = (name, description, properties, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const TOOL_SCHEMAS = [
  fn('search_career_ops',
    "Search <YOUR_NAME>'s own career data: job descriptions he saved (jd), his past evaluation reports with scores and reasoning (report), applications he has tracked (application), and his CV/profile/writing (profile). Use this FIRST for anything about his background, a role he saved, or what he previously concluded about a company. Returns snippets with ids. NOTE: 'report' is his own past assessment of a job — cite it when discussing his pipeline, but never use it as a source of factual claims about his experience in a CV or cover letter.",
    { query: str('what to look for, in keywords'),
      kind: { type: 'string', enum: ['jd', 'report', 'application', 'profile'], description: 'narrow to one corpus; omit to search all' },
      limit: num('max results, default 6') },
    ['query']),

  fn('get_document', 'Read the full text of a document returned by search_career_ops, by its id.',
    { id: str('document id from search results, e.g. jd:077-....txt#0'),
      whole: bool('true to return the entire file rather than just this chunk') },
    ['id']),

  fn('get_application', 'Look up one tracked application by number (#1240), company name, or job URL. Returns status, score, dates and the linked report.',
    { ref: str('#1240, a company name, or the posting URL') }, ['ref']),

  fn('web_search', 'Search the live web. Use for anything current or outside his own data: company news, funding, salary data, whether a role is still open.',
    { query: str('the search query'), limit: num('1-10, default 5'),
      domains: { type: 'array', items: { type: 'string' }, description: 'restrict to these domains' },
      recency_days: num('only results newer than this many days') },
    ['query']),

  fn('fetch_url', 'Fetch and read one web page (a job posting, an article, a company page). Returns extracted text.',
    { url: str('the http(s) URL to read') }, ['url']),

  fn('get_linkedin_post', 'Read a LinkedIn post from its URL or urn. Returns the author, full text and engagement, optionally the comments. Use whenever the user pastes a LinkedIn post link.',
    { url: str('LinkedIn post URL or urn:li:activity|share|ugcPost:<id>'),
      with_comments: bool('also fetch the comment thread') },
    ['url']),

  fn('search_people', 'Find someone in the outreach database by name. Returns who they are, where they work, and how many times he has contacted them.',
    { query: str('a name or part of one') }, ['query']),

  fn('get_thread', 'Load the full LinkedIn conversation with one person, INCLUDING their replies. Use before drafting any follow-up message.',
    { name: str('their name'), provider_id: str('their LinkedIn provider id, if known'),
      linkedin: str('their profile URL, if known') },
    []),

  fn('get_person', 'Everything known about one contact: title, company, the related application, and every message already sent to them.',
    { name: str('their name'), provider_id: str('LinkedIn provider id'), linkedin: str('profile URL') },
    []),

  fn('get_invite_budget', 'Current LinkedIn invitation headroom for the week, and whether sending more is safe.', {}, []),

  fn('company_context', 'How many applications and contacts already exist for one company, and whether the per-company cap is reached.',
    { company: str('company name') }, ['company']),

  fn('screen_jd', 'Screen a job description against his hard bars (clearance, citizenship, ITAR, location, sponsorship). Use before recommending he apply.',
    { text: str('the job description text') }, ['text']),

  fn('evaluate_job',
    "Run a job posting through <YOUR_NAME>'s real career-ops evaluation. Use this whenever he gives you a job link or pastes a job description and wants to know if it is worth applying to. It fetches the posting, runs the liveness, blacklist, hard-bar and duplicate-company gates, and returns his actual scoring rubric, archetypes and CV so you can produce the A-D block evaluation and an X.X/5 score. Prefer this over fetch_url for job postings.",
    { url: str('the job posting URL — pass this ONLY when you have no JD text'),
      text: str('the full JD text. If the user pasted a job description, ALWAYS pass it here, even if that text also contains a URL — pasted text is complete, whereas fetching the URL often returns only a JavaScript shell') },
    []),

  fn('check_draft', 'Check a drafted message or application answer against his never-claim rules, style rules, and (if a person is named) whether it repeats something already sent. Run this on any outreach you write BEFORE showing it.',
    { text: str('the draft to check'), person_name: str('who it is addressed to, if anyone'),
      application_answer: bool('true if this is an application question answer rather than outreach') },
    ['text']),
];

// ---- dispatch ---------------------------------------------------------------

const ok = (v) => v;
const clipList = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : arr);

/**
 * Execute one tool call. Never throws — a failed tool must come back as data the model can read
 * and react to, otherwise a single bad URL kills the whole turn.
 */
export async function runTool(root, name, args = {}) {
  try {
    switch (name) {
      case 'search_career_ops':
        return ok(ragSearch(root, args.query, {
          kind: args.kind, limit: Math.min(args.limit || 6, 12), listTrackerRows,
        }));

      case 'get_document':
        return ok(getDocument(root, args.id, { whole: Boolean(args.whole), listTrackerRows }));

      case 'get_application': {
        const r = resolveApplication(root, args.ref);
        // An ambiguous ref is a real answer, not an error: #1000 is both <TARGET_COMPANY> and <TARGET_COMPANY> in
        // this tracker, and guessing would silently attach the wrong company to a draft.
        if (r.status === 'resolved' && r.application?.report) {
          const text = loadReportText(root, r.application.report);
          if (text) r.reportExcerpt = String(text).slice(0, 3000);
        }
        return ok(r);
      }

      case 'web_search':
        return ok(await webSearch(args.query, {
          limit: args.limit, domains: args.domains, recencyDays: args.recency_days,
        }));

      case 'fetch_url':
        return ok(await fetchUrl(args.url));

      case 'get_linkedin_post':
        return ok(await getPost(root, args.url, { withComments: Boolean(args.with_comments) }));

      case 'search_people': {
        const r = searchPeople(root, args.query);
        return ok({ ...r, results: clipList(r.results, 10) });
      }

      case 'get_thread': {
        const r = await loadThread(root, {
          name: args.name, providerId: args.provider_id, linkedin: args.linkedin,
        });
        return ok({
          ok: r.ok, source: r.source, bothSides: r.bothSides, reason: r.reason ?? null,
          person: r.person?.identity ?? null,
          messageCount: (r.messages || []).length,
          messages: clipList(r.messages, 40),
        });
      }

      case 'get_person': {
        const p = findPerson(root, {
          name: args.name, providerId: args.provider_id, linkedin: args.linkedin,
        });
        return ok({
          found: p.found, identity: p.identity, relatedApplication: p.relatedApplication ?? null,
          contactCount: p.contactCount, invited: p.invited, messaged: p.messaged,
          lastContact: p.lastContact ?? null, priorMessages: clipList(p.priorMessages, 8),
        });
      }

      case 'get_invite_budget':
        return ok(await inviteBudget(root));

      case 'company_context':
        return ok(await companyContext(root, args.company));

      case 'screen_jd':
        return ok(screenJD(String(args.text || '')));

      case 'evaluate_job':
        return ok(await evaluateJob(root, { url: args.url, text: args.text }));

      case 'check_draft': {
        const text = String(args.text || '');
        const filters = runFilters(text, { root, applicationAnswer: Boolean(args.application_answer) });
        const out = { ok: filters.ok, fatal: filters.fatal, summary: filters.summary, findings: filters.findings };
        if (args.person_name) {
          const p = findPerson(root, { name: args.person_name });
          if (p.found) {
            const rel = checkRelevance(text, p);
            out.relevance = {
              relevant: rel.relevant, reason: rel.reason ?? null,
              repeatsPriorMessage: rel.repeatsPriorMessage ?? false,
            };
          } else {
            out.relevance = { note: `no contact record for "${args.person_name}" — relevance not checked` };
          }
        }
        return ok(out);
      }

      default:
        return { error: `unknown tool "${name}"` };
    }
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 300) };
  }
}

export const ragIndexStats = (root) => ragStats(root, { listTrackerRows });
