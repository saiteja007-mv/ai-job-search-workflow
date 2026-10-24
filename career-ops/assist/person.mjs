// person.mjs — who am I writing to, and what have I already said to them?
//
// Three questions the draft pipeline must answer before writing a message:
//   1. Have I contacted this person before, and what EXACTLY did I say?
//      (Repeating your own opener verbatim is the most visible failure in outreach.)
//   2. Who are they — title, company, the role they relate to?
//   3. Is the draft actually about THEM, or is it generic filler?
//
// Sources, all read-only:
//   data/outreach_log.json  — 667 person-identified sends with full message text and dates,
//                             plus sent_profiles keyed by provider_id (the dedupe map).
//   data/contacts.json      — 618 contacts, 594 with LinkedIn URLs, carrying title/company/
//                             the application they belong to.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const handleOf = (u) => String(u ?? '').replace(/\/+$/, '').split('/').pop().toLowerCase();

const readJson = (root, rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; }
};

/**
 * Identify a person from whatever the page gave us.
 * Any of provider_id / public_id / profile URL / name will do; the first three are exact,
 * name is a fallback and can legitimately match more than one person.
 */
export function findPerson(root, { providerId, publicId, linkedin, name } = {}) {
  const pid = providerId || null;
  const handle = (publicId || handleOf(linkedin) || '').toLowerCase();
  const nameQ = norm(name);

  const log = readJson(root, 'data/outreach_log.json') || { events: [], sent_profiles: {} };
  const events = Array.isArray(log.events) ? log.events : [];

  const matches = events.filter((e) => {
    if (pid && e.provider_id === pid) return true;
    const eh = String(e.public_id || e.public_identifier || '').toLowerCase() || handleOf(e.linkedin);
    if (handle && eh === handle) return true;
    // Name matching only when nothing stronger is available — two people can share a name.
    return Boolean(nameQ) && !pid && !handle && norm(e.name) === nameQ;
  });

  // Contact record: title, company, and which application they belong to.
  const contacts = readJson(root, 'data/contacts.json');
  let contact = null;
  let application = null;
  if (contacts?.applications) {
    outer: for (const app of contacts.applications) {
      for (const c of app.contacts || []) {
        const ch = handleOf(c.linkedinProfileLink || c.linkedin);
        if ((pid && c.provider_id === pid) || (handle && ch === handle) ||
            (!pid && !handle && nameQ && norm(c.name) === nameQ)) {
          contact = c; application = app; break outer;
        }
      }
    }
  }

  const sentProfile = pid ? (log.sent_profiles || {})[pid] || null : null;

  // Newest first — the most recent thing you said matters most when writing the next message.
  const history = matches
    .map((e) => ({
      sent_at: e.sent_at, channel: e.channel, company: e.company || null, role: e.role || null,
      message: e.message || null, invitation_id: e.invitation_id || null, origin: e.external_origin || e.origin || null,
    }))
    .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));

  const invited = history.some((h) => /invite/i.test(h.channel || '')) || Boolean(sentProfile);
  const messaged = history.some((h) => /dm|message/i.test(h.channel || ''));

  return {
    found: Boolean(history.length || contact || sentProfile),
    identity: {
      name: contact?.name || history[0]?.name || name || null,
      title: contact?.title || null,
      company: contact?.company || history[0]?.company || null,
      linkedin: contact?.linkedinProfileLink || contact?.linkedin || linkedin || null,
      providerId: pid || contact?.provider_id || null,
      publicId: handle || contact?.public_id || null,
      type: contact?.type || null,
    },
    // The daily recruiter cron files its targets under a synthetic bucket; that is not an application.
    relatedApplication: application && application.company !== 'Daily LinkedIn recruiter outreach' ? {
      appNumber: application.appNumber ?? null,
      company: application.company ?? null,
      role: application.role ?? null,
      appliedRole: contact?.appliedRole ?? null,
    } : null,
    invited,
    messaged,
    contactCount: history.length,
    lastContact: history[0] || null,
    history: history.slice(0, 8),
    // The exact notes already sent, so the model can avoid repeating them.
    priorMessages: history.map((h) => h.message).filter(Boolean).slice(0, 5),
  };
}

/**
 * Deterministic relevance check. Spec-adjacent: the same shape as the other filters, and it
 * answers the question "are we giving details relevant to THIS person" mechanically rather
 * than trusting the model's self-assessment.
 *
 * A draft is "generic" when it references nothing specific to the recipient: not their name,
 * not their company, not their role, and not anything from the thread.
 */
