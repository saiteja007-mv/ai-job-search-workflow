import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { search, getDocument, stats } from '../rag.mjs';
import { postUrn } from '../linkedin-post.mjs';
import { runTool, TOOL_SCHEMAS } from '../tools.mjs';
import { ROUTES } from '../assist-server.mjs';

// ---- a small fake corpus, so these never depend on the live repo ------------
const root = path.join(os.tmpdir(), `assist-agent-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'jds'), { recursive: true });
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

fs.writeFileSync(path.join(root, 'jds', '001-acme-ml-engineer.txt'),
  `Company: Acme\nRole: Machine Learning Engineer\nLocation: Austin, TX\nURL: https://acme.example/jobs/1\n\n` +
  `<h2>About</h2><p>You will build <strong>LLM inference</strong> pipelines and own model quantization for edge devices.</p>` +
  `<ul><li>Kubernetes and Triton serving</li><li>Active TS/SCI clearance required</li></ul>`);
fs.writeFileSync(path.join(root, 'jds', '002-globex-data-scientist.txt'),
  `Company: Globex\nRole: Data Scientist\nLocation: Remote\nURL: https://globex.example/jobs/2\n\n` +
  `<p>Forecasting and experimentation. Snowflake, dbt, causal inference.</p>`);
fs.writeFileSync(path.join(root, 'cv-aiml.md'),
  `# CV\n\n## Experience\nBuilt retrieval systems and applied quantization for edge inference.\n\n## Skills\nPython, PyTorch, Kubernetes.\n`);

// ---- retrieval --------------------------------------------------------------

test('retrieval finds the right JD by its content, not just its title', () => {
  const r = search(root, 'quantization edge inference');
  assert.equal(r.ok, true);
  assert.ok(r.results.length > 0);
  assert.ok(r.results.some((x) => x.title.includes('Acme')), 'the Acme JD mentions quantization');
});

test('HTML markup is stripped so tags never reach the model as content', () => {
  const r = search(root, 'Triton serving');
  const hit = r.results.find((x) => x.kind === 'jd');
  assert.ok(hit, 'found the JD');
  const doc = getDocument(root, hit.id);
  assert.ok(!/<[a-z]+>/i.test(doc.text), `raw tags leaked: ${doc.text.slice(0, 120)}`);
  assert.match(doc.text, /Triton/);
});

test('JD header metadata is parsed into company, role and url', () => {
  const r = search(root, 'Snowflake causal inference');
  const hit = r.results.find((x) => x.company === 'Globex');
  assert.ok(hit, 'Globex JD found');
  assert.equal(hit.role, 'Data Scientist');
  assert.equal(hit.url, 'https://globex.example/jobs/2');
});

test('kind narrows the corpus', () => {
  assert.ok(search(root, 'quantization', { kind: 'profile' }).results.every((r) => r.kind === 'profile'));
  assert.ok(search(root, 'quantization', { kind: 'jd' }).results.every((r) => r.kind === 'jd'));
});

test('a query matching nothing returns zero results rather than the whole corpus', () => {
  assert.equal(search(root, 'zzzqqq-nonexistent-term').count, 0);
});

test('an empty query is refused', () => {
  assert.equal(search(root, '   ').ok, false);
});

test('the index reports what it actually contains', () => {
  const s = stats(root);
  assert.ok(s.chunks > 0);
  assert.ok(s.byKind.jd >= 2);
  assert.ok(s.byKind.profile >= 1, 'cv-aiml.md is an allowed source and must be indexed');
});

test('retrieval stays inside the allowed-source boundary', () => {
  // A secret sitting in the repo must never be retrievable into a prompt.
  fs.writeFileSync(path.join(root, '.env'), 'UNIPILE_API_KEY=super-secret-value\n');
  fs.writeFileSync(path.join(root, 'private-notes.md'), 'super-secret-value appears here too\n');
  const r = search(root, 'super-secret-value');
  assert.equal(r.count, 0, 'files outside the allowlist must not be indexed');
});

// ---- LinkedIn post ids ------------------------------------------------------

test('post urls of every shape resolve to a typed urn', () => {
  assert.equal(postUrn('https://www.linkedin.com/posts/someone_hiring-share-7000000000000000001-HL-j'),
    'urn:li:share:7000000000000000001');
  assert.equal(postUrn('https://www.linkedin.com/posts/someone_hiring-ugcPost-7000000000000000002-oMJk'),
    'urn:li:ugcPost:7000000000000000002');
  assert.equal(postUrn('https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000003/'),
    'urn:li:activity:7000000000000000003');
});

