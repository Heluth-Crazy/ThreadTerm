// Real-app QA for Quick Launch v2 worktree setup.  This deliberately runs only
// the fixture Node programs below; its app PATH contains Node, Git's cmd folder,
// and System32, so installed agent CLIs cannot be launched.  Do not run this
// while developing: it requires runtime/target-qa and a Desktop 1 environment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs'; // Desktop 1; never takes the user's desktop.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const gitDir = (() => {
 const found = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
 const git = found.find(path => /\\cmd\\git\.exe$/i.test(path)) ?? found[0];
 assert.ok(git, 'git was not found'); return dirname(git);
})();
const scratch = await mkdtemp(join(tmpdir(), 'tt-worktree-setup-'));
const work = join(scratch, 'fixture');
const created = join(scratch, 'setup-worktree');
const appDir = join(scratch, 'app');
const out = join(root, 'qa/results/worktree-setup');
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [] };
let app, page, project, finalizing = false;
const delay = ms => new Promise(done => setTimeout(done, ms));
const asText = error => error instanceof Error ? (error.stack ?? error.message) : String(error);
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const canonicalPath = value => String(value ?? '').replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const samePath = (left, right) => canonicalPath(left) === canonicalPath(right);
async function until(probe, label, timeout = 45_000) {
 const end = Date.now() + timeout;
 for (;;) {
  try { const value = await probe(); if (value) return value; } catch { /* React/runtime may still be changing. */ }
  if (Date.now() >= end) throw Error(`Timed out: ${label}`);
  await delay(200);
 }
}
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name) }); report.screenshots.push(name); }
async function snapshot() { return request('runtime.snapshot'); }
async function setupRuns() { return request('quickLaunch.setup.status', { projectId: project.id }); }
async function latestSetup(rootPath = created) { return until(async () => (await setupRuns()).find(run => samePath(run.root, rootPath)), `setup sequence for ${rootPath}`); }
async function buildApp() {
 await mkdir(appDir, { recursive: true });
 for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
 await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
 await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-worktree-setup-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function prepareFixture() {
 await mkdir(work, { recursive: true });
 for (const args of [['init'], ['config', 'user.email', 'qa@example.test'], ['config', 'user.name', 'Worktree Setup QA']]) execFileSync('git', args, { cwd: work, stdio: 'pipe' });
 await writeFile(join(work, 'step1.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile('step1.done','done');\n");
 await writeFile(join(work, 'step2.mjs'), "import { existsSync } from 'node:fs'; if (!existsSync('allow-step2')) process.exit(1);\n");
 await writeFile(join(work, 'step3.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile('step3.done','done');\n");
 await writeFile(join(work, 'README.md'), 'worktree setup fixture\n');
 execFileSync('git', ['add', '.'], { cwd: work, stdio: 'pipe' });
 execFileSync('git', ['commit', '-m', 'fixture'], { cwd: work, stdio: 'pipe' });
 await buildApp();
}
const menu = () => page.locator('[data-testid="quick-launch-menu"]');
// The trigger toggles; after "Run setup again" the menu stays open to show progress.
async function openRun() { if (!(await menu().isVisible())) await page.getByRole('button', { name: /^(Run|运行)/ }).first().click(); await menu().waitFor(); }
async function saveSetupInDialog(commands) {
 await openRun();
 await page.getByRole('button', { name: /Worktree setup|工作树初始化/ }).click();
 const dialog = page.getByRole('dialog'); await dialog.waitFor();
 await shot('01-setup-dialog.png');
 for (const command of commands) {
  const box = dialog.getByRole('checkbox', { name: new RegExp(command.name, 'i') });
  if (!await box.isChecked()) await box.check();
 }
 // Exercise the accessible ordering controls while restoring the fixture order.
 const secondUp = dialog.getByRole('button', { name: /Move up step 2|上移 step 2/ });
 await secondUp.click();
 await dialog.getByRole('button', { name: /Move down step 2|下移 step 2/ }).click();
 await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click();
 await dialog.waitFor({ state: 'hidden' });
 const setup = await request('quickLaunch.setup.read', { projectId: project.id });
 assert.deepEqual(setup.commandIds, commands.map(command => command.id), 'dialog saved setup commands in fixture order');
}
async function createWorktreeViaUi() {
 await page.getByRole('button', { name: /^(New worktree|新建工作树)$/ }).click();
 const dialog = page.getByRole('dialog'); await dialog.waitFor();
 await dialog.getByLabel(/Branch name|分支名/).fill('qa-worktree-setup');
 await dialog.getByLabel(/Worktree directory|工作树目录/).fill(created);
 await dialog.getByRole('button', { name: /Create worktree|创建工作树/ }).click();
 await dialog.waitFor({ state: 'hidden' });
 await until(async () => (await request('worktree.list', { projectId: project.id })).some(tree => samePath(tree.path, created)), 'worktree created through UI');
}
async function showCreatedWorktree() {
 const row = page.locator('.tree-row').filter({ hasText: 'qa-worktree-setup' }).first();
 if (await row.count()) { await row.click(); await page.getByTestId('project-home').waitFor(); }
}
async function openRunSetupAgain() {
 await openRun();
 await page.getByRole('button', { name: /Run setup again|再次运行初始化/ }).click();
}
// Stop the running step the way a user would: its Stop button in the Run menu.
async function stopCurrentStep(run) {
 assert.ok(run.sessionIds.at(-1), 'running setup has a current terminal');
 await openRun();
 const row = menu().locator('.ql-command').filter({ hasText: run.names[run.step] });
 await row.getByRole('button', { name: /^(Stop|停止)$/ }).click();
}
async function finalize(fatal) {
 if (finalizing) return; finalizing = true;
 if (fatal) { report.errors.push(asText(fatal)); console.error(`FAIL ${asText(fatal)}`); }
 await mkdir(out, { recursive: true }).catch(() => {});
 if (page && report.errors.length) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
 if (page) await Promise.race([request('runtime.shutdown', { operationId: randomUUID() }), delay(3_000)]).catch(() => {});
 if (app) { await Promise.race([app.evaluate(({ app: electronApp }) => electronApp.exit(0)), delay(2_000)]).catch(() => {}); await Promise.race([app.close(), delay(5_000)]).catch(() => {}); try { app.process()?.kill(); } catch {} }
 if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
 await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
 process.exitCode = report.passed && !report.errors.length ? 0 : 1;
}
process.on('uncaughtException', error => { void finalize(error); });
process.on('unhandledRejection', error => { void finalize(error); });

try {
 assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa first`);
 await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await prepareFixture();
 // Remove every spelling of PATH before constructing the complete, safe process PATH.
 const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path' && !/^(claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i.test(name)));
 Object.assign(env, { PATH: [dirname(process.execPath), gitDir, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-worktree-setup-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime });
 app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
 page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
 await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor({ timeout: 60_000 }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
 const initial = await snapshot();
 await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings?.revision ?? 0, operationId: randomUUID() });
 project = await request('project.add', { path: work, name: 'Worktree Setup QA', operationId: randomUUID() });
 await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.proj-row').filter({ hasText: 'Worktree Setup QA' }).click(); await page.getByTestId('project-home').waitFor();
 const commands = [];
 for (const [name, command] of [['step 1', 'node step1.mjs'], ['step 2', 'node step2.mjs'], ['step 3', 'node step3.mjs']]) commands.push(await request('quickLaunch.save', { projectId: project.id, name, command, shell: 'cmd', cwd: '', kind: 'task', env: [], operationId: randomUUID() }));
 await saveSetupInDialog(commands);
 await createWorktreeViaUi();
 const failed = await until(async () => { const run = await latestSetup(); return run.state === 'failed' && run; }, 'automatic setup fails at step 2');
 assert.equal(failed.step, 1); assert.equal(failed.exitCode, 1); assert.ok(existsSync(join(created, 'step1.done')), 'step 1 marker exists'); assert.ok(!existsSync(join(created, 'step3.done')), 'step 3 did not run after failure');
 // The worktree's own home (where the user lands) shows the outcome; the Run menu repeats it.
 await showCreatedWorktree(); const card = page.getByTestId('worktree-setup-card');
 await until(async () => /Setup failed at.*step 2.*exit 1/i.test(await card.innerText().catch(() => '')), 'failed setup card on the worktree home'); await shot('02-failed-state.png');
 await writeFile(join(created, 'allow-step2'), 'allow\n');
 await card.getByRole('button', { name: /Retry from this step|从此步骤重试/ }).click();
 const retried = await until(async () => { const run = await latestSetup(); return run.id !== failed.id && run.state === 'completed' && run; }, 'retry completes steps 2 and 3');
 assert.equal(retried.trigger, 'retry'); assert.equal(retried.step, 2); assert.ok(existsSync(join(created, 'step3.done')), 'step 3 marker exists after retry'); check('automatic setup runs step 1, stops at failing step 2, then retries its snapshot through step 3');
 await openRunSetupAgain();
 const manual = await until(async () => { const run = await latestSetup(); return run.id !== retried.id && run.state === 'completed' && run; }, 'manual setup completes');
 assert.equal(manual.trigger, 'manual'); await shot('03-completed-state.png'); check('Run setup again starts a completed manual sequence');
 // Rewrite only the untracked worktree fixture copy so a manual setup reaches a stoppable step without changing its saved command definition.
 await writeFile(join(created, 'step2.mjs'), "await new Promise(resolve => setTimeout(resolve, 60000));\n");
 await openRunSetupAgain();
 const running = await until(async () => { const run = await latestSetup(); return run.id !== manual.id && run.state === 'running' && run.step === 1 && run; }, 'slow step 2 is running');
 const concurrent = await Promise.all([request('quickLaunch.setup.run', { projectId: project.id, cwd: created, operationId: randomUUID() }), request('quickLaunch.setup.run', { projectId: project.id, cwd: created, operationId: randomUUID() })]);
 assert.equal(concurrent[0].id, running.id); assert.equal(concurrent[1].id, running.id); assert.equal((await setupRuns()).filter(run => samePath(run.root, created) && run.state === 'running').length, 1, 'only one setup sequence runs per root');
 await stopCurrentStep(running);
 const cancelled = await until(async () => { const run = await latestSetup(); return run.id === running.id && run.state === 'cancelled' && run; }, 'Stop cancels setup sequence');
 assert.equal(cancelled.step, 1); check('a terminal Stop cancels the active sequence and concurrent starts reuse its single run');
 assert.deepEqual(report.errors, [], 'renderer emitted no console or page errors'); report.passed = true;
} catch (error) { await finalize(error); } finally { await finalize(); }
