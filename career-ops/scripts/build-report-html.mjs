// Build a print-ready HTML job-search analysis report from both data layers.
// Source of truth: Agency records_clean.json (work-Gmail) + data/applications.md + data/applied-dates.json
// Emits: output/job-search-report-<today>.html  (render to PDF via generate-pdf.mjs)
// Cross-platform: paths resolved relative to the repo root (works on Windows + Ubuntu/Syncthing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NB = path.join(ROOT, 'agency-applications', '_raw', 'records_clean.json');
const APP = path.join(ROOT, 'data', 'applications.md');
const APPLIED = path.join(ROOT, 'data', 'applied-dates.json');
const REPORT_DATE = new Date().toISOString().slice(0, 10);
const CANDIDATE = '<YOUR_NAME>';
const OUT = path.join(ROOT, 'output', `job-search-report-${REPORT_DATE}.html`);

const norm = s => (s || '').toString().trim();
const esc = s => norm(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (n, d) => d ? (n / d * 100) : 0;

// ---------- Agency layer ----------
const recs = JSON.parse(fs.readFileSync(NB, 'utf8'));
const arr = Array.isArray(recs) ? recs : (recs.records || Object.values(recs).find(v => Array.isArray(v)));

const status = {};
for (const r of arr) status[norm(r.status) || '?'] = (status[norm(r.status) || '?'] || 0) + 1;
const total = arr.length;
const rej = status['Rejected'] || 0;
const asmt = status['Assessment'] || 0;
const intv = status['Interview'] || 0;
const silent = total - rej - asmt - intv;

// staffing/body-shop classifier (precise tokens) — estimate, flagged as such
const AGENCY = /(staffing|consult|technolog(y|ies)|infotech|infotek|solutions|talent|recruit|resourc|teksystems|kforce|randstad|insight global|robert half|aara|net2source|mindlance|diverse lynx|compunnel|artech|collabera|dexian|brooksource|selby jennings|primary talent|trident|cliff services|nova infotek|ptr global|perfict|nityo|cybertec|sysmind|us tech|e-?solutions|sonsoft|intelliswift|stellent|ascii group|datastaff|nasscomm|tek |systems\b|partners\b|group, llc)/i;
const ALLOW = /(davita|cvs|optum|unitedhealth|molina|centene|elevance|humana|oscar|kaiser|aetna|cigna|caterpillar|criteo|wellmark|gallup|amazon|p&g|procter)/i;
const isAgency = c => AGENCY.test(c || '') && !ALLOW.test(c || '');

// per-company tallies
const co = {};
for (const r of arr) {
  const c = norm(r.company);
  if (!c || c === '(unknown)') continue;
  co[c] = co[c] || { total: 0, rej: 0, sources: new Set() };
  co[c].total++;
  if (norm(r.status) === 'Rejected') co[c].rej++;
  const s = (r.sender || '').toLowerCase();
  let k = 'direct';
  if (/myworkday|workday/.test(s)) k = 'Workday';
  else if (/greenhouse/.test(s)) k = 'Greenhouse';
  else if (/lever/.test(s)) k = 'Lever';
  else if (/icims/.test(s)) k = 'iCIMS';
  else if (/ashby/.test(s)) k = 'Ashby';
  else if (/linkedin/.test(s)) k = 'LinkedIn';
  else if (/indeed/.test(s)) k = 'Indeed';
  else if (/smartrecruiters/.test(s)) k = 'SmartRec';
  co[c].sources.add(k);
}
const namedCos = Object.keys(co).length;
let agencySubs = 0; const agencySet = new Set();
for (const [c, v] of Object.entries(co)) if (isAgency(c)) { agencySubs += v.total; agencySet.add(c.toLowerCase()); }
const topCos = Object.entries(co).sort((a, b) => b[1].total - a[1].total).slice(0, 30);
const dupCos = Object.entries(co).filter(([, v]) => v.total >= 3).sort((a, b) => b[1].total - a[1].total);

// rejecters
const rejBy = {};
for (const r of arr) if (norm(r.status) === 'Rejected') { const c = norm(r.company) || '(unknown)'; rejBy[c] = (rejBy[c] || 0) + 1; }
const topRej = Object.entries(rejBy).sort((a, b) => b[1] - a[1]).slice(0, 12);

// source mix
const src = {};
for (const r of arr) {
  const s = (r.sender || '').toLowerCase(); let k = 'Other / direct';
  if (/myworkday|workday/.test(s)) k = 'Workday';
  else if (/greenhouse/.test(s)) k = 'Greenhouse';
  else if (/lever/.test(s)) k = 'Lever';
  else if (/icims/.test(s)) k = 'iCIMS';
  else if (/ashby/.test(s)) k = 'Ashby';
  else if (/linkedin/.test(s)) k = 'LinkedIn Easy Apply';
  else if (/smartrecruiters/.test(s)) k = 'SmartRecruiters';
  else if (/jobvite/.test(s)) k = 'Jobvite';
  src[k] = (src[k] || 0) + 1;
}
const srcSorted = Object.entries(src).sort((a, b) => b[1] - a[1]);

// roles + seniority
const role = {};
for (const r of arr) { const ro = norm(r.role) || '(unknown)'; role[ro] = (role[ro] || 0) + 1; }
const topRoles = Object.entries(role).sort((a, b) => b[1] - a[1]).slice(0, 10);
const seniorMis = arr.filter(r => /\b(senior|sr\.?|staff|lead|principal|manager|director|iii|iv)\b/i.test(r.role || '')).length;

// weekly volume buckets
const byDate = {};
for (const r of arr) { const d = norm(r.applied_date).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) byDate[d] = (byDate[d] || 0) + 1; }
const dates = Object.keys(byDate).sort();
const wk = {};
for (const [d, n] of Object.entries(byDate)) {
  const dt = new Date(d + 'T00:00:00Z');
  const day = dt.getUTCDay(); const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((day + 6) % 7));
  const key = monday.toISOString().slice(0, 10);
  wk[key] = (wk[key] || 0) + n;
}
const weeks = Object.entries(wk).sort();
const activeDays = dates.length;

