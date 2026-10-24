export const meta = {
  name: 'career-ops-email-drafts-v2',
  description: 'Sidecar-file version. Each agent writes data/email-drafts/<num>.json directly (no schema, no race). Final merge reads all sidecars and patches contacts.json once.',
  whenToUse: 'Recovery from v1 schema-timeout failures. Pass args.apps = [{appNumber, reportPath}].',
  phases: [
    { title: 'Draft', detail: 'Parallel — each agent writes one sidecar JSON, returns plain text only.' },
    { title: 'Merge', detail: 'Read all sidecars, patch contacts.json once.' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const SIDECAR_DIR = 'data/email-drafts'

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !Array.isArray(_args.apps) || !_args.apps.length) {
  throw new Error('args.apps is REQUIRED.')
}
const APPS = _args.apps

phase('Draft')
const drafts = await parallel(APPS.map(app => () =>
  agent(
    `Draft cold-outreach EMAILS for each existing contact on app #${app.appNumber}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${app.appNumber}
  reportPath: ${app.reportPath}
  sidecarPath: ${SIDECAR_DIR}/${app.appNumber}.json

MANDATORY READS (in order — DO NOT skip):
1. data/contacts.json — find the applications[] entry with appNumber == ${app.appNumber}. Read company, role, url, contacts[] (each: name, title, type, linkedin). If contacts[] is empty, write {appNumber: ${app.appNumber}, emails: [], note: "no contacts to draft for"} to the sidecar and exit.
2. ${app.reportPath} — read JD highlights (company/role context, JD's actual stack/tooling).
3. AGENTS.md (the "Outreach message rules" + "Resume Accuracy & Outreach Sourcing" sections only — skim, do not read end-to-end).
4. cv.md (for metric source-of-truth).

EMAIL FRAMEWORK (cold-outreach email, different from LinkedIn connect — emails are longer + have subject):

For EACH existing contact, draft:
- emailSubject: <=60 chars. Specific. Role + company OR anchored on their work. Never generic.
- emailBody: 90-170 words. Plain text. 3 short paragraphs + signature.

Type-specific body framework:
- hiring_manager:
  · P1: Anchor on THEIR team or something specific to the role/team (1 sentence).
  · P2: One quantified proof from cv.md matched to the JD's actual ML domain (RAG/transformer NLP for LLM roles, recsys for recommendation, multi-modal DL + edge inference for CV, MLOps on AWS+K8s for platform). Never default-stamp a domain the JD doesn't call for. One specific metric — not five.
  · P3: Soft CTA — "Would love 15 minutes to learn how your team is approaching [their challenge]."
  · NEVER ask referral, NEVER beg.
- recruiter:
  · P1: "I applied to the <Role> role." Screening data: stack match (1 line), comp target $70-100K, work auth <YOUR_WORK_AUTH_STATUS> (STEM extension eligible), location USA-wide / fully mobile.
  · P2: ONE proof metric anchored to JD's stack.
  · P3: Direct CTA — "Happy to share my CV or jump on a 15-min screen — what works best?"
- peer:
  · P1: Reference THEIR specific work/path/skill. NOT generic.
  · P2: Your related work — ONE metric. Shared-interest framing, not job pitch.
  · P3: Curiosity CTA — "Would love your take on <topic>." NO referral ask, NO "forward my resume", NO job pitch.

UNIVERSAL HARD RULES:
- Body 90-170 words. Subject <=60 chars.
- Signature block at end of body (literal — include "---" separator):
    ---
    <YOUR_NAME>
    <YOUR_EMAIL>
    LinkedIn: https://www.linkedin.com/in/<PROFILE_SLUG>
    Portfolio: https://<YOUR_DOMAIN>/
- NEVER include phone number.
- NEVER fabricate metrics. Allowed: <YOUR_CV_METRICS>.
- One specific metric per email max.
- No corporate-speak. No emojis. No "circling back", "leverage as verb", "hope this finds you well".
- If contact already has a non-null emailBody, skip it.

CRITICAL OUTPUT — write a single JSON file via the Write tool to:
  ${SIDECAR_DIR}/${app.appNumber}.json

Schema:
{
  "appNumber": ${app.appNumber},
  "company": "<from contacts.json>",
  "role": "<from contacts.json>",
  "emails": [
    {
      "contactName": "<exact name as in contacts.json>",
      "contactType": "hiring_manager" | "recruiter" | "peer",
      "emailSubject": "<...>",
      "emailBody": "<...with literal newlines as \\n in the JSON string...>"
    }
  ]
}

After writing the JSON file, return ONE LINE of plain text:
  DONE app=${app.appNumber} emails=<N>
or
  FAIL app=${app.appNumber} reason=<short clause>

Plain text only. Do NOT call StructuredOutput. The sidecar file IS the deliverable.`,
    { label: `email-v2:${app.appNumber}`, phase: 'Draft' }
  )
))

const responseCount = drafts.filter(Boolean).length
log(`Draft phase: ${responseCount}/${APPS.length} agents returned`)

phase('Merge')
const merge = await agent(
  `Merge sidecar email drafts into data/contacts.json. Project root ${ROOT}.

STEPS:
1. List all files in ${SIDECAR_DIR}/ — they are named "<appNumber>.json".
2. For each sidecar file:
   - Parse the JSON. Expect { appNumber, emails: [{contactName, contactType, emailSubject, emailBody}] }.
   - Open data/contacts.json. Find applications[] entry with matching appNumber.
   - For each email in emails[]:
     · Find the contact in that application's contacts[] where contact.name == contactName AND contact.type == contactType.
     · Update contact.messages.emailSubject = emailSubject and contact.messages.emailBody = emailBody.
     · LEAVE contact.messages.linkedinConnect UNTOUCHED.
   - Track: app touched, contacts updated, mismatches (contactName not found).
3. Write the FULL contacts.json back atomically via Write tool.
4. Verify post-write: re-read, confirm a spot-check of 2-3 entries have the new fields.

For these targeted appNumbers (the ones we ran THIS time), expect to find sidecars for: [${APPS.map(a => a.appNumber).join(', ')}].
Any sidecar for an app NOT in that list = leftover from a prior run; merge it too (it's still valid data).

Return plain text summary:
- Sidecars found: N
- Apps touched: N
- Contacts updated: N
- Mismatches: list any contactName not found
- linkedinConnect preserved: yes/no
No StructuredOutput.`,
  { label: 'merge-sidecars', phase: 'Merge' }
)

return {
  attempted: APPS.length,
  responses: drafts.map((r, i) => ({ app: APPS[i].appNumber, response: (r || 'NULL').slice(0, 80) })),
  merge,
}
