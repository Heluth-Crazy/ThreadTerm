// Real-app check of the console host choice (task 10-03-windows-terminal-hardening): the target-qa Rust
// runtime + RuntimeClient + the sandboxed preload (built from source into scratch) + production React
// TerminalSurface and SettingsControls. Shell terminal only — no agent CLI is started.
//   node qa/conpty-host-visual.mjs <bundled|system|default> [selected: bundled|system|default]
// `bundled` / `system` force the host (THREADTERM_V3_CONPTY); `default` uses the runtime's own choice (no
// override, no setting → bundled when runtime/target-qa/debug/conpty/ holds the pair, else the built-in host).
// `selected` is the Settings value shown (`default` = not set). Prepare the pair with
// node runtime/conpty/prepare.mjs --out runtime/target-qa/debug/conpty
// Screenshots (en + zh-CN): qa/results/conpty-host-visual/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { terminalWindowArguments } from '../desktop/src/terminalEnvironment.ts';

const [mode = 'default', selected = 'default'] = process.argv.slice(2);
assert.ok(['bundled', 'system', 'default'].includes(mode) && ['bundled', 'system', 'default'].includes(selected), 'usage: node qa/conpty-host-visual.mjs <bundled|system|default> [bundled|system|default]');
const root = resolve('.');
const exe = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const pairPresent = existsSync(join(root, 'runtime/target-qa/debug/conpty/OpenConsole.exe')) && existsSync(join(root, 'runtime/target-qa/debug/conpty/conpty.dll'));
if (mode === 'bundled') assert.ok(pairPresent, 'prepare runtime/target-qa/debug/conpty first');
/** The host the runtime should end up using, and what the Settings value means. */
const host = mode === 'default' ? (pairPresent ? 'bundled' : 'system') : mode;
const chosen = selected === 'system' ? 'system' : 'bundled';
const out = join(root, 'qa/results/conpty-host-visual');
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'tt-conpty-host-'));
const data = join(scratch, 'data'); await mkdir(data);
const pipe = `\\\\.\\pipe\\tt-conpty-host-${randomUUID()}`;
const { THREADTERM_V3_CONPTY: _inherited, ...parentEnv } = process.env;
const runtimeEnv = { ...parentEnv, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: exe, ...(mode === 'default' ? {} : { THREADTERM_V3_CONPTY: mode }) };
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };

