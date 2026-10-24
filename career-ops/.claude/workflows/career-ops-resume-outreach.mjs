export const meta = {
  name: 'career-ops-resume-outreach',
  description: 'Resume + Outreach for a fixed list of >=4.0 high-fit appNumbers (after a prior scan/eval already wrote reports + applications.md rows). Splits Resume into a no-schema worker to avoid StructuredOutput timeouts.',
  whenToUse: 'After a scan/eval workflow whose Resume stage failed mid-StructuredOutput. Pass args: { today, hits: [{appNumber, slug, score, company, role, url, archetype, jdEmphasizeKeywords, summaryAnchor, reportPath, legitimacy, employerHidden}, ...] }.',
  phases: [
    { title: 'Resume', detail: 'JD-tailored Professional Summary + PDF + report/applications.md PDF cell flip' },
    { title: 'Outreach', detail: 'Real currently-employed LinkedIn HM/Recruiter/Peer (skip when employerHidden=true)' },
    { title: 'Dashboard', detail: 'Verify webapp /api/* reflects new PDFs + contacts' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

// Parse args (harness sometimes serializes to string)
let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = null }
}
if (!_args || !_args.today || !/^\d{4}-\d{2}-\d{2}$/.test(_args.today)) {
  throw new Error('args.today is REQUIRED (YYYY-MM-DD).')
}
if (!_args.hits || !Array.isArray(_args.hits) || !_args.hits.length) {
  throw new Error('args.hits is REQUIRED (non-empty array of high-fit objects).')
}
const TODAY = _args.today
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

// pipeline: Resume (no-schema) -> Outreach (schema)
const results = await pipeline(
  HITS,
  hf => agent(
    `Resume + tracker update for app #${hf.appNumber}. Project root ${ROOT}.

CONTEXT:
  appNumber: ${hf.appNumber}
  slug: ${hf.slug}
  company: ${hf.company}
  role: ${hf.role}
  score: ${hf.score}
  archetype: ${hf.archetype}
  emphasize: ${hf.jdEmphasizeKeywords}
  summaryAnchor (truthful): ${hf.summaryAnchor}
  reportPath: ${hf.reportPath}
  today: ${TODAY}

MANDATORY READS (read once, in order): cv.md, config/profile.yml, CLAUDE.md (Rule 6 esp.), AGENTS.md ("Resume Accuracy" section).

STEPS (do them sequentially; finish ALL before responding):
1. Craft a JD-tailored Professional Summary (3-5 sentences, ~85-110 words). Per CLAUDE.md Rule 6:
   - Lead with this JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for.
   - Every metric must trace to cv.md (<YOUR_CV_METRICS>).
   - Reframe — never fabricate.
2. Run shell:
     node scripts/build-tailored-cv.mjs ${hf.appNumber} ${hf.slug} "${hf.role.replace(/"/g, '\\"')}" "${hf.archetype}" "${hf.jdEmphasizeKeywords}" "" "<summary text in double-quotes, escape inner quotes with backslash>"
   The 8th positional arg (summaryOverride) REPLACES the default cv.md summary. Pass empty "" for the 6th positional. Verify stdout reports "HTML written".
3. Run shell:
     node generate-pdf.mjs output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-${hf.slug}.html output/${hf.appNumber}-${hf.slug}.pdf
   Verify PDF file exists at output/${hf.appNumber}-${hf.slug}.pdf and is >= 50KB.
4. Edit ${hf.reportPath}: replace the line "**PDF:** ❌" with "**PDF:** ✅ output/${hf.appNumber}-${hf.slug}.pdf"
5. Edit data/applications.md: locate the row starting "| ${hf.appNumber} |" — the PDF column (between Score and Report) currently shows "❌". Replace that single "❌" cell with "✅" on that one row only. Use Edit with old_string anchored to the row's unique appNumber prefix to avoid changing other rows.

Return ONE LINE of plain text in this exact format (no JSON, no tool, just text):
  DONE app=${hf.appNumber} pdf=output/${hf.appNumber}-${hf.slug}.pdf pages=<N or unknown>

If any step fails, return:
  FAIL app=${hf.appNumber} reason=<one short clause>

Do NOT call any StructuredOutput tool. Plain text only.`,
    { label: `resume:${hf.company}`.slice(0, 50), phase: 'Resume' }
  ),
  (resumeText, hf) => agent(
    `Outreach for app #${hf.appNumber} at ${hf.company}. Project root ${ROOT}.

Resume-stage result (verify it ran before doing outreach): ${(resumeText || '').slice(0, 200)}

CONTEXT:
  appNumber: ${hf.appNumber}
  company: ${hf.company}
  role: ${hf.role}
  url: ${hf.url}
  reportPath: ${hf.reportPath}
  legitimacy: ${hf.legitimacy || 'unknown'}
  employerHidden: ${hf.employerHidden ? 'YES (aggregator listing — <TARGET_COMPANY> or similar; real employer not disclosed in JD)' : 'no'}

MANDATORY READS: AGENTS.md "Resume Accuracy & Outreach Sourcing" + "Outreach message rules", modes/contacto.md.

${hf.employerHidden ? `
SPECIAL CASE — employerHidden=true:
- The JD is hosted on an aggregator (<TARGET_COMPANY> etc.); the hiring employer is intentionally undisclosed pre-application.
- Do NOT WebSearch for contacts at "<TARGET_COMPANY>" — they are a middleman, not the employer.
- Skip contact sourcing. Set contacts = [] and gaps = "Aggregator listing (${hf.company}) — actual employer undisclosed in JD. Manual contact research deferred until employer reveal after application."
- Still append a "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} with the gaps note (do not skip the section — the dashboard reads it).
- Still update data/contacts.json with an entry for appNumber ${hf.appNumber} with empty contacts array + the gaps note (preserve all other entries).
- Then call StructuredOutput with {appNumber: ${hf.appNumber}, contacts: [], gaps: "..."}.
` : `
HARD RULES:
- Every contact is a REAL human, real https://www.linkedin.com/in/<handle>/ URL. NO placeholders, NO search-result-URLs as final saves.
- Currently employed at ${hf.company} (LinkedIn snippet shows current role there, not "Former" or another employer).
- 3 contacts max, types: hiring_manager (or direct team manager), recruiter (TA), peer (similar IC on same team).
- Each connectMessage <= 300 chars (LinkedIn connect cap). Verify char count.
- Framework per modes/contacto.md (Hook/Proof/CTA for HM; Fit/Proof/CTA for Recruiter; Interest/Connection/CTA for Peer — NO referral ask).
- One specific stat per message MAX. Person-anchored (reference something only THAT person did).
- Email = <YOUR_EMAIL>. No phone.
- If a type cannot be found via WebSearch, document in 'gaps' field; do NOT save a placeholder.

STEPS:
1. WebSearch (3 queries):
   - "${hf.company}" "machine learning" OR "ML" OR "AI" engineering manager OR director site:linkedin.com/in
   - "${hf.company}" recruiter talent acquisition site:linkedin.com/in
   - "${hf.company}" "machine learning engineer" OR "ML engineer" site:linkedin.com/in
2. Confirm current employment (LinkedIn snippet language).
3. Draft + verify <=300 char messages.
4. MERGE into data/contacts.json (read FULL file, append/replace just this appNumber entry, write FULL file back — do NOT truncate other entries).
5. Append "## Outreach Targets (LinkedIn)" section to ${hf.reportPath} per modes/_profile.md template.
6. Call StructuredOutput with {appNumber: ${hf.appNumber}, contacts: [...], gaps: <string or null>}.
`}`,
    { schema: OUTREACH_SCHEMA, label: `outreach:${hf.company}`.slice(0, 50), phase: 'Outreach' }
  )
)

// ---------- Dashboard ----------
phase('Dashboard')
const dash = await agent(
  `Verify webapp dashboard reflects the new PDFs + contacts. Project root ${ROOT}. Port 5050. Per CLAUDE.md Rule 1: DATA bind-mount, no rebuild needed.

CHECKS:
1. docker ps --filter name=career-ops-dashboard --format "{{.Status}}"
2. curl -s http://127.0.0.1:5050/api/applications | jq 'length' — note total.
3. For each appNumber in [${HITS.map(h => h.appNumber).join(', ')}]:
   - curl -s "http://127.0.0.1:5050/api/pdf-path?appNumber=<num>" — expect a path, NOT 404.
4. curl -s http://127.0.0.1:5050/api/contacts | jq '.applications | map(.appNumber) | sort'

Return one paragraph text summary: docker status, applications count, PDFs that resolved, PDFs that 404'd, contacts entries present. No StructuredOutput.`,
  { label: 'dashboard-verify', phase: 'Dashboard' }
)

return {
  attempted: HITS.length,
  resumeResults: results.map((r, i) => ({ app: HITS[i].appNumber, resume: (Array.isArray(r) ? r[0] : null), outreach: (Array.isArray(r) ? r[1] : null) })),
  dashboard: dash,
}
