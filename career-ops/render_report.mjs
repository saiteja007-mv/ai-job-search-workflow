import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import path from 'path';

const html = path.resolve('job_search_report.html');
const out = path.resolve('job_search_report.pdf');
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
await p.pdf({ path: out, format: 'A4', printBackground: true });
await b.close();
console.log('PDF written:', out);
