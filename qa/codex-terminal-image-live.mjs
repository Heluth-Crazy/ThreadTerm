// Real Codex CLI, no model submission; clipboard restored after isolated QA.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-terminal-image-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(codex_home|threadterm_v3_(runtime|data|user_data|pipe))$/i.test(key)));
Object.assign(env, { CODEX_HOME: join(scratch, 'codex-home'), THREADTERM_V3_RUNTIME: resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-image-cli-${randomUUID()}` });
let app, page, priorClipboard;
const report = { scratch, passed: false };
const delay = ms => new Promise(done => setTimeout(done, ms));
try {
  await Promise.all([mkdir(env.CODEX_HOME), mkdir(env.THREADTERM_V3_DATA), mkdir(env.THREADTERM_V3_USER_DATA), mkdir(join(scratch, 'workspace'))]);
  await copyFile(join(process.env.USERPROFILE, '.codex', 'auth.json'), join(env.CODEX_HOME, 'auth.json'));
  // Reuse this machine's non-secret setup marker in the isolated home. Never
  // install/refresh a host sandbox merely to test the CLI's clipboard shortcut.
  await mkdir(join(env.CODEX_HOME, '.sandbox'));
  await copyFile(join(process.env.USERPROFILE, '.codex', '.sandbox', 'setup_marker.json'), join(env.CODEX_HOME, '.sandbox', 'setup_marker.json'));
  await writeFile(join(env.CODEX_HOME, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
  app = await electron.launch({ args: [resolve('.')], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
  const project = await rpc('project.add', { path: join(scratch, 'workspace'), name: 'Codex image QA', operationId: randomUUID() });
  // The isolated native background daemon cannot start in this host. The CLI's
  // documented --no-daemon route keeps this QA process supervised by its PTY.
  const standardProvider = process.argv.includes('--standard-provider');
  report.standardProvider = standardProvider;
  const session = await rpc('session.create', { projectId: project.id, cwd: project.path, provider: standardProvider ? 'codex' : 'custom', mode: 'terminal', executable: 'codex', args: ['--no-daemon', '--no-alt-screen', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never'], title: 'Codex image QA', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const output = async () => Buffer.from((await rpc('terminal.read', { sessionId: session.id, cursor: 0, limit: 1024 * 1024 })).data, 'base64').toString('utf8');
  await page.locator('.term-loading-overlay').waitFor({ state: 'hidden', timeout: 60_000 });
  const term = page.locator('.xterm-helper-textarea');
  await term.evaluate(element => element.focus());
  const readyDeadline = Date.now() + 60_000;
  let trustHandled = false;
  while (Date.now() < readyDeadline) {
    const text = await output();
    if (!trustHandled && /trust this|trust the|work in this folder|Yes, I trust/i.test(text)) { trustHandled = true; await page.keyboard.press('Enter'); await delay(1000); }
    if (/context left|for shortcuts|gpt-.*directory:/i.test(text)) break;
    await delay(200);
  }
  const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100; const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 80, 100); ctx.fillStyle = 'blue'; ctx.fillRect(80, 0, 80, 100); return canvas.toDataURL('image/png'); });
  priorClipboard = await app.evaluate(async ({ clipboard }) => Promise.all((await clipboard.read()).map(async item => Promise.all(item.types.map(async type => {
    const payload = await item.getType(type);
    return typeof payload.arrayBuffer === 'function' ? { type, bytes: Array.from(new Uint8Array(await payload.arrayBuffer())) } : { type, value: payload };
  })))));
  await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }, data) => {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([nativeImage.createFromDataURL(data).toPNG()], { type: 'image/png' }) })]);
  }, image);
  await term.evaluate(element => element.focus());
  await page.keyboard.press('Alt+v');
  await delay(1500);
  report.outputAfterAltV = await output();
  await page.screenshot({ path: join(scratch, 'alt-v.png') });
  report.passed = /Image #1|\[image|image attached|attached image/i.test(report.outputAfterAltV);
  if (!report.passed) report.error = 'Native CLI did not show an attached image after Alt+V; inspect redacted terminal output and screenshot.';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  if (app && priorClipboard) await app.evaluate(async ({ clipboard, ClipboardItem }, prior) => {
    if (!prior.length) { clipboard.clear(); return; }
    await clipboard.write(prior.map(item => new ClipboardItem(Object.fromEntries(item.map(entry => [entry.type, entry.bytes ? new Blob([Uint8Array.from(entry.bytes)], { type: entry.type }) : entry.value])))));
  }, priorClipboard).catch(() => {});
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Codex terminal image ${report.passed ? 'passed' : 'failed'}: ${join(scratch, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
