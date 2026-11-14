// Track G captures: the real app's Start, Source Control, Git review, editor and history screens in zh-CN/en and
// light/dark, next to the same prototype screens (prototypes/mac-style, Look: Flush). Isolated runtime, data and
// profile; read-only against the fixture repo apart from the fixture edits it makes before launching.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must point to tt-qa-temp'); })());
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP is the approved QA scratch root');
assert.ok(existsSync(runtime), `missing ${runtime}`);
const scratch = await mkdtemp(join(scratchBase, 'tt-git-editor-'));
const workspace = join(scratch, 'workspace'), bin = join(scratch, 'bin'), out = join(root, 'qa/results/git-editor');
const screens = (process.env.TT_G_SCREENS ?? 'start,scm,review,editor,history').split(',').filter(Boolean);
const delay = ms => new Promise(done => setTimeout(done, ms));
let app, page, releaseLock, cleanup, browser;
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const report = { screenshots: [], measurements: {}, errors: [] };

function git(...args) { const result = spawnSync(process.env.THREADTERM_TEST_GIT ?? 'git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`); return result.stdout; }
function environment() {
  const dropped = /^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const gitExe = process.env.THREADTERM_TEST_GIT ?? spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean) ?? 'git';
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    TEMP: scratchBase, TMP: scratchBase, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-git-editor-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_QA_PROVIDER_BIN: bin,
  });
  return env;
}
async function until(probe, text, timeout = 30_000) { const end = Date.now() + timeout; let error; while (Date.now() < end) { try { if (await probe()) return; } catch (next) { error = next; } await delay(120); } throw Error(`Timed out: ${text}${error ? `: ${error.message}` : ''}`); }
async function setAppearance(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(([lang, nextTheme]) => document.documentElement.lang === lang && document.documentElement.dataset.theme === nextTheme, [language, theme]);
  await page.mouse.move(0, 0); await delay(200);
}
async function shot(target, name) { await target.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function prototype(screen, theme, name, locator = '.win') {
  const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await proto.goto(`file:///${join(root, 'prototypes/mac-style/index.html').replaceAll('\\', '/')}?screen=${screen}&palette=mac&style=flush&theme=${theme}`);
    const node = proto.locator(locator).first(); await node.waitFor();
    await shot(node, name);
  } finally { await proto.close(); }
}
async function openView(name) { const button = page.locator('.wb-switcher:visible').getByRole('button', { name, exact: true }); if (await button.count()) { if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); } else await page.keyboard.press(name === 'Source Control' ? 'Control+Shift+g' : 'Control+Shift+e'); }

