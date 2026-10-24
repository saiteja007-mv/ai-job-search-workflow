export const meta = {
  name: 'ship-feed-eval-gaps',
  description: 'Complete the high-fits from the LinkedIn-feed eval run that did NOT get a resume PDF and/or outreach pack. Inputs: hard-coded list from the feed-eval result.',
  whenToUse: 'Use to close the gap when career-ops-feed-eval ships fewer resumes/outreach than highFits due to interrupted Resume/Outreach phase agents.',
  phases: [
    { title: 'Resume',    detail: 'Build PDF for each (appNumber, slug, role, archetype, emphasize, summaryAnchor)' },
    { title: 'Outreach',  detail: 'Source 3 real LinkedIn contacts per missing outreach target' },
    { title: 'Verify',    detail: 'merge-tracker + verify-pipeline + dashboard check' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const SCORE_FLOOR = 4.0

// args.today REQUIRED. args.resumeTargets + args.outreachTargets REQUIRED.
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) {
  throw new Error('args.today REQUIRED (YYYY-MM-DD)')
}
const TODAY = _args.today
const RESUME_TARGETS = _args.resumeTargets || []
const OUTREACH_TARGETS = _args.outreachTargets || []

const RESUME_CONCURRENCY = 3
async function chunked(items, fn, chunkSize = 3) {
  const out = []
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize)
    const batch = await parallel(slice.map(item => () => fn(item)))
    out.push(...batch)
  }
  return out
}

// ---------- Phase 1: Resume ----------
phase('Resume')
log(`Building ${RESUME_TARGETS.length} resume PDFs`)
const resumeResults = RESUME_TARGETS.length
  ? await chunked(RESUME_TARGETS, async (hf) =>
      agent(
        `Generate JD-tailored resume PDF for #${hf.appNumber} ${hf.company}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  archetype: ${hf.archetype || 'Applied AI / GenAI Engineer'}
  emphasize: (extract 4-7 lowercase comma-sep keywords from the JD by reading reports/${hf.appNumber}-*-${TODAY}.md)
  reportPath: reports/${hf.appNumber}-*-${TODAY}.md

MANDATORY READS: cv.md, config/profile.yml, CLAUDE.md (Rule 6, Rule 8), AGENTS.md Resume Accuracy, config/active-template.txt, the report file matching reports/${hf.appNumber}-*-${TODAY}.md.

STEPS:
0. Read config/active-template.txt (will be "html"). Pipeline: scripts/build-tailored-cv.mjs + generate-pdf.mjs.
1. Read reports/${hf.appNumber}-*-${TODAY}.md to extract the JD keywords + the archetype + craft a truthful summaryAnchor (one sentence). Lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps) — never default-stamp a domain the JD doesn't call for. Every metric must trace to cv.md.
2. Determine the kebab slug used in the report filename (it's "<slug>" in reports/${hf.appNumber}-<slug>-${TODAY}.md).
3. Build CV HTML:
     node scripts/build-tailored-cv.mjs ${hf.appNumber} <slug> "${hf.role}" "<archetype>" "<emphasize-csv>" "" "<full 3-5 sentence summary>"
4. Generate PDF:
     node generate-pdf.mjs output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-<slug>.html output/${hf.appNumber}-<slug>.pdf
5. Edit reports/${hf.appNumber}-<slug>-${TODAY}.md: replace "**PDF:** ❌" with "**PDF:** ✅ output/${hf.appNumber}-<slug>.pdf"
6. The TSV is already merged. Find data/applications.md row for ${hf.appNumber} and flip the PDF cell from ❌ to ✅ via Edit.
7. VERIFY: ls output/${hf.appNumber}-*.pdf must exist; grep "**PDF:** ✅" in the report.

Return ONE LINE:
  DONE app=${hf.appNumber} pdf=output/${hf.appNumber}-<slug>.pdf
or
  FAIL app=${hf.appNumber} reason=<short clause>
Plain text only.`,
        { label: `resume:${hf.company}`.slice(0, 50), phase: 'Resume' }
      ),
      RESUME_CONCURRENCY,
    )
  : []
log(`Resume: ${resumeResults.filter(Boolean).length}/${RESUME_TARGETS.length} returned`)

