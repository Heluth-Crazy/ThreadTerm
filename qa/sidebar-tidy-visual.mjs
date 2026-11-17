// Sidebar tidy QA: the real desktop app, the debug runtime and a Git fixture with linked worktrees.
// One computer only, so the branch chevrons are the tidy sidebar's own fold state (not the machine tree).
// Screenshots go to qa/results/sidebar-tidy/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? (() => { throw new Error('TEMP must point at a scratch directory'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/sidebar-tidy');
const scratch = await mkdtemp(join(base, 'tt-sidebar-tidy-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins');
const repo = join(scratch, 'tidy-repo');
const worktrees = {
  alpha: join(scratch, 'tidy-alpha'), theta: join(scratch, 'tidy-theta'), beta: join(scratch, 'tidy-beta'),
  gamma: join(scratch, 'tidy-gamma'), delta: join(scratch, 'tidy-delta'), epsilon: join(scratch, 'tidy-epsilon'),
  detached: join(scratch, 'tidy-detached'), missing: join(scratch, 'tidy-missing'),
};
const data = join(scratch, 'data'), profile = join(scratch, 'profile'), pipe = `\\\\.\\pipe\\tt-sidebar-tidy-${randomUUID()}`;
const report = { passed: false, checks: [], errors: [], screenshots: [], measurements: {} };
let app, page, releaseLock, qaApp;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const settle = () => delay(250);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* the runtime is still catching up */ }
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(125);
  }
}
const shot = async (target, name) => { await delay(200); await target.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); };
const settings = async patch => {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
};
const snapshot = () => request('runtime.snapshot');
const sessionStatus = async id => (await snapshot()).sessions.find(row => row.id === id)?.status;

function gitDirectory() {
  const explicit = process.env.THREADTERM_TEST_GIT;
  if (explicit && existsSync(explicit)) return dirname(explicit);
  for (const directory of (process.env.PATH ?? '').split(';')) if (directory && existsSync(join(directory, 'git.exe'))) return directory;
  return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd');
}
function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_runtime_bin'].includes(key.toLowerCase())));
  const git = gitDirectory();
  return Object.assign(env, {
    TEMP: base, TMP: base, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), git].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_ECHO_STORE_DIR: join(scratch, 'echo-store'),
  });
}
const git = process.env.THREADTERM_TEST_GIT && existsSync(process.env.THREADTERM_TEST_GIT) ? process.env.THREADTERM_TEST_GIT : join(gitDirectory(), 'git.exe');
const runGit = (...args) => execFileSync(git, ['-C', repo, ...args], { timeout: 60_000, stdio: 'pipe' });

