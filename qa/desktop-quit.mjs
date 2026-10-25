// Production-main tray Quit QA. Every Electron profile, runtime database and
// named pipe is temporary; this never attaches to the user's application.
import assert from 'node:assert/strict';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';
import {createHmac, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {buildQaApp} from './lib/qa-app.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-desktop-quit-'));
const visualOut = join(root, 'qa/results/desktop-quit');
await mkdir(visualOut, {recursive:true});
const appDir = join(scratch, 'app');
const desktopMain = join(appDir, 'main.cjs');
const harness = join(scratch, 'desktop-quit-harness.cjs');
const releaseLock = await acquireElectronQaLock();
try {
  await buildQaApp({root, outDir:appDir});
} catch (error) { await releaseLock(); throw error; }

await writeFile(harness, `
const electron = require('electron');
// 7a2b7c1c preapproves ordinary QA quits; this harness verifies the confirmation itself.
process.env.THREADTERM_V3_QA_AUTO_CONFIRM_QUIT = '0';
process.chdir(${JSON.stringify(root)});
electron.app.setAppPath(${JSON.stringify(appDir)});
const originalSetContextMenu = electron.Tray.prototype.setContextMenu;
globalThis.__desktopQuitQa = { menu: undefined, dialogs: [], response: 0, pending: [] };
electron.Tray.prototype.setContextMenu = function(menu) {
  globalThis.__desktopQuitQa.menu = menu;
  return originalSetContextMenu.call(this, menu);
};
const originalMessageBox = electron.dialog.showMessageBox;
electron.dialog.showMessageBox = async function(parent, options) {
  const qa = globalThis.__desktopQuitQa;
  qa.dialogs.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons, noLink: options.noLink, defaultId: options.defaultId, cancelId: options.cancelId, iconPresent: !!options.icon && !options.icon.isEmpty(), parentVisible: !!parent && parent.isVisible() });
  if (qa.response === 'real') return await originalMessageBox.call(electron.dialog, parent, options);
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

function framed(socket) {
  let incoming = Buffer.alloc(0);
  let listener = () => {};
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (incoming.length < length + 4) return;
      const frame = incoming.subarray(4, length + 4);
      incoming = incoming.subarray(length + 4);
      listener(frame);
    }
  });
  const send = body => {
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    socket.write(frame);
  };
  return {
    onFrame(next) { listener = next; },
    json(value) { send(Buffer.from(JSON.stringify(value), 'utf8')); },
    output(sessionId, cursor, data) {
      const header = Buffer.from(JSON.stringify({sessionId, cursor}), 'utf8');
      const body = Buffer.allocUnsafe(5 + header.length + data.length);
      body.writeUInt8(1, 0); body.writeUInt32LE(header.length, 1); header.copy(body, 5); data.copy(body, 5 + header.length);
      send(body);
    },
  };
}

async function startFailOnceRuntime(data, pipe) {
  const credential = `desktop-quit-${randomUUID()}`;
  await writeFile(join(data, 'runtime.credential'), credential);
  const sockets = new Set();
  const outputPeers = new Set();
  const subscriptions = new Map();
  const errors = [];
  let shutdownAttempts = 0;
  let closed = false;
  const servers = [];
  const snapshot = () => ({
    epoch: 'desktop-quit-failure-epoch', revision: 0, projects: [], sessions: [], workspaces: [], inbox: [], providers: [],
    settings: {revision: 0, theme: 'system', language: 'zh-CN', notifications: {native: false, attention: false, completed: false, sound: false}},
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolveClose => server.close(() => resolveClose()))));
  };
  const listen = (name, kind) => new Promise((resolveListen, rejectListen) => {
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      const peer = framed(socket);
      const nonce = randomUUID();
      let authenticated = false;
      peer.json({kind: 'challenge', nonce, protocol: 1, contract: PROTOCOL_CONTRACT});
      peer.onFrame(frame => {
        try {
          if (!authenticated) {
            const auth = JSON.parse(frame.toString('utf8'));
            assert.equal(auth.kind, 'auth');
            assert.equal(auth.protocol, 1); assert.equal(auth.contract, PROTOCOL_CONTRACT);
            assert.equal(auth.hmac, createHmac('sha256', credential).update(`1:${auth.clientId}:${nonce}`).digest('hex'));
            authenticated = true;
            peer.json({kind: 'authenticated', principal: auth.clientId, epoch: 'desktop-quit-failure-epoch', contract: PROTOCOL_CONTRACT, hmac: createHmac('sha256', credential).update(`server:1:${auth.clientId}:${nonce}`).digest('hex')});
            if (kind === 'output') outputPeers.add(peer);
            return;
          }
          if (kind === 'output') {
            const frameKind = frame.readUInt8(0);
            const headerLength = frame.readUInt32LE(1);
            const header = JSON.parse(frame.subarray(5, 5 + headerLength).toString('utf8'));
            if (frameKind === 3) subscriptions.set(peer, header.sessionId);
            return;
          }
          const request = JSON.parse(frame.toString('utf8'));
          if (!request?.method) return;
          if (request.method === 'runtime.snapshot') peer.json({v: 1, id: request.id, result: snapshot()});
          else if (request.method === 'catalog.visibility.list' || request.method === 'project.catalog.list') peer.json({v: 1, id: request.id, result: []});
          else if (request.method === 'runtime.shutdown') {
            shutdownAttempts++;
            if (shutdownAttempts === 1) peer.json({v: 1, id: request.id, error: {code: 'qa_shutdown_failure', message: 'forced shutdown failure'}});
            else {
              peer.json({v: 1, id: request.id, result: null});
              setTimeout(() => { void close(); }, 50);
            }
          } else peer.json({v: 1, id: request.id, error: {code: 'qa_unexpected_request', message: `Unexpected QA request: ${request.method}`}});
        } catch (error) {
          errors.push(error);
          socket.destroy();
        }
      });
    });
    servers.push(server);
    server.once('error', rejectListen);
    server.listen(name, resolveListen);
  });
  await Promise.all([listen(`${pipe}-control`, 'control'), listen(`${pipe}-output`, 'output')]);
  return {
    close,
    get shutdownAttempts() { return shutdownAttempts; },
    get errors() { return [...errors]; },
    hasSubscription(sessionId) { return [...subscriptions.values()].includes(sessionId); },
    sendOutput(sessionId, cursor, text) {
      const data = Buffer.from(text, 'utf8');
      for (const peer of outputPeers) if (subscriptions.get(peer) === sessionId) peer.output(sessionId, cursor, data);
    },
  };
}

async function closeRuntime(data, pipe) {
  try {
    const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
    const peer = await connectPeer(`${pipe}-control`);
    try {
      const challenge = JSON.parse((await peer.next()).toString('utf8'));
      assert.equal(challenge.protocol, 1); assert.equal(challenge.contract, PROTOCOL_CONTRACT);
      const clientId = randomUUID();
      peer.json({kind:'auth', clientId, protocol:1, contract:PROTOCOL_CONTRACT, nonce:challenge.nonce, hmac:createHmac('sha256', credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});
      const authenticated = JSON.parse((await peer.next()).toString('utf8'));
      assert.equal(authenticated.kind, 'authenticated'); assert.equal(authenticated.contract, PROTOCOL_CONTRACT);
      assert.equal(authenticated.hmac, createHmac('sha256', credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
      await peer.request('runtime.shutdown', {operationId: randomUUID()});
    }
    finally { peer.close(); }
  } catch { /* runtime may already be gone or was intentionally never started */ }
}

async function buildLateRuntimeWrapper() {
  const source = join(scratch, 'late-runtime-wrapper.cs');
  const executable = join(scratch, 'late-runtime-wrapper.exe');
  await writeFile(source, `
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class LateRuntimeWrapper {
  public static int Main() {
    var marker = Environment.GetEnvironmentVariable("TT_QA_LATE_RUNTIME_MARKER");
    var runtime = Environment.GetEnvironmentVariable("TT_QA_REAL_RUNTIME");
    if (String.IsNullOrEmpty(marker) || String.IsNullOrEmpty(runtime)) return 2;
    try { using (File.Open(marker + ".lock", FileMode.CreateNew, FileAccess.Write, FileShare.None)) {} }
    catch (IOException) { return 0; }
    File.WriteAllText(marker, "started");
    Thread.Sleep(1500);
    var start = new ProcessStartInfo(runtime) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
    using (var child = Process.Start(start)) {
      if (child == null) return 3;
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await promisify(execFile)(compiler, ['-nologo', `-out:${executable}`, source], {windowsHide:true, timeout:20_000});
  return executable;
}

function isolatedEnvironment(data, userData, pipe, runtimePath) {
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime|threadterm_v3_dev_server_url)$/i.test(key))),
    Path: [process.env.SystemRoot + '\\System32', process.execPath.slice(0, process.execPath.lastIndexOf('\\'))].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
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

async function launch(name, runtimePath, beforeLaunch, extraEnvironment = {}) {
  const data = join(scratch, `${name}-data`);
  const userData = join(scratch, `${name}-user-data`);
  const project = join(scratch, `${name}-project`);
  const pipe = `\\\\.\\pipe\\threadterm-desktop-quit-${randomUUID()}`;
  await Promise.all([mkdir(data), mkdir(userData), mkdir(project)]);
  const fixture = await beforeLaunch?.({data, userData, pipe, project});
  const app = await electron.launch({args: [harness, '--disable-features=CalculateNativeWinOcclusion', '--disable-gpu', '--in-process-gpu', '--no-sandbox'], env: {...isolatedEnvironment(data, userData, pipe, runtimePath), ...extraEnvironment}, timeout: 30_000});
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.threadterm), {timeout: 15_000});
  await app.evaluate(() => {
    if (!globalThis.__desktopQuitQa.menu) throw new Error('Tray menu was not created');
  });
  return {app, page, data, pipe, project, fixture};
}

