export const meta = {
  name: 'career-ops-outreach-only',
  description: 'Outreach-only: source real LinkedIn contacts for a list of high-fit appNumbers (after Resume work is already done). Gracefully records gaps for aggregator listings (employerHidden=true).',
  whenToUse: 'After a deep-scan workflow whose Resume stage actually completed file-work but failed StructuredOutput, leaving outreach unrun. Pass args.hits = [{appNumber, company, role, url, reportPath, legitimacy, employerHidden}, ...].',
  phases: [
    { title: 'Outreach', detail: 'Per-app: WebSearch LinkedIn → verify current employment → draft <=300-char msgs → merge contacts.json → append report section. <TARGET_COMPANY>/aggregator: record gap.' },
    { title: 'Dashboard', detail: 'Verify dashboard /api/* reflects new PDFs + contacts entries' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = null }
}
if (!_args || !Array.isArray(_args.hits) || !_args.hits.length) {
  throw new Error('args.hits is REQUIRED (non-empty array).')
}
const HITS = _args.hits

const OUTREACH_SCHEMA = {
  type: 'object',
  properties: {
    appNumber: { type: 'number' },
    contacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          name: { type: 'string' },
          title: { type: 'string' },
          linkedin: { type: 'string' },
          currentlyEmployed: { type: 'boolean' },
          connectMessage: { type: 'string' },
          chars: { type: 'number' },
        },
        required: ['type', 'name', 'linkedin', 'connectMessage'],
        additionalProperties: true,
      },
    },
    gaps: { type: ['string', 'null'] },
    employerHidden: { type: 'boolean' },
  },
  required: ['appNumber', 'contacts'],
  additionalProperties: true,
}

phase('Outreach')
const outreachResults = await parallel(HITS.map(hf => () =>
  agent(
    `Outreach for app #${hf.appNumber} at ${hf.company} (${hf.role}). Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: ${hf.reportPath}
  legitimacy: ${hf.legitimacy}
  employerHidden: ${hf.employerHidden ? 'YES' : 'no'}

MANDATORY READS (do not skip): AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md, modes/_profile.md "Auto-Outreach for High-Fit Roles" template section.

${hf.employerHidden ? `
=== AGGREGATOR CASE (employerHidden=YES) ===

The JD is hosted on <TARGET_COMPANY> or similar aggregator — actual hiring employer NOT disclosed in the JD body. You CANNOT find LinkedIn contacts at "<TARGET_COMPANY>" itself (they are a middleman, not the employer).

STEPS (do all, in order):
1. Skip WebSearch entirely. No contacts to source.
2. Merge into data/contacts.json:
   - Read FULL existing JSON.
   - Append (or replace if exists) an entry: { appNumber: ${hf.appNumber}, company: ${JSON.stringify(hf.company)}, role: ${JSON.stringify(hf.role)}, url: ${JSON.stringify(hf.url)}, contacts: [], notes: "Aggregator listing — employer undisclosed in JD. Manual contact research deferred until employer reveal after application." }.
   - Write FULL JSON back. DO NOT truncate other entries.
3. Append a "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} with one short paragraph: "Aggregator listing (${hf.company}). Real employer not disclosed in JD pre-application. Outreach deferred — once the employer reveals their identity (typically in initial recruiter screen), source HM + recruiter + peer contacts per modes/contacto.md."
4. Call StructuredOutput with:
   { appNumber: ${hf.appNumber}, contacts: [], gaps: "Aggregator listing — employer undisclosed pre-application", employerHidden: true }
` : `
=== REAL EMPLOYER CASE ===

HARD RULES (refuse to violate even if research is hard):
- Every contact = real human + real https://www.linkedin.com/in/<handle>/ URL. NO TODO, NO {firstName}, NO search-results URLs as final saves.
- Currently employed at ${hf.company}. LinkedIn snippet must show current role at ${hf.company} (not "Former", not at a different company).
- 3 contacts MAX, types: hiring_manager (or direct team manager), recruiter (TA), peer (similar IC on same team).
- Each connectMessage <= 300 chars (LinkedIn connect cap). Verify char count via plain length check.
- Framework per modes/contacto.md:
  · HM: Hook/Proof/CTA — anchor on the team's actual challenge or something only THAT person did. One specific stat max.
  · Recruiter: Fit/Proof/CTA — screening data (stack match, comp band $70-100K, <YOUR_WORK_AUTH_STATUS> work-auth, location).
  · Peer: Interest/Connection/CTA — reference THEIR work; NO job pitch, NO referral ask.
- Email = <YOUR_EMAIL>. No phone in any message.
- If a type cannot be found, document in 'gaps' field; do NOT save a placeholder.

STEPS (in order):
1. WebSearch up to 3 queries (search the WEB, not LinkedIn directly — LinkedIn blocks bots; Google's snippet of LinkedIn results is what surfaces names + current roles):
   - "${hf.company}" "machine learning" OR "ML" OR "AI" engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" OR "applied AI" site:linkedin.com/in
2. From snippets, identify candidates whose CURRENT role (snippet format "X - <Title> at ${hf.company}") matches the type you need. Skip "Former" and snippets pointing to other employers.
3. Draft each message per framework. Count chars. Verify <=300.
4. Merge into data/contacts.json:
   - Read FULL existing JSON.
   - Append (or replace if exists) an entry for appNumber ${hf.appNumber} with company/role/url + contacts array. Each contact: { name, title, type, linkedin, email: null, messages: { linkedinConnect: "<msg>", linkedinInmail: null, emailSubject: null, emailBody: null } }.
   - Write FULL JSON back. DO NOT truncate.
5. Append a "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} per the modes/_profile.md template — list each contact with name, title, LinkedIn URL, the connect message in a blockquote, and (chars) below it.
6. Call StructuredOutput with the schema.
`}`,
    { schema: OUTREACH_SCHEMA, label: `outreach:${hf.company}:${hf.appNumber}`.slice(0, 55), phase: 'Outreach' }
  )
))

const ok = outreachResults.filter(Boolean)
log(`Outreach: ${ok.length}/${HITS.length} returned schema-valid results`)

// ---------- Dashboard ----------
phase('Dashboard')
const dash = await agent(
  `Verify webapp dashboard. Project root ${ROOT}. Port 5050.

CHECKS:
1. docker ps --filter name=career-ops-dashboard --format "{{.Status}}"
2. curl -s http://127.0.0.1:5050/api/applications | jq 'length'
3. For each appNumber in [${HITS.map(h => h.appNumber).join(', ')}]:
   - curl -s "http://127.0.0.1:5050/api/pdf-path?appNumber=<num>"
   - report which return a path vs which 404
4. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | map(.appNumber) | sort | unique' — confirm new appNumbers appear.

Return one paragraph text summary. NO StructuredOutput tool.`,
  { label: 'dashboard-verify', phase: 'Dashboard' }
)

return {
  attempted: HITS.length,
  succeeded: ok.length,
  perApp: outreachResults.map((r, i) => ({
    appNumber: HITS[i].appNumber,
    company: HITS[i].company,
    employerHidden: HITS[i].employerHidden,
    contactsFound: r?.contacts?.length || 0,
    gaps: r?.gaps || null,
  })),
  dashboard: dash,
}