try {
  assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
  assert.ok(existsSync(join(root, 'qa/fixtures/prompt-queue-echo-acp/threadterm-plugin.json')), 'missing the Prompt Queue Echo fixture');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(repo, { recursive: true })]);
  cpSync(join(root, 'qa/fixtures/prompt-queue-echo-acp'), join(plugins, 'prompt-queue-echo-acp'), { recursive: true });

  // A Git project with main and linked worktrees. The missing one is created, listed once and then removed with Git,
  // so the runtime keeps its row with missing:true.
  execFileSync(git, ['init', '-q', '-b', 'main', repo], { timeout: 60_000 });
  runGit('config', 'user.email', 'qa@threadterm.invalid');
  runGit('config', 'user.name', 'ThreadTerm QA');
  await writeFile(join(repo, 'README.md'), 'tidy sidebar fixture\n');
  runGit('add', 'README.md');
  runGit('commit', '-q', '-m', 'fixture base');
  for (const [name, branch] of [['alpha', 'feat/alpha'], ['theta', 'feat/theta'], ['beta', 'feat/beta'], ['gamma', 'feat/gamma'], ['delta', 'feat/delta'], ['epsilon', 'feat/epsilon'], ['missing', 'feat/zeta']]) {
    runGit('worktree', 'add', '-q', '-b', branch, worktrees[name]);
  }
  runGit('worktree', 'add', '--detach', '-q', worktrees.detached);
  check('fixture: Git project with main, five listed branches, two empty branches, a detached folder and a worktree to delete');

  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  const electronLog = createWriteStream(join(base, 'sidebar-tidy-electron.log'));
  app.process().stdout?.pipe(electronLog); app.process().stderr?.pipe(electronLog);
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await settings({ language: 'zh-CN', theme: 'light' });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  check('isolated app launched at 1440x900 in Chinese, light theme');

  await until(async () => (await request('plugin.list')).plugins.find(plugin => plugin.id === 'prompt-queue-echo-acp'), 'the fixture is discovered');
  await request('plugin.setEnabled', { pluginId: 'prompt-queue-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).find(item => item.id === 'queue-echo' && item.chat), 'Queue Echo is enabled');

  const project = await request('project.add', { path: repo, name: 'tidy-repo', operationId: randomUUID() });
  const listed = await until(async () => { const rows = await request('worktree.list', { projectId: project.id }); return rows.length >= 9 ? rows : undefined; }, 'nine worktrees are listed');
  assert.equal(listed.some(tree => tree.missing), false, 'every worktree exists on the first listing');
  // The runtime keeps the worktree row after Git removes the folder, so the next listing reports missing:true.
  runGit('worktree', 'remove', '--force', worktrees.missing);
  assert.equal(existsSync(worktrees.missing), false, 'the removed worktree path is gone');
  const trees = await until(async () => { const rows = await request('worktree.list', { projectId: project.id }); return rows.some(tree => tree.missing) ? rows : undefined; }, 'the deleted worktree stays listed as missing');
  report.measurements.worktrees = trees.map(tree => ({ branch: tree.branch, path: tree.path, missing: tree.missing, isMain: tree.isMain }));
  // The runtime may hold the deleted folder twice (Git listed it under its own path spelling while the folder was
  // going); the sidebar lists it once, which the other-branches check below asserts.
  report.measurements.missingRows = trees.filter(tree => tree.missing).length;
  assert.ok(report.measurements.missingRows >= 1, 'the deleted worktree stays listed as missing');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');

  const createShell = async (cwd, title) => {
    const session = await request('session.create', { cwd, projectId: project.id, title, provider: 'shell', mode: 'terminal', operationId: randomUUID() });
    await until(async () => ['running', 'idle', 'starting'].includes(await sessionStatus(session.id)), `shell ${title} starts`);
    return session;
  };
  const stop = async session => {
    await request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() });
    await until(async () => ['exited', 'error', 'interrupted'].includes(await sessionStatus(session.id)), `shell ${session.title} ends`);
  };
  const createChat = async (cwd, title, text) => {
    const session = await request('session.create', { cwd, projectId: project.id, title, provider: 'queue-echo', mode: 'chat', operationId: randomUUID() });
    const { leaseEpoch } = await request('session.claim', { sessionId: session.id, clientId: 'sidebar-tidy-qa' });
    const connected = await request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() });
    assert.equal(connected.phase, 'ready', `chat ${title} connects`);
    await request('chat.send', { sessionId: session.id, text, leaseEpoch, operationId: randomUUID() });
    return session;
  };

  // Seven sessions on main, oldest to newest, then all ended so main has no pinned row.
  const mainSessions = [];
  for (let index = 1; index <= 7; index++) {
    mainSessions.push(await createShell(repo, `main ${index}`));
    await delay(120);
  }
  await Promise.all(mainSessions.map(stop));
  const alpha = await createShell(worktrees.alpha, 'alpha session');
  await stop(alpha);
  const thetaOne = await createShell(worktrees.theta, 'theta one');
  await stop(thetaOne);
  const thetaTwo = await createShell(worktrees.theta, 'theta two');
  await stop(thetaTwo);
  const beta = await createChat(worktrees.beta, 'beta approval', 'approval please');
  await until(async () => (await sessionStatus(beta.id)) === 'waiting', 'beta waits for approval');
  const gamma = await createChat(worktrees.gamma, 'gamma running', 'slow:120000 running turn');
  await until(async () => (await sessionStatus(gamma.id)) === 'running', 'gamma runs');
  check('sessions: 7 ended on main, ended sessions on alpha/theta, beta waits, gamma runs');

  // Select alpha before the tree checks, so the persistent selection never points at a folded branch.
  await request('session.present', { sessionId: alpha.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const projectScope = () => page.locator('.proj-group').first();
  const branchGroup = name => page.locator('.catalog-tree-group').filter({ hasText: name }).first();
  const branchChevron = name => branchGroup(name).locator('.tree-row-wrap > .proj-disclosure');
  const branchRows = () => projectScope().locator('.tree-list .tree-row');
  const sessionRows = name => branchGroup(name).locator('.sess-row-wrap[data-session-id]');
  await projectScope().waitFor();
  await until(async () => (await branchRows().count()) >= 5, 'the one-PC branch rows are visible');
  check('branch chevrons exist on one computer');

  // Header: label + Projects/Recent control + the existing ⋯ menu opener with exactly one icon.
  const head = page.locator('.catalog-head');
  assert.equal(await head.locator('.side-scope').count(), 1);
  assert.equal(await head.locator('.side-scope .ico').count(), 1);
  assert.equal(await head.locator('.side-scope').getAttribute('aria-label'), '项目范围');
  assert.equal(await head.locator('.catalog-view-seg button').count(), 2);
  check('header keeps one ⋯ control and adds the Projects/Recent control');

  // R4/R3: main first, then newest session, and the other four branches fold away.
  const order = (await branchRows().allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim());
  report.measurements.branchOrder = order;
  assert.match(order[0], /main/);
  assert.match(order[1], /gamma/);
  assert.match(order[2], /beta/);
  assert.match(order[3], /theta/);
  assert.match(order[4], /alpha/);
  const other = projectScope().locator('.other-fold-row');
  await other.waitFor();
  assert.match(await other.innerText(), /其他 4 个分支/);
  await other.click();
  const otherNames = (await projectScope().locator('.other-fold-row ~ .catalog-tree-group .tree-row').allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim());
  report.measurements.otherBranches = otherNames;
  assert.equal(otherNames.length, 4, 'other branches hold exactly four worktrees');
  const otherText = otherNames.join('|').replace(/\s+/g, '');
  for (const name of ['delta', 'epsilon', 'tidy-detached', 'feat/zeta']) assert.ok(otherText.includes(name), `other branches hold ${name}`);
  assert.ok(!/gamma|beta|theta|alpha/.test(otherText), 'live and used branches never fold into other branches');
  const missingRow = projectScope().locator('.tree-list .tree-row.gone').filter({ hasText: 'zeta' });
  assert.equal(await missingRow.count(), 1, 'the deleted worktree keeps its row');
  assert.match(await missingRow.innerText(), /已删除/);
  check('main is first, branches follow newest session, and other branches hold the empty/detached/deleted worktrees');

  // R5/R6: main shows three newest ended sessions and folds the four older ones.
  assert.equal(await sessionRows('main').count(), 3, 'main shows the 3 newest sessions');
  const older = branchGroup('main').locator('.older-fold-row');
  assert.match(await older.innerText(), /更早的 4 个会话/);
  await older.click();
  await until(async () => (await sessionRows('main').count()) === 7, 'opening older sessions shows all seven');
  assert.match(await branchGroup('main').locator('.older-fold-row').innerText(), /收起较早的会话/);
  await branchGroup('main').locator('.older-fold-row').click();
  check('main shows pinned + 3 newest and "更早的 4 个会话"; opening it shows all seven');

  // R1: a folded branch keeps an amber needs count or a green running spinner.
  await branchChevron('beta').click();
  await until(async () => (await branchChevron('beta').getAttribute('aria-expanded')) === 'false', 'beta folds');
  assert.equal((await branchGroup('beta').locator('.badge.amber').textContent())?.trim(), '1');
  await branchChevron('gamma').click();
  await until(async () => (await branchChevron('gamma').getAttribute('aria-expanded')) === 'false', 'gamma folds');
  assert.equal(await branchGroup('gamma').locator('.fold-spin').count(), 1);
  check('a folded branch shows the amber count and the running spinner');

  // R1 persistence: a branch fold and the Recent choice survive a reload.
  await page.locator('.catalog-view-seg [data-view="recent"]').click();
  await page.locator('.catalog-recent-list').waitFor();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await until(async () => (await page.locator('.catalog-view-seg [data-view="recent"]').getAttribute('class'))?.includes('on'), 'Recent stays selected after reload');
  await page.locator('.catalog-view-seg [data-view="tree"]').click();
  await projectScope().waitFor();
  await until(async () => (await branchChevron('gamma').getAttribute('aria-expanded')) === 'false', 'the folded branch stays folded after reload');
  await branchChevron('gamma').click();
  await branchChevron('beta').click();
  await request('session.present', { sessionId: alpha.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await branchChevron('alpha').getAttribute('aria-expanded')) === 'true', 'alpha is the current branch again');
  check('branch folds and the Recent/Projects choice survive page.reload()');

  // R8/R1: the menu collapses, expands and keeps only the current branch unfolded.
  await page.locator('.side-scope').click();
  const menu = page.locator('.catalogue-popover');
  await menu.waitFor();
  const items = await menu.getByRole('menuitem').allInnerTexts();
  for (const expected of ['添加项目', '全部项目', '全部收起', '只展开当前', '全部展开']) assert.ok(items.some(text => text.includes(expected)), `menu keeps ${expected}`);
  await menu.getByRole('menuitem', { name: '全部收起' }).click();
  await until(async () => (await projectScope().locator('.tree-list').count()) === 0, 'Collapse all folds every project');
  await page.locator('.side-scope').click();
  await page.locator('.catalogue-popover').getByRole('menuitem', { name: '全部展开' }).click();
  // Expand all opens projects, branches and parents; the "other branches" and "older sessions" folds keep their state.
  const otherFold = () => page.locator('.other-fold-row');
  const otherOpenBefore = await otherFold().getAttribute('aria-expanded');
  await until(async () => (await projectScope().locator('.tree-list').count()) === 1
    && (await page.locator('.catalog-tree-group > .tree-row-wrap > .proj-disclosure[aria-expanded="false"]').count()) === 0, 'Expand all opens every listed branch');
  assert.equal(await otherFold().getAttribute('aria-expanded'), otherOpenBefore, 'Expand all leaves the other-branches fold as it was');
  await page.locator('.side-scope').click();
  await page.locator('.catalogue-popover').getByRole('menuitem', { name: '只展开当前' }).click();
  await until(async () => (await page.locator('.catalog-tree-group > .tree-row-wrap > .proj-disclosure[aria-expanded="true"]').count()) === 1, 'only the current branch stays expanded');
  assert.equal(await branchChevron('alpha').getAttribute('aria-expanded'), 'true');
  check('menu 全部收起 / 全部展开 / 只展开当前 work');

  // Alt+click folds every sibling branch, then opens them again.
  await page.locator('.side-scope').click();
  await page.locator('.catalogue-popover').getByRole('menuitem', { name: '全部展开' }).click();
  await until(async () => (await page.locator('.catalog-tree-group > .tree-row-wrap > .proj-disclosure[aria-expanded="false"]').count()) === 0, 'all listed branches are open again');
  await branchChevron('main').click({ modifiers: ['Alt'] });
  await until(async () => (await page.locator('.catalog-tree-group > .tree-row-wrap > .proj-disclosure[aria-expanded="true"]').count()) === 0, 'Alt+click folds all siblings');
  await branchChevron('main').click({ modifiers: ['Alt'] });
  await until(async () => (await page.locator('.catalog-tree-group > .tree-row-wrap > .proj-disclosure[aria-expanded="false"]').count()) === 0, 'Alt+click opens all siblings');
  check('Alt+click folds and unfolds every branch sibling');

  // R9: selecting a session inside a folded branch unfolds it.
  await branchChevron('alpha').click();
  await until(async () => (await branchChevron('alpha').getAttribute('aria-expanded')) === 'false', 'alpha folds before selection');
  await request('session.present', { sessionId: thetaOne.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await page.locator('.sess-row.active[data-session-id]').first().getAttribute('data-session-id')) === thetaOne.id, 'theta becomes the selected session');
  assert.equal(await branchChevron('alpha').getAttribute('aria-expanded'), 'false', 'selecting another branch leaves alpha folded');
  await request('session.present', { sessionId: alpha.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await branchChevron('alpha').getAttribute('aria-expanded')) === 'true', 'the newly selected session unfolds its branch');
  assert.equal(await branchGroup('alpha').locator(`.sess-row-wrap[data-session-id="${alpha.id}"]`).count(), 1);
  check('selecting a session inside a folded branch unfolds it and shows the row');

  // Screenshots: light/dark tree, folded summaries, other branches, Recent.
  await shot(page, '01-tree-light.png');
  await settings({ theme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await shot(page, '02-tree-dark.png');
  await settings({ theme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme !== 'dark');
  await branchChevron('beta').click();
  await branchChevron('gamma').click();
  await shot(page, '03-folded-summary-light.png');
  await page.locator('.side-scope').click();
  await page.locator('.catalogue-popover').waitFor();
  await shot(page, '04-menu-light.png');
  await page.keyboard.press('Escape');
  if ((await projectScope().locator('.other-fold-row').getAttribute('aria-expanded')) !== 'true') await projectScope().locator('.other-fold-row').click();
  await shot(page, '05-other-branches-light.png');

  // R7: Recent rows, a day header, "project · branch", and a click opens the session.
  await page.locator('.catalog-view-seg [data-view="recent"]').click();
  await until(async () => (await page.locator('.catalog-recent-row').count()) > 0, 'Recent lists sessions');
  assert.ok((await page.locator('.catalog-recent-day').count()) >= 1, 'Recent has a day header');
  const firstWhere = (await page.locator('.catalog-recent-row .catalog-recent-where').first().innerText()).trim();
  assert.match(firstWhere, /tidy-repo · /);
  report.measurements.recentWhere = firstWhere;
  const firstRecent = page.locator('.catalog-recent-row').first();
  await firstRecent.click();
  await until(async () => (await page.locator('.catalog-recent-row.active').count()) === 1, 'clicking a Recent row opens and highlights it');
  await shot(page, '06-recent-light.png');
  await settings({ theme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await shot(page, '07-recent-dark.png');
  await settings({ theme: 'light' });
  check('Recent shows day headers, project · branch and opens the clicked session');

  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error);
  process.exitCode = 1;
  await Promise.race([page?.screenshot({ path: join(out, 'failure.png') }), delay(5000)]).catch(() => {});
} finally {
  if (app) await Promise.race([app.close(), delay(20_000)]).catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  await releaseLock?.().catch(() => {});
  await qaApp?.cleanup?.().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
