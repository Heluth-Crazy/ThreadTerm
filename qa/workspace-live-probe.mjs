// Real app + QA runtime, isolated data: measures the session pane area that decides file
// splits, and types in a real TypeScript editor. Never touches the user's profile or runtime.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-probe-'));
const project = join(scratch, 'project'); await mkdir(join(project, 'src'), { recursive: true });
await writeFile(join(project, 'src', 'app.ts'), 'export function run() {\n  const handleSubmit = 1;\n  \n}\n');
const env = { ...process.env, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'electron'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-v3-probe-${randomUUID()}`, THREADTERM_V3_RUNTIME: resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe') };
let runtimeLog = ''; const daemon = spawn(env.THREADTERM_V3_RUNTIME, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); daemon.stderr.on('data', chunk => { runtimeLog += chunk; });
const out = resolve('qa/results/workspace-live-probe'); await mkdir(out, { recursive: true });
let app; const report = { scratch };
try {
  app = await electron.launch({ args: [resolve('.')], env, timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 20_000 }); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.threadterm);
  const session = await page.evaluate(async path => {
    const s = await window.threadterm.request('runtime.snapshot', {});
    await window.threadterm.request('settings.update', { patch: { language: 'en' }, expectedRevision: s.settings.revision, operationId: crypto.randomUUID() });
    const added = await window.threadterm.request('project.add', { path, name: 'Probe', operationId: crypto.randomUUID() });
    return window.threadterm.request('session.create', { projectId: added.id, cwd: path, title: 'Probe shell', provider: 'shell', mode: 'terminal', operationId: crypto.randomUUID() });
  }, project);
  const navigate = () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), session.id);
  await navigate();
  await page.locator('.ws-content > .ws-pane').waitFor();
  await page.waitForTimeout(500);
  const measure = () => page.evaluate(() => {
    const box = selector => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), width: Math.round(rect.width) }; };
    return { window: innerWidth, content: box('.ws-content'), sidebar: box('.ws-content > .wb-sidebar'), pane: document.querySelector('.ws-content > .ws-pane')?.clientWidth, panes: document.querySelectorAll('.ws-pane [data-pane-id], .ws-pane .pane').length };
  });
  report.default = await measure();
  await page.screenshot({ path: join(out, 'session-1440.png') });

  // The side panel starts collapsed; the first switcher icon opens the Files view.
  await page.locator('.wb-switcher .wb-switch-btn').first().click();
  const row = path => page.locator(`.wb-tree [data-path="${path}"]`);
  await row('src').waitFor();
  report.withFiles = await measure();
  await row('src').click(); await row('src/app.ts').click();
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.waitFor();
  report.afterOpen = await measure();
  await page.waitForTimeout(800);
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('End');
  await page.keyboard.type('hand', { delay: 40 });
  const popup = await page.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 3000 }).then(() => true, () => false);
  report.completion = { popup, labels: await page.evaluate(() => [...document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel')].map(item => item.textContent)) };
  await page.screenshot({ path: join(out, 'editor-1440.png') });
  await page.keyboard.press('Escape');

  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(1920, 1040); });
  await page.waitForTimeout(600);
  report.wide = await measure();
  report.errors = errors;
  await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  console.log(JSON.stringify(report, null, 1));
} catch (error) {
  console.error('[probe] failed', error, runtimeLog.slice(-2000)); process.exitCode = 1;
  if (app) await app.windows()[0]?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (app) { await app.evaluate(({ app }) => { setTimeout(() => app.exit(), 0); }).catch(() => {}); await app.close().catch(() => {}); }
  if (daemon.exitCode === null) daemon.kill();
}
