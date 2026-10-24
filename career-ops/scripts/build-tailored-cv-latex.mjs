// build-tailored-cv-latex.mjs -- One-page ATS LaTeX CV per target role.
// Mirrors build-tailored-cv.mjs's interface so the template toggle is seamless.
// Usage:
//   node scripts/build-tailored-cv-latex.mjs <num> <companySlug> <role> <archetype> <emphasize> <jdAnchor> <summaryOverride> [overrides.json]
//   - emphasize: comma-separated keywords to push relevant bullets to the top
//   - summaryOverride: full JD-tailored Professional Summary (truthful reframe of cv.md). REPLACES default cv.md summary.
//   - overrides.json (any .json positional arg): { summary, competencies, experience:{<companySubstr>:[...]}, projectOrder:[...] }
// Source of truth: config/profile.yml (contact) + cv.md (bullets) -- no fabrication.
// Output: writes a filled .tex to output/_tmp_cv/ and prints its path. Compile with generate-latex.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rawArgs = process.argv.slice(2);
// LaTeX has a single canonical format (cv-v2.md slim source + cv-template.tex with Summary slot).
// --v2 flag is accepted for backward compatibility but is a no-op.
const overridesPath = rawArgs.find(a => a && a.toLowerCase().endsWith('.json'));
const positional = rawArgs.filter(a => a !== overridesPath && a !== '--v2');

// CV_SOURCE / CV_TEMPLATE env overrides let alternate resume archetypes (e.g. an
// AI/ML Engineer resume with no Work Experience section) reuse this builder without
// touching the default Data-Analyst path. Defaults are unchanged.
const PATHS = {
  template: path.join(ROOT, 'templates', process.env.CV_TEMPLATE || 'cv-template.tex'),
  cv:       path.join(ROOT, process.env.CV_SOURCE || 'cv-v2.md'),
  profile:  path.join(ROOT, 'config', 'profile.yml'),
  outDir:   path.join(ROOT, 'output', '_tmp_cv'),
};

const [num, companySlug, , archetypeArg, emphasizeArg, , summaryArg] = positional;
if (!num || !companySlug) {
  console.error('usage: node scripts/build-tailored-cv-latex.mjs <num> <companySlug> [role] [archetype] [emphasize] [jdAnchor] [summaryOverride] [overrides.json]');
  process.exit(1);
}
let overrides = {};
if (overridesPath) overrides = JSON.parse(fs.readFileSync(path.resolve(ROOT, overridesPath), 'utf8'));