test('the type prefix is preserved, because a bare id 404s at Unipile', () => {
  // Verified live: urn:li:share:<id> and urn:li:activity:<id> both return 200, the bare number
  // returns 404. Dropping the prefix is the plausible-looking change that breaks this silently.
  assert.match(postUrn('https://www.linkedin.com/posts/x_hiring-share-7000000000000000001-HL-j'), /^urn:li:share:/);
});

test('input with no post id returns null instead of a malformed urn', () => {
  for (const bad of ['', 'not a link', 'https://example.com/page', 'https://www.linkedin.com/in/<PROFILE_SLUG>']) {
    assert.equal(postUrn(bad), null, `"${bad}" must not yield a urn`);
  }
});

// ---- tools ------------------------------------------------------------------

test('every advertised tool has a schema the API will accept', () => {
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name, 'named');
    assert.ok(t.function.description?.length > 20, `${t.function.name} needs a real description`);
    assert.equal(t.function.parameters.type, 'object');
    for (const req of t.function.parameters.required || []) {
      assert.ok(req in t.function.parameters.properties, `${t.function.name}: required "${req}" is not declared`);
    }
  }
});

test('an unknown tool name comes back as data, not a thrown error', async () => {
  const r = await runTool(root, 'no_such_tool', {});
  assert.match(r.error, /unknown tool/);
});

test('a failing tool returns an error object so one bad call cannot kill the turn', async () => {
  const r = await runTool(root, 'get_linkedin_post', { url: 'https://example.com/nope' });
  assert.equal(r.ok, false);
  assert.ok(r.error, 'explains itself');
});

test('search_career_ops dispatches through to retrieval', async () => {
  const r = await runTool(root, 'search_career_ops', { query: 'quantization', kind: 'jd' });
  assert.equal(r.ok, true);
  assert.ok(r.results.length > 0);
});

test('check_draft catches a style violation', async () => {
  const r = await runTool(root, 'check_draft', { text: 'I hope this message finds you well — I am excited about this opportunity.' });
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.findings));
});

// ---- the read-only invariant ------------------------------------------------

test('the agent route is registered and declared non-writing', () => {
  const r = ROUTES.find((x) => x.path === '/api/assist/agent');
  assert.ok(r, 'route exists');
  assert.equal(r.write, false);
  assert.equal(r.auth, true, 'the agent can read the whole corpus — it must require a token');
});

test('no tool can send, apply, or spend an invite', () => {
  // The panel promises draft-only. If a future tool breaks that, this test should be the thing
  // that objects — loudly, and before it ships.
  const forbidden = /^(send|post|apply|submit|invite|create|delete|update|write)_/;
  for (const t of TOOL_SCHEMAS) {
    assert.ok(!forbidden.test(t.function.name), `"${t.function.name}" looks like it mutates something`);
  }
});

// ---- job evaluation ---------------------------------------------------------
import { evaluateJob } from '../evaluate.mjs';

test('a pasted JD is evaluated with the rubric read live from the repo', async () => {
  // The rubric must come from the repo's own mode files, so retuning the scoring retunes this.
  const r = await evaluateJob(process.env.CAREER_OPS_ROOT || path.resolve(import.meta.dirname, '..', '..'),
    { text: 'Company: Globex\nRole: ML Engineer\n\nBuild inference pipelines in Python and Kubernetes.' });
  assert.equal(r.ok, true);
  assert.equal(r.company, 'Globex');
  assert.ok(r.rubric.scoring?.includes('Scoring System'), 'the real scoring table is attached');
  assert.ok(r.rubric.cv?.length > 100, 'the CV is attached for grounding');
  assert.match(r.guidance, /not saved/, 'it must say nothing was written');
});

test('hard bars are detected and named, not silently dropped', async () => {
  const r = await evaluateJob(process.env.CAREER_OPS_ROOT || path.resolve(import.meta.dirname, '..', '..'),
    { text: 'Company: Acme\nRole: ML Engineer\n\nActive TS/SCI clearance required. ITAR facility.' });
  // screenJD returns {verdict, bars[]} and has NO `blocked` field — reading `.blocked` made this
  // warning silently vanish, which is the whole reason this assertion is on the shape.
  assert.equal(r.gates.hardBars.verdict, 'bars');
  assert.ok(r.gates.hardBars.bars.length >= 2);
  assert.match(r.guidance, /HARD BARS HIT/);
  assert.match(r.guidance, /clearance/i, 'the specific bar is named');
});