// ---------- Phase 2: Outreach (serial) ----------
phase('Outreach')
const outreachResults = []
for (const hf of OUTREACH_TARGETS) {
  let r = null
  try {
    const text = await agent(
      `Source real, currently-employed LinkedIn outreach contacts for #${hf.appNumber} at ${hf.company}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: reports/${hf.appNumber}-*-${TODAY}.md

MANDATORY READS: AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md, modes/_profile.md "Auto-Outreach".

SERIAL — take time, write data/contacts.json atomically.

HARD RULES:
- Every contact = REAL human, real https://www.linkedin.com/in/<handle>/ URL. No TODO, no placeholder.
- Currently employed at ${hf.company}. NO "Former" or other employer.
- 3 contacts MAX: hiring_manager, recruiter, peer.
- Each connect message <=300 chars per modes/contacto.md framework (HM Hook/Proof/CTA, Recruiter Fit/Proof/CTA, Peer Interest/Connection/CTA-no-job-pitch).
- Email = <YOUR_EMAIL>. No phone.
- Missing role type -> document in gaps, DO NOT save placeholder.

STEPS:
1. WebSearch 3 queries:
   - "${hf.company}" machine learning engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" OR "AI engineer" site:linkedin.com/in
2. Confirm current employment via LinkedIn snippets.
3. Draft + verify <=300-char messages.
4. ATOMIC merge data/contacts.json: Read FULL, remove existing entry with appNumber == ${hf.appNumber}, append new, sort by appNumber, Write FULL back.
5. Append "## Outreach Targets (LinkedIn)" section to the matching report.

RETURN FORMAT — plain text. Do NOT call StructuredOutput.

OUTREACH_JSON_BEGIN
{"appNumber": ${hf.appNumber}, "company": "${hf.company}", "contacts": [{"type": "hiring_manager|recruiter|peer", "name": "<full>", "title": "<title @ company>", "linkedin": "https://www.linkedin.com/in/<handle>/", "currentlyEmployed": true, "connectMessage": "<<=300 chars>", "chars": <number>, "notes": null}], "gaps": "<short string or null>"}
OUTREACH_JSON_END`,
      { label: `outreach:${hf.company}`.slice(0, 50), phase: 'Outreach' }
    )
    if (text && typeof text === 'string') {
      const m = text.match(/OUTREACH_JSON_BEGIN\s*([\s\S]*?)\s*OUTREACH_JSON_END/)
      if (m) {
        try { r = JSON.parse(m[1].trim()) } catch (e) { log(`Outreach #${hf.appNumber}: JSON.parse failed — ${e.message}`) }
      }
    }
  } catch (e) { log(`Outreach #${hf.appNumber}: agent error — ${e.message?.slice(0, 160)}`) }
  if (!r) r = { appNumber: hf.appNumber, company: hf.company, contacts: [], gaps: 'Outreach agent failed.' }
  outreachResults.push(r)
  log(`Outreach #${hf.appNumber}: ${r?.contacts?.length || 0} contacts`)
}

// ---------- Phase 3: Verify ----------
phase('Verify')
const verifyRes = await agent(
  `Project root ${ROOT}. Verify the data layer + dashboard:
1. node verify-pipeline.mjs
2. curl -s http://127.0.0.1:5050/api/applications | jq 'length'
3. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | length'
4. Confirm appNumbers ${RESUME_TARGETS.map(h => h.appNumber).join(', ')} all show PDF=✅ in data/applications.md (grep each row, look for the ✅ in the PDF column).
5. Confirm appNumbers ${OUTREACH_TARGETS.map(h => h.appNumber).join(', ')} both have entries in data/contacts.json.

Return {pipelineErrors: <int>, pipelineWarnings: <int>, applicationsCount: <int>, contactsAppsCount: <int>, pdfFlippedFor: [<appNumbers with PDF=✅>], outreachConfirmedFor: [<appNumbers with contacts.json entry>], summary: "<one line>"}.`,
  {
    schema: {
      type: 'object',
      properties: {
        pipelineErrors: { type: 'number' }, pipelineWarnings: { type: 'number' },
        applicationsCount: { type: ['number', 'null'] }, contactsAppsCount: { type: ['number', 'null'] },
        pdfFlippedFor: { type: 'array', items: { type: 'number' } },
        outreachConfirmedFor: { type: 'array', items: { type: 'number' } },
        summary: { type: 'string' },
      },
      required: ['summary'], additionalProperties: true,
    },
    label: 'verify-gaps',
  }
)

return {
  resumeShipped: resumeResults.filter(Boolean).length,
  resumeRequested: RESUME_TARGETS.length,
  outreachShipped: outreachResults.filter(r => (r.contacts || []).length > 0).length,
  outreachRequested: OUTREACH_TARGETS.length,
  verify: verifyRes,
}
