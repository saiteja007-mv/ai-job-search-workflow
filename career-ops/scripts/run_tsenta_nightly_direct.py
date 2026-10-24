#!/usr/bin/env python3
import json, math, os, re, subprocess, sys, time
from collections import Counter
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# Hermes MCP direct client imports
sys.path.insert(0, "/home/<YOU>/.hermes/hermes-agent")
try:  # current Hermes layout; tools.mcp_tool is a deprecated compat shim slated for removal
    from tools.mcp_tool_discovery import discover_mcp_tools  # noqa:E402
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers  # noqa:E402
except ImportError:
    from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers  # noqa:E402
from tools.registry import registry  # noqa:E402

ROOT = Path('/home/<YOU>/career-ops')
TODAY = datetime.now(ZoneInfo('<YOUR_TZ>')).date().isoformat()
RUN_TAG = os.environ.get('TSENTA_RUN_TAG', 'nightly')
APPS_JSON = ROOT / 'data' / f'tsenta-applications-{TODAY}-{RUN_TAG}.json'
REPORT_MD = ROOT / 'reports' / f'tsenta-{RUN_TAG}-{TODAY}.md'
# Separate path so a same-day preview (TSENTA_DRY_RUN=1) can never overwrite
# a completed real run's report for the day.
DRYRUN_REPORT_MD = ROOT / 'reports' / f'tsenta-{RUN_TAG}-{TODAY}-dryrun.md'

AI_TERMS = re.compile(r'\b(ai|artificial intelligence|machine learning|ml|data scientist|data science|deep learning|nlp|llm|gen(erative)? ai|mlops|applied scientist|recommendation|computer vision|automation engineer)\b', re.I)
SWE_TITLE = re.compile(
    r'\b(software (engineer|developer)|swe|data engineer|analytics engineer|data analyst|'
    r'full[- ]?stack|back[- ]?end|platform engineer|python (engineer|developer)|'
    r'cloud engineer|devops engineer|forward deployed engineer|ai engineer|ml engineer|'
    r'machine learning engineer|applied scientist)\b',
    re.I,
)
BAD_TITLE = re.compile(
    r'\b(senior|sr\.?|lead|staff|principal|director|managers?|architect|sales|account|support|'
    r'solution(s)? architect|field application|intern(ship)?|temporary|contract|'
    r'2027|new[- ]?grad(uate)?|ph\.?d|fellow(ship)?|unpaid|volunteer|student(s)?|cohort|visiting|'
    r'mechanical|recruit(er|ing)|talent acquisition|university program|bilingual|'
    r'postdoc(toral)?|orbit program|gtm|fleet|interview on|hiring event|talent community|'
    r'expression of interest|campus|federal|public\s+sector)\b',
    re.I,
)
# Level gate (2026-09-26 gap: <COMPANY_O> "Engineer 4" roles above his level slipped
# through). Blocks a level of IV/4+ written right after a role word; I/II/III/1/2/3
# still pass. Anchored to the role word so it never fires on "Web3"/"4G".
# Off-archetype titles that slip through SWE/AI title matches (profile hard-rejects mobile/frontend).
OFF_PROFILE_TITLE = re.compile(r'\b(ios|android|mobile|front[- ]?end|counsel|paralegal|legal|clinical|nurse|teacher|coordinator|specialist|technician)\b', re.I)
BAD_LEVEL = re.compile(
    r'\b(engineer|scientist|developer|analyst)\s+(4|5|6|7|8|9|10|IV|V|VI|VII|VIII|IX|X)\b',
    re.I,
)
# The `us citizens?/green cards?` clause (either order, plural, loose
# spacing around the slash) closes a verified live gap (2026-09-25): a
# title/status-bar reading "US Citizens/ Green Cards- Local to DMV only"
# fell through every other clause because it has no adjacent
# required/only qualifier on "citizens"/"cards" themselves -- the slash
# pairing IS the requirement, so no qualifier is needed to hard-block it.
BAD_TEXT = re.compile(r'\b(us\s*citizen(ship)?\s*(is\s*)?(required|only)|must\s+be\s+a\s+u\.?s\.?\s+citizen|active\s+(secret|top secret|ts[/\\\s]*sci|security)\s+clearance|secret\s+clearance\s+(required|needed)|top\s+secret\s+clearance|ts[/\\\s]*sci|ci\s+poly(graph)?|polygraph\s+(required|needed)|itar|export\s+control(led)?|u\.?s\.?\s+person(s)?\s+(only|required)|permanent\s+resident\s+or\s+u\.?s\.?\s+citizen|\busc\s*/\s*gc\b|\busc\s+or\s+gc\b|green\s+card\s+(required|only)|\bus\s+citizens?\s*/\s*green\s+cards?\b|\bgreen\s+cards?\s*/\s*us\s+citizens?\b)\b', re.I)
# 2026-09-26 gap (<COMPANY_AA> "...DoD Security Clearance"): bare
# clearance/public-trust mentions with no adjacent required/active qualifier.
# Kept OUT of BAD_TEXT and checked separately (see _has_bare_clearance_risk)
# because these bare phrases are the ones a JD can flip with a negation a few
# words earlier ("does not require a security clearance") -- a fixed-width
# regex lookbehind can't reach across the variable gap, so a real word scan
# of the text before the match is needed instead.
BAD_TEXT_BARE_CLEARANCE = re.compile(
    r'\b((dod|doe|government|federal|security)\s+clearance|clearance\s+(required|eligib\w*|preferred)|'
    r'public\s+trust|secret\s+clearance)\b', re.I)
_CLEARANCE_NEGATION_RE = re.compile(r'\b(no|not|n\'t|without|never|non)\b', re.I)

def _has_bare_clearance_risk(text):
    for m in BAD_TEXT_BARE_CLEARANCE.finditer(text):
        # look back a few words (not just adjacent) for a negation --
        # "does not require a security clearance" has two words between
        # "not" and the matched phrase.
        window = text[max(0, m.start() - 40):m.start()]
        if not _CLEARANCE_NEGATION_RE.search(window):
            return True
    return False
