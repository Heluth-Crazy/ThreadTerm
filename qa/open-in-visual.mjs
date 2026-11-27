// "Open in" and quick copy (owner 2026-11-26: 「以某个软件快速打开这个文件或者路径」「某些内容可以方便快捷的复制」).
// The real desktop app and debug runtime on an isolated profile with one Git project. THREADTERM_V3_OPEN_IN_QA makes
// main offer this Electron as "VS Code" and record each launch (program, arguments, folder) instead of starting it.
// Checks the project page's Open button and its menu, hover copy of the branch and path, the sidebar ⋯ menu, the
// Explorer's copy items, and a file opened at the cursor's line. Screenshots go to qa/results/open-in/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { openCatalogPage } from './catalog-page.mjs';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? (() => { throw new Error('TEMP must point at a scratch directory'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/open-in');
const scratch = await mkdtemp(join(base, 'tt-open-in-'));
const record = join(scratch, 'open-in.jsonl');
const gitExe = process.env.THREADTERM_TEST_GIT && existsSync(process.env.THREADTERM_TEST_GIT) ? process.env.THREADTERM_TEST_GIT
  : spawnSync('where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(line => line.endsWith('git.exe')) ?? 'git';
const report = { passed: false, checks: [], errors: [], launches: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, qaApp;
const launches = () => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(probe, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await probe(); if (value) return value; } catch { /* not yet */ } if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await delay(120); }
}
const git = (cwd, ...args) => { const run = spawnSync(gitExe, args, { cwd, encoding: 'utf8', windowsHide: true }); if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`); };

function environment() {
  const blocked = ['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_qa_provider_bin', 'threadterm_v3_open_in_qa'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.includes(key.toLowerCase())));
  return Object.assign(env, {
    PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), TEMP: base, TMP: base,
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'), THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-open-in-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_PROVIDER_BIN: join(scratch, 'provider-bin'), THREADTERM_V3_OPEN_IN_QA: record,
  });
}

try {
  assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const work = join(scratch, 'repo');
  await mkdir(join(scratch, 'provider-bin'), { recursive: true });
  git(scratch, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'user.name', 'QA'); git(work, 'config', 'user.email', 'qa@example.invalid');
  await writeFile(join(work, 'notes.txt'), 'one\ntwo\nthree\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init');

  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(1280, 820); });
  // What the page writes to the clipboard, recorded in the page: the OS clipboard is unreachable on a locked PC (main
  // reads it back empty even after a write that resolved), and desktop1 never focuses a QA window.
  await page.evaluate(() => { window.__qaCopied = []; navigator.clipboard.writeText = async text => { window.__qaCopied.push(text); }; });
  const clipboard = () => page.evaluate(() => window.__qaCopied.at(-1) ?? '');
  const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'zh-CN', notifications: { native: false, attention: false, completed: false, sound: false, island: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'));
  await request('project.add', { path: work, name: 'Open QA', operationId: randomUUID() });
  const row = page.locator('.proj-row', { hasText: 'Open QA' }).first();
  await row.waitFor();
  const canonical = (await request('runtime.snapshot')).projects.find(project => project.name === 'Open QA').path;
  check('isolated app with one Git project; main offers this Electron as VS Code');

  // 1. The project page: Open goes to the editor; its menu lists the editors.
  await openCatalogPage(row);
  await page.getByTestId('project-home').waitFor();
  const open = page.locator('.open-in .open-in-main');
  await open.waitFor();
  assert.equal(await open.getAttribute('aria-label'), '在 VS Code 中打开');
  assert.equal(await page.locator('.open-in .open-in-icon').count(), 1, "the editor's own icon is shown");
  await open.click();
  const first = await until(() => launches()[0], 'the project opens in the editor');
  assert.equal(first.exe.toLowerCase(), (await app.evaluate(() => process.execPath)).toLowerCase(), 'the program found by main');
  assert.equal(first.args.length, 1, 'a folder opens as a workspace');
  assert.equal(first.args[0].toLowerCase(), canonical.toLowerCase(), 'the project root, from the runtime record');
  await page.locator('.open-in .open-in-more').click();
  const menuItem = page.getByRole('menuitem', { name: '在 VS Code 中打开' });
  await menuItem.waitFor();
  await page.screenshot({ path: join(out, '01-project-open-in.png') });
  await page.keyboard.press('Escape');
  check('the project page opens the project in VS Code; the arrow lists the editors with their icons');

  // 2. Hover copy on the project page: its path.
  const sub = page.locator('.ov-page-head .page-sub');
  await sub.hover();
  await sub.getByRole('button', { name: '复制路径' }).click();
  await until(async () => (await clipboard()).toLowerCase().includes('repo'), 'the path is copied');
  await page.screenshot({ path: join(out, '02-hover-copy.png'), clip: { x: 0, y: 0, width: 1280, height: 120 } });
  check('hovering the path shows a copy button that copies it');

  // 3. The sidebar ⋯ menu offers the editor too.
  const wrap = row.locator('xpath=..');
  await wrap.hover(); await wrap.locator('.row-more').click();
  const popover = page.locator('.catalogue-popover');
  await popover.getByRole('menuitem', { name: '在 VS Code 中打开' }).waitFor();
  await page.screenshot({ path: join(out, '03-sidebar-menu.png') });
  const before = launches().length;
  await popover.getByRole('menuitem', { name: '在 VS Code 中打开' }).click();
  await until(() => launches().length > before, 'the sidebar opens the project');
  check('the sidebar ⋯ menu opens the project in VS Code');

  // 3b. The branch page: hovering the branch name copies it.
  await openCatalogPage(page.locator('.tree-row', { hasText: 'main' }).first());
  const title = page.locator('.ov-title-row');
  await until(async () => (await title.locator('h1').innerText()).trim() === 'main', 'the branch page is open');
  await title.hover();
  await title.getByRole('button', { name: '复制分支名' }).click();
  assert.equal(await until(async () => (await clipboard()) === 'main' && 'main', 'the branch is copied'), 'main');
  check('hovering the branch name shows a copy button that copies it');
  await openCatalogPage(row);
  await page.getByTestId('project-home').waitFor();

  // 4. Files: the Explorer copies the path and the name; the file bar opens the file at the cursor's line.
  await page.getByRole('button', { name: '项目操作', exact: true }).click();
  await page.locator('.project-tools-menu').getByRole('button', { name: '浏览文件', exact: true }).click();
  const tree = page.locator('.tt-file-tree .wb-tree');
  const fileRow = tree.locator('[role=treeitem]', { hasText: 'notes.txt' });
  await fileRow.waitFor();
  await fileRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制文件名' }).click();
  assert.equal(await until(async () => (await clipboard()) === 'notes.txt' && 'notes.txt', 'the name is copied'), 'notes.txt');
  await fileRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制路径', exact: true }).click();
  await until(async () => (await clipboard()).toLowerCase().endsWith('\\notes.txt'), 'the full path is copied');
  check('the Explorer copies a file\'s full path and its name');
  await fileRow.click();
  const editor = page.locator('.tt-editor-shell .cm-content');
  await editor.waitFor();
  await editor.locator('.cm-line', { hasText: 'two' }).click();
  const more = page.locator('.file-bar-more, button[aria-label="工作区操作"]').first();
  await more.click();
  const fileOpen = page.getByRole('menuitem', { name: '在 VS Code 中打开' });
  await fileOpen.waitFor();
  await page.screenshot({ path: join(out, '04-file-menu.png') });
  const count = launches().length;
  await fileOpen.click();
  const fileLaunch = await until(() => launches()[count], 'the file opens in the editor');
  assert.equal(fileLaunch.args[0], '--goto');
  assert.match(fileLaunch.args[1], /notes\.txt:2$/i, 'at the line the cursor is on');
  check(`the file bar opens the file at the cursor's line: ${fileLaunch.args.join(' ')}`);

  report.launches = launches();
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (app) await Promise.race([app.close(), delay(20_000)]).catch(() => {});
  await releaseLock?.().catch(() => {});
  await qaApp?.cleanup?.().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(report.passed ? 'OPEN-IN VISUAL QA PASSED' : 'OPEN-IN VISUAL QA FAILED');
}
