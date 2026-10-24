/**
 * posting-facts.mjs — when a recruiter sends a job link, OPEN IT before replying.
 *
 * Why this file exists (2026-09-17):
 * a recruiter InMailed a link whose blurb called the role "AI Software Engineer 3". Nothing in
 * the drafting path fetched it, so the model drafted from that prose alone, read the title as a
 * generic "Software Engineer 3", and declined a req whose own summary is "intelligent
 * automation, agentic workflows, and decision support" — while in the same sentence asking
 * the recruiter for exactly that kind of role. The reply was sent before anyone looked.
 *
 * The lesson is not "the model was careless". A recruiter's blurb is a SALES SUMMARY of the
 * posting, written to get a reply, and it is routinely wrong about title, level and scope.
 * Drafting a decision from it is drafting from hearsay. The posting is the primary source.
 *
 * This deliberately reuses the three fetch/screen pieces that already existed one directory
 * over in assist/ rather than adding a fourth fetcher:
 *   fetchViaAts  — Greenhouse/Lever/Ashby public JSON APIs, SSRF-guarded (assist/ats-fetch.mjs)
 *   fetchUrl     — generic readable-text fallback via the pplx CLI (assist/web.mjs)
 *   screenJD     — regex hard-bar screen: clearance, citizenship, ITAR (assist/bars.mjs)
 * Verified 2026-09-17 against a live <COMPANY_E> careers URL (not one of those three ATSes):
 * fetchViaAts correctly reports notAts, the generic fallback returns ~10.6k chars and the right
 * title. The chain already worked; only the message-drafting path never called it.
 *
 * Nothing here sends anything or writes to the queue. It returns facts, or null.
 */
import { screenJD } from '../assist/bars.mjs';

/**
 * Hosts that serve job postings. Deliberately a list, not a "does the text look like a job"
 * heuristic — a false positive here spends a slow network fetch on every inbound message,
 * and a recruiter's link to their own Calendly or company homepage is not a posting.
 * Calendly is the single most common inbound link in the queue and must never match.
 */
const ATS_HOST = /(?:^|\.)(?:myworkdayjobs|greenhouse|lever|ashbyhq|icims|workable|smartrecruiters|bamboohr|jobvite|taleo|successfactors|paylocity|breezy|recruitee|teamtailor|jobs|careers|apply)\.[a-z]/i;
const ATS_PATH = /\/(?:job|jobs|careers|opening|openings|position|vacancy)s?\//i;

