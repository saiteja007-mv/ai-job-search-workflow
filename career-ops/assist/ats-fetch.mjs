// ats-fetch.mjs — read a job posting from its ATS's own public API.
//
// WHY: pplx honours robots.txt, and essentially every applicant-tracking system disallows
// crawlers, so `fetch_url` on a real job link returns `disallow_by_robots` and the evaluation
// dies before it starts. Company career pages are also JavaScript-rendered, which is the other
// half of the problem (the Opendoor page extracts 725 chars of nav shell).
//
// This is NOT a robots bypass. Greenhouse, Lever and Ashby each publish a documented public
// job-board API intended for exactly this — reading a posting you were linked to. We ask the
// board for its own posting instead of scraping the page it renders. career-ops already does
// this in scan.mjs and liveness-api.mjs for the same reason: it is the supported path, and it
// returns clean structured text rather than markup.
//
// The URL -> API mapping is NOT reimplemented here: resolveAtsApi() in ../liveness-api.mjs is
// the canonical parser (and carries an SSRF guard on every derived path segment). A second copy
// would drift the first time an ATS changed a URL shape.
import { resolveAtsApi } from '../liveness-api.mjs';

const TIMEOUT_MS = 20_000;
const UA = 'career-ops-assist/1.0';

const detag = (s) => String(s ?? '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** A Greenhouse job id can also ride on a company career page as ?gh_jid=NNN. */
function greenhouseFromQuery(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const id = u.searchParams.get('gh_jid');
    if (!id || !/^\d+$/.test(id)) return null;
    // The board token is the company subdomain in the common case; we cannot know it for sure
    // from a career-page URL, so report the id and let the caller say what is missing.
    return { id, host: u.hostname };
  } catch { return null; }
}

const parts_ = (r) => r.parts?.board || r.parts?.slug || r.parts?.org || 'that company';

/** Plausible Greenhouse board tokens for a career-page hostname: example-company.com -> hioscar, oscar. */
function boardCandidates(host) {
  const base = String(host || '').replace(/^www\./, '').split('.')[0];
  if (!base) return [];
  const out = new Set([base]);
  if (base.startsWith('hi')) out.add(base.slice(2)); // hioscar -> oscar
  if (base.endsWith('inc')) out.add(base.slice(0, -3));
  return [...out].filter((s) => /^[a-z0-9-]{2,40}$/i.test(s)).slice(0, 3);
}

/** Does the board itself still exist? Separates "this job is gone" from "this URL is wrong". */
async function boardExists(resolved) {
  const listUrl = resolved.apiUrl.replace(/\/jobs\/[^/?#]+.*$/, '/jobs');
  if (listUrl === resolved.apiUrl) return false;
  try {
    const res = await fetch(listUrl, { headers: { accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch { return false; }
}

/**
 * Fetch a posting through its ATS API.
 * Returns { ok, source:'ats', ats, title, company, location, text } or { ok:false, error, hint }.
 */
export async function fetchViaAts(rawUrl) {
  const resolved = resolveAtsApi(rawUrl);
  if (!resolved) {
    const gh = greenhouseFromQuery(rawUrl);
    if (gh) {
      // The board token is not in the URL, but for an embedded board it is almost always the
      // company's own name. Try the obvious candidates from the hostname before giving up —
      // one or two cheap requests beat telling him to go find the real link himself.
      for (const board of boardCandidates(gh.host)) {
        const r = await fetchViaAts(`https://job-boards.greenhouse.io/${board}/jobs/${gh.id}`);
        if (r.ok) return { ...r, url: rawUrl, guessedBoard: board };
        if (r.closed) return { ...r, url: rawUrl, guessedBoard: board };
      }
      return { ok: false, notAts: true,
        error: `this looks like a Greenhouse posting (gh_jid=${gh.id}) embedded in ${gh.host}'s career page, and the board token could not be guessed from the hostname`,
        hint: 'open the posting on job-boards.greenhouse.io and use that link, or paste the JD text' };
    }
    return { ok: false, notAts: true, error: 'not a recognised Greenhouse, Lever or Ashby posting URL' };
  }

  let json;
  try {
    const res = await fetch(resolved.apiUrl, {
      headers: { accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(resolved.timeoutMs || TIMEOUT_MS),
    });
    if (res.status === 404) {
      // A 404 here is usually the useful answer, not a failure: if the board itself still
      // resolves, the board is fine and this specific posting is gone — which is exactly what
      // the liveness gate wants to know. Only if the board 404s too is the URL simply wrong.
      const boardOk = await boardExists(resolved);
      return boardOk
        ? { ok: false, ats: resolved.ats, closed: true,
            error: `the posting is no longer listed on ${parts_(resolved)}'s ${resolved.ats} board — it looks closed or filled` }
        : { ok: false, ats: resolved.ats, error: `no ${resolved.ats} board found for "${parts_(resolved)}" — check the URL` };
    }
    if (!res.ok) return { ok: false, ats: resolved.ats, error: `${resolved.ats} API returned ${res.status}` };
    json = await res.json();
  } catch (e) {
    return { ok: false, ats: resolved.ats, error: `${resolved.ats} API request failed: ${String(e.message || e).slice(0, 140)}` };
  }

  const out = extract(resolved, json);
  if (!out || !out.text || out.text.length < 200) {
    return { ok: false, ats: resolved.ats,
      error: `the ${resolved.ats} API responded but carried no job description${out?.closed ? ' — the posting appears to be closed' : ''}` };
  }
  return { ok: true, source: 'ats', ats: resolved.ats, url: rawUrl, ...out, chars: out.text.length };
}

function extract(resolved, json) {
  const { ats, parts } = resolved;
  if (ats === 'greenhouse') {
    return {
      title: json.title || null,
      company: json.company_name || parts.board || null,
      location: json.location?.name || null,
      text: detag(json.content || ''),
    };
  }
  if (ats === 'lever') {
    const body = [json.description, ...(json.lists || []).map((l) => `${l.text}\n${l.content}`), json.additional]
      .filter(Boolean).join('\n\n');
    return {
      title: json.text || null,
      company: parts.slug || null,
      location: json.categories?.location || null,
      text: detag(body),
    };
  }
  if (ats === 'ashby') {
    // Ashby's public API returns the whole board; find the one posting we were linked to.
    const jobs = json.jobs || [];
    const job = jobs.find((j) => j.id === parts.jobId || j.jobId === parts.jobId)
      || jobs.find((j) => String(j.jobUrl || '').includes(parts.jobId));
    if (!job) return { closed: true, text: '' };
    return {
      title: job.title || null,
      company: parts.org || null,
      location: job.location || null,
      text: detag(job.descriptionHtml || job.descriptionPlain || ''),
    };
  }
  return null;
}
