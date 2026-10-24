// Build tailored CV HTML per target role (ATS-optimized)
// Usage:
//   node scripts/build-tailored-cv.mjs <num> <companySlug> <role> <archetype> <emphasize> <jdAnchor> <summaryOverride>
// emphasize: comma-separated keywords to push to top (e.g. "healthcare,claims,sql")
// summaryOverride: full JD-tailored Professional Summary (truthful reframe of cv.md, leads with THIS JD's domain).
//   When provided it REPLACES the default Healthcare summary and jdAnchor is ignored.
//
// Notes:
// - Source of truth for personal info: config/profile.yml (per AGENTS.md)
// - Experience/project bullets come from cv.md (no fabrication)
// - Output HTML is written to /tmp and can be passed to generate-pdf.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Any positional arg ending in `.json` is treated as a per-JD overrides file and
// pulled out of the positional list (so it never gets misread as role/archetype/etc).
// Overrides shape (all keys optional):
//   {
//     "summary":      "full JD-tailored Professional Summary (truthful reframe of cv.md)",
//     "competencies": ["tag1", "tag2", ...],            // replaces Core Competencies (max 8)
//     "experience":   { "<PAST_EMPLOYER>": ["bullet", ...], "<PAST_EMPLOYER>": ["bullet", ...] },  // keyed by company substring
//     "projectOrder": ["E-commerce", "Glassdoor"],      // reorder projects by title prefix
//     "templatePath": "templates/cv-template-classic.html"  // alternate template (default: cv-template.html)
//   }
// Bullets/summary MUST be truthful reframes of cv.md facts — no fabricated metrics.
const rawArgs = process.argv.slice(2);
const overridesPath = rawArgs.find(a => a && a.toLowerCase().endsWith('.json'));
const positional = rawArgs.filter(a => a !== overridesPath);
const [num, companySlug, roleArg, archetypeArg, emphasizeArg, jdAnchorArg, summaryArg] = positional;
if (!num || !companySlug) {
  console.error('usage: node scripts/build-tailored-cv.mjs <num> <companySlug> [role] [archetype] [emphasize] [jdAnchor] [summaryOverride] [overrides.json]');
  process.exit(1);
}

let overrides = {};
if (overridesPath) {
  try {
    overrides = JSON.parse(fs.readFileSync(path.resolve(ROOT, overridesPath), 'utf8'));
  } catch (e) {
    console.error(`Failed to read overrides file "${overridesPath}": ${e.message}`);
    process.exit(1);
  }
}

