#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, sys, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('<CAREER_OPS_DIR>')
ENV = ROOT/'.env'
TODAY = datetime.now().strftime('%Y-%m-%d')
EXPECTED = '<UNIPILE_ACCOUNT_ID>'
QUERIES = [
    'hiring applied AI engineer San Francisco',
    'hiring AI engineer Bay Area',
    'hiring machine learning engineer San Francisco',
    'hiring LLM engineer remote US',
    'hiring generative AI engineer remote US',
    'we are hiring applied AI engineer',
    'founding AI engineer San Francisco hiring',
    'MLOps engineer hiring United States',
    'machine learning engineer hiring remote United States',
    'AI engineer recruiter hiring San Francisco',
    'applied scientist hiring machine learning United States',
    'data engineer AI hiring San Francisco',
]

GOOD_TERMS = ['ai engineer','applied ai','machine learning engineer','ml engineer','llm','generative ai','genai','mlops','applied scientist','data engineer','rag','agents','pytorch','hugging face','vector']
BAD_TERMS = ['senior director','principal','staff/principal','staff engineer','director','vp','head of','manager role','india','canada','uk','london','europe','emea','internship only','c2c','clearance','secret clearance','public trust','citizen']
URL_RE = re.compile(r'https?://[^\s)>,]+')

def load_env():
    if not ENV.exists(): raise RuntimeError('Missing .env')
    for raw in ENV.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def api(path, method='GET', body=None):
    base=os.environ['UNIPILE_API_BASE'].rstrip('/')
    data=None; headers={'X-API-KEY': os.environ['UNIPILE_API_KEY'], 'accept':'application/json'}
    if body is not None:
        data=json.dumps(body).encode(); headers['content-type']='application/json'
    req=urllib.request.Request(base+path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=35) as resp:
        return json.loads(resp.read().decode('utf-8','replace'))

def get_accounts():
    data=api('/accounts')
    accs=data if isinstance(data,list) else data.get('items') or data.get('accounts') or data.get('data') or []
    out=[]
    for a in accs:
        out.append({'id':a.get('id') or a.get('account_id'), 'type':a.get('type') or a.get('provider'), 'name':a.get('name') or a.get('username') or a.get('email'), 'status':a.get('status') or a.get('connection_status')})
    return out

def search_posts(account_id):
    posts=[]; errors=[]; seen=set()
    for q in QUERIES:
        try:
            data=api('/linkedin/search?'+urllib.parse.urlencode({'account_id':account_id}), method='POST', body={'api':'classic','category':'posts','keywords':q})
            items = data.get('items') or data.get('data') or data.get('posts') or (data if isinstance(data,list) else [])
            for p in items[:12]:
                if not isinstance(p,dict): continue
                sid=p.get('social_id') or p.get('id') or p.get('share_url')
                if not sid or sid in seen: continue
                seen.add(sid); p['_query']=q; posts.append(p)
        except Exception as e:
            errors.append({'query':q,'error':type(e).__name__+': '+str(e)[:240]})
            if '429' in str(e): break
    return posts, errors

def clean_url(u):
    return u.split('?')[0].rstrip('.,')

def canonical_job_url(p):
    urls=[]
    text=p.get('text') or ''
    urls += URL_RE.findall(text)
    art=p.get('article') or {}
    if art.get('url'): urls.append(art['url'])
    atts=p.get('attachments') or []
    for a in atts:
        if isinstance(a,dict) and a.get('url'): urls.append(a['url'])
    for u in urls:
        cu=clean_url(u)
        low=cu.lower()
        if 'linkedin.com/posts' in low: continue
        if any(x in low for x in ['careers','jobs','greenhouse','lever.co','ashbyhq','workdayjobs','bamboohr','apply','job']):
            return cu
    return None

def post_url(p):
    u=p.get('share_url') or ''
    return clean_url(u) if u else (f"https://www.linkedin.com/posts/activity-{p.get('id')}" if p.get('id') else '')

def age_score(p):
    d=(p.get('date') or '').lower()
    if any(x in d for x in ['h','m','now']): return 2
    m=re.search(r'(\d+)d', d)
    if m and int(m.group(1))<=3: return 2
    if m and int(m.group(1))<=7: return 1
    if 'w' in d: return 0
    return 1

