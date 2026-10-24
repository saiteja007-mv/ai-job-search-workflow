#!/usr/bin/env node
/**
 * job-mail-rules.mjs — strict rules that classify job-hunt mail (2026-10-03).
 *
 * ONE set of phrase lists drives both the Gmail search/filter queries and a local matcher
 * (so rules can be scored offline against labeled samples). Used for the Gmail filters on the
 * personal inbox (Job hunt/* labels, contact@ mail only), the strict legacymail filters,
 * backfills and audits. "Strict" means:
 *   - a rejection needs a declarative rejection phrase AND an application-context phrase;
 *   - a submission needs a confirmation phrase and must not read as a rejection;
 *   - interviews / availability need scheduling language and must not read as a rejection;
 *   - job-alert / newsletter / survey mail is excluded everywhere.
 *
 *   node lib/job-mail-rules.mjs show                       # print the queries + lengths
 *   node lib/job-mail-rules.mjs test <account> [scope]     # per-label thread list (scope: contact|all)
 *   node lib/job-mail-rules.mjs filters <account> [--apply]   # (re)create this tool's Gmail filters
 *   node lib/job-mail-rules.mjs backfill <account> [--apply]  # label existing matching mail (dry run by default)
 *   node lib/job-mail-rules.mjs legacy-filters <account> [--apply]   # list / delete older filters feeding the same labels
 *   node lib/job-mail-rules.mjs relabel <account> [--days N] [--apply] # remove wrong labels + add missing ones
 * Gmail filters only see NEW mail; backfill covers what is already there. Unipile has no filter API
 * (v1 also cannot create labels), so filters + labels are created with gog; personal-inbox backfill uses Unipile.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTACT_SCOPE = '(to:<YOUR_EMAIL> OR deliveredto:<YOUR_EMAIL>)';

// Gmail matches straight and curly apostrophes alike ("aren’t" == "aren't"), verified 2026-10-03.
export const P = {
  REJECT: ['not moving forward', "aren't moving forward", 'not be moving forward', "won't be moving forward",
    // 'not to move forward' alone also matches 'If you decide not to move forward, you can delete...' (draft notices).
    'decided not to move forward', 'decision not to move forward', 'chosen not to move forward', 'unable to move forward', 'forward with other candidates', 'forward with other applicants',
    'forward with another candidate', 'pursue other candidates', 'pursuing other candidates', 'not to proceed',
    'not be proceeding', 'no longer under consideration', 'regret to inform', 'not been selected', 'were not selected',
    'unable to offer', 'position has been filled', 'not be progressing', 'not progress your application',
    'not a match for', 'hired someone', 'completed our hiring process', 'closing out the requisition', 'decided to go with another',
    // NOT "not selected for": confirmations say "If you are not selected for this position, ..." (held-out 2026-10-03).
    'did not select you', 'not selected to progress', 'not to select you', 'not be moving you forward', 'not moving you forward',
    'unable to move you forward', 'not move you forward', 'pursuing other applicants', 'pursue other applicants',
    'not be an ideal match', 'not going to be an ideal match', 'role is now closed', 'position is now closed',
    'role has been closed', 'position has been closed', 'no longer hiring', "won't be able to invite you",
    'not be able to invite you', 'unable to invite you', "won't be proceeding", 'only able to move forward with candidates',
    'unable to offer sponsorship', 'not be able to offer you',
    // round-3 held-out phrasing (2026-10-03)
    'pursue another candidate', 'pursue a different candidate', 'pursuing another candidate', 'is moving forward with candidates',
    'are moving forward with candidates', 'considering other candidates', 'move ahead with other candidates', 'proceed with other candidates',
    'going in a direction', 'unable to pursue your candidacy', 'unable to shortlist', 'deemed you as ineligible',
    'unfortunately you are no longer being considered', 'not take things further', 'not seeing exact alignment', 'unable to find a good match',
    'not sponsoring', 'decided to not move forward', 'not selected for further consideration', "weren't selected", "wasn't selected",
    "haven't been selected", 'was not selected', 'maximum number of applications',
    // round-4 held-out phrasing (2026-10-03)
    'forward with another applicant', 'do not have an immediate opening', "don't have an ideal fit", 'unable to provide future sponsorship', 'not able to offer you'],
  APP_CONTEXT: ['your application', 'your job application', 'your candidacy', 'your interest', 'applying', 'the position', 'the role', 'this role', 'this position'],
  SUB_SUBJECT: ['thanks for applying', 'thank you for applying', 'application received', 'we received your application',
    'application has been received', 'application submitted', 'successfully applied', 'your application was sent',
    'application confirmation', 'received your', 'thank you for your application', 'Indeed Application', 'Submitted: Application', 'Application for Dice'],
  SUB_BODY: ['received your application', 'received your resume', 'received your job application', 'has been received', 'was submitted successfully',
    'review your application', 'will be reviewing your application', 'recruiter will review', 'online submission',
    'submitted successfully', 'will be reviewed', 'review your submission', 'made its way to us'],
  // "next steps" is NOT an interview signal (assessments and questionnaires use it too).
  INT_SUBJECT: ['interview', 'phone screen', 'technical screen', 'next round', 'Invitation:'],
  INT_BODY: ['schedule', 'scheduled', 'scheduling', 'invitation', 'calendar', 'zoom', 'google meet', 'microsoft teams',
    'phone call', 'video call', 'phone screen', 'technical screen', 'your interview', 'the interview', 'interview with', 'interview is confirmed'],
  // Requests for times only: "your availability" alone also appears in rejection boilerplate ("gauge your availability").
  AVAIL: ['provide your availability', 'share your availability', 'send your availability', 'send me your availability',
    'let us know your availability', 'let me know your availability', 'provide your interview availability',
    'provide as much availability', 'time slots', 'enter your availability', 'schedule your next interview', "when you're available", 'confirm your availability', 'confirm your specific availability', 'times that work', 'times that will be convenient', 'what times work', 'available times',
    'pick a time', 'select a time', 'book a time', 'schedule your interview', 'availability request',
    'let us know when you are available', 'select your availability', 'selecting at least'],
  // An assessment / questionnaire request mentions "the interview process" but is not an interview.
  ASSESS: ['assessment', 'assessments', 'questionnaire', 'follow-up questions', 'virtual recruiter', 'coding challenge',
    'take-home', 'hackerrank', 'codility', 'codesignal', 'online test'],
  AVAIL_CONTEXT: ['interview', 'role', 'position', 'application', 'recruiter', 'hiring', 'call'],
  NOISE_SUBJECT: ['job alert', 'new roles', 'new jobs', 'newsletter', 'webinar', 'survey', 'recruiting experience', 'interview experience', 'provide feedback'],
  CANCELED: ['canceled', 'cancelled', 'no interview'],
  // An 'Application received - next steps' mail still confirms a submission, so 'next steps' is not excluded here.
  NOT_SUB_SUBJECT: ['assessment', 'interview'],
};

const any = list => `(${list.map(p => (/\s|:|'/.test(p) ? `"${p}"` : p)).join(' OR ')})`;
const NOISE = `-subject:${any(P.NOISE_SUBJECT)}`;
const PROMO = '-category:promotions -category:social';

export const RULES = {
  // Precedence: rejection > availability > interview/assessment > submission.
  Submissions: `(subject:${any(P.SUB_SUBJECT)} OR (${any(P.SUB_BODY)} ${any(P.APP_CONTEXT)})) -${any(P.REJECT)} -${any(P.AVAIL)} -subject:${any(P.NOT_SUB_SUBJECT)} ${NOISE}`,
  // LinkedIn's "Your update from <Company>" mail IS its rejection template (email_jobs_application_rejected_01,
  // 12/12 sampled 2026-10-03); its text never states the decision.
  Rejections: `((${any(P.REJECT)} ${any(P.APP_CONTEXT)}) OR (from:<CONTACT_EMAIL> "your update from")) ${NOISE}`,
  // An availability request is Availability, not (yet) an Interview.
  Interviews: `subject:${any(P.INT_SUBJECT)} ${any(P.INT_BODY)} -${any(P.AVAIL)} -${any(P.ASSESS)} -subject:${any(P.CANCELED)} -${any(P.REJECT)} ${NOISE} ${PROMO}`,
  Availability: `${any(P.AVAIL)} ${any(P.AVAIL_CONTEXT)} -subject:${any(P.CANCELED)} -${any(P.REJECT)} ${NOISE} ${PROMO}`,
};

/** Query for one label, optionally pinned to contact@ mail (the personal inbox). */
export const ruleQuery = (label, { contactOnly = false } = {}) => (contactOnly ? `${CONTACT_SCOPE} ` : '') + RULES[label];