const role = roleArg || '';
const archetype = archetypeArg || 'Data Analyst';
const emphasize = (emphasizeArg || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// A JD-anchored closing sentence for the Professional Summary (best-practice: always include
// one line that is specific to *this* JD). Pass it in from the evaluator/report.
const jdAnchor = stripMd(jdAnchorArg || '').trim();

// Profile data dir: where the user's cv.md + profile.yml live, plus generated output.
// Defaults to ~/.resume-forge (stable across plugin updates + shared by every project on the
// machine). Override with RESUME_FORGE_DATA (absolute or relative to cwd) to point elsewhere.
// Falls back to <skill>/profile if it has a cv.md (covers the in-folder/dev layout).
const HOME_DATA = path.join(os.homedir(), '.resume-forge');
const LOCAL_DATA = path.join(ROOT, 'profile');
const DATA_DIR = process.env.RESUME_FORGE_DATA
  ? path.resolve(process.env.RESUME_FORGE_DATA)
  : (fs.existsSync(path.join(LOCAL_DATA, 'cv.md')) ? LOCAL_DATA : HOME_DATA);

const PATHS = {
  template: path.join(ROOT, 'templates', 'cv-template.html'),
  cv: path.join(DATA_DIR, 'cv.md'),
  profile: path.join(DATA_DIR, 'profile.yml')
};

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

// Minimal YAML extraction (profile.yml is simple key/value; avoid extra deps)
function yamlGet(yml, keyPath) {
  // keyPath like: candidate.full_name
  const keys = keyPath.split('.');
  const lines = yml.split(/\r?\n/);
  let indentStack = [{ indent: -1, key: null }];
  for (const line of lines) {
    const raw = line;
    const trimmed = raw.replace(/\t/g, '  ');
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

    const m = trimmed.match(/^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;

    const indent = m[1].length;
    const key = m[2];
    let val = m[3];

    // Maintain stack based on indent
    while (indentStack.length && indent <= indentStack[indentStack.length - 1].indent) {
      indentStack.pop();
    }
    const parentPath = indentStack.map(x => x.key).filter(Boolean);
    const currentPath = [...parentPath, key].join('.');

    indentStack.push({ indent, key });

    if (currentPath === keyPath) {
      // Strip quotes
      val = val.replace(/^['\"]/, '').replace(/['\"]$/, '');
      return val;
    }
  }
  return '';
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scoreByKeywords(text) {
  if (!emphasize.length) return 0;
  const lc = (text || '').toLowerCase();
  let s = 0;
  for (const k of emphasize) {
    if (!k) continue;
    if (lc.includes(k)) s += 10;
  }
  return s;
}

function stripMd(s) {
  return (s || '')
    // bold/italic markers
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/\*/g, '')
    // inline code
    .replace(/`/g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCvMd(md) {
  const lines = md.split(/\r?\n/);

  function findHeader(h) {
    const idx = lines.findIndex(l => l.trim() === h);
    return idx;
  }

  function collectSection(startHeader) {
    const start = findHeader(startHeader);
    if (start === -1) return [];
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('## ') && l.trim() !== startHeader) break;
      // Drop divider lines so they never leak into rendered PDF
      if (l.trim() === '---') continue;
      out.push(l);
    }
    return out;
  }

  const summaryLines = collectSection('## Summary');
  const skillsLines = collectSection('## Technical Skills');
  const expLines = collectSection('## Experience');
  const projectsLines = collectSection('## Projects');
  const educationLines = collectSection('## Education');
  const certLines = collectSection('## Certifications');

  // Experience parser: blocks of
  // ### Title | Company | Location
  // **Dates**
  // - bullet
  const experience = [];
  for (let i = 0; i < expLines.length; i++) {
    const l = expLines[i].trim();
    if (l.startsWith('### ')) {
      const header = l.slice(4).trim();
      const parts = header.split('|').map(x => x.trim());
      const title = parts[0] || '';
      const company = parts[1] || '';
      const location = parts[2] || '';
      let dates = '';
      let j = i + 1;
      while (j < expLines.length && !expLines[j].trim()) j++;
      if (j < expLines.length && expLines[j].trim().startsWith('**')) {
        dates = expLines[j].trim().replace(/\*\*/g, '');
        j++;
      }
      while (j < expLines.length && !expLines[j].trim()) j++;
      const bullets = [];
      while (j < expLines.length && expLines[j].trim().startsWith('- ')) {
        bullets.push(expLines[j].trim().slice(2));
        j++;
      }
      const ordered = [...bullets].sort((a,b) => scoreByKeywords(b) - scoreByKeywords(a));
      experience.push({ title, company, location, dates, bullets: ordered });
      i = j - 1;
    }
  }

  // Projects parser: blocks of
  // ### Title | tags
  // - bullet...
  const projects = [];
  for (let i = 0; i < projectsLines.length; i++) {
    const l = projectsLines[i].trim();
    if (l.startsWith('### ')) {
      const title = l.slice(4).trim();
      const bullets = [];
      let j = i + 1;
      while (j < projectsLines.length && projectsLines[j].trim().startsWith('- ')) {
        bullets.push(projectsLines[j].trim().slice(2));
        j++;
      }
      projects.push({ title, bullets });
      i = j - 1;
    }
  }

  return {
    summaryText: summaryLines.map(s => stripMd(s)).filter(Boolean).join(' '),
    skillsLines: skillsLines.map(s => stripMd(s)).filter(Boolean),
    educationLines: educationLines.map(s => stripMd(s)).filter(Boolean),
    certLines: certLines.map(s => stripMd(s)).filter(Boolean),
    experience: experience.map(j => ({
      ...j,
      bullets: (j.bullets || []).map(b => stripMd(b)).filter(Boolean)
    })),
    projects: projects.map(p => ({
      ...p,
      title: stripMd(p.title),
      bullets: (p.bullets || []).map(b => stripMd(b)).filter(Boolean)
    }))
  };
}

function buildCompetencies(archetype) {
  // Keep stable base set but reorder for emphasize
  const base = [
    'Healthcare Claims & Utilization',
    'Prior Authorization Analytics',
    'SQL (CTEs, Window Functions)',
    'Power BI / Tableau Dashboards',
    'KPI Definition & Reporting',
    'Statistical Analysis',
    'Stakeholder Communication',
    'Data Quality (dbt tests)'
  ];

  // Light archetype tweaks (still truthful)
  if ((archetype || '').toLowerCase().includes('analytics engineer')) {
    base.unshift('Data Modeling (dbt, Snowflake)');
  }

  return [...new Set(base)].sort((a,b) => scoreByKeywords(b) - scoreByKeywords(a));
}

// Template selection: overrides.templatePath (relative to ROOT or absolute) lets callers
// pick an alternate template (e.g. templates/cv-template-classic.html). Falls back to the
// default HTML template when unset — fully backward compatible.
const templatePath = overrides.templatePath
  ? path.resolve(ROOT, overrides.templatePath)
  : PATHS.template;
const tpl = readFile(templatePath);
const cvMd = readFile(PATHS.cv);
const profileYml = readFile(PATHS.profile);

const name = yamlGet(profileYml, 'candidate.full_name');
const phone = yamlGet(profileYml, 'candidate.phone');
const email = yamlGet(profileYml, 'candidate.email');
const linkedin = yamlGet(profileYml, 'candidate.linkedin');
const portfolio = yamlGet(profileYml, 'candidate.portfolio_url');
const location = yamlGet(profileYml, 'candidate.location');

const linkedinDisplay = (linkedin || '').replace(/^https?:\/\//,'').replace(/\/$/,'');
const portfolioDisplay = (portfolio || '').replace(/^https?:\/\//,'').replace(/\/$/,'');

const cv = parseCvMd(cvMd);

// Apply per-JD experience-bullet overrides (truthful reframes of cv.md bullets).
// Keyed by a substring of the company name (e.g. "<PAST_EMPLOYER>", "<PAST_EMPLOYER>").
if (overrides.experience && typeof overrides.experience === 'object') {
  for (const job of cv.experience) {
    for (const [key, bullets] of Object.entries(overrides.experience)) {
      if (Array.isArray(bullets) && bullets.length &&
          (job.company || '').toLowerCase().includes(key.toLowerCase())) {
        job.bullets = bullets.map(b => stripMd(b)).filter(Boolean);
        break;
      }
    }
  }
}

// Reorder projects to surface the JD-relevant one first (by title prefix match).
if (Array.isArray(overrides.projectOrder) && overrides.projectOrder.length) {
  const wanted = overrides.projectOrder.map(t => (t || '').toLowerCase());
  const rank = title => {
    const lc = (title || '').toLowerCase();
    const i = wanted.findIndex(w => w && lc.startsWith(w));
    return i === -1 ? 99 : i;
  };
  cv.projects.sort((a, b) => rank(a.title) - rank(b.title));
}

// Summary precedence:
//  1. summaryOverride (full JD-tailored summary passed by evaluator) — used as-is, self-contained.
//     Must be truthful: reframes cv.md facts to lead with THIS JD's domain/archetype, no fabricated metrics.
//  2. cv.md summary (default Healthcare framing) + optional jdAnchor closing line.
// Do not fabricate new claims in either path.
const summaryOverride = stripMd(overrides.summary || summaryArg || '').trim();
let summary;
if (summaryOverride) {
  summary = summaryOverride.replace(/\s+/g, ' ').trim();
} else {
  summary = cv.summaryText || 'Data Analyst with 3+ years turning data into decisions using SQL, Python, and BI.';
  if (jdAnchor) {
    const closing = jdAnchor.endsWith('.') ? jdAnchor : `${jdAnchor}.`;
    summary = `${summary} ${closing}`.replace(/\s+/g, ' ').trim();
  }
}

const comps = (Array.isArray(overrides.competencies) && overrides.competencies.length)
  ? overrides.competencies.map(c => stripMd(c)).filter(Boolean)
  : buildCompetencies(archetype);
const competenciesHtml = comps
  .slice(0, 8)
  .map(c => `<span class="competency-tag">${escapeHtml(c)}</span>`)
  .join('\n');

function jobHtml(job) {
  const bullets = (job.bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join('\n');
  return `
<div class="job">
  <div class="job-header">
    <div class="job-company">${escapeHtml(job.company)}</div>
    <div class="job-period">${escapeHtml(job.dates)}</div>
  </div>
  <div class="job-role">${escapeHtml(job.title)} <span class="job-location">| ${escapeHtml(job.location)}</span></div>
  <ul>
    ${bullets}
  </ul>
</div>`;
}
const experienceHtml = cv.experience.map(jobHtml).join('\n');

function projectHtml(p) {
  const bullets = (p.bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join('\n');
  return `
<div class="project">
  <div class="project-title">${escapeHtml(p.title)}</div>
  <ul>
    ${bullets}
  </ul>
</div>`;
}
const projectsHtml = cv.projects.slice(0, 4).map(projectHtml).join('\n');

// Education: first line "Degree | Org | Year", remaining lines = description
function buildEducationHtml(linesArr) {
  if (!linesArr.length) return '';
  const head = linesArr[0].replace(/^[-*]\s+/, '');
  const parts = head.split('|').map(x => x.trim());
  const degree = parts[0] || '';
  const org = parts[1] || '';
  const year = parts[2] || '';
  const desc = linesArr.slice(1).map(s => s.replace(/^[-*]\s+/, '')).join(' ').trim();
  return `
<div class="edu-item">
  <div class="edu-header">
    <div class="edu-title">${escapeHtml(degree)}${org ? `<span class="edu-org"> | ${escapeHtml(org)}</span>` : ''}</div>
    ${year ? `<div class="edu-year">${escapeHtml(year)}</div>` : ''}
  </div>
  ${desc ? `<div class="edu-desc">${escapeHtml(desc)}</div>` : ''}
</div>`;
}

// Certifications: optional "Title | Org | Year" per line, styled grid
function buildCertHtml(arr) {
  return arr.map(c => {
    const parts = c.replace(/^[-*]\s+/, '').split('|').map(x => x.trim());
    return `<div class="cert-item"><span class="cert-title">${escapeHtml(parts[0] || '')}</span><span class="cert-org">${escapeHtml(parts[1] || '')}</span><span class="cert-year">${escapeHtml(parts[2] || '')}</span></div>`;
  }).join('\n');
}

// Skills: "Category: items" → bold category prefix, one row per line
function buildSkillsHtml(arr) {
  return arr.map(s => {
    const t = s.replace(/^[-*]\s+/, '');
    const ci = t.indexOf(':');
    if (ci > -1) {
      const cat = t.slice(0, ci).trim();
      const items = t.slice(ci + 1).trim();
      return `<div class="skill-item"><span class="skill-category">${escapeHtml(cat)}:</span> ${escapeHtml(items)}</div>`;
    }
    return `<div class="skill-item">${escapeHtml(t)}</div>`;
  }).join('\n');
}

const educationHtml = buildEducationHtml(cv.educationLines);
const certHtml = buildCertHtml(cv.certLines);
const skillsHtml = buildSkillsHtml(cv.skillsLines);

const html = tpl
  .replace(/\{\{LANG\}\}/g, 'en')
  .replace(/\{\{PAGE_WIDTH\}\}/g, '8.5in')
  .replace(/\{\{NAME\}\}/g, escapeHtml(name))
  .replace(/\{\{PHONE\}\}/g, escapeHtml(phone))
  .replace(/\{\{EMAIL\}\}/g, escapeHtml(email))
  .replace(/\{\{LINKEDIN_URL\}\}/g, linkedin)
  .replace(/\{\{LINKEDIN_DISPLAY\}\}/g, escapeHtml(linkedinDisplay))
  .replace(/\{\{PORTFOLIO_URL\}\}/g, portfolio)
  .replace(/\{\{PORTFOLIO_DISPLAY\}\}/g, escapeHtml(portfolioDisplay))
  .replace(/\{\{LOCATION\}\}/g, escapeHtml(location))
  .replace(/\{\{SECTION_SUMMARY\}\}/g, 'Professional Summary')
  .replace(/\{\{SUMMARY_TEXT\}\}/g, escapeHtml(summary))
  .replace(/\{\{SECTION_COMPETENCIES\}\}/g, 'Core Competencies')
  .replace(/\{\{COMPETENCIES\}\}/g, competenciesHtml)
  .replace(/\{\{SECTION_EXPERIENCE\}\}/g, 'Work Experience')
  .replace(/\{\{EXPERIENCE\}\}/g, experienceHtml)
  .replace(/\{\{SECTION_PROJECTS\}\}/g, 'Projects')
  .replace(/\{\{PROJECTS\}\}/g, projectsHtml)
  .replace(/\{\{SECTION_EDUCATION\}\}/g, 'Education')
  .replace(/\{\{EDUCATION\}\}/g, educationHtml)
  .replace(/\{\{SECTION_CERTIFICATIONS\}\}/g, 'Certifications')
  .replace(/\{\{CERTIFICATIONS\}\}/g, certHtml)
  .replace(/\{\{SECTION_SKILLS\}\}/g, 'Skills')
  .replace(/\{\{SKILLS\}\}/g, skillsHtml);

function kebab(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const candidateSlug = kebab(name);
// Write temp HTML under the data dir (writable + stable), not the plugin dir.
const tmpDir = path.join(DATA_DIR, '_tmp_cv');
fs.mkdirSync(tmpDir, { recursive: true });

// Convention: output/_tmp_cv/cv-{candidate}-{company}.html
const outPath = path.join(tmpDir, `cv-${candidateSlug}-${companySlug}.html`);
fs.writeFileSync(outPath, html);
console.log(outPath);