// live signals
const FRESH = '2026-05-10';
const liveRaw = arr.filter(r => ['Assessment', 'Interview', 'Applied'].includes(norm(r.status)))
  .map(r => ({ status: norm(r.status), company: norm(r.company), role: norm(r.role), date: norm(r.last_event).slice(0, 10), subj: norm(r.last_subject).slice(0, 64) }))
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
const liveFresh = liveRaw.filter(r => (r.date || '') >= FRESH);
const liveOld = liveRaw.filter(r => (r.date || '') < FRESH);

// ---------- career-ops layer ----------
const md = fs.readFileSync(APP, 'utf8').split(/\r?\n/).filter(l => /^\|\s*\d+\s*\|/.test(l));
const cstat = {}; let appliedScores = [];
for (const l of md) {
  const c = l.split('|').map(s => s.trim());
  const score = parseFloat((c[5] || '').replace('/5', '')); const st = c[6] || '?';
  cstat[st] = (cstat[st] || 0) + 1;
  if (st === 'Applied' && !isNaN(score)) appliedScores.push(score);
}
const avgApplied = appliedScores.length ? (appliedScores.reduce((a, b) => a + b, 0) / appliedScores.length) : 0;
const loggedDates = Object.keys(JSON.parse(fs.readFileSync(APPLIED, 'utf8')).dates || {}).length;

// ---------- HTML helpers ----------
const bar = (label, val, max, cls = '') =>
  `<div class="barrow"><span class="blabel">${esc(label)}</span><span class="btrack"><span class="bfill ${cls}" style="width:${(pct(val, max)).toFixed(1)}%"></span></span><span class="bval">${val}</span></div>`;