// ---- local matcher (approximates Gmail: case-insensitive whole-word phrase match; terms match subject or body) ----
// Tokens keep inner '.', ':' and "'" (calendly.com, Invitation:, aren't) but lose them at the edges, like Gmail.
const norm = s => ` ${String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9'.:@]+/g, ' ')
  .split(' ').map(t => t.replace(/^[.:']+|[.:']+$/g, '')).filter(Boolean).join(' ')} `;
const has = (text, list) => list.some(p => text.includes(` ${norm(p).trim()} `)
  || (p.endsWith(':') && text.includes(` ${norm(p).trim()} `.replace(/ $/, ''))));
export function classifyLocal({ subject = '', body = '', from = '' }) {
  const s = norm(subject), all = norm(`${subject} ${body}`);
  const linkedinReject = /jobs-noreply@linkedin\.com/i.test(from) && has(all, ['your update from']);
  const noise = has(s, P.NOISE_SUBJECT), rej = has(all, P.REJECT), canceled = has(s, P.CANCELED), avail = has(all, P.AVAIL);
  return {
    Submissions: !noise && !rej && !avail && !has(s, P.NOT_SUB_SUBJECT) && (has(s, P.SUB_SUBJECT) || (has(all, P.SUB_BODY) && has(all, P.APP_CONTEXT))),
    Rejections: !noise && ((rej && has(all, P.APP_CONTEXT)) || linkedinReject),
    Interviews: !noise && !rej && !canceled && !avail && !has(all, P.ASSESS) && has(s, P.INT_SUBJECT) && has(all, P.INT_BODY),
    Availability: !noise && !rej && !canceled && avail && has(all, P.AVAIL_CONTEXT),
  };
}

