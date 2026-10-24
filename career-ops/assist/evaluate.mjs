// evaluate.mjs — run a job posting through the real career-ops evaluation, not a lookalike.
//
// The rubric is not invented here. It is read at call time from the repo's own mode files
// (modes/_shared.md scoring table, modes/oferta.md blocks, modes/_profile.md archetypes,
// config/profile.yml targeting), so when <YOUR_NAME> retunes his scoring the chatbot retunes with
// it. A copied-out rubric would drift the first time he edits one of those files.
//
// WHY THIS IS ONE TOOL AND NOT SIX: the gates are gates. Liveness, blacklist, hard bars and the
// per-company cap must run on every evaluation — if each were a separate tool the model could
// simply not call one, and a gate that runs only when the model remembers is not a gate. This
// runs all of them deterministically, then hands the model a packet to score against.
//
// READ-ONLY. It does not write a report to reports/, does not add a tracker row, and does not
// reserve a report number. The assist service opens no file for writing (see assist-server.mjs)
// and it sits on a public tunnel; keeping it read-only is what makes that safe. Committing an
// evaluation to disk stays a deliberate step <YOUR_NAME> takes in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fetchUrl } from './web.mjs';
import { fetchViaAts } from './ats-fetch.mjs';
import { getJob as getLinkedInJob } from './linkedin-post.mjs';
import { screenJD } from './bars.mjs';
import { companyContext, loadBlacklist } from './context.mjs';

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

// Pull one "## Heading" section out of a mode file, so the packet carries the scoring rules
// without the other 400 lines of prose around them.
function section(md, heading) {
  if (!md) return null;
  const re = new RegExp(`^##\\s+${heading}[^\\n]*$`, 'im');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (m[0] + (next ? rest.slice(0, next.index) : rest)).trim();
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…[truncated]' : s);

// A posting reduced to a footer/navbar is a dead link. oferta.md's liveness gate stops before
// Block A for exactly this reason: a 404 otherwise consumes a full A-G evaluation on nothing.
function livenessOf(page) {
  // "I could not fetch it" and "the posting is dead" are different facts and must not collapse
  // into one. A pplx rate-limit reported as "this job is closed" would tell <YOUR_NAME> to drop a
  // role that is in fact open — the failure mode is worse than saying nothing.
  if (!page?.ok) {
    const err = String(page?.error || 'could not fetch the posting');
    const transient = /RATE_LIMIT|rate limit|timeout|timed out|ECONN|ENOTFOUND|5\d\d/i.test(err);
    return { live: null, fetchFailed: true, transient, reason: err.slice(0, 200) };
  }
  const text = String(page.content || '');
  if (/no longer accepting applications|this job (is no longer|has been) (available|closed|filled)|position (has been )?filled|posting (has )?expired|page not found/i.test(text)) {
    return { live: false, reason: 'the page states the posting is closed' };
  }
  // Below this the extraction is a nav shell, not a JD — common on JS-rendered boards. Not
  // proof the role is dead, so don't claim it is.
  if (text.length < 1200) {
    return { live: null, thin: true, chars: text.length,
      reason: `only ${text.length} chars extracted — the posting is probably JavaScript-rendered, so this is not the full JD` };
  }
  return { live: true, chars: text.length };
}

// Company name straight from the JD text, good enough to drive the blacklist and cap checks.
function guessCompany(text, url) {
  const m = /^\s*Company:\s*(.+)$/im.exec(text || '');
  if (m) return m[1].trim();
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const at = /(?:boards|jobs|job-boards)\.(greenhouse|lever|ashbyhq)\.(?:io|co)\/([^/]+)/i.exec(url);
    if (at) return at[2].replace(/[-_]+/g, ' ');
    return host.split('.')[0];
  } catch { return null; }
}

/**
 * Assemble everything needed to score one posting.
 * Returns a packet: the JD, the deterministic gate results, and the live rubric.
 */
