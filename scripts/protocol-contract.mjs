#!/usr/bin/env node
// Keeps PROTOCOL_CONTRACT honest (11-26). Desktops, runtimes and paired computers refuse each other at the handshake
// when their contracts differ, but the contract stayed 20 while the wire schema changed, so a desktop and a runtime
// from different packages agreed and then rejected each other's replies without a word.
//
// protocol/contract.json records the contract with a fingerprint of the generated wire schemas (RPC requests and
// results: WireRequest.schema.json + WireSuccess.schema.json). This script fails when:
//   - the record is stale (the schemas changed and nobody recorded them),
//   - protocol/index.ts, runtime/src/lib.rs and the record disagree on the contract,
//   - the schemas differ from the base revision's (merge-base of HEAD and main) while the contract is the same,
//     also when the new fingerprint was recorded under the old number.
//
//   node scripts/protocol-contract.mjs [--repo <git dir>] [--committed]  check (npm run check)
//   node scripts/protocol-contract.mjs --record [--repo <git dir>]       after raising the contract: write the record
// --committed: the checked tree is HEAD itself (check.mjs without --working-tree), so on main the base is HEAD's
// first parent: a commit must not be its own base. Without it the same holds when nothing of the protocol differs from
// HEAD (a clean main being packaged): then HEAD is what is checked.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const repo = resolve(option('--repo') ?? root);
const record = process.argv.includes('--record');
const committed = process.argv.includes('--committed');
const RECORD = 'protocol/contract.json';
const SCHEMAS = ['protocol/WireRequest.schema.json', 'protocol/WireSuccess.schema.json'];
const normalized = text => text.replace(/\r\n/g, '\n');

function fingerprint(schemas) {
  const hash = createHash('sha256');
  for (const text of schemas) hash.update(normalized(text)).update('\0');
  return hash.digest('hex');
}
const constant = (path, pattern) => {
  const match = pattern.exec(readFileSync(join(root, path), 'utf8'));
  if (!match) throw new Error(`${path}: PROTOCOL_CONTRACT not found`);
  return Number(match[1]);
};
const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 60000, windowsHide: true });

const current = fingerprint(SCHEMAS.map(path => readFileSync(join(root, path), 'utf8')));
const typescript = constant('protocol/index.ts', /export const PROTOCOL_CONTRACT = (\d+) as const;/);
const rust = constant('runtime/src/lib.rs', /pub const PROTOCOL_CONTRACT: u32 = (\d+);/);
const problems = [];
if (typescript !== rust) problems.push(`PROTOCOL_CONTRACT is ${typescript} in protocol/index.ts but ${rust} in runtime/src/lib.rs`);

// The base: what main has. Without a main branch (an export without history) only the record itself is checked.
const revision = args => { const result = git(['rev-parse', '--verify', '--quiet', ...args]); return result.status === 0 ? result.stdout.trim() : undefined; };
const mergeBase = git(['merge-base', 'HEAD', 'main']);
let base = mergeBase.status === 0 ? mergeBase.stdout.trim() : undefined;
const protocolInputs = [RECORD, ...SCHEMAS, 'protocol/index.ts', 'runtime/src/lib.rs'];
const uncommitted = () => git(['diff', '--quiet', 'HEAD', '--', ...protocolInputs]).status !== 0;
if (base && base === revision(['HEAD']) && (committed || !uncommitted())) base = revision(['HEAD^1']);
const baseRecord = (() => {
  if (!base) return undefined;
  const shown = git(['show', `${base}:${RECORD}`]);
  return shown.status === 0 ? JSON.parse(shown.stdout) : undefined;
})();
if (baseRecord) {
  if (typescript < baseRecord.contract) problems.push(`PROTOCOL_CONTRACT ${typescript} is lower than main's ${baseRecord.contract}`);
  else if (baseRecord.fingerprint !== current && typescript === baseRecord.contract) {
    problems.push(`the wire schema changed since main (${base.slice(0, 8)}) but PROTOCOL_CONTRACT is still ${typescript}: raise it in protocol/index.ts and runtime/src/lib.rs, then run npm run protocol:contract`);
  }
}

if (record) {
  if (problems.length) { for (const problem of problems) console.error(`protocol contract: ${problem}`); process.exit(1); }
  writeFileSync(join(root, RECORD), `${JSON.stringify({ contract: typescript, fingerprint: current }, null, 2)}\n`);
  console.log(`protocol contract: recorded ${typescript} ${current.slice(0, 12)}`);
  process.exit(0);
}

if (!existsSync(join(root, RECORD))) problems.push(`${RECORD} is missing: run npm run protocol:contract`);
else {
  const stored = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  if (stored.contract !== typescript) problems.push(`${RECORD} records contract ${stored.contract}, protocol/index.ts says ${typescript}: run npm run protocol:contract`);
  if (stored.fingerprint !== current) problems.push(`the wire schema changed since ${RECORD} was written: raise PROTOCOL_CONTRACT if main has this one, then run npm run protocol:contract`);
}
if (problems.length) { for (const problem of problems) console.error(`protocol contract: ${problem}`); process.exit(1); }
console.log(`protocol contract: ${typescript} matches the wire schema${baseRecord ? ` (main has ${baseRecord.contract})` : base ? ' (main has no record yet)' : ' (no main to compare with)'}`);
