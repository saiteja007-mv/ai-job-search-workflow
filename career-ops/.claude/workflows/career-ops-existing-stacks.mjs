export const meta = {
  name: 'career-ops-existing-stacks',
  description: 'For a fixed list of EXISTING evaluations, generate JD-tailored PDFs (parallel, no schema, verified) and source real LinkedIn outreach (serial, atomic JSON writes).',
  whenToUse: 'When the user names specific appNumbers that already have reports/applications.md rows but lack PDFs and/or outreach. Pass args.hits = [{appNumber, slug, reportPath}, ...].',
  phases: [
    { title: 'Resume', detail: 'Parallel — one agent per appNumber. Plain-text return, 3-way verification before exit.' },
    { title: 'Outreach', detail: 'Serial — one agent at a time, atomic contacts.json writes (no race).' },
    { title: 'Sync', detail: 'Flip applications.md PDF cells ❌→✅; verify dashboard endpoints.' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !Array.isArray(_args.hits) || !_args.hits.length) {
  throw new Error('args.hits is REQUIRED (non-empty array of {appNumber, slug, reportPath}).')
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
  },
  required: ['appNumber', 'contacts'],
  additionalProperties: true,
}

// ---------- Phase 1: Resume (parallel, no schema) ----------
phase('Resume')
const resumeResults = await parallel(HITS.map(hf => () =>
  agent(
    `Generate a JD-tailored resume PDF for an existing evaluation. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  slug: ${hf.slug}
  reportPath: ${hf.reportPath}

You DO NOT know the company/role/archetype yet — discover them from the report.

MANDATORY READS (in order):
1. Read ${hf.reportPath} END-TO-END. Extract: company, role, URL, archetype, Block A-F highlights, JD's specific tooling/keywords.
2. Read cv.md, config/profile.yml, CLAUDE.md (Rule 6 esp.), AGENTS.md "Resume Accuracy" section.

STEPS:
1. Craft a JD-tailored Professional Summary (3-5 sentences, ~85-110 words). Per CLAUDE.md Rule 6:
   - Lead with this JD's actual archetype/domain. Lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for.
   - Every metric must trace to cv.md (<YOUR_CV_METRICS>).
   - Reframe truthfully — map the JD's ML problem to the closest project in cv.md (e.g. RAG/LLM guidance, edge inference, recsys/ad-targeting, time-series forecasting). NEVER fabricate.
2. Identify 4-7 JD emphasize keywords (lowercase, comma-separated, pulled from the JD body).
3. Pick archetype from {Machine Learning Engineer, Applied AI / GenAI Engineer, NLP / LLM Engineer, MLOps Engineer, Data Scientist}.
4. Build CV HTML:
     node scripts/build-tailored-cv.mjs ${hf.appNumber} ${hf.slug} "<role from report>" "<archetype>" "<keywords>" "" "<full summary text>"
   Use double-quotes around args; escape inner quotes with backslash if any.
5. Generate PDF:
     node generate-pdf.mjs output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-${hf.slug}.html output/${hf.appNumber}-${hf.slug}.pdf
6. Edit ${hf.reportPath}: locate the "**PDF:**" line. If it says "❌", replace the WHOLE line with "**PDF:** ✅ output/${hf.appNumber}-${hf.slug}.pdf". If it already has a ✅ with a path, leave it.

MANDATORY VERIFICATION before returning — run and confirm ALL pass:
- ls -la output/${hf.appNumber}-${hf.slug}.pdf  (file exists, >50KB)
- grep "PDF:.*✅" ${hf.reportPath}  (report header has ✅)
If either fails, re-run that step.

Return ONE LINE of plain text:
  DONE app=${hf.appNumber} pdf=output/${hf.appNumber}-${hf.slug}.pdf company=<short company> role=<short role>
or
  FAIL app=${hf.appNumber} reason=<short clause>

Plain text only. Do NOT call StructuredOutput.`,
    { label: `resume:${hf.appNumber}`, phase: 'Resume' }
  )
))
log(`Resume parallel: ${resumeResults.filter(Boolean).length}/${HITS.length} returned`)
resumeResults.forEach((r, i) => log(`  #${HITS[i].appNumber}: ${(r || 'NULL').slice(0, 100)}`))

// ---------- Phase 2: Outreach (serial — no race on contacts.json) ----------
phase('Outreach')
const outreachResults = []
for (const hf of HITS) {
  const r = await agent(
    `Source real, currently-employed LinkedIn outreach contacts for app #${hf.appNumber}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  reportPath: ${hf.reportPath}

You DO NOT know company/role yet — discover from the report.

MANDATORY READS:
1. Read ${hf.reportPath} — extract company, role, URL, team/function hints.
2. Read AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules" sections.
3. Read modes/contacto.md.
4. Read modes/_profile.md "Auto-Outreach for High-Fit Roles" template.

You are running SERIALLY — no other agent is writing data/contacts.json concurrently. Take your time and write the FULL file back atomically.

AGGREGATOR DETECTION: If the company in the report is "<TARGET_COMPANY>" or another aggregator hiding the real employer pre-application, set contacts=[] and gaps="Aggregator listing — employer undisclosed pre-application. Manual outreach deferred until recruiter screen reveals identity." Then still write the empty entry to contacts.json and append a one-paragraph gap-note section to the report. Then StructuredOutput.

HARD RULES (real-employer case):
- Each contact = REAL human + real https://www.linkedin.com/in/<handle>/ URL. NO placeholders, NO search-result URLs.
- Currently employed at the company (LinkedIn snippet shows current role at this employer, not "Former" or another company).
- 3 contacts MAX: hiring_manager (or direct team manager), recruiter (TA/sourcing), peer (similar IC on same team).
- Each connectMessage ≤300 chars. Verify char count.
- Framework per modes/contacto.md:
  · HM: Hook/Proof/CTA — anchor on something only that person did. ONE specific stat.
  · Recruiter: Fit/Proof/CTA — applied + screening data (stack, comp band, <YOUR_WORK_AUTH_STATUS>, location).
  · Peer: Interest/Connection/CTA — reference THEIR work; NO job pitch, NO referral ask.
- Email = <YOUR_EMAIL>. No phone.
- If a type cannot be found, document in gaps. Never save a placeholder.

STEPS:
1. WebSearch (3 queries — substitute the company you read from the report):
   - "<company>" machine learning engineering manager OR director site:linkedin.com/in
   - "<company>" recruiter talent acquisition site:linkedin.com/in
   - "<company>" "machine learning engineer" OR "ML engineer" OR "AI engineer" OR "applied scientist" OR "MLOps" OR "data scientist" site:linkedin.com/in
   (match the JD's exact role-family in the third query — e.g., for an NLP/LLM Engineer JD, search "machine learning engineer" or "applied scientist", not "data analyst")
2. Verify current employment via LinkedIn snippets.
3. Draft + char-count messages.
4. ATOMIC merge into data/contacts.json:
   - Read FULL existing JSON.
   - REMOVE any existing entry with appNumber == ${hf.appNumber} (idempotency).
   - APPEND { appNumber: ${hf.appNumber}, company, role, url, contacts: [...], notes: <optional> }.
   - Each contact: { name, title, type, linkedin, email: null, messages: { linkedinConnect: "<msg>", linkedinInmail: null, emailSubject: null, emailBody: null } }.
   - Sort applications[] by appNumber.
   - Write FULL JSON back via the Write tool.
5. Append "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} per modes/_profile.md template.

Return schema: { appNumber, contacts:[...], gaps }.`,
    { schema: OUTREACH_SCHEMA, label: `outreach:${hf.appNumber}`, phase: 'Outreach' }
  )
  outreachResults.push(r)
  log(`Outreach #${hf.appNumber}: ${r?.contacts?.length || 0} contacts, gaps=${(r?.gaps || '').slice(0, 60)}`)
}

// ---------- Phase 3: Sync applications.md + dashboard verify ----------
phase('Sync')
const sync = await agent(
  `Sync applications.md PDF cells + verify dashboard. Project root ${ROOT}.

For each appNumber in [${HITS.map(h => h.appNumber).join(', ')}]:
1. Check that the row in data/applications.md exists. The row starts with "| <num> |" (with surrounding pipes — match carefully).
2. The PDF column (7th cell, between Status and Report) currently shows "❌". Replace ONLY that single "❌" with "✅" on that exact row. Use Edit with old_string anchored uniquely to the appNumber prefix to avoid changing other rows.

Then verify the dashboard:
- docker ps --filter name=career-ops-dashboard --format "{{.Status}}"
- For each appNumber: curl -s "http://127.0.0.1:5050/api/pdf-path?report=<reportPath>" — expect a non-null pdfPath.
- curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | map(.appNumber) | map(select(. == ${HITS.map(h => h.appNumber).join(' or . == ')})) | sort'

Report one-paragraph summary: which rows flipped, which PDFs resolve via API, which contacts present. No StructuredOutput.`,
  { label: 'sync-verify', phase: 'Sync' }
)

return {
  resumeCount: resumeResults.filter(Boolean).length,
  outreachResults: outreachResults.map((r, i) => ({
    appNumber: HITS[i].appNumber,
    contacts: r?.contacts?.length || 0,
    gaps: r?.gaps || null,
  })),
  sync,
}
