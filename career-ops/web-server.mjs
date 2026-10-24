/**
 * career-ops web dashboard
 * Run: node web-server.mjs
 * Opens: http://localhost:3131
 */

import express from 'express';
import { createServer } from 'http';
import { watch } from 'chokidar';
import { marked } from 'marked';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname);
const PORT = 3131;

// ─────────────────────────────────────────────
// DATA PARSING
// ─────────────────────────────────────────────

function parseScore(raw) {
  const m = raw?.match(/(\d+\.?\d*)\/5/);
  return m ? parseFloat(m[1]) : 0;
}

function parseReportLink(raw) {
  const m = raw?.match(/\[(\d+)\]\(([^)]+)\)/);
  return m ? { num: m[1], path: m[2] } : null;
}

function normalizeStatus(raw = '') {
  const s = raw.replace(/\*\*/g, '').trim().toLowerCase();
  if (s === 'skip') return 'SKIP';
  if (s.includes('applied')) return 'Applied';
  if (s.includes('interview')) return 'Interview';
  if (s.includes('offer')) return 'Offer';
  if (s.includes('responded')) return 'Responded';
  if (s.includes('rejected')) return 'Rejected';
  if (s.includes('discarded')) return 'Discarded';
  if (s.includes('evaluated')) return 'Evaluated';
  return raw.trim();
}

function parseApplications() {
  const filePath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, 'utf8').split('\n');
  const apps = [];
  let rowNum = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---') || line.startsWith('| Date')) continue;

    let fields;
    if (line.includes('\t')) {
      fields = line.replace(/^\|/, '').split('\t').map(f => f.replace(/\|$/, '').trim());
    } else {
      fields = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(f => f.trim());
    }

    if (fields.length < 8) continue;

    const [num, date, company, role, scoreRaw, statusRaw, pdfRaw, reportRaw, ...notesParts] = fields;
    const report = parseReportLink(reportRaw);
    rowNum++;

    apps.push({
      id: rowNum,
      num: parseInt(num) || rowNum,
      date: date || '',
      company: company || '',
      role: role || '',
      scoreRaw: scoreRaw || '',
      score: parseScore(scoreRaw),
      status: normalizeStatus(statusRaw),
      hasPDF: (pdfRaw || '').includes('✅'),
      reportNum: report?.num || '',
      reportPath: report?.path || '',
      notes: notesParts.join(' | ').trim(),
      jobURL: '',
    });
  }

  // Enrich with job URLs from reports (**URL:** field)
  for (const app of apps) {
    if (!app.reportPath) continue;
    const rp = join(ROOT, app.reportPath);
    if (!existsSync(rp)) continue;
    const header = readFileSync(rp, 'utf8').slice(0, 1200);
    const m = header.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
    if (m) app.jobURL = m[1];
  }

  // Enrich with job URLs from scan-history.tsv
  enrichFromScanHistory(apps);

  return apps;
}

function enrichFromScanHistory(apps) {
  const scanPath = join(ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(scanPath)) return;

  const byCompany = {};
  for (const line of readFileSync(scanPath, 'utf8').split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 5 || fields[0] === 'url' || !fields[0].startsWith('http')) continue;
    const key = normalizeCompanyKey(fields[4]);
    if (!byCompany[key]) byCompany[key] = [];
    byCompany[key].push({ url: fields[0], title: fields[3] || '' });
  }

  for (const app of apps) {
    if (app.jobURL) continue;
    const key = normalizeCompanyKey(app.company);
    const matches = byCompany[key] || [];
    if (matches.length === 1) {
      app.jobURL = matches[0].url;
    } else if (matches.length > 1) {
      const appRole = app.role.toLowerCase();
      let best = matches[0].url, bestScore = 0;
      for (const m of matches) {
        const score = appRole.split(/\s+/).filter(w => w.length > 2 && m.title.toLowerCase().includes(w)).length;
        if (score > bestScore) { bestScore = score; best = m.url; }
      }
      app.jobURL = best;
    }
  }
}

