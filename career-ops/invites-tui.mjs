#!/usr/bin/env node
// invites-tui.mjs — LinkedIn invitation rate-limit dashboard.
//
// Answers one question fast: can I safely send invitations right now, and if not, when?
// Zero dependencies: raw ANSI + Node stdlib. Read-only — it never sends anything.
//
//   node invites-tui.mjs           interactive TUI
//   node invites-tui.mjs --once    render one frame and exit (pipe-friendly)
//   node invites-tui.mjs --json    machine-readable metrics
//
// Keys: 1/2/3 views · j/k scroll · r refresh · ? help · q quit

import fs from "fs";
import { summarize, SAFE_DAILY, SAFE_WEEKLY, OBSERVED_BLOCK, addDays } from "./lib/invite-ledger.mjs";

const ROOT = ".";
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const TTY = process.stdout.isTTY;
const ONCE = has("--once") || has("-1") || !TTY;
const JSON_OUT = has("--json");

// ── capability detection ────────────────────────────────────────────────────
// NO_COLOR is a cross-tool convention (no-color.org): any value means disable.
// Colour also goes away when stdout is not a terminal, unless explicitly forced —
// otherwise escape codes end up inside piped output and log files.
const FORCE_COLOR = has("--color") || process.env.FORCE_COLOR !== undefined;
const NO_COLOR = process.env.NO_COLOR !== undefined || has("--no-color") || (!TTY && !FORCE_COLOR);
const TRUE_COLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
// Windows consoles that predate Terminal, and dumb terminals, get ASCII boxes.
const UNICODE = !/^(dumb|cons25)$/i.test(process.env.TERM || "") && process.env.CAREEROPS_ASCII === undefined;

// ── palette (Catppuccin Mocha — matches dashboard/internal/theme) ───────────
const HEX = {
  text: "#cdd6f4", sub: "#a6adc8", dim: "#6c7086", surface: "#45475a",
  green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8",
  blue: "#89b4fa", mauve: "#cba6f7", peach: "#fab387",
};
const X256 = { text: 189, sub: 145, dim: 242, surface: 238, green: 114, yellow: 179, red: 210, blue: 111, mauve: 141, peach: 215 };

function fg(name) {
  if (NO_COLOR) return "";
  if (TRUE_COLOR) {
    const h = HEX[name];
    return `\x1b[38;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m`;
  }
  return `\x1b[38;5;${X256[name]}m`;
}
const RESET = NO_COLOR ? "" : "\x1b[0m";
const BOLD = NO_COLOR ? "" : "\x1b[1m";
const DIM = NO_COLOR ? "" : "\x1b[2m";
const c = (name, s) => (NO_COLOR ? s : fg(name) + s + RESET);
const b = s => (NO_COLOR ? s : BOLD + s + RESET);

// visible width, ignoring escape sequences
const vlen = s => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vlen(s)));
const padL = (s, n) => " ".repeat(Math.max(0, n - vlen(s))) + s;
// Cut to n cells with a visible signal. U+2026 is ONE cell; "..." is three.
const ELL = UNICODE ? "…" : "~";
const trunc = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + ELL);

const CH = UNICODE
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", bar: "█", dash: "┈", up: "▲", dot: "·" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", bar: "#", dash: ".", up: "^", dot: "-" };
const BLOCKS = UNICODE ? ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] : ["", ".", ".", "-", "-", "=", "=", "#", "#"];

// ── terminal lifecycle ──────────────────────────────────────────────────────
// Setup and teardown live side by side so they cannot drift: every private mode
// enabled on the left has a matching disable on the right.
//  ?1049 alt screen · ?25 cursor · ?7 autowrap · 2J clear ONCE (never per frame)
const SETUP = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H";
const RESTORE = "\x1b[?2026l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l";
// Synchronized output: the terminal buffers the whole frame and paints it at once.
const SYNC_ON = "\x1b[?2026h", SYNC_OFF = "\x1b[?2026l";
let rawActive = false;
let entered = false;

function enterTui() {
  entered = true;
  process.stdout.write(SETUP);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawActive = true;
  }
  process.stdin.resume();
}
// Restoring is not optional: skip it and the user's shell is left with no cursor
// in an alternate buffer. Wire it to every exit path, not just the happy one.
let restored = false;
function restore() {
  if (restored || !entered) return; // never emit restore codes we did not cause
  restored = true;
  if (rawActive && process.stdin.isTTY) try { process.stdin.setRawMode(false); } catch {}
  // writeSync, not stdout.write: on Windows pipes stdout is async and the restore
  // can be dropped on the way out, leaving the terminal with no cursor.
  try { fs.writeSync(1, RESTORE); } catch { process.stdout.write(RESTORE); }
}
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 143); });
}
process.on("uncaughtException", e => { restore(); console.error(e); process.exit(1); });

