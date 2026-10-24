export const meta = {
  name: 'aiml-eval-url',
  description: 'Evaluate AI/ML candidates by fetching the LIVE JD from public ATS URLs (Greenhouse/Ashby/Lever), liveness-gate, A-G score',
  phases: [{ title: 'Evaluate', detail: 'fetch live JD + score, waves of 4 to respect fetch/search rate limits' }],
}

// args: array of { idx, n, company, role, url }
const items = (typeof args === 'string' ? JSON.parse(args) : args) || []

const EVAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['n', 'company', 'role', 'score', 'liveness', 'legitimacy', 'recommendation', 'status', 'summary'],
  properties: {
    n: { type: 'integer' },
    company: { type: 'string' },
    role: { type: 'string' },
    url: { type: ['string', 'null'] },
    archetype: { type: 'string' },
    score: { type: 'number', description: 'global 1-5; 0 if dead/closed posting' },
    liveness: { type: 'string', enum: ['active', 'closed', 'unreachable'] },
    legitimacy: { type: 'string', enum: ['High Confidence', 'Proceed with Caution', 'Suspicious', 'N/A'] },
    recommendation: { type: 'string', enum: ['APPLY', 'MAYBE', 'SKIP'] },
    status: { type: 'string', enum: ['evaluated', 'skipped'], description: 'evaluated if live+scored; skipped if dead/closed' },
    posted_date: { type: ['string', 'null'] },
    sponsorship_note: { type: 'string' },
    report_path: { type: ['string', 'null'] },
    tsv_path: { type: ['string', 'null'] },
    summary: { type: 'string' },
  },
}

function prompt(it) {
  return `You are a career-ops evaluation agent. Evaluate ONE AI/ML job by fetching its LIVE description, then produce a full A-G report.

# Candidate
- Company: ${it.company}
- Role: ${it.role}
- URL: ${it.url}
- Pre-assigned report/app number: ${it.n}

# Step 0 — LIVENESS GATE (do this FIRST)
WebFetch the URL and read the page. These are PUBLIC ATS boards (Greenhouse/Ashby/Lever/company careers) — NOT login-gated, so WebFetch returns the real JD.
- If the URL is a Greenhouse careers link with a gh_jid and WebFetch is thin/blocked, retry via the public API: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{gh_jid} (infer board_token from the company, e.g. doordashusa, gitlab, robinhood) — this returns clean JSON with title/content/location/updated_at.
- Classify liveness:
  - "active": a real job title + description + apply path is present.
  - "closed": 404/410, "no longer accepting applications", redirect to a generic careers/search page, or only nav/footer with no JD.
  - "unreachable": fetch failed after a retry.
- If NOT active: STOP. Do NOT write a report. Return {n, company, role, url, score: 0, liveness: "closed"|"unreachable", legitimacy: "N/A", recommendation: "SKIP", status: "skipped", report_path: null, tsv_path: null, summary: "<why>"}. Also append a one-line note to data/pipeline.md is NOT needed — just return.

# Step 1 — Load context (read these files)
- modes/_shared.md, modes/_profile.md, modes/oferta.md, cv.md

# Step 2 — Evaluate A-G per modes/oferta.md, applying the USER's rules from _profile.md:
- HARD-REJECT seniority: Senior/Sr/Staff/Lead/Principal/III/IV/Manager/Director/Head/VP. If the live JD reveals senior scope (e.g. 6+ yrs, "lead the team", "mentor") despite the title, score low + SKIP. "Engineer II" / "II" / mid-level is ELIGIBLE.
- USA-only. If the role is non-US (e.g. London/France/Remote-EU/Canada/India), score location very low and SKIP (note it). All US modes (remote/hybrid/onsite/relocate) = location 5.0.
- Comp target <TARGET_COMP_RANGE> (floor $110K). Big-tech/AI-first comp above $150K is a POSITIVE (top-quartile), not a negative. Use WebSearch (Levels.fyi/Glassdoor) — 2-3 queries MAX.
- Sponsorship: candidate is <YOUR_WORK_AUTH_STATUS>. Assess this employer (most of these — Pinterest, Affirm, DoorDash, Stripe, Robinhood, <TARGET_COMPANY>, Airbnb, Waymo, OpenAI, Spotify, <TARGET_COMPANY> — are large AI-first H1B sponsors = positive). Put in Block G + sponsorship_note.
- Detect archetype (MLE / Applied AI-GenAI / NLP-LLM / MLOps / Data Scientist), frame B/E/F.
- Block G legitimacy: use the fetched page freshness + 1-2 WebSearch for layoffs. Keep TOTAL web calls (fetch+search) <= 5.

# Step 3 — Write the report (only if active)
slug = company lowercased, non-alphanumerics → hyphens, collapsed.
Write to: reports/${it.n}-{slug}-2026-06-17.md
Header EXACTLY:
\`\`\`
# Evaluation: ${it.company} — ${it.role}

**Date:** 2026-06-17
**URL:** ${it.url}
**Archetype:** {detected}
**Score:** {X.X}/5
**Legitimacy:** {High Confidence | Proceed with Caution | Suspicious}
**PDF:** ❌
\`\`\`
Then full ## A)–## G) blocks, "## H) Draft Application Answers" only if score >= 4.5, "## Cover Letter Draft" per oferta.md, "## Keywords extracted" (15-20).

# Step 4 — Write the tracker TSV (single line, 9 tab-separated cols, status BEFORE score)
Write to: batch/tracker-additions/${it.n}-{slug}.tsv
${it.n}\t2026-06-17\t${it.company}\t${it.role}\tEvaluated\t{X.X}/5\t❌\t[${it.n}](reports/${it.n}-{slug}-2026-06-17.md)\t{one-line note}

# Step 5 — Return the structured object
report_path/tsv_path = exact paths written (or null if skipped). score one decimal. recommendation APPLY(>=4.0)/MAYBE(3.5-3.9)/SKIP(<3.5). status "evaluated" if you wrote a report, else "skipped". posted_date from the JD if present else null.

Be rigorous and honest — a 4.0+ must be a genuine entry/mid IC role the candidate can win and that sponsors. Do not inflate; do not reject a legitimately mid-level "Engineer II" just because it is at a famous company.`
}

phase('Evaluate')
const results = []
for (let i = 0; i < items.length; i += 4) {
  const wave = items.slice(i, i + 4)
  log(`Wave ${i / 4 + 1}: ${wave.map((w) => `#${w.n} ${w.company} ${w.role.slice(0, 28)}`).join(' | ')}`)
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
  evaluated: clean.filter((r) => r.status === 'evaluated').length,
  skipped: clean.filter((r) => r.status === 'skipped').length,
  highFit: highFit.length,
  highFitList: highFit.map((r) => `#${r.n} ${r.company} ${r.role} = ${r.score}`),
  results: clean.map((r) => ({
    n: r.n, company: r.company, role: r.role, score: r.score,
    liveness: r.liveness, legitimacy: r.legitimacy, rec: r.recommendation, status: r.status,
    posted: r.posted_date, sponsorship: r.sponsorship_note,
    report: r.report_path, tsv: r.tsv_path, summary: r.summary,
  })),
}
