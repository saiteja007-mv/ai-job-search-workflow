// LinkedIn invitation ledger — union of every log that records a confirmed send.
//
// Only records carrying an `invitation_id` count: that field is written solely on a
// Unipile 201, so it is the one reliable marker of a delivered invitation. Attempt
// rows without it are queued/failed/skipped and must never inflate the counts.
//
// Multiple writers append to different files (the scheduled run, the CSV outreach
// workflow, ad-hoc scripts), so the union is deduped by provider_id.

import fs from "fs";
import path from "path";

// LinkedIn publishes NO numeric invitation limit. These are OUR budget, not their API.
// OBSERVED_BLOCK: rolling-7d total on 2026-08-22 when a 422 came back — it was cannot_resend_yet
// (per-recipient duplicate), NOT a weekly cap; kept only as a historical marker.
// 2026-09-11 recalibration (<YOUR_NAME>: "use the limit to the fullest"). Verified facts:
//  - Unipile's provider-limits doc: a PAID, active LinkedIn account can send 80-100 invitations
//    per day and ~200 per week WITH a note; Unipile recommends spacing sends and 30-50/day.
//  - This account is LinkedIn Premium (Unipile /users/me premium:true, no Sales Navigator).
//  - Industry consensus: ~100/week for ordinary accounts, 150-200 for Premium/warmed accounts.
//  - Empirically this account sent 116/week (W34), 105 (W35), 148 on 2026-09-01's LinkedIn
//    count, with ZERO weekly-limit refusals ever recorded. The "block at 112" of 2026-08-22 was
//    a 422 errors/cannot_resend_yet — a PER-RECIPIENT "you already invited this person" error
//    (see reports/tsenta-nightly-2026-08-22.md), misread as an account cap.
//  170/week and 30/day keep a margin under the documented 200 while more than doubling capacity.
//  The one real risk signal is the pending backlog (900 unanswered invites on 2026-09-11).
export const SAFE_WEEKLY = 250; // raised 2026-09-29 by <YOUR_NAME> (was 170)
export const SAFE_DAILY = 35; // raised 2026-09-29 by <YOUR_NAME> (was 30)
export const OBSERVED_BLOCK = 112;

const LEDGERS = [
  { file: "data/outreach_log.json", pick: j => j.sent_profiles || {} },
  { file: ".tmp/_invites.json", pick: j => j },
  { file: ".tmp/api2.json", pick: j => j.sent_profiles || {} },
];

const DAY = 86400000;
export const toDay = ms => new Date(ms).toISOString().slice(0, 10);
export const dayMs = d => Date.parse(d + "T00:00:00Z");
export const addDays = (d, n) => toDay(dayMs(d) + n * DAY);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// The confirmed-send marker is not always top-level. The MCP and the scheduled scans write
// `invitation_id` on the record itself; tsenta_unipile_outreach.py (and the CSV outreach
// scripts) store Unipile's whole reply under `unipile_response` and put the id INSIDE it.
// Reading only the top-level field silently dropped every tsenta send: on 2026-09-01 this
// returned trailing7=36 while the same file held 125 confirmed sends and LinkedIn reported
// 148 — and a batch was sized against the 36. A 422 reply carries no invitation_id in either
// place, so widening where we look does not let failed attempts in.
function confirmedInvitationId(rec) {
  const status = rec.unipile_status;
  if (status != null && Number(status) !== 201) return null;
  return rec.invitation_id
    || rec.unipile_response?.invitation_id
    || rec.unipile_response?.id
    || null;
}

/** Union of all ledgers, deduped by provider_id, confirmed sends only. */
export function loadInvites(root = ".") {
  const byPid = new Map();
  const sources = [];
  for (const { file, pick } of LEDGERS) {
    const full = path.join(root, file);
    const j = readJson(full);
    if (!j) continue;
    let n = 0;
    for (const [rawPid, rec] of Object.entries(pick(j) || {})) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.alias_for) continue; // a pointer to another key, never a send in its own right
      const id = confirmedInvitationId(rec);
      if (!id) continue;
      n++;
      // tsenta writes keys as "provider:ACoAA…", the MCP as bare "ACoAA…" — same person.
      const pid = String(rawPid).replace(/^provider:/, "");
      if (byPid.has(pid)) continue; // first writer wins; they agree on the date
      const date = String(rec.sent_at || rec.ts || "").slice(0, 10);
      byPid.set(pid, {
        pid,
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        name: rec.name || rec.public_id || pid.slice(0, 12),
        company: rec.company || "",
        role: rec.role || "",
        id,
      });
    }
    sources.push({ file, records: n });
  }
  const invites = [...byPid.values()];
  invites.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { invites, sources };
}

/** date -> count, undated excluded. */
export function dailyCounts(invites) {
  const m = new Map();
  for (const i of invites) if (i.date) m.set(i.date, (m.get(i.date) || 0) + 1);
  return m;
}

/** Sends in the `win`-day window ENDING on `end` (inclusive). */
export function rolling(daily, end, win = 7) {
  let n = 0;
  for (let k = 0; k < win; k++) n += daily.get(addDays(end, -k)) || 0;
  return n;
}

