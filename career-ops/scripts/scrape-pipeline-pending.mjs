import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const runDate = process.argv[2] || new Date().toISOString().slice(0, 10);
const pipelinePath = resolve('data/pipeline.md');
const reportsDir = resolve('reports');
const outDir = resolve(`jds/pipeline-${runDate}`);

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

function compact(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractLines(text) {
  const seen = new Set();
  const lines = [];
  for (const line of text.split(/\n+/).map(compact).filter(Boolean)) {
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function nextReportNum() {
  if (!existsSync(reportsDir)) return 1;
  const nums = readdirSync(reportsDir)
    .map((name) => name.match(/^(\d{3})-/)?.[1])
    .filter(Boolean)
    .map((value) => Number(value));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function parsePendingJobs() {
  const lines = readFileSync(pipelinePath, 'utf-8').split(/\r?\n/);
  const jobs = [];
  for (const line of lines) {
    if (!line.startsWith('- [ ]')) continue;
    const parts = line.replace(/^- \[ \]\s*/, '').split('|').map((part) => part.trim());
    if (parts.length < 3) continue;
    jobs.push({ url: parts[0], company: parts[1], role: parts.slice(2).join(' | ') });
  }
  return jobs;
}

function classifyStatus(result) {
  const text = `${result.pageTitle || ''}\n${result.h1 || ''}\n${result.text || ''}`.toLowerCase();
  if (result.error) return 'error';
  if (result.status && result.status >= 400) return 'http-error';
  if (result.finalUrl?.includes('linkedin.com') && /sign in|join linkedin|login/.test(text)) return 'login-blocked';
  if (/job no longer available|job posting is no longer active|no longer accepting|position has been filled|job has expired|not found|404|job you are looking for is no longer/.test(text)) return 'closed';
  if (result.textLength < 800) return 'thin-content';
  if (/apply|submit application|apply now/.test(text)) return 'active';
  return 'needs-review';
}

mkdirSync(outDir, { recursive: true });

const jobs = parsePendingJobs();
const firstReportNum = nextReportNum();
const browser = await chromium.launch({ headless: true });
const results = [];

for (let index = 0; index < jobs.length; index++) {
  const job = jobs[index];
  const reportNum = firstReportNum + index;
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  });
  const result = { ...job, reportNum, id: index + 1 };

  try {
    const response = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    const title = await page.title().catch(() => '');
    const h1 = await page.locator('h1').first().innerText({ timeout: 4000 }).catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    const lines = extractLines(bodyText);
    const text = lines.join('\n');

    result.status = response?.status() ?? null;
    result.finalUrl = page.url();
    result.pageTitle = compact(title);
    result.h1 = compact(h1);
    result.textLength = text.length;
    result.text = text;
    result.verification = classifyStatus(result);

    const slug = `${String(reportNum).padStart(3, '0')}-${slugify(job.company)}-${slugify(job.role)}`;
    result.jdPath = `jds/pipeline-${runDate}/${slug}.md`;
    writeFileSync(
      resolve(result.jdPath),
      `# ${job.company} - ${job.role}\n\nURL: ${job.url}\nFinal URL: ${result.finalUrl}\nHTTP status: ${result.status ?? 'n/a'}\nVerification: ${result.verification}\nPage title: ${result.pageTitle}\nH1: ${result.h1}\n\n---\n\n${text}\n`,
      'utf-8',
    );
    console.log(`${index + 1}/${jobs.length} ${result.verification} | #${String(reportNum).padStart(3, '0')} | ${job.company} | ${job.role} | chars=${text.length}`);
  } catch (error) {
    result.error = error.message;
    result.verification = classifyStatus(result);
    console.log(`${index + 1}/${jobs.length} ${result.verification} | #${String(reportNum).padStart(3, '0')} | ${job.company} | ${job.role} | ${error.message}`);
  } finally {
    results.push(result);
    await page.close();
  }
}

await browser.close();
writeFileSync(resolve(outDir, 'pipeline-jobs.json'), JSON.stringify(results, null, 2), 'utf-8');
console.log(`Saved ${results.length} results to ${resolve(outDir, 'pipeline-jobs.json')}`);