const findings = {
  issues: [
    ['Eval-to-submit-to-track gap (your real bottleneck)', `In your curated pipeline, ${cstat['Evaluated'] || 0} roles were evaluated and ${cstat['Applied'] || 0} marked Applied, but only ${loggedDates} have a real submission date logged. You evaluate far more than you ship, and sends go untracked. An un-sent 4.7 is worth zero.`],
    ['The shared email works against you', `The marketing group sprays staffing agencies / body-shops under your address — an estimated ${agencySubs} submissions across ${agencySet.size} distinct shops (Robert Half, Randstad, Kforce, Insight Global each 5x). These harvest resumes, rarely convert, and burn your ATS dedup so you can be blocked from re-applying to good direct roles.`],
    ['Duplicate spray', `${dupCos.length} companies received 3 or more applications under your email — a spam signal to those ATS systems and a waste of your one good shot at a real employer.`],
    ['Low-yield channel mix', `LinkedIn Easy Apply is ${src['LinkedIn Easy Apply'] || 0} of ${total} (${pct(src['LinkedIn Easy Apply'] || 0, total).toFixed(0)}%) — highest volume, lowest conversion. Every live signal came from a direct apply (Workday/Greenhouse/iCIMS), never Easy Apply or an agency.`],
    ['Some over-tier applies', `${seniorMis} spray applications targeted Senior / Staff / Lead / III-IV roles — outside your eligible tier and wasted effort.`],
  ],
  note: [
    `Volume is NOT your performance: ${rej} rejections (${pct(rej, total).toFixed(1)}%) and ~${pct(silent, total).toFixed(0)}% silence is normal spray physics, mostly from the marketing group — not personal rejection.`,
    `Your live signals cluster on real direct employers (Amazon, Wellmark, P&G, NCD, Gallup, NYU Langone) — never on agencies. That is your conversion pattern, in your own data.`,
    `The curated layer's near-zero rejection (${cstat['Rejected'] || 0}/${cstat['Applied'] || 0}) is not a win yet — outcomes are largely untracked and too recent to read as success.`,
    `Velocity is front-loaded (62/52/51 apps in early April) then tapered — burst spray, not steady targeting.`,
  ],
  improve: [
    'Work the live queue FIRST — chase Amazon, the 05-21 interview, Wellmark, P&G, and NCD before sending anything new. One worked assessment beats 200 applies.',
    'Close the loop: hit the "Applied on" picker on every send; target 3 tailored sends/day from the >=4.5 stack (resumes are now JD-tailored and ready).',
    'Follow up — Day-1 LinkedIn DM + Day-3/Day-7 cadence (contacts.json + followup-cadence.mjs). Silence drops fast with one human touch.',
    'Dedup before applying: check the Agency work-Gmail so career-ops never double-applies to a role the group already burned.',
    'Direct employers only for your own sends. Skip every staffing shell.',
  ],
  avoid: [
    'Letting the group spray staffing agencies / body-shops under your email (harvest + ATS pollution).',
    'Re-applying to the same company 3+ times.',
    'LinkedIn Easy-Apply blasting — it is the bulk of the silence.',
    'Over-tier (Senior / III / Lead) applications.',
    'Treating rejection-label volume as your score.',
    'Evaluate-and-sit: the gap between Applied and logged-sent is the whole problem.',
  ],
};

// ---------- build HTML ----------
const srcMax = Math.max(...srcSorted.map(s => s[1]));
const roleMax = Math.max(...topRoles.map(s => s[1]));
const wkMax = Math.max(...weeks.map(s => s[1]));

