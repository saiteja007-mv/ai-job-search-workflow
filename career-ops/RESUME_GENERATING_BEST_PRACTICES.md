# Resume Generating — Best Practices

> A field guide for any agent generating tailored, ATS-optimized resume PDFs in this
> repo. Distilled from 114+ PDFs produced through the career-ops pipeline. Follow this
> and you'll produce resumes that pass ATS parsing, survive a 6-second recruiter scan,
> and never fabricate. Pairs with `modes/pdf.md` (the procedure) and `AGENTS.md`
> (the hard accuracy rules).

---

## 0. The two non-negotiables

Everything below serves two rules. Break either and the output is worthless or harmful:

1. **Truth-grounded.** Every metric, skill, employer, date, and contact field comes from
   `cv.md` + `config/profile.yml`. You may *rephrase* real experience in the JD's
   vocabulary; you may **never** add a skill, number, or claim the candidate doesn't have.
2. **ATS-parseable first, pretty second.** A beautiful resume the ATS can't read is a
   rejection. Single column, standard headers, selectable UTF-8 text, no text trapped in
   images or PDF headers/footers.

---

## 1. Source of truth (read these before generating)

| Field | Comes from | Never source from |
|-------|-----------|-------------------|
| Name, email, phone, LinkedIn, portfolio, location | `config/profile.yml` + `cv.md` | Memory, a prior session, another candidate |
| Work history, metrics, dates | `cv.md` | Invention, "rounding up", the JD's wishlist |
| Proof points / hero metrics | `cv.md`, `article-digest.md` | — |
| Company, role, location, comp, tooling | **the JD itself** | Assumptions ("remote" because the board said so) |

**Re-verify the header against `cv.md`/`profile.yml` every time before rendering.** The
single most embarrassing failure mode observed: using a remembered Gmail instead of the
canonical email in `cv.md`. Diff in your head: header email, phone, links, location — all
match canonical?

---

## 2. The pipeline (what actually happens)

```
cv.md + profile.yml ──┐
JD (text/URL) ────────┼─▶ tailor content ─▶ fill cv-template.html ─▶ generate-pdf.mjs ─▶ output/{NUM}-{slug}.pdf
                      │     (§3, §4)            (placeholders)         (Playwright+ATS)
target role + locale ─┘
```

1. Read `cv.md` (truth) and the JD (target).
2. Extract **15–20 keywords** from the JD (tools, methods, domain terms, soft skills).
3. Detect JD language → CV language (EN default). Detect company location → paper size:
   **US/Canada → `letter`, rest of world → `a4`.**
4. Detect the archetype (Healthcare DA / BI / Analytics Engineer / Data Scientist) → pick
   the framing and which metrics lead.
5. Rewrite the Professional Summary (§3). Reorder experience bullets by JD relevance.
   Build a 6–8 item Core Competencies grid from JD requirements. Inject keywords into
   *existing* achievements (§4).
6. Select the **top 3–4 most relevant** projects (drop the rest — relevance over completeness).
7. Fill `templates/cv-template.html` placeholders → write to `output/_tmp_cv/cv-{candidate}-{company}.html`.
8. Render: `node generate-pdf.mjs <input.html> output/{NUM}-{slug}.pdf --format={letter|a4}`.
9. Update the report header PDF line (§8) and tracker.

---

## 3. The Professional Summary formula

This is the highest-leverage block — it's read first. The proven structure (3–4 lines):

```
[Archetype] with [YOE] of [domain]. At [employer]: [3–5 packed, quantified proofs].
[One sentence that names something specific from THIS JD and asserts the match].
```

**Example shape (a GenAI-platform ML Engineer role), with placeholders:**
> "<TARGET_ROLE> with <N> yrs shipping <YOUR_DOMAIN> systems end to end.
> At <CURRENT_EMPLOYER>: <PROOF_1 with real metric>, <PROOF_2 with real metric>,
> and <PROOF_3 with real metric>. **Direct match for
> {Company}'s production LLM/RAG platform serving real-time inference at scale.**"

Why it works: archetype + YOE in the first 6 words; a dense run of *real* metrics; and a
closing sentence that quotes the JD's own specifics (production LLM/RAG, real-time inference)
to make the match undeniable. The bolded line is regenerated per JD — never reused verbatim.

---

## 4. Keyword injection — ethical, evidence-based

Mirror the JD's exact vocabulary onto experience the candidate **actually has**. Legitimate
rephrasings:

| JD says | CV originally said | Rewrite to |
|---------|-------------------|-----------|
| "LLM / RAG in production" | "RAG + transformer NLP pipelines" | "production RAG pipelines with transformer NLP (vector search, semantic retrieval)" |
| "model serving / low latency" | "<N> ms edge inference" | "low-latency model serving: <N> ms multi-modal inference on edge" |
| "MLOps / monitoring" | "MLOps on AWS + Kubernetes" | "MLOps: CI/CD, drift detection, and model versioning on AWS + Kubernetes" |

**The line you do not cross:** if the candidate has never touched a tool, it does not go on
the resume — not in Skills, not in a bullet, not in the competency grid. Reword real work;
never manufacture new work.

Keyword **distribution** (so the ATS scores it and a human still reads naturally):
Summary (top ~5 terms) · the first bullet of each role · the Core Competencies grid · the
Skills section. Don't keyword-stuff — one natural placement beats five forced ones.

---

## 5. Section order (optimized for the 6-second scan)

1. **Header** — name (large), gradient rule, contact row, portfolio link
2. **Professional Summary** — keyword-dense, JD-anchored
3. **Core Competencies** — 6–8 JD-matched tags in a flex grid
4. **Work Experience** — reverse-chronological, bullets reordered by JD relevance
5. **Projects** — top 3–4 most relevant only
6. **Education & Certifications**
7. **Skills** — technical + languages