function search(account, client, query, max = 50) {
  const r = spawnSync('gog', ['--account', account, '--client', client, 'gmail', 'search', query, '--json', '--max', String(max), '--no-input'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 300));
  return JSON.parse(r.stdout);
}

// Where each rule's label lives per mailbox. The personal inbox is only ever touched for contact@ mail.
export const MAILBOXES = {
  '<YOUR_EMAIL>': { client: 'default', contactOnly: true,
    labels: { Submissions: 'Job hunt/Submissions', Rejections: 'Job hunt/Rejections', Interviews: 'Job hunt/Interviews', Availability: 'Job hunt/Availability' } },
  '<YOUR_EMAIL>': { client: 'legacymail', contactOnly: false,
    labels: { Submissions: 'Submissions', Rejections: 'Rejections', Interviews: 'interview', Availability: 'availability' } },
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'data/gmail-job-filters.json'); // { account: { rule: filterId } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gog = (account, client, args) => {
  const r = spawnSync('gog', ['--account', account, '--client', client, ...args, '--no-input'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(0, 300));
  return r.stdout;
};

/** Every thread id matching a rule (all pages; legacymail paced for Gmail's per-minute quota). */
async function allThreads(account, rule) {
  const box = MAILBOXES[account];
  const out = []; let token = '';
  do {
    const args = ['gmail', 'search', ruleQuery(rule, { contactOnly: box.contactOnly }), '--json', '--max', '100'];
    if (token) args.push('--page', token);
    const d = JSON.parse(gog(account, box.client, args));
    out.push(...(d.threads || []));
    token = d.nextPageToken || '';
    if (token) await sleep(box.contactOnly ? 2_000 : 60_000);
  } while (token);
  return out;
}

