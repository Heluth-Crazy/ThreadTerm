import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from '@playwright/test';
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-alt-v-'));
const runtime = resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.match(runtime, /runtime[\\/]target-qa[\\/]debug/);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^threadterm_v3_(runtime|data|user_data|pipe)$/i.test(key)));
Object.assign(env, { THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-alt-v-${randomUUID()}` });
let app, page;
const report = { scratch, bytes: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
try {
  await Promise.all([mkdir(env.THREADTERM_V3_DATA), mkdir(env.THREADTERM_V3_USER_DATA)]);
  app = await electron.launch({ args: [resolve('.')], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
  const project = await rpc('project.add', { path: scratch, name: 'Alt V QA', operationId: randomUUID() });
  const session = await rpc('session.create', { projectId: project.id, cwd: scratch, provider: 'shell', mode: 'terminal', title: 'Alt V QA', executable: 'powershell.exe', args: ['-NoProfile', '-Command', "[Console]::WriteLine('KEY_READY'); while($true){$k=[Console]::ReadKey($true); [Console]::WriteLine(('BYTE:{0:X2} MOD:{1}' -f [int]$k.KeyChar,$k.Modifiers))}"], operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const output = async () => Buffer.from((await rpc('terminal.read', { sessionId: session.id, cursor: 0, limit: 1024 * 1024 })).data, 'base64').toString('utf8');
  const waitOutput = async marker => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const text = await output(); if (text.includes(marker)) return text; await delay(100); }
    throw new Error(`Missing ${marker}; output: ${await output()}`);
  };
  await waitOutput('KEY_READY');
  await page.locator('.term-loading-overlay').waitFor({ state: 'hidden', timeout: 30_000 });
  const term = page.locator('.xterm-helper-textarea');
  await term.waitFor({ state: 'attached' });
  await term.evaluate(element => element.focus());
  await page.keyboard.press('a');
  await waitOutput('BYTE:61');
  await page.keyboard.press('Alt+v');
  await page.keyboard.press('Alt+Shift+v');
  await delay(500);
  report.text = await output();
  report.bytes = [...report.text.matchAll(/BYTE:([0-9A-F]{2})/g)].map(match => match[1]);
  // Windows ReadKey consumes the VT prefix and exposes the Alt modifier.
  assert.match(report.text, /BYTE:76 MOD:Alt/);
  assert.match(report.text, /BYTE:56 MOD:(?:Alt, Shift|Shift, Alt)/);
  report.passed = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