// ── widgets ─────────────────────────────────────────────────────────────────
function box(title, width, lines, tone = "surface") {
  const t = title ? ` ${title} ` : "";
  const top = c(tone, CH.tl + CH.h) + b(t) + c(tone, CH.h.repeat(Math.max(0, width - 3 - vlen(t))) + CH.tr);
  const out = [top];
  for (const l of lines) out.push(c(tone, CH.v) + " " + pad(l, width - 3) + c(tone, CH.v));
  out.push(c(tone, CH.bl + CH.h.repeat(width - 2) + CH.br));
  return out;
}

/** Horizontal gauge with two threshold markers. */
function gauge(value, cap, hard, width) {
  const scale = Math.max(cap, hard, value) * 1.05;
  const filled = Math.round((value / scale) * width);
  const capAt = Math.round((cap / scale) * width);
  const hardAt = Math.round((hard / scale) * width);
  let tone = "green";
  if (value >= hard) tone = "red";
  else if (value >= cap) tone = "peach";
  else if (value >= cap * 0.75) tone = "yellow";

  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) bar += c(tone, CH.bar);
    else if (i === capAt || i === hardAt) bar += c("dim", CH.v);
    else bar += c("surface", UNICODE ? "░" : ".");
  }
  // marker row: label the two thresholds beneath their positions
  let marks = " ".repeat(width).split("");
  const put = (at, label) => {
    const start = Math.max(0, Math.min(width - label.length, at - Math.floor(label.length / 2)));
    for (let i = 0; i < label.length; i++) marks[start + i] = label[i];
  };
  put(capAt, `${CH.up}budget ${cap}`);
  const hardLabel = `${CH.up}blocked ${hard}`;
  // Only drop the second marker if it would collide with the first, not merely
  // because it sits near the right edge — put() already clamps into range.
  if (hardAt - capAt > `${CH.up}budget ${cap}`.length) put(hardAt, hardLabel);
  return [bar, c("dim", marks.join("").replace(/\s+$/, ""))];
}

/** Vertical column chart. `series` is [{label, value}]. */
function columns(series, height, dailyCap) {
  const max = Math.max(1, ...series.map(s => s.value));
  const colW = 2;
  const rows = [];
  for (let r = height - 1; r >= 0; r--) {
    const lo = (r / height) * max;
    const hi = ((r + 1) / height) * max;
    const threshRow = dailyCap > lo && dailyCap <= hi;
    let line = "";
    for (const s of series) {
      const eighths = Math.round((s.value / max) * height * 8);
      const cell = Math.max(0, Math.min(8, eighths - r * 8));
      let tone = "green";
      if (s.value > dailyCap * 2) tone = "red";
      else if (s.value > dailyCap) tone = "peach";
      if (cell > 0) line += c(tone, BLOCKS[cell].repeat(colW));
      else line += threshRow ? c("dim", CH.dash.repeat(colW)) : " ".repeat(colW);
    }
    const axis = r === height - 1 ? padL(String(max), 4)
      : threshRow ? c("dim", padL(String(dailyCap), 4))
      : r === 0 ? padL("0", 4) : "    ";
    rows.push(axis + " " + line);
  }
  // x labels every 3rd column, anchored under their bar
  let lab = "";
  series.forEach((s, i) => { lab += i % 3 === 0 ? pad(s.label, colW * 3) : ""; });
  rows.push("     " + c("dim", lab));
  return rows;
}

function statusBadge(status) {
  const tone = status === "BLOCKED" ? "red" : status === "OVER BUDGET" ? "peach" : status === "WARNING" ? "yellow" : "green";
  // Never signal by color alone — the word carries the meaning too.
  return c(tone, BOLD + ` ${status} ` + RESET);
}

