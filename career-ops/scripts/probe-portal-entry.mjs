#!/usr/bin/env node
// Probe a candidate portals.yml tracked_companies entry WITHOUT editing portals.yml:
// resolves the provider exactly as scan.mjs does, fetches one page, and prints the
// provider id, job count, and ML/AI/data titles found.
//   node scripts/probe-portal-entry.mjs '{"name":"<TARGET_COMPANY>","careers_url":"https://..."}'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

const entry = JSON.parse(process.argv[2] || '{}');
if (!entry.name || !(entry.careers_url || entry.api || entry.provider)) {
  console.log(JSON.stringify({ ok: false, error: 'need {name, careers_url|api|provider}' }));
  process.exit(1);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'providers');
const providers = await loadProviders(dir);
const resolved = resolveProvider(entry, providers);
const provider = resolved && (resolved.provider || resolved);
if (!provider || !provider.fetch) {
  console.log(JSON.stringify({ ok: false, error: 'no provider claims this entry', entry }));
  process.exit(2);
}
const ctx = { ...makeHttpCtx(), maxPages: 2 };
try {
  const jobs = await provider.fetch(entry, ctx);
  const ml = jobs.filter(j => /machine learning|\bml\b|\bai\b|artificial intelligence|data scien|llm|genai|generative|applied scien|deep learning|nlp|computer vision|data engineer/i.test(j.title || ''));
  console.log(JSON.stringify({ ok: true, provider: provider.id, jobs: jobs.length, ml_titles: ml.length, sample: ml.slice(0, 8).map(j => `${j.title} | ${j.location || ''}`) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, provider: provider.id, error: String(e.message || e).slice(0, 300), status: e.status }));
  process.exit(3);
}
