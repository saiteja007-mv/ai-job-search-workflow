export const meta = {
  name: 'aiml-role-research',
  description: 'Deep multi-stream research on the AI/ML Engineer role (2-3 yrs experience): required skills, real JD requirements, portfolio projects, last-30-day trends, MLOps expectations, certs/salary/interviews, and resume positioning. Synthesizes a single cited markdown report saved to the AI-ML Engineer folder.',
  whenToUse: 'When the user wants a comprehensive, current research dossier on the AI/ML Engineer role to drive resume/portfolio/skill decisions.',
  phases: [
    { title: 'Research',  detail: '7 parallel streams — skills, JDs, projects, trends, MLOps, certs/salary/interview, positioning' },
    { title: 'Synthesize', detail: 'Merge all streams into one structured cited report, write to disk' },
    { title: 'Critic',    detail: 'Completeness pass — flag gaps/missing modalities' },
  ],
}

const OUT_DIR = '<CAREER_OPS_DIR>\\AI-ML Engineer'
const OUT_FILE = OUT_DIR + '\\AI-ML-Engineer-Role-Research.md'

// User context so research is tailored, not generic.
const USER_CTX = `Candidate context (tailor findings to this, but research the ROLE broadly):
- Targeting <TARGET_ROLE> (e.g. AI/ML Engineer) roles, ~2.0-3.0 years experience band (mid/early-mid level, USA).
- Background: <YOUR_BACKGROUND_ONE_LINER> (prior discipline, core tools). <YOUR_DEGREE>. <YOUR_WORK_AUTH_STATUS> (needs sponsoring employers later).
- Real projects already built: (1) <YOUR_PROJECT_1>; (2) <YOUR_PROJECT_2>.
- Goal: know exactly what skills, projects, keywords, and framing make a competitive 2-3 yr <TARGET_ROLE> candidate transitioning from <PRIOR_ROLE>.`

const FINDER = (title, brief) => `You are a research analyst producing one section of a deep-research dossier on the AI/ML Engineer role. Focus ONLY on: ${title}.

${USER_CTX}

YOUR ASSIGNMENT:
${brief}

METHOD:
- Use WebSearch (always available) for 4-8 targeted queries, then WebFetch the 3-6 most authoritative/current sources (job boards, engineering blogs, 2025-2026 surveys, reputable salary sources, well-known practitioners). Prefer sources from the last ~12 months; explicitly tag anything older.
- If the Indeed/ZipRecruiter/Dice job-search MCPs load via ToolSearch, sample 5-10 real "AI/ML Engineer" / "Machine Learning Engineer" postings (2-3 yr / mid level, USA) to ground requirements in actual demand. If they don't load, rely on WebSearch of real postings. Never fabricate a posting.
- Distinguish "must-have (in most JDs)" vs "nice-to-have (differentiator)".
- Quote concrete specifics (named tools, version, %s, $ figures, frameworks) — avoid vague generalities.

RETURN: A dense, well-structured markdown section (use ### subheadings, bullet lists, and a short "Sources" list of the URLs you actually read). Plain markdown only, no preamble. Aim for signal density over length.`