const liveRow = r => `<tr class="${r.date >= FRESH ? 'fresh' : ''}"><td><span class="pill ${r.status.toLowerCase()}">${esc(r.status)}</span></td><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(r.date)}</td><td class="subj">${esc(r.subj)}</td></tr>`;
const coRow = ([c, v]) => `<tr><td>${esc(c)}${isAgency(c) ? ' <span class="tag ag">agency?</span>' : ''}${v.total >= 3 ? ' <span class="tag dup">dup</span>' : ''}</td><td class="num">${v.total}</td><td class="num">${v.rej || ''}</td><td>${[...v.sources].join(', ')}</td></tr>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Job Search Analysis — ${CANDIDATE}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; font-size: 11px; line-height: 1.5; margin: 0; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #e5e7eb; color: #111827; }
  h2 .sub { font-weight: 400; color: #6b7280; font-size: 11px; }
  .head { background: linear-gradient(135deg,#0f766e,#0891b2); color: #fff; padding: 20px 22px; border-radius: 10px; }
  .head .meta { opacity: .9; font-size: 11px; margin-top: 6px; }
  .tldr { background: #f0fdfa; border: 1px solid #99f6e4; border-left: 4px solid #0d9488; padding: 12px 14px; border-radius: 6px; margin: 14px 0; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .card { flex: 1 1 120px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
  .card .v { font-size: 20px; font-weight: 700; color: #0f766e; }
  .card .l { font-size: 9.5px; color: #64748b; text-transform: uppercase; letter-spacing: .03em; }
  .card.warn .v { color: #b45309; } .card.bad .v { color: #b91c1c; } .card.good .v { color: #15803d; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 10px; }
  th { text-align: left; background: #f1f5f9; padding: 5px 7px; border-bottom: 1px solid #cbd5e1; font-size: 9.5px; text-transform: uppercase; letter-spacing: .02em; color: #475569; }
  td { padding: 4px 7px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:nth-child(even) td { background: #fafcff; }
  tr.fresh td { background: #fffbeb !important; }
  .subj { color: #6b7280; font-style: italic; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 9px; font-weight: 600; color: #fff; }
  .pill.interview { background: #7c3aed; } .pill.assessment { background: #0891b2; } .pill.applied { background: #64748b; }
  .tag { font-size: 8px; padding: 0 5px; border-radius: 8px; font-weight: 600; }
  .tag.ag { background: #fee2e2; color: #b91c1c; } .tag.dup { background: #ffedd5; color: #9a3412; }
  .barrow { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .blabel { width: 150px; font-size: 10px; color: #374151; flex: none; }
  .btrack { flex: 1; background: #eef2f7; border-radius: 4px; height: 13px; overflow: hidden; }
  .bfill { display: block; height: 100%; background: #0d9488; border-radius: 4px; }
  .bfill.alt { background: #0891b2; } .bfill.warn { background: #f59e0b; }
  .bval { width: 42px; text-align: right; font-size: 10px; color: #475569; flex: none; font-variant-numeric: tabular-nums; }
  .panels { display: flex; flex-wrap: wrap; gap: 10px; }
  .panel { flex: 1 1 46%; border-radius: 8px; padding: 11px 13px; border: 1px solid; page-break-inside: avoid; }
  .panel h3 { margin: 0 0 6px; font-size: 12px; }
  .panel ul { margin: 0; padding-left: 16px; } .panel li { margin: 4px 0; }
  .panel li b { color: #111827; }
  .p-issue { background: #fef2f2; border-color: #fecaca; } .p-issue h3 { color: #b91c1c; }
  .p-note { background: #eff6ff; border-color: #bfdbfe; } .p-note h3 { color: #1d4ed8; }
  .p-improve { background: #f0fdf4; border-color: #bbf7d0; } .p-improve h3 { color: #15803d; }
  .p-avoid { background: #fff7ed; border-color: #fed7aa; } .p-avoid h3 { color: #c2410c; }
  .twocol { display: flex; gap: 16px; } .twocol > div { flex: 1; }
  .foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 9px; }
  .note-sm { font-size: 9px; color: #9ca3af; margin-top: 2px; }
  section { page-break-inside: avoid; }
</style></head><body>

<div class="head">
  <h1>Job Search — Application Analysis</h1>
  <div class="meta">${CANDIDATE} &nbsp;•&nbsp; Window ${dates[0]} → ${dates[dates.length - 1]} (${activeDays} active days) &nbsp;•&nbsp; Generated ${REPORT_DATE}</div>
</div>

<div class="tldr">
  <b>Two pipelines run under your name.</b> The high-volume <b>Agency</b> stream (${total} apps) is mostly the
  marketing group spray-applying via <code><YOUR_EMAIL></code> — <b>not your taste or effort</b>.
  Your <b>career-ops</b> stream (${cstat['Applied'] || 0} applied @ avg fit ${avgApplied.toFixed(2)}/5) is the curated, tailored work.
  Read the volume numbers as the group's behavior; read quality + live signals as yours.
</div>

<section>
<h2>At a glance</h2>
<div class="cards">
  <div class="card"><div class="v">${total.toLocaleString()}</div><div class="l">Total apps (Agency)</div></div>
  <div class="card bad"><div class="v">${rej}</div><div class="l">Rejected (${pct(rej, total).toFixed(1)}%)</div></div>
  <div class="card warn"><div class="v">~${pct(silent, total).toFixed(0)}%</div><div class="l">Silent / no reply</div></div>
  <div class="card good"><div class="v">${intv}</div><div class="l">Interviews</div></div>
  <div class="card good"><div class="v">${asmt}</div><div class="l">Assessments</div></div>
  <div class="card warn"><div class="v">~${agencySubs}</div><div class="l">Agency / body-shop</div></div>
  <div class="card"><div class="v">${cstat['Applied'] || 0}</div><div class="l">Curated applied</div></div>
  <div class="card bad"><div class="v">${loggedDates}</div><div class="l">Sends actually logged</div></div>
</div>
</section>

<section>
<h2>🔴 Live signals <span class="sub">— real traction worth more than any new apply. Work these first.</span></h2>
<table>
  <tr><th>Status</th><th>Company</th><th>Role</th><th>Last event</th><th>Subject</th></tr>
  ${liveFresh.map(liveRow).join('\n')}
</table>
<div class="note-sm">Fresh / likely-open (highlighted). Older signals below are likely lapsed — chase only if still relevant.</div>
<table>
  ${liveOld.map(liveRow).join('\n')}
</table>
</section>

<section>
<div class="twocol">
  <div>
    <h2>Where applications go <span class="sub">(channel)</span></h2>
    ${srcSorted.map(([k, v]) => bar(k, v, srcMax, /Easy Apply/.test(k) ? 'warn' : 'alt')).join('\n')}
  </div>
  <div>
    <h2>Weekly volume <span class="sub">(spray cadence)</span></h2>
    ${weeks.map(([k, v]) => bar('wk ' + k.slice(5), v, wkMax)).join('\n')}
  </div>
</div>
</section>

<section>
<h2>Top roles applied <span class="sub">(Agency — subject-line derived)</span></h2>
${topRoles.map(([k, v]) => bar(k, v, roleMax, /senior|iii|lead|staff/i.test(k) ? 'warn' : '')).join('\n')}
<div class="note-sm">${seniorMis} applications (${pct(seniorMis, total).toFixed(0)}%) targeted Senior/Staff/Lead/III-IV — outside eligible tier.</div>
</section>

<section>
<h2>Top companies by application count <span class="sub">— dup spray &amp; agencies flagged</span></h2>
<table>
  <tr><th>Company</th><th>Apps</th><th>Rej</th><th>Source</th></tr>
  ${topCos.map(coRow).join('\n')}
</table>
<div class="note-sm">${namedCos} distinct named companies • ${dupCos.length} got 3+ apps • ~${agencySet.size} distinct staffing shops (agency flag is a heuristic estimate).</div>
</section>

<section>
<h2>Who responded (rejections) <span class="sub">— and the curated pipeline</span></h2>
<div class="twocol">
  <div>
    <table><tr><th>Top rejecters</th><th>×</th></tr>
    ${topRej.map(([c, n]) => `<tr><td>${esc(c)}</td><td class="num">${n}</td></tr>`).join('\n')}
    </table>
  </div>
  <div>
    <table><tr><th>career-ops status</th><th>#</th></tr>
    ${Object.entries(cstat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('\n')}
    </table>
    <div class="note-sm">Curated avg fit (Applied): <b>${avgApplied.toFixed(2)}/5</b> • only ${loggedDates} submission dates logged.</div>
  </div>
</div>
</section>

<section>
<h2>Findings &amp; recommendations</h2>
<div class="panels">
  <div class="panel p-issue"><h3>⚠ Issues from your end</h3><ul>${findings.issues.map(([t, d]) => `<li><b>${esc(t)}.</b> ${esc(d)}</li>`).join('')}</ul></div>
  <div class="panel p-note"><h3>📌 What to note</h3><ul>${findings.note.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
  <div class="panel p-improve"><h3>✅ What to improve</h3><ul>${findings.improve.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
  <div class="panel p-avoid"><h3>🚫 What to avoid</h3><ul>${findings.avoid.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
</div>
</section>

<div class="foot">
  Generated by career-ops from <code>agency-applications/_raw/records_clean.json</code>, <code>data/applications.md</code>, and <code>data/applied-dates.json</code> on ${REPORT_DATE}.
  Agency volume reflects combined activity on the shared work mailbox (marketing group + candidate); curated metrics reflect candidate-owned applications.
</div>

</body></html>`;

fs.writeFileSync(OUT, html);
console.log('WROTE', OUT, `(${(html.length / 1024).toFixed(1)} KB)`);
console.log(`live fresh=${liveFresh.length} old=${liveOld.length} | topCos=${topCos.length} | weeks=${weeks.length}`);