/** Replace this tool's Gmail filters on one mailbox (previous ones are tracked in data/gmail-job-filters.json). */
function applyFilters(account) {
  const box = MAILBOXES[account];
  const reg = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : {};
  reg[account] ||= {};
  for (const [rule, label] of Object.entries(box.labels)) {
    const old = reg[account][rule];
    if (old) { try { gog(account, box.client, ['gmail', 'filters', 'delete', old, '-y']); } catch { /* already gone */ } }
    const created = JSON.parse(gog(account, box.client, ['gmail', 'filters', 'create', '-j', '--query', ruleQuery(rule, { contactOnly: box.contactOnly }), '--add-label', label]));
    reg[account][rule] = (created.filter || created).id;
    console.log(`filter ${rule} -> "${label}" ${reg[account][rule]}`);
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

/** Legacy (non-registry) filters that add one of this mailbox's managed labels — the loose legacymail ones. */
function legacyFilters(account) {
  const box = MAILBOXES[account];
  const reg = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))[account] || {} : {};
  const ours = new Set(Object.values(reg));
  const labelIds = new Map(JSON.parse(gog(account, box.client, ['gmail', 'labels', 'list', '-j'])).labels.map(l => [l.id, l.name]));
  const managed = new Set(Object.values(box.labels));
  const list = JSON.parse(gog(account, box.client, ['gmail', 'filters', 'list', '-j']));
  return (list.filters || list.filter || []).filter(f => !ours.has(f.id)
    && (f.action?.addLabelIds || []).some(id => managed.has(labelIds.get(id))));
}

// Conservative removal for the two big labels: drop Submissions only from mail that strictly reads as a
// rejection (and vice versa). Mail the rules simply don't recognise keeps its existing label, because
// rejection wording is a long tail (held-out recall ~0.75) and dropping those would lose real rejections.
const REMOVE_ONLY_IF = { Submissions: 'Rejections', Rejections: 'Submissions' };

/** Correct existing labels: remove label L where the rules say it is wrong, add it where they say yes. */
async function relabel(account, apply, days) {
  const box = MAILBOXES[account];
  const win = days ? ` newer_than:${days}d` : '';
  for (const [rule, label] of Object.entries(box.labels)) {
    const q = ruleQuery(rule, { contactOnly: box.contactOnly });
    const wrong = REMOVE_ONLY_IF[rule] ? `(${ruleQuery(REMOVE_ONLY_IF[rule], { contactOnly: box.contactOnly })})` : `-(${q})`;
    for (const [verb, query] of [['remove', `label:"${label}" ${wrong}${win}`], ['add', `(${q}) -label:"${label}"${win}`]]) {
      const ids = []; let token = '';
      do {
        const args = ['gmail', 'search', query, '--json', '--max', '100']; if (token) args.push('--page', token);
        const d = JSON.parse(gog(account, box.client, args)); ids.push(...(d.threads || []).map(t => t.id));
        token = d.nextPageToken || ''; if (token) await sleep(box.contactOnly ? 2_000 : 60_000);
      } while (token);
      console.log(`${label}: ${verb} ${ids.length}`);
      if (apply) for (const id of ids) { gog(account, box.client, ['gmail', 'labels', 'modify', id, verb === 'add' ? '--add' : '--remove', label]); await sleep(250); }
    }
  }
}

