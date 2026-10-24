export const meta = {
  name: 'regen-latex-resumes',
  description: 'Regenerate canonical LaTeX resume PDFs for a manifest of jobs (cv-v2.md slim source + GitHub links + no location), flip tracker/report PDF flags, verify each PDF is served by the dashboard.',
  whenToUse: 'After batch/_regen_manifest.json is written. Rebuilds every listed job to the latest LaTeX template and confirms dashboard accessibility.',
  phases: [
    { title: 'Build',  detail: 'Per-job: read report → build LaTeX → render PDF → flip flags (chunked 3)' },
    { title: 'Verify', detail: 'Confirm each PDF is served by /api/pdf-path + /api/pdf' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'
const DASH = 'http://127.0.0.1:5050'

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
const JOBS = (_args && Array.isArray(_args.jobs)) ? _args.jobs : null
if (!JOBS || !JOBS.length) {
  throw new Error('args.jobs REQUIRED: non-empty array of {num, company, role, report}')
}

const BUILD_CONCURRENCY = 3
async function chunked(items, fn, size = 3) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    const batch = await parallel(slice.map(it => () => fn(it)))
    out.push(...batch)
  }
  return out
}

// ---------- Phase 1: Build ----------
phase('Build')
log(`Regenerating ${JOBS.length} LaTeX resumes (canonical slim format)`)

const results = await chunked(JOBS, async (job) => {
  const { num, company, role, report } = job
  try {
    const text = await agent(
      `Regenerate the canonical LaTeX resume PDF for application #${num} (${company} — ${role}). Project root ${ROOT}.

INPUT:
  appNumber: ${num}
  company: ${company}
  role: ${role}
  reportPath: ${report}    (e.g. reports/${num}-<slug>-<date>.md)

MANDATORY READS: ${report}, cv-v2.md, config/profile.yml, CLAUDE.md (Rule 6: lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for).

The LaTeX builder reads cv-v2.md (the canonical slim source — already has project GitHub links and NO location line). You only supply: num, slug, role, archetype, emphasize keywords, and a tailored summary.

STEPS:
1. Derive the slug DETERMINISTICALLY from the report filename so the output PDF matches existing naming and the dashboard can resolve it:
     slug = report basename, with the leading "<num>-" stripped and the trailing "-YYYY-MM-DD.md" stripped.
     e.g. "<NUM>-<company-slug>-<date>.md" -> slug = "thomson-reuters-machine-learning-engineer"
2. Read ${report}. From it determine:
     - archetype: one of {Machine Learning Engineer, Applied AI / GenAI Engineer, NLP / LLM Engineer, MLOps Engineer, Data Scientist} matching the JD's actual domain (use the report's stated archetype if present).
     - emphasize: 4-7 lowercase comma-separated keywords pulled from the JD's stack + domain (Block A/B of the report).
     - summary: a truthful 3-5 sentence Professional Summary that LEADS with this JD's actual domain/archetype. Every metric must trace to cv-v2.md facts (<YOUR_CV_METRICS>). Reframe, never fabricate. Lead with the JD's actual ML domain (CV, NLP, recsys, GenAI/LLM, MLOps); never default-stamp a domain the JD doesn't call for.
3. Build the LaTeX intermediate (escape $ in the summary as needed for the shell):
     node scripts/build-tailored-cv-latex.mjs ${num} <slug> "${role}" "<archetype>" "<emphasize-csv>" "" "<summary>"
   It prints the emitted .tex path: output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-<slug>.tex
4. Render the PDF:
     node generate-latex.mjs output/_tmp_cv/cv-sai-teja-<YOUR_NAME>-<slug>.tex output/${num}-<slug>.pdf
5. Edit ${report}: set the header "**PDF:**" line to exactly:
     **PDF:** ✅ output/${num}-<slug>.pdf
   (replace whatever currently follows **PDF:** — could be ❌ or an old ✅ path).
6. Edit data/applications.md row for #${num}: ensure the PDF column cell is ✅ (7th pipe-column).
7. VERIFY locally (all must pass; re-do the failed step if not):
     - ls output/${num}-<slug>.pdf  (file exists, non-zero)
     - the .tex compiled without LaTeX errors (generate-latex.mjs prints "compiled": true)
     - grep '**PDF:** ✅' ${report}

Return ONE LINE of plain text (no StructuredOutput):
  DONE app=${num} pdf=output/${num}-<slug>.pdf slug=<slug>
or
  FAIL app=${num} reason=<short clause>`,
      { label: `regen:${company}`.slice(0, 48), phase: 'Build' }
    )
    const line = (text || '').trim().split('\n').filter(Boolean).pop() || ''
    const ok = /^DONE app=/.test(line)
    const slugM = line.match(/slug=([^\s]+)/)
    const pdfM = line.match(/pdf=([^\s]+)/)
    return { num, company, ok, slug: slugM ? slugM[1] : null, pdf: pdfM ? pdfM[1] : null, report, line }
  } catch (e) {
    log(`Build #${num} ${company}: agent error — ${e.message?.slice(0, 140)}`)
    return { num, company, ok: false, slug: null, pdf: null, report, line: `FAIL app=${num} reason=agent-error` }
  }
}, BUILD_CONCURRENCY)

const built = results.filter(r => r && r.ok)
const failed = results.filter(r => r && !r.ok)
log(`Build done: ${built.length}/${JOBS.length} ok, ${failed.length} failed`)

// ---------- Phase 2: Verify dashboard accessibility ----------
phase('Verify')
const verify = await agent(
  `Verify that the dashboard serves the regenerated resume PDFs. Project root ${ROOT}. Dashboard at ${DASH}.

For EACH report path below, run two curls and record the HTTP status + resolved pdfPath:
  A) curl -s "${DASH}/api/pdf-path?report=<urlencoded reportPath>"   -> expect JSON {pdfPath: "output/..."} (NOT null)
  B) curl -s -o /dev/null -w "%{http_code}" "${DASH}/api/pdf?path=<urlencoded pdfPath from A>"  -> expect 200

Report paths (one per built job):
${built.map(b => `  #${b.num} -> ${b.report}`).join('\n')}

Also sanity-check the container is healthy:
  "/c/Program Files/Docker/Docker/resources/bin/docker.exe" --version  (just to confirm reachable; if absent, rely on curl)
  curl -s ${DASH}/api/status   -> {"ok":true,...}

Return JSON: {
  statusOk: <bool>,
  total: <int>,
  served200: <int>,            // count where pdf-path returned non-null AND /api/pdf == 200
  pdfPathNull: [<appNumbers where pdf-path returned null>],
  notServed: [<appNumbers where /api/pdf != 200>],
  summary: "<one line>"
}`,
  {
    schema: {
      type: 'object',
      properties: {
        statusOk: { type: 'boolean' },
        total: { type: 'number' },
        served200: { type: 'number' },
        pdfPathNull: { type: 'array', items: { type: 'number' } },
        notServed: { type: 'array', items: { type: 'number' } },
        summary: { type: 'string' },
      },
      required: ['summary'], additionalProperties: true,
    },
    label: 'verify-dashboard',
  }
)

log(`Verify: ${verify?.summary || 'no summary'}`)

return {
  requested: JOBS.length,
  built: built.length,
  failed: failed.map(f => ({ num: f.num, company: f.company, line: f.line })),
  verify,
}
