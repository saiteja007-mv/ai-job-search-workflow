// bars.mjs — work-authorization disqualifier screen. Spec §10, "worth building in v1".
//
// Pure mechanism: regex only, no model call, instant. Per the spec this has already caught
// real disqualifiers, so it runs on any JD text the panel can see.
//
// WORD BOUNDARIES ARE LOAD-BEARING. The named regression is `itar` matching inside "military".
// Every pattern here anchors with \b, and the test suite asserts the "military" case directly.
//
// Patterns mirror the ones in the repo's own scan-filter.mjs, which has ZERO exports and so
// cannot be imported. Kept here with tests rather than duplicated silently.

/** Hard bars: if one of these fires, the role is very likely not applicable. */
export const HARD_BARS = [
  { id: 'no-sponsorship-catchall', why: 'states it will not sponsor',
    re: /\b(?:unable|not\s+able|cannot|will\s+not|do(?:es)?\s+not|are\s+not)\s+(?:to\s+)?(?:offer|provide|support|sponsor|extend)\b[^.]{0,40}(?:visa|sponsor|work\s+permit|h-?1b)/i },
  { id: 'no-sponsorship-direct', why: 'employer explicitly does not sponsor',
    re: /\b(?:we|company|employer|this\s+(?:role|position|company))\s+(?:does\s+not|do\s+not|cannot|are\s+unable|is\s+unable|won'?t)\s+(?:offer\s+|provide\s+|support\s+)?sponsor/i },
  { id: 'indefinite-work-auth', why: 'requires indefinite/permanent work authorization (rules out <YOUR_WORK_AUTH_STATUS>)',
    re: /\bindefinite(?:ly)?\b[^.]{0,20}(?:work\s+auth|authoriz)/i },
  { id: 'permanent-work-auth', why: 'requires permanent work authorization',
    re: /\bpermanent\s+work\s+auth/i },
  { id: 'unrestricted-work-auth', why: 'requires unrestricted work authorization',
    re: /\bunrestricted\s+work\s+auth/i },
  { id: 'without-sponsorship', why: 'requires authorization without current or future sponsorship',
    re: /\bwithout\s+(?:current\s+or\s+future\s+)?sponsorship\b/i },
  { id: 'us-citizen-required', why: 'US citizenship required',
    re: /\bmust\s+be\s+(?:a\s+)?US\s+citizen\b/i },
  { id: 'us-citizenship-required', why: 'US citizenship required',
    re: /\bUS\s+citizenship\s+(?:required|is\s+required|is\s+a\s+requirement)/i },
  { id: 'us-citizens-only', why: 'US citizens only',
    re: /\b(?:only\s+US\s+citizens|US\s+citizens\s+only)\b/i },
  { id: 'security-clearance', why: 'security clearance required (citizen-only proxy)',
    re: /\bsecurity\s+clearance\b/i },
  { id: 'active-clearance', why: 'active clearance required',
    re: /\bactive\s+(?:secret|top\s+secret|TS\/?SCI)\b/i },
  { id: 'clearance-level', why: 'named clearance level required',
    re: /\b(?:TS\/?SCI|SECRET\s+clearance)\b/i },
  { id: 'public-trust', why: 'public trust clearance required',
    re: /\bpublic\s+trust\s+clearance\b/i },
  // \bITAR\b, case-SENSITIVE and word-bounded. This is the exact pattern the "military" bug
  // was about — a loose /itar/i matches m-i-l-ITAR-y.
  { id: 'itar', why: 'ITAR / export-controlled (US Person required)', re: /\bITAR\b/ },
  { id: 'export-controlled', why: 'export-controlled role',
    re: /\bexport[ -]controlled\s+(?:role|technology|information)/i },
  { id: 'export-control-regs', why: 'subject to export control regulations',
    re: /\bexport\s+control\s+regulations\b/i },
  { id: 'us-person', why: 'US Person status required',
    re: /\bU\.?S\.?\s+Person\s+(?:status\s+)?(?:required|only)\b/i },
  { id: 'skillbridge', why: 'SkillBridge / transitioning service member only',
    re: /\b(?:SkillBridge|transitioning\s+(?:service\s+)?member)\b/i },
  { id: 'stem-opt-i983-refusal', why: 'refuses to sign the STEM OPT I-983 training plan',
    re: /\b(?:will\s+not|cannot|do(?:es)?\s+not)\s+sign\b[^.]{0,40}I-?983\b/i },
];

/** Non-US posting markers — not a hard bar, but usually means the role is not US-based. */
export const LOCATION_FLAGS = [
  { id: 'eu-gender-suffix', why: 'EU job-board gender suffix implies an EU posting',
    re: /\((?:m\/f\/d|m\/w\/d|h\/f|w\/m\/x|m\/v)\)/i },
  { id: 'non-us-base', why: 'explicitly based outside the US',
    re: /\b(?:based|office|located|HQ)\s+in\s+(?:Berlin|Frankfurt|Munich|Hamburg|Paris|London|Dublin|Amsterdam|Madrid|Barcelona|Rome|Milan|Tel\s*Aviv|Bangalore|Hyderabad|Mumbai|Pune|Singapore|Tokyo|Sydney|Sao\s*Paulo)\b/i },
];

/** Positive signals — a JD that says it sponsors is worth surfacing just as loudly. */
export const SPONSOR_HINTS = [
  { id: 'sponsors-h1b', why: 'states it sponsors H-1B', re: /\bsponsor\s+h-?1b\b/i },
  { id: 'sponsorship-available', why: 'visa sponsorship available', re: /\bvisa\s+sponsorship\s+available\b/i },
  { id: 'will-sponsor', why: 'will sponsor a visa', re: /\bwill\s+sponsor\s+(?:visa|h-?1b)\b/i },
  { id: 'sponsorship-offered', why: 'sponsorship offered', re: /\bsponsorship\s+(?:is\s+)?(?:available|provided|offered)\b/i },
];

const sentenceAround = (text, index, span = 160) => {
  const start = Math.max(0, index - span / 2);
  return text.slice(start, start + span).replace(/\s+/g, ' ').trim();
};

function scan(text, patterns) {
  const out = [];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    out.push({ id: p.id, why: p.why, matched: m[0].slice(0, 80), context: sentenceAround(text, m.index) });
  }
  return out;
}

/**
 * Screen a JD.
 * `verdict` is advisory, never a decision: 'bars' when a hard bar fires, 'sponsors' when only
 * positive signals do, 'unclear' otherwise. The 4.0 eval gate stays in career-ops (spec §1).
 */
export function screenJD(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { verdict: 'no-text', bars: [], locationFlags: [], sponsorHints: [] };
  const bars = scan(t, HARD_BARS);
  const locationFlags = scan(t, LOCATION_FLAGS);
  const sponsorHints = scan(t, SPONSOR_HINTS);
  return {
    verdict: bars.length ? 'bars' : (sponsorHints.length ? 'sponsors' : 'unclear'),
    bars,
    locationFlags,
    sponsorHints,
    // A JD can both promise sponsorship and require clearance. Say so rather than averaging.
    conflicting: bars.length > 0 && sponsorHints.length > 0,
  };
}
