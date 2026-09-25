// Production-main tray Quit QA. Every Electron profile, runtime database and
// named pipe is temporary; this never attaches to the user's application.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {_electron as electron} from '@playwright/test';
import {connectPeer} from './pipe-client.mjs';

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const root = resolve(new URL('..', import.meta.url).pathname.slice(1));
const desktopMain = join(root, 'desktop-dist', 'main.cjs');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/resume-qa/debug/threadterm-v3-runtime.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-desktop-quit-'));
const harness = join(scratch, 'desktop-quit-harness.cjs');

await writeFile(harness, `
const electron = require('electron');
process.chdir(${JSON.stringify(root)});
electron.app.setAppPath(${JSON.stringify(root)});
const originalSetContextMenu = electron.Tray.prototype.setContextMenu;
globalThis.__desktopQuitQa = { menu: undefined, dialogs: [], response: 0, pending: [] };
electron.Tray.prototype.setContextMenu = function(menu) {
  globalThis.__desktopQuitQa.menu = menu;
  return originalSetContextMenu.call(this, menu);
};
electron.dialog.showMessageBox = async function(parent, options) {
  const qa = globalThis.__desktopQuitQa;
  qa.dialogs.push({ title: options.title, message: options.message, parentVisible: !!parent && parent.isVisible() });
  if (qa.response === 'defer') return await new Promise(resolve => qa.pending.push(resolve));
  return { response: qa.response };
};
globalThis.__desktopQuitQa.clickQuit = () => {
  const item = globalThis.__desktopQuitQa.menu?.items.find(candidate => candidate.label === 'Quit');
  if (!item?.click) throw new Error('Tray Quit item was not captured');
  item.click();
};
globalThis.__desktopQuitQa.releaseDialogs = response => {
  const pending = globalThis.__desktopQuitQa.pending.splice(0);
  for (const resolve of pending) resolve({ response });
};
require(${JSON.stringify(desktopMain)});
`);

async function waitFor(predicate, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function pipeOpen(pipe) {
  return await new Promise(resolveOpen => {
    const socket = net.createConnection(pipe);
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolveOpen(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function closeRuntime(data, pipe) {
  try {
    const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
    const peer = await connectPeer(`${pipe}-control`);
    try { await peer.auth(credential); await peer.request('runtime.shutdown', {operationId: randomUUID()}); }
    finally { peer.close(); }
  } catch { /* runtime may already be gone or was intentionally never started */ }
}

function isolatedEnvironment(data, userData, pipe, runtimePath) {
  const environment = {
    ...process.env,
    APPDATA: join(scratch, `appdata-${randomUUID()}`),
    LOCALAPPDATA: join(scratch, `localappdata-${randomUUID()}`),
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: userData,
    THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtimePath,
  };
  delete environment.THREADTERM_V3_DEV_SERVER_URL;
  return environment;
}

async function launch(name, runtimePath) {
  const data = join(scratch, `${name}-data`);
  const userData = join(scratch, `${name}-user-data`);
  const project = join(scratch, `${name}-project`);
  const pipe = `\\\\.\\pipe\\threadterm-desktop-quit-${randomUUID()}`;
  await Promise.all([mkdir(data), mkdir(userData), mkdir(project)]);
  const app = await electron.launch({args: [harness], env: isolatedEnvironment(data, userData, pipe, runtimePath), timeout: 30_000});
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.threadterm), {timeout: 15_000});
  await app.evaluate(() => {
    if (!globalThis.__desktopQuitQa.menu) throw new Error('Tray menu was not created');
  });
  return {app, page, data, pipe, project};
}

const checks = [];
let active;
try {
  active = await launch('active', runtime);
  const session = await active.page.evaluate(async ({cwd}) => await window.threadterm.request('session.create', {
    cwd, title: 'desktop quit QA', provider: 'custom', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], operationId: crypto.randomUUID(),
  }), {cwd: active.project});
  await waitFor(async () => await active.page.evaluate(async id => (await window.threadterm.request('runtime.snapshot', {})).sessions.some(row => row.id === id && row.status === 'running'), session.id), 'active terminal');
  await active.page.evaluate(() => window.threadterm.windowAction('close'));
  await waitFor(() => active.page.evaluate(() => !window.threadterm.windowAction || !document.hasFocus()).then(() => true), 'main window hide dispatch');

  await active.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(async () => (await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length)) === 1, 'active-session confirmation');
  const hiddenDialog = await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs[0]);
  assert.equal(hiddenDialog.parentVisible, true, 'Quit must show the hidden main window before parenting an active-session confirmation');
  const stillRunning = await active.page.evaluate(async id => (await window.threadterm.request('runtime.snapshot', {})).sessions.some(row => row.id === id && row.status === 'running'), session.id);
  assert.equal(stillRunning, true, 'cancelling Quit keeps the real active session running');
  checks.push('hidden-window confirmation is parented to a visible window', 'cancel keeps the active session running');

  await active.app.evaluate(() => { globalThis.__desktopQuitQa.response = 'defer'; globalThis.__desktopQuitQa.clickQuit(); globalThis.__desktopQuitQa.clickQuit(); });
  await delay(500);
  assert.equal(await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length), 2, 'two rapid tray clicks share one pending Quit operation');
  await active.app.evaluate(() => globalThis.__desktopQuitQa.releaseDialogs(1));
  await waitFor(() => pipeOpen(`${active.pipe}-control`).then(open => !open), 'runtime pipe release after confirmed quit');
  await delay(500);
  assert.equal(await pipeOpen(`${active.pipe}-control`), false, 'confirmed Quit must not restart the runtime after shutdown');
  checks.push('rapid Quit clicks are single-flight', 'confirmed Quit releases the real runtime pipe without restart');
  console.log(JSON.stringify({passed: true, checks, scratch}));
} finally {
  if (active) { await active.app.evaluate(({app}) => app.exit(0)).catch(() => {}); await active.app.close().catch(() => {}); await closeRuntime(active.data, active.pipe); }
  await rm(scratch, {recursive: true, force: true});
}
