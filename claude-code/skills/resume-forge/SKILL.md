---
name: resume-forge
description: Paste a job description or job link → scrape the full JD → generate an ATS-optimized resume tailored to the user's profile. Choose a template (default | latex | classic). If no profile exists, it onboards from the user's original resume first.
arguments: input # Claude Code specific — the JD text, a job URL, or a template flag
user-invocable: true
argument-hint: "[JD text | job URL] [--template=default|latex|classic]"
license: MIT
---

# resume-forge — JD → tailored ATS resume

Turn any job description (pasted text **or** a job link) into a tailored, ATS-clean resume PDF
built from the user's real profile. This is a **self-contained bundle** — all scripts, templates,
and fonts ship inside this folder; nothing outside it is required.

**Paths — read first.** `$SKILL` = the directory containing this `SKILL.md`. Run every command from
`$SKILL` (or with absolute paths into it). The pieces:
- `$SKILL/scripts/build-resume.mjs` — cv.md + profile.yml + template → tailored HTML
- `$SKILL/scripts/generate-pdf.mjs` — HTML → ATS-clean PDF (Playwright)
- `$SKILL/scripts/generate-latex.mjs` — .tex → PDF (validator + tectonic/pdflatex)
- `$SKILL/templates/` — `cv-template.html` (default), `cv-template-classic.html` (classic), `cv-template.tex` (latex)
- `$SKILL/profile/` — the user's `cv.md` + `profile.yml` (private; created on onboarding). Override the
  data location with the `RESUME_FORGE_DATA` env var (a dir holding `cv.md` + `profile.yml`).
- `$SKILL/output/` — generated PDFs; temp HTML/TeX under `$SKILL/output/_tmp_cv/`.

First run requires `npm install` inside `$SKILL` (installs Playwright + Chromium). See `README.md`.

**Hard rule: never fabricate.** Every metric, employer,
date, and skill on the resume must trace to `cv.md` / `config/profile.yml`. Reframe truthfully to
the JD's vocabulary; never invent experience the user does not have. Stop before any submit —
this skill produces a file for the user to review, it does not apply.

---

## Inputs

`$input` is one of:
- **JD text** — pasted job description (look for "responsibilities", "requirements",
  "qualifications", "about the role", "we're looking for").
- **Job URL** — a link to a posting (Greenhouse, Lever, Ashby, Workday, LinkedIn, Indeed, company
  careers page, etc.). Scrape it (Step 1).
- A **`--template=`** flag may accompany either. If no template is given, ask (Step 4) or default
  to `default`.

If `$input` is empty, ask: *"Paste the job description or the job link, and tell me which template
you want (default / latex / classic)."*

---

## Step 0 — Profile check (onboarding gate)

Before anything else, verify the user's profile exists (in `$SKILL/profile/`, or in
`RESUME_FORGE_DATA` if set). Both are required:
1. `profile/cv.md` — canonical resume source of truth.
2. `profile/profile.yml` with `candidate.full_name` + `candidate.email` set.

**If both exist** → proceed to Step 1.

**If `profile/cv.md` is missing (or `profile/profile.yml` lacks candidate fields)** → onboard first:

> "I don't have your profile yet. Paste your current resume (text is fine), or attach the file,
> and I'll build your profile from it. I only do this once — after that every tailored resume is
> instant."

Then:
- Parse the user's resume into `profile/cv.md` using the **exact format below** (the builder depends
  on it). `profile/cv.example.md` shows the format.
- Populate `profile/profile.yml` `candidate:` block from the resume header
  (`full_name`, `email`, `phone`, `linkedin`, `portfolio_url`, `location`). If `profile/profile.yml`
  is missing, copy `profile/profile.example.yml` first.
- Confirm the parsed name/email/phone back to the user in one line before continuing.

### `cv.md` format (required — the builder parses these exact headers)

