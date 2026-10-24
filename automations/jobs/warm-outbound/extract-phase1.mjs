#!/usr/bin/env node
// extract-phase1.mjs — pulls the fenced ```json block out of `claude -p --output-format json`'s
// own JSON envelope (.result), validates it parses and has a candidates array, and writes just
// that inner JSON to outPath. Its own file (not inlined into run.sh) so run.sh never has to
// embed JS inside bash quoting.
import fs from 'node:fs';

const [, , cliJsonPath, outPath] = process.argv;
if (!cliJsonPath || !outPath) {
  console.error('usage: node extract-phase1.mjs <claude-cli-json> <out-phase1-json>');
  process.exit(1);
}

let envelope;
try { envelope = JSON.parse(fs.readFileSync(cliJsonPath, 'utf8')); }
catch (e) { console.error(`claude CLI output was not valid JSON: ${e.message}`); process.exit(1); }

if (envelope.is_error || typeof envelope.result !== 'string' || !envelope.result) {
  console.error(`claude phase-1 call failed: ${envelope.subtype || (envelope.is_error ? 'is_error' : 'no result')}`);
  process.exit(1);
}

const m = /```json\s*([\s\S]*?)```/.exec(envelope.result);
if (!m) { console.error('phase-1 result has no fenced ```json block'); process.exit(1); }

let parsed;
try { parsed = JSON.parse(m[1]); }
catch (e) { console.error(`fenced json block did not parse: ${e.message}`); process.exit(1); }

if (!Array.isArray(parsed.candidates)) { console.error('fenced json block has no "candidates" array'); process.exit(1); }

fs.writeFileSync(outPath, JSON.stringify(parsed));
