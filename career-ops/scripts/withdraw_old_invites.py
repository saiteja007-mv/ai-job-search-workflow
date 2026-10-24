#!/usr/bin/env python3
"""Withdraw pending LinkedIn invites older than MIN_AGE days via Unipile. Paced; logs to data/linkedin-invite-withdrawals-<date>.json.
Usage: python3 scripts/withdraw_old_invites.py [min_age_days=30] [--dry]
"""
import os, sys, json, time, random, datetime, urllib.request, urllib.error
ROOT = '<CAREER_OPS_DIR>'
for line in open(f'{ROOT}/.env'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.strip().split('=', 1); os.environ.setdefault(k, v.strip('"\''))
B, K, A = os.environ['UNIPILE_API_BASE'], os.environ['UNIPILE_API_KEY'], '<UNIPILE_ACCOUNT_ID>'
args = [a for a in sys.argv[1:] if not a.startswith('--')]
MIN_AGE = int(args[0]) if args else 30
DRY = '--dry' in sys.argv

def call(method, path):
    req = urllib.request.Request(B + path, method=method, headers={'X-API-KEY': K})
    return json.load(urllib.request.urlopen(req, timeout=60))

items, cur = [], None
while True:
    d = call('GET', f'/users/invite/sent?account_id={A}&limit=100' + (f'&cursor={cur}' if cur else ''))
    items += d.get('items', []); cur = d.get('cursor')
    if not cur or not d.get('items'): break
now = datetime.datetime.now(datetime.timezone.utc)
old = []
for i in items:
    try: age = (now - datetime.datetime.fromisoformat(i['parsed_datetime'].replace('Z', '+00:00'))).total_seconds() / 86400
    except Exception: continue
    if age >= MIN_AGE: old.append((age, i))
old.sort(key=lambda x: -x[0])
today = datetime.date.today().isoformat()
out_path = f'{ROOT}/data/linkedin-invite-withdrawals-{today}.json'
log = {'started': now.isoformat(), 'min_age_days': MIN_AGE, 'pending_total': len(items), 'withdrawn': [], 'failed': []}
if os.path.exists(out_path):
    prev = json.load(open(out_path)); log['withdrawn'] = prev.get('withdrawn', []); log['failed'] = prev.get('failed', [])
print(f'pending {len(items)}, >= {MIN_AGE}d: {len(old)}', flush=True)
for n, (age, i) in enumerate(old, 1):
    rec = {'id': i['id'], 'name': i.get('invited_user'), 'public_id': i.get('invited_user_public_id'),
           'provider_id': i.get('invited_user_id'), 'sent': i.get('parsed_datetime'), 'age': round(age, 1)}
    if DRY: print('DRY', rec['name'], rec['age']); continue
    try:
        call('DELETE', f"/users/invite/sent/{i['id']}?account_id={A}")
        rec['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat(); log['withdrawn'].append(rec)
    except urllib.error.HTTPError as e:
        rec['error'] = f'HTTP {e.code} {e.read()[:150]!r}'; log['failed'].append(rec)
        if e.code in (429, 403): print('rate/permission stop:', rec['error'], flush=True); break
    except Exception as e:
        rec['error'] = str(e)[:150]; log['failed'].append(rec)
    if n % 20 == 0:
        json.dump(log, open(out_path, 'w'), indent=1); print(f'{n}/{len(old)} done', flush=True)
    time.sleep(random.uniform(4, 8))
log['finished'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(log, open(out_path, 'w'), indent=1)
print(f"withdrawn {len(log['withdrawn'])}, failed {len(log['failed'])} -> {out_path}")