BAD_COMPANIES = re.compile(
    r'\b(northrop|lockheed|raytheon|nightwing|booz|leidos|general dynamics|general atomics|'
    r'l3harris|anduril|palantir|bae systems|peraton|caci|saic|sierra nevada|<past_employer_2> federal|'
    r'credence|rtx|idt|innovative defense|spacex|nuclear company|nextgen federal systems|'
    r'applied research lab(oratory)?|penn state(\s+university)?\W+arl|arl\W+penn state|'
    r'asrc|draper|guidehouse|chenega|cathexis|company_aa)\b',
    re.I,
)
# Pack-only balance (all remaining credits are pack credits) reports
# monthly.cycleEnd=null, so the drain branch never fired and the run fell back
# to the 100 cap. The authoritative cycle end is locked here; once it passes,
# a null cycleEnd falls through to the normal 100 cap again.
LOCKED_CYCLE_END = datetime(2026, 9, 13, 20, 34, 53, tzinfo=timezone.utc)

# Injectable clock/sleep so tests can drive the apply loop without real waits
# (tests monkeypatch these two module attributes directly).
def _now_utc():
    return datetime.now(timezone.utc)

def _sleep(seconds):
    time.sleep(seconds)

def mcp_call(tool_suffix, args):
    name = 'mcp__tsenta__' + tool_suffix
    # Native MCP discovery can return before the HTTP server's tools are fully
    # registered in headless cron. Wait briefly instead of failing the run with
    # a transient KeyError.
    for _ in range(30):
        if name in registry._tools:
            break
        try:
            discover_mcp_tools()
        except Exception:
            pass
        time.sleep(1)
    if name not in registry._tools:
        available = sorted(n for n in registry._tools.keys() if 'tsenta' in n.lower())
        raise RuntimeError(f'{name}: tool not registered after discovery; available_tsenta_tools={available[:20]}')
    raw = registry._tools[name].handler(args)
    obj = json.loads(raw)
    if 'error' in obj:
        raise RuntimeError(f'{name}: {obj["error"]}')
    sc = obj.get('structuredContent')
    if isinstance(sc, dict) and 'result' in sc:
        return sc['result']
    res = obj.get('result')
    if isinstance(res, str):
        try:
            return json.loads(res)
        except Exception:
            return res
    return res

def parse_dt(s):
    if not s: return None
    try:
        return datetime.fromisoformat(str(s).replace('Z','+00:00'))
    except Exception:
        return None

def get_app_time(app):
    for k in ('appliedAt','createdAt','submittedAt','updatedAt'):
        dt = parse_dt(app.get(k))
        if dt: return dt.astimezone(timezone.utc)
    return None

def normalize_apps(resp):
    if isinstance(resp, dict):
        for key in ('applications','apps','rows','items'):
            if isinstance(resp.get(key), list):
                return resp[key]
        if isinstance(resp.get('result'), dict):
            return normalize_apps(resp['result'])
    return []

def list_apps(limit=100, all_pages=False, since_dt=None):
    # since_dt: stop paginating once a page reaches rows older than it. list_applications is
    # newest-first (verified live 2026-09-25: non-increasing createdAt within and across pages;
    # 3,466 rows = 35 pages at limit 100), so everything created at/after since_dt is loaded.
    first = mcp_call('list_applications', {'filter':'all','limit':limit,'page':1,'includeCounts':True})
    if not all_pages:
        return first

    apps = normalize_apps(first)
    pagination = first.get('pagination') if isinstance(first, dict) else {}
    total_pages = int((pagination or {}).get('totalPages') or 1)
    for page in range(2, total_pages + 1):
        if since_dt is not None and apps and get_app_time(apps[-1]) and get_app_time(apps[-1]) < since_dt:
            break
        resp = mcp_call('list_applications', {'filter':'all','limit':limit,'page':page,'includeCounts':False})
        apps.extend(normalize_apps(resp))

    merged = dict(first) if isinstance(first, dict) else {}
    merged['applications'] = apps
    merged['pagination'] = {**(pagination or {}), 'page': 1, 'limit': limit, 'totalPages': total_pages, 'loaded': len(apps)}
    return merged

def is_optimized_app(a):
    return bool(a.get('optimized') or a.get('isOptimized') or a.get('useOptimizedResume'))

def write_credits(balance):
    if not isinstance(balance, dict):
        return
    data = dict(balance)
    data['updated'] = datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    data['source'] = 'tsenta get-application-balance (mirrored by nightly Tsenta job)'
    (ROOT/'data'/'tsenta-credits.json').write_text(json.dumps(data, indent=2))

def refresh_dashboard(apps_resp):
    apps = normalize_apps(apps_resp)
    counts = Counter((a.get('status') or '').upper() for a in apps)
    today_ct = 0
    opt_ct = 0
    out = []
    today_local = datetime.now(ZoneInfo('<YOUR_TZ>')).date()
    for a in apps:
        dt = get_app_time(a)
        if dt and dt.astimezone(ZoneInfo('<YOUR_TZ>')).date() == today_local:
            today_ct += 1
        if is_optimized_app(a):
            opt_ct += 1
        out.append({
            'appId': a.get('appId') or a.get('id') or a.get('applicationId'),
            'appliedAt': a.get('appliedAt') or a.get('createdAt') or a.get('submittedAt'),
            'atsType': a.get('atsType'),
            'company': a.get('company') or a.get('companyName'),
            'optimized': is_optimized_app(a),
            'status': a.get('status'),
            'title': a.get('title') or a.get('jobTitle'),
            'url': a.get('url') or a.get('jobUrl'),
        })

    source_counts = apps_resp.get('counts') if isinstance(apps_resp, dict) else None
    summary = {
        'total': int(source_counts.get('all', len(apps))) if isinstance(source_counts, dict) else len(apps),
        'submitted': int(source_counts.get('submitted', counts.get('COMPLETED',0))) if isinstance(source_counts, dict) else counts.get('COMPLETED',0),
        'failed': int(source_counts.get('failed', counts.get('FAILED',0))) if isinstance(source_counts, dict) else counts.get('FAILED',0),
        'skipped': int(source_counts.get('skipped', counts.get('SKIPPED',0))) if isinstance(source_counts, dict) else counts.get('SKIPPED',0),
        'in_flight': int(source_counts.get('in_flight', 0)) if isinstance(source_counts, dict) else sum(v for k,v in counts.items() if k not in {'COMPLETED','FAILED','SKIPPED'}),
        'needs_approval': int(source_counts.get('needs', 0)) if isinstance(source_counts, dict) else 0,
        'today': today_ct,
        'optimized': opt_ct,
    }
    data = {
        'updated': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
        'summary': summary,
        'apps': out,
    }
    (ROOT/'data'/'tsenta-apps.json').write_text(json.dumps(data, indent=2))