function normalizeCompanyKey(name = '') {
  return name.toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|technologies|technology|group|co)\b\.?/g, '')
    .replace(/\s+/g, ' ').trim();
}

function computeMetrics(apps) {
  const byStatus = {};
  let totalScore = 0, scored = 0, topScore = 0, withPDF = 0;

  for (const app of apps) {
    const s = app.status;
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (app.score > 0) { totalScore += app.score; scored++; topScore = Math.max(topScore, app.score); }
    if (app.hasPDF) withPDF++;
  }

  return {
    total: apps.length,
    byStatus,
    avgScore: scored ? (totalScore / scored).toFixed(2) : 0,
    topScore: topScore.toFixed(1),
    withPDF,
    actionable: (byStatus['Applied'] || 0) + (byStatus['Evaluated'] || 0) + (byStatus['Interview'] || 0) + (byStatus['Responded'] || 0) + (byStatus['Offer'] || 0),
  };
}

function listPDFs() {
  const dir = join(ROOT, 'output');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.pdf')).map(f => ({
    name: f,
    label: f.replace(/^cv-/, '').replace(/-\d{4}-\d{2}-\d{2}\.pdf$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    url: `/output/${f}`,
  }));
}

function updateStatus(reportNum, newStatus) {
  const filePath = join(ROOT, 'data', 'applications.md');
  let content = readFileSync(filePath, 'utf8');
  const CANONICAL = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
  if (!CANONICAL.includes(newStatus)) throw new Error('Invalid status: ' + newStatus);

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`[${reportNum}]`)) {
      // Find and replace status field (5th pipe-delimited column)
      const oldStatus = lines[i].match(/\|\s*([A-Za-z]+)\s*\|[^|]*\|[^|]*\[/)?.[1];
      if (oldStatus) {
        lines[i] = lines[i].replace(oldStatus, newStatus);
        writeFileSync(filePath, lines.join('\n'));
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

const app = express();
const server = createServer(app);
app.use(express.json());

// Serve PDFs
app.use('/output', express.static(join(ROOT, 'output')));

// SSE clients
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(msg);
}

// File watcher
const watcher = watch([
  join(ROOT, 'data', 'applications.md'),
  join(ROOT, 'reports'),
  join(ROOT, 'output'),
], { ignoreInitial: true, usePolling: false });

watcher.on('all', () => {
  setTimeout(() => broadcast('refresh', { ts: Date.now() }), 300);
});

// API routes
app.get('/api/apps', (req, res) => {
  res.json(parseApplications());
});

app.get('/api/metrics', (req, res) => {
  res.json(computeMetrics(parseApplications()));
});

app.get('/api/report', (req, res) => {
  const rpath = req.query.path;
  if (!rpath) return res.status(400).json({ error: 'missing path' });
  const full = join(ROOT, rpath);
  if (!existsSync(full)) return res.status(404).json({ error: 'not found' });
  const md = readFileSync(full, 'utf8');
  res.json({ raw: md, html: marked(md) });
});

app.get('/api/pdfs', (req, res) => {
  res.json(listPDFs());
});

app.post('/api/status', (req, res) => {
  const { reportNum, status } = req.body;
  try {
    const ok = updateStatus(reportNum, status);
    if (ok) { broadcast('refresh', { ts: Date.now() }); res.json({ ok: true }); }
    else res.status(404).json({ error: 'not found' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FRONTEND (inline HTML)
// ─────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Career Ops Dashboard</title>
<style>
/* ── Anthropic / Claude Design System ── */
:root {
  --bg: #f5f4ed;
  --surface: #faf9f5;
  --surface2: #f0eee6;
  --border: #e8e6dc;
  --border-light: #f0eee6;
  --text: #141413;
  --text-sec: #5e5d59;
  --muted: #87867f;
  --accent: #c96442;
  --accent2: #d97757;
  --dark: #30302e;
  --near-black: #141413;
  --green: #2e7d5a;
  --yellow: #8a6020;
  --red: #b53333;
  --warm-silver: #b0aea5;
  --radius: 8px;
  --radius-lg: 12px;
  --shadow-ring: 0px 0px 0px 1px #d1cfc5;
  --shadow-whisper: rgba(0,0,0,0.05) 0px 4px 24px;
  --font-serif: Georgia, 'Times New Roman', serif;
  --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* ── TOP BAR ── */
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 11px 24px; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; box-shadow: var(--shadow-whisper); }
.topbar-logo { font-family: var(--font-serif); font-size: 17px; font-weight: 500; color: var(--text); letter-spacing: -0.01em; line-height: 1.1; }
.topbar-logo span { color: var(--accent); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 6px; animation: pulse 2.5s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.live-label { font-size: 11px; color: var(--muted); letter-spacing: 0.02em; }

/* ── METRICS ── */
.metrics { display: flex; background: var(--bg); border-bottom: 1px solid var(--border); flex-shrink: 0; padding: 0 8px; }
.metric { flex: 1; padding: 12px 14px; text-align: center; border-right: 1px solid var(--border-light); }
.metric:last-child { border-right: none; }
.metric-val { font-family: var(--font-serif); font-size: 20px; font-weight: 500; color: var(--text); line-height: 1; }
.metric-val.green { color: var(--green); }
.metric-val.accent { color: var(--accent); }
.metric-val.yellow { color: var(--yellow); }
.metric-val.accent2 { color: var(--accent2); }
.metric-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }

/* ── CONTROLS ── */
.controls { display: flex; gap: 8px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; align-items: center; }
.search-box { flex: 1; min-width: 180px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); color: var(--text); padding: 7px 12px; font-size: 13px; font-family: var(--font-sans); outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
.search-box::placeholder { color: var(--muted); }
.search-box:focus { border-color: #3898ec; box-shadow: 0 0 0 2px rgba(56,152,236,0.15); }
.filter-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.tab { padding: 5px 11px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 11px; font-family: var(--font-sans); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
.tab:hover { background: var(--surface2); color: var(--text-sec); box-shadow: var(--shadow-ring); }
.tab.active { background: var(--accent); border-color: var(--accent); color: #faf9f5; font-weight: 500; box-shadow: 0px 0px 0px 1px var(--accent); }

/* ── BUTTONS ── */
.btn { padding: 6px 13px; border-radius: var(--radius); border: none; background: var(--surface2); color: var(--text-sec); font-size: 12px; font-family: var(--font-sans); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; box-shadow: var(--shadow-ring); text-decoration: none; }
.btn:hover { background: var(--border); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #faf9f5; box-shadow: 0px 0px 0px 1px var(--accent); }
.btn.primary:hover { background: #b85838; }

/* ── LAYOUT ── */
.main { display: flex; flex: 1; overflow: hidden; }

/* ── TABLE ── */
.table-wrap { flex: 1; overflow-y: auto; }
.table-wrap::-webkit-scrollbar { width: 5px; }
.table-wrap::-webkit-scrollbar-track { background: var(--bg); }
.table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
table { width: 100%; border-collapse: collapse; }
thead th { position: sticky; top: 0; background: var(--surface); padding: 9px 14px; text-align: left; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; cursor: pointer; user-select: none; font-family: var(--font-sans); }
thead th:hover { color: var(--text-sec); }
tbody tr { border-bottom: 1px solid var(--border-light); cursor: pointer; transition: background 0.12s; }
tbody tr:hover { background: var(--surface); }
tbody tr.selected { background: rgba(201,100,66,0.06); border-left: 2px solid var(--accent); }
td { padding: 9px 14px; vertical-align: middle; }
.td-num { color: var(--muted); font-size: 11px; width: 36px; font-variant-numeric: tabular-nums; }
.td-date { color: var(--muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.td-company { font-weight: 500; color: var(--text); font-family: var(--font-sans); }
.td-role { color: var(--text-sec); font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── SCORE BADGES ── */
.score-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500; }
.score-high { background: rgba(46,125,90,0.10); color: var(--green); box-shadow: 0px 0px 0px 1px rgba(46,125,90,0.2); }
.score-mid { background: rgba(138,96,32,0.10); color: var(--yellow); box-shadow: 0px 0px 0px 1px rgba(138,96,32,0.2); }
.score-low { background: rgba(181,51,51,0.08); color: var(--red); box-shadow: 0px 0px 0px 1px rgba(181,51,51,0.18); }
.score-none { background: var(--surface2); color: var(--muted); box-shadow: var(--shadow-ring); }

/* ── STATUS PILLS ── */
.status-pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 10px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
.s-applied { background: rgba(215,119,87,0.12); color: var(--accent2); box-shadow: 0px 0px 0px 1px rgba(215,119,87,0.25); }
.s-evaluated { background: rgba(201,100,66,0.10); color: var(--accent); box-shadow: 0px 0px 0px 1px rgba(201,100,66,0.22); }
.s-interview { background: rgba(46,125,90,0.12); color: var(--green); box-shadow: 0px 0px 0px 1px rgba(46,125,90,0.22); }
.s-offer { background: rgba(46,125,90,0.2); color: #1a5e40; box-shadow: 0px 0px 0px 1px rgba(46,125,90,0.3); }
.s-responded { background: rgba(138,96,32,0.10); color: var(--yellow); box-shadow: 0px 0px 0px 1px rgba(138,96,32,0.2); }
.s-skip { background: var(--surface2); color: var(--muted); box-shadow: var(--shadow-ring); }
.s-rejected, .s-discarded { background: rgba(181,51,51,0.08); color: var(--red); box-shadow: 0px 0px 0px 1px rgba(181,51,51,0.16); }
.s-default { background: var(--surface2); color: var(--muted); }
.pdf-icon { font-size: 13px; }
.no-rows { padding: 60px; text-align: center; color: var(--muted); font-family: var(--font-serif); font-size: 15px; font-weight: 500; }

/* ── DETAIL PANEL ── */
.panel { width: 0; overflow: hidden; background: var(--surface); border-left: 1px solid var(--border); transition: width 0.25s ease; display: flex; flex-direction: column; }
.panel.open { width: 480px; min-width: 480px; }
.panel-header { padding: 16px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-shrink: 0; background: var(--bg); }
.panel-title { font-family: var(--font-serif); font-weight: 500; font-size: 15px; line-height: 1.3; color: var(--text); }
.panel-sub { font-size: 11px; color: var(--muted); margin-top: 3px; }
.panel-close { background: none; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); cursor: pointer; font-size: 15px; padding: 2px 7px; line-height: 1.4; flex-shrink: 0; transition: all 0.15s; }
.panel-close:hover { background: var(--surface2); color: var(--text); }
.panel-actions { display: flex; gap: 6px; padding: 10px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; flex-shrink: 0; }
.panel-actions .btn { font-size: 11px; }
.status-select { background: var(--bg); border: 1px solid var(--border); color: var(--text-sec); border-radius: var(--radius); padding: 5px 8px; font-size: 11px; font-family: var(--font-sans); cursor: pointer; outline: none; transition: border-color 0.15s; }
.status-select:focus { border-color: #3898ec; }
.panel-body { flex: 1; overflow-y: auto; padding: 18px; }
.panel-body::-webkit-scrollbar { width: 5px; }
.panel-body::-webkit-scrollbar-track { background: var(--surface); }
.panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* ── MARKDOWN ── */
.md h1 { font-family: var(--font-serif); font-size: 16px; font-weight: 500; color: var(--text); margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 9px; line-height: 1.3; }
.md h2 { font-size: 10px; font-weight: 500; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin: 18px 0 6px; }
.md h3 { font-size: 12px; font-weight: 500; color: var(--text-sec); margin: 12px 0 4px; }
.md p { color: var(--text-sec); margin-bottom: 9px; line-height: 1.65; font-size: 12px; }
.md ul, .md ol { padding-left: 16px; margin-bottom: 9px; }
.md li { color: var(--text-sec); font-size: 12px; line-height: 1.65; margin-bottom: 3px; }
.md strong { color: var(--text); font-weight: 600; }
.md em { color: var(--muted); font-style: italic; }
.md code { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-family: var(--font-mono); font-size: 11px; color: var(--accent); }
.md pre { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-bottom: 10px; overflow-x: auto; }
.md pre code { background: none; border: none; padding: 0; font-size: 11px; color: var(--text-sec); }
.md table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 11px; }
.md th { background: var(--surface2); padding: 5px 9px; text-align: left; color: var(--muted); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; border-bottom: 1px solid var(--border); }
.md td { padding: 5px 9px; border-bottom: 1px solid var(--border-light); color: var(--text-sec); }
.md a { color: var(--accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
.md blockquote { border-left: 2px solid var(--accent); padding-left: 13px; color: var(--muted); margin: 10px 0; font-style: italic; }

/* ── PDF MODAL ── */
.pdf-modal { display: none; position: fixed; inset: 0; background: rgba(20,20,19,0.82); z-index: 100; flex-direction: column; }
.pdf-modal.open { display: flex; }
.pdf-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border); }
.pdf-modal-title { font-family: var(--font-serif); font-size: 14px; font-weight: 500; color: var(--text); }
.pdf-modal-close { background: none; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); cursor: pointer; font-size: 16px; padding: 3px 8px; line-height: 1.4; transition: all 0.15s; }
.pdf-modal-close:hover { background: var(--surface2); color: var(--text); }
.pdf-modal embed { flex: 1; width: 100%; border: none; }

/* ── RESUMES ── */
.resume-item { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.resume-name { font-size: 12px; font-weight: 500; color: var(--text-sec); }
.resume-actions { display: flex; gap: 5px; }
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div class="topbar-logo">Career<span>Ops</span></div>
  <div style="display:flex;align-items:center;gap:14px">
    <div><span class="live-dot"></span><span class="live-label" id="live-label">Live</span></div>
    <button class="btn" onclick="showResumes()">&#128196; Resumes</button>
  </div>
</div>

<!-- METRICS -->
<div class="metrics" id="metrics"></div>

<!-- CONTROLS -->
<div class="controls">
  <input class="search-box" id="search" placeholder="Search company, role, notes..." oninput="applyFilters()">
  <div class="filter-tabs" id="filter-tabs"></div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th onclick="sortBy('num')">#</th>
          <th onclick="sortBy('date')">Date</th>
          <th onclick="sortBy('company')">Company</th>
          <th onclick="sortBy('role')">Role</th>
          <th onclick="sortBy('score')">Score</th>
          <th onclick="sortBy('status')">Status</th>
          <th>PDF</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="no-rows" class="no-rows" style="display:none">No matching applications.</div>
  </div>

  <!-- DETAIL PANEL -->
  <div class="panel" id="panel">
    <div class="panel-header">
      <div>
        <div class="panel-title" id="panel-title">&#8212;</div>
        <div class="panel-sub" id="panel-sub">&#8212;</div>
      </div>
      <button class="panel-close" onclick="closePanel()">&#215;</button>
    </div>
    <div class="panel-actions" id="panel-actions"></div>
    <div class="panel-body">
      <div class="md" id="panel-md"></div>
    </div>
  </div>
</div>

<!-- PDF MODAL -->
<div class="pdf-modal" id="pdf-modal">
  <div class="pdf-modal-header">
    <div class="pdf-modal-title" id="pdf-modal-title">Resume</div>
    <div style="display:flex;gap:8px;align-items:center">
      <a id="pdf-download" href="" download class="btn">&#8595; Download</a>
      <button class="pdf-modal-close" onclick="closePDFModal()">&#215;</button>
    </div>
  </div>
  <embed id="pdf-embed" src="" type="application/pdf">
</div>

<script>
let allApps = [];
let activeFilter = 'All';
let sortKey = 'num';
let sortAsc = true;
let selectedId = null;
const CANONICAL_STATUSES = ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP'];

// ── STATUS HELPERS ──
function statusClass(s) {
  const m = { Applied:'s-applied', Evaluated:'s-evaluated', Interview:'s-interview', Offer:'s-offer', Responded:'s-responded', SKIP:'s-skip', Rejected:'s-rejected', Discarded:'s-discarded' };
  return m[s] || 's-default';
}

// ── SCORE BADGE ──
function scoreBadge(score, raw) {
  if (!score) return '<span class="score-badge score-none">—</span>';
  const cls = score >= 4.1 ? 'score-high' : score >= 3.0 ? 'score-mid' : 'score-low';
  return '<span class="score-badge ' + cls + '">' + raw + '</span>';
}

// ── METRICS ──
function renderMetrics(apps) {
  const total = apps.length;
  const byStatus = {};
  let totalScore = 0, scored = 0, topScore = 0, withPDF = 0;
  for (const a of apps) {
    byStatus[a.status] = (byStatus[a.status]||0)+1;
    if (a.score > 0) { totalScore += a.score; scored++; topScore = Math.max(topScore, a.score); }
    if (a.hasPDF) withPDF++;
  }
  const avg = scored ? (totalScore/scored).toFixed(2) : '—';
  const items = [
    { val: total, label: 'Total', cls: 'accent' },
    { val: byStatus['Applied']||0, label: 'Applied', cls: 'accent2' },
    { val: byStatus['Evaluated']||0, label: 'Evaluated', cls: '' },
    { val: byStatus['Interview']||0, label: 'Interview', cls: 'green' },
    { val: byStatus['SKIP']||0, label: 'Skip', cls: '' },
    { val: avg, label: 'Avg Score', cls: 'yellow' },
    { val: topScore ? topScore.toFixed(1) : '—', label: 'Top Score', cls: 'green' },
    { val: withPDF, label: 'With PDF', cls: '' },
  ];
  document.getElementById('metrics').innerHTML = items.map(i =>
    '<div class="metric"><div class="metric-val ' + i.cls + '">' + i.val + '</div><div class="metric-label">' + i.label + '</div></div>'
  ).join('');
}

// ── FILTER TABS ──
function renderTabs(apps) {
  const statuses = ['All', ...new Set(apps.map(a => a.status))].sort((a,b) => {
    const order = ['All','Applied','Interview','Offer','Responded','Evaluated','SKIP','Rejected','Discarded'];
    return (order.indexOf(a)||99) - (order.indexOf(b)||99);
  });
  document.getElementById('filter-tabs').innerHTML = statuses.map(s => {
    const count = s === 'All' ? apps.length : apps.filter(a => a.status === s).length;
    return '<button class="tab ' + (s===activeFilter?'active':'') + '" onclick="setFilter(\\''+s+'\\')">' + s + ' <span style="opacity:0.6">'+count+'</span></button>';
  }).join('');
}

function setFilter(s) { activeFilter = s; applyFilters(); }

// ── SORT ──
function sortBy(key) {
  if (sortKey === key) sortAsc = !sortAsc; else { sortKey = key; sortAsc = true; }
  applyFilters();
}

// ── APPLY FILTERS ──
function applyFilters() {
  const q = document.getElementById('search').value.toLowerCase();
  let filtered = allApps.filter(a => {
    if (activeFilter !== 'All' && a.status !== activeFilter) return false;
    if (!q) return true;
    return [a.company, a.role, a.notes, a.status].some(f => f && f.toLowerCase().includes(q));
  });

  filtered.sort((a,b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    return 0;
  });

  renderTable(filtered);
  renderTabs(allApps);
}

// ── TABLE ──
function renderTable(apps) {
  const tbody = document.getElementById('tbody');
  const noRows = document.getElementById('no-rows');
  if (!apps.length) { tbody.innerHTML = ''; noRows.style.display = ''; return; }
  noRows.style.display = 'none';
  tbody.innerHTML = apps.map(a => {
    const sel = a.id === selectedId ? 'selected' : '';
    const notesShort = a.notes.length > 60 ? a.notes.slice(0,57)+'…' : a.notes;
    return '<tr class="'+sel+'" onclick="selectApp('+a.id+')" data-id="'+a.id+'">'+
      '<td class="td-num">'+a.num+'</td>'+
      '<td class="td-date">'+a.date+'</td>'+
      '<td class="td-company">'+esc(a.company)+'</td>'+
      '<td class="td-role" title="'+esc(a.role)+'">'+esc(a.role)+'</td>'+
      '<td>'+scoreBadge(a.score, a.scoreRaw)+'</td>'+
      '<td><span class="status-pill '+statusClass(a.status)+'">'+a.status+'</span></td>'+
      '<td class="pdf-icon">'+(a.hasPDF ? '<span title="PDF available" style="color:var(--green);cursor:pointer" onclick="event.stopPropagation();openPDFForApp('+a.id+')">📄</span>' : '<span style="color:var(--border)">—</span>')+'</td>'+
      '<td style="color:var(--muted);font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.notes)+'">'+esc(notesShort)+'</td>'+
    '</tr>';
  }).join('');
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── SELECT APP ──
async function selectApp(id) {
  selectedId = id;
  const app = allApps.find(a => a.id === id);
  if (!app) return;

  // Update selected row highlight
  document.querySelectorAll('tbody tr').forEach(r => r.classList.toggle('selected', parseInt(r.dataset.id) === id));

  // Open panel
  document.getElementById('panel').classList.add('open');
  document.getElementById('panel-title').textContent = app.company;
  document.getElementById('panel-sub').textContent = app.role + (app.date ? ' · ' + app.date : '');

  // Actions
  const actions = document.getElementById('panel-actions');
  let html = '';
  if (app.jobURL) html += '<a href="'+esc(app.jobURL)+'" target="_blank" class="btn">🔗 Job URL</a>';
  if (app.hasPDF) html += '<button class="btn primary" onclick="openPDFForApp('+id+')">📄 Resume</button>';
  html += '<select class="status-select" onchange="changeStatus('+id+', this.value)">'+
    CANONICAL_STATUSES.map(s => '<option value="'+s+'"'+(s===app.status?' selected':'')+'>'+s+'</option>').join('')+
  '</select>';
  actions.innerHTML = html;

  // Load report
  const md = document.getElementById('panel-md');
  if (app.reportPath) {
    md.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading report…</div>';
    try {
      const res = await fetch('/api/report?path=' + encodeURIComponent(app.reportPath));
      const data = await res.json();
      md.innerHTML = data.html;
    } catch {
      md.innerHTML = '<div style="color:var(--red)">Failed to load report.</div>';
    }
  } else {
    md.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">No report file linked.</div>';
    if (app.notes) md.innerHTML += '<p class="md" style="margin-top:8px;color:var(--text);font-size:12px">'+esc(app.notes)+'</p>';
  }
}

function closePanel() {
  document.getElementById('panel').classList.remove('open');
  selectedId = null;
  document.querySelectorAll('tbody tr').forEach(r => r.classList.remove('selected'));
}

// ── STATUS CHANGE ──
async function changeStatus(id, newStatus) {
  const app = allApps.find(a => a.id === id);
  if (!app || !app.reportNum) { alert('Cannot update status — no report number.'); return; }
  const res = await fetch('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportNum: app.reportNum, status: newStatus })
  });
  const data = await res.json();
  if (data.ok) { app.status = newStatus; applyFilters(); }
  else alert('Error: ' + data.error);
}

// ── PDF ──
function openPDFForApp(id) {
  const app = allApps.find(a => a.id === id);
  if (!app) return;
  // Try to find matching PDF by company slug
  const slug = app.company.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  fetch('/api/pdfs').then(r=>r.json()).then(pdfs => {
    const match = pdfs.find(p => p.name.includes(slug)) || (pdfs.length ? pdfs[0] : null);
    if (match) openPDFModal(match.url, match.label);
    else alert('No PDF found for this application.');
  });
}

function openPDFModal(url, title) {
  document.getElementById('pdf-modal-title').textContent = title || 'Resume';
  document.getElementById('pdf-embed').src = url;
  document.getElementById('pdf-download').href = url;
  document.getElementById('pdf-download').download = url.split('/').pop();
  document.getElementById('pdf-modal').classList.add('open');
}

function closePDFModal() {
  document.getElementById('pdf-modal').classList.remove('open');
  document.getElementById('pdf-embed').src = '';
}

// ── RESUMES PANEL ──
function showResumes() {
  fetch('/api/pdfs').then(r=>r.json()).then(pdfs => {
    const win = window.open('', '_blank', 'width=900,height=700');
    win.document.write('<html><head><title>Resumes</title><style>body{background:#0f1117;color:#e2e4f0;font-family:system-ui;padding:20px}h2{margin-bottom:16px;color:#7c6af7}.list{display:flex;flex-direction:column;gap:8px}.item{background:#1a1d27;border:1px solid #2e3147;border-radius:8px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between}.name{font-size:13px;font-weight:500}.btns{display:flex;gap:8px}a{padding:6px 12px;border-radius:6px;border:none;font-size:12px;cursor:pointer;text-decoration:none;background:#7c6af7;color:#fff}</style></head><body>');
    win.document.write('<h2>📄 All Resumes</h2><div class="list">');
    for (const p of pdfs) {
      win.document.write('<div class="item"><div class="name">'+p.label+'</div><div class="btns"><a href="'+p.url+'" target="_blank">View</a><a href="'+p.url+'" download="'+p.name+'">Download</a></div></div>');
    }
    win.document.write('</div></body></html>');
  });
}

// ── SSE LIVE UPDATES ──
function connectSSE() {
  const evtSource = new EventSource('/api/events');
  evtSource.addEventListener('refresh', () => {
    loadData();
    document.getElementById('live-label').textContent = 'Updated ' + new Date().toLocaleTimeString();
  });
  evtSource.onerror = () => {
    document.querySelector('.live-dot').style.background = 'var(--red)';
    setTimeout(connectSSE, 3000);
  };
}

// ── LOAD DATA ──
async function loadData() {
  try {
    const res = await fetch('/api/apps');
    allApps = await res.json();
    renderMetrics(allApps);
    applyFilters();
    // Re-select if panel was open
    if (selectedId) {
      const app = allApps.find(a => a.id === selectedId);
      if (app) selectApp(selectedId);
    }
  } catch (e) {
    console.error('Failed to load apps', e);
  }
}

// ── KEYBOARD ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePanel(); closePDFModal(); }
  if (e.key === '/' && !e.ctrlKey) { e.preventDefault(); document.getElementById('search').focus(); }
});

// ── INIT ──
loadData();
connectSSE();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

function startServer(port) {
  server.listen(port, () => {
    console.log(`\n🚀 Career Ops Dashboard running at http://localhost:${port}\n`);
    import('child_process').then(({ exec }) => {
      exec(`start http://localhost:${port}`);
    }).catch(() => {});
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} in use, trying ${port + 1}...`);
      server.close();
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

startServer(PORT);
