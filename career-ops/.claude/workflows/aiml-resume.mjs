export const meta = {
  name: 'aiml-resume',
  description: 'Tailor the canonical AI/ML LaTeX resume per JD variant, compile to PDF, flip report+TSV to PDF ✅',
  phases: [{ title: 'Tailor', detail: 'one agent per resume variant' }],
}

const variants = (typeof args === 'string' ? JSON.parse(args) : args) || []

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'tex_path', 'pdf_path', 'compiled', 'roles_updated', 'note'],
  properties: {
    name: { type: 'string' },
    tex_path: { type: 'string' },
    pdf_path: { type: 'string' },
    compiled: { type: 'boolean' },
    roles_updated: { type: 'array', items: { type: 'integer' } },
    note: { type: 'string' },
  },
}

function prompt(v) {
  const rolesList = v.roles.map((r) => `  - #${r.n} ${r.role} → report ${r.report}, tsv ${r.tsv}`).join('\n')
  return `You are a resume-tailoring agent. Produce ONE JD-tailored one-page LaTeX resume and compile it.

# Variant: ${v.name}
Target role(s) this resume serves:
${rolesList}
Lead report (read its Block E "Customization Plan" + "Keywords extracted"): ${v.leadReport}
Emphasis for this variant: ${v.emphasis}
Output .tex: output/${v.name}.tex
Output .pdf: output/${v.name}.pdf

# Step 1 — Read sources
- AI-ML Engineer/<YOUR_NAME>-Teja-<YOUR_NAME>-AI-ML-Engineer.tex  (the CANONICAL one-page resume — your starting point)
- cv.md  (full detail to draw exact bullets/metrics from — NEVER invent; only reorder/reword existing facts)
- ${v.leadReport}  (Block E tells you which sections to change and how; Keywords give ATS terms to mirror)

# Step 2 — Tailor (keep it ONE PAGE, ATS-clean, no fabrication)
Edit a COPY of the canonical .tex:
- **Summary**: rewrite 2-3 sentences to lead with this variant's emphasis (${v.emphasis}). Use only real experience.
- **Technical Skills**: reorder so the JD's most-wanted stack appears first; you may drop a trailing skill to keep one page, but do not add skills the candidate lacks.
- **Experience / Projects bullets**: reorder and lightly reword existing bullets to surface the JD-relevant work first (e.g. recommendation/ranking for ads roles; edge-optimization/quantization for model-optimization roles; multimodal/CV for perception roles; MLOps/feature-platform for platform roles). Keep all metrics exactly as in cv.md.
- Do NOT change name/contact/education. Do NOT exceed one page. No em-dashes (use --), no smart quotes, no buzzwords.
- Mirror 6-10 exact JD keywords from the report's "Keywords extracted" naturally into Summary/Skills/bullets for ATS.

# Step 3 — Write + compile
Write the tailored file to output/${v.name}.tex (use the Write tool).
Compile with Bash: node generate-latex.mjs output/${v.name}.tex output/${v.name}.pdf
If pdflatex errors, read the error, fix the .tex (usually an unescaped %, &, _, or $), and recompile until output/${v.name}.pdf exists. Confirm the PDF file exists.

# Step 4 — Flip report + TSV to PDF ✅ for EACH role this resume serves
For each role listed above, use Edit:
- In its report .md header, replace the line "**PDF:** ❌" with "**PDF:** ✅ output/${v.name}.pdf"
- In its tsv (batch/tracker-additions/{n}-{slug}.tsv), change the 7th tab-column from ❌ to ✅ (keep all other columns identical).

# Step 5 — Return the structured object
compiled = true only if output/${v.name}.pdf actually exists. roles_updated = the app numbers whose report+tsv you flipped. note = one line (e.g. "compiled clean; flipped 437").`
}

phase('Tailor')
const results = []
for (let i = 0; i < variants.length; i += 4) {
  const wave = variants.slice(i, i + 4)
  log(`Tailoring: ${wave.map((v) => v.name).join(', ')}`)
  const r = await parallel(
    wave.map((v) => () => agent(prompt(v), { label: `resume:${v.name}`, phase: 'Tailor', schema: SCHEMA }))
  )
  results.push(...r)
}
const clean = results.filter(Boolean)
return {
  variants: clean.length,
  compiled: clean.filter((r) => r.compiled).length,
  results: clean.map((r) => ({ name: r.name, pdf: r.pdf_path, compiled: r.compiled, roles: r.roles_updated, note: r.note })),
}