/** Trailing-7d for each of the next `days` days assuming nothing more is sent. */
export function forecast(daily, from, days = 7, cap = SAFE_WEEKLY) {
  const out = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(from, k);
    const t = rolling(daily, date);
    out.push({ date, trailing7: t, headroom: cap - t, over: t >= cap });
  }
  return out;
}

/** First date on which trailing-7d drops to/below cap. null if already clear. */
export function clearsOn(daily, from, cap = SAFE_WEEKLY, horizon = 21) {
  for (let k = 0; k < horizon; k++) {
    const date = addDays(from, k);
    if (rolling(daily, date) <= cap) return date;
  }
  return null;
}

export function byCompany(invites, limit = 12) {
  const m = new Map();
  for (const i of invites) {
    const c = i.company || "(unknown)";
    m.set(c, (m.get(c) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function summarize(root = ".", today = toDay(Date.now())) {
  const { invites, sources } = loadInvites(root);
  const daily = dailyCounts(invites);
  const dates = [...daily.keys()].sort();
  const trailing7 = rolling(daily, today);
  const peak = dates.reduce((a, d) => (daily.get(d) > (daily.get(a) || 0) ? d : a), dates[0]);

  let status = "OK";
  if (trailing7 >= OBSERVED_BLOCK) status = "BLOCKED";
  else if (trailing7 >= SAFE_WEEKLY) status = "OVER BUDGET";
  else if (trailing7 >= SAFE_WEEKLY * 0.75) status = "WARNING";

  const lastSend = dates.length ? dates[dates.length - 1] : null;
  return {
    today,
    total: invites.length,
    undated: invites.filter(i => !i.date).length,
    firstSend: dates[0] || null,
    lastSend,
    daysSinceLastSend: lastSend ? Math.round((dayMs(today) - dayMs(lastSend)) / DAY) : null,
    sentToday: daily.get(today) || 0,
    trailing7,
    status,
    safeWeekly: SAFE_WEEKLY,
    safeDaily: SAFE_DAILY,
    observedBlock: OBSERVED_BLOCK,
    remainingThisWeek: Math.max(0, SAFE_WEEKLY - trailing7),
    remainingToday: Math.max(0, Math.min(SAFE_DAILY - (daily.get(today) || 0), SAFE_WEEKLY - trailing7)),
    peakDay: peak ? { date: peak, count: daily.get(peak) } : null,
    clearsOn: trailing7 > SAFE_WEEKLY ? clearsOn(daily, today) : null,
    forecast: forecast(daily, today, 8),
    daily,
    dates,
    invites,
    sources,
  };
}

// ponytail: self-check instead of a test framework. `node lib/invite-ledger.mjs --check`
function check() {
  const assert = (c, m) => {
    if (!c) throw new Error("FAIL: " + m);
  };
  assert(addDays("2026-08-22", -1) === "2026-08-21", "addDays back");
  assert(addDays("2026-03-01", -1) === "2026-02-28", "addDays across month");
  assert(addDays("2026-01-01", -1) === "2025-12-31", "addDays across year");

  const daily = new Map([
    ["2026-08-17", 36],
    ["2026-08-18", 46],
    ["2026-08-19", 18],
    ["2026-08-20", 4],
  ]);
  // window ending 08-20 covers 08-14..08-20 -> all four days
  assert(rolling(daily, "2026-08-20") === 104, "rolling includes full 7d window");
  // 08-24 drops 08-17 out of the window
  assert(rolling(daily, "2026-08-24") === 68, "rolling rolls off oldest day");
  // 08-26 leaves only 08-20
  assert(rolling(daily, "2026-08-26") === 4, "rolling nearly empty");
  assert(rolling(daily, "2026-09-01") === 0, "rolling empty past window");

  const f = forecast(daily, "2026-08-22", 4, 80);
  assert(f[0].date === "2026-08-22" && f[0].trailing7 === 104, "forecast day 0");
  assert(f[0].over === true, "forecast flags over-budget");
  assert(f[2].date === "2026-08-24" && f[2].trailing7 === 68, "forecast day 2 rolls off");
  assert(f[2].over === false && f[2].headroom === 12, "headroom vs cap 80");

  assert(clearsOn(daily, "2026-08-22", 80) === "2026-08-24", "clearsOn finds first clear day");
  assert(clearsOn(daily, "2026-08-22", 200) === "2026-08-22", "clearsOn immediate when under cap");

  // dedupe: same provider_id in two ledgers counts once
  const dup = dailyCounts([
    { pid: "A", date: "2026-08-01" },
    { pid: "B", date: "2026-08-01" },
    { pid: "C", date: null },
  ]);
  assert(dup.get("2026-08-01") === 2, "dailyCounts skips undated");
  assert(dup.size === 1, "dailyCounts has no null key");

  console.log("invite-ledger self-check: all assertions passed");
}

if (process.argv[1] && process.argv[1].endsWith("invite-ledger.mjs") && process.argv.includes("--check")) check();