// ── views ───────────────────────────────────────────────────────────────────
function viewOverview(s, W) {
  const inner = W - 4;
  const L = [];
  L.push("");
  const head = `${statusBadge(s.status)}  ${c("sub", "trailing 7d")} ${b(String(s.trailing7))}${c("dim", " / " + s.safeWeekly + " budget")}`;
  L.push(head);
  L.push("");
  L.push(...gauge(s.trailing7, s.safeWeekly, s.observedBlock, inner - 2).map(x => " " + x));
  L.push("");

  if (s.status === "OK") {
    L.push(` ${c("green", "Clear to send.")} ${c("sub", `${s.remainingToday} today, ${s.remainingThisWeek} this week within budget.`)}`);
  } else if (s.clearsOn) {
    const days = Math.round((Date.parse(s.clearsOn) - Date.parse(s.today)) / 86400000);
    L.push(` ${c("peach", "Hold.")} ${c("sub", `Budget clears ${s.clearsOn}` + (days > 0 ? ` (${days}d)` : " (today)"))}`);
  } else {
    L.push(` ${c("red", "Over budget with no clear date inside the horizon.")}`);
  }
  L.push(c("dim", ` Last send ${s.lastSend || "never"}${s.daysSinceLastSend != null ? ` (${s.daysSinceLastSend}d ago)` : ""} ${CH.dot} ${s.total} lifetime`));
  L.push("");

  const days = 21;
  const series = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = addDays(s.today, -k);
    series.push({ label: d.slice(5), value: s.daily.get(d) || 0 });
  }
  L.push(b(" DAILY SENDS") + c("dim", `  last ${days}d ${CH.dot} peak ${s.peakDay ? s.peakDay.count + " on " + s.peakDay.date : "-"} ${CH.dot} dashed line = ${SAFE_DAILY}/day budget`));
  L.push(...columns(series, 7, SAFE_DAILY).map(x => " " + x));
  L.push("");

  L.push(b(" FORECAST") + c("dim", "  trailing 7d if nothing more is sent"));
  for (const f of s.forecast.slice(0, 6)) {
    const bar = CH.bar.repeat(Math.round((f.trailing7 / Math.max(1, s.observedBlock)) * 28));
    const tone = f.trailing7 >= s.observedBlock ? "red" : f.over ? "peach" : "green";
    const note = f.over ? c("dim", "over budget") : c("green", `${f.headroom} headroom`);
    L.push(` ${c("sub", f.date)}  ${padL(b(String(f.trailing7)), 3)}  ${c(tone, pad(bar, 28))} ${note}`);
  }
  return L;
}

function viewRecent(s, W, scroll) {
  const L = ["", b(" RECENT INVITATIONS") + c("dim", `  ${s.total} total ${CH.dot} j/k to scroll`), ""];
  const rows = s.invites.slice(scroll, scroll + 16);
  if (!rows.length) L.push(c("dim", "  nothing to show"));
  for (const i of rows) {
    L.push(` ${c("sub", i.date || "??????????")}  ${pad(b(trunc(i.name, 24)), 24)} ${c("mauve", pad(trunc(i.company, 22), 22))} ${c("dim", trunc(i.role, Math.max(0, W - 62)))}`);
  }
  L.push("");
  L.push(c("dim", `  showing ${scroll + 1}-${Math.min(scroll + 16, s.total)} of ${s.total}`));
  return L;
}

function viewCompanies(s, W) {
  const top = (function byCo(inv) {
    const m = new Map();
    for (const i of inv) m.set(i.company || "(unknown)", (m.get(i.company || "(unknown)") || 0) + 1);
    return [...m.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 14);
  })(s.invites);
  const max = Math.max(1, ...top.map(t => t[1]));
  const L = ["", b(" INVITATIONS BY COMPANY") + c("dim", `  top ${top.length}`), ""];
  for (const [co, n] of top) {
    const w = Math.round((n / max) * 34);
    L.push(` ${pad(trunc(co, 26), 26)} ${padL(b(String(n)), 3)}  ${c("blue", CH.bar.repeat(w))}`);
  }
  L.push("");
  L.push(c("dim", `  ${s.sources.map(x => `${x.file}: ${x.records}`).join("  " + CH.dot + "  ")}`));
  return L;
}

const HELP = [
  "", b(" KEYS"), "",
  `  ${b("1")}  overview        ${b("2")}  recent sends     ${b("3")}  by company`,
  `  ${b("j/k")} or ${b("arrows")}  scroll     ${b("r")}  reload data      ${b("?")}  this help`,
  `  ${b("q")} / ${b("Esc")} / ${b("Ctrl-C")}  quit`,
  "", b(" WHAT THE NUMBERS MEAN"), "",
  c("sub", `  LinkedIn publishes no numeric invitation limit. The ${SAFE_WEEKLY}/week and ${SAFE_DAILY}/day`),
  c("sub", "  figures are OUR self-imposed budget, not an API limit."),
  c("sub", `  The ${OBSERVED_BLOCK} marker is the rolling-7d total that actually earned a`),
  c("sub", "  422 errors/cannot_resend_yet on 2026-08-22."),
  "",
  c("sub", "  Only records with an invitation_id count — that is written on a Unipile 201,"),
  c("sub", "  so attempts and failures never inflate the totals."),
  "",
  c("dim", "  This dashboard is read-only. It never sends an invitation."),
];