const checks = [];
let active;
let noActive;
let failure;
let late;
try {
  active = await launch('active', runtime);
  await active.page.evaluate(async () => {
    const snapshot = await window.threadterm.request('runtime.snapshot', {});
    await window.threadterm.request('settings.update', {patch: {language: 'en', notifications: {native:false, attention:false, completed:false, sound:false}}, expectedRevision: snapshot.settings.revision, operationId: crypto.randomUUID()});
  });
  const session = await active.page.evaluate(async ({cwd}) => await window.threadterm.request('session.create', {
    cwd, title: 'desktop quit QA', provider: 'custom', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], operationId: crypto.randomUUID(),
  }), {cwd: active.project});
  await waitFor(async () => await active.page.evaluate(async id => (await window.threadterm.request('runtime.snapshot', {})).sessions.some(row => row.id === id && row.status === 'running'), session.id), 'active terminal');
  await active.page.evaluate(() => window.threadterm.windowAction('close'));
  await waitFor(() => active.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), 'main window to become hidden');

  await active.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(async () => (await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length)) === 1, 'active-session confirmation');
  const hiddenDialog = await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs[0]);
  assert.equal(hiddenDialog.parentVisible, true, 'Quit must show the hidden main window before parenting an active-session confirmation');
  const stillRunning = await active.page.evaluate(async id => (await window.threadterm.request('runtime.snapshot', {})).sessions.some(row => row.id === id && row.status === 'running'), session.id);
  assert.equal(hiddenDialog.noLink, true);
  assert.equal(hiddenDialog.iconPresent, true);
  assert.equal(hiddenDialog.defaultId, 0); assert.equal(hiddenDialog.cancelId, 0);
  assert.deepEqual(hiddenDialog.buttons, ['Keep running', 'Exit application']);
  assert.equal(stillRunning, true, 'cancelling Quit keeps the real active session running');
  checks.push('hidden-window confirmation is parented to a visible window', 'cancel keeps the active session running');

  await active.page.evaluate(async () => {
    const snapshot = await window.threadterm.request('runtime.snapshot', {});
    await window.threadterm.request('settings.update', {patch: {language: 'zh-CN'}, expectedRevision: snapshot.settings.revision, operationId: crypto.randomUUID()});
  });
  await active.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(async () => (await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length)) === 2, 'localized active-session confirmation');
  const localized = await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs[1]);
  assert.deepEqual(localized.buttons, ['继续运行', '退出应用']);
  assert.equal(localized.title, '退出 ThreadTerm？');
  checks.push('native confirmation reads the current runtime locale and uses safe ordinary buttons');

  if (process.env.TT_QA_QUIT_VISUAL === '1') {
    const captureScript = join(scratch, 'capture-dialog.ps1');
    await writeFile(captureScript, `param([int]$OwnerPid,[long]$OwnerHandle,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class QuitDialogCapture {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
 [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 public struct RECT { public int left,top,right,bottom; }
 public static IntPtr Find(uint owner, IntPtr parent) { var popup=GetWindow(parent,6); if(popup!=IntPtr.Zero && popup!=parent)return popup; popup=GetLastActivePopup(parent); if(popup!=IntPtr.Zero && popup!=parent)return popup; IntPtr result=IntPtr.Zero; EnumWindows((h,p)=>{uint id; GetWindowThreadProcessId(h,out id); var s=new StringBuilder(80); GetClassName(h,s,80); if(id==owner && s.ToString()=="#32770"){result=h;return false;} return true;},IntPtr.Zero); return result; }
 public static int CommandLinks(IntPtr parent) { int count=0; EnumChildWindows(parent,(h,p)=>{var s=new StringBuilder(80);GetClassName(h,s,80);int type=GetWindowLong(h,-16)&15;if(s.ToString()=="Button"&&(type==14||type==15))count++;return true;},IntPtr.Zero);return count; }
}
'@
[void][QuitDialogCapture]::SetProcessDPIAware()
$dialogHandle=[IntPtr]::Zero
$parentHandle=[IntPtr]::new($OwnerHandle)
$deadline=[DateTime]::UtcNow.AddSeconds(10)
while($dialogHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline){$dialogHandle=[QuitDialogCapture]::Find([uint32]$OwnerPid,$parentHandle); Start-Sleep -Milliseconds 50}
if($dialogHandle -eq [IntPtr]::Zero){throw 'Owned native dialog not found'}
try {
 Start-Sleep -Milliseconds 250
 $rectangle=New-Object QuitDialogCapture+RECT
 [void][QuitDialogCapture]::GetWindowRect($dialogHandle,[ref]$rectangle)
 $bitmap=New-Object Drawing.Bitmap(($rectangle.right-$rectangle.left),($rectangle.bottom-$rectangle.top))
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 $dc=$graphics.GetHdc()
 try {$printed=[QuitDialogCapture]::PrintWindow($dialogHandle,$dc,2)} finally {$graphics.ReleaseHdc($dc)}
 $bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)
 $graphics.Dispose();$bitmap.Dispose()
 @{printed=$printed;commandLinks=[QuitDialogCapture]::CommandLinks($dialogHandle);width=($rectangle.right-$rectangle.left);height=($rectangle.bottom-$rectangle.top)} | ConvertTo-Json -Compress
} finally { [void][QuitDialogCapture]::PostMessage($dialogHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
`);
    const ownerHandle = await active.app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
      if (!window) throw new Error('Visible dialog owner is unavailable');
      const handle = window.getNativeWindowHandle();
      return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
    });
    await active.app.evaluate(() => {globalThis.__desktopQuitQa.response='real';setTimeout(()=>globalThis.__desktopQuitQa.clickQuit(),100);});
    const captured = await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-File',captureScript,'-OwnerPid',String(active.app.process().pid),'-OwnerHandle',ownerHandle,'-OutputPath',join(visualOut,'quit-native-zh.png')], {windowsHide:true, timeout:20_000});
    const metrics=JSON.parse(captured.stdout.trim());
    assert.equal(metrics.printed,true); assert.equal(metrics.commandLinks,0);
    await waitFor(() => active.page.evaluate(async id => (await window.threadterm.request('runtime.snapshot',{})).sessions.some(row=>row.id===id&&row.status==='running'),session.id), 'native close cancellation preserves the session');
    await writeFile(join(visualOut,'native-metrics.json'),JSON.stringify(metrics,null,2));
    checks.push('actual native dialog has ordinary buttons and closing it preserves active work');
  }

  await active.app.evaluate(() => { globalThis.__desktopQuitQa.response = 'defer'; globalThis.__desktopQuitQa.clickQuit(); globalThis.__desktopQuitQa.clickQuit(); });
  await delay(500);
  assert.equal(await active.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length), process.env.TT_QA_QUIT_VISUAL === '1' ? 4 : 3, 'two rapid tray clicks share one pending Quit operation');
  await active.app.evaluate(() => globalThis.__desktopQuitQa.releaseDialogs(1));
  await waitFor(() => pipeOpen(`${active.pipe}-control`).then(open => !open), 'runtime pipe release after confirmed quit');
  await delay(500);
  assert.equal(await pipeOpen(`${active.pipe}-control`), false, 'confirmed Quit must not restart the runtime after shutdown');
  checks.push('rapid Quit clicks are single-flight', 'confirmed Quit releases the real runtime pipe without restart');

  noActive = await launch('no-active', runtime);
  const noActiveProcess = noActive.app.process();
  const noActiveSnapshot = await noActive.page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
  assert.equal(noActiveSnapshot.sessions.some(row => ['starting', 'running', 'idle', 'waiting'].includes(row.status)), false);
  await noActive.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(() => pipeOpen(`${noActive.pipe}-control`).then(open => !open), 'no-active runtime pipe release');
  await waitFor(() => noActiveProcess.exitCode !== null, 'no-active desktop exit');
  await delay(500);
  assert.equal(await pipeOpen(`${noActive.pipe}-control`), false, 'no-active Quit must not relaunch the runtime');
  checks.push('no-active Quit exits without a confirmation and leaves the runtime stopped');

  failure = await launch('failure', join(scratch, 'must-not-auto-launch.exe'), ({data, pipe}) => startFailOnceRuntime(data, pipe));
  const failureProcess = failure.app.process();
  await failure.page.evaluate(async () => {
    window.__desktopQuitFailureBytes = 0;
    window.__desktopQuitFailureUnsubscribe = await window.threadterm.subscribeOutput('qa-retained', 0, chunk => { window.__desktopQuitFailureBytes += chunk.data.length; });
  });
  await waitFor(() => failure.fixture.hasSubscription('qa-retained'), 'failure fixture output subscription');
  await failure.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(async () => (await failure.app.evaluate(() => globalThis.__desktopQuitQa.dialogs.length)) === 1, 'localized shutdown failure');
  const failedDialog = await failure.app.evaluate(() => globalThis.__desktopQuitQa.dialogs[0]);
  assert.equal(failedDialog.title, 'ThreadTerm 未能停止运行时');
  assert.equal(failedDialog.message, 'forced shutdown failure');
  assert.equal(failedDialog.detail, '应用将保持打开，保留正在运行的工作。');
  assert.equal(failure.fixture.shutdownAttempts, 1);
  failure.fixture.sendOutput('qa-retained', 0, 'retained-after-failure');
  await waitFor(() => failure.page.evaluate(() => window.__desktopQuitFailureBytes > 0), 'retained output after shutdown failure');
  assert.equal(await failure.page.evaluate(() => Boolean(window.threadterm)), true, 'shutdown failure keeps the desktop open');
  await failure.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(() => pipeOpen(`${failure.pipe}-control`).then(open => !open), 'retry shutdown after failure');
  await waitFor(() => failureProcess.exitCode !== null, 'desktop exit after retry');
  assert.equal(failure.fixture.shutdownAttempts, 2);
  assert.deepEqual(failure.fixture.errors, []);
  checks.push('localized no-active shutdown failure keeps the app open and preserves subscriptions', 'a second Quit succeeds after shutdown failure recovery');

  const lateWrapper = await buildLateRuntimeWrapper();
  const lateMarker = join(scratch, 'late-runtime-started');
  late = await launch('late', lateWrapper, undefined, {TT_QA_REAL_RUNTIME: runtime, TT_QA_LATE_RUNTIME_MARKER: lateMarker});
  const lateProcess = late.app.process();
  await waitFor(() => readFile(lateMarker).then(() => true, () => false), 'owned late runtime startup');
  const lateQuitStarted = Date.now();
  await late.app.evaluate(() => globalThis.__desktopQuitQa.clickQuit());
  await waitFor(() => lateProcess.exitCode !== null, 'late-bind desktop exit', 20_000);
  assert.ok(Date.now() - lateQuitStarted >= 700, 'Quit must wait for the already-owned startup instead of exiting before its delayed bind');
  await delay(2_000);
  assert.equal(await pipeOpen(`${late.pipe}-control`), false, 'late startup must be observed and shut down without an orphaned runtime');
  checks.push('Quit waits for an already-owned late runtime bind and leaves no orphaned daemon');

  for (const check of checks) console.log(`PASS ${check}`);
  console.log(JSON.stringify({passed: true, checks, scratch}));
} finally {
  if (active) { await active.app.evaluate(({app}) => app.exit(0)).catch(() => {}); await active.app.close().catch(() => {}); await closeRuntime(active.data, active.pipe); }
  if (noActive) { await noActive.app.evaluate(({app}) => app.exit(0)).catch(() => {}); await noActive.app.close().catch(() => {}); await closeRuntime(noActive.data, noActive.pipe); }
  if (failure) { await failure.app.evaluate(({app}) => app.exit(0)).catch(() => {}); await failure.app.close().catch(() => {}); await failure.fixture.close().catch(() => {}); }
  if (late) { await late.app.evaluate(({app}) => app.exit(0)).catch(() => {}); await late.app.close().catch(() => {}); await closeRuntime(late.data, late.pipe); }
  const scratchRelative = relative(resolve(tmpdir()), resolve(scratch));
  assert.ok(scratchRelative && !scratchRelative.startsWith('..') && !isAbsolute(scratchRelative), 'cleanup stays inside the temporary QA root');
  try { await rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 250}); } finally { await releaseLock(); }
}