Use only standard headers ("Professional Summary", "Work Experience", "Education",
"Skills", "Certifications", "Projects") — ATS keys off these exact strings.

---

## 6. Technical generation — `generate-pdf.mjs`

HTML → PDF via headless Chromium (Playwright). Key behaviors you rely on:

- **ATS text normalization runs automatically** on body text (not CSS/URLs/attributes).
  Don't fight it — write em-dashes and curly quotes naturally; the script converts:
  | From | To | Why |
  |------|----|-----|
  | em-dash `—`, en-dash `–` | `-` | legacy parsers choke |
  | smart quotes `" " ' '` | `" '` | mojibake in plain-text extraction |
  | ellipsis `…` | `...` | parser safety |
  | zero-width chars, BOM | removed | invisible tokens break keyword matching |
  | non-breaking space ` ` | normal space | word-boundary breakage |
  It logs a per-run breakdown (`em-dash=3, nbsp=1, …`).
- **Fonts are self-hosted** in `fonts/` and injected as absolute `file://` URLs at render
  time — never rely on Google Fonts CDN (offline-safe, deterministic).
- **Margins:** `0.6in` all sides. **`printBackground: true`** (keeps the gradient rule and
  competency-tag backgrounds). **Format:** `letter` (US/CA) or `a4`.
- It prints page count and KB on success. Use the page count to enforce length (§9).

Invocation:
```bash
node generate-pdf.mjs output/_tmp_cv/cv-<candidate>-<company>.html output/<NUM>-<slug>.pdf --format=letter
```

---

## 7. Design system (from `templates/cv-template.html`)

- **Fonts:** Space Grotesk (headings, 600–700) + DM Sans (body, 400–500).
- **Header:** name in Space Grotesk ~24px bold; 2px gradient rule
  `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))`; contact row beneath.
- **Section headers:** Space Grotesk ~13px, uppercase, letter-spacing 0.05em, cyan.
- **Body:** DM Sans ~11px, line-height ~1.5–1.7.
- **Company names:** accent purple `hsl(270,70%,45%)`. **Competency tags:** cyan-tinted pills.
- **Background:** pure white. Single column, no sidebars.

The color/gradient is decorative only — all information is live text, so ATS still reads
everything.

---

## 8. File & report wiring conventions

- Tailored HTML → `output/_tmp_cv/cv-{candidate}-{company}.html` (candidate = profile name,
  kebab-cased lowercase).
- Final PDF → `output/{NUM}-{slug}.pdf` (NUM = tracker number).
- **Report header MUST embed the path literally**, because the dashboard regex-extracts it
  from the first 30 lines:
  ```
  **PDF:** ✅ output/{NUM}-{slug}.pdf      ← generated
  **PDF:** ❌                              ← skipped (below threshold)
  ```
  A bare `✅` with no path breaks the dashboard's "View PDF" button. After
  `generate-pdf.mjs` succeeds, replace the placeholder `❌` with `✅ output/{NUM}-{slug}.pdf`.
- **When to generate at all:** only at/above the score threshold (currently **≥ 4.5/5** for
  the scheduled runner; **≥ 4.0** for interactive — check the profile). Below threshold,
  write the report and tracker row but skip the PDF. Quality over volume.

---

## 9. Length discipline (target: 2 pages, ideally tight)

If `generate-pdf.mjs` reports 3+ pages, trim — don't shrink the font into illegibility:
- Cut the weakest project (keep 3, not 4).
- Collapse the oldest role to its 2–3 strongest bullets.
- Merge redundant skills into the competency grid.
- Tighten the summary to 3 lines.

A known unresolved case (Seed #349) sat at 2 pages when 1 was wanted — length is a real
review axis, not an afterthought.

---

## 10. Pre-ship QA checklist

- [ ] Header email/phone/LinkedIn/portfolio/location match `cv.md` + `profile.yml` exactly.
- [ ] Every metric traces to `cv.md`/`article-digest.md` (none invented).
- [ ] Company, role, and location pulled from the JD (not assumed — verify remote/hybrid/onsite).
- [ ] Summary's closing line names something specific from *this* JD.
- [ ] Competency grid = JD terms the candidate genuinely has.
- [ ] Standard section headers present; single column; no info in PDF header/footer.
- [ ] Correct paper size (letter for US/CA).
- [ ] Page count ≤ 2.
- [ ] Report header PDF line carries the literal path.

---

## 11. Anti-patterns (real failures to avoid)

- **Wrong contact from memory.** Always re-read `cv.md`; never trust a remembered email.
- **Trusting an aggregator's "remote"/posted-date label.** Verify against the source ATS;
  a mislabeled "remote" role was actually onsite-with-relocation.
- **Inventing a metric to satisfy a JD ask.** Mark the gap honestly instead.
- **Reusing a generic summary.** If the same summary could go to any company, the
  JD-anchored closing line is missing — rewrite it.
- **Keyword stuffing / fake competencies.** ATS may pass it; a human screener won't, and
  it's dishonest.

---

## 12. Reproducing this on another agent / CLI

The pipeline is CLI-agnostic (open agent skill standard). Any agent (Claude, Codex, Gemini,
OpenCode, …) reproduces it by: reading `cv.md` + `config/profile.yml` + the JD → tailoring
content per §3–§5 → filling `templates/cv-template.html` → running
`node generate-pdf.mjs`. The Node script does the ATS normalization and rendering
identically regardless of which agent invokes it, so output is deterministic across agents.
The judgment that doesn't transfer automatically — and that this doc exists to teach — is
**§3 (the summary formula), §4 (ethical keyword injection), and §0 (never fabricate).**
