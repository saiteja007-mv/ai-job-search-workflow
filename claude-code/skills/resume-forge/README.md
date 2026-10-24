# resume-forge

Paste a **job description** or a **job link** → it scrapes the JD → generates an **ATS-optimized
resume PDF tailored to your profile**. Three templates: `default`, `classic`, `latex`.

This is a **self-contained skill bundle** — drop the whole `resume-forge/` folder into any
agent-skills directory (Claude Code, Codex, Gemini, OpenCode, etc. — it follows the
[open agent skill standard](https://agentskills.io)) and it runs without the rest of any repo.

## What's in the box

```
resume-forge/
├─ SKILL.md                     # the skill the agent reads + follows
├─ README.md                    # this file
├─ package.json                 # deps (playwright) + helper scripts
├─ scripts/
│  ├─ build-resume.mjs          # cv.md + profile.yml + template → tailored HTML
│  ├─ generate-pdf.mjs          # HTML → ATS-clean PDF (Playwright)
│  ├─ generate-latex.mjs        # .tex → PDF (tectonic/pdflatex) + validator
│  └─ fonts/                    # woff2 fonts for the default template
├─ templates/
│  ├─ cv-template.html          # default — modern branded single-column
│  ├─ cv-template-classic.html  # classic — plain black/white, ATS-bulletproof
│  └─ cv-template.tex           # latex — typeset
└─ profile/
   ├─ profile.example.yml       # copy → profile.yml (your contact info)
   └─ cv.example.md             # copy → cv.md (your resume, this exact format)
```

## Install

```bash
cd resume-forge
npm install            # installs playwright + downloads Chromium (postinstall)
# optional, only for the latex template:
#   brew install tectonic    # macOS
#   # or install MiKTeX / TeX Live (gives pdflatex) on Windows/Linux
```

## One-time setup (your profile)

The skill onboards you automatically the first time — just paste your current resume when asked.
Or do it manually:

```bash
cp profile/profile.example.yml profile/profile.yml   # edit: name, email, phone, linkedin, etc.
cp profile/cv.example.md        profile/cv.md         # replace with YOUR resume, keep the headers
```

`profile/cv.md` and `profile/profile.yml` are **private** and git-ignored — never commit or
re-share them. Keep `*.example.*` when sharing the bundle.

> **Point at another project's data instead:** set `RESUME_FORGE_DATA=/path/to/dir` (a dir holding
> `cv.md` + `profile.yml`) and the builder reads from there instead of `profile/`.

## Use

In your agent, invoke the skill and pass a JD or URL:

```
/resume-forge https://boards.greenhouse.io/acme/jobs/123  --template=classic
/resume-forge <paste full job description text>           --template=latex
```

Or run the scripts directly:

```bash
# 1) tailored HTML (summary/keywords supplied via an overrides JSON — see SKILL.md Step 3)
node scripts/build-resume.mjs 0 acme-data-analyst "Data Analyst" "BI / Reporting Analyst" \
  "sql,power bi,dbt" "" "" output/_tmp_cv/overrides-acme.json
# 2) HTML → PDF
node scripts/generate-pdf.mjs output/_tmp_cv/cv-jane-doe-acme-data-analyst.html \
  output/resume-jane-doe-acme.pdf --format=letter
```

For the **classic** template, add `"templatePath": "templates/cv-template-classic.html"` to the
overrides JSON. For **latex**, fill `templates/cv-template.tex` and run
`node scripts/generate-latex.mjs <file.tex> <out.pdf>`.

## Templates

| Template | Look | Best for |
|----------|------|----------|
| `default` | Modern branded single-column (Space Grotesk + DM Sans, subtle accent) | Most apps; modern + ATS-parseable |
| `classic` | Plain black-on-white, Georgia/Arial, no color | Strict ATS, corporate/government portals |
| `latex`   | Typeset LaTeX (compiled) | Polished typeset PDF; needs a LaTeX engine |

## Honesty rule

Every metric, employer, date, and skill on the resume must trace to your `cv.md`. The skill reframes
your real experience to match the JD's vocabulary — it never invents experience you don't have. It
generates a file for **you to review**; it does not submit applications.

## Requirements

- Node ≥ 18
- `playwright` (installed via `npm install`) for HTML→PDF
- A LaTeX engine (`tectonic` or `pdflatex`) — only if you use the `latex` template
