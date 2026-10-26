// Idle-cost regression for the workbench (F16): an open Source Control side bar and an open Agent changes panel
// must make zero `git.*` / `review.*` requests while nothing happens (they used to poll every 5 s), and after a
// commit through the UI each of them refreshes exactly once instead of polling. Desktop1 + an isolated runtime,
// profile and Git repository; no provider CLI on PATH, so no real agent can start.
//   node qa/idle-workbench.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(!/\/runtime\/target\/(debug|release)\/threadterm-v3-runtime\.exe$/i.test(runtime.replaceAll('\\', '/')), 'never launch the user runtime build');
const out = process.env.THREADTERM_QA_OUTPUT_DIR || join(root, 'qa/results/idle-workbench-ac2');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must point to tt-qa-temp'); })());
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP must be tt-qa-temp');
const scratch = await mkdtemp(join(scratchBase, 'tt-idle-workbench-'));
const appDir = join(scratch, 'app'), bin = join(scratch, 'bin');
const repo = join(scratch, 'repo');
const IDLE_MS = 15_000;
const report = { passed: false, checks: [], idle: {}, refreshes: {}, notes: [], screenshots: [], errors: [] };
let app, page, releaseLock;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const counts = () => page.evaluate(() => window.threadtermQaCounts.snapshot());
const resetCounts = () => page.evaluate(() => window.threadtermQaCounts.reset());
const idleMethods = seen => Object.fromEntries(Object.entries(seen).filter(([method]) => /^(git\.|review\.)/.test(method)));
async function until(probe, label, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* retry until the deadline */ }
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await sleep(150);
  }
}
/** Git is a prerequisite of this harness (it needs a repository to commit into). It is detected, never
 * assumed: an explicit THREADTERM_TEST_GIT wins, otherwise the first `git` on PATH is resolved. */
function gitBinary() {
  const explicit = process.env.THREADTERM_TEST_GIT;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    return found && existsSync(found) ? found : undefined;
  } catch { return undefined; }
}
const gitExe = gitBinary();
const git = (args, cwd = repo) => new Promise((done, fail) => {
  const child = spawn(gitExe, ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done(stdout) : fail(Error(`git ${args.join(' ')}: ${stderr}`)));
});
function childEnv() {
  const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  Object.assign(value, {
    TEMP: scratchBase, TMP: scratchBase,
    // Only node, System32 and Git's own folder (which holds no agent CLI): the runtime must find Git, and no
    // real agent CLI can be discovered by accident.
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(systemRoot, 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-idle-workbench-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  });
  assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'exactly one PATH variable');
  return value;
}
function preloadWrapper() {
  return `import { contextBridge, ipcRenderer } from 'electron';
import '${join(root, 'desktop/src/preload.ts').replaceAll('\\', '/')}';
// Harness-only: count renderer→runtime requests instead of touching the product preload.
const counts = new Map<string, number>();
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = ((channel: string, ...args: unknown[]) => {
  if (channel === 'threadterm:request') { const method = String(args[0]); counts.set(method, (counts.get(method) ?? 0) + 1); }
  return invoke(channel, ...args);
}) as typeof ipcRenderer.invoke;
contextBridge.exposeInMainWorld('threadtermQaCounts', {
  snapshot: () => Object.fromEntries(counts),
  reset: () => counts.clear(),
});
`;
}
async function shot(name) {
  await page.mouse.move(0, 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'));
  const png = await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; const [width, height] = window.getContentSize(); return (await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true })).toPNG().toString('base64'); });
  await writeFile(join(out, name), Buffer.from(png, 'base64'));
  report.screenshots.push(name);
}
const rail = name => page.locator('.wb-switcher').getByRole('button', { name, exact: true });
async function openView(name) {
  if (await rail(name).getAttribute('aria-pressed') !== 'true') await rail(name).click();
  await page.locator('.wb-sidebar').waitFor();
}
async function applySettings(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(({ language, theme }) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme, { language, theme });
}
async function setContentSize(width, height) {
  if (width === 1440 && height === 900) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  else if (width === 900 && height === 720) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 720));
  else throw Error(`unsupported QA content size ${width}x${height}`);
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
}
async function assertAgentChangesHeader() {
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.wb-sidebar')?.getBoundingClientRect();
    const title = document.querySelector('.wb-panel-head strong');
    return { panelWidth: panel?.width, title: title?.textContent, titleFits: title ? title.scrollWidth <= title.clientWidth : false };
  });
  assert.ok(layout.panelWidth && Math.abs(layout.panelWidth - 280) <= 1, `the default side bar must be 280px: ${JSON.stringify(layout)}`);
  assert.equal(layout.title, 'Agent changes', `the Agent changes title must remain readable: ${JSON.stringify(layout)}`);
  assert.equal(layout.titleFits, true, `the Agent changes title must not be truncated: ${JSON.stringify(layout)}`);
}
async function assertSelectionAlignment() {
  const layout = await page.evaluate(() => {
    const group = document.querySelector('.wb-change-group[aria-label="Changes"]');
    const selectAll = group?.querySelector('.wb-group-head > .wb-change-select')?.getBoundingClientRect();
    const row = group?.querySelector('.wb-change-row .wb-change-select')?.getBoundingClientRect();
    return { selectAllLeft: selectAll?.left, rowLeft: row?.left };
  });
  assert.ok(layout.selectAllLeft !== undefined && layout.rowLeft !== undefined && Math.abs(layout.selectAllLeft - layout.rowLeft) <= 1, `the CHANGES select-all checkbox must align with file-row checkboxes: ${JSON.stringify(layout)}`);
}
async function idle(label) {
  await sleep(1500);
  await resetCounts();
  await sleep(IDLE_MS);
  const seen = await counts();
  const relevant = idleMethods(seen);
  report.idle[label] = { windowMs: IDLE_MS, methods: relevant, all: seen };
  console.log(`idle ${label}: git/review=${JSON.stringify(relevant)} all=${JSON.stringify(seen)}`);
  return relevant;
}

