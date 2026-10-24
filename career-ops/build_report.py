#!/usr/bin/env python3
# Builds an HTML job-search analysis report from gog Gmail label dumps.
import re, collections, html, datetime

def load(p):
    return [l.split('\t') for l in open(p, encoding='utf-8', errors='replace').read().splitlines()
            if l and not l.startswith('ID') and '\t' in l]

sub = load('lbl_Submissions.txt')
rej = load('lbl_Rejections.txt')

def company(r):
    fr = r[2] if len(r) > 2 else ''
    s = r[3] if len(r) > 3 else ''
    m = re.search(r'application was sent to (.+)$', s)
    if m: return m.group(1).strip()
    m = re.search(r'(?i)applying to (.+?)[!\.,:]*$', s)
    if m: return m.group(1).strip()
    nm = re.match(r'"?([^<"]+?)"?\s*<', fr)
    return (nm.group(1).strip() if nm else fr.split('@')[0]).strip()

# ---- source split ----
src = collections.Counter()
for r in sub:
    fr = r[2].lower() if len(r) > 2 else ''
    if 'linkedin' in fr: src['LinkedIn Easy Apply'] += 1
    elif 'greenhouse' in fr: src['Greenhouse'] += 1
    elif 'workday' in fr or 'myworkday' in fr: src['Workday'] += 1
    elif 'ashby' in fr: src['Ashby'] += 1
    elif 'icims' in fr: src['iCIMS'] += 1
    elif 'lever' in fr: src['Lever'] += 1
    elif 'jobvite' in fr: src['Jobvite'] += 1
    elif 'indeed' in fr: src['Indeed'] += 1
    else: src['Other / direct'] += 1

# ---- staffing agencies ----
AGENCY = ['robert half','randstad','kforce','insight global','teksystems','dexian','aaratech',
'aara tech','american technology consulting','helic','crossing hurdles','joveo','beacon hill',
'michael page','jobot','tier4','medix','cybercoders','motion recruitment','russell tobin',
'collabera','diverse lynx','mindlance','compunnel','synergisticit','staffing','recruit','talent',
'consulting','infotech','emonics','net2source','<TARGET_COMPANY>','hiretalent','ask consulting','manha',
'madison-davis','cynet','intellectt','primary talent','world insurance','solutions llc','tek ']
def is_agency(c):
    cl = c.lower()
    return any(a in cl for a in AGENCY)
agc = collections.Counter()
for r in sub:
    c = company(r)
    if c and is_agency(c) and 'recruiting' != c.lower() and len(c) > 2:
        agc[c.strip()] += 1
agency_total = sum(agc.values())

# ---- roles & seniority ----
text = ' || '.join((r[3] if len(r) > 3 else '') for r in sub).lower()
fam = {'Data Analyst': r'data analyst',
'Business / Reporting Analyst': r'business analyst|reporting analyst|reporting',
'BI / Analytics Eng': r'business intelligence|bi analyst|bi developer|analytics engineer|tableau|power bi',
'Data Engineer': r'data engineer',
'Data Scientist': r'data scientist',
'Financial Analyst': r'financial analyst'}
rolec = {k: len(re.findall(v, text)) for k, v in fam.items()}
sen = {'Mid / Level II-III': r'analyst ii|analyst iii| ii | iii ',
'Senior / Sr': r'senior|sr\.| sr ',
'Lead / Principal / Staff': r'lead|principal|staff',
'Junior / Entry / Associate': r'junior|entry|associate|jr\.',
'Manager / Director': r'manager|director|head of'}
senc = {k: len(re.findall(v, text)) for k, v in sen.items()}

# ---- rejections w/ role ----
def rj(r):
    s = r[3] if len(r) > 3 else ''
    co = ''
    m = re.search(r'(?i)(?:application|applying)(?: to| for| with| status)?\s+(?:the role of |the )?(.+?)$', s)
    raw = m.group(1).strip(' .!:') if m else s.strip()
    role = ''
    rm = re.search(r'(?i)(data analyst[^,@]*|business (?:data )?analyst[^,@]*|analyst[^,@]*|data engineer[^,@]*|data scien[^,@]*|pricing[^,@]*)', s)
    if rm: role = rm.group(1).strip(' .!:')[:48]
    cm = re.search(r'(?i)(?:at|with)\s+([^,]+?)$', s)
    if cm: co = cm.group(1).strip(' .!:')[:40]
    return (r[1][:10], html.escape(co), html.escape(role), html.escape(s[:90]))