/** Every job-posting URL in a block of free text, de-duplicated, trailing punctuation stripped. */
export function postingUrlsIn(text) {
  const raw = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  const out = [];
  for (const u of raw) {
    const clean = u.replace(/[.,;:!?]+$/, '');
    let host;
    try { host = new URL(clean).hostname; } catch { continue; }
    // linkedin.com/jobs/view/<id> is a posting; every other linkedin.com link is not.
    const isLinkedInJob = /(?:^|\.)linkedin\.com$/i.test(host) && /\/jobs\/view\//i.test(clean);
    if (!isLinkedInJob && !(ATS_HOST.test(host) || ATS_PATH.test(clean))) continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** "3+ years", "5-7 Years", "Relevant Work Experience: 5-7 Years" — every years bar stated. */
function yearsBars(text) {
  const out = [];
  const re = /(\d{1,2})\s*(?:\+|-|–|to)\s*(\d{1,2})?\s*\+?\s*years?/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 8) {
    const end = m.index + m[0].length;
    // "3+ years of software engineering experience" carries its meaning AFTER the number.
    // "Relevant Work Experience\n5-7 Years" carries it on the LINE BEFORE, which a same-line
    // regex can never see — and on <COMPANY_E> reqs that preceding-line field is the one bar that
    // actually governs the screen. Take whichever side has words.
    const sameLine = text.slice(end, end + 70).split('\n')[0].trim();
    const priorLines = text.slice(Math.max(0, m.index - 140), m.index).split('\n').map((s) => s.trim()).filter(Boolean);
    const label = /[a-z]{3}/i.test(sameLine) ? sameLine : (priorLines.pop() || '');
    out.push({
      low: Number(m[1]),
      high: m[2] ? Number(m[2]) : null,
      label: label.replace(/[:;\-–,.]+\s*$/, '').slice(-60).trim(),
    });
  }
  return out;
}

/** The advertised base band, if the posting states one. */
function payBand(text) {
  const m = text.match(/\$\s?([\d,]{5,12}(?:\.\d\d)?)\s*(?:-|–|to)\s*\$?\s?([\d,]{5,12}(?:\.\d\d)?)/);
  if (!m) return null;
  const n = (s) => Number(String(s).replace(/,/g, ''));
  const [lo, hi] = [n(m[1]), n(m[2])];
  // Plausibility: a US base band, not a revenue figure or a phone number that happens to match.
  if (!(lo >= 30_000 && hi <= 900_000 && hi > lo)) return null;
  return { low: lo, high: hi };
}

/** Requisition id as the posting itself states it. */
function reqId(text) {
  const m = text.match(/\b(?:req(?:uisition)?(?:\s*(?:id|#|no\.?|number))?)\s*[:#]?\s*([A-Z]{0,3}-?\d{4,10})\b/i)
    || text.match(/\b(R\d{6,9})\b/);
  return m ? m[1] : null;
}

/** The posting's own title, preferring the ATS API's field over a scraped <title>. */
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*(?:\||-|–|—)\s*(?:jobs?|careers?)\b.*$/i, '')
    // Scraped <title> tags tack the board's own name on: "... and jobs at <COMPANY_E>". The
    // generic fetcher also truncates long titles, so the suffix can arrive as "and jobs ...".
    .replace(/\s+and jobs\b.*$/i, '')
    .replace(/\s*\.{3}$/, '')
    .trim()
    .slice(0, 160) || null;
}

/**
 * Fetch one posting and reduce it to the handful of facts a reply actually turns on.
 * Returns null when the URL cannot be read — a reply grounded in nothing is the bug this
 * file exists to stop, so an unreachable posting must NOT silently degrade to a guess.
 */
export async function postingFactsFor(url, { timeoutMs = 45_000 } = {}) {
  let title = null, text = '', company = null, location = null, source = null;

  try {
    const { fetchViaAts } = await import('../assist/ats-fetch.mjs');
    const r = await Promise.race([
      fetchViaAts(url),
      new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), timeoutMs)),
    ]);
    if (r?.ok) ({ title, text, company, location } = r), (source = `ats:${r.ats}`);
    // A posting the ATS reports as CLOSED is a fact worth returning, not a failure to hide.
    else if (r?.closed) return { url, closed: true, source: `ats:${r.ats || '?'}` };
  } catch { /* fall through to the generic fetcher */ }

  if (!text) {
    try {
      const { fetchUrl } = await import('../assist/web.mjs');
      const r = await Promise.race([
        fetchUrl(url, { maxChars: 14_000 }),
        new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), timeoutMs)),
      ]);
      if (r?.ok && r.content) { title = title || r.title; text = r.content; source = 'web'; }
    } catch { /* unreachable — handled below */ }
  }

  if (!text || text.length < 400) return null;   // nav-shell scrape, not a posting body

  return {
    url,
    source,
    title: cleanTitle(title),
    company,
    location,
    req: reqId(text),
    years: yearsBars(text),
    pay: payBand(text),
    screen: screenJD(text),
    text: text.slice(0, 6000),
  };
}

/**
 * Turn posting facts into an instruction the drafting model must obey.
 *
 * The framing matters more than the facts. Telling the model "here is the posting" invites it
 * to blend the posting with the recruiter's blurb and average the two. It is told explicitly
 * that the recruiter's description is hearsay and the posting overrides it, because the whole
 * failure mode is a confident reply built on a recruiter's paraphrase of their own req.
 */
export function postingInstruction(facts) {
  if (!facts) return null;
  if (facts.closed) {
    return `The job posting they linked (${facts.url}) is CLOSED according to the employer's own applicant `
      + `system. Say so plainly and ask whether there is an equivalent open req. Do not agree to apply to it.`;
  }

  const L = [];
  L.push(`VERIFIED FROM THE POSTING ITSELF (fetched just now from ${facts.url}).`);
  L.push(`This overrides anything the sender wrote about the role: their description is a summary written to `
    + `get a reply, and it is often wrong about the title and the level. Where the two disagree, the posting wins.`);
  if (facts.title) L.push(`- Actual posting title: "${facts.title}"`);
  if (facts.company) L.push(`- Company: ${facts.company}`);
  if (facts.location) L.push(`- Location: ${facts.location}`);
  if (facts.req) L.push(`- Requisition id: ${facts.req}`);
  if (facts.pay) L.push(`- Advertised base band: $${facts.pay.low.toLocaleString()} to $${facts.pay.high.toLocaleString()}`);

  if (facts.years?.length) {
    const s = facts.years.map((y) => `${y.low}${y.high ? `-${y.high}` : '+'} years${y.label ? ` (stated as: "${y.label.trim()}")` : ''}`);
    L.push(`- Experience bars stated in the posting: ${s.join('; ')}`);
    // A posting that states two different years bars is the single most decision-relevant
    // ambiguity on this surface, and the reply must not silently pick one and sound certain.
    if (facts.years.length > 1) {
      L.push(`  NOTE: this posting states MORE THAN ONE experience bar. Do not assert a single `
        + `requirement as if it were settled. If the years bar decides the answer, say which figure you are `
        + `going on, or ask them which one governs.`);
    }
  }

  if (facts.screen?.bars?.length) {
    L.push(`- HARD BARS found in the posting: ${facts.screen.bars.map((b) => b.id).join(', ')}. `
      + `These are disqualifying and must be addressed directly rather than ignored.`);
  }

  L.push('');
  L.push('=== POSTING TEXT (primary source; the sender\'s summary is not) ===');
  L.push(facts.text);
  L.push('=== END POSTING TEXT ===');
  L.push('');
  L.push('Judge the role from the posting text above, NOT from the title alone and NOT from their summary. '
    + 'If they raised work authorization or sponsorship, answer it using the stated facts about my status '
    + 'rather than leaving it unaddressed.');
  return L.join('\n');
}

