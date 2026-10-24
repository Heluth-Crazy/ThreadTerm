#!/usr/bin/env node
// Bundles every renderer unit test (renderer/src/**/*.test.ts) with esbuild and runs the bundles through node --test.
// The renderer sources import each other without file extensions (Vite resolves them), so plain Node cannot load
// them; esbuild gives each test the same module graph the renderer build uses. Usage: node scripts/run-renderer-tests.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testFile = /\.test\.ts$/;

function discover(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') discover(path, found);
    } else if (testFile.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const tests = discover(join(root, 'renderer/src')).sort();
if (tests.length === 0) {
  console.error('renderer tests: no *.test.ts under renderer/src');
  process.exit(1);
}
const out = mkdtempSync(join(tmpdir(), 'tt-renderer-tests-'));
const bundles = [];
for (const [index, entry] of tests.entries()) {
  const outfile = join(out, `${index}-${relative(root, entry).replace(/[\\/]/g, '-').replace(/\.ts$/, '.mjs')}`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['node:*'] });
  bundles.push(outfile);
}
console.log(`renderer tests: ${bundles.length} files`);
const result = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...bundles], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