rejrows = [rj(r) for r in sorted(rej, key=lambda x: x[1])]

# ---- KPIs ----
total = len(sub)
ds = sorted(r[1][:10] for r in sub if len(r) > 1)
days = (datetime.date.fromisoformat(ds[-1]) - datetime.date.fromisoformat(ds[0])).days or 1
per_day = round(total / days, 1)
rejn = len(rej)
rejpct = round(rejn / total * 100, 1)
uniq = len(set(company(r).lower() for r in sub if company(r)))

def bar(label, val, mx, color):
    w = int(val / mx * 100) if mx else 0
    return f'<div class="row"><span class="lbl">{html.escape(label)}</span><span class="track"><span class="fill" style="width:{w}%;background:{color}"></span></span><span class="num">{val}</span></div>'

mxr = max(rolec.values()) or 1
mxs = max(senc.values()) or 1
mxsrc = max(src.values()) or 1

role_bars = ''.join(bar(k, v, mxr, '#2563eb') for k, v in sorted(rolec.items(), key=lambda x: -x[1]))
sen_bars = ''.join(bar(k, v, mxs, '#7c3aed') for k, v in sorted(senc.items(), key=lambda x: -x[1]))
src_bars = ''.join(bar(k, v, mxsrc, '#0891b2') for k, v in src.most_common())

agency_rows = ''.join(
    f'<tr><td>{html.escape(k)}</td><td class="c">{v}</td></tr>'
    for k, v in agc.most_common(40))

rej_rows = ''.join(
    f'<tr><td class="d">{d}</td><td>{co or "&mdash;"}</td><td>{role or "&mdash;"}</td></tr>'
    for d, co, role, raw in rejrows)

today = datetime.date.today().isoformat()

