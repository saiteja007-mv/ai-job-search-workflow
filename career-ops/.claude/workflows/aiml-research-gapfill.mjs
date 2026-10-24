export const meta = {
  name: 'aiml-research-gapfill',
  description: 'Fill the 6 depth-gaps the completeness critic flagged in the AI/ML Engineer dossier (DSA plan, ML system-design worked example, behavioral STAR+R Q-bank, salary negotiation script, networking/referral channels, application-volume targets) and append a Part II: Tactical Playbooks section to the existing dossier.',
  whenToUse: 'After aiml-role-research produced the dossier and the critic flagged depth-level gaps.',
  phases: [
    { title: 'GapResearch', detail: '3 parallel streams covering the 6 gaps' },
    { title: 'Append', detail: 'Append Part II: Tactical Playbooks to the dossier file' },
  ],
}

const OUT_FILE = '<CAREER_OPS_DIR>\\AI-ML Engineer\\AI-ML-Engineer-Role-Research.md'

const USER_CTX = `Candidate: targeting <TARGET_ROLE> (e.g. AI/ML Engineer) (~2-3 yr band, USA). Background: <YOUR_BACKGROUND_ONE_LINER>, <YOUR_DEGREE>, <YOUR_WORK_AUTH_STATUS>. Real projects: <YOUR_PROJECT_1>; <YOUR_PROJECT_2>.`

const FINDER = (title, brief) => `Research analyst producing a TACTICAL playbook section for an AI/ML Engineer job-search dossier. Focus ONLY on: ${title}.

${USER_CTX}

ASSIGNMENT:
${brief}

METHOD: WebSearch (4-8 queries) + WebFetch 3-5 authoritative/current (2025-2026) sources. Concrete and actionable — name platforms, give real example questions, real $ figures/scripts, real channels. No fluff, no fabricated numbers (say "varies / not found" if unknown). Tailor to a DA→AIML transition + <YOUR_WORK_AUTH_STATUS> where relevant.

RETURN: dense markdown with ### subheadings, tables/checklists/example Q&A where useful, and a short Sources list of URLs you actually read. Markdown only.`

phase('GapResearch')
const STREAMS = [
  ['Technical interview prep — DSA plan + ML system design worked example', `Two parts. (1) DSA/coding prep for ML Engineer loops: the realistic scope (arrays/strings/hashmaps/two-pointers/trees/graphs/DP at what depth), the BEST platform + a concrete study set (e.g. NeetCode 150 / Blind 75 — name the lists), a realistic weekly cadence for someone working full-time, and Python-specific tips. (2) ML SYSTEM DESIGN: give 2 fully worked reference examples a mid-level candidate should be able to whiteboard end-to-end (e.g. "design a RAG-based document Q&A system" and "design a real-time recommendation / fraud-detection / content-moderation pipeline") — for each, lay out the components (data, features, model, serving, eval, monitoring, scaling, tradeoffs) as a reference architecture to study. Name good study resources (books/courses/repos).`],
  ['Behavioral STAR+R question bank + salary negotiation script', `Two parts. (1) BEHAVIORAL: an enumerated bank of 12-15 of the most common behavioral/values questions for ML Engineer loops (incl. "tell me about a project", conflict, failure, ambiguity, stakeholder comms, ML-ethics) + the STAR+R framework + 2-3 SAMPLE answers a DA→AIML candidate could adapt from their real projects (RAG chatbot, cyberbully detection, CVS claims work). (2) SALARY NEGOTIATION: a concrete counter-offer playbook for a 2-3 yr ML Engineer — when/how to counter, exact phrasing/scripts for the recruiter call, how to leverage competing offers, what's negotiable beyond base (sign-on, equity, relocation, start date), and <YOUR_WORK_AUTH_STATUS> / H1B-timing considerations. Use real ranges where sources give them.`],
  ['Job-search strategy — networking, referrals, sourcing channels, volume & timeline', `A tactical job-search operations playbook for a 2-3 yr AI/ML Engineer (<YOUR_WORK_AUTH_STATUS>, needs H1B sponsorship): (a) the highest-ROI sourcing channels (LinkedIn search operators, which job boards, niche AI/ML boards, H1B-sponsor databases like myvisajobs/h1bgrader, Discord/Slack communities, GitHub/Kaggle visibility); (b) a referral/networking outreach playbook (who to contact, message templates, cadence); (c) realistic APPLICATION-VOLUME targets and a timeline-to-first-offer expectation for this profile in the 2026 market; (d) how to track/prioritize. Be specific and realistic, including the harder <YOUR_WORK_AUTH_STATUS> odds.`],
]

const gaps = await parallel(STREAMS.map(([title, brief]) => () =>
  agent(FINDER(title, brief), { label: `gap:${title}`.slice(0, 46), phase: 'GapResearch' })
))
const blocks = STREAMS.map((s, i) => ({ title: s[0], body: gaps[i] })).filter(s => s.body)
log(`GapResearch: ${blocks.length}/${STREAMS.length} returned`)

phase('Append')
const RAW = blocks.map((b, i) => `===== GAP STREAM ${i + 1}: ${b.title} =====\n${typeof b.body === 'string' ? b.body : JSON.stringify(b.body)}`).join('\n\n')

const append = await agent(
  `Append a new "Part II: Tactical Playbooks" to the existing AI/ML Engineer dossier.

STEP 1: Read the current file at ${OUT_FILE} (note its existing "## Sources" section near the end).
STEP 2: Compose a polished new part from the 3 gap-research streams below, with this structure:
  # Part II — Tactical Playbooks
  ## 11. Technical Interview Prep — DSA Plan + ML System Design  (the study lists, cadence, + 2 worked ML-system-design reference architectures)
  ## 12. Behavioral Q-Bank + Salary Negotiation  (enumerated STAR+R question bank, sample answers tied to the candidate's real projects, negotiation scripts)
  ## 13. Job-Search Operations  (sourcing channels, referral/outreach templates, application-volume target + timeline-to-offer for an <YOUR_WORK_AUTH_STATUS> 2-3 yr candidate)
  Keep dense + specific (named platforms, real example questions, real $ ranges, scripts). No fabricated numbers.
STEP 3: APPEND your new part to the file (use Edit to insert it just BEFORE the existing "## Sources" heading so Sources stays last, and merge any new URLs into that Sources list). Do NOT rewrite or delete existing content.

RAW GAP RESEARCH:
${RAW.slice(0, 80000)}

Return ONE line: APPENDED Part II (<approx added word count>).`,
  { label: 'append-part-ii', phase: 'Append' }
)

return { gapStreams: blocks.length, result: (append || '').trim(), outFile: OUT_FILE }
