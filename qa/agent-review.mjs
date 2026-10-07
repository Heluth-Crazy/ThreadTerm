// Real-app independent-agent-review QA. It launches only the local Review Echo
// ACP fixture with an isolated profile and a deliberately restricted PATH.
// Do not run until runtime/target-qa is built by the runtime owner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs'; // Desktop 1; never steals focus.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/agent-review-echo-acp');
const out = join(root, 'qa/results/agent-review');
const scratch = await mkdtemp(join(tmpdir(), 'tt-agent-review-'));
const appDir = join(scratch, 'app');
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], errors: [] };
let app, page;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* the runtime or React may still be updating */ }
    if (Date.now() >= end) throw Error(`Timed out: ${label}`);
    await delay(150);
  }
}
const shot = async name => { await delay(200); await page.screenshot({ path: join(out, name) }); };
const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
const rail = name => page.locator('.wb-switcher').getByRole('button', { name, exact: true });
async function openView(name) { if (await rail(name).getAttribute('aria-pressed') !== 'true') await rail(name).click(); }
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-agent-review-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function enableFixture() {
  await until(async () => (await request('plugin.list')).plugins.some(plugin => plugin.id === 'agent-review-echo-acp'), 'Agent Review Echo fixture discovered');
  await request('plugin.setEnabled', { pluginId: 'agent-review-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => { const providers = await request('provider.list'); return providers.some(provider => provider.id === 'review-echo' && provider.chat) && providers.some(provider => provider.id === 'implementation-echo' && provider.chat); }, 'Review and implementation Echo enabled');
}
async function startReview() {
  await page.getByTestId('agent-review-start').click();
  const dialog = page.getByTestId('agent-review-dialog').locator('xpath=ancestor::*[@role="dialog"]'); await dialog.waitFor();
  const select = dialog.getByRole('combobox');
  await select.click();
  await page.getByRole('listbox').getByRole('option', { name: 'Review Echo', exact: true }).click();
  const whole = dialog.getByRole('radio', { name: /Whole session/i });
  if (await whole.count()) await whole.check();
  if (!report.shots?.includes('00-dialog.png')) { await shot('00-dialog.png'); (report.shots ??= []).push('00-dialog.png'); }
  await dialog.getByRole('button', { name: /^(Start review|Review with agent)$/i }).click();
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing Agent Review Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await buildApp();
  const plugins = join(scratch, 'plugins'); cpSync(fixture, join(plugins, 'agent-review-echo-acp'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  // Git's own cmd folder (git, gitk, git-gui only), wherever Git is installed; review checkpoints need git.
  const found = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean);
  const gitExe = found.find(path => /\\cmd\\git\.exe$/i.test(path)) ?? found[0];
  assert.ok(gitExe, 'git was not found');
  env.PATH = [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
  Object.assign(env, {
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-agent-review-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_ECHO_STORE_DIR: join(scratch, 'echo-store'),
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor({ timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  await enableFixture(); check('isolated profile launches with notifications disabled, restricted PATH, and only Review Echo');

  const work = join(scratch, 'review-repo'); await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src/review-target.ts'), 'export const reviewed = false;\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial');
  const project = await request('project.add', { path: work, name: 'Agent review QA', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: work, title: 'Implementation Echo', provider: 'implementation-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => await composer(session.id).isEnabled(), 'implementation composer ready');
  const checkpoint = await request('review.checkpoint', { sessionId: session.id, kind: 'manual', operationId: randomUUID() });
  assert.equal(checkpoint.status, 'ready');
  await writeFile(join(work, 'src/review-target.ts'), 'export const reviewed = true;\n');
  await openView('Agent changes'); await page.getByTestId('agent-review-start').waitFor();
  await startReview();
  const finished = await until(async () => (await request('agentReview.list', { sessionId: session.id }))[0]?.state === 'completed' ? (await request('agentReview.list', { sessionId: session.id }))[0] : undefined, 'reviewer completes');
  const reviewerText = (await request('chat.snapshot', { sessionId: finished.reviewerSessionId })).items.flatMap(item => item.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(reviewerText, /src\/review-target\.ts/); assert.match(reviewerText, /reviewed = true/);
  await page.getByTestId('agent-review-list').waitFor();
  const findings = await until(async () => (await request('agentReview.list', { sessionId: session.id }))[0]?.findings, 'findings parsed');
  assert.equal(findings.length, 3); assert.equal(findings.filter(finding => !finding.path).length, 2);
  await until(async () => await page.getByTestId('agent-review-finding').count() === 3, 'three findings render');
  await page.getByTestId('agent-review-list').scrollIntoViewIfNeeded(); await shot('00-findings.png');
  await page.getByTestId('agent-review-finding').first().locator('input[type=checkbox]').check();
  await page.getByTestId('agent-review-add-comments').click();
  // File comments are displayed by a text-file view, not the Agent Changes panel.
  await openView('Files');
  const srcFolder = page.locator('.wb-tree-row[data-path="src"]');
  await srcFolder.waitFor();
  if (await srcFolder.getAttribute('aria-expanded') !== 'true') await srcFolder.click();
  await page.locator('.wb-tree-row[data-path="src/review-target.ts"]').click();
  const strip = page.locator('.wb-review-comments').first(); await strip.waitFor();
  assert.match(await strip.innerText(), /review-target\.ts:1/); await shot('01-findings-and-comment.png');
  check('whole-session review receives the captured diff, renders three findings, and anchors the high finding as a file comment');
  await strip.getByRole('button', { name: 'Add to message', exact: true }).click();
  await until(async () => (await composer(session.id).inputValue()).includes('Changed behavior needs a regression test'), 'comment added to implementation composer');
  check('Add to message inserts the accepted finding into the implementation session without sending it');

  await mkdir(join(work, '.threadterm'), { recursive: true }); await writeFile(join(work, '.threadterm/review.md'), 'INVALID-REVIEW-MARKER\n');
  await writeFile(join(work, 'src/review-target.ts'), 'export const reviewed = "again";\n');
  await openView('Agent changes'); await startReview();
  const reviews = await until(async () => { const value = await request('agentReview.list', { sessionId: session.id }); return value.length >= 2 && value[0]?.state === 'completed' ? value : undefined; }, 'second review completes');
  const invalid = reviews[0]; assert.equal(invalid.instructions, 'repository'); assert.equal(invalid.unparsed, true);
  const invalidPrompt = (await request('chat.snapshot', { sessionId: invalid.reviewerSessionId })).items.flatMap(item => item.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(invalidPrompt, /INVALID-REVIEW-MARKER/); await page.getByTestId('agent-review-unparsed').waitFor(); await shot('02-repository-instructions-unparsed.png');
  check('repository review instructions reach the reviewer and a reply without a findings block shows the unparsed fallback');
  assert.deepEqual(report.errors, [], report.errors.join('\n')); report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  report.completedAt = new Date().toISOString(); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'AGENT REVIEW QA PASSED' : `AGENT REVIEW QA FAILED\n${report.errors.join('\n')}`); process.exitCode = report.passed ? 0 : 1;
}