/** Unipile: map Gmail thread id -> Unipile emails for contact@ mail on the personal account. */
async function unipileContactEmails() {
  const { readEnv } = await import('./outreach-email.mjs');
  const env = readEnv(ROOT);
  const account = env.UNIPILE_GMAIL_PERSONAL_ACCOUNT_ID || env.UNIPILE_PERSONAL_GMAIL_ACCOUNT_ID;
  const base = String(env.UNIPILE_API_BASE).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const H = { 'X-API-KEY': env.UNIPILE_API_KEY, accept: 'application/json', 'content-type': 'application/json' };
  const byThread = new Map(); let cursor = null;
  do {
    const u = new URL(`${base}/api/v1/emails`);
    u.searchParams.set('account_id', account); u.searchParams.set('limit', '100'); u.searchParams.set('meta_only', 'true');
    u.searchParams.set('to', '<YOUR_EMAIL>');
    if (cursor) u.searchParams.set('cursor', cursor);
    const j = await (await fetch(u, { headers: H })).json();
    for (const e of j.items || []) { if (!byThread.has(e.thread_id)) byThread.set(e.thread_id, []); byThread.get(e.thread_id).push(e); }
    cursor = j.cursor || null;
  } while (cursor);
  const addLabel = async (e, label) => {
    const r = await fetch(`${base}/api/v1/emails/${e.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ folders: [...new Set([...(e.folders || []), label])] }) });
    if (!r.ok) throw new Error(`Unipile HTTP ${r.status}`);
  };
  return { byThread, addLabel };
}

/** Label existing matching mail. Personal (contact@): through Unipile. legacymail: through gog. Dry run unless apply. */
async function backfill(account, apply) {
  const box = MAILBOXES[account];
  const uni = box.contactOnly ? await unipileContactEmails() : null;
  for (const [rule, label] of Object.entries(box.labels)) {
    const threads = await allThreads(account, rule);
    const todo = threads.filter(t => !(t.labels || []).includes(label));
    console.log(`${rule}: ${threads.length} match, ${todo.length} still need "${label}"`);
    if (!apply) continue;
    for (const t of todo) {
      const emails = uni ? uni.byThread.get(t.id) || [] : [];
      try { if (!emails.length) throw new Error('not in Unipile'); for (const e of emails) await uni.addLabel(e, label); }
      catch { gog(account, box.client, ['gmail', 'labels', 'modify', t.id, '--add', label]); await sleep(300); } // Unipile 404 / unsynced -> Gmail API
    }
    console.log(`  labeled ${todo.length}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const [cmd, account, scope = 'contact'] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (cmd === 'show') { for (const [k, q] of Object.entries(RULES)) console.log(`${k} (${q.length} chars)\n  ${q}\n`); }
  else if (cmd === 'filters' && MAILBOXES[account]) { if (apply) applyFilters(account); else for (const [r, l] of Object.entries(MAILBOXES[account].labels)) console.log(`would create: ${r} -> "${l}" (${ruleQuery(r, { contactOnly: MAILBOXES[account].contactOnly }).length} chars)`); }
  else if (cmd === 'backfill' && MAILBOXES[account]) await backfill(account, apply);
  else if (cmd === 'legacy-filters' && MAILBOXES[account]) {
    const legacy = legacyFilters(account);
    for (const f of legacy) { console.log(`${apply ? 'deleting' : 'legacy'} ${f.id} ${JSON.stringify(f.criteria).slice(0, 110)}`); if (apply) gog(account, MAILBOXES[account].client, ['gmail', 'filters', 'delete', f.id, '-y']); }
  }
  else if (cmd === 'relabel' && MAILBOXES[account]) { const d = process.argv.indexOf('--days'); await relabel(account, apply, d > -1 ? process.argv[d + 1] : null); }
  else if (cmd === 'test') {
    const client = account === '<YOUR_EMAIL>' ? 'legacymail' : 'default';
    for (const label of Object.keys(RULES)) {
      const d = search(account, client, ruleQuery(label, { contactOnly: scope === 'contact' }));
      const th = d.threads || [];
      console.log(`== ${label}: ${th.length}${d.nextPageToken ? '+' : ''}`);
      for (const t of th.slice(0, 30)) console.log(`   ${String(t.date).slice(0, 10)} | ${String(t.from).replace(/"/g, '').slice(0, 40)} | ${String(t.subject).slice(0, 80)}`);
    }
  } else { console.error('usage: show | test <account> [contact|all] | filters|backfill|legacy-filters <account> [--apply] | relabel <account> [--days N] [--apply]'); process.exit(2); }
}
