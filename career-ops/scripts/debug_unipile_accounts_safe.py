#!/usr/bin/env python3
import json, os, urllib.request
from pathlib import Path
ROOT=Path('<CAREER_OPS_DIR>')
for raw in (ROOT/'.env').read_text().splitlines():
    raw=raw.strip()
    if '=' in raw and not raw.startswith('#'):
        k,v=raw.split('=',1); os.environ.setdefault(k.strip(),v.strip().strip('"').strip("'"))
base=os.environ['UNIPILE_API_BASE'].rstrip('/'); key=os.environ['UNIPILE_API_KEY']
req=urllib.request.Request(base+'/accounts',headers={'X-API-KEY':key,'accept':'application/json'})
with urllib.request.urlopen(req,timeout=35) as r: data=json.loads(r.read().decode())
items=data.get('items') or data.get('accounts') or (data if isinstance(data,list) else [])
safe=[]
for a in items:
    safe.append({k:a.get(k) for k in ['id','type','provider','name','account_name','username','status','connection_params','sources','created_at'] if k in a})
print(json.dumps({'top_keys':list(data.keys()) if isinstance(data,dict) else 'list','count':len(items),'accounts':safe},indent=2))
