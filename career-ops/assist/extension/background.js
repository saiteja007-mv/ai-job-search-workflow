// Service worker: side panel behaviour + the live invite-budget poll.
//
// WHY A BACKGROUND ALARM RATHER THAN A TIMER IN THE PANEL: the trailing-7-day invite window
// moves on its own as days roll off the back, so the number goes stale whether or not the
// panel is open. A setInterval in the panel only runs while the panel is open, which is
// exactly when you do NOT need reminding. An alarm keeps the badge honest, so the headroom is
// visible before you open anything and start sending.
//
// Holds no secrets and does no generation — it reads one read-only endpoint.

const DEFAULT_ENDPOINT = 'https://<YOUR_DOMAIN>';
const ALARM = 'budget-refresh';
const DEFAULT_HOURS = 1;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  scheduleBudget();
  refreshBudget();
});

// Chrome suspends the service worker aggressively; onStartup re-arms after a browser restart.
chrome.runtime.onStartup.addListener(() => { scheduleBudget(); refreshBudget(); });

async function scheduleBudget() {
  const { budgetHours } = await chrome.storage.local.get('budgetHours');
  const hours = Number(budgetHours) > 0 ? Number(budgetHours) : DEFAULT_HOURS;
  // periodInMinutes is the floor Chrome honours; it may fire later if the worker is asleep,
  // which is why the panel also shows the age of the reading rather than implying freshness.
  chrome.alarms.create(ALARM, { periodInMinutes: hours * 60, delayInMinutes: 0.1 });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) refreshBudget(); });

// The panel asks for an immediate refresh when it opens or when you hit Refresh.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'REFRESH_BUDGET') { refreshBudget().then(sendResponse); return true; }
  if (msg?.type === 'RESCHEDULE_BUDGET') { scheduleBudget().then(() => sendResponse({ ok: true })); return true; }
});

function setBadge(invites) {
  if (!invites?.available) {
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setTitle({ title: 'LinkedIn Copilot — invite budget unavailable' });
    return;
  }
  const left = Number(invites.remainingThisWeek ?? 0);
  chrome.action.setBadgeText({ text: String(Math.max(0, left)) });
  // Red once the week's headroom is gone, amber when the ledger says WARNING, else green.
  const color = left <= 0 ? '#c62828' : (invites.status && invites.status !== 'OK' ? '#ef6c00' : '#2e7d32');
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({
    title: `LinkedIn Copilot — ${invites.trailing7}/${invites.safeWeekly} invites in the last 7 days, ${left} left this week (${invites.status})`,
  });
}

async function refreshBudget() {
  const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
  if (!token) {
    chrome.action.setBadgeText({ text: '' });
    return { ok: false, reason: 'not configured' };
  }
  const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/api/assist/context', { headers: { Authorization: 'Bearer\u0020' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const invites = body.invites || {};
    const record = { invites, fetchedAt: Date.now(), ok: true };
    await chrome.storage.local.set({ budget: record });
    setBadge(invites);
    return record;
  } catch (e) {
    // Keep the last good reading and mark it stale rather than blanking it — a number with a
    // timestamp is more useful than an empty panel when the server is briefly unreachable.
    const { budget } = await chrome.storage.local.get('budget');
    const record = { ...(budget || {}), ok: false, error: String(e.message || e), checkedAt: Date.now() };
    await chrome.storage.local.set({ budget: record });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setTitle({ title: 'LinkedIn Copilot — could not reach the assist server' });
    return record;
  }
}
