export const meta = {
  name: 'career-ops-outreach-serial',
  description: 'Serial outreach for a small list of real-employer high-fits — one agent at a time to avoid the lost-update race on data/contacts.json that wiped 6/9 entries during parallel writes.',
  whenToUse: 'When a prior parallel outreach run lost writes due to read-modify-write race on contacts.json. Pass args.hits = [{appNumber, company, role, url, reportPath}, ...].',
  phases: [
    { title: 'Outreach', detail: 'Serial: one agent at a time, each fully completes its contacts.json + report.md writes before the next starts.' },
    { title: 'Verify', detail: 'Confirm all entries persisted to contacts.json' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = null }
}
if (!_args || !Array.isArray(_args.hits) || !_args.hits.length) {
  throw new Error('args.hits is REQUIRED.')
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
    contactsJsonTotalAfter: { type: 'number' },
  },
  required: ['appNumber', 'contacts'],
  additionalProperties: true,
}

phase('Outreach')
const results = []
for (const hf of HITS) {
  const r = await agent(
    `Outreach for app #${hf.appNumber} at ${hf.company} (${hf.role}). Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: ${hf.reportPath}

MANDATORY READS: AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md, modes/_profile.md "Auto-Outreach for High-Fit Roles" template.

HARD RULES (refuse to violate):
- Every contact = real human + real https://www.linkedin.com/in/<handle>/ URL. NO placeholders, NO search-URL stand-ins.
- Currently employed at ${hf.company}. LinkedIn snippet must say current role at ${hf.company}.
- 3 contacts max, types: hiring_manager (or direct team manager), recruiter (TA), peer (similar IC on same team).
- connectMessage <= 300 chars. Verify char count.
- Framework per modes/contacto.md (HM: Hook/Proof/CTA; Recruiter: Fit/Proof/CTA; Peer: Interest/Connection/CTA, NO referral ask).
- Email = <YOUR_EMAIL>. No phone.
- If a type cannot be found, record in gaps; do NOT save a placeholder.

STEPS (in order — finish all before responding):
1. WebSearch (3 queries):
   - "${hf.company}" "machine learning" OR "ML" OR "AI" engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" OR "applied AI" site:linkedin.com/in
2. Identify candidates with CURRENT roles at ${hf.company}. Skip Former / other-employer.
3. Draft + verify <=300-char messages.
4. CRITICAL — atomic merge into data/contacts.json:
   - Read FULL existing JSON.
   - REMOVE any existing entry with appNumber == ${hf.appNumber} (idempotency).
   - APPEND new entry: { appNumber: ${hf.appNumber}, company: ${JSON.stringify(hf.company)}, role: ${JSON.stringify(hf.role)}, url: ${JSON.stringify(hf.url)}, contacts: [ ...each with name, title, type, linkedin, email: null, messages: { linkedinConnect: "<msg>", linkedinInmail: null, emailSubject: null, emailBody: null } ] }.
   - Sort applications[] by appNumber.
   - Write FULL JSON back via the Write tool (one-shot atomic; do NOT use Edit for whole-file replace).
5. Append "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} per modes/_profile.md template — Primary HM, Recruiter, Peer, Sequencing block.
6. Verify your entry survived: re-read data/contacts.json, confirm your appNumber is present and contacts.length matches what you intended. Capture total count as contactsJsonTotalAfter.
7. Call StructuredOutput with the schema.

You are running SERIALLY — no other agent is writing to contacts.json concurrently. Take your time.`,
    { schema: OUTREACH_SCHEMA, label: `outreach-serial:${hf.appNumber}`, phase: 'Outreach' }
  )
  results.push(r)
  log(`#${hf.appNumber} ${hf.company}: ${r?.contacts?.length || 0} contacts, total after: ${r?.contactsJsonTotalAfter || '?'}`)
}

// ---------- Verify ----------
phase('Verify')
const verify = await agent(
  `Final verification. Project root ${ROOT}.

1. Read data/contacts.json. Confirm presence of these appNumbers: [${HITS.map(h => h.appNumber).join(', ')}].
2. For each, report contacts.length.
3. Also confirm these were preserved (added earlier in this session and must NOT have been overwritten): 510, 511, 512, 514, 515, 516, plus all prior entries down to appNumber 2.
4. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | map(.appNumber) | sort' — confirm dashboard sees the same.

Return one-paragraph text summary. No StructuredOutput.`,
  { label: 'final-verify', phase: 'Verify' }
)

return {
  attempted: HITS.length,
  results: results.map((r, i) => ({
    appNumber: HITS[i].appNumber,
    company: HITS[i].company,
    contacts: r?.contacts?.length || 0,
    gaps: r?.gaps || null,
    totalAfter: r?.contactsJsonTotalAfter || null,
  })),
  verify,
}
