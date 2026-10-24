# Career-Ops — Two-Way Sync (Windows ⇄ Ubuntu/Hermes)

Two-way file sync of the whole career-ops working tree (code + data + config) between
this Windows laptop and the Ubuntu "Hermes" laptop, over **Tailscale**, via **Syncthing**.
Run career-ops on whichever machine you're at; both stay in sync. The Docker webapp
on either machine just reads the synced `data/`.

Private data never touches the public `santifer/career-ops` git remote — Syncthing is
peer-to-peer and encrypted.

---

## This laptop (Windows) — DONE

- **Syncthing** v2.1.0 installed (winget). Auto-starts at logon via
  `…\Startup\syncthing.vbs` (runs hidden). GUI: http://127.0.0.1:8384
- **Device ID:** `<SYNCTHING_DEVICE_ID>`
- **Tailscale IP:** `<SERVER_IP>`
- **Shared folder:** id `career-ops`, path `<CAREER_OPS_DIR>`, sendreceive.
- **Ignore rules:** `.stignore` at repo root (excludes `.git`, `node_modules`,
  the dashboard `.exe`, batch scratch, conflict/OS files).

---

## Ubuntu (Hermes) laptop — TO DO

### 1. Tailscale (same tailnet as this laptop)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up        # log in with the SAME account as the Windows laptop
tailscale status         # confirm you can see <SERVER_IP> (the Windows node)
ping <SERVER_IP>       # reachability check
```

### 2. Syncthing
```bash
sudo apt update && sudo apt install -y syncthing
# Run once to generate identity, then as a user service:
systemctl --user enable --now syncthing.service   # if available, else: syncthing serve --no-browser &
```
Open the GUI (http://127.0.0.1:8384), copy THIS Ubuntu device's ID
(Actions → Show ID).

### 3. Pair the two devices
- **On Windows** (http://127.0.0.1:8384): Add Remote Device → paste the Ubuntu
  device ID → on the **Sharing** tab tick the `career-ops` folder → Save.
- **On Ubuntu:** accept the incoming device, then accept the shared `career-ops`
  folder. Set its folder path to e.g. `/home/<you>/career-ops`. Leave it empty —
  Syncthing pulls all files from Windows on first sync (code + data + config).
- Both devices are connected once Tailscale is up; sync runs over the tailnet
  (and relays if ever apart).

### 4. Same ignore rules on Ubuntu
Syncthing does NOT auto-sync `.stignore`. After the folder appears, set its ignore
patterns (folder → Edit → Ignore Patterns) to match the repo's `.stignore`, or
copy that file's contents in.

### 5. Node deps (per-device; node_modules is not synced)
```bash
cd ~/career-ops
# install Node 20+ if missing, then:
npm install
node --version   # ensure >= 20
```

### 6. Hermes/Codex scheduled run (Linux equivalent of the Windows 4-hour task)
Create `~/career-ops-cron/run.sh`:
```bash
#!/usr/bin/env bash
set +e
cd ~/career-ops
LOCK=data/.sync-lock
# Concurrency guard: skip if the OTHER device holds a fresh (<30 min) lock
if [ -f "$LOCK" ] && [ "$(find "$LOCK" -mmin -30)" ] && ! grep -q "$(hostname)" "$LOCK"; then
  echo "$(date -Is) other device running ($(cat "$LOCK")) — skip"; exit 0
fi
echo "$(hostname) $(date -Is)" > "$LOCK"
# Hermes is a Codex-based harness → invoke career-ops with the same prompt:
codex exec "$(cat ~/career-ops-cron/morning-prompt.txt)" 2>&1 | tee -a "logs/$(date +%F).log"
rm -f "$LOCK"
```
Copy the prompt over (it's in the synced repo at `data/`? no — it lives on Windows
at `%USERPROFILE%\.career-ops-cron\morning-prompt.txt`). Easiest: paste the same
prompt into `~/career-ops-cron/morning-prompt.txt` on Ubuntu. (Adjust `codex exec`
to however the openclaw/Codex harness is actually invoked.)

systemd timer (every 4 hours):
```ini
# ~/.config/systemd/user/career-ops.service
[Service]
ExecStart=%h/career-ops-cron/run.sh

# ~/.config/systemd/user/career-ops.timer
[Timer]
OnBootSec=10min
OnUnitActiveSec=4h
[Install]
WantedBy=timers.target
```
```bash
chmod +x ~/career-ops-cron/run.sh
systemctl --user enable --now career-ops.timer
```

### 7. (Optional) Webapp on Ubuntu
The dashboard runs on Linux too: `docker compose up -d --build career-ops-dashboard`.
Or skip it and just view the Windows webapp at `http://<SERVER_IP>:5050` over Tailscale.

---

## Concurrency rule (both devices)
Run career-ops on **one device at a time**. The `data/.sync-lock` convention above
prevents the 4-hour timers from overlapping. If a `*.sync-conflict-*` file ever
appears (simultaneous edits), keep the newer and delete the conflict copy.

## Reachability
- Windows webapp over Tailscale: `http://<SERVER_IP>:5050` (ensure Windows
  Firewall allows inbound TCP 5050 on the Tailscale interface).
- Syncthing sync needs no port-forwarding — it discovers peers over the tailnet.
