// scripts/protocol-contract.mjs in a scratch repository: a schema change without a new contract fails, also when the
// new fingerprint is recorded under the old number; raising the contract in both constants and recording passes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/protocol-contract.mjs');
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

test('a wire schema change needs a new PROTOCOL_CONTRACT', { skip: !gitAvailable && 'git is not on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-protocol-contract-'));
  try {
    const write = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
    const contract = number => {
      write('protocol/index.ts', `export const PROTOCOL_CONTRACT = ${number} as const;\n`);
      write('runtime/src/lib.rs', `pub const PROTOCOL_CONTRACT: u32 = ${number};\n`);
    };
    const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@example.invalid', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true }).status, 0, `git ${args.join(' ')}`);
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'scripts/protocol-contract.mjs'), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(script, join(dir, 'scripts/protocol-contract.mjs'));
    contract(5);
    write('protocol/WireRequest.schema.json', '{"request":1}\n');
    write('protocol/WireSuccess.schema.json', '{"success":1}\n');
    assert.equal(run('--record').status, 0);
    git('init', '-q');
    git('checkout', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    assert.equal(run().status, 0, 'the committed record matches');

    write('protocol/WireSuccess.schema.json', '{"success":2}\n');
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still 5/, 'a schema change at main\'s contract fails');
    assert.match(result.stderr, /changed since protocol\/contract\.json/, 'and the record is stale');
    assert.equal(run('--record').status, 1, 'recording the new fingerprint under the old number is refused');
    assert.equal(JSON.parse(readFileSync(join(dir, 'protocol/contract.json'), 'utf8')).contract, 5);

    write('protocol/index.ts', 'export const PROTOCOL_CONTRACT = 6 as const;\n');
    result = run('--record');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /6 in protocol\/index\.ts but 5 in runtime\/src\/lib\.rs/, 'both constants move together');

    contract(6);
    assert.equal(run('--record').status, 0);
    assert.equal(run().status, 0, 'a raised contract with a fresh record passes');

    contract(4);
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lower than main's 5/);

    // On main itself, a commit that changed the schema and re-recorded it under the same number: the committed check
    // compares with the commit before it, not with itself.
    git('checkout', '-q', 'main');
    git('reset', '-q', '--hard');
    write('protocol/WireRequest.schema.json', '{"request":2}\n');
    const recorded = JSON.parse(readFileSync(join(dir, 'protocol/contract.json'), 'utf8'));
    assert.equal(recorded.contract, 5, 'main as committed');
    const fingerprintOf = (...texts) => { const hash = createHash('sha256'); for (const text of texts) hash.update(text).update('\0'); return hash.digest('hex'); };
    write('protocol/contract.json', `${JSON.stringify({ contract: 5, fingerprint: fingerprintOf('{"request":2}\n', '{"success":1}\n') }, null, 2)}\n`);
    git('commit', '-q', '-am', 'schema change without a new contract');
    assert.equal(run().status, 1, 'a clean main (packaging) is checked against its parent as well');
    result = run('--committed');
    assert.equal(result.status, 1, 'the committed check compares the commit with its parent');
    assert.match(result.stderr, /still 5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