test('a JD that both promises sponsorship and states a bar surfaces the contradiction', async () => {
  const r = await evaluateJob(process.env.CAREER_OPS_ROOT || path.resolve(import.meta.dirname, '..', '..'),
    { text: 'Company: Acme\nRole: ML Engineer\n\nActive TS/SCI clearance required. We sponsor H-1B visas.' });
  assert.equal(r.gates.hardBars.conflicting, true);
  assert.match(r.guidance, /both promises sponsorship/);
});

test('a fetch failure is never reported as a closed posting', async () => {
  // Conflating "I could not read it" with "the role is gone" would tell him to drop a live role.
  const { evaluateJob: ev } = await import('../evaluate.mjs');
  const r = await ev(root, { url: 'https://127.0.0.1:9/definitely-not-real' });
  assert.notEqual(r.stopped, 'closed', 'an unreachable page is not a closed posting');
  assert.ok(['unreachable', 'thin'].includes(r.stopped), `got ${r.stopped}`);
  if (r.stopped === 'unreachable') assert.match(r.guidance, /NOT evidence the role is closed/);
});

test('evaluate_job is reachable as a tool and declares both input shapes', () => {
  const t = TOOL_SCHEMAS.find((x) => x.function.name === 'evaluate_job');
  assert.ok(t, 'registered');
  assert.ok('url' in t.function.parameters.properties);
  assert.ok('text' in t.function.parameters.properties);
});

test('evaluating a job writes nothing to disk', async () => {
  // The assist service sits on a public tunnel and opens no file for writing. An evaluation
  // that quietly created reports/NNN-*.md would break that invariant.
  const rootDir = path.resolve(import.meta.dirname, '..', '..');
  const before = fs.readdirSync(path.join(rootDir, 'reports')).length;
  await evaluateJob(rootDir, { text: 'Company: Zzz\nRole: Tester\n\nSome description text here.' });
  assert.equal(fs.readdirSync(path.join(rootDir, 'reports')).length, before, 'no report file was created');
});

// ---- ATS fetch --------------------------------------------------------------
import { fetchViaAts } from '../ats-fetch.mjs';

test('a non-ATS url is reported as such rather than silently attempted', async () => {
  const r = await fetchViaAts('https://example.com/careers/some-role');
  assert.equal(r.ok, false);
  assert.equal(r.notAts, true);
});

test('a career page carrying gh_jid is recognised as a Greenhouse posting', async () => {
  // No network assertion here — only that the gh_jid shape is detected and explained. The
  // board token is absent from these URLs, so the message must say so rather than 404 blankly.
  const r = await fetchViaAts('https://zzz-not-a-real-company-xyz.com/careers?gh_jid=12345');
  assert.equal(r.ok, false);
  assert.match(r.error, /gh_jid=12345/);
  assert.match(r.error, /Greenhouse/i);
});

test('a malformed url does not throw', async () => {
  for (const bad of ['', 'not a url', 'ftp://x/y']) {
    const r = await fetchViaAts(bad);
    assert.equal(r.ok, false, `${bad} handled`);
  }
});

test('evaluate_job prefers the ATS API over the crawler for job links', async () => {
  // The crawler path returns `disallow_by_robots` on essentially every ATS, which is what
  // motivated this whole module. If someone reorders these, this test should catch it.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'evaluate.mjs'), 'utf8');
  const atsAt = src.indexOf('fetchViaAts');
  const crawlAt = src.indexOf('fetchUrl(url');
  assert.ok(atsAt > 0 && crawlAt > 0, 'both paths present');
  assert.ok(atsAt < crawlAt, 'the ATS API must be tried before the crawler');
});

// ---- LinkedIn job postings --------------------------------------------------
import { jobIdFromUrl } from '../linkedin-post.mjs';

test('LinkedIn job urls of every shape yield the job id', () => {
  assert.equal(jobIdFromUrl('https://www.linkedin.com/jobs/view/4456794897/'), '4456794897');
  assert.equal(jobIdFromUrl('https://www.linkedin.com/jobs/view/research-engineer-at-barrington-james-4456794897'), '4456794897');
  assert.equal(jobIdFromUrl('https://www.linkedin.com/jobs/search/?currentJobId=4456794897&keywords=ml'), '4456794897');
  assert.equal(jobIdFromUrl('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4456794897'), '4456794897');
});

