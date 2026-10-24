export const meta = {
  name: 'career-ops-email-drafts',
  description: 'Backfill emailSubject + emailBody drafts onto every existing contact in contacts.json for a list of appNumbers. LinkedIn connect msgs untouched; email is the parallel channel for once Chrome extension reveals the address.',
  whenToUse: 'When you need to add email drafts to already-sourced LinkedIn contacts (HM/Recruiter/Peer). Pass args.apps = [{appNumber, reportPath}, ...]. Skips contacts that already have emailBody.',
  phases: [
    { title: 'Draft', detail: 'Parallel — one agent per app, reads its report + drafts emails per contact type, returns structured payload.' },
    { title: 'Merge', detail: 'Serial — single merge agent writes all email drafts back into contacts.json atomically.' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !Array.isArray(_args.apps) || !_args.apps.length) {
  throw new Error('args.apps is REQUIRED (non-empty array of {appNumber, reportPath}).')
}
const APPS = _args.apps

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    appNumber: { type: 'number' },
    company: { type: 'string' },
    role: { type: 'string' },
    emails: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          contactName: { type: 'string' },
          contactType: { type: 'string' },
          emailSubject: { type: 'string' },
          emailBody: { type: 'string' },
          subjectChars: { type: 'number' },
          bodyWords: { type: 'number' },
        },
        required: ['contactName', 'contactType', 'emailSubject', 'emailBody'],
        additionalProperties: true,
      },
    },
    skipped: { type: 'array', items: { type: 'string' } },
  },
  required: ['appNumber', 'emails'],
  additionalProperties: true,
}

// ---------- Phase 1: Draft (parallel) ----------
phase('Draft')
const drafts = await parallel(APPS.map(app => () =>
  agent(
    `Draft cold-outreach EMAILS (not LinkedIn connects) for each existing contact on app #${app.appNumber}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${app.appNumber}
  reportPath: ${app.reportPath}

MANDATORY READS (in order):
1. data/contacts.json — find the applications[] entry with appNumber == ${app.appNumber}. Read company, role, url, and the contacts[] array (each has name, title, type, linkedin).
2. ${app.reportPath} — read the JD highlights (Block A role summary, Block B fit-to-role keywords/tooling). You need this to anchor each email in the JD's actual stack/domain.
3. AGENTS.md "Outreach message rules" section (3-sentence framework + hard rules).
4. modes/contacto.md (HM / Recruiter / Peer message frameworks).
5. cv.md — for metric-source-of-truth.

EMAIL FRAMEWORK (different from the LinkedIn connect msg — emails are LONGER and have a subject):

For EACH existing contact, draft:
- emailSubject: <=60 chars. Specific. Role + company name OR a curiosity-anchor referencing their work. NEVER generic ("Hello", "Reaching out", "Quick question").
- emailBody: 90-170 words. Plain text. Greeting → 2-3 short paragraphs → signature block.

Type-specific body framework:
- **hiring_manager**:
  · Para 1: Anchor on THEIR team or something specific to the role/team (1 sentence — from JD or their LinkedIn title context).
  · Para 2: One quantified proof from cv.md matched to the JD's actual pain (e.g., RAG/transformer NLP pipeline for an LLM role, recommendation engine for recsys, multi-modal DL + edge inference for CV, MLOps on AWS+K8s for platform roles). Lead with the JD's actual ML domain; never default-stamp a domain the JD doesn't call for. ONE specific metric — don't dump 5.
  · Para 3: Soft CTA — "Would love 15 minutes to learn how your team is thinking about [their challenge]" OR "Happy to share more on how I'd approach [X]."
  · NEVER ask for referral. NEVER beg.
- **recruiter**:
  · Para 1: "I applied to the <Role> role on <date if known, else 'recently'>." Add screening data: stack match (1 line), comp expectation $70-100K, work auth <YOUR_WORK_AUTH_STATUS> (STEM extension eligible), location preference (USA-wide, fully mobile).
  · Para 2: ONE proof metric anchored to the JD's stack.
  · Para 3: Direct CTA — "Happy to send my CV again or jump on a 15-min screen — what works best?"
- **peer**:
  · Para 1: Reference THEIR specific work / path / something only that person could have done. NOT generic "I see you work at X."
  · Para 2: Your related work — ONE metric. Frame as shared-interest, NOT job-pitch.
  · Para 3: Curiosity CTA — "Would love 15 minutes to hear your take on <topic>." NO referral ask, NO "can you forward my resume", NO job pitch.

UNIVERSAL HARD RULES:
- Body 90-170 words. Subject <=60 chars. Count words/chars before returning.
- Signature block at end of body:
    ---
    <YOUR_NAME>
    <YOUR_EMAIL>
    LinkedIn: https://www.linkedin.com/in/<PROFILE_SLUG>
    Portfolio: https://<YOUR_DOMAIN>/
- NEVER include phone number (per AGENTS.md / modes/_profile.md hard rule).
- NEVER fabricate metrics. Allowed: <YOUR_CV_METRICS>.
- One specific metric per email MAX. Person-anchored opening, not template.
- No corporate-speak ("synergy", "leverage as a verb", "I hope this finds you well", "circling back").
- No emojis.
- If contact already has a non-null emailBody in contacts.json, skip it (add to "skipped" array with the contact name + reason).

Return DRAFT_SCHEMA: { appNumber, company, role, emails: [{contactName, contactType, emailSubject, emailBody, subjectChars, bodyWords}], skipped }.`,
    { schema: DRAFT_SCHEMA, label: `email-draft:${app.appNumber}`, phase: 'Draft' }
  )
))

const ok = drafts.filter(Boolean)
log(`Drafted: ${ok.length}/${APPS.length} apps; total emails: ${ok.reduce((s, d) => s + (d.emails?.length || 0), 0)}`)

// ---------- Phase 2: Merge (single serial agent) ----------
phase('Merge')

const allDrafts = ok.map(d => ({
  appNumber: d.appNumber,
  emails: d.emails || [],
}))

const merge = await agent(
  `Merge email drafts into data/contacts.json. Project root ${ROOT}.

You will receive a JSON payload below with all drafted emails. For EACH entry:
1. Find the applications[] entry in data/contacts.json with the matching appNumber.
2. For each email in that entry's emails[] array:
   - Locate the contact in that application's contacts[] where contact.name == email.contactName AND contact.type == email.contactType.
   - Update contact.messages.emailSubject = email.emailSubject.
   - Update contact.messages.emailBody = email.emailBody.
   - Leave contact.messages.linkedinConnect UNTOUCHED.
3. Do not modify any other fields, contacts, or applications.

After all updates, write the FULL contacts.json back atomically (Write tool, not Edit — single write of the whole file).

Verify after writing: re-read the file and confirm the email counts. Report: total apps touched, total contacts updated, any contact-not-found mismatches.

PAYLOAD:
${JSON.stringify(allDrafts, null, 2)}

Return plain text summary. No StructuredOutput.`,
  { label: 'merge-emails', phase: 'Merge' }
)

return {
  attempted: APPS.length,
  drafted: ok.length,
  totalEmails: ok.reduce((s, d) => s + (d.emails?.length || 0), 0),
  totalSkipped: ok.reduce((s, d) => s + (d.skipped?.length || 0), 0),
  perApp: ok.map(d => ({
    appNumber: d.appNumber,
    company: d.company,
    emails: d.emails?.length || 0,
    skipped: d.skipped?.length || 0,
  })),
  merge,
}