# ---------------------------------------------------------------------------
# Day target: computed once per local calendar day, persisted, reused by any
# later run the same day so the target never shrinks/grows mid-day and
# successes are never double counted against a moving target.
# ---------------------------------------------------------------------------
def load_or_compute_day_target(today, compute_fn, stamp_dir=None):
    stamp_dir = stamp_dir or (ROOT / 'data')
    stamp_path = stamp_dir / f'tsenta-{today}-daytarget-stamp.json'
    if stamp_path.exists():
        try:
            data = json.loads(stamp_path.read_text())
            if 'target' in data:
                return data, stamp_path, True
        except Exception:
            pass
    data = dict(compute_fn())
    data['date'] = str(today)
    data['computed_at_utc'] = _now_utc().isoformat().replace('+00:00', 'Z')
    stamp_dir.mkdir(parents=True, exist_ok=True)
    stamp_path.write_text(json.dumps(data, indent=2))
    return data, stamp_path, False

def compute_deadline_utc(run_started_local, tz, env_val=None):
    if env_val is None:
        env_val = os.environ.get('TSENTA_DEADLINE_LOCAL', '').strip()
    if env_val:
        try:
            dt_local = datetime.fromisoformat(env_val) if ('T' in env_val or '-' in env_val) else None
            if dt_local is None:
                hh, mm = env_val.split(':')
                dt_local = run_started_local.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
                if dt_local <= run_started_local:
                    dt_local += timedelta(days=1)
            if dt_local.tzinfo is None:
                dt_local = dt_local.replace(tzinfo=tz)
            return dt_local.astimezone(timezone.utc)
        except Exception:
            pass
    dt_local = run_started_local.replace(hour=5, minute=30, second=0, microsecond=0)
    if dt_local <= run_started_local:
        dt_local += timedelta(days=1)
    return dt_local.astimezone(timezone.utc)

# ---------------------------------------------------------------------------
# Candidate sourcing / filtering
# ---------------------------------------------------------------------------
# Profile target titles (config/profile.yml target_roles + portals.yml title_filter), 2026-09-28.
PROFILE_TITLE_QUERIES = (
    'machine learning', 'data scientist', 'software engineer', 'data engineer',
    'machine learning engineer', 'ML engineer', 'AI engineer', 'AI/ML engineer', 'applied AI engineer',
    'applied machine learning', 'AI software engineer', 'software engineer machine learning',
    'software engineer AI', 'machine learning scientist', 'applied scientist', 'recommendation',
    'ranking', 'relevance', 'personalization', 'search engineer', 'generative AI', 'LLM', 'RAG',
    'AI agent', 'NLP engineer', 'computer vision', 'deep learning', 'MLOps', 'ML platform',
    'forward deployed engineer', 'AI developer', 'analytics engineer', 'python engineer',
    'backend engineer', 'software engineer early career', 'software engineer II',
)

