#!/usr/bin/env node
// Merge sidecar email drafts in data/email-drafts/*.json into data/contacts.json
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const DRAFTS_DIR = path.join(ROOT, 'data', 'email-drafts');
const CONTACTS_PATH = path.join(ROOT, 'data', 'contacts.json');

const contactsRaw = fs.readFileSync(CONTACTS_PATH, 'utf8');
const contacts = JSON.parse(contactsRaw);

if (!Array.isArray(contacts.applications)) {
  console.error('ERROR: contacts.json missing applications[] array');
  process.exit(1);
}

const sidecarFiles = fs.readdirSync(DRAFTS_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

let appsTouched = 0;
let contactsUpdated = 0;
const mismatches = [];
let linkedinPreservedAll = true;
const touchedAppNums = [];

for (const file of sidecarFiles) {
  const full = path.join(DRAFTS_DIR, file);
  const sidecar = JSON.parse(fs.readFileSync(full, 'utf8'));
  const appNum = sidecar.appNumber;
  const emails = sidecar.emails || [];

  const app = contacts.applications.find(a => a.appNumber === appNum);
  if (!app) {
    mismatches.push(`appNumber ${appNum} (file ${file}) not in applications[]`);
    continue;
  }

  let touchedThisApp = false;
  for (const em of emails) {
    const c = (app.contacts || []).find(
      x => x.name === em.contactName && x.type === em.contactType
    );
    if (!c) {
      mismatches.push(`app ${appNum}: contact name="${em.contactName}" type="${em.contactType}" not found`);
      continue;
    }
    if (!c.messages) c.messages = {};
    // Preserve linkedinConnect explicitly — we only set email fields.
    const beforeLinkedin = c.messages.linkedinConnect;
    c.messages.emailSubject = em.emailSubject;
    c.messages.emailBody = em.emailBody;
    const afterLinkedin = c.messages.linkedinConnect;
    if (beforeLinkedin !== afterLinkedin) linkedinPreservedAll = false;
    contactsUpdated += 1;
    touchedThisApp = true;
  }
  if (touchedThisApp) {
    appsTouched += 1;
    touchedAppNums.push(appNum);
  }
}

// Atomic write: write to tmp, rename.
const tmp = CONTACTS_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(contacts, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, CONTACTS_PATH);

// Verify spot-check: re-read and confirm a few entries.
const verifyRaw = fs.readFileSync(CONTACTS_PATH, 'utf8');
const verify = JSON.parse(verifyRaw);
const spotCheckIds = touchedAppNums.slice(0, 3);
const spotChecks = [];
for (const id of spotCheckIds) {
  const app = verify.applications.find(a => a.appNumber === id);
  if (!app) { spotChecks.push(`app ${id}: NOT FOUND in re-read`); continue; }
  for (const c of (app.contacts || [])) {
    if (c.messages && (c.messages.emailSubject || c.messages.emailBody)) {
      spotChecks.push(`app ${id} / ${c.name} (${c.type}): subject="${(c.messages.emailSubject||'').slice(0,60)}..." linkedinConnect=${c.messages.linkedinConnect ? 'present' : 'absent'}`);
      break;
    }
  }
}

const out = {
  sidecarsFound: sidecarFiles.length,
  appsTouched,
  contactsUpdated,
  mismatches,
  linkedinPreserved: linkedinPreservedAll ? 'yes' : 'no',
  touchedAppNums,
  spotChecks,
};
console.log(JSON.stringify(out, null, 2));
