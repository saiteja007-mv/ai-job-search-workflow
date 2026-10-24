export const meta = {
  name: 'aiml-contacts',
  description: 'Find REAL LinkedIn outreach contacts per high-fit company + draft messages; return structured for merge',
  phases: [{ title: 'Outreach', detail: 'one agent per company, ≤5 concurrent to respect web-search rate limits' }],
}

const groups = (typeof args === 'string' ? JSON.parse(args) : args) || []

const CONTACT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'type', 'linkedin', 'messages'],
  properties: {
    name: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string', enum: ['hiring_manager', 'recruiter', 'peer', 'skip_level', 'interviewer'] },
    linkedin: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    verified: { type: 'boolean', description: 'true only if a real LinkedIn profile URL was found via search; false if inferred/uncertain' },
    messages: {
      type: 'object',
      additionalProperties: false,
      required: ['linkedinConnect', 'linkedinInmail', 'emailSubject', 'emailBody'],
      properties: {
        linkedinConnect: { type: 'string', description: '<=300 chars' },
        linkedinInmail: { type: ['string', 'null'] },
        emailSubject: { type: ['string', 'null'] },
        emailBody: { type: ['string', 'null'] },
      },
    },
  },
}
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'applications'],
  properties: {
    company: { type: 'string' },
    applications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['appNumber', 'company', 'role', 'url', 'contacts'],
        properties: {
          appNumber: { type: 'integer' },
          company: { type: 'string' },
          role: { type: 'string' },
          url: { type: ['string', 'null'] },
          contacts: { type: 'array', items: CONTACT },
        },
      },
    },
  },
}

function prompt(g) {
  const roleLines = g.roles.map((r) => `  - #${r.n} ${r.role} (${r.url})`).join('\n')
  return `You are a career-ops outreach agent (contacto mode). Find REAL LinkedIn contacts at ${g.company} and draft messages.

# Company: ${g.company}
High-fit role(s) the candidate is applying to:
${roleLines}

# Candidate identity (for message signing / personalization)
- Name: <YOUR_NAME>
- LinkedIn: https://www.linkedin.com/in/<PROFILE_SLUG>
- Email: <YOUR_EMAIL>
- Pitch: <YOUR_ONE_LINE_PITCH> (Read modes/_profile.md for the exact framing + modes/contacto.md for message rules.)

# Step 1 — Read context
- modes/_profile.md  (outreach rules, OPT framing — state "authorized to work in US", do NOT volunteer visa; do NOT share phone)
- modes/contacto.md  (message format + the ≤300-char LinkedIn connect-note limit)

# Step 2 — Find REAL contacts (WebSearch — keep TOTAL searches for this whole task ≤ 6)
Discover contacts at ${g.company} relevant to these ML/AI teams. Per _profile.md discovery process:
1. Hiring manager / ML lead:  "${g.company}" machine learning OR ML OR AI manager OR director site:linkedin.com/in
2. Recruiter / talent:         "${g.company}" recruiter "machine learning" OR technical recruiter site:linkedin.com/in
3. Peer ML engineer:           "${g.company}" "machine learning engineer" site:linkedin.com/in
Find 2-3 real people TOTAL for the company (reuse across the roles; note role-specific fit). PRIMARY = tightest title-to-team match (peer on the exact team > direct manager > recruiter).
**CRITICAL: never invent names or LinkedIn URLs.** Only include a contact with verified:true if you actually found a real LinkedIn profile URL in search results. If you cannot verify a real profile, you may include a role-targeted recruiter/HM with linkedin:null and verified:false, clearly labeled, OR return fewer contacts. Honesty over completeness.

# Step 3 — Draft messages per contact (apply _profile.md writing rules: no buzzwords, active voice, concrete)
- linkedinConnect: <=300 chars, personalized to the contact's team + the candidate's tightest matching proof point.
- linkedinInmail: a longer (120-180 word) version for InMail/DM.
- emailSubject + emailBody: only if a reasonable company email pattern exists (e.g. first.last@company.com) — else null.

# Step 4 — Append an "## Outreach" section to EACH role's report (use Edit; report paths:)
${g.roles.map((r) => `  - #${r.n}: ${r.report}`).join('\n')}
Add the contacts + the primary connect message under "## Outreach" at the end of each report.

# Step 5 — Return the structured object
applications[]: one entry per role (appNumber, company, role, url, contacts[]). Reuse the same company-level contacts across roles, but you may tailor the connect message per role's team. Mark verified=false for any contact you could not confirm with a real profile URL.`
}

phase('Outreach')
// 5 company groups — run all concurrently (<=5 web-search agents, within the safe band).
const results = (await parallel(
  groups.map((g) => () => agent(prompt(g), { label: `contacts:${g.company}`, phase: 'Outreach', schema: SCHEMA }))
)).filter(Boolean)

const totalContacts = results.reduce((s, r) => s + r.applications.reduce((a, x) => a + x.contacts.length, 0), 0)
return {
  companies: results.length,
  totalContacts,
  byCompany: results.map((r) => ({
    company: r.company,
    apps: r.applications.map((a) => ({ n: a.appNumber, role: a.role, contacts: a.contacts.length, verified: a.contacts.filter((c) => c.verified).length })),
  })),
  // full payload for the orchestrator to merge into data/contacts.json
  merge: results.flatMap((r) => r.applications),
}