HTML = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>
@page {{ size: A4; margin: 14mm 12mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color:#1e293b; font-size:11px; line-height:1.45; margin:0; }}
h1 {{ font-size:23px; margin:0 0 2px; color:#0f172a; }}
h2 {{ font-size:14px; margin:22px 0 8px; color:#0f172a; border-bottom:2px solid #2563eb; padding-bottom:4px; }}
.sub {{ color:#64748b; font-size:11px; margin-bottom:14px; }}
.kpis {{ display:flex; gap:8px; flex-wrap:wrap; margin:14px 0; }}
.kpi {{ flex:1; min-width:90px; background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:10px 12px; }}
.kpi .v {{ font-size:22px; font-weight:700; color:#2563eb; }}
.kpi .k {{ font-size:9.5px; color:#64748b; text-transform:uppercase; letter-spacing:.04em; }}
.kpi.warn .v {{ color:#dc2626; }}
table {{ width:100%; border-collapse:collapse; margin:6px 0 0; }}
th,td {{ text-align:left; padding:4px 7px; border-bottom:1px solid #e2e8f0; font-size:10px; }}
th {{ background:#f8fafc; font-size:9px; text-transform:uppercase; letter-spacing:.03em; color:#475569; }}
td.c,th.c {{ text-align:center; }}
td.d {{ color:#64748b; white-space:nowrap; font-variant-numeric:tabular-nums; }}
.row {{ display:flex; align-items:center; gap:8px; margin:3px 0; }}
.row .lbl {{ width:155px; font-size:10px; }}
.row .track {{ flex:1; height:13px; background:#f1f5f9; border-radius:4px; overflow:hidden; }}
.row .fill {{ display:block; height:100%; }}
.row .num {{ width:34px; text-align:right; font-weight:600; font-size:10px; }}
.callout {{ background:#fef2f2; border-left:4px solid #dc2626; padding:9px 12px; border-radius:0 6px 6px 0; margin:10px 0; }}
.callout.ok {{ background:#f0fdf4; border-left-color:#16a34a; }}
.cols {{ display:flex; gap:18px; }}
.cols > div {{ flex:1; }}
ul {{ margin:6px 0; padding-left:18px; }} li {{ margin:3px 0; }}
.note {{ font-size:9px; color:#94a3b8; font-style:italic; }}
.tbl-wrap {{ column-count:2; column-gap:18px; }}
.foot {{ margin-top:18px; font-size:8.5px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:6px; }}
</style></head><body>

<h1>Job Search Analysis &mdash; Work Inbox</h1>
<div class="sub">Mailbox: <YOUR_EMAIL> &nbsp;&middot;&nbsp; Source: Gmail labels (Submissions, Rejections) &nbsp;&middot;&nbsp; Window: {ds[0]} &rarr; {ds[-1]} ({days} days) &nbsp;&middot;&nbsp; Generated {today}</div>

<div class="kpis">
<div class="kpi"><div class="v">{total}</div><div class="k">Total Submissions</div></div>
<div class="kpi"><div class="v">{per_day}</div><div class="k">Apps / day</div></div>
<div class="kpi"><div class="v">~{uniq}</div><div class="k">Distinct senders</div></div>
<div class="kpi warn"><div class="v">{rejn}</div><div class="k">Rejections ({rejpct}%)</div></div>
<div class="kpi warn"><div class="v">{agency_total}</div><div class="k">Agency apps</div></div>
</div>

<div class="callout">
<b>Headline:</b> {per_day} applications/day &mdash; high-volume spray. {src['LinkedIn Easy Apply']} of {total} ({round(src['LinkedIn Easy Apply']/total*100)}%) were LinkedIn Easy Apply. {agency_total} submissions went to staffing agencies / consulting body-shops (not direct employers). Rejection rate {rejpct}%; interviews/assessments remain in single digits &mdash; the volume is drowning fit.
</div>

<h2>Where applications went</h2>
{src_bars}

<div class="cols">
<div>
<h2>Roles applied to</h2>
{role_bars}
<div class="note">Counts = role keyword in confirmation subject. Many ATS emails omit the role, so these are a lower bound. Data Analyst is clearly dominant.</div>
</div>
<div>
<h2>Seniority signals</h2>
{sen_bars}
<div class="note">From title keywords. Spread across mid (II/III), lead, and entry &mdash; an unfocused seniority band can hurt match quality.</div>
</div>
</div>

<h2>Staffing agencies &amp; consulting body-shops applied to ({len(agc)} firms, {agency_total} submissions)</h2>
<div class="note">These firms re-list the same reqs and harvest resumes. They rarely convert to direct hires. Top 40 by volume:</div>
<table><tr><th>Agency / staffing firm</th><th class="c">Apps</th></tr>{agency_rows}</table>

<h2>Rejections ({rejn})</h2>
<div class="tbl-wrap">
<table><tr><th class="d">Date</th><th>Company</th><th>Role</th></tr>{rej_rows}</table>
</div>

<h2>Recommendations</h2>
<div class="callout ok">
<ul>
<li><b>Cut volume, raise fit.</b> Drop from ~{per_day}/day to ~5 tailored direct-employer applications/day.</li>
<li><b>Stop blind agency applies.</b> {agency_total} submissions to {len(agc)} staffing firms produced little. Keep at most 1&ndash;2 recruiter relationships that actually responded.</li>
<li><b>De-duplicate.</b> Several employers were applied to 2&ndash;3&times;; never reapply to a rejected company (full list above).</li>
<li><b>Focus the title band.</b> Lead with Data Analyst (mid-level); avoid simultaneously chasing entry + lead roles.</li>
<li><b>Work the live queue first</b> &mdash; outstanding assessments/interviews before chasing new postings.</li>
<li><b>Filter scam senders</b> (example-company.com, jobright.ai upsells).</li>
</ul>
</div>

<div class="foot">Auto-generated from Gmail labels via gog CLI. Role/seniority figures are subject-line estimates and undercount emails that omit the title. Rejections = messages tagged "Rejections".</div>
</body></html>"""

open('job_search_report.html', 'w', encoding='utf-8').write(HTML)
print('wrote job_search_report.html', len(HTML), 'bytes; agencies', len(agc), 'rej', rejn)
