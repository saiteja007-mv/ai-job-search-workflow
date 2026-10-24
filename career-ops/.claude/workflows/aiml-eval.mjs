export const meta = {
  name: 'aiml-eval',
  description: 'Evaluate AI/ML job candidates (A-G) from the master pool, throttled fan-out, structured scores',
  phases: [{ title: 'Evaluate', detail: 'one agent per candidate, waves of 4 to respect web-search rate limits' }],
}

// args: array of { idx, n, company, role }
const items = (typeof args === 'string' ? JSON.parse(args) : args) || []

const EVAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['idx', 'appNumber', 'company', 'role', 'score', 'legitimacy', 'recommendation', 'report_path', 'tsv_path', 'summary'],
  properties: {
    idx: { type: 'integer' },
    appNumber: { type: 'integer' },
    company: { type: 'string' },
    role: { type: 'string' },
    url: { type: ['string', 'null'] },
    archetype: { type: 'string' },
    score: { type: 'number', description: 'global 1-5 score, one decimal' },
    legitimacy: { type: 'string', enum: ['High Confidence', 'Proceed with Caution', 'Suspicious'] },
    recommendation: { type: 'string', enum: ['APPLY', 'MAYBE', 'SKIP'] },
    posted_date: { type: ['string', 'null'] },
    sponsorship_note: { type: 'string', description: '<YOUR_WORK_AUTH_STATUS>/H1B sponsorship assessment for this employer' },
    report_path: { type: 'string' },
    tsv_path: { type: 'string' },
    summary: { type: 'string', description: 'one-line verdict' },
  },
}

function prompt(it) {
  return `You are a career-ops evaluation agent. Evaluate ONE job candidate and produce a full A-G report.

# Candidate
- Master index: ${it.idx}
- Company: ${it.company}
- Role: ${it.role}
- Pre-assigned report/app number: ${it.n}

# Step 1 — Load context (read these files)
- modes/_shared.md   (scoring system, archetypes, global rules, writing rules)
- modes/_profile.md   (THE USER's targets, hard-rejects, sponsorship policy, comp targets, location policy, freshness, scoring overrides)
- modes/oferta.md     (the A-G report format + report header + tracker TSV contract)
- cv.md               (candidate resume — cite exact lines in Block B; never invent metrics)
- batch/_candidates_master.json  → candidates[${it.idx}]  (this is YOUR candidate)

# Step 2 — Use the PRE-FETCHED JD body
candidates[${it.idx}].description is the REAL job description body (markdown), fetched at scan time.
- USE IT as the JD. Do NOT re-fetch the URL (LinkedIn/Indeed/ZR gate JD pages behind login walls / 403 and you will get garbage or a fabrication risk).
- If description is null/empty (rare), say so and base the eval only on title+company, and cap legitimacy at "Proceed with Caution".

# Step 3 — Evaluate A-G per modes/oferta.md
Produce all blocks A through G. Key user-specific rules from _profile.md you MUST apply:
- HARD-REJECT seniority: Senior/Sr/Staff/Lead/Principal/III/IV/Manager/Director/Head/VP. If the JD is actually senior despite the title, score it low and recommend SKIP.
- USA-only. All US work modes (remote/hybrid/onsite/relocate) score location 5.0 — do NOT penalize onsite or relocation.
- Comp target <TARGET_COMP_RANGE> (floor $110K). Use WebSearch for Block D comp (Levels.fyi/Glassdoor/Blind) — 2-3 queries MAX.
- Block G legitimacy: 1-2 WebSearch queries MAX for layoffs/hiring-freeze. Keep total WebSearch ≤ 4 for this whole eval.
- Sponsorship: candidate is <YOUR_WORK_AUTH_STATUS>. Assess this employer's sponsorship likelihood (big consultancies like TCS/Cognizant/<TARGET_COMPANY> and large enterprises like UnitedHealth/Optum sponsor heavily = positive; tiny startups <20 = negative). Put this in Block G context + the sponsorship_note field. Do NOT hard-reject for it, but weigh it in cultural signals.
- Detect the archetype (Machine Learning Engineer / Applied AI-GenAI / NLP-LLM / MLOps / Data Scientist) and frame Block B/E/F accordingly.

# Step 4 — Write the report file
Compute slug = company lowercased, non-alphanumerics → hyphens, collapsed (e.g. "Tata Consultancy Services (TCS)" → "tata-consultancy-services-tcs").
Write the full A-G report to:  reports/${it.n}-{slug}-2026-06-17.md
Report header MUST be exactly:
\`\`\`
# Evaluation: ${it.company} — ${it.role}

**Date:** 2026-06-17
**URL:** {the candidates[${it.idx}].url, or "recruiter/aggregator — no canonical URL" if it is "nan"/empty}
**Archetype:** {detected}
**Score:** {X.X}/5
**Legitimacy:** {High Confidence | Proceed with Caution | Suspicious}
**PDF:** ❌
\`\`\`
(Leave **PDF:** ❌ — a later phase generates the tailored PDF for >=4.0 roles.)
Then the full ## A) ... ## G) blocks, a "## H) Draft Application Answers" ONLY if score >= 4.5, the "## Cover Letter Draft" section per oferta.md, and "## Keywords extracted" (15-20 ATS keywords).

# Step 5 — Write the tracker-addition TSV (single line, 9 tab-separated columns, status BEFORE score)
Write to:  batch/tracker-additions/${it.n}-{slug}.tsv
Exact format (real tabs, no header):
${it.n}\t2026-06-17\t${it.company}\t${it.role}\tEvaluated\t{X.X}/5\t❌\t[${it.n}](reports/${it.n}-{slug}-2026-06-17.md)\t{one-line note}

# Step 6 — Return the structured object (schema-enforced)
report_path and tsv_path = the exact relative paths you wrote. score = your global 1-5 (one decimal). recommendation = APPLY (>=4.0) / MAYBE (3.5-3.9) / SKIP (<3.5). posted_date = candidates[${it.idx}].postedDate.

Be rigorous and honest. A 4.0+ must be genuinely worth the user's time. Do not inflate.`
}

phase('Evaluate')
const results = []
// Waves of 4 → keep concurrent web-search agents within the safe (<=4-5) band.
for (let i = 0; i < items.length; i += 4) {
  const wave = items.slice(i, i + 4)
  log(`Evaluating wave ${i / 4 + 1}: ${wave.map((w) => `#${w.n} ${w.company}`).join(', ')}`)
  const waveRes = await parallel(
    wave.map((it) => () =>
      agent(prompt(it), { label: `eval:${it.n}-${it.company}`, phase: 'Evaluate', schema: EVAL_SCHEMA })
    )
  )
  results.push(...waveRes)
}

const clean = results.filter(Boolean)
const highFit = clean.filter((r) => r.score >= 4.0)
return {
  evaluated: clean.length,
  highFit: highFit.length,
  results: clean.map((r) => ({
    idx: r.idx, n: r.appNumber, company: r.company, role: r.role,
    score: r.score, legitimacy: r.legitimacy, rec: r.recommendation,
    sponsorship: r.sponsorship_note, posted: r.posted_date,
    report: r.report_path, tsv: r.tsv_path, summary: r.summary,
  })),
}