def build_pulls(max_page=20):
    pulls = [
        {'limit':50,'page':1,'datePosted':'7d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True,'roleFamilies':['SOFTWARE_ENGINEERING','DATA_SCIENCE'],'maxYearsExperience':5},
        {'limit':50,'page':2,'datePosted':'7d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True,'roleFamilies':['SOFTWARE_ENGINEERING','DATA_SCIENCE'],'maxYearsExperience':5},
        {'limit':50,'page':1,'datePosted':'14d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True,'roleFamilies':['SOFTWARE_ENGINEERING','DATA_SCIENCE'],'maxYearsExperience':5,'search':'machine learning OR AI OR data scientist'},
        {'limit':50,'page':1,'datePosted':'14d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True,'maxYearsExperience':5,'search':'generative AI OR LLM OR MLOps'},
        {'limit':50,'page':1,'datePosted':'30d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True},
        {'limit':50,'page':2,'datePosted':'30d','jobTypes':['ENTRY_LEVEL','MID_LEVEL'],'locations':['country:US'],'autoApplyOnly':True},
    ]
    # Thin-feed drain: paginate deep into the unfiltered US feed (up to
    # max_page) plus role/title search variants, so pool exhaustion is
    # declared only after this deep sourcing pass, not before.
    pulls.extend(
        {'limit': 50, 'page': page, 'datePosted': 'all',
         'jobTypes': ['ENTRY_LEVEL', 'MID_LEVEL'],
         'locations': ['country:US'], 'autoApplyOnly': True}
        for page in range(1, max_page + 1)
    )
    pulls.extend(
        {'limit': 50, 'page': page, 'datePosted': 'all',
         'jobTypes': ['ENTRY_LEVEL', 'MID_LEVEL'],
         'locations': ['country:US'], 'autoApplyOnly': True, 'search': query}
        for query in PROFILE_TITLE_QUERIES
        for page in range(1, 4)
    )
    return pulls

def pull_with_retry(args, attempts=3, wait=5):
    # Tsenta's MCP drops the SSE stream now and then ("SSE stream ended without a
    # response"); one blip was costing a whole page of recommendations (Oct 2 and Oct 4).
    for n in range(attempts):
        try:
            return mcp_call('get_job_recommendations', args)
        except Exception:
            if n == attempts - 1:
                raise
            time.sleep(wait)

def source_pool(pulls, blockers):
    seen = {}
    for args in pulls:
        try:
            rec = pull_with_retry(args)
            for j in (rec.get('jobs', []) if isinstance(rec, dict) else []):
                if j.get('id') and j['id'] not in seen:
                    seen[j['id']] = j
        except Exception as e:
            blockers.append(f'recommendation pull failed after 3 attempts: {type(e).__name__}: {e}')
    return sorted(seen.values(), key=lambda j: (j.get('matchScore') or 0), reverse=True)

def fetch_details(candidates, blockers):
    details = {}
    ids = [j['id'] for j in candidates if j.get('id')]
    for i in range(0, len(ids), 20):
        batch = ids[i:i+20]
        try:
            det = mcp_call('get_jobs_by_ids', {'jobIds': batch, 'descriptionMaxChars': 8000})
            jobs = det.get('jobs') or det.get('items') or det.get('result') or []
            if isinstance(jobs, list):
                for d in jobs:
                    if d.get('id'):
                        details[d['id']] = d
        except Exception as e:
            blockers.append(f'JD fetch failed for batch {i//20+1}: {type(e).__name__}: {e}')
    return details

_EXTRA_COMPANY_BLOCKLIST_CACHE = None

def _find_key_recursive(obj, key):
    # extra_company_blocklist lives nested under pipeline_filter: in profile.yml,
    # not at the top level -- search the whole tree instead of assuming depth.
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = _find_key_recursive(v, key)
            if found is not None:
                return found
    return None

def load_extra_company_blocklist():
    # Cached for the process lifetime; profile.yml doesn't change mid-run.
    # Missing file/key/module -> empty list, silently (this is opt-in user config).
    global _EXTRA_COMPANY_BLOCKLIST_CACHE
    if _EXTRA_COMPANY_BLOCKLIST_CACHE is not None:
        return _EXTRA_COMPANY_BLOCKLIST_CACHE
    items = []
    try:
        import yaml
        cfg = yaml.safe_load((ROOT / 'config' / 'profile.yml').read_text())
        raw = _find_key_recursive(cfg, 'extra_company_blocklist') or []
        items = [str(x).strip().lower() for x in raw if str(x).strip()]
    except Exception:
        items = []
    _EXTRA_COMPANY_BLOCKLIST_CACHE = items
    return items

def filter_candidates(candidates, details, exclude_ids, skipped_reasons):
    eligible = []
    extra_blocklist = load_extra_company_blocklist()
    for j in candidates:
        jid = j.get('id'); title = j.get('title') or ''; company = j.get('companyName') or ''
        text_blob = json.dumps({**j, **(details.get(jid) or {})}, ensure_ascii=False)
        if not j.get('isSupportedAts'):
            skipped_reasons['unsupported ATS'] += 1; continue
        employment_type = str(j.get('employmentType') or '').upper()
        if employment_type in {'CONTRACT', 'TEMPORARY', 'PART_TIME', 'INTERNSHIP'}:
            skipped_reasons['bad employment type'] += 1; continue
        # SPONSORSHIP gate is a NON-ISSUE per config/profile.yml (~line 154):
        # <YOUR_NAME> is work-authorized (<VISA_STATUS>) and not asking anyone to
        # sponsor him. Never reject on NO_SPONSORSHIP (2026-09-25 fix).
        if BAD_TITLE.search(title) or BAD_LEVEL.search(title) or re.search(r'\bcampus\b', company, re.I):
            skipped_reasons['bad title/seniority'] += 1; continue
        company_lower = company.lower()
        if (BAD_COMPANIES.search(company) or BAD_TEXT.search(text_blob)
                or _has_bare_clearance_risk(text_blob)
                or any(b in company_lower for b in extra_blocklist)):
            skipped_reasons['citizenship/clearance/export-control risk'] += 1; continue
        if not (AI_TERMS.search(title) or SWE_TITLE.search(title)) or OFF_PROFILE_TITLE.search(title):
            skipped_reasons['not AI/ML enough'] += 1; continue
        if jid in exclude_ids:
            skipped_reasons['already attempted this cycle'] += 1; continue
        eligible.append(j)
    return eligible

# Workday/SmartRecruiters skips 8/8 PROFILE_INCOMPLETE last night (screening
# questions/EEO fields) -- deprioritize, don't exclude: stable sort keeps
# matchScore order within each group, just moves these two ATS types last.
_ATS_DEPRIORITIZE = {'workday', 'smartrecruiters'}

def _ats_sort_key(j):
    return 1 if str(j.get('atsType') or '').lower() in _ATS_DEPRIORITIZE else 0

# ---------------------------------------------------------------------------
# Live application accounting (local-day scoped)
# ---------------------------------------------------------------------------
def application_accounting(apps, today_local, tz, run_started_dt=None):
    completed_today, inflight_today, failed_today, skipped_today = [], [], [], []
    cycle_job_ids = set()
    for a in apps:
        jid = a.get('jobId')
        if jid:
            cycle_job_ids.add(jid)
        dt = get_app_time(a)
        # "Today" for the loop's own gap-closing decisions is the target's
        # calendar day (so a same-day rerun still counts earlier successes)
        # OR anything created during this run's own session (so a run that
        # crosses local midnight, which the nightly 22:00 schedule does by
        # design, doesn't lose its own post-midnight completions and keep
        # applying past the true remaining gap). A fresh run tomorrow has a
        # later run_started_dt of its own, so last night's tail stays
        # excluded from it.
        is_today = bool(dt and (
            dt.astimezone(tz).date() == today_local
            or (run_started_dt and dt >= run_started_dt)
        ))
        status = (a.get('status') or '').upper()
        if not is_today:
            continue
        if status == 'COMPLETED':
            completed_today.append(a)
        elif status == 'FAILED':
            failed_today.append(a)
        elif status == 'SKIPPED':
            skipped_today.append(a)
        else:
            inflight_today.append(a)
    return {
        'completed_today': completed_today,
        'inflight_today': inflight_today,
        'failed_today': failed_today,
        'skipped_today': skipped_today,
        'cycle_job_ids': cycle_job_ids,
    }

def approve_pending(run_started_at_utc, blockers, result):
    cutoff_dt = parse_dt(run_started_at_utc)
    for _round in range(4):
        try:
            needs_resp = mcp_call('list_applications', {'filter': 'needs', 'limit': 100, 'includeCounts': True})
            needs = (needs_resp or {}).get('applications') or []
            pending = [
                a for a in needs
                if (a.get('status') or '').upper() == 'PENDING_RESUME_REVIEW'
                and get_app_time(a) and cutoff_dt and get_app_time(a) >= cutoff_dt
            ]
            if not pending:
                break
            for a in pending:
                try:
                    mcp_call('approve_application', {'applicationId': a['applicationId']})
                    result['approve_calls'] += 1
                except Exception as e:
                    blockers.append(f"approve {a.get('applicationId')}: {type(e).__name__}: {e}")
            _sleep(8)
        except Exception as e:
            blockers.append(f'resume-review pass failed: {type(e).__name__}: {e}')
            break

# ---------------------------------------------------------------------------
# Success-loop: apply until `target` COMPLETED (or in-flight covering the
# gap) is reached, backfilling FAILED/SKIPPED refunds with replacements,
# until one of the stop conditions fires.
# ---------------------------------------------------------------------------
def apply_loop(*, target, total_before, today_local, tz, run_started_at_utc,
                deadline_utc, attempt_cap, dry_run, pulls, blockers, skipped_reasons):
    result = {
        'stop_reason': None,
        'attempts': 0,
        'attempted_ids': [],
        'selected_jobs': [],
        'successes_this_run': 0,
        'successes_today': 0,
        'in_flight_at_end': 0,
        'failed_refunded': 0,
        'skipped_refunded': 0,
        'pool_size': 0,
        'filter_skips': {},
        'would_apply': [],
        'apply_calls': 0,
        'approve_calls': 0,
        'final_apps': [],
        'pool_refreshes': 0,
    }

    run_started_dt = parse_dt(run_started_at_utc)
    day_start_utc = datetime(today_local.year, today_local.month, today_local.day, tzinfo=tz).astimezone(timezone.utc)
    poll_cutoff = min(day_start_utc, run_started_dt) if run_started_dt else day_start_utc

    def poll_apps():
        # Wrapped like the apply/balance calls right below: a transient
        # mcp_call failure here must not crash the whole run (uncaught, it
        # propagates out of apply_loop and out of main()'s bare
        # try/finally, losing the report, the Slack summary, and the
        # outreach step for whatever did complete). On failure, keep
        # polling on the next iteration instead of updating state from it.
        # Only rows since the earlier of local midnight and this run's start matter for the
        # success/in-flight accounting; the cycle-wide dedupe set (exclude_ids) is built once from
        # the full history below and never rebuilt from a poll. Paging all ~35 pages every 60s
        # for hours would be thousands of calls a night.
        try:
            return normalize_apps(list_apps(100, all_pages=True, since_dt=poll_cutoff))
        except Exception as e:
            blockers.append(f'list_applications poll failed: {type(e).__name__}: {e}')
            return None

    candidates = source_pool(pulls, blockers)
    details = fetch_details(candidates, blockers)

    all_apps = normalize_apps(list_apps(100, all_pages=True))
    acct = application_accounting(all_apps, today_local, tz, run_started_dt)
    exclude_ids = set(acct['cycle_job_ids'])
    eligible = filter_candidates(candidates, details, exclude_ids, skipped_reasons)
    eligible.sort(key=_ats_sort_key)

    result['pool_size'] = len(eligible)
    result['filter_skips'] = dict(skipped_reasons)
    result['successes_today'] = len(acct['completed_today'])
    result['in_flight_at_end'] = len(acct['inflight_today'])
    result['failed_refunded'] = len(acct['failed_today'])
    result['skipped_refunded'] = len(acct['skipped_today'])
    result['final_apps'] = all_apps

    if dry_run:
        gap = max(0, target - result['successes_today'] - result['in_flight_at_end'])
        result['would_apply'] = [
            {'id': j.get('id'), 'title': j.get('title'), 'company': j.get('companyName'), 'matchScore': j.get('matchScore')}
            for j in eligible[:gap]
        ]
        result['stop_reason'] = 'dry_run'
        return result

    if target <= 0 or result['successes_today'] >= target:
        result['stop_reason'] = 'target already zero' if target <= 0 else 'target reached'
        return result

    pool_iter_idx = 0
    balance_remaining = total_before

    # Root cause 2/3 (2026-09-26 stall): bounds for re-sourcing the pool once it
    # runs dry, and for giving up on in-flight rows that never move.
    MAX_POOL_REFRESHES = 3
    MIN_REFRESH_GAP = timedelta(minutes=20)
    STALL_TIMEOUT = timedelta(minutes=30)
    last_refresh_at = None
    in_flight_snapshot = None
    in_flight_snapshot_at = None

    while True:
        successes_today = len(acct['completed_today'])
        in_flight_today = len(acct['inflight_today'])
        result['successes_today'] = successes_today
        result['in_flight_at_end'] = in_flight_today
        result['failed_refunded'] = len(acct['failed_today'])
        result['skipped_refunded'] = len(acct['skipped_today'])
        gap = target - successes_today - in_flight_today

        # Stall detection: (applicationId, status) of every in-flight row. If this
        # is unchanged for STALL_TIMEOUT while the pool is exhausted, nothing is
        # going to move on its own (this is exactly last night's PENDING_RESUME_REVIEW/
        # CAPTCHA-retry freeze) -- track it every iteration, act on it only in the
        # wait branches below. A change (new row, resolved row, status flip) resets it.
        current_snapshot = frozenset((a.get('applicationId'), (a.get('status') or '').upper()) for a in acct['inflight_today'])
        if current_snapshot != in_flight_snapshot:
            in_flight_snapshot = current_snapshot
            in_flight_snapshot_at = _now_utc()

        if successes_today >= target:
            result['stop_reason'] = 'target reached'; break
        if _now_utc() >= deadline_utc:
            result['stop_reason'] = 'deadline'; break
        if result['attempts'] >= attempt_cap:
            result['stop_reason'] = 'attempt cap'; break
        if balance_remaining <= 0:
            result['stop_reason'] = 'balance exhausted'; break

        if gap > 0:
            remaining_pool = eligible[pool_iter_idx:]
            if not remaining_pool:
                # Root cause 2: re-source instead of idling on a pool built once at
                # start. Bounded (3 max, >=20 min apart) so a thin feed doesn't turn
                # into a hot-loop of get_job_recommendations calls.
                now = _now_utc()
                refresh_due = (
                    result['pool_refreshes'] < MAX_POOL_REFRESHES
                    and (last_refresh_at is None or now - last_refresh_at >= MIN_REFRESH_GAP)
                )
                refreshed_new = False
                if refresh_due:
                    result['pool_refreshes'] += 1
                    last_refresh_at = now
                    exclude_now = exclude_ids | set(result['attempted_ids']) | acct['cycle_job_ids']
                    fresh_candidates = source_pool(pulls, blockers)
                    new_ids = [j['id'] for j in fresh_candidates if j.get('id') and j['id'] not in details]
                    if new_ids:
                        details.update(fetch_details([{'id': i} for i in new_ids], blockers))
                    new_eligible = filter_candidates(fresh_candidates, details, exclude_now, skipped_reasons)
                    known_ids = {j['id'] for j in eligible}
                    added = [j for j in new_eligible if j['id'] not in known_ids]
                    if added:
                        added.sort(key=_ats_sort_key)
                        eligible.extend(added)
                        result['pool_size'] = len(eligible)
                        result['filter_skips'] = dict(skipped_reasons)
                        refreshed_new = True
                if refreshed_new:
                    continue
                # Root cause 1: apps land in PENDING_RESUME_REVIEW minutes after the
                # apply batch that created them (resume optimization) -- run approval
                # every wait iteration, not just right after an apply batch.
                approve_pending(run_started_at_utc, blockers, result)
                if in_flight_today > 0:
                    # Root cause 3: pool exhausted (refresh capped or found nothing)
                    # and in-flight hasn't moved in 30 min -> it never will on its own.
                    if in_flight_snapshot_at and now - in_flight_snapshot_at >= STALL_TIMEOUT:
                        result['stop_reason'] = 'in-flight stalled'; break
                    _sleep(60)
                    new_apps = poll_apps()
                    if new_apps is not None:
                        all_apps = new_apps
                        acct = application_accounting(all_apps, today_local, tz, run_started_dt)
                        result['final_apps'] = all_apps
                    continue
                result['stop_reason'] = 'candidate pool exhausted'; break
            allowance = attempt_cap - result['attempts']
            batch_size = max(0, min(gap, 20, len(remaining_pool), balance_remaining, allowance))
            if batch_size <= 0:
                result['stop_reason'] = 'attempt cap' if allowance <= 0 else 'balance exhausted'; break
            batch = remaining_pool[:batch_size]
            batch_ids = [j['id'] for j in batch]

            apply_ok = False
            try:
                mcp_call('apply_to_job', {'jobIds': batch_ids, 'optimizationModeOverride': 'HONEST'})
                result['apply_calls'] += 1
                apply_ok = True
            except Exception as e:
                blockers.append(f'apply batch failed: {type(e).__name__}: {e}')

            balance_before_batch = balance_remaining
            balance_confirmed = False
            try:
                b = mcp_call('get_application_balance', {})
                balance_remaining = int(b.get('total') or 0)
                balance_confirmed = True
            except Exception as e:
                blockers.append(f'balance check failed: {type(e).__name__}: {e}')
                # No live number to trust: assume the worst case (this whole
                # batch's credits were consumed) instead of clamping later
                # batches against a stale, too-high balance -- the live
                # balance must never be exceeded even when the check itself
                # is what's failing.
                balance_remaining = max(0, balance_before_batch - len(batch_ids))

            # Only credit this batch as attempted once there is evidence
            # Tsenta actually created rows for it (the call succeeded, or a
            # confirmed balance drop proves it despite the exception -- the
            # documented "SSE ended but row was created" case). A raised
            # exception with a confirmed-unchanged balance means nothing was
            # created, so the candidates stay in the pool for the next
            # iteration to retry instead of being silently discarded.
            credits_consumed = apply_ok or (balance_confirmed and balance_remaining < balance_before_batch)
            if credits_consumed:
                pool_iter_idx += batch_size
                result['attempts'] += len(batch_ids)
                result['attempted_ids'].extend(batch_ids)
                result['selected_jobs'].extend(batch)
            else:
                blockers.append(f'apply batch {batch_ids} created no rows (balance unchanged); retrying next iteration')

            approve_pending(run_started_at_utc, blockers, result)

            _sleep(60)
            new_apps = poll_apps()
            if new_apps is not None:
                all_apps = new_apps
                acct = application_accounting(all_apps, today_local, tz, run_started_dt)
                result['final_apps'] = all_apps
            continue
        else:
            if in_flight_today <= 0:
                result['stop_reason'] = 'target reached'; break
            # Same root cause 1/3 fixes as the pool-exhausted wait above: approve
            # what's ready, and give up if in-flight covering the gap is frozen.
            approve_pending(run_started_at_utc, blockers, result)
            if in_flight_snapshot_at and _now_utc() - in_flight_snapshot_at >= STALL_TIMEOUT:
                result['stop_reason'] = 'in-flight stalled'; break
            _sleep(60)
            new_apps = poll_apps()
            if new_apps is not None:
                all_apps = new_apps
                acct = application_accounting(all_apps, today_local, tz, run_started_dt)
                result['final_apps'] = all_apps
            continue

    attempted_id_set = set(result['attempted_ids'])
    result['successes_this_run'] = sum(1 for a in acct['completed_today'] if a.get('jobId') in attempted_id_set)
    return result

def build_slack_summary(today, result, target, total_before, total_after, outreach_sent, outreach_skipped, outreach_failed):
    skips = ', '.join(f'{k}:{v}' for k, v in (result.get('filter_skips') or {}).items())
    lines = [
        f"Tsenta {today}: target {target} | successes_today {result['successes_today']}/{target} (this run {result['successes_this_run']})",
        f"in-flight {result['in_flight_at_end']} | failed {result['failed_refunded']} | skipped {result['skipped_refunded']} | attempts {result['attempts']}",
        f"pool {result['pool_size']} ({skips})" if skips else f"pool {result['pool_size']}",
        f"stop: {result['stop_reason']} | balance {total_before}->{total_after}",
        f"outreach sent {outreach_sent} / skipped {outreach_skipped} / failed {outreach_failed}",
    ]
    summary = '\n'.join(lines)
    return summary[:1500]

def shared_invite_allowance(cap=35, fallback=10):
    """Invites this run may send, from the linkedin MCP's shared, reconciled budget.

    tsenta_unipile_outreach.py sends via raw Unipile, so it never saw the shared 30/day, 170/week
    guard -- on 2026-09-26 it sent 56 in one day. Every sender now draws from one pool (<YOUR_NAME>'s
    "shared pool, by priority" decision): this run takes at most what is left today and this week.
    If the budget can't be read, fall back to a small number rather than the full 35.
    """
    try:
        out = subprocess.run(
            ['node', '-e', "import('./deploy/linkedin-send.mjs').then(async m=>console.log(JSON.stringify(await m.linkedInTool('get_invite_budget',{}))))"],
            cwd=str(ROOT), text=True, capture_output=True, timeout=60)
        b = json.loads(out.stdout.strip().splitlines()[-1])
        if not b.get('available', True):
            return fallback
        return max(0, min(cap, int(b.get('remainingToday', 0)), int(b.get('remainingThisWeek', 0))))
    except Exception:
        return fallback


def main():
    REPORT_MD.parent.mkdir(exist_ok=True)
    APPS_JSON.parent.mkdir(exist_ok=True)
    tz = ZoneInfo('<YOUR_TZ>')
    local_now = datetime.now(tz)
    today = local_now.date()
    y, m = today.year, today.month
    if today.day >= 13:
        m += 1
        if m == 13:
            y += 1; m = 1
    next_refresh = date(y, m, 13)
    days_left_fallback = max(1, (next_refresh - today).days)

    dry_run = os.environ.get('TSENTA_DRY_RUN') == '1'

    discover_mcp_tools()
    blockers=[]; outreach_summary={}; outreach_report=None
    skipped_reasons = Counter()
    try:
        balance_before = mcp_call('get_application_balance', {})
        total_before = int(balance_before.get('total') or 0)
        # Drain remaining (monthly + pack) before this cycle ends. The 100 cap
        # cannot finish ~746 credits in 4 nights. After cycleEnd, revert to even 100.
        cycle_end = None
        try:
            cycle_end = parse_dt((balance_before.get('monthly') or {}).get('cycleEnd'))
        except Exception:
            cycle_end = None
        now_utc = _now_utc()
        cycle_end_source = 'monthly' if cycle_end is not None else 'none'
        if cycle_end is None and now_utc < LOCKED_CYCLE_END:
            cycle_end = LOCKED_CYCLE_END
            cycle_end_source = 'locked'

        def compute_target():
            if cycle_end is not None and now_utc < cycle_end:
                drain_days = max(1, (cycle_end.astimezone(tz).date() - today).days)
                t = total_before if drain_days <= 1 else (math.ceil(total_before / drain_days) if total_before > 0 else 0)
                return {'target': t, 'days_left': drain_days,
                        'cycle_end': cycle_end.isoformat(), 'cycle_end_source': cycle_end_source,
                        'total_before_first_run': total_before}
            t = min(100, math.ceil(total_before / days_left_fallback)) if total_before > 0 else 0
            return {'target': t, 'days_left': days_left_fallback,
                    'cycle_end': cycle_end.isoformat() if cycle_end is not None else None,
                    'cycle_end_source': cycle_end_source, 'total_before_first_run': total_before}

        # Computed once per local day and reused by any later run the same
        # day (no double-counting, no shrinking); TSENTA_TARGET_OVERRIDE still
        # applies per-invocation on top for manual split-day drains.
        day_data, day_stamp_path, day_target_reused = load_or_compute_day_target(today, compute_target)
        target_today = int(day_data['target'])
        days_left = int(day_data.get('days_left') or days_left_fallback)
        cycle_end_iso = day_data.get('cycle_end')
        cycle_end_source = day_data.get('cycle_end_source', cycle_end_source)

        override = os.environ.get('TSENTA_TARGET_OVERRIDE', '').strip()
        if override:
            target_today = max(0, min(int(override), total_before))

        run_started_at_utc_dt = _now_utc()
        run_started_at_utc = run_started_at_utc_dt.isoformat().replace('+00:00','Z')

        deadline_utc = compute_deadline_utc(local_now, tz)
        max_runtime_min = int(os.environ.get('TSENTA_MAX_RUNTIME_MIN', '420'))
        runtime_deadline = run_started_at_utc_dt + timedelta(minutes=max_runtime_min)
        if runtime_deadline < deadline_utc:
            deadline_utc = runtime_deadline
        attempt_cap = max(0, target_today) * 3

        stamp_path = ROOT / 'data' / f'tsenta-{RUN_TAG}-{TODAY}-stamp.json'
        stamp_path.write_text(json.dumps({
            'run_started_at_utc': run_started_at_utc,
            'target_today': target_today,
            'total_before': total_before,
            'run_tag': RUN_TAG,
            'skip_outreach': os.environ.get('TSENTA_SKIP_OUTREACH') == '1',
            'dry_run': dry_run,
            'deadline_utc': deadline_utc.isoformat().replace('+00:00','Z'),
            'attempt_cap': attempt_cap,
            'day_target_reused': day_target_reused,
            'day_target_stamp': str(day_stamp_path),
        }, indent=2))

        pulls = build_pulls()
        result = apply_loop(
            target=target_today, total_before=total_before, today_local=today, tz=tz,
            run_started_at_utc=run_started_at_utc, deadline_utc=deadline_utc,
            attempt_cap=attempt_cap, dry_run=dry_run, pulls=pulls,
            blockers=blockers, skipped_reasons=skipped_reasons,
        )
        skipped_reasons = Counter(result.get('filter_skips') or {})
        attempted_ids = result['attempted_ids']
        selected = result['selected_jobs']

        if dry_run:
            print(json.dumps({
                'dry_run': True,
                'target_today': target_today,
                'pool_size': result['pool_size'],
                'filter_skips': result['filter_skips'],
                'successes_today': result['successes_today'],
                'in_flight_today': result['in_flight_at_end'],
                'would_apply_count': len(result['would_apply']),
                'would_apply': result['would_apply'],
            }, indent=2))
            lines = [
                f"# Tsenta nightly quota DRY RUN — {TODAY}",
                "",
                f"- Run time: {local_now.isoformat()} <YOUR_TZ>",
                f"- Target today: {target_today} (days left: {days_left})",
                f"- Live successes today so far: {result['successes_today']}",
                f"- Live in-flight today: {result['in_flight_at_end']}",
                f"- Candidate pool size after filters: {result['pool_size']}",
                f"- Filter skip counts: {result['filter_skips']}",
                f"- Would-apply count (capped by gap): {len(result['would_apply'])}",
                "",
                "No apply/approve calls were made. No application files were written.",
            ]
            DRYRUN_REPORT_MD.write_text('\n'.join(lines) + '\n')
            return

        # Downstream (dashboard/outreach/report) uses this run's own new rows,
        # while target accounting above used the whole local day.
        apps = result.get('final_apps') or []
        run_started_dt = parse_dt(run_started_at_utc)
        new_apps=[a for a in apps if (get_app_time(a) and get_app_time(a) >= run_started_dt)]
        status_counts=Counter((a.get('status') or 'UNKNOWN').upper() for a in new_apps)
        completed=[a for a in new_apps if (a.get('status') or '').upper() == 'COMPLETED']
        in_flight=[a for a in new_apps if (a.get('status') or '').upper() not in {'COMPLETED','FAILED','SKIPPED'}]
        failed=[a for a in new_apps if (a.get('status') or '').upper() == 'FAILED']
        skipped=[a for a in new_apps if (a.get('status') or '').upper() == 'SKIPPED']
        balance_after = mcp_call('get_application_balance', {})
        total_after = int(balance_after.get('total') or 0)
        saved = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
            'local_run_date': str(today),
            'local_run_started_at': local_now.isoformat(),
            'run_started_at_utc': run_started_at_utc,
            'next_refresh_date': str(next_refresh),
            'days_left': days_left,
            'cycle_end_used': cycle_end_iso,
            'cycle_end_source': cycle_end_source,
            'balance_before': balance_before,
            'balance_after': balance_after,
            'total_before': total_before,
            'total_after': total_after,
            'target_today': target_today,
            'day_target_reused': day_target_reused,
            'attempt_cap': attempt_cap,
            'deadline_utc': deadline_utc.isoformat().replace('+00:00','Z'),
            'stop_reason': result['stop_reason'],
            'successes_today': result['successes_today'],
            'successes_this_run': result['successes_this_run'],
            'in_flight_at_end': result['in_flight_at_end'],
            'failed_refunded': result['failed_refunded'],
            'skipped_refunded': result['skipped_refunded'],
            'pool_size': result['pool_size'],
            'filter_skips': result['filter_skips'],
            'applications': new_apps,
            'attempted_job_ids': attempted_ids,
            'selected_jobs': selected,
            'status_counts': dict(status_counts),
        }
        APPS_JSON.write_text(json.dumps(saved, indent=2, default=str))
        try:
            # Use the full paginated application list for dashboard/history.
            # The first page is enough for run-status polling, but the trend chart
            # needs all rows; otherwise it silently drops older days after 100 apps.
            dashboard_apps_resp = list_apps(100, all_pages=True)
            refresh_dashboard(dashboard_apps_resp)
            write_credits(balance_after)
        except Exception as e:
            blockers.append(f'dashboard mirror update failed: {type(e).__name__}: {e}')
        # outreach
        if os.environ.get('TSENTA_SKIP_OUTREACH') == '1':
            outreach_summary={'skipped_reason':'TSENTA_SKIP_OUTREACH=1'}
        elif completed and (allowance := shared_invite_allowance()) <= 0:
            outreach_summary={'skipped_reason':'shared LinkedIn invite budget exhausted (today or this week)'}
        elif completed:
            since=run_started_at_utc[:-1] if run_started_at_utc.endswith('Z') else run_started_at_utc
            cmd=['python3','scripts/tsenta_unipile_outreach.py','--apps-json',str(APPS_JSON.relative_to(ROOT)),'--since',since,'--max-send',str(allowance),'--delay','90']
            try:
                p=subprocess.run(cmd, cwd=str(ROOT), text=True, capture_output=True, timeout=3600)
                txt=(p.stdout or '') + ('\n' + p.stderr if p.stderr else '')
                # Store raw output without secrets; script should not print them.
                raw_path=ROOT/'reports'/f'tsenta-unipile-outreach-run-{TODAY}.log'
                raw_path.write_text(txt)
                # Try parse last JSON object/file path hints
                outreach_summary={'exit_code':p.returncode,'log':str(raw_path)}
                for path in sorted((ROOT/'reports').glob(f'tsenta-unipile-outreach-{TODAY}*.json'), key=lambda x:x.stat().st_mtime, reverse=True):
                    outreach_report=str(path)
                    try:
                        od=json.loads(path.read_text())
                        outreach_summary.update(od if isinstance(od,dict) else {'json':od})
                    except Exception: pass
                    break
                if p.returncode != 0:
                    blockers.append(f'Unipile outreach exited {p.returncode}; see {raw_path}')
            except subprocess.TimeoutExpired:
                blockers.append('Unipile outreach timed out after 3600s; stopped waiting')
                outreach_summary={'timed_out':True}
        else:
            outreach_summary={'skipped_reason':'no completed applications from this run'}
        sent_o = outreach_summary.get('sent')
        sent_count = len(sent_o) if isinstance(sent_o, list) else (sent_o if isinstance(sent_o, int) else int(outreach_summary.get('sent_count') or 0))
        failed_o = outreach_summary.get('failed')
        failed_count = len(failed_o) if isinstance(failed_o,list) else (failed_o if isinstance(failed_o,int) else 0)
        skipped_o = outreach_summary.get('skipped')
        skipped_count = len(skipped_o) if isinstance(skipped_o,list) else (skipped_o if isinstance(skipped_o,int) else 0)
        lines=[]
        lines.append(f"# Tsenta nightly quota + LinkedIn outreach — {TODAY}")
        lines.append("")
        lines.append(f"- Run time: {local_now.isoformat()} <YOUR_TZ>")
        lines.append(f"- Run started at UTC: {run_started_at_utc}")
        lines.append(f"- Next Tsenta refresh: {next_refresh.isoformat()}")
        lines.append(f"- Days left: {days_left}")
        lines.append(f"- Cycle end used: {cycle_end_iso or 'none'} ({cycle_end_source})")
        lines.append(f"- Balance before: {total_before}")
        lines.append(f"- Balance after: {total_after}")
        lines.append(f"- Target today (day-level, persisted{' — reused from earlier run' if day_target_reused else ''}): {target_today}")
        lines.append(f"- Successes today (whole day, all runs): {result['successes_today']} / {target_today}")
        lines.append(f"- Successes this run: {result['successes_this_run']}")
        lines.append(f"- In-flight at end (today): {result['in_flight_at_end']}")
        lines.append(f"- Failed today (refunded): {result['failed_refunded']}")
        lines.append(f"- Skipped today (refunded): {result['skipped_refunded']}")
        lines.append(f"- Attempts this run: {result['attempts']} (cap {attempt_cap})")
        lines.append(f"- Candidate pool size after filters: {result['pool_size']}")
        lines.append(f"- Filter skip counts: {result['filter_skips']}")
        lines.append(f"- Stop reason: {result['stop_reason']}")
        lines.append(f"- Applications attempted (this run): {len(attempted_ids)}")
        lines.append(f"- Applications completed (this run): {len(completed)}")
        lines.append(f"- Applications in-flight (this run): {len(in_flight)}")
        lines.append(f"- Applications failed (this run): {len(failed)}")
        lines.append(f"- Applications skipped (this run): {len(skipped)}")
        lines.append(f"- Outreach eligible completed applications: {len(completed)}")
        lines.append(f"- Unipile outreach sent: {sent_count}")
        lines.append(f"- Unipile outreach skipped: {skipped_count}")
        lines.append(f"- Unipile outreach failed: {failed_count}")
        lines.append(f"- Saved applications JSON: {APPS_JSON}")
        if outreach_report: lines.append(f"- Saved outreach report JSON: {outreach_report}")
        elif isinstance(outreach_summary,dict) and outreach_summary.get('log'): lines.append(f"- Outreach log: {outreach_summary['log']}")
        if blockers:
            lines.append("")
            lines.append("## Blockers / warnings")
            for b in blockers: lines.append(f"- {b}")
        else:
            lines.append("")
            lines.append("## Blockers / warnings")
            lines.append("- None.")
        report='\n'.join(lines)+'\n'
        REPORT_MD.write_text(report)
        print(report, file=sys.stderr)  # full report -> journal + REPORT_MD; only the summary goes to Slack
        print(build_slack_summary(TODAY, result, target_today, total_before, total_after, sent_count, skipped_count, failed_count))
    finally:
        shutdown_mcp_servers()

if __name__ == '__main__':
    main()