try {
  if (!gitExe) throw Error('This QA needs Git (PATH or THREADTERM_TEST_GIT) to build the repository it commits into.');
  assert.ok(existsSync(runtime), `missing ${runtime}`);
  await Promise.all([out, appDir, bin, repo, join(scratch, 'home')].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(scratch, 'preload-entry.ts'), preloadWrapper());
  await esbuild({ entryPoints: [join(root, 'desktop/src/main.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'main.cjs'), logLevel: 'error' });
  await esbuild({ entryPoints: [join(scratch, 'preload-entry.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'preload.cjs'), logLevel: 'error' });
  await viteBuild({ ...(process.env.THREADTERM_QA_RENDERER_ROOT ? { root: resolve(process.env.THREADTERM_QA_RENDERER_ROOT) } : {}), configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, minify: false } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'idle-workbench-qa', version: '0.1.0', main: 'main.cjs' }));

  // A real repository with one committed file and one edited file, so Source Control has a change to commit.
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'qa@example.test']);
  await git(['config', 'user.name', 'QA']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'notes.md'), '# notes\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'initial commit']);
  await writeFile(join(repo, 'notes.md'), '# notes\n\nedited by the QA harness\n');

  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: childEnv(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await until(() => page.evaluate(() => Boolean(window.threadtermQaCounts)), 'request counter');
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', themeSelection: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });

  const project = await request('project.add', { path: repo, name: 'Idle Workbench', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: repo, title: 'Idle workbench shell', provider: 'shell', mode: 'terminal', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  // The side bar asks Git about the session's own worktree root, so the harness uses the same value.
  const worktree = (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.worktreePath;
  const scope = { projectId: project.id, ...(worktree ? { worktreePath: worktree } : {}) };
  report.notes.push(`session worktree ${JSON.stringify(worktree)}`);
  await page.locator('.xterm').first().waitFor();
  await page.locator('.wb-switcher').waitFor();
  assert.equal(await page.locator('.wb-sidebar').count(), 0, 'the side bar starts closed');

  // Source Control: the panel is visible with a real change present, and opening it reads the status once.
  await resetCounts();
  await openView('Source Control');
  await page.locator('.wb-scm .wb-change-group', { hasText: 'notes.md' }).waitFor();
  await sleep(1500);
  const opened = idleMethods(await counts());
  report.refreshes.open = opened;
  assert.equal(opened['git.status'], 1, `opening Source Control must read the status exactly once: ${JSON.stringify(opened)}`);
  check('opening Source Control reads the Git status exactly once');
  const scm = await idle('source-control-open');
  assert.deepEqual(scm, {}, `an open Source Control panel must not poll: ${JSON.stringify(scm)}`);
  check(`Source Control with a pending change makes zero git.*/review.* requests in ${IDLE_MS} ms`);
  await assertSelectionAlignment();
  await shot('en-light-source-control.png');

  // Agent changes: mounting and switching views refreshes once, then nothing.
  await openView('Agent changes');
  await page.locator('.wb-review').waitFor();
  await until(async () => ((await counts())['review.list'] ?? 0) >= 1, 'agent changes loads when it opens');
  const changes = await idle('agent-changes-open');
  assert.deepEqual(changes, {}, `an open Agent changes panel must not poll: ${JSON.stringify(changes)}`);
  check(`Agent changes makes zero git.*/review.* requests in ${IDLE_MS} ms while idle`);
  await assertAgentChangesHeader();
  check('the default 280px Workbench header keeps Agent changes readable and aligns CHANGES select-all with file rows');
  await shot('en-light-agent-changes.png');

  // A commit through the Source Control UI costs exactly one status refresh, and none of it repeated.
  await openView('Source Control');
  await sleep(1200);
  await page.getByRole('textbox', { name: 'Commit message' }).fill('QA: idle workbench commit');
  await page.locator('.wb-change-group[aria-label="Changes"]').getByRole('button', { name: 'Stage all changes' }).click();
  await page.locator('.wb-change-group[aria-label="Staged changes"]').waitFor();
  // Staging is its own change with its own single refresh; the commit is measured on its own.
  await sleep(1500);
  await resetCounts();
  await page.locator('.wb-commit').getByRole('button', { name: /^Commit all/ }).click();
  await page.locator('.wb-scm .wb-empty').waitFor();
  await sleep(1500);
  const commit = idleMethods(await counts());
  report.refreshes.commit = commit;
  console.log(`commit refresh: ${JSON.stringify(commit)}`);
  const reads = Object.fromEntries(Object.entries(commit).filter(([method]) => method !== 'git.commit'));
  assert.deepEqual(reads, { 'git.status': 1 }, `one commit must refresh the status exactly once and read nothing else: ${JSON.stringify(commit)}`);
  check('a commit through the UI refreshes the Source Control status exactly once');
  assert.equal((await git(['log', '-1', '--format=%s'])).trim(), 'QA: idle workbench commit', 'the commit reached the repository');
  await shot('en-light-source-control-committed.png');

  // The Agent-changes panel refreshes once for a commit made while it is open (the same runtime event).
  await openView('Agent changes');
  await sleep(1200);
  await writeFile(join(repo, 'notes.md'), '# notes\n\nedited again\n');
  await request('git.stage', { ...scope, paths: ['notes.md'], operationId: randomUUID() });
  await sleep(1500);
  await resetCounts();
  await request('git.commit', { ...scope, message: 'QA: event-driven refresh', operationId: randomUUID() });
  await until(async () => ((await counts())['review.list'] ?? 0) >= 1, 'agent changes refreshes for a commit event');
  await sleep(1500);
  const reviewed = idleMethods(await counts());
  report.refreshes.agentChanges = reviewed;
  console.log(`agent changes refresh: ${JSON.stringify(reviewed)}`);
  assert.equal(reviewed['review.list'], 1, `one commit must refresh the review list exactly once: ${JSON.stringify(reviewed)}`);
  check('a commit while Agent changes is open refreshes its review list exactly once');
  const final = await idle('both-visited');
  assert.deepEqual(final, {}, `both panels visited and idle must stay quiet: ${JSON.stringify(final)}`);
  check('with both panels visited, an idle workbench makes zero git.*/review.* requests again');

  // Capture each locale/theme at the wide width, then use the actual window width after requesting a narrow size.
  for (const [language, theme, scmName, changesName, prefix] of [
    ['en', 'light', 'Source Control', 'Agent changes', 'en-light'],
    ['en', 'dark', 'Source Control', 'Agent changes', 'en-dark'],
    ['zh-CN', 'light', '源代码管理', 'Agent 改动', 'zh-light'],
    ['zh-CN', 'dark', '源代码管理', 'Agent 改动', 'zh-dark'],
  ]) {
    await applySettings(language, theme);
    await setContentSize(1440, 900);
    await openView(changesName);
    await shot(`${prefix}-wide-agent-changes.png`);
    const [narrowWidth] = await setContentSize(900, 720);
    assert.ok(narrowWidth < 1440, `the narrow capture must use the real narrower window width: ${narrowWidth}`);
    report.notes.push(`${prefix} narrow content width ${narrowWidth}px`);
    await openView(scmName);
    await shot(`${prefix}-narrow-source-control.png`);
  }
  check('captured Source Control and Agent changes in English/Chinese, light/dark, wide and real narrow windows');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await shot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  if (releaseLock) await releaseLock().catch(() => {});
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  if (report.errors.length) report.passed = false;
  console.log(report.passed ? 'IDLE WORKBENCH QA PASSED' : `IDLE WORKBENCH QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
