import { _electron as electron } from '@playwright/test';
import { access, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const installRoot = await realpath(resolve(process.argv[2] ?? ''));
const temporaryRoot = await realpath(tmpdir());
assert.equal(dirname(installRoot).toLowerCase(), temporaryRoot.toLowerCase(), 'test installation must be a direct child of Temp');
assert.ok(basename(installRoot).startsWith('threadterm-v3-installed-'), 'refuse to uninstall an unrelated application');
const executablePath = join(installRoot, 'ThreadTerm.exe');
const uninstaller = join(installRoot, 'Uninstall ThreadTerm.exe');
await access(uninstaller);
const resolvedUninstaller = await realpath(uninstaller);
assert.equal(dirname(resolvedUninstaller).toLowerCase(), installRoot.toLowerCase(), 'refuse to run an uninstaller outside the validated test installation');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-installed-qa-'));
const projectPath = join(scratch, 'project');
await mkdir(projectPath);
const env = { ...process.env, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-v3-installed-${randomUUID()}` };
delete env.THREADTERM_V3_RUNTIME;
delete env.THREADTERM_V3_DEV_SERVER_URL;
let app, page;
const report = { startedAt: new Date().toISOString(), installRoot, retainedData: env.THREADTERM_V3_DATA, passed: false, checks: [] };
function finishWithin(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`operation did not finish within ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timeout));
}
async function closeApp() {
  const runningApp = app;
  const runningPage = page;
  app = undefined;
  page = undefined;
  if (!runningApp) return;
  await finishWithin((async () => {
    await runningPage?.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
    await runningApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await runningApp.close().catch(() => {});
  })(), 10_000);
}
try {
  for (const resource of ['threadterm-v3-runtime.exe', 'threadterm-v3-mcp.exe', 'claude-sdk-host.mjs', 'claude-sdk-cli.exe']) await access(join(installRoot, 'resources', 'runtime', resource));
  const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(nodeEnv)) if (key.toLowerCase() === 'path') delete nodeEnv[key];
  nodeEnv.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  await new Promise((resolveWorker, rejectWorker) => {
    const worker = spawn(executablePath, [join(installRoot, 'resources', 'runtime', 'claude-sdk-host.mjs')], { env: nodeEnv, cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = createInterface({ input: worker.stdout });
    let replied = false;
    const timer = setTimeout(() => { worker.kill(); rejectWorker(Error('Installed Claude host ping timed out')); }, 20_000);
    reader.on('line', line => {
      try { const value = JSON.parse(line); if (value.id === 1 && value.ok?.sdk === true) { replied = true; worker.stdin.end(); } }
      catch { /* Other worker output cannot satisfy the ping assertion. */ }
    });
    worker.once('error', error => { clearTimeout(timer); rejectWorker(error); });
    worker.once('exit', code => { clearTimeout(timer); reader.close(); if (code === 0 && replied) resolveWorker(); else rejectWorker(Error(`Installed Claude host failed (${code})`)); });
    worker.stdin.end(JSON.stringify({ id: 1, op: 'host.ping' }) + '\n');
  });
  report.checks.push('installed Electron ran the bundled Claude SDK host and answered host.ping without external Node on PATH');
  app = await electron.launch({ executablePath, args: [], env, timeout: 45_000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.threadterm, { timeout: 30_000 });
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'), version: app.getVersion() }));
  assert.equal(identity.packaged, true);
  assert.equal(identity.userData.toLowerCase(), env.THREADTERM_V3_USER_DATA.toLowerCase());
  const health = await page.evaluate(() => window.threadterm.request('runtime.health', {}));
  assert.equal(typeof health.epoch, 'string');
  report.version = identity.version;
  report.checks.push('installed packaged renderer, isolated user profile and bundled runtime/MCP/Claude host verified');
  const project = await page.evaluate(path => window.threadterm.request('project.add', { path, name: 'Installed QA', operationId: crypto.randomUUID() }), projectPath);
  const created = await page.evaluate(({ projectId, cwd }) => window.threadterm.request('session.create', { projectId, cwd, provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], title: 'Installed PTY validation', operationId: crypto.randomUUID() }), { projectId: project.id, cwd: projectPath });
  await page.reload();
  await page.waitForFunction(() => !!window.threadterm, { timeout: 30_000 });
  const installedPtyRow = page.locator('.sess-row').filter({ hasText: 'Installed PTY validation' }).first();
  await installedPtyRow.waitFor({ state: 'visible', timeout: 30_000 });
  await installedPtyRow.click();
  await page.locator('.terminal-host').waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.locator('.terminal-host').click();
  const marker = 'INSTALLED_PTY_' + randomUUID().replaceAll('-', '');
  await page.keyboard.type('echo ' + marker);
  await page.keyboard.press('Enter');
  await page.waitForFunction(marker => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent?.trim() === marker), marker, { timeout: 20_000 });
  report.checks.push('typed a command into the installed TerminalSurface and observed the exact real PTY output line');
  await page.evaluate(sessionId => window.threadterm.request('session.stop', { sessionId, operationId: crypto.randomUUID() }), created.id);
  await closeApp();
  // NSIS receives only the known test installation's uninstaller. No path is
  // interpolated into a shell command, and no other program/profile is removed.
  await new Promise((resolvePromise, reject) => {
    const child = spawn(resolvedUninstaller, ['/S'], { cwd: temporaryRoot, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(Error(`NSIS uninstall exited ${code}`)));
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { await access(executablePath); } catch { break; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  await assert.rejects(access(executablePath), 'isolated installed executable should be removed');
  const sqlite = await readFile(join(env.THREADTERM_V3_DATA, 'threadterm-v3.sqlite3'));
  assert.equal(sqlite.subarray(0, 15).toString(), 'SQLite format 3');
  report.checks.push('isolated NSIS uninstall removed the application and retained its external V3 SQLite data');
  report.passed = true;
} catch (error) {
  await mkdir('qa/results', { recursive: true });
  await page?.screenshot({ path: 'qa/results/installed-smoke-failure.png', fullPage: true }).catch(() => {});
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await closeApp().catch(() => {});
  report.completedAt = new Date().toISOString();
  await mkdir('qa/results', { recursive: true });
  await writeFile('qa/results/installed-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