export function checkRelevance(draft, person, extra = {}) {
  const d = norm(draft);
  if (!d) return { relevant: false, matched: [], reason: 'empty draft' };

  const signals = [];
  const id = person?.identity || {};
  const add = (label, value) => {
    if (!value) return;
    const v = norm(value);
    if (v.length < 3) return;
    // Match on the distinctive leading token, so "<COMPANY_AC>" matches "<COMPANY_AC>".
    const head = v.split(' ')[0];
    if (head.length >= 3 && d.includes(head)) signals.push(label);
  };
  add('name', (id.name || '').split(' ')[0]);
  add('company', id.company || extra.company);
  add('title', id.title);
  add('role', person?.relatedApplication?.role || extra.role);
  // A reply that answers what they actually wrote is relevant even if it never says their
  // name or company (a recruiter asking for OPT dates gets dates, not a greeting). Count
  // distinctive words from THEIR latest message that recur in the draft.
  // A reply that quotes a verified fact we handed the model (a req number, a posting URL) is
  // specific by construction — without this the relevance gate withholds exactly the answers
  // the recruiter asked for, because a req number contains none of their name/company words.
  for (const tok of extra.verifiedTokens || []) {
    if (tok && String(tok).length >= 4 && d.includes(norm(tok))) { signals.push('verified-fact'); break; }
  }
  if (extra.theirLast) {
    const stop = new Set(['please', 'thanks', 'thank', 'would', 'could', 'should', 'about', 'there', 'their',
      'which', 'where', 'because', 'looking', 'interested', 'opportunity', 'opportunities', 'experience',
      'company', 'regards', 'hello', 'provide', 'below', 'following']);
    const words = [...new Set(norm(extra.theirLast).split(/[^a-z0-9]+/).filter((w) => w.length >= 6 && !stop.has(w)))];
    const hits = words.filter((w) => d.includes(w));
    // Two shared words, or one long distinctive one ("attempts", "onboarding"): a short
    // request shares few words with an honest answer to it.
    if (hits.length >= 2 || hits.some((w) => w.length >= 8)) signals.push('thread');
  }

  // Repeating a previously sent opener verbatim is worse than being generic.
  const repeats = (person?.priorMessages || []).filter((m) => {
    const opener = norm(m).slice(0, 60);
    return opener.length > 30 && d.includes(opener);
  });

  return {
    relevant: signals.length > 0,
    matched: [...new Set(signals)],
    repeatsPriorMessage: repeats.length > 0,
    reason: signals.length ? null : 'the draft references nothing specific to this person',
  };
}

/** Compact block for the model prompt. Kept short — free-model context is scarce. */
export function personBlock(person) {
  if (!person?.found) return '';
  const id = person.identity;
  const lines = [`=== RECIPIENT ===`,
    `Name: ${id.name || 'unknown'}`,
    id.title ? `Title: ${id.title}` : '',
    id.company ? `Company: ${id.company}` : '',
    person.relatedApplication ? `Related application: ${person.relatedApplication.role || ''} at ${person.relatedApplication.company || ''}`.trim() : '',
  ].filter(Boolean);

  if (person.contactCount) {
    lines.push('', `=== PRIOR OUTREACH TO THIS PERSON (${person.contactCount}) ===`);
    lines.push(person.invited ? 'A connection invitation has already been sent.' : 'No invitation sent yet.');
    for (const h of person.history.slice(0, 3)) {
      lines.push(`- ${String(h.sent_at).slice(0, 10)} (${h.channel || '?'}): ${String(h.message || '').slice(0, 200)}`);
    }
    lines.push('', 'DO NOT repeat these messages. Write the NEXT message in this relationship, referring back only if it helps.');
  } else {
    lines.push('', 'No prior outreach to this person on file. This is a first contact.');
  }
  return lines.join('\n');
}

/** HTTP handler for GET /api/assist/person?linkedin=…&name=…&provider_id=… */
export function handler(ctx) {
  const q = ctx.url.searchParams;
  const person = findPerson(ctx.root, {
    providerId: q.get('provider_id') || undefined,
    publicId: q.get('public_id') || undefined,
    linkedin: q.get('linkedin') || undefined,
    name: q.get('name') || undefined,
  });
  return ctx.json(200, { ok: true, person });
}