// ── main ────────────────────────────────────────────────────────────────────
function frame(s, view, scroll, W, H, fill = true) {
  const title = ` LinkedIn Invitations `;
  const right = ` ${s.today} `;
  const barLine = c("mauve", CH.tl + CH.h) + b(title) + c("mauve", CH.h.repeat(Math.max(0, W - 4 - vlen(title) - vlen(right)))) + c("dim", right) + c("mauve", CH.h + CH.tr);

  let body;
  if (view === "help") body = HELP;
  else if (view === "recent") body = viewRecent(s, W, scroll);
  else if (view === "companies") body = viewCompanies(s, W);
  else body = viewOverview(s, W);

  const lines = [barLine];
  const avail = H - 3;
  for (const l of body.slice(0, avail)) lines.push(c("mauve", CH.v) + pad(l, W - 2) + c("mauve", CH.v));
  // Interactive mode fills the viewport so the footer pins to the bottom; a
  // one-shot render stops at the content so it does not spew blank lines.
  if (fill) for (let i = body.length; i < avail; i++) lines.push(c("mauve", CH.v) + " ".repeat(W - 2) + c("mauve", CH.v));

  const tabs = [["1", "overview", view === "overview"], ["2", "recent", view === "recent"], ["3", "company", view === "companies"]]
    .map(([k, n, on]) => (on ? c("mauve", BOLD + `${k} ${n}` + RESET) : c("dim", `${k} ${n}`))).join(c("dim", "  "));
  const hint = c("dim", `r reload ${CH.dot} ? help ${CH.dot} q quit`);
  // Pad to exactly W so the previous frame's footer is fully overwritten.
  const foot = pad(" " + tabs + " ".repeat(Math.max(1, W - 3 - vlen(tabs) - vlen(hint))) + hint, W);
  lines.push(c("mauve", CH.bl + CH.h.repeat(W - 2) + CH.br));
  lines.push(foot);
  return lines.join("\n");
}

function main() {
  let s = summarize(ROOT);

  if (JSON_OUT) {
    const { daily, invites, ...rest } = s;
    console.log(JSON.stringify({ ...rest, dailyCounts: Object.fromEntries(daily), recent: invites.slice(0, 20) }, null, 2));
    return;
  }

  const W = () => Math.max(64, Math.min(process.stdout.columns || 100, 110));
  const H = () => Math.max(20, (process.stdout.rows || 32) - 1);

  if (ONCE) {
    // Piped or --once: emit a static frame. Still useful in a scheduled run's log.
    const v = (argv.find(a => a.startsWith("--view=")) || "").split("=")[1] || "overview";
    console.log(frame(s, v, 0, W(), 999, false));
    return;
  }

  let view = "overview", scroll = 0;
  enterTui();

  const MIN_W = 64, MIN_H = 18;
  const draw = () => {
    const cols = process.stdout.columns || 80, rows = process.stdout.rows || 24;
    if (cols < MIN_W || rows < MIN_H) {
      // Say what is wrong in one line rather than rendering a garbled screen.
      process.stdout.write("\x1b[H\x1b[J" + `terminal too small: need ${MIN_W}x${MIN_H}, have ${cols}x${rows}`);
      return;
    }
    // Home + overwrite + erase-to-end. No \x1b[2J per frame: that blanks the
    // screen before the repaint lands and shows as a flash on every keystroke.
    process.stdout.write(SYNC_ON + "\x1b[H" + frame(s, view, scroll, W(), H()) + "\x1b[J" + SYNC_OFF);
  };
  draw();

  // Resize storms arrive one event per pixel-drag; coalesce them.
  let rt = null;
  process.stdout.on("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(draw, 60);
  });

  process.stdin.on("data", buf => {
    const k = buf.toString();
    if (k === "q" || k === "\x1b" || k === "\x03") { restore(); process.exit(0); }
    else if (k === "1") { view = "overview"; scroll = 0; }
    else if (k === "2") { view = "recent"; scroll = 0; }
    else if (k === "3") { view = "companies"; scroll = 0; }
    else if (k === "?" || k === "h") view = "help";
    else if (k === "r") { s = summarize(ROOT); }
    else if (k === "j" || k === "\x1b[B") scroll = Math.min(Math.max(0, s.total - 16), scroll + 1);
    else if (k === "k" || k === "\x1b[A") scroll = Math.max(0, scroll - 1);
    else if (k === "G") scroll = Math.max(0, s.total - 16);
    else if (k === "g") scroll = 0;
    else return;
    draw();
  });
}

main();
