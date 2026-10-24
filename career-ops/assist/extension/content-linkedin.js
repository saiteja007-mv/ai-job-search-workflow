// content-linkedin.js — DOM extraction for the three LinkedIn surfaces.
//
// Spec §8: "LinkedIn DOM changes -> Extractors fail loudly with the selector that broke."
// Every selector lives in SELECTORS below so a redesign is a one-line fix, and a failed
// extraction reports WHICH selector missed rather than silently returning empty text.
//
// Read-only: this script never clicks, types, sends or submits. It reads DOM the user is
// already looking at.

const SELECTORS = {
  message: {
    thread: ['.msg-s-message-list-content', '.msg-s-message-list', '[data-view-name="message-thread"]'],
    bubble: ['.msg-s-event-listitem', '.msg-s-message-list__event'],
    sender: ['.msg-s-message-group__name', '.msg-s-event-listitem__name'],
    body: ['.msg-s-event-listitem__body', '.msg-s-event__content'],
    correspondent: ['.msg-entity-lockup__entity-title', '.msg-thread__link-to-profile'],
    correspondentLink: ['a.msg-thread__link-to-profile', '.msg-entity-lockup a[href*="/in/"]', '.msg-conversation-card__participant-names a[href*="/in/"]'],
    correspondentHeadline: ['.msg-entity-lockup__entity-info', '.msg-thread__topcard-subtitle'],
  },
  post: {
    container: ['.feed-shared-update-v2', '[data-urn*="activity"]', '.occludable-update'],
    author: ['.update-components-actor__title', '.feed-shared-actor__name'],
    text: ['.update-components-text', '.feed-shared-update-v2__description', '.feed-shared-text'],
    authorLink: ['.update-components-actor__meta-link', '.feed-shared-actor__container-link', 'a[href*="/in/"]'],
    authorHeadline: ['.update-components-actor__description', '.feed-shared-actor__description'],
  },
  job: {
    container: ['.jobs-details', '.job-view-layout', '.jobs-search__job-details'],
    title: ['.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', 'h1'],
    company: ['.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name'],
    location: ['.job-details-jobs-unified-top-card__bullet', '.jobs-unified-top-card__bullet'],
    description: ['.jobs-description__content', '.jobs-box__html-content', '#job-details'],
  },
};

const pick = (root, list) => {
  for (const sel of list) { const el = root.querySelector(sel); if (el) return el; }
  return null;
};
const pickAll = (root, list) => {
  for (const sel of list) { const els = root.querySelectorAll(sel); if (els.length) return [...els]; }
  return [];
};
const txt = (el) => (el ? el.innerText.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '');

function detectPageType() {
  const u = location.href;
  if (/\/messaging\//.test(u)) return 'message';
  if (/\/jobs\/(view|search)/.test(u)) return 'job';
  if (/\/feed\/update\/|\/posts\//.test(u)) return 'post';
  // Fall back to what is actually on the page — LinkedIn routes a lot through /feed/.
  if (pick(document, SELECTORS.job.container)) return 'job';
  if (pick(document, SELECTORS.message.thread)) return 'message';
  if (pick(document, SELECTORS.post.container)) return 'post';
  return 'unknown';
}

function extractMessage() {
  const thread = pick(document, SELECTORS.message.thread);
  if (!thread) return { ok: false, missing: 'message.thread', tried: SELECTORS.message.thread };
  const bubbles = pickAll(thread, SELECTORS.message.bubble);
  if (!bubbles.length) return { ok: false, missing: 'message.bubble', tried: SELECTORS.message.bubble };
  let lastFrom = '';
  const messages = bubbles.map((b) => {
    const who = txt(pick(b, SELECTORS.message.sender));
    if (who) lastFrom = who;           // LinkedIn only labels the first bubble of a run
    return { from: who || lastFrom, text: txt(pick(b, SELECTORS.message.body)) };
  }).filter((m) => m.text);
  if (!messages.length) return { ok: false, missing: 'message.body', tried: SELECTORS.message.body };
  // WHOLE thread, not the last 15. Answering "what do I say next" needs everything already
  // said; a truncated thread is how a reply repeats a point or contradicts an earlier turn.
  const link = pick(document, SELECTORS.message.correspondentLink);
  const profileUrl = link ? link.href.split('?')[0] : '';
  return {
    ok: true, pageType: 'message',
    correspondent: txt(pick(document, SELECTORS.message.correspondent)) || messages[0].from || 'unknown',
    correspondentUrl: profileUrl,
    publicId: profileUrl ? profileUrl.replace(/\/+$/, '').split('/').pop() : '',
    correspondentHeadline: txt(pick(document, SELECTORS.message.correspondentHeadline)).split('\n')[0] || '',
    messages,
    messageCount: messages.length,
  };
}

function extractPost() {
  const c = pick(document, SELECTORS.post.container);
  if (!c) return { ok: false, missing: 'post.container', tried: SELECTORS.post.container };
  const text = txt(pick(c, SELECTORS.post.text));
  if (!text) return { ok: false, missing: 'post.text', tried: SELECTORS.post.text };
  const author = txt(pick(c, SELECTORS.post.author)).split('\n')[0] || 'unknown';
  const aLink = pick(c, SELECTORS.post.authorLink);
  const profileUrl = aLink ? aLink.href.split('?')[0] : '';
  // Classify locally — a job post and a general post want different drafts (spec §1).
  const isJobPost = /\b(hiring|we'?re hiring|join our team|open role|now hiring|apply now|job opening)\b/i.test(text);
  return {
    ok: true, pageType: 'post', author, text, isJobPost,
    profileUrl,
    publicId: profileUrl && /\/in\//.test(profileUrl) ? profileUrl.replace(/\/+$/, '').split('/').pop() : '',
    authorHeadline: txt(pick(c, SELECTORS.post.authorHeadline)).split('\n')[0] || '',
  };
}

function extractJob() {
  const c = pick(document, SELECTORS.job.container) || document.body;
  const description = txt(pick(c, SELECTORS.job.description));
  if (!description) return { ok: false, missing: 'job.description', tried: SELECTORS.job.description };
  return {
    ok: true, pageType: 'job',
    title: txt(pick(c, SELECTORS.job.title)).split('\n')[0] || '',
    company: txt(pick(c, SELECTORS.job.company)).split('\n')[0] || '',
    location: txt(pick(c, SELECTORS.job.location)).split('\n')[0] || '',
    description,
    url: location.href,
  };
}

function extract() {
  const pageType = detectPageType();
  if (pageType === 'message') return extractMessage();
  if (pageType === 'post') return extractPost();
  if (pageType === 'job') return extractJob();
  return { ok: false, missing: 'pageType', reason: 'not a LinkedIn message, post or job page', url: location.href };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'EXTRACT') return;
  try { sendResponse(extract()); }
  catch (e) { sendResponse({ ok: false, missing: 'exception', reason: String(e.message || e) }); }
  return true;
});
