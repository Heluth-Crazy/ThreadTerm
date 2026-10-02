import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { prototypeRoot, outputRoot } from './harness.mjs';

const lint = new ESLint({ cwd: prototypeRoot, overrideConfigFile: resolve(prototypeRoot, 'tests/eslint.config.mjs') });
const lintResults = await lint.lintFiles(['app.js', 'features/*.js', 'editor-src/*.js', 'editor-build.mjs', 'tests/*.mjs']);
const formatter = await lint.loadFormatter('stylish');
const lintText = formatter.format(lintResults);
if (lintText) process.stdout.write(lintText);
const errors = lintResults.reduce((sum, result) => sum + result.errorCount, 0);
if (errors) throw new Error(`Scoped ESLint failed with ${errors} errors.`);
process.stdout.write('PASS scoped ESLint\n');

const steps = [
  ['editor-build.mjs', null],
  ['tests/verify.mjs', 'verification-results.json'],
  ['tests/core-review.mjs', 'core-review-results.json'],
  ['tests/editor-review.mjs', 'editor-review-results.json'],
  ['tests/settings-review.mjs', 'settings-review-results.json'],
  ['tests/session-workflows.mjs', 'session-workflows-results.json'],
  ['tests/desktop-completion.mjs', 'desktop-completion-results.json'],
  ['tests/visuals.mjs', 'visuals-results.json'],
];
const summaries = [];
let failed = false;
for (const [script, report] of steps) {
  const result = spawnSync(process.execPath, [resolve(prototypeRoot, script)], {
    cwd: prototypeRoot, stdio: 'inherit', env: { ...process.env, PROTOTYPE_TEST: '' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
  if (!report) {
    summaries.push({ step: 'editor build', status: result.status === 0 ? 'passed' : 'failed' });
    continue;
  }
  const data = JSON.parse(await readFile(resolve(outputRoot, report), 'utf8'));
  summaries.push({ step: script, report, scenarios: data.results.length, passed: data.results.filter((row) => row.status === 'passed').length, failed: data.results.filter((row) => row.status !== 'passed').length });
}
const summary = { generatedAt: new Date().toISOString(), scope: 'static prototype only', lint: { status: 'passed', files: lintResults.length }, typeCheck: 'Not applicable: plain JavaScript; production TypeScript/Rust unchanged.', steps: summaries };
await writeFile(resolve(outputRoot, 'verification-summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (failed) process.exitCode = 1;