```markdown
# {Full Name} — {Headline Title}

## Summary
{2–4 sentence professional summary in plain prose.}

## Technical Skills
- {Category}: {comma-separated items}
- {Category}: {comma-separated items}

## Experience
### {Job Title} | {Company} | {Location}
**{Start} – {End}**
- {Achievement bullet, quantified where the real resume quantifies it}
- {…}

### {Job Title} | {Company} | {Location}
**{Start} – {End}**
- {…}

## Projects
### {Project Title} | {tech tags}
- {bullet}

## Education
- {Degree} | {Institution} | {Year}

## Certifications
- {Cert} | {Issuer} | {Year}
```

Keep bullets verbatim-truthful to the source resume. Do not embellish during onboarding — tailoring
happens per-JD later, always as a truthful reframe.

---

## Step 1 — Get the JD (scrape if a URL)

**If `$input` is JD text** → use it directly. Skip to Step 2.

**If `$input` is a URL** → scrape the live posting (per AGENTS.md *Offer Verification*):
1. Preferred: Playwright — `browser_navigate` to the URL, then `browser_snapshot` to read the
   rendered content. A page with only footer/navbar = closed/expired → tell the user and stop.
2. Fallback (Playwright unavailable / headless): `WebFetch` the URL.
3. As a last resort for aggregator MCPs already connected (Indeed / Dice / ZipRecruiter), use their
   `get_job_details` / `search_jobs` tool to retrieve the description.

Extract and keep: **company, role title, location (city/state/country + remote/hybrid/onsite),
comp band if shown, full JD text, and the tech/tooling stack mentioned.** Pull these from the JD
itself — do not guess (AGENTS.md *Resume Accuracy*). If the posting is dead, report that and stop.

---

## Step 2 — Analyze the JD

1. Extract **15–20 keywords/phrases** (stack + domain + responsibilities), preserving the JD's exact
   wording (e.g. "RAG pipelines", "stakeholder management", "dbt", "revenue analytics").
2. Detect the **archetype/domain** the JD actually buys (e.g. BI / Reporting Analyst, Analytics
   Engineer, Healthcare Data Analyst, Data Scientist, revenue/billing analytics, product/growth
   analytics). **Lead with this — do NOT default to "Healthcare Data Analyst"** unless the JD is
   genuinely a healthcare/claims role (CLAUDE.md Rule 6).
3. Detect **paper format**: US/Canada employer → `letter`; rest of world → `a4`.
4. Detect **language** (default English; switch only if the JD is non-English and the user wants it).

---

## Step 3 — Build the tailored content (truthful reframe)

1. **Professional Summary (3–5 sentences):** lead with the JD's archetype/domain; weave in the top
   JD keywords; every metric traces to `cv.md`. Reframe, never fabricate (e.g. claims data =
   billing/transactional data — a legitimate reframe).
2. **Core Competencies (6–8):** select from `cv.md` skills, worded to match the JD's exact phrasing.
3. **Experience bullets:** reorder by JD relevance and inject the JD's vocabulary into *existing*
   achievements — never add a skill the user lacks. Keep metrics intact.
4. **Projects:** surface the 1–3 most JD-relevant first.

Capture these as an **overrides JSON** for the builder (truthful reframes only):

```json
{
  "summary": "<full JD-tailored Professional Summary>",
  "competencies": ["<JD-phrased competency>", "..."],
  "experience": { "<Company substring>": ["<reframed bullet>", "..."] },
  "projectOrder": ["<Project title prefix>", "..."],
  "templatePath": "<set in Step 5 for default/classic>"
}
```

Write it to `output/_tmp_cv/overrides-{company-slug}.json`.

---

## Step 4 — Choose template

If the user passed `--template=`, use it. Otherwise ask (single question, 3 options):

| Template | What it is | Best for |
|----------|-----------|----------|
| **default** | Modern branded single-column (Space Grotesk + DM Sans, subtle cyan→purple accent). | Most applications; modern, still ATS-parseable. |
| **classic** | Plain black-on-white single-column, Georgia/Arial, no color or chips. | Strict ATS parsers, conservative/corporate portals, government. |
| **latex** | Typeset LaTeX (clean academic/engineering look, compiled via tectonic/pdflatex). | When the user wants a polished typeset PDF and has a LaTeX engine. |

