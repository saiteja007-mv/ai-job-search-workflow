#!/usr/bin/env python3
"""Find + SMTP-verify work emails for recruiter contacts using email-sleuth.

Enriches contacts in data/contacts.json in place (email fields only). Never sends,
never drafts, never touches dateSent/status.

Usage:
  find_recruiter_emails.py                 # today's daily recruiter entry (appNumber YYYYMMDD)
  find_recruiter_emails.py --app 20260927  # a specific appNumber
  find_recruiter_emails.py --name "Jane Doe" --domain acme.ai   # one-off lookup, no file writes
  find_recruiter_emails.py --dry           # show what would be checked
Options: --limit N (per run, default 10), --domain-override "Company=domain.com"

Safety: daily cap (DAILY_CAP lookups/day, tracked in state file) because probes
come from the home IP; accept only SMTP-verified, non-catch-all hits >= MIN_CONF.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile

ROOT = "/home/<YOU>/career-ops"
CONTACTS = f"{ROOT}/data/contacts.json"
DOMAINS = f"{ROOT}/data/company_domains.json"
BIN = "/home/<YOU>/tools/email-sleuth/target/release/email-sleuth"
CONF = os.path.expanduser("~/.config/email-sleuth/config.toml")
STATE = os.path.expanduser("~/.local/state/email-sleuth/usage.json")
HELO = os.environ.get("EMAIL_SLEUTH_HELO", "<HOME_RDNS_HOSTNAME>")
DAILY_CAP = int(os.environ.get("EMAIL_SLEUTH_DAILY_CAP", "40"))
MIN_CONF = 8
TODAY = dt.date.today().isoformat()


def load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    json.load(open(tmp))  # validate
    os.replace(tmp, p)


def has_mx(domain):
    try:
        out = subprocess.run(["dig", "+short", "MX", domain], capture_output=True, text=True, timeout=8).stdout
        return bool(out.strip())
    except Exception:
        return False


def resolve_domain(company, cache):
    if not company:
        return None, None
    key = company.strip().lower()
    if key in cache:
        return cache[key], "cache"
    slug = re.sub(r"\b(inc|llc|ltd|corp|corporation|co|technologies|labs?)\b\.?", "", key)
    slug = re.sub(r"[^a-z0-9]", "", slug)
    for tld in (".com", ".ai", ".io"):
        if slug and has_mx(slug + tld):
            return slug + tld, "guessed"
    return None, None


def run_sleuth(people):
    """people: list of dicts first_name,last_name,domain. Returns list of results."""
    with tempfile.TemporaryDirectory() as td:
        inp, out = os.path.join(td, "in.json"), os.path.join(td, "out.json")
        json.dump(people, open(inp, "w"))
        env = dict(os.environ, EMAIL_SLEUTH_HELO=HELO, RUST_LOG="warn")
        subprocess.run([BIN, "--config-file", CONF, "-m", "enhanced", "-i", inp, "-o", out],
                       env=env, capture_output=True, text=True, timeout=120 * max(1, len(people)))
        return load(out, [])


def verdict(res):
    er = res.get("email_discovery_results") or {}
    email = er.get("most_likely_email") or res.get("email")
    conf = er.get("confidence_score") or res.get("email_confidence") or 0
    log = " ".join((er.get("verification_log") or {}).values()).lower()
    catch_all = "catch-all" in log and "non-catch-all" not in log
    if email and conf >= MIN_CONF and not catch_all:
        return email, conf, "verified"
    if catch_all:
        return None, conf, "catch_all_domain"
    if "rejected" in log or "550" in log:
        return None, conf, "not_found"
    return None, conf, "inconclusive"


def split_name(full):
    parts = [p for p in re.sub(r"[,(].*$", "", full or "").split() if p]
    if len(parts) < 2:
        return None, None
    return parts[0], parts[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app")
    ap.add_argument("--name")
    ap.add_argument("--domain")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--domain-override", action="append", default=[])
    a = ap.parse_args()

    state = load(STATE, {})
    used = state.get(TODAY, 0)

    if a.name:
        fn, ln = split_name(a.name)
        if not (fn and a.domain):
            sys.exit("need --name 'First Last' and --domain")
        if used >= DAILY_CAP:
            sys.exit(f"daily cap {DAILY_CAP} reached")
        r = run_sleuth([{"first_name": fn, "last_name": ln, "domain": a.domain}])
        state[TODAY] = used + 1; save(STATE, state)
        print(json.dumps({"name": a.name, "domain": a.domain, "result": verdict(r[0]) if r else None}))
        return

    cache = load(DOMAINS, {})
    for o in a.domain_override:
        c, d = o.split("=", 1)
        cache[c.strip().lower()] = d.strip()
    data = load(CONTACTS, None)
    if not data:
        sys.exit("contacts.json missing")
    app_no = a.app or TODAY.replace("-", "")
    apps = [x for x in data["applications"] if str(x.get("appNumber")) == str(app_no)]
    if not apps:
        sys.exit(f"no application entry {app_no}")

    todo, skipped = [], []
    for c in apps[0].get("contacts", []):
        if c.get("email") or c.get("email_status") in ("verified", "catch_all_domain", "not_found") and c.get("email_checked_at"):
            continue
        fn, ln = split_name(c.get("profileName") or c.get("name"))
        dom, src = (c.get("company_domain"), "contact") if c.get("company_domain") else resolve_domain(c.get("company"), cache)
        if not (fn and dom):
            skipped.append((c.get("name"), c.get("company"), "no name/domain"))
            continue
        todo.append((c, {"first_name": fn, "last_name": ln, "domain": dom}, src))

    budget = max(0, min(a.limit, DAILY_CAP - used))
    todo, over = todo[:budget], todo[budget:]
    for c, _, _ in over:
        skipped.append((c.get("name"), c.get("company"), "daily cap"))
    print(f"app {app_no}: checking {len(todo)} (cap left {DAILY_CAP - used}), skipped {len(skipped)}")
    for c, p, src in todo:
        print(f"  - {c.get('name')} @ {p['domain']} (domain {src})")
    if a.dry or not todo:
        for s in skipped:
            print("  skip:", *s)
        return

    results = run_sleuth([p for _, p, _ in todo])
    state[TODAY] = used + len(todo); save(STATE, state)
    by_key = {}
    for r in results:
        ci = r.get("contact_input") or r
        by_key[(ci.get("first_name"), ci.get("last_name"), ci.get("domain"))] = r
    found = 0
    for c, p, src in todo:
        r = by_key.get((p["first_name"], p["last_name"], p["domain"]))
        email, conf, status = verdict(r) if r else (None, 0, "error")
        c.update({"email_status": status, "email_confidence": conf, "email_domain": p["domain"],
                  "email_domain_source": src, "email_checked_at": TODAY, "email_tool": "email-sleuth"})
        if email:
            c["email"] = email
            found += 1
            if src == "guessed":
                cache[(c.get("company") or "").strip().lower()] = p["domain"]
        print(f"  {status:17} {c.get('name')} -> {email or '-'} (conf {conf})")
    save(DOMAINS, cache)
    save(CONTACTS, data)
    print(f"verified {found}/{len(todo)}; contacts.json updated. Nothing drafted or sent.")
    for s in skipped:
        print("  skip:", *s)


if __name__ == "__main__":
    main()