// ---------- Phase 1: Research fan-out ----------
phase('Research')
const STREAMS = [
  ['Core skills & technical stack', `Map the full skill taxonomy a 2-3 yr AI/ML Engineer is expected to have, grouped: (a) Languages (Python depth, SQL, occasionally Scala/Java/C++), (b) Classical ML (scikit-learn, XGBoost, feature engineering), (c) Deep Learning (PyTorch vs TensorFlow/Keras prevalence in 2025-26, CNNs, RNN/LSTM, Transformers), (d) GenAI/LLM (RAG, fine-tuning, embeddings/vector DBs like Pinecone/FAISS/pgvector, prompt engineering, LangChain/LlamaIndex, agents), (e) MLOps & infra (Docker, Kubernetes, CI/CD, MLflow, Airflow, model serving, monitoring), (f) Cloud (AWS SageMaker/Bedrock, GCP Vertex, Azure ML — which dominate), (g) Data engineering adjacency (Spark, pipelines). Rank each by how often it appears in mid-level JDs.`],
  ['Real JD requirements (mid / 2-3 yr)', `From ACTUAL current US "AI/ML Engineer" and "Machine Learning Engineer" postings at the 2-3 yr / mid level, extract the recurring requirements: required degrees, years, the exact phrases for must-have skills, common responsibilities, and the line between "Junior/Associate ML Engineer", "ML Engineer", and "Senior ML Engineer". Note H1B-sponsorship-friendly employer patterns relevant to an <YOUR_WORK_AUTH_STATUS> candidate. Cite specific companies/postings where possible.`],
  ['Portfolio projects that win interviews', `What projects make a 2-3 yr AI/ML Engineer portfolio competitive in 2025-2026? Cover: project archetypes that impress (end-to-end deployed ML service, RAG/LLM app, fine-tuned model, MLOps pipeline, multi-modal, agentic system), what "good" looks like (deployment, evaluation rigor, scale, real users), and 6-10 concrete project IDEAS with the stack each would showcase. Critique the candidate's existing 2 projects (AWS RAG chatbot + multi-modal cyberbully detection) — how strong are they, what to add/emphasize, and 2-3 high-leverage projects they could build next given their background.`],
  ['Last-30-day trends & market signal', `What is the AI/ML Engineer hiring + skills conversation RIGHT NOW (last ~30-60 days, 2026)? Pull from recent Reddit (r/MachineLearning, r/cscareerquestions, r/learnmachinelearning), Hacker News, X/LinkedIn discourse, and recent posts: which skills are surging (agents, RAG-in-prod, LLM evals, small/local models, MLOps for LLMs = "LLMOps"), what's cooling, what hiring managers complain candidates lack, and the GenAI-vs-classical-ML balance employers now want. Be explicit about dates.`],
  ['MLOps & production engineering bar', `What production/MLOps competency separates an AI/ML Engineer from a Data Scientist/Analyst at 2-3 yr? Cover: taking a model from notebook to production (containerization, REST/gRPC serving, FastAPI, batch vs real-time inference), experiment tracking (MLflow/W&B), pipeline orchestration (Airflow/Kubeflow/Prefect), monitoring & drift, model registry, testing ML code, cost/latency optimization, and for LLMs: eval harnesses, guardrails, caching, vector-store ops. State the realistic bar for a mid-level hire.`],
  ['Certifications, salary, interview process', `For a 2-3 yr AI/ML Engineer in the USA (2025-2026): (a) which certifications actually carry weight (AWS ML Specialty, GCP ML Engineer, Azure AI Engineer, deep-learning.ai, NVIDIA) vs which are noise; (b) realistic total-comp bands by metro/remote and company tier (base + bonus + equity); (c) the typical interview loop (coding/DSA, ML breadth, ML system design, take-home, behavioral) and what each stage tests. Use named, dated salary sources (levels.fyi, Glassdoor 2025-26, surveys).`],
  ['Resume positioning & ATS for DA→AIML transition', `How should a candidate with a Data Analyst background and an MS CS position themselves as a 2-3 yr AI/ML Engineer? Cover: the strongest framing of transferable DA experience (SQL, Python, stats, production data) toward ML, the exact ATS keywords/phrases that AI-ML-Engineer resume scanners look for at mid level, how to order/weight a projects-forward resume when the title doesn't yet say "ML Engineer", common positioning mistakes, and a recommended skills-section taxonomy + 3-4 summary-line templates that lead with AI/ML.`],
]

const findings = await parallel(STREAMS.map(([title, brief]) => () =>
  agent(FINDER(title, brief), { label: `research:${title}`.slice(0, 48), phase: 'Research' })
))
const sections = STREAMS.map((s, i) => ({ title: s[0], body: findings[i] })).filter(s => s.body)
log(`Research: ${sections.length}/${STREAMS.length} streams returned`)

// ---------- Phase 2: Synthesize + write file ----------
phase('Synthesize')
const SECTION_BLOCKS = sections.map((s, i) =>
  `===== STREAM ${i + 1}: ${s.title} =====\n${typeof s.body === 'string' ? s.body : JSON.stringify(s.body)}`
).join('\n\n')

