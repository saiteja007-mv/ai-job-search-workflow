// linkedin-post.mjs — turn a LinkedIn post URL into its actual content, via Unipile.
//
// The URL embeds both the type and the id:
//   .../posts/someone_hiring-share-7000000000000000001-HL-j      -> urn:li:share:7000000000000000001
//   .../posts/someone_hiring-ugcPost-7000000000000000002-oMJk    -> urn:li:ugcPost:7000000000000000002
//   .../feed/update/urn:li:activity:7000000000000000003/         -> urn:li:activity:7000000000000000003
//
// VERIFIED 2026-08-25 against the live API:
//   urn:li:activity:<id>  -> 200
//   urn:li:share:<id>     -> 200 (same post; Unipile resolves share -> activity itself)
//   bare <id>             -> 404
// So the type prefix is required, and the number in the URL is NOT interchangeable with the
// post's own social_id — on the post this was verified against they differ by ~575 million. Stripping the
// type and passing the digits alone is the obvious-looking mistake that silently 404s.
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 30_000;

function config(root) {
  let env = '';
  try { env = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return null; }
  const get = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  const base = get('UNIPILE_API_BASE');
  const key = get('UNIPILE_API_KEY');
  const account = get('UNIPILE_LINKEDIN_ACCOUNT_ID') || get('UNIPILE_ACCOUNT_ID');
  if (!base || !key || !account) return null;
  return { base: base.replace(/\/+$/, ''), key, account };
}

async function get(cfg, rel, params = {}) {
  const url = new URL(cfg.base + rel);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    // Without a browser-ish UA the edge returns Cloudflare 1010, which reads exactly like an
    // auth failure and sends you debugging the wrong thing.
    headers: { 'X-API-KEY': cfg.key, accept: 'application/json', 'User-Agent': 'career-ops-assist/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Unipile ${res.status} on ${rel}`);
  return res.json();
}

/** Extract a LinkedIn JOB id from a jobs URL. Null if this is not a job link. */
export function jobIdFromUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // /jobs/view/4456794897/ and /jobs/view/some-slug-4456794897
  const view = s.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/i);
  if (view) return view[1];
  // /jobs/search/?currentJobId=… and /jobs/collections/…?currentJobId=…
  const cur = s.match(/[?&]currentJobId=(\d{6,})/i);
  if (cur) return cur[1];
  return null;
}

/**
 * Fetch a LinkedIn job posting through Unipile.
 *
 * WHY THIS EXISTS: LinkedIn job pages are unreadable by any crawler (robots-disallowed and
 * login-walled), and LinkedIn is not a Greenhouse/Lever/Ashby board, so the ATS path does not
 * apply either. Unipile reads it with <YOUR_NAME>'s own authenticated session — the same access he
 * has in his browser — and returns strictly more than the page shows: a `state` field that
 * answers the liveness gate outright, the applicant count, and the hiring team with provider
 * ids, which is exactly who outreach would target.
 */
export async function getJob(root, input) {
  const id = jobIdFromUrl(input) || (/^\d{6,}$/.test(String(input || '').trim()) ? String(input).trim() : null);
  if (!id) return { ok: false, notJob: true, error: 'no LinkedIn job id in that input' };
  const cfg = config(root);
  if (!cfg) return { ok: false, error: 'Unipile is not configured' };

  try {
    const j = await get(cfg, `/linkedin/jobs/${encodeURIComponent(id)}`, { account_id: cfg.account });
    if (!j || j.status === 404 || /not found/i.test(String(j.title || '')) === true && !j.description) {
      return { ok: false, error: `LinkedIn has no job ${id} (it may have been taken down)` };
    }
    const description = String(j.description || '');
    return {
      ok: true, source: 'linkedin', jobId: id,
      title: j.title || null,
      company: typeof j.company === 'string' ? j.company : (j.company?.name || null),
      location: j.location || null,
      // `state` is LinkedIn's own answer to "is this still open" — better than inferring it.
      state: j.state || null,
      applicants: j.applicants_counter ?? null,
      publishedAt: j.published_at ? new Date(Number(j.published_at)).toISOString().slice(0, 10) : null,
      hiringTeam: (j.hiring_team || []).map((h) => ({
        name: String(h.name || '').trim(), providerId: h.provider_id || null, profile: h.profile_url || null,
      })).filter((h) => h.name),
      text: description,
      chars: description.length,
    };
  } catch (e) {
    return { ok: false, error: `Unipile job fetch failed: ${String(e.message || e).slice(0, 160)}` };
  }
}

/** Extract a LinkedIn post URN from a URL, a bare urn, or a "type-id" fragment. Null if absent. */
export function postUrn(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const urn = s.match(/urn:li:(activity|share|ugcPost):(\d{10,})/i);
  if (urn) return `urn:li:${urn[1]}:${urn[2]}`;
  // ..._slug-<type>-<id>-<hash> in /posts/ links
  const typed = s.match(/-(activity|share|ugcPost)-(\d{10,})/i);
  if (typed) return `urn:li:${typed[1]}:${typed[2]}`;
  return null;
}

/**
 * Fetch a post's text, author and engagement. `withComments` also pulls the discussion, which is
 * usually where the hiring detail lives ("DM me", "role is remote", "we're closed on this one").
 */
export async function getPost(root, input, { withComments = false, commentLimit = 20 } = {}) {
  const urn = postUrn(input);
  if (!urn) {
    return { ok: false, error: 'could not find a LinkedIn post id in that input. Expected a post URL, a feed /update/ URL, or urn:li:activity|share|ugcPost:<id>.' };
  }
  const cfg = config(root);
  if (!cfg) return { ok: false, error: 'Unipile is not configured (UNIPILE_API_BASE / _API_KEY / _LINKEDIN_ACCOUNT_ID)' };

  try {
    const p = await get(cfg, `/posts/${encodeURIComponent(urn)}`, { account_id: cfg.account });
    const out = {
      ok: true, urn,
      author: p.author?.name || null,
      authorHeadline: p.author?.headline || null,
      authorProviderId: p.author?.id || p.author?.provider_id || null,
      postedAt: p.date || p.parsed_datetime || null,
      text: p.text || '',
      reactions: p.reaction_counter ?? null,
      comments: p.comment_counter ?? null,
      shareUrl: p.share_url || null,
    };
    if (withComments) {
      try {
        const c = await get(cfg, `/posts/${encodeURIComponent(urn)}/comments`, { account_id: cfg.account, limit: commentLimit });
        out.commentList = (c.items || []).map((x) => ({
          author: x.author?.name || null, text: x.text || '', date: x.date || null,
        })).filter((x) => x.text);
      } catch (e) {
        // A readable post with unreadable comments is still useful — say so rather than fail.
        out.commentsError = String(e.message || e).slice(0, 160);
      }
    }
    return out;
  } catch (e) {
    return { ok: false, urn, error: String(e.message || e).slice(0, 200) };
  }
}