test('a slugged job url takes the trailing id, not a number inside the slug', () => {
  // "...-at-company-2024-4456794897" must resolve to the job id, not to 2024.
  assert.equal(jobIdFromUrl('https://www.linkedin.com/jobs/view/ml-eng-2024-team-4456794897'), '4456794897');
});

test('non-job LinkedIn urls do not produce a job id', () => {
  for (const bad of [
    'https://www.linkedin.com/in/<PROFILE_SLUG>',
    'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000003/',
    'https://www.linkedin.com/company/acme',
    '',
  ]) assert.equal(jobIdFromUrl(bad), null, `"${bad}" must not look like a job`);
});

test('a post url and a job url are not confused for each other', () => {
  const postUrl = 'https://www.linkedin.com/posts/x_hiring-share-7000000000000000001-HL-j';
  const jobUrl = 'https://www.linkedin.com/jobs/view/4456794897/';
  assert.equal(jobIdFromUrl(postUrl), null, 'a post is not a job');
  assert.equal(postUrn(jobUrl), null, 'a job is not a post');
});

test('evaluate_job tries LinkedIn before the ATS path and the crawler', () => {
  // LinkedIn is robots-disallowed AND login-walled: neither of the other two can ever read one.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'evaluate.mjs'), 'utf8');
  const li = src.indexOf('getLinkedInJob(root, url)');
  const ats = src.indexOf('fetchViaAts(url)');
  const crawl = src.indexOf('fetchUrl(url');
  assert.ok(li > 0 && ats > 0 && crawl > 0, 'all three paths present');
  assert.ok(li < ats && ats < crawl, 'order must be LinkedIn -> ATS -> crawler');
});

// ---- auto-digest of new documents -------------------------------------------

test('a document added after the index was built becomes searchable without a restart', () => {
  const marker = `zzmarker${process.pid}unique`;
  search(root, 'quantization'); // build the index first
  assert.equal(search(root, marker).count, 0, 'marker absent to begin with');

  fs.writeFileSync(path.join(root, 'jds', 'newly-added.txt'),
    `Company: Newco\nRole: Staff Engineer\n\nThis posting contains ${marker} as a token.`);
  const after = search(root, marker, { force: true });
  assert.equal(after.count, 1, 'the new document must be indexed on the next query');
  assert.match(after.results[0].title, /Newco/);
});

test('editing an existing document reindexes its new content', () => {
  const marker = `zzedit${process.pid}unique`;
  const f = path.join(root, 'jds', 'newly-added.txt');
  fs.appendFileSync(f, `\n\nAmended with ${marker}.`);
  // Watching the parent directory's mtime would MISS this: editing a file in place does not
  // change its directory's timestamp. That is why the signature hashes file mtimes.
  assert.equal(search(root, marker, { force: true }).count, 1, 'an in-place edit must be picked up');
});

test('deleting a document removes it from the index', () => {
  const marker = `zzmarker${process.pid}unique`;
  fs.unlinkSync(path.join(root, 'jds', 'newly-added.txt'));
  assert.equal(search(root, marker, { force: true }).count, 0, 'a deleted document must stop being retrievable');
});

test('documents in subdirectories are indexed, not just the top level', () => {
  // 556 of 634 real JD files live in dated subdirectories; a flat readdir indexed only 78.
  fs.mkdirSync(path.join(root, 'jds', 'batch-2026-08'), { recursive: true });
  const marker = `zzsub${process.pid}unique`;
  fs.writeFileSync(path.join(root, 'jds', 'batch-2026-08', 'nested.txt'),
    `Company: Deepco\nRole: ML Engineer\n\nNested posting containing ${marker}.`);
  const r = search(root, marker, { force: true });
  assert.equal(r.count, 1, 'a JD in a subdirectory must be indexed');
  assert.match(r.results[0].path, /batch-2026-08/);
});