All three are single-column and ATS-safe. Default to **default** if the user has no preference.

---

## Step 5 — Generate the PDF

Let `{slug}` = `{company}-{role}` kebab-case. Pick output name
`output/resume-{candidate}-{slug}-{YYYY-MM-DD}.pdf` (candidate = profile name kebab-cased; the
builder names the HTML automatically).

### default / classic (HTML → PDF)

1. For **classic**, set `"templatePath": "templates/cv-template-classic.html"` in the overrides JSON.
   For **default**, omit `templatePath` (or set `templates/cv-template.html`).
2. Build the HTML (run from `$SKILL`):
   ```bash
   node scripts/build-resume.mjs {num-or-0} {slug} "{role}" "{archetype}" "{csv-keywords}" "" "" output/_tmp_cv/overrides-{slug}.json
   ```
   (positional `num` is unused for ad-hoc runs — pass `0`; summary/competencies come from the
   overrides JSON.) The script prints the HTML path: `output/_tmp_cv/cv-{candidate}-{slug}.html`.
3. Render the PDF:
   ```bash
   node scripts/generate-pdf.mjs output/_tmp_cv/cv-{candidate}-{slug}.html output/resume-{candidate}-{slug}-{YYYY-MM-DD}.pdf --format={letter|a4}
   ```
   ATS Unicode normalization runs automatically inside `generate-pdf.mjs`. Fonts for the default
   template are bundled at `scripts/fonts/` and resolved automatically.

### latex (TeX → PDF)

1. Read `templates/cv-template.tex`. Fill its placeholders from `profile/cv.md` + `profile/profile.yml`:
   `{{NAME}}`, `{{CONTACT_LINE}}`, `{{EMAIL_URL}}`/`{{EMAIL_DISPLAY}}`,
   `{{LINKEDIN_URL}}`/`{{LINKEDIN_DISPLAY}}`, `{{GITHUB_URL}}`/`{{GITHUB_DISPLAY}}`,
   `{{EDUCATION}}`, `{{EXPERIENCE}}`, `{{PROJECTS}}`, `{{SKILLS}}` — using the `\resumeSubheading`,
   `\resumeItem`, and `\resumeProjectHeading` commands the template defines. Apply the SAME
   JD-tailored summary/keywords/reorder from Step 3. **Escape LaTeX specials** (`& % $ # _ { } ~ ^`).
2. Write the filled file to `output/_tmp_cv/cv-{candidate}-{slug}.tex`.
3. Compile + validate:
   ```bash
   node scripts/generate-latex.mjs output/_tmp_cv/cv-{candidate}-{slug}.tex output/resume-{candidate}-{slug}-{YYYY-MM-DD}.pdf
   ```
   The script returns JSON. If `valid:false`, fix the reported missing sections/commands/placeholders
   and re-run. If `compileError` says no engine found, tell the user to install `tectonic`
   (`brew install tectonic`) or pdflatex (MiKTeX/TeX Live), and offer to fall back to the
   **default** HTML template instead.

---

## Step 6 — Report

Output a short summary:
- ✅ PDF path
- Template used + paper format
- Page count
- JD keyword coverage (which of the 15–20 keywords landed in the resume)
- Any honest gaps (JD asks for X the user lacks — surfaced, never faked)

Then stop. **Do not submit the application** — the user reviews and applies (AGENTS.md *Ethical Use*).

---

## Notes

- **Source of truth:** `profile/cv.md` + `profile/profile.yml` (or `RESUME_FORGE_DATA`). Re-read them
  at generation time; never use remembered contact values.
- **Template files:** `templates/cv-template.html` (default), `templates/cv-template-classic.html`
  (classic), `templates/cv-template.tex` (latex). The classic template reuses the same `{{...}}`
  placeholders and CSS class names as default, so the builder drives it via the overrides
  `templatePath` key.
- **Output dir:** `output/` (gitignored). Temp HTML/TeX in `output/_tmp_cv/`.
- **Self-contained:** this bundle has no external repo dependency. It does not write to any tracker —
  it produces a reviewed PDF only.