const synth = await agent(
  `You are the lead author assembling a single, polished, comprehensive research dossier on the **AI/ML Engineer role (2-3 years experience, USA, 2025-2026)** from 7 research streams below.

${USER_CTX}

RAW RESEARCH STREAMS:
${SECTION_BLOCKS.slice(0, 90000)}

TASK — write ONE cohesive markdown document and SAVE it with the Write tool to EXACTLY this path:
  ${OUT_FILE}

DOCUMENT STRUCTURE (use this outline, merge/dedupe across streams, keep concrete specifics + numbers):
  # AI/ML Engineer — Role Research Dossier (2-3 Years Experience)
  > One-line scope + date (2026) + that figures are current as of research.

  ## 1. Executive Summary  (8-12 bullet takeaways — the "if you read nothing else")
  ## 2. The Role: What an AI/ML Engineer Actually Does at 2-3 Years
     (responsibilities, how it differs from Data Scientist / Data Analyst / MLOps Engineer; the Junior→Mid→Senior ladder)
  ## 3. Required Skills & Tech Stack  (grouped table: Skill | Tier [Must-have/Nice-to-have] | Notes; cover languages, classical ML, DL, GenAI/LLM, MLOps, cloud, data-eng)
  ## 4. What Real Job Descriptions Demand  (recurring must-haves, exact JD phrasing, H1B-sponsorship notes for <YOUR_WORK_AUTH_STATUS>)
  ## 5. Last-30-Day Trends & Market Signal  (what's surging / cooling, with dates; LLMOps, agents, RAG-in-prod, evals)
  ## 6. Portfolio Projects That Win  (archetypes + what "good" looks like + 6-10 concrete project ideas table; then a candid critique of the candidate's 2 existing projects + 2-3 recommended next projects)
  ## 7. MLOps / Production Bar  (the notebook→production competency expected at mid level)
  ## 8. Certifications, Salary & Interview Process  (certs that matter; comp table by tier/metro; interview-loop breakdown)
  ## 9. Resume Positioning for a Data-Analyst → AI/ML-Engineer Transition  (framing, ATS keyword list, skills-section taxonomy, 3-4 summary-line templates leading with AI/ML)
  ## 10. Action Plan  (a prioritized 30/60/90-style checklist of skills to learn + projects to build + resume moves)
  ## Sources  (consolidated, deduped list of every URL the streams cited)

RULES: keep it dense and specific (named tools, %s, $ ranges, dates). No fabricated figures — if a stream didn't find a number, say "not found in sources" rather than inventing. Tables where useful. This must be genuinely useful to drive resume + upskilling decisions.

After writing the file, return ONE line: SAVED <path> (<approx word count>).`,
  { label: 'synthesize-dossier', phase: 'Synthesize' }
)
log(`Synthesis: ${(synth || '').trim().slice(0, 120)}`)

// ---------- Phase 3: Completeness critic ----------
phase('Critic')
const critic = await agent(
  `Read the research dossier at ${OUT_FILE}. You are a completeness critic.

Assess: does it adequately cover (a) the must-have skill stack, (b) real JD demands, (c) current 2026 trends incl. GenAI/LLMOps/agents, (d) portfolio projects + a critique of the candidate's 2 existing projects, (e) MLOps bar, (f) certs/salary/interview, (g) DA→AIML resume positioning + ATS keywords + an action plan?

Return JSON: { complete: <bool>, wordCount: <int approx>, gaps: [<short missing items>], strongest: "<one line>", verdict: "<one line>" }.`,
  {
    schema: {
      type: 'object',
      properties: {
        complete: { type: 'boolean' }, wordCount: { type: 'number' },
        gaps: { type: 'array', items: { type: 'string' } },
        strongest: { type: 'string' }, verdict: { type: 'string' },
      },
      required: ['verdict'], additionalProperties: true,
    },
    label: 'completeness-critic',
  }
)

return {
  streamsReturned: sections.length,
  saved: (synth || '').trim(),
  critic,
  outFile: OUT_FILE,
}