const archetype = archetypeArg || 'Data Analyst';
const emphasize = (emphasizeArg || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const read = p => fs.readFileSync(p, 'utf8');

// LaTeX escaping. Order matters: backslash first, then specials, then unicode punctuation.
function tex(s) {
  return (s || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/</g, '\\textless{}')   // raw < renders as inverted ! in default LaTeX font
    .replace(/>/g, '\\textgreater{}')
    .replace(/[–—]/g, '--')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}
function stripMd(s) {
  return (s || '').replace(/\*\*/g, '').replace(/__/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}
function scoreByKeywords(t) {
  if (!emphasize.length) return 0;
  const lc = (t || '').toLowerCase();
  return emphasize.reduce((s, k) => s + (lc.includes(k) ? 10 : 0), 0);
}

function yamlGet(yml, keyPath) {
  const lines = yml.split(/\r?\n/);
  let stack = [{ indent: -1, key: null }];
  for (const raw of lines) {
    const t = raw.replace(/\t/g, '  ');
    if (!t.trim() || t.trim().startsWith('#')) continue;
    const m = t.match(/^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    const indent = m[1].length, key = m[2];
    let val = m[3];
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const cur = [...stack.map(x => x.key).filter(Boolean), key].join('.');
    stack.push({ indent, key });
    if (cur === keyPath) return val.replace(/^['"]/, '').replace(/['"]$/, '');
  }
  return '';
}

function parseCv(md) {
  const lines = md.split(/\r?\n/);
  const find = h => lines.findIndex(l => l.trim() === h);
  const collect = h => {
    const s = find(h); if (s === -1) return [];
    const out = [];
    for (let i = s + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('## ') && l.trim() !== h) break;
      if (l.trim() === '---') continue;
      out.push(l);
    }
    return out;
  };
  const expLines = collect('## Experience');
  const projLines = collect('## Projects');
  const experience = [];
  for (let i = 0; i < expLines.length; i++) {
    const l = expLines[i].trim();
    if (l.startsWith('### ')) {
      const [title = '', company = '', location = ''] = l.slice(4).split('|').map(x => x.trim());
      let j = i + 1, dates = '';
      while (j < expLines.length && !expLines[j].trim()) j++;
      if (j < expLines.length && expLines[j].trim().startsWith('**')) { dates = expLines[j].trim().replace(/\*\*/g, ''); j++; }
      while (j < expLines.length && !expLines[j].trim()) j++;
      const bullets = [];
      while (j < expLines.length && expLines[j].trim().startsWith('- ')) { bullets.push(stripMd(expLines[j].trim().slice(2))); j++; }
      experience.push({ title, company, location, dates, bullets });
      i = j - 1;
    }
  }
  const projects = [];
  for (let i = 0; i < projLines.length; i++) {
    const l = projLines[i].trim();
    if (l.startsWith('### ')) {
      // ### Title | Tech [| github-url]
      const headLine = l.slice(4).trim();
      const parts = headLine.split('|').map(s => s.trim());
      let github = '';
      if (parts.length >= 2 && /^https?:\/\//i.test(parts[parts.length - 1])) {
        github = parts.pop();
      }
      const title = parts.join(' | ');
      const bullets = []; let j = i + 1;
      while (j < projLines.length && projLines[j].trim().startsWith('- ')) { bullets.push(stripMd(projLines[j].trim().slice(2))); j++; }
      projects.push({ title, github, bullets }); i = j - 1;
    }
  }
  return {
    summaryText: collect('## Summary').map(stripMd).filter(Boolean).join(' '),
    skillsLines: collect('## Technical Skills').map(stripMd).filter(Boolean),
    educationLines: collect('## Education').map(stripMd).filter(Boolean),
    experience, projects,
  };
}

const cv = parseCv(read(PATHS.cv));
const yml = read(PATHS.profile);

const name = yamlGet(yml, 'candidate.full_name') || '<YOUR_NAME>';
const phone = yamlGet(yml, 'candidate.phone');
const loc = yamlGet(yml, 'candidate.location');
const emailRaw = overrides.email || yamlGet(yml, 'candidate.email');
const linkedin = yamlGet(yml, 'candidate.linkedin');
const github = yamlGet(yml, 'candidate.github');
const portfolio = yamlGet(yml, 'candidate.portfolio_url');
const disp = u => (u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

const summary = tex(stripMd(overrides.summary || summaryArg || cv.summaryText));

const education = (() => {
  const L = cv.educationLines;
  // Degree lines have the format `Degree | School | Date` (contain "|") AND mention a degree keyword.
  // Coursework lines start with "- **Relevant coursework:**" and have no "|" — excluded automatically.
  const isDeg = x => x.includes('|') && /master|bachelor|b\.?\s*tech|\bm\.?\s*s\b|\bb\.?\s*s\b/i.test(x);
  const degLines = L.filter(isDeg);
  if (!degLines.length) degLines.push(L[0] || '');
  // Walk forward from each degree line; attach the next coursework line to it (if any) before the following degree.
  const courseFor = (degLine) => {
    const idx = L.indexOf(degLine);
    for (let j = idx + 1; j < L.length; j++) {
      if (isDeg(L[j])) break;
      if (/coursework/i.test(L[j])) return L[j].replace(/^[-]\s*/, '');
    }
    return '';
  };
  return degLines.map((line) => {
    const [deg = line, school = '', date = ''] = line.split('|').map(s => s.trim());
    let block = '    \\resumeSubheading{' + tex(school) + '}{' + tex(date) + '}{' + tex(deg) + '}{}';
    const course = courseFor(line);
    if (course) block += '\n    \\resumeItemListStart\n      \\resumeItem{' + tex(course) + '}\n    \\resumeItemListEnd';
    return block;
  }).join('\n');
})();

// One-page caps (overridable). Recent role keeps more bullets than older roles.
const expCaps = Array.isArray(overrides.maxExpBullets) ? overrides.maxExpBullets : [5, 4, 4, 3];
const maxProjects = Number.isInteger(overrides.maxProjects) ? overrides.maxProjects : 2;
const maxProjBullets = Number.isInteger(overrides.maxProjBullets) ? overrides.maxProjBullets : 3;

const experience = cv.experience.map((job, idx) => {
  let bullets = job.bullets;
  if (overrides.experience) {
    const key = Object.keys(overrides.experience).find(k => (job.company || '').toLowerCase().includes(k.toLowerCase()));
    if (key) bullets = overrides.experience[key].map(stripMd);
  }
  bullets = [...bullets].sort((a, b) => scoreByKeywords(b) - scoreByKeywords(a));
  const cap = expCaps[idx] ?? expCaps[expCaps.length - 1] ?? 4;
  bullets = bullets.slice(0, cap);
  const items = bullets.map(b => '      \\resumeItem{' + tex(b) + '}').join('\n');
  const sub = job.company + (job.location ? ', ' + job.location : '');
  return '    \\resumeSubheading{' + tex(job.title) + '}{' + tex(job.dates) + '}{' + tex(sub) + '}{}\n    \\resumeItemListStart\n' + items + '\n    \\resumeItemListEnd';
}).join('\n');

let projList = cv.projects;
if (Array.isArray(overrides.projectOrder)) {
  projList = [...cv.projects].sort((a, b) => {
    const ia = overrides.projectOrder.findIndex(p => a.title.toLowerCase().startsWith(p.toLowerCase()));
    const ib = overrides.projectOrder.findIndex(p => b.title.toLowerCase().startsWith(p.toLowerCase()));
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
const projects = projList.slice(0, maxProjects).map(p => {
  const [title, tags] = p.title.split('|').map(s => s.trim());
  let head = tags ? '\\textbf{' + tex(title) + '} $|$ \\emph{' + tex(tags) + '}' : '\\textbf{' + tex(title) + '}';
  if (p.github) {
    // hyperref \href — package already imported in template (\usepackage[hidelinks]{hyperref}).
    head += ' $|$ \\href{' + p.github + '}{\\underline{[GitHub]}}';
  }
  const items = p.bullets.slice(0, maxProjBullets).map(b => '      \\resumeItem{' + tex(b) + '}').join('\n');
  return '    \\resumeProjectHeading{' + head + '}{}\n    \\resumeItemListStart\n' + items + '\n    \\resumeItemListEnd';
}).join('\n');

const compOverride = Array.isArray(overrides.competencies) && overrides.competencies.length;
let skills;
if (compOverride) {
  skills = '\\textbf{Core Competencies}{: ' + tex(overrides.competencies.join(', ')) + '}';
} else {
  skills = cv.skillsLines.map(line => {
    const m = line.match(/^[-]?\s*([^:]+):\s*(.+)$/);
    if (m) return '\\textbf{' + tex(m[1].trim()) + '}{: ' + tex(m[2].trim()) + '} \\\\';
    return tex(line) + ' \\\\';
  }).join('\n     ');
}

const contactLine = tex(phone); // location intentionally omitted from resume contact line
const fields = {
  NAME: tex(name), CONTACT_LINE: contactLine,
  EMAIL_URL: emailRaw, EMAIL_DISPLAY: tex(emailRaw),
  LINKEDIN_URL: linkedin, LINKEDIN_DISPLAY: tex(disp(linkedin)),
  GITHUB_URL: github, GITHUB_DISPLAY: tex(disp(github)),
  PORTFOLIO_URL: portfolio, PORTFOLIO_DISPLAY: tex(disp(portfolio)),
  SUMMARY: summary, EDUCATION: education, EXPERIENCE: experience,
  PROJECTS: projects, SKILLS: skills,
};
let out = read(PATHS.template);
for (const [k, v] of Object.entries(fields)) out = out.replaceAll('{{' + k + '}}', () => v);

fs.mkdirSync(PATHS.outDir, { recursive: true });
const outPath = path.join(PATHS.outDir, 'cv-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + companySlug + '.tex');
fs.writeFileSync(outPath, out);
console.log(outPath);