const entry = `
import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {TerminalSurface} from './renderer/src/components/TerminalSurface';
import {SettingsControls} from './renderer/src/components/SettingsControls';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const open = Terminal.prototype.open;
Terminal.prototype.open = function (element) { window.term = this; return open.call(this, element); };
function Fixture() {
  const [session, setSession] = useState(), [zh, setZh] = useState(false);
  const [settings, setSettings] = useState(${JSON.stringify(selected === 'default' ? { revision: 0 } : { revision: 0, conptyHost: selected })});
  window.showSession = setSession; window.setZh = setZh;
  useEffect(() => { if (!session) return; const timer = setInterval(() => window.threadterm.request('runtime.snapshot', {}).then(snapshot => setSession(old => snapshot.sessions.find(item => item.id === old?.id) ?? old)), 500); return () => clearInterval(timer); }, [session?.id]);
  return <I18nProvider locale={zh ? 'zh-CN' : 'en'}><div className="fixture">
    <div className="qa-terminal">{session && <TerminalSurface key={session.id} sessionId={session.id} session={session} provider={session.provider} theme="light" terminalCompatibility={{}} />}</div>
    <div className="qa-settings"><SettingsControls settings={settings} zh={zh} update={async patch => setSettings(old => ({ ...old, ...patch }))} counts={{ checks: 0, alertCount: 0 }} /></div>
  </div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root,.fixture{height:100%;margin:0}.fixture{display:flex}.qa-terminal{flex:1;min-width:0;display:flex}.qa-terminal>*{flex:1;min-width:0}.qa-settings{width:380px;overflow:auto;padding:8px 14px;font:13px system-ui}</style><div id="root"></div><script src="qa.js"></script>');
await build({ entryPoints: [join(root, 'desktop/src/preload.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(scratch, 'preload.cjs'), logLevel: 'error' });
const main = `
import {app, BrowserWindow, ipcMain} from 'electron';
import {RuntimeClient} from './desktop/src/runtime-client';
import {validateRequest} from './protocol/index';
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
const client = new RuntimeClient(), subs = new Map();
function close(id) { const s = subs.get(id); if (!s) return; subs.delete(id); s.unsubscribe?.(); for (const ack of s.acks) ack(); }
ipcMain.handle('threadterm:request', (_e, method, params) => { validateRequest(method, params); return client.request(method, params); });
ipcMain.handle('threadterm:subscribe-output', async (e, sessionId, cursor, id) => {
  subs.set(id, { acks: [] });
  const unsubscribe = await client.subscribeOutput(sessionId, cursor, chunk => new Promise(resolve => { const s = subs.get(id); if (!s || e.sender.isDestroyed()) { resolve(); return; } s.acks.push(resolve); e.sender.send('threadterm:output', { id, chunk }); }));
  const s = subs.get(id); if (s) s.unsubscribe = unsubscribe; else unsubscribe();
  return { id };
});
ipcMain.handle('threadterm:ack-output', (_e, id) => subs.get(id)?.acks.shift()?.());
ipcMain.handle('threadterm:unsubscribe-output', (_e, id) => close(id));
app.on('before-quit', () => { for (const id of subs.keys()) close(id); client.dispose(); });
app.whenReady().then(() => new BrowserWindow({ width: 1300, height: 820, show: false, webPreferences: { preload: ${JSON.stringify(join(scratch, 'preload.cjs'))}, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ${JSON.stringify(terminalWindowArguments(process.platform, release()))} } }).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));
`;
await build({ stdin: { contents: main, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(scratch, 'main.cjs'), logLevel: 'error' });

let app;
const daemon = spawn(exe, [], { env: runtimeEnv, windowsHide: true, stdio: 'ignore' });
let failed;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], env: runtimeEnv });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(`page error: ${error.message}`); });
  page.on('console', message => { if (message.type() === 'error') console.log(`console error: ${message.text()}`); });
  await page.waitForFunction(() => window.showSession && window.threadterm);
  const request = (method, params = {}) => page.evaluate(({ method, params }) => window.threadterm.request(method, params), { method, params });
  const reported = await request('terminal.host');
  assert.equal(reported.conptyHost, host, 'the runtime reports the host it was started with');
  note(`terminal.host → ${reported.conptyHost}`);

  const t0 = Date.now();
  const session = await request('session.create', { cwd: scratch, title: 'QA host', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/k', 'prompt READY$G'], operationId: randomUUID() });
  const createdMs = Date.now() - t0;
  assert.ok(createdMs < 1500, `session start took ${createdMs} ms (an unanswered host handshake costs ~3 s)`);
  await page.evaluate(value => window.showSession(value), session);
  const screen = () => page.evaluate(() => { const buffer = window.term.buffer.active; return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').filter(line => line.trim()).join('\n'); });
  await page.waitForFunction(() => window.term && Array.from({ length: window.term.buffer.active.length }, (_, y) => window.term.buffer.active.getLine(y)?.translateToString(true) ?? '').some(line => line.includes('READY>')));
  note(`shell terminal started in ${createdMs} ms`);

  // xterm's Windows heuristics follow the host the runtime uses.
  await page.waitForFunction(expected => window.term.options.windowsPty?.buildNumber === expected, host === 'bundled' ? 21376 : Number(release().split('.')[2]), { timeout: 5000 }).catch(() => {});
  const windowsPty = await page.evaluate(() => window.term.options.windowsPty);
  if (host === 'bundled') assert.ok(windowsPty?.buildNumber >= 21376, `bundled host must give xterm a modern build, got ${JSON.stringify(windowsPty)}`);
  else assert.equal(windowsPty?.buildNumber, Number(release().split('.')[2]), 'system host keeps the OS build');
  note(`xterm windowsPty ${JSON.stringify(windowsPty)}`);

  await page.waitForFunction(() => !window.term.options.disableStdin, null, { timeout: 15000 });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo HOST-OK');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Array.from({ length: window.term.buffer.active.length }, (_, y) => window.term.buffer.active.getLine(y)?.translateToString(true) ?? '').some(line => line.trim() === 'HOST-OK'));
  const text = await screen();
  assert.ok(!/\[\?1;2c|\^\[/.test(text), `no stray terminal reply in the shell:\n${text}`);
  note('typed command ran; no stray terminal reply reached the shell');

  for (const zh of [false, true]) {
    await page.evaluate(value => window.setZh(value), zh);
    await page.waitForTimeout(400);
    const settingsText = await page.locator('.qa-settings').innerText();
    const expectInUse = host === 'bundled' ? (zh ? '随附的 OpenConsole' : 'the bundled OpenConsole') : (zh ? 'Windows 自带的控制台主机' : 'the Windows built-in console host');
    assert.ok(settingsText.includes(expectInUse), `settings must name the host in use (${expectInUse})`);
    const missing = chosen === 'bundled' && !pairPresent;
    const missingNote = zh ? '此版本未附带 OpenConsole' : 'does not include the OpenConsole files';
    assert.equal(settingsText.includes(missingNote), missing, 'the "not in this build" note exactly when bundled is chosen but the pair is missing');
    const restartNote = zh ? '重新启动 ThreadTerm' : 'Takes effect after ThreadTerm';
    assert.equal(settingsText.includes(restartNote), !missing && host !== chosen, 'restart note only when the choice differs from the host in use');
    const checked = await page.locator('.qa-settings .compatibility-settings').last().locator('input[type=checkbox]').isChecked();
    assert.equal(checked, chosen === 'bundled', 'the switch shows the choice (bundled unless set to system)');
    await page.locator('.qa-settings').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const name = `${mode}-selected-${selected}${pairPresent ? '' : '-no-pair'}-${zh ? 'zh-CN' : 'en'}.png`;
    await page.screenshot({ path: join(out, name) });
    note(`settings (${zh ? 'zh-CN' : 'en'}): switch ${checked ? 'on' : 'off'}, host in use named${missing ? ', "not in this build" note' : host !== chosen ? ', restart note' : ''} → ${name}`);
  }
  assert.deepEqual(errors, [], 'no page errors');
  await request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() }).catch(() => {});
  console.log(JSON.stringify({ host, selected, passed: true, checks }, null, 2));
} catch (error) {
  failed = error;
  console.log(`FAIL ${error.stack ?? error}`);
} finally {
  await app?.close().catch(() => {});
  if (daemon.exitCode === null) daemon.kill();
  await new Promise(done => setTimeout(done, 1500));
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`scratch left at ${scratch}`));
  if (failed) process.exitCode = 1;
}