try {
  await Promise.all([mkdir(join(workspace, 'renderer/src/components'), { recursive: true }), mkdir(bin, { recursive: true }), mkdir(out, { recursive: true }), mkdir(join(scratch, 'home', '.codex'), { recursive: true })]);
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\necho codex 1.0.0-qa\r\n');
  await writeFile(join(workspace, 'renderer/src/components/SheetView.tsx'), ['export function SheetView({ sheet }: Props) {', '  const cells = layoutCells(sheet);', '  return cells.map(cell => {', '    const style = { gridColumn: `span ${cell.span}` };', '    return <Cell key={cell.id} style={style} />;', '  });', '}', ''].join('\n'));
  await writeFile(join(workspace, 'renderer/src/components/sheet-view.css'), ['.sheet-cell[data-merged] {', '  position: relative;', '}', ''].join('\n'));
  await writeFile(join(workspace, 'README.md'), '# Track G\n\nFixture for the Cursor-referenced surfaces.\n');
  git('init', '-q', '-b', 'office-preview'); git('config', 'user.name', 'ThreadTerm QA'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'core.autocrlf', 'false');
  git('add', '.'); git('commit', '-qm', 'baseline');
  await writeFile(join(workspace, 'renderer/src/components/SheetView.tsx'), ['export function SheetView({ sheet }: Props) {', '  const cells = layoutCells(sheet);', '  const frozen = useFrozenColumns(sheet);', '  return cells.map(cell => {', '    const style = { gridColumn: `span ${cell.span}`, left: freezeX(cell, frozen) };', '    if (cell.merged && crossesFreeze(cell, frozen)) style.clipPath = clipAtFreeze(cell, frozen);', '    return <Cell key={cell.id} style={style} />;', '  });', '}', ''].join('\n'));
  await writeFile(join(workspace, 'renderer/src/components/sheet-view.css'), ['.sheet-cell[data-merged] {', '  position: sticky;', '  left: var(--freeze-x, 0);', '}', ''].join('\n'));
  await writeFile(join(workspace, 'renderer/src/sheetMerge.test.ts'), ['import { crossesFreeze } from "./sheetMerge";', 'test("crosses", () => expect(crossesFreeze(cell, frozen)).toBe(true));', ''].join('\n'));
  ({ cleanup } = await buildQaApp({ root, outDir: join(scratch, 'qa-app') }));
  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', join(scratch, 'qa-app')], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60_000 });
  await until(async () => (await request('provider.list', {})).some(row => row.id === 'codex' && row.installed), 'codex provider');
  const project = await request('project.add', { path: workspace, name: 'ThreadTerm', operationId: randomUUID() });
  const shell = await request('session.create', { projectId: project.id, cwd: workspace, provider: 'shell', mode: 'terminal', title: 'Office preview fixes', operationId: randomUUID() });
  await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  // A manual checkpoint, then a second round of edits, so the Agent changes review lists real files.
  await request('review.checkpoint', { sessionId: shell.id, kind: 'manual', operationId: randomUUID() });
  await writeFile(join(workspace, 'renderer/src/components/SheetView.tsx'), ['export function SheetView({ sheet }: Props) {', '  const cells = layoutCells(sheet);', '  const frozen = useFrozenColumns(sheet);', '  return cells.map(cell => {', '    const style = { gridColumn: `span ${cell.span}`, left: freezeX(cell, frozen) };', '    if (cell.merged && crossesFreeze(cell, frozen)) style.clipPath = clipAtFreeze(cell, frozen);', '    return <Cell key={cell.id} style={style} />;', '  });', '}', 'export const frozenWidth = (frozen: Frozen) => (frozen ? frozen.count * 96 : 0);', ''].join('\n'));
  await writeFile(join(workspace, 'renderer/src/components/sheet-view.css'), ['.sheet-cell[data-merged] {', '  position: sticky;', '  left: var(--freeze-x, 0);', '}', ''].join('\n'));
  const { chromium } = await import('@playwright/test'); browser = await chromium.launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));

  for (const [language, locale] of [['en', 'en'], ['zh-CN', 'zh']]) for (const theme of ['light', 'dark']) {
    const tag = `${locale}-${theme}`;
    await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.start-q').waitFor({ timeout: 45_000 });
    await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    await setAppearance(language, theme);
    await page.locator('.workbench-page .composer').waitFor();
    await until(async () => (await page.locator('.start-row').count()) > 0, 'recent sessions');
    if (screens.includes('start')) { await shot(page.locator('.content.main'), `start-${tag}.png`); await prototype('start', theme, `proto-start-${theme}.png`); }
    await page.getByRole('button', { name: /Office preview fixes/ }).first().click();
    await page.locator('.runtime-workspace').waitFor({ timeout: 30_000 });
    if (screens.includes('scm')) { await openView(language === 'zh-CN' ? '源代码管理' : 'Source Control'); await page.locator('.wb-scm').waitFor(); await until(async () => !/Loading|正在读取/.test(await page.locator('.wb-scm').innerText()), 'source control status'); await delay(250); await shot(page.locator('.wb-sidebar'), `scm-${tag}.png`); if (language === 'en') await prototype('review', theme, `proto-scm-${theme}.png`, '.inspector'); }
    if (screens.includes('editor')) {
      await openView(language === 'zh-CN' ? '文件' : 'Files');
      for (const dir of ['renderer', 'renderer/src', 'renderer/src/components']) { const row = page.locator(`.wb-tree-row[data-path="${dir}"]`).first(); await row.waitFor(); if (await row.getAttribute('aria-expanded') !== 'true') await row.click(); }
      const file = page.locator('.wb-tree-row[data-path="renderer/src/components/SheetView.tsx"]').first(); await file.waitFor(); await file.click();
      await page.locator('.file-workspace-bar').waitFor(); await until(async () => (await page.locator('.tt-editor-shell .cm-content').count()) > 0, 'editor content');
      await page.locator('.tt-editor-shell .cm-content').first().click(); await delay(300);
      await shot(page.locator('.workspace-pane.selected'), `editor-${tag}.png`);
      if (language === 'en') await prototype('editor', theme, `proto-editor-${theme}.png`);
    }
    if (screens.includes('review')) {
      await openView(language === 'zh-CN' ? 'Agent 改动' : 'Agent changes');
      const reviewFile = page.locator('.wb-review .wb-change-open').first(); await reviewFile.waitFor({ timeout: 30_000 });
      await reviewFile.click();
      await page.locator('[data-testid="review-diff-surface"]').waitFor(); await delay(600);
      await shot(page.locator('.workspace-pane.selected'), `review-${tag}.png`);
      if (language === 'en') await prototype('review', theme, `proto-review-${theme}.png`);
    }
    if (screens.includes('history')) {
      await openView(language === 'zh-CN' ? '源代码管理' : 'Source Control');
      await page.locator('.wb-panel-head').getByRole('button', { name: language === 'zh-CN' ? '提交历史' : 'History' }).click();
      const commit = page.locator('.wb-commit-row').first(); await commit.waitFor(); await commit.click(); await delay(500);
      await shot(page.locator('.content.main'), `history-${tag}.png`);
      if (language === 'en') await prototype('review', theme, `proto-history-${theme}.png`, '.inspector');
    }
  }
  console.log(JSON.stringify({ ok: true, out, screenshots: report.screenshots, errors: report.errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, out, error: String(error?.stack ?? error), screenshots: report.screenshots, errors: report.errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await app?.close().catch(() => {});
  await releaseLock?.();
  await cleanup?.();
  process.exit(process.exitCode ?? 0);
}
