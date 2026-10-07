// Real-app QA for per-session Plans & docs. This intentionally launches a plain
// cmd terminal only: the child PATH contains Node, Git and System32, with every
// inherited PATH spelling removed, so no installed agent CLI can be selected.
// Do not run while developing; Desktop 1 and runtime/target-qa are required.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
 const git = found.find(value => /\\cmd\\git\.exe$/i.test(value)) ?? found[0];
 assert.ok(git, 'git was not found');
 return dirname(git);
})();
const scratch = await mkdtemp(join(tmpdir(), 'tt-plan-artifacts-'));
const work = join(scratch, 'fixture'), appDir = join(scratch, 'app');
const out = join(root, 'qa/results/plan-artifacts');
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [] };
let app, page, session, finalizing = false;
const delay = ms => new Promise(done => setTimeout(done, ms));
const asText = error => error instanceof Error ? (error.stack ?? error.message) : String(error);
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 45_000) {
 const end = Date.now() + timeout;
 for (;;) {
  try { const value = await probe(); if (value) return value; } catch { /* React/runtime can be between updates. */ }
  if (Date.now() >= end) throw Error(`Timed out: ${label}`);
  await delay(200);
 }
}
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name) }); report.screenshots.push(name); }
async function buildApp() {
 await mkdir(appDir, { recursive: true });
 for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
 await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
 await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-plan-artifacts-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function prepareFixture() {
 await mkdir(join(work, 'docs'), { recursive: true });
 await writeFile(join(work, 'docs/plan.md'), '# Checkout plan\n\nKeep the checkout path simple.\n');
 await writeFile(join(work, 'docs/research.md'), '---\nauthor: QA\n---\n\n## Payment research\n\nCompare providers.\n');
 await writeFile(join(work, 'notes.txt'), 'A plain pinned note.\n');
 for (const args of [['init'], ['config', 'user.email', 'qa@example.test'], ['config', 'user.name', 'Plan artifacts QA']]) execFileSync('git', args, { cwd: work, stdio: 'pipe' });
 execFileSync('git', ['add', '.'], { cwd: work, stdio: 'pipe' });
 execFileSync('git', ['commit', '-m', 'fixture'], { cwd: work, stdio: 'pipe' });
 await buildApp();
}
const inspector = () => page.locator('aside.inspector');
const plans = () => page.getByTestId('session-documents');
async function openInspector() {
 const button = page.getByRole('button', { name: /^(Session details|会话详情面板)$/ }).first();
 if (!(await inspector().isVisible())) await button.click();
 await inspector().waitFor();
 await plans().waitFor();
}
async function showSession() {
 await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(window => window.isVisible())?.webContents.send('threadterm:desktop-navigate', { sessionId: id }), session.id);
 // The terminal session's workspace (Chat sessions have a session-chat-* test id; terminals do not).
 await page.locator('section.session-screen').waitFor();
}
async function openFile(path) {
 await request('filesystem.read', { projectId: session.projectId, worktreePath: work, path });
 // The real UI flow uses the Explorer row; opening it once also makes its file tab available for the toolbar route.
 // The workbench switcher mounts lazily; wait for it instead of skipping the click.
 const files = page.locator('.wb-switcher').getByRole('button', { name: 'Files', exact: true });
 await files.waitFor();
 if (await files.getAttribute('aria-pressed') !== 'true') await files.click();
 const parts = path.split('/');
 for (let index = 1; index < parts.length; index++) {
  const folder = parts.slice(0, index).join('/');
  const row = page.locator(`.wb-tree-row[data-path="${folder}"]`);
  await row.waitFor();
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
 }
 const row = page.locator(`.wb-tree-row[data-path="${path}"]`); await row.waitFor(); await row.click();
}
async function pinFromFileTab() {
 await openFile('docs/plan.md');
 const pin = page.getByRole('button', { name: /^Add to Plans & docs \(Session details\)$/ });
 await pin.waitFor(); await until(async () => await pin.isEnabled(), 'file-tab pin button enabled'); await pin.click();
 await until(async () => (await request('session.documents.list', { sessionId: session.id })).some(item => item.path === 'docs/plan.md'), 'plan pinned from file tab');
 assert.equal(await page.getByRole('button', { name: /^Remove from Plans & docs$/ }).getAttribute('aria-pressed'), 'true', 'file-tab pin toggle is pressed');
 await shot('01-file-tab-pinned.png');
}
async function pinFromExplorer() {
 const row = page.locator('.wb-tree-row[data-path="notes.txt"]'); await row.waitFor(); await row.click({ button: 'right' });
 const item = page.getByRole('menuitem', { name: /Add to Plans & docs|添加到计划与文档/ }); await item.waitFor(); await shot('02-explorer-menu.png'); await item.click();
 await until(async () => (await request('session.documents.list', { sessionId: session.id })).some(value => value.path === 'notes.txt'), 'notes pinned from Explorer menu');
}
async function pinFromPicker() {
 await openInspector();
 await plans().getByRole('button', { name: /Add file…|添加文件…/ }).click();
 const picker = page.getByRole('dialog', { name: /^Add to Plans & docs$/ }); await picker.waitFor();
 await picker.getByRole('textbox', { name: /^File name$/ }).fill('research.md');
 const result = picker.getByRole('option', { name: /research\.md/ }); await result.waitFor(); await shot('03-picker.png'); await result.click();
 await until(async () => (await request('session.documents.list', { sessionId: session.id })).some(value => value.path === 'docs/research.md'), 'research pinned from picker');
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
 // Drop all case variants before supplying the intentionally tiny launch PATH.
 const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path' && !/^(claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i.test(name)));
 Object.assign(env, { PATH: [dirname(process.execPath), gitDir, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-plan-artifacts-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime });
 app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
 page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
 await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor({ timeout: 60_000 }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
 const initial = await request('runtime.snapshot');
 await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings?.revision ?? 0, operationId: randomUUID() });
 const project = await request('project.add', { path: work, name: 'Plan artifacts QA', operationId: randomUUID() });
 // `shell` with cmd.exe is the only launched terminal in this QA; it never starts an agent.
 session = await request('session.create', { projectId: project.id, cwd: work, title: 'Plan artifacts terminal', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/k'], operationId: randomUUID() });
 await showSession();
 await pinFromFileTab(); await pinFromExplorer(); await pinFromPicker();
 await openInspector();
 for (const title of ['Checkout plan', 'Payment research', 'notes.txt']) await plans().getByRole('listitem').locator('.session-document-label > b').getByText(title, { exact: true }).waitFor();
 await plans().locator('[data-path="docs/plan.md"] .session-document-open').click();
 // The opened tab is the editable editor (its Markdown preview copy stays hidden).
 await page.locator('.cm-line', { hasText: 'Keep the checkout path simple' }).first().waitFor();
 check('file tab, Explorer menu and Plans & docs picker pin the three fixture files; document rows use Markdown titles and open their editors');
 await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await showSession(); await openInspector();
 assert.equal((await request('session.documents.list', { sessionId: session.id })).length, 3, 'pins survive window reload');
 check('pinned documents survive a renderer reload');
 await unlink(join(work, 'notes.txt'));
 // Missing state is refreshed when the details block mounts; do not rely on a timer.
 const details = page.getByRole('button', { name: /^(Session details|会话详情面板)$/ }).first();
 await details.click(); await inspector().waitFor({ state: 'hidden' }); await details.click(); await openInspector();
 const missing = plans().locator('[data-path="notes.txt"] .session-document-missing'); await until(async () => await missing.isVisible(), 'missing file chip'); await shot('04-inspector-missing.png');
 await plans().getByRole('button', { name: /^Remove notes\.txt$/ }).click();
 await until(async () => !(await request('session.documents.list', { sessionId: session.id })).some(item => item.path === 'notes.txt'), 'unpin missing notes file');
 const checkpoint = await request('review.checkpoint', { sessionId: session.id, kind: 'manual', operationId: randomUUID() }); assert.ok(checkpoint.id, 'manual checkpoint created');
 await writeFile(join(work, 'docs/new-idea.md'), '# New idea\n\nA change after the checkpoint.\n');
 // Refresh by closing/reopening the inspector: suggestions are deliberately event/open driven, never polled.
 await details.click(); await inspector().waitFor({ state: 'hidden' }); await details.click(); await openInspector();
 const suggestionRow = plans().locator('[data-suggested-path="docs/new-idea.md"]'); await suggestionRow.waitFor(); await shot('05-inspector-pins-and-suggested.png');
 await suggestionRow.getByRole('button', { name: /^Add docs\/new-idea\.md$/ }).click();
 await until(async () => (await request('session.documents.list', { sessionId: session.id })).some(item => item.path === 'docs/new-idea.md'), 'pin suggested file');
 check('deleted pin becomes Missing and can be unpinned; a Markdown change after a manual checkpoint is suggested and pinnable');
 assert.deepEqual(report.errors, [], 'renderer emitted no console or page errors'); report.passed = true;
} catch (error) { await finalize(error); } finally { await finalize(); }
