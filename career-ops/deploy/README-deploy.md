# career-ops on Ubuntu — always-on workflow daemon

Run the whole system on your Ubuntu laptop as background **systemd** services + timers,
controlled from your phone. Your private data never leaves your hardware.

```
Ubuntu laptop (always-on home server)
├── career-ops-dashboard.service   Docker webapp on :5050   (restart=unless-stopped)
├── career-ops-scan.timer          daily 08:00 -> agent-run.sh (headless Claude: scan+eval)
├── career-ops-sync.timer          5x/day      -> sync-run.sh  (gog Gmail -> Agency data)
└── career-ops-telegram.service    long-running bot: /status /scan /sync /report
Phone ── Tailscale ──> http://<laptop>:5050 (dashboard)   +   Telegram bot (control)
```

---

## 0. Prereqs on the laptop
- Ubuntu 22.04+ with `sudo`.
- The repo present at a fixed path, e.g. `~/career-ops`.

## 1. Get the code + your private data onto the box (Syncthing)
You sync this folder Windows<->Ubuntu with **Syncthing**, so code AND private data arrive
automatically — no manual copy. Point Syncthing at `~/career-ops` on Ubuntu and let it converge.

**Syncthing rules (already encoded in `.stignore`):**
- `node_modules`, `.git`, `dashboard/career-dashboard.exe` are **excluded** — OS-specific, rebuilt per device in step 2. Never let Windows `node_modules` overwrite Ubuntu's.
- `deploy/.env` + `deploy/logs` are **excluded** — secrets + the Ubuntu-specific `CAREER_OPS_DIR` path stay per-device.
- **One active writer at a time.** Both machines can write `data/applications.md`, `contacts.json`, `records_clean.json`; running the dashboard/agent on both at once creates `.sync-conflict-*` files. After migrating, treat the **Ubuntu box as primary** and stop the Windows dashboard/agent.
- Files are committed **LF** so synced shell scripts + systemd units run on Linux unchanged.

For reference, the data Syncthing carries (everything except the exclusions above):
```
cv.md
config/profile.yml
modes/_profile.md
data/                      (applications.md, pipeline.md, applied-dates.json,
                            contacts.json, posted-dates.json, contact-status.json, ...)
output/                    (generated PDFs)
reports/
interview-prep/
agency-applications/           (especially _raw/*.json — the synced tracker)
portals.yml
```
(Not using Syncthing? Copy them manually, e.g. `scp -r cv.md config data output reports "agency-applications" portals.yml youruser@LAPTOP:~/career-ops/`)

## 2. Bootstrap (installs Node 20, Docker, Claude CLI, Playwright/Chromium)
```bash
cd ~/career-ops
export CAREER_OPS_DIR=~/career-ops
bash deploy/bootstrap-ubuntu.sh
newgrp docker          # apply docker group without re-login
```

## 3. Configure secrets
```bash
cp deploy/.env.example deploy/.env
nano deploy/.env       # set CAREER_OPS_DIR, MEM0_API_KEY, APOLLO_API_KEY,
                       # TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_ID, (optional) ANTHROPIC_API_KEY
```

## 4. Authenticate Claude + gog (one time)
```bash
claude            # then run /login  (saves creds in ~/.claude)  — OR put ANTHROPIC_API_KEY in deploy/.env
# gog: install per its docs, then auth the work account:
gog -a <YOUR_EMAIL> --client work gmail search "test" --max 1 --no-input
```

## 5. Install the workflow daemons
```bash
bash deploy/install-systemd.sh
systemctl --user list-timers | grep career-ops      # confirm timers scheduled
docker compose -f ~/career-ops/docker-compose.yml ps  # dashboard healthy
```
`install-systemd.sh` enables **linger** so these keep running with no one logged in.

## 6. Keep the laptop awake (run as a server)
```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl restart systemd-logind
```

## 7. Reach it from your phone — Tailscale (recommended, private)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4        # note the 100.x.y.z address
```
Install Tailscale on your phone (same account). Then from the phone browser open
`http://100.x.y.z:5050`. Nothing is exposed to the public internet.

*Alternative — public URL:* `cloudflared tunnel --url http://localhost:5050` (add Cloudflare Access to gate it).

## 8. Control from your phone (Telegram)
Message your bot:
- `/status` — pipeline health + dashboard container state
- `/sync` — refresh Gmail (Agency) data now
- `/scan` — run scan + evaluate (replies when done)
- `/report` — rebuild the analysis report HTML

---

## Day-2 ops
```bash
# logs
journalctl --user -u career-ops-scan -f
journalctl --user -u career-ops-telegram -f
tail -f ~/career-ops/deploy/logs/scan-*.log

# run a scan right now
systemctl --user start career-ops-scan.service

# change schedule: edit deploy/systemd/*.timer, then re-run install-systemd.sh
# update code: git pull && docker compose up -d --build && systemctl --user restart career-ops-telegram
```

## Notes & caveats
- **Unattended Claude** runs with `--dangerously-skip-permissions` (no human to approve tool calls). It only executes the fixed prompt in `agent-run.sh` against this repo — review `deploy/logs/` regularly and tune the prompt to taste.
- **Cost/limits:** headless Claude uses your subscription login or `ANTHROPIC_API_KEY` (metered). The daily timer is one run/day by default.
- **Reliability:** a laptop is not a real server — if it sleeps or home internet drops, timers pause (they catch up via `Persistent=true`). For 24/7 hard uptime, the same kit runs unchanged on a $6/mo VPS.
- **Open-PDF-in-Explorer** dashboard button is Windows-only and silently no-ops on Linux; PDFs still render inline in the browser.
- **Never** expose port 5050 directly to the internet — use Tailscale or Cloudflare Access.
- The Telegram bot only obeys `TELEGRAM_ALLOWED_CHAT_ID` — set it, or anyone who finds the bot can run commands.