def classify_score(p):
    text=(p.get('text') or '').lower(); author=p.get('author') or {}; headline=(author.get('headline') or '').lower()
    job=canonical_job_url(p)
    has_hiring=any(x in text for x in ['hiring','we are hiring','join our team','apply','send your resume','dm me','reach out','open role','job'])
    good=sum(1 for t in GOOD_TERMS if t in text or t in headline)
    bad=sum(1 for t in BAD_TERMS if t in text or t in headline)
    if bad>=2 or ('senior' in text and '3+' not in text and 'ii' not in text): action='SKIP'
    elif job: action='JOB_POSTING'
    elif any(x in text for x in ['dm me','send your resume','email','reach out']) and has_hiring: action='APPLY_OR_DM'
    elif has_hiring and ('recruiter' in headline or 'talent' in headline or 'founder' in headline): action='CONTACT_PERSON'
    elif good>=2: action='COMMENT'
    else: action='SKIP'
    score=min(10, max(1, 3 + good + (2 if has_hiring else 0) + (2 if job else 0) + age_score(p) - bad*2))
    if action=='SKIP': score=min(score,5)
    return action, score, job

def duplicate(job_url, company, title, hay):
    blob=hay.lower()
    if job_url and clean_url(job_url).lower() in blob: return True
    # only use loose company/title dup if both are present and distinctive
    if company and title and company.lower() in blob and title.lower()[:35] in blob: return True
    return False

def infer_company_title(p, job_url):
    text=(p.get('text') or '').replace('\n',' ')
    author=p.get('author') or {}
    company='Unknown'; title='Role from LinkedIn post'
    art=p.get('article') or {}
    if art.get('author'):
        company=re.sub(r'\.(com|ai|co|io)$','',art['author'], flags=re.I).title()
    if art.get('title'):
        title=art['title'][:90]
    m=re.search(r'(AI Engineer|Applied AI Engineer|Machine Learning Engineer(?: II| I)?|ML Engineer(?: II| I)?|LLM Engineer|Generative AI Engineer|Applied Scientist(?: II| I)?|Data Engineer)', text, re.I)
    if m: title=m.group(1)
    m2=re.search(r'at ([A-Z][A-Za-z0-9 .&-]{2,40})', text)
    if m2 and company=='Unknown': company=m2.group(1).strip()
    if company=='Unknown' and author.get('headline'):
        hm=re.search(r'@\s*([^|,]+)', author['headline'])
        if hm: company=hm.group(1).strip()
    return company[:60], title[:100]

def draft(item):
    action=item['action_type']; comp=item['company']; title=item['title']; author=item['author']
    if action=='COMMENT':
        return "Strong signal when AI roles connect product value with reliable deployment. The hard part is usually turning prototypes into observable, low-latency systems that teams can trust in production."
    if action=='APPLY_OR_DM':
        return f"Hi {author.split()[0] if author else 'there'} — saw your post about {title}. I’ve built production ML/RAG systems with PyTorch, Hugging Face, vector search, and AWS/Kubernetes deployment. If a 3+ yrs AI/ML profile fits, I’d like to learn more."
    if action=='CONTACT_PERSON':
        return f"Hi {author.split()[0] if author else 'there'} — saw you’re hiring for {title}. my background is <YOUR_CORE_SKILLS>. Would be glad to connect if this role is still active."
    return ''