export async function evaluateJob(root, { url, text } = {}) {
  let jd = String(text || '');
  let page = null;
  let linkedinJob = null;
  let liveness = { live: true, reason: 'JD text supplied directly; no liveness check possible' };

  if (!jd && url) {
    // LinkedIn jobs first — they are robots-disallowed AND login-walled, so neither the ATS
    // path nor the crawler can ever read one. Unipile reads it with <YOUR_NAME>'s own session.
    const lj = await getLinkedInJob(root, url);
    if (lj.ok) {
      const team = lj.hiringTeam?.length ? `Hiring team: ${lj.hiringTeam.map((h) => h.name).join(', ')}` : '';
      jd = [lj.company ? `Company: ${lj.company}` : '', lj.title ? `Role: ${lj.title}` : '',
        lj.location ? `Location: ${lj.location}` : '', `URL: ${url}`,
        lj.applicants != null ? `Applicants: ${lj.applicants}` : '',
        lj.publishedAt ? `Posted: ${lj.publishedAt}` : '', team, '', lj.text]
        .filter((l) => l !== '').join('\n');
      // LinkedIn states this itself — no inference needed.
      if (lj.state && !/active|open|listed/i.test(lj.state)) {
        return {
          ok: true, stopped: 'closed', url,
          liveness: { live: false, reason: `LinkedIn reports this posting as "${lj.state}"`, via: 'Unipile' },
          guidance: 'LinkedIn itself reports this posting is no longer active. Do NOT produce an evaluation; tell <YOUR_NAME> the role appears closed.',
        };
      }
      liveness = { live: true, chars: lj.chars, via: 'Unipile (LinkedIn)', state: lj.state, applicants: lj.applicants };
      page = { ok: true, content: jd };
      linkedinJob = lj;
    }
    if (!linkedinJob) {
    // ATS API first. A crawler-fetch of a real job link usually fails outright
    // (`disallow_by_robots` — every major ATS disallows crawlers) or returns a JavaScript shell.
    // The board's own public API returns the posting as structured text.
    const ats = await fetchViaAts(url);
    if (ats.ok) {
      jd = [ats.company ? `Company: ${ats.company}` : '', ats.title ? `Role: ${ats.title}` : '',
        ats.location ? `Location: ${ats.location}` : '', `URL: ${url}`, '', ats.text]
        .filter((l) => l !== '').join('\n');
      liveness = { live: true, chars: ats.text.length, via: `${ats.ats} API` };
      page = { ok: true, content: jd };
    } else if (ats.closed) {
      // The board answered and the posting is not on it. That is a definite liveness answer,
      // better than anything the crawler could tell us — don't fall through and second-guess it.
      return {
        ok: true, stopped: 'closed', url,
        liveness: { live: false, reason: ats.error, via: `${ats.ats} API` },
        guidance: 'The ATS board confirms this posting is gone. Per the career-ops liveness gate, do NOT produce an evaluation. Tell <YOUR_NAME> the role appears filled or closed.',
      };
    } else {
      page = await fetchUrl(url, { maxChars: 20_000 });
      // Keep why the ATS path was skipped — otherwise a robots refusal looks like the only
      // thing that was ever tried.
      if (!ats.notAts) page.atsNote = ats.error;
      jd = String(page?.content || '');
      liveness = livenessOf(page);
      if (page?.atsNote) liveness.atsAttempt = page.atsNote;
    }
    } // end: not a LinkedIn job

    // Stop before the rubric, as oferta.md's gate requires — but say which of the three things
    // happened, because the right next move differs for each.
    if (liveness.live === false) {
      return {
        ok: true, stopped: 'closed', url, liveness,
        guidance: 'The posting says it is closed. Per the career-ops liveness gate, do NOT produce an evaluation. Tell <YOUR_NAME> the role appears filled or expired.',
      };
    }
    if (liveness.fetchFailed) {
      return {
        ok: true, stopped: 'unreachable', url, liveness,
        guidance: `The page could not be fetched (${liveness.transient ? 'looks transient — a retry may work' : 'looks permanent'}). This is NOT evidence the role is closed. Say the fetch failed and why, and offer to evaluate the JD if he pastes the text.`,
      };
    }
    if (liveness.thin) {
      return {
        ok: true, stopped: 'thin', url, liveness, extracted: clip(jd, 2_000),
        guidance: 'Too little text was extracted to be the real job description — almost certainly a JavaScript-rendered board. Do NOT score it from this fragment. Tell him what was extracted and ask him to paste the JD text.',
      };
    }
  }
  if (!jd.trim()) return { ok: false, error: 'no job description: pass a url that can be fetched, or the JD text' };

  const company = guessCompany(jd, url || '');

  // --- gates, all deterministic ---
  const blacklist = (() => {
    try {
      const list = loadBlacklist(root) || [];
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const hit = company && list.find((c) => norm(c).length && (norm(c) === norm(company) || norm(company).includes(norm(c))));
      return { checked: true, listed: list.length, hit: hit || null };
    } catch { return { checked: false, listed: 0, hit: null }; }
  })();

  const bars = screenJD(jd);
  let history = null;
  try { history = company ? await companyContext(root, company) : null; } catch { /* optional */ }

  // --- the rubric, read live from the repo ---
  const shared = read(root, 'modes/_shared.md');
  const oferta = read(root, 'modes/oferta.md');
  const rubric = {
    scoring: clip(section(shared, 'Scoring System'), 4_000),
    blocks: clip([section(oferta, 'Block A'), section(oferta, 'Block B'), section(oferta, 'Block C'),
      section(oferta, 'Block D')].filter(Boolean).join('\n\n'), 6_000),
    archetypes: clip(read(root, 'modes/_profile.md'), 6_000),
    profile: clip(read(root, 'config/profile.yml'), 4_000),
    cv: clip(read(root, 'cv-aiml.md') || read(root, 'cv.md'), 8_000),
  };

  return {
    ok: true,
    url: url || null,
    company,
    jd: clip(jd, 14_000),
    liveness,
    gates: {
      blacklist,
      hardBars: bars,
      companyHistory: history,
    },
    rubric,
    guidance: [
      // The model reliably conflated these two lists, printing "Block A: Match con CV" — the
      // dimensions are not the blocks, and mislabelling them makes the output look like a
      // career-ops report while disagreeing with what that report format actually means.
      'Score this posting on the six DIMENSIONS in the "Scoring System" table above (Match con CV, North Star alignment, Comp, Cultural signals, Red flags, then the weighted Global), each 1-5, and give the Global as X.X/5.',
      'Label them as dimensions, NOT as "Block A/B/C". The lettered Blocks A-F are a different thing entirely (A=Role Summary, B=Match with CV, C=Level and Strategy, D=Comp and Demand) — do not renumber the dimensions as blocks.',
      'State the score interpretation band (4.5+ apply now, 4.0-4.4 worth applying, 3.5-3.9 only with a reason, below 3.5 recommend against).',
      'Ground every claim about <YOUR_NAME> in the cv/profile text provided. Never invent experience he does not have.',
      // screenJD reports {verdict, bars[], ...} — there is no `.blocked` field, and reading one
      // silently disabled this warning until it was checked against the real return shape.
      bars.bars?.length ? `HARD BARS HIT (${bars.bars.map((b) => b.why || b.id).join('; ')}) — lead with that; a hard bar outranks a good score.` : null,
      bars.conflicting ? 'The JD both promises sponsorship and states a hard bar — surface the contradiction rather than averaging it away.' : null,
      blacklist.hit ? `BLACKLISTED: "${blacklist.hit}" is on his do-not-apply list. Surface it and ask before evaluating further.` : null,
      history?.atCap ? 'The per-company application cap is already reached — say so.' : null,
      'This evaluation is not saved. No report file was written and no tracker row was added.',
    ].filter(Boolean).join(' '),
  };
}