// ponytail: one self-check over the parsing, which is where the bugs live. The fetchers are
// already covered by their own modules; what is new here is URL selection and field extraction.
if (process.argv[1] && process.argv[1].endsWith('posting-facts.mjs')) {
  const assert = (await import('assert')).strict;
  const C = 'https://jobs.example.com/job/city/software-engineer-3-ai-hybrid-city-st-team/45483/<ID>';

  // Shape of a real InMail: the posting is found; a scheduling link, a company homepage and a
  // profile link are not. Scheduling links are the most common inbound URL by far.
  assert.deepEqual(postingUrlsIn(`AI Software Engineer 3 \n${C} \n\nFor more information...`), [C]);
  assert.deepEqual(postingUrlsIn('grab a slot https://calendly.com/example-recruiter/30min'), []);
  assert.deepEqual(postingUrlsIn('see https://www.example.com/ and https://linkedin.com/in/someone'), []);
  assert.deepEqual(postingUrlsIn('https://www.linkedin.com/jobs/view/<ID>'), ['https://www.linkedin.com/jobs/view/<ID>']);
  assert.deepEqual(postingUrlsIn('apply at https://boards.greenhouse.io/acme/jobs/12345.'),
    ['https://boards.greenhouse.io/acme/jobs/12345']);        // trailing period stripped
  assert.deepEqual(postingUrlsIn(`${C} and again ${C}`), [C]); // de-duplicated

  // Both of <COMPANY_E>'s contradictory bars are captured — picking one silently was the bug.
  const y = yearsBars('Preferred Qualifications\n3+ years of software engineering experience.\nRelevant Work Experience\n5-7 Years');
  assert.equal(y.length, 2);
  assert.deepEqual([y[0].low, y[0].high], [3, null]);
  assert.deepEqual([y[1].low, y[1].high], [5, 7]);

  assert.deepEqual(payBand('Virginia Pay Range: $100,000.00 - $150,000.00'), { low: 100000, high: 150000 });
  assert.equal(payBand('call 555-0100-2000 or <PHONE>'), null);  // phone digits are not a pay band
  assert.equal(reqId('Req ID\nR442250\nJob Type'), 'R442250');
  assert.equal(cleanTitle('Software Engineer 3 (AI) - Hybrid - <CITY>, <ST> - <TEAM> and jobs at <COMPANY_E>'),
    'Software Engineer 3 (AI) - Hybrid - <CITY>, <ST> - <TEAM>');
  // What the generic fetcher actually returned for this posting: truncated mid-suffix.
  assert.equal(cleanTitle('Software Engineer 3 (AI) - Hybrid - <CITY>, <ST> - <TEAM> and jobs ...'),
    'Software Engineer 3 (AI) - Hybrid - <CITY>, <ST> - <TEAM>');
  // The years label must name the bar, not capture a stray dash before the number.
  assert.ok(/software engineering/i.test(y[0].label), `bare label: ${JSON.stringify(y[0].label)}`);
  assert.ok(/Relevant Work Experience/i.test(y[1].label), `bare label: ${JSON.stringify(y[1].label)}`);

  // A posting that states two bars must warn the model rather than sound certain.
  const inst = postingInstruction({ url: C, title: 'Software Engineer 3 (AI)', years: y, text: 'x'.repeat(500), screen: { bars: [] } });
  assert.ok(inst.includes('MORE THAN ONE experience bar'));
  assert.ok(inst.includes('the posting wins'));
  assert.equal(postingInstruction(null), null);
  assert.ok(postingInstruction({ url: C, closed: true }).includes('CLOSED'));

  console.log('posting-facts.mjs: all checks passed');
}