def main():
    load_env(); accounts=get_accounts()
    linkedin=[a for a in accounts if str(a.get('type','')).upper()=='LINKEDIN' or a.get('id')==EXPECTED]
    account=(next((a for a in linkedin if a.get('id')==EXPECTED), None) or (linkedin[0] if linkedin else None))
    if not account: raise RuntimeError('No LinkedIn account found')
    posts, errors=search_posts(account['id'])
    raw={'date':TODAY,'account':account,'queries':QUERIES,'errors':errors,'count':len(posts),'posts':posts}
    (ROOT/f'data/linkedin-post-search-raw-{TODAY}.json').write_text(json.dumps(raw, indent=2, ensure_ascii=False))
    hay=(ROOT/'data/pipeline.md').read_text(errors='ignore')+'\n'+(ROOT/'data/applications.md').read_text(errors='ignore')
    candidates=[]
    for p in posts:
        action, score, job=classify_score(p)
        if action=='SKIP' or score<6: continue
        company,title=infer_company_title(p,job)
        author=(p.get('author') or {}).get('name') or 'Unknown'
        item={'date':TODAY,'post_url':post_url(p),'author':author,'author_headline':(p.get('author') or {}).get('headline'),'author_public_identifier':(p.get('author') or {}).get('public_identifier'),'action_type':action,'score':score,'company':company,'title':title,'job_url':job,'rationale':'Relevant to AI/ML/GenAI targets; hiring intent and freshness scored from LinkedIn post text.','pipeline_added':False,'auto_processed':False,'artifact':None,'status':'pending_approval','drafted_reply':None,'connection_note':None,'dm':None,'date_label':p.get('date'),'source_query':p.get('_query'),'text_excerpt':(p.get('text') or '')[:500]}
        d=draft(item)
        if action=='COMMENT': item['drafted_reply']=d
        elif action=='APPLY_OR_DM': item['dm']=d
        elif action=='CONTACT_PERSON': item['connection_note']=d[:300]
        candidates.append(item)
    # sort, keep unique post urls
    candidates=sorted(candidates, key=lambda x:x['score'], reverse=True)
    uniq=[]; seen=set()
    for c in candidates:
        if c['post_url'] in seen: continue
        seen.add(c['post_url']); uniq.append(c)
        if len(uniq)>=8: break
    # add pipeline for strong job postings, max 5
    pipe_path=ROOT/'data/pipeline.md'; pipe=pipe_path.read_text(); added=[]
    for c in uniq:
        if c['action_type']=='JOB_POSTING' and c['score']>=8 and c['job_url'] and not duplicate(c['job_url'],c['company'],c['title'],hay+pipe):
            if len(added)>=5: break
            if f'via weekday LinkedIn role-post engagement agent ({TODAY})' not in pipe:
                pipe += f"\n<!-- Added {TODAY} via weekday LinkedIn role-post engagement agent ({TODAY}). -->\n"
            line=f"- [ ] {c['job_url']} | {c['company']} | {c['title']} | LINKEDIN_POST {TODAY} source={c['post_url']}\n"
            pipe += line; c['pipeline_added']=True; c['status']='internal_done'; added.append(c)
    if added: pipe_path.write_text(pipe)
    queue={'date':TODAY,'account':account,'target_keywords':['AI/ML Engineer','Applied AI Engineer','Machine Learning Engineer','GenAI/LLM Engineer','MLOps','Data Engineer with AI/data focus'],'posts':uniq,'actions_completed':{'pipeline_added':[{'company':c['company'],'title':c['title'],'job_url':c['job_url'],'post_url':c['post_url']} for c in added], 'auto_processed':[]},'errors':errors}
    qpath=ROOT/'data/linkedin-post-reply-queue.json'; qpath.write_text(json.dumps(queue,indent=2,ensure_ascii=False))
    # markdown report
    lines=[f"# LinkedIn role-post action shortlist — {TODAY}","",f"Verified <YOUR_NAME>'s LinkedIn account via Unipile `GET /accounts`: `{account['id']}`. Searched {len(QUERIES)} targeted post queries and found {len(posts)} unique posts.","","## Shortlist",""]
    for i,c in enumerate(uniq,1):
        lines += [f"{i}. **{c['action_type']} — {c['author']} / {c['company']}**  ",f"   Post: {c['post_url']}  "]
        if c['job_url']: lines.append(f"   Job URL: {c['job_url']}  ")
        lines += [f"   Role/topic: {c['title']}  ",f"   Score: {c['score']}/10  ",f"   Why relevant: {c['rationale']}  "]
        if c['pipeline_added']: lines.append("   Internal action: added to `data/pipeline.md` with source-post note.  ")
        if c.get('drafted_reply'): lines.append(f"   Draft comment: “{c['drafted_reply']}”")
        if c.get('dm'): lines.append(f"   Draft DM: “{c['dm']}”")
        if c.get('connection_note'): lines.append(f"   Draft connection note: “{c['connection_note']}”")
        lines.append("")
    lines += ["## Actions completed automatically","",f"- Verified LinkedIn account through Unipile: <YOUR_NAME> (`{account['id']}`).",f"- Searched {len(QUERIES)} targeted role-post queries; saved raw artifact: `data/linkedin-post-search-raw-{TODAY}.json`.",f"- Added {len(added)} safe internal pipeline item(s).",f"- Saved machine-readable approval queue: `data/linkedin-post-reply-queue.json`.",f"- Saved this report: `reports/linkedin-post-engagement-{TODAY}.md`.","- No external LinkedIn comments, DMs, connection requests, resume sends, or applications were sent."]
    rpath=ROOT/f'reports/linkedin-post-engagement-{TODAY}.md'; rpath.write_text('\n'.join(lines)+"\n")
    print(json.dumps({'ok':True,'date':TODAY,'account':account,'searched_posts':len(posts),'shortlist':len(uniq),'pipeline_added':len(added),'queue':str(qpath),'report':str(rpath),'errors':errors},indent=2))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'ok':False,'error':type(e).__name__+': '+str(e)},indent=2), file=sys.stderr); sys.exit(1)