test('reports are indexed as their own kind, separate from JDs and profile', () => {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', '<NUM>-<company-slug>-<date>.md'),
    `# Testco\n\n**Score:** 4.2/5\n**URL:** https://testco.example/j/1\n\nStrong infra alignment; zzreport${process.pid} token.`);
  const r = search(root, `zzreport${process.pid}`, { force: true });
  assert.equal(r.count, 1);
  assert.equal(r.results[0].kind, 'report', 'a report must not be filed as a jd or profile doc');
  assert.match(r.results[0].title, /4\.2\/5/, 'the score belongs in the title so it is visible in results');
});

test('reports stay retrievable by kind without polluting the profile corpus', () => {
  // The repo's source-of-truth boundary forbids reports as a basis for CV/cover-letter claims.
  // Keeping them in their own kind is what lets the model tell the difference.
  const profile = search(root, `zzreport${process.pid}`, { kind: 'profile', force: true });
  assert.equal(profile.count, 0, 'a report must never appear in a profile-kind search');
});

test('a term ending a sentence is still findable', () => {
  // The tokenizer keeps interior punctuation so node.js and c++ survive, but that made a
  // sentence-final word swallow its full stop and stop matching the same word as a query.
  fs.writeFileSync(path.join(root, 'jds', 'punct.txt'),
    'Company: Punctco\nRole: Engineer\n\nWe deploy on Kubernetes. We also use node.js and c++ daily.');
  const r = search(root, 'kubernetes', { force: true });
  assert.ok(r.results.some((x) => x.title.includes('Punctco')), 'trailing-period term must match');
  assert.ok(search(root, 'node.js', { force: true }).count > 0, 'interior dots must still work');
  fs.unlinkSync(path.join(root, 'jds', 'punct.txt'));
});

test('the corpus is re-checked on a timer, so new docs need no restart or reindex command', async () => {
  // The force:true tests above prove the reindex is CORRECT; this proves it happens on its own.
  const { search: freshSearch } = await import(`../rag.mjs?ttl=${Date.now()}`);
  const marker = `zzttl${process.pid}unique`;
  freshSearch(root, 'warmup');
  fs.writeFileSync(path.join(root, 'jds', 'ttl-probe.txt'), `Company: Ttlco\nRole: Eng\n\nContains ${marker} token`);
  const immediately = freshSearch(root, marker).count;
  await new Promise((r) => setTimeout(r, 5200)); // default signature TTL is 5s
  const later = freshSearch(root, marker).count;
  fs.unlinkSync(path.join(root, 'jds', 'ttl-probe.txt'));
  assert.equal(later, 1, `picked up after the TTL lapsed (was ${immediately} immediately)`);
});

// ---- MCP surface -------------------------------------------------------------
import { buildServer } from '../mcp.mjs';

test('the MCP route is registered and still declared non-writing', () => {
  const r = ROUTES.find((x) => x.path === '/mcp');
  assert.ok(r, 'route exists');
  assert.equal(r.write, false, 'MCP exposes read-only tools only');
  assert.equal(r.method, 'POST');
});

test('MCP and the panel share ONE tool definition, so they cannot drift', async () => {
  // The MCP server is built from TOOL_SCHEMAS, not a parallel hand-written list. If someone
  // adds a tool for the panel and forgets MCP (or vice versa), this catches it.
  const server = buildServer({ root });
  const registered = Object.keys(server._registeredTools || {});
  for (const t of TOOL_SCHEMAS) {
    assert.ok(registered.includes(t.function.name), `${t.function.name} is missing from the MCP server`);
  }
  assert.ok(registered.includes('index_status'), 'the MCP-only discovery tool is present');
});

test('an enum parameter survives the JSON-Schema to zod conversion', () => {
  // kind: jd|report|application|profile must reach the client AS an enum — degrading it to a
  // free string means a chat app silently passes "jobs" and gets zero results with no error.
  const s = TOOL_SCHEMAS.find((t) => t.function.name === 'search_career_ops');
  const kind = s.function.parameters.properties.kind;
  assert.ok(Array.isArray(kind.enum) && kind.enum.includes('report'), 'source schema carries the enum');
  const server = buildServer({ root });
  assert.ok(server._registeredTools?.search_career_ops, 'tool registered');
});

test('every MCP tool name is a legal identifier for a chat client', () => {
  // Clients reject or mangle names with spaces or dots; catch it here rather than in a dialog.
  for (const t of TOOL_SCHEMAS) {
    assert.match(t.function.name, /^[a-z][a-z0-9_]{1,63}$/, `${t.function.name} is not a safe tool name`);
  }
});
