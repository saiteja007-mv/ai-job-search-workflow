export const meta = {
  name: 'career-ops-recruiter-sourcing',
  description: 'Source real, currently-employed LinkedIn recruiters/HMs/peers per company and emit BOTH a contacts.json payload and a hermes recruiter-report block (Prospeo/Reoon email pipeline input)',
  whenToUse: 'After applications are CONFIRMED submitted. Pass args.companies = [{company, role, url, appNumber?, reportPath?, score?, appliedVia?}]. Output feeds Unipile LinkedIn invites and the <HOME_SERVER> hermes recruiter-email queue.',
  phases: [
    { title: 'Source', detail: 'One agent per company: WebSearch LinkedIn, verify current employment, draft <=300-char connect + <=120-word email' },
  ],
}

const ROOT = '<CAREER_OPS_DIR>'

let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch { _args = null } }
if (!_args || !Array.isArray(_args.companies) || !_args.companies.length) {
  throw new Error('args.companies is REQUIRED (non-empty array of {company, role, url, ...})')
}
const COMPANIES = _args.companies
const TODAY = _args.today || 'today'

phase('Source')
log(`Sourcing outreach contacts for ${COMPANIES.length} companies`)

const results = await parallel(COMPANIES.map(t => () =>
  agent(
    `Source REAL LinkedIn outreach contacts at ONE company. Project root: ${ROOT}. Today: ${TODAY}.

TARGET:
  company: ${t.company}
  role applied to: ${t.role}
  job url: ${t.url || 'n/a'}
  application status: ${t.appliedVia ? `ALREADY SUBMITTED via ${t.appliedVia}` : 'submitted'}
  gate score: ${t.score || 'n/a'}
  ${t.appNumber ? `career-ops appNumber: ${t.appNumber}` : 'no career-ops report (tsenta feed job)'}

MANDATORY READS: AGENTS.md (the "Resume Accuracy & Outreach Sourcing" and "Outreach message rules" sections), modes/contacto.md, modes/_profile.md, cv-aiml.md, article-digest.md.

=== THE ONLY THING THAT MATTERS: THE CONTACTS MUST BE REAL ===
Every contact you return must be a REAL, NAMED human with a REAL https://www.linkedin.com/in/<handle>/ URL that you actually saw in a search result. Never a search URL, never a {firstName} placeholder, never a "TODO", never a guessed handle built from a name. If you can only find 1 real person, return 1. If you find 0, return 0 and say so in gaps. A fabricated contact is worse than an empty list — it gets a message sent into the void and burns the LinkedIn account's rate budget.

CURRENT EMPLOYMENT: the LinkedIn snippet must show a CURRENT role at ${t.company} — not "Former", not a different employer, not an alum. If the snippet is ambiguous, mark confidence "medium" and say why in the notes. Do not upgrade a guess into a confirmation.

SEARCH (run these, plus any variation that helps):
  1. "${t.company}" recruiter OR "talent acquisition" OR "technical recruiter" OR sourcer site:linkedin.com/in
  2. "${t.company}" "machine learning" manager OR "engineering manager" OR "director of AI" OR "head of data science" site:linkedin.com/in
  3. "${t.company}" "machine learning engineer" OR "AI engineer" OR "data scientist" OR "applied scientist" site:linkedin.com/in
  4. If the company is large enough to have a dedicated AI/ML org, add: "${t.company}" AI OR "artificial intelligence" recruiter 2026

WANTED: up to 3 contacts, at most one of each type — recruiter (TA/sourcing, HIGHEST PRIORITY because the hermes email pipeline can find a work email for recruiters far more reliably than for engineers), hiring_manager (the ML/AI/data manager or director this role would report into), peer (an IC on the same team).

MESSAGE RULES (from modes/contacto.md — verify every count yourself before returning):
  · connectMessage <= 300 CHARACTERS. Count them. A message over 300 chars is silently rejected by LinkedIn.
  · Recruiter framing = Fit / Proof / CTA: the stack, the comp band, work authorization, location flexibility — the things a screener actually needs.
  · Hiring-manager framing = Hook / Proof / CTA: anchor on something only THAT person or THAT team shipped. One stat maximum.
  · Peer framing = Interest / Connection / CTA: reference THEIR work. No job pitch, no referral ask.
  · The application is ALREADY SUBMITTED, so write "I applied to ..." — that is accurate. Never write "I'm applying" for an already-submitted role, and never claim an application you did not make.
  · No phone number in any message. Contact email = <YOUR_EMAIL>.
  · Work authorization phrasing, exactly: "currently on <YOUR_WORK_AUTH_STATUS> work authorization". Do NOT write "US-work-authorized and not seeking sponsorship" — that phrasing is factually unstable and the downstream email script rewrites it anyway.

=== TRUTH BOUNDARY — NON-NEGOTIABLE ===
Every factual claim about the candidate must come from cv-aiml.md or article-digest.md. Reorder, reframe, emphasize — never invent. Specifically:
  · Do NOT claim experience with a tool just because the JD asks for it. Prior runs injected "<TARGET_COMPANY>", "Content Safety", "LLM-as-a-Judge" and "agent orchestration" that are NOT on the CV. That is fabrication and it is the single worst failure mode of this pipeline.
  · Do NOT claim the candidate authored a repo/library/tool unless cv-aiml.md or article-digest.md attributes it to him.
  · The candidate HAS shipped, and these are safe to lead with because they are real and clickable: a semantic caching layer, a text-to-SQL guardrails project, a hybrid-search RAG system, and a METR-LA traffic LSTM. Prefer a link to a shipped project over a keyword list.
  · Real background: ~3 years, <CURRENT_EMPLOYER> (multimodal edge ML, transformer NLP, semantic retrieval) and <PAST_EMPLOYER> (large-scale recommendation and ad-prediction systems), MS CS completed Dec 2025.

=== ALSO EMIT A HERMES RECRUITER-REPORT BLOCK ===
The downstream email pipeline (Prospeo enrich -> Reoon verify -> approval queue) parses a very specific markdown shape, and a shape mismatch means your contacts are SILENTLY DROPPED. Emit, for each contact, a block in EXACTLY this form (the parser keys off the "**N. " prefix, the em-dash, the trailing "**", the LinkedIn URL, and the "Email / InMail" line):

**N. Full Name — Title, ${t.company}**  (confidence: high|medium)
**LinkedIn:** https://www.linkedin.com/in/<handle>
**Why this fit:**
- <one line tying this person to the role/team>
- <one line of evidence you actually saw>
**Connect request (<=300 chars):**
> <the connect message>
**Email / InMail (<=120 words):**
> <a single-paragraph email pitch, <=120 words, written in FIRST PERSON as the candidate. Downstream rewrites it into third person automatically, so do not pre-write it in third person.>
**Evidence / uncertainty:**
- <what the search result actually said>
- <what remains unverified>

Leave N as the literal placeholder "N" — the orchestrator renumbers.
Note the company must be the LAST comma-separated token of the title line, because the parser takes the text after the final comma as the company name. So write "Senior Technical Recruiter, ${t.company}" — never "${t.company} Senior Technical Recruiter".

RETURN FORMAT — plain text only, no StructuredOutput. Put the markdown blocks first, then the LAST lines of your response must be exactly:

CONTACTS_JSON_BEGIN
{"company":"${t.company}","role":"${t.role}","appNumber":${t.appNumber || 'null'},"contacts":[{"type":"recruiter|hiring_manager|peer","name":"<full name>","title":"<title>","linkedin":"https://www.linkedin.com/in/<handle>","currentlyEmployed":true,"confidence":"high|medium","connectMessage":"<=300 chars>","chars":<number>,"emailPitch":"<=120 words, first person>","evidence":"<what you actually saw>"}],"gaps":"<string or null>","reportBlocks":"<the full markdown blocks above, newlines escaped as \\n>"}
CONTACTS_JSON_END

Use double-quoted keys, escape all inner quotes and newlines, no trailing commas — it must JSON.parse cleanly. If you found nobody real: contacts: [] and an honest gaps string.`,
    { label: `source:${String(t.company).slice(0, 30)}`, phase: 'Source' }
  ).then(text => {
    const m = typeof text === 'string' && text.match(/CONTACTS_JSON_BEGIN\s*([\s\S]*?)\s*CONTACTS_JSON_END/)
    if (!m) { log(`${t.company}: no CONTACTS_JSON block`); return null }
    try { return JSON.parse(m[1].trim()) }
    catch (e) { log(`${t.company}: parse failed — ${e.message}`); return null }
  }).catch(e => { log(`${t.company}: ${String(e.message).slice(0, 140)}`); return null })
))

const clean = results.filter(Boolean)
const totalContacts = clean.reduce((a, r) => a + (r.contacts || []).length, 0)
const recruiters = clean.reduce((a, r) => a + (r.contacts || []).filter(c => c.type === 'recruiter').length, 0)
log(`Sourced ${totalContacts} contacts (${recruiters} recruiters) across ${clean.length}/${COMPANIES.length} companies`)

return {
  today: TODAY,
  companies: clean,
  totals: { companies: clean.length, contacts: totalContacts, recruiters },
  failed: COMPANIES.filter(t => !clean.find(c => c.company === t.company)).map(t => t.company),
}
