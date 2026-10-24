// sidepanel.js — the chat panel.
//
// One conversation, one input. Everything the old four-tab panel did (application answers,
// message drafting, page reading, invite budget, person and thread lookup) is reachable by
// asking for it — the agent picks the tool. Removing the tabs is the point: a tab per feature
// meant knowing which tab a question belonged to before you could ask it. The old panel is kept
// at sidepanel.js.tabs-backup.
//
// Transport is fetch + SSE rather than EventSource, because EventSource cannot POST or set an
// Authorization header. Steps stream in as they happen; a tool loop takes tens of seconds and a
// silent spinner for that long reads as broken.

const $ = (id) => document.getElementById(id);
const state = { endpoint: null, token: null, history: [], busy: false, ctx: null, useCtx: false };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Deliberately tiny markdown: bold, inline code, fenced code, links, and pipe tables — the
// shapes the model actually produces. Anything richer is a rendering bug waiting to happen.
function render(md) {
  const text = String(md ?? '');
  return text.split(/```/).map((block, i) => {
    if (i % 2 === 1) return `<pre>${esc(block.replace(/^\w*\n/, ''))}</pre>`;
    const out = [];
    let table = null;
    const flush = () => {
      if (!table) return;
      const rows = table.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
      const cells = rows.map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      if (cells.length) {
        out.push('<table>' + cells.map((row, ri) =>
          '<tr>' + row.map((c) => `<${ri ? 'td' : 'th'}>${inline(esc(c))}</${ri ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>');
      }
      table = null;
    };
    for (const line of block.split('\n')) {
      if (/^\s*\|.*\|\s*$/.test(line)) { (table ||= []).push(line); continue; }
      flush();
      out.push(inline(esc(line)));
    }
    flush();
    return out.join('\n');
  }).join('');
}
const inline = (s) => String(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

function addMsg(role, html) {
  $('welcome')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="body">${html}</div>`;
  $('log').appendChild(el);
  scroll();
  return el;
}
const scroll = () => { $('log').scrollTop = $('log').scrollHeight; };

async function loadConfig() {
  const c = await chrome.storage.local.get(['endpoint', 'token']);
  state.endpoint = (c.endpoint || '').replace(/\/+$/, '');
  state.token = c.token || '';
  const missing = !state.endpoint || !state.token;
  $('setup').classList.toggle('hide', !missing);
  $('send').disabled = missing;
  return !missing;
}

// ---- page context -----------------------------------------------------------

async function grabPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('linkedin.com')) return { ok: false, why: 'not a LinkedIn page' };
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT' });
    if (!r?.ok) return { ok: false, why: r?.missing ? `could not read ${r.missing}` : 'nothing readable here' };
    const text = r.pageType === 'message'
      ? (r.messages || []).map((m) => `${m.from}: ${m.text}`).join('\n')
      : (r.text || r.description || '');
    return { ok: true, type: r.pageType, url: tab.url, text, title: tab.title };
  } catch {
    // The content script is not injected on non-LinkedIn tabs, and sendMessage throws rather
    // than returning — that is "no context available", not an error worth surfacing loudly.
    return { ok: false, why: 'no reader on this page' };
  }
}

async function toggleCtx() {
  if (state.useCtx) {
    state.useCtx = false; state.ctx = null;
    $('ctxBtn').classList.remove('on'); $('ctxLabel').textContent = '';
    return;
  }
  $('ctxLabel').textContent = 'reading…';
  const p = await grabPage();
  if (!p.ok) { $('ctxLabel').textContent = p.why; return; }
  state.ctx = p; state.useCtx = true;
  $('ctxBtn').classList.add('on');
  $('ctxLabel').textContent = `${p.type} · ${p.text.length.toLocaleString()} chars`;
}

// ---- send -------------------------------------------------------------------

async function send() {
  const input = $('input');
  const message = input.value.trim();
  if (!message || state.busy) return;
  if (!(await loadConfig())) return;

  state.busy = true;
  $('send').disabled = true;
  input.value = '';
  input.style.height = 'auto';
  addMsg('user', esc(message));

  const wrap = addMsg('assistant', '');
  const body = wrap.querySelector('.body');
  const steps = document.createElement('div');
  steps.className = 'steps';
  body.before(steps);
  const pending = new Map();

  const addStep = (label) => {
    const el = document.createElement('div');
    el.className = 'step';
    el.innerHTML = `<span class="dot"></span><span><span class="lbl">${esc(label)}</span> <span class="res"></span></span>`;
    steps.appendChild(el); scroll();
    return el;
  };
  let thinking = addStep('thinking…');
  const clearThinking = () => { thinking?.remove(); thinking = null; };

  try {
    const res = await fetch(`${state.endpoint}/api/assist/agent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer\u0020${state.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message,
        history: state.history.slice(-12),
        context: state.useCtx && state.ctx
          ? { type: state.ctx.type, url: state.ctx.url, text: state.ctx.text }
          : undefined,
      }),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);

    let answered = false;
    await readSSE(res, (event, data) => {
      if (event === 'tool') {
        clearThinking();
        pending.set(data.n, addStep(data.label));
      } else if (event === 'tool_result') {
        const el = pending.get(data.n);
        if (el) {
          el.classList.add(data.ok ? 'done' : 'fail');
          el.querySelector('.res').textContent = `— ${data.summary}`;
        }
      } else if (event === 'answer') {
        answered = true;
        clearThinking();
        body.innerHTML = render(data.answer);
        state.history.push({ role: 'user', content: message }, { role: 'assistant', content: data.answer });
        if (data.warnings?.length) {
          const f = document.createElement('div');
          f.className = 'flags';
          f.textContent = `Flagged by your rules: ${data.warnings.map((w) => `${w.rule}${w.term ? ` (${w.term})` : ''}`).join(', ')}`;
          body.appendChild(f);
        }
        scroll();
      } else if (event === 'error') {
        clearThinking();
        body.innerHTML = `<span class="err">${esc(data.error)}${data.detail ? ` — ${esc(data.detail)}` : ''}</span>`;
        scroll();
      }
    });
    if (!answered && !body.innerHTML) {
      body.innerHTML = '<span class="err">The connection ended before an answer arrived.</span>';
    }
  } catch (e) {
    clearThinking();
    body.innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
  } finally {
    state.busy = false;
    $('send').disabled = false;
    input.focus();
    scroll();
  }
}

/** Parse an SSE body off a fetch stream. */
async function readSSE(res, on) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try { on(event, JSON.parse(data.join('\n'))); } catch { /* skip a malformed frame */ }
    }
  }
}

// ---- wiring -----------------------------------------------------------------

$('send').addEventListener('click', send);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
});
$('ctxBtn').addEventListener('click', toggleCtx);
$('newChat').addEventListener('click', () => {
  state.history = [];
  $('log').innerHTML = '';
  addMsg('assistant', '<span class="empty">New conversation.</span>');
});
for (const id of ['openOptions', 'setupLink']) {
  $(id)?.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}

loadConfig();
$('input').focus();
