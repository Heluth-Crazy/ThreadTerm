import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'desktop/src/local-files');
const tests = (await readdir(source)).filter(name => name.endsWith('.test.mts')).sort();
if (!tests.length) throw new Error('No local file tests found');
const output = join(root, 'desktop-dist/local-files-tests');
await build({
  entryPoints: tests.map(name => join(source, name)), outdir: output, outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'warning',
});
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => join(output, name.replace(/\.mts$/, '.cjs')))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
