// Two isolated runtimes, one desktop. The host's pipe is used only for setup/revoke;
// all application work on the host travels through the pinned peer TLS profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { connectPeer } from './pipe-client.mjs';

const hostingProbe = process.env.THREADTERM_QA_MACHINE_HOSTING === '1';
const treeProbe = process.env.THREADTERM_QA_MACHINE_TREE === '1';
const browserProbe = process.env.THREADTERM_QA_MACHINE_BROWSER === '1';
const signInProbe = process.env.THREADTERM_QA_MACHINE_SIGN_IN === '1';
const filesProbe = process.env.THREADTERM_QA_MACHINE_FILES === '1';
const root = resolve(import.meta.dirname, '..');
const qaTemp = /[\\/]tt-qa-temp$/i.test(tmpdir()) ? tmpdir() : join(tmpdir(), 'tt-qa-temp');
await mkdir(qaTemp, { recursive: true });
process.env.TEMP = qaTemp; process.env.TMP = qaTemp;
const scratch = await mkdtemp(join(qaTemp, 'remote-basic-'));
const out = join(root, hostingProbe ? 'qa/results/remote-machine-hosting' : signInProbe ? 'qa/results/remote-machine-sign-in' : browserProbe ? 'qa/results/remote-machine-browser' : filesProbe ? 'qa/results/remote-machine-files' : treeProbe ? 'qa/results/remote-machine-tree' : 'qa/results/remote-machine-basic');
await mkdir(out, { recursive: true });
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), 'Build and copy the QA runtime first');
const bin = join(scratch, 'provider-bin'), hostWork = join(scratch, 'host-project'), clientWork = join(scratch, 'client-project'), control = join(scratch, 'control');
for (const directory of [bin, hostWork, clientWork, control]) await mkdir(directory);
await writeFile(join(control, 'connect-delay-ms'), '0');
const browserScenarios = browserProbe ? await import('./remote-machine-browser-scenarios.mjs') : undefined;
const browserFixtures = await browserScenarios?.setupRemoteBrowserProbe(scratch);
const signInScenarios = signInProbe ? await import('./remote-machine-sign-in-scenarios.mjs') : undefined;
const signInFixtures = await signInScenarios?.setupRemoteSignInProbe(scratch);
const fake = join(root, hostingProbe ? 'qa/fixtures/fake-codex-hosting.cjs' : signInProbe ? 'qa/fixtures/fake-codex-sign-in.cjs' : browserProbe ? 'qa/fixtures/browser-agent-reads/codex.cjs' : treeProbe ? 'qa/fixtures/fake-codex-machine-tree.cjs' : 'qa/fixtures/fake-codex-connect-transition.cjs');
await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
const report = { passed: false, checks: [], errors: [], cleanup: [], scratch, ...(browserProbe?{acceptancePassed:false,limitations:[],blockedChecks:[]}: {}) };
const note = (message, blocked=false) => { if(signInProbe)(report.notes ??= []).push(message);if(browserProbe){report.limitations.push(message);if(blocked)report.blockedChecks.push(message);}console.log(`NOTE ${message}`); };
const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
function environment(kind) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'home', 'userprofile', 'appdata', 'localappdata', 'codex_home', 'electron_run_as_node'].includes(key.toLowerCase()) && !key.toLowerCase().startsWith('threadterm_')));
  Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    TEMP: qaTemp, TMP: qaTemp, HOME: join(scratch, kind, 'home'), USERPROFILE: join(scratch, kind, 'home'), APPDATA: join(scratch, kind, 'appdata'), LOCALAPPDATA: join(scratch, kind, 'localappdata'), CODEX_HOME: join(scratch, kind, 'codex'),
    THREADTERM_V3_DATA: join(scratch, kind, 'data'), THREADTERM_V3_USER_DATA: join(scratch, kind, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-remote-${kind}-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_QA_REMOTE_BIND: '127.0.0.1', THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_QA_TRANSITION_CONTROL: control, THREADTERM_QA_TRANSITION_LOG: join(scratch, `${kind}-provider.jsonl`), THREADTERM_QA_TRANSITION_CWD: kind === 'host' ? hostWork : clientWork });
  if(browserProbe){env.THREADTERM_QA_BROWSER_EVENTS=join(scratch,`${kind}-browser-events.jsonl`);env.THREADTERM_QA_BROWSER_CWD=kind==='host'?hostWork:clientWork;env.THREADTERM_QA_BROWSER_URL=`http://localhost:${browserFixtures.port}`;if(kind==='host')env.THREADTERM_QA_TUNNEL_PORT_MAP=browserFixtures.portMap;}
  if(signInProbe){env.THREADTERM_QA_SIGN_IN_LOG=join(scratch,`${kind}-sign-in.jsonl`);env.THREADTERM_QA_SIGN_IN_KIND=kind;env.THREADTERM_QA_SIGN_IN_URL=signInFixtures.url??'';env.THREADTERM_QA_SIGN_IN_PORT=String(signInFixtures.hostPort??0);if(kind==='host'&&signInFixtures.portMap)env.THREADTERM_QA_TUNNEL_PORT_MAP=signInFixtures.portMap;}
  return env;
}
const hostEnv = environment('host'), clientEnv = environment('client');
if (filesProbe) {
  const clientLog = join(clientWork, 'client-attachment.log');
  await writeFile(clientLog, 'CLIENT LOG CONTENT\n' + 'x'.repeat(2 * 1024 * 1024));
  clientEnv.THREADTERM_V3_ATTACH_FILES_QA = clientLog;
}
let browserReceipt;
let host, hostPeer, app, hostApp, built, releaseLock, localPage, remotePage, attentionSession;
const rpc = (page, method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const hosting = hostingProbe ? new (await import('./remote-machine-hosting-scenarios.mjs')).HostingProbe({ scratch, runtime, hostEnv, environment, rpc, until, pass, out, report }) : undefined;
try {
  if (hosting) {
    built = await buildQaApp(); releaseLock = await acquireElectronQaLock();
    await hosting.startA(built);
  } else host = spawn(runtime, [], { env: hostEnv, windowsHide: true, stdio: 'ignore' });
  await until(async () => {
    let candidate;
    try {
      candidate = await connectPeer(`${hostEnv.THREADTERM_V3_PIPE}-control`);
      const secret = (await readFile(join(hostEnv.THREADTERM_V3_DATA, 'runtime.credential'), 'utf8')).trim();
      await candidate.auth(secret); hostPeer = candidate; return true;
    } catch { candidate?.close(); if (host && host.exitCode !== null) throw new Error('Isolated host runtime exited'); return false; }
  }, 'host admin pipe');
  const hostSnapshot = await hostPeer.request('runtime.snapshot');
  await hostPeer.request('settings.update', { patch: { remoteMachines: { enabled: true }, language: 'en', theme: 'dark', themeSelection: 'dark', notifications: { native: false } }, expectedRevision: hostSnapshot.settings.revision, operationId: randomUUID() });
  await hostPeer.request('device.enable', { operationId: randomUUID() });
  const hostProject = await hostPeer.request('project.add', { path: hostWork, name: 'Host-only project', operationId: randomUUID() });
  const offer = await hostPeer.request('device.pairing.create', { permission: 'fullcontrol', profile: 'desktop', operationId: randomUUID() });
  assert.equal(new URL(offer.serverUrl).hostname, '127.0.0.1', 'debug QA binding advertises the reachable loopback endpoint');
  pass('second runtime uses isolated data/pipe, loopback binding and a desktop offer');

  if (!built) { built = await buildQaApp(); releaseLock = await acquireElectronQaLock(); }
  app = await electron.launch({ args: [built.appDir], env: clientEnv, timeout: 30000 });
  localPage = await app.firstWindow();
  await localPage.waitForFunction(() => !!window.threadterm);
  const localSnapshot = await rpc(localPage, 'runtime.snapshot');
  await localPage.getByRole('button', { name: 'Local user', exact: true }).click();
  await localPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await localPage.getByRole('tab', { name: 'Computers', exact: true }).click();
  const gated = localPage.getByRole('region', { name: 'Computers', exact: true });
  await gated.getByText('Enable Computers preview', { exact: true }).waitFor();
  assert.equal(await gated.getByLabel('Paste pairing text from the other computer', { exact: true }).count(), 0);
  await localPage.getByRole('tab', { name: 'Phones', exact: true }).waitFor();
  await localPage.getByRole('button', { name: 'Close settings', exact: true }).click();
  pass('gate off shows only the Computers switch while Phones stays available');
  await rpc(localPage, 'settings.update', { patch: { remoteMachines: { enabled: true }, language: 'en', theme: 'dark', themeSelection: 'dark', notifications: { native: treeProbe, attention: true, completed: false, sound: false } }, expectedRevision: localSnapshot.settings.revision, operationId: randomUUID() });
  const clientProject = await rpc(localPage, 'project.add', { path: clientWork, name: 'Client-only project', operationId: randomUUID() });
  const slowWork = join(scratch, 'client-slow'), badWork = join(scratch, 'client-bad');
  await mkdir(slowWork); await mkdir(badWork);
  const slowProject = await rpc(localPage, 'project.add', { path: slowWork, name: 'Slow project', operationId: randomUUID() });
  const badProject = await rpc(localPage, 'project.add', { path: badWork, name: 'Retry project', operationId: randomUUID() });
  // Hold one project's details across the pairing/remount and reject another. The catalog list itself is healthy.
  // Inject at main's IPC boundary so the real renderer, preload and runtime routing still participate.
  await app.evaluate(({ ipcMain, BrowserWindow }, { slowId, badId }) => {
    const original = ipcMain._invokeHandlers.get('threadterm:request');
    const senderId = BrowserWindow.getAllWindows()[0].webContents.id;
    let released = false;
    const pending = new Promise(resolve => { globalThis.__releaseCatalogDetails = () => { released = true; resolve(); }; });
    globalThis.__catalogFaults = { slow: 0, failed: 0 };
    ipcMain.removeHandler('threadterm:request');
    ipcMain.handle('threadterm:request', async (event, method, params) => {
      if (event.sender.id === senderId && method === 'worktree.list') {
        if (params.projectId === slowId && !released) { globalThis.__catalogFaults.slow++; await pending; }
        if (params.projectId === badId && !globalThis.__catalogFaults.failed++) throw new Error('QA temporary worktree failure');
      }
      return original(event, method, params);
    });
  }, { slowId: slowProject.id, badId: badProject.id });
  await until(async () => (await localPage.evaluate(() => window.threadterm.machineList())).enabled, 'client preview enabled');
  await localPage.getByRole('button', { name: 'Local user', exact: true }).click();
  await localPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await localPage.getByRole('tab', { name: 'Computers', exact: true }).click();
  const settings = localPage.getByRole('region', { name: 'Computers', exact: true });
  await settings.getByLabel('Paste pairing text from the other computer', { exact: true }).fill(offer.qrPayload);
  await settings.getByLabel('Name', { exact: true }).fill('Office-PC');
  await settings.getByLabel('Color', { exact: true }).fill('#3fb8a6');
  await settings.getByRole('button', { name: 'Check computer', exact: true }).click();
  const checkCode = offer.tlsFingerprint.replace(/:/g, '').toUpperCase().slice(0, 12).match(/.{1,4}/g).join(' ');
  await settings.getByText(checkCode, { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Codes match — Add computer', exact: true }).click();
  await settings.getByText('Computer added. Choose it in the sidebar.', { exact: true }).waitFor();
  const registry = await localPage.evaluate(() => window.threadterm.machineList());
  const machine = registry.machines.find(item => item.name === 'Office-PC'); assert.ok(machine);
  assert.ok(!JSON.stringify(registry).includes('credential'));
  const saved = JSON.parse(await readFile(join(clientEnv.THREADTERM_V3_USER_DATA, 'machines.json'), 'utf8'));
  assert.ok(saved[0].encryptedCredential); assert.equal(saved[0].credential, undefined);
  pass('real Computers UI checks the pin, compares the code, pairs and stores an encrypted credential');
  await localPage.getByRole('button', { name: 'Close settings', exact: true }).click();
  // Once a second computer joins, This PC's own catalog moves under its machine row: it must still list its projects,
  // and again after the row is collapsed and expanded.
  const ownCatalog = localPage.locator('.machine-group[data-machine-id="local"]').getByText('Client-only project', { exact: true });
  await until(async () => await ownCatalog.count() > 0, 'This PC lists its own project after pairing', 15000);
  await localPage.locator('.machine-group[data-machine-id="local"] .machine-disclosure').click();
  await until(async () => await ownCatalog.count() === 0, 'This PC collapses', 5000);
  await localPage.locator('.machine-group[data-machine-id="local"] .machine-disclosure').click();
  await until(async () => await ownCatalog.count() > 0, 'This PC lists its own project after collapse and expand', 15000);
  pass('This PC keeps its own catalog after pairing and after collapse/expand');
  const ownGroup = localPage.locator('.machine-group[data-machine-id="local"]');
  for (const name of ['Slow project', 'Retry project']) await ownGroup.getByText(name, { exact: true }).waitFor({ timeout: 5000 });
  assert.equal((await rpc(localPage, 'project.catalog.list')).length, 3);
  const faults = await app.evaluate(() => globalThis.__catalogFaults);
  assert.ok(faults.slow > 0 && faults.failed > 0, 'both slow and failing detail requests reached the renderer');
  assert.equal(await ownGroup.getByText('No projects yet. Add a directory to get started.', { exact: true }).count(), 0);
  await app.evaluate(() => globalThis.__releaseCatalogDetails());
  pass('several local projects stay visible across pairing/remount while one worktree list stalls and another fails');
  if (treeProbe) {
    await until(async () => (await localPage.evaluate(() => window.threadterm.machineTree())).machines.find(row => row.machine.id === machine.id)?.machine.state === 'connected', 'control-only watcher connected without opening a host view');
    assert.equal(app.context().pages().length, 1, 'watcher creates no renderer view');
    await app.evaluate(({ Notification }) => {
      globalThis.__machineToasts = [];
      Notification.prototype.show = function () { globalThis.__machineToasts.push({ title: this.title, body: this.body, target: this }); this.emit('show'); };
    });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
    attentionSession = await hostPeer.request('session.create', { projectId: hostProject.id, cwd: hostWork, provider: 'codex', mode: 'chat', title: 'Host approval', operationId: randomUUID() });
    const lease = await hostPeer.request('session.claim', { sessionId: attentionSession.id, clientId: 'tree-setup' });
    await hostPeer.request('chat.connect', { sessionId: attentionSession.id, leaseEpoch: lease.leaseEpoch, operationId: randomUUID() });
    await hostPeer.request('chat.send', { sessionId: attentionSession.id, text: 'TREE-APPROVAL', leaseEpoch: lease.leaseEpoch, operationId: randomUUID() });
    await hostPeer.request('session.release', { sessionId: attentionSession.id, leaseEpoch: lease.leaseEpoch });
    await until(async () => (await localPage.evaluate(() => window.threadterm.machineTree())).machines.find(row => row.machine.id === machine.id)?.sessions.some(row => row.session.id === attentionSession.id && row.needsYou > 0), 'host attention reaches This PC tree');
    await localPage.locator('.remote-project-catalog .sess-row').filter({ hasText: 'Host approval' }).waitFor();
    await localPage.locator(`.machine-group[data-machine-id="${machine.id}"] .machine-row .badge`).waitFor();
    await until(() => app.evaluate(() => globalThis.__machineToasts.length === 1), 'exactly one remote notification');
    await delay(400);
    assert.equal(await app.evaluate(() => globalThis.__machineToasts.length), 1);
    const toast = await app.evaluate(() => globalThis.__machineToasts.map(({ title, body }) => ({ title, body })));
    assert.match(toast[0].title, /^Office-PC · Host approval/);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'ThreadTerm');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); });
    await localPage.screenshot({ path: join(out, 'this-pc-host-attention.png') });
    pass('while This PC is shown, host approval updates its tree/count and records exactly one machine-named notification');
    await localPage.locator('.remote-project-catalog .sess-row').filter({ hasText: 'Host approval' }).click();
  } else {
    const hostGroup = localPage.locator(`.machine-group[data-machine-id="${machine.id}"]`);
    await hostGroup.locator('.proj-row-wrap').filter({ hasText: 'Host-only project' }).hover();
    await hostGroup.getByRole('button', { name: 'New terminal in Host-only project', exact: true }).click();
  }
  remotePage = await until(async () => {
    for (const page of app.context().pages()) if (page !== localPage && await page.evaluate(() => window.threadterm?.machineId).catch(() => undefined) === machine.id) return page;
  }, 'remote WebContentsView renderer');
  await remotePage.getByText('Host-only project', { exact: true }).first().waitFor();
  await until(async () => await remotePage.locator('.machine-group[data-machine-id="local"]').getByText('Client-only project', { exact: true }).count() > 0, 'the host view lists This PC projects', 15000);
  pass('a computer view lists This PC projects under This PC');
  if (!treeProbe) {
    const firstCreator = remotePage.getByRole('dialog');
    await firstCreator.getByRole('textbox', { name: 'Local path', exact: true }).waitFor();
    assert.equal((await firstCreator.getByRole('textbox', { name: 'Local path', exact: true }).inputValue()).replaceAll('\\', '/'), hostWork.replaceAll('\\', '/'));
    assert.equal(await firstCreator.getByRole('combobox').first().getAttribute('data-value'), hostProject.id);
    await firstCreator.getByRole('button', { name: 'Cancel', exact: true }).click();
    pass('remote project plus creates the host view and delivers prefilled New session after its first load');
  }
  if (treeProbe) {
    await remotePage.getByTestId(`session-chat-${attentionSession.id}`).waitFor();
    await remotePage.evaluate(() => { window.__machineRetainedProof = 'retained'; });
    // A row click asks main asynchronously; wait for each switch before the next one, or a late one wins.
    const windowTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    await remotePage.locator('.machine-row').filter({ hasText: 'This PC' }).click();
    await until(async () => await windowTitle() === 'ThreadTerm', 'This PC shown');
    await localPage.locator('.remote-project-catalog .sess-row').filter({ hasText: 'Host approval' }).click();
    await until(async () => await windowTitle() === 'ThreadTerm — Office-PC', 'tree click shows the host');
    await remotePage.getByTestId(`session-chat-${attentionSession.id}`).waitFor();
    assert.equal(await remotePage.evaluate(() => window.__machineRetainedProof), 'retained', 'tree route does not reload a retained view');
    await remotePage.locator('.machine-row').filter({ hasText: 'This PC' }).click();
    await until(async () => await windowTitle() === 'ThreadTerm', 'This PC shown again');
    await app.evaluate(() => globalThis.__machineToasts[0].target.emit('click'));
    await until(async () => await windowTitle() === 'ThreadTerm — Office-PC', 'notification click shows the host');
    await remotePage.getByTestId(`session-chat-${attentionSession.id}`).waitFor();
    pass('host tree session and notification click route the correct retained view/session without reload');
  }
  const remoteSnapshot = await rpc(remotePage, 'runtime.snapshot');
  assert.ok(remoteSnapshot.projects.some(item => item.id === hostProject.id));
  assert.ok(!remoteSnapshot.projects.some(item => item.name === 'Client-only project'));
  assert.ok(!(await rpc(localPage, 'runtime.snapshot')).projects.some(item => item.id === hostProject.id));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'ThreadTerm — Office-PC');
  const chrome = await remotePage.locator('.titlebar').evaluate(element => ({ width: getComputedStyle(element).borderTopWidth, color: getComputedStyle(element).borderTopColor }));
  assert.equal(chrome.color, 'rgb(63, 184, 166)');
  assert.ok(Math.abs(parseFloat(chrome.width) - 3) <= 1 / await remotePage.evaluate(() => devicePixelRatio), '3px border within one physical pixel of DPI rounding');
  await remotePage.getByText('on Office-PC', { exact: true }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 1);
  assert.equal(await app.evaluate(({ session }, id) => session.fromPartition(`persist:machine-${id}`).getPreloadScripts().filter(script => script.filePath.endsWith('htmlPreviewSandboxPreload.cjs')).length, machine.id), 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
  await remotePage.waitForFunction(() => innerWidth === 1200 && innerHeight === 800);
  pass('one visible resized view has the host project, remote title, color line and header chip; sender routing stays isolated');
  await localPage.evaluate(() => localStorage.setItem('machine-partition-proof', 'local'));
  await remotePage.evaluate(() => localStorage.setItem('machine-partition-proof', 'remote'));
  assert.equal(await localPage.evaluate(() => localStorage.getItem('machine-partition-proof')), 'local');
  await remotePage.getByRole('button', { name: 'Local user', exact: true }).click();
  await remotePage.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of ['Computers', 'Phones', 'Data']) assert.equal(await remotePage.getByRole('tab', { name, exact: true }).count(), 0);
  await remotePage.getByRole('button', { name: 'Close settings', exact: true }).click();
  pass('remote settings hide host administration pages and machine partitions isolate localStorage');

  await remotePage.locator('.machine-row').filter({ hasText: 'This PC' }).click();
  await until(async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()) === 'ThreadTerm', 'This PC shown for remote row action');
  const hostRows = localPage.locator(`.machine-group[data-machine-id="${machine.id}"]`);
  await hostRows.locator('.proj-row-wrap').filter({ hasText: 'Host-only project' }).hover();
  await hostRows.getByRole('button', { name: 'Host-only project actions', exact: true }).click();
  await localPage.getByRole('menuitem', { name: 'New terminal', exact: true }).click();
  await until(async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()) === 'ThreadTerm — Office-PC', 'remote project action switches to the host');
  const creator = remotePage.getByRole('dialog');
  await creator.getByRole('textbox', { name: 'Local path', exact: true }).waitFor();
  assert.equal((await creator.getByRole('textbox', { name: 'Local path', exact: true }).inputValue()).replaceAll('\\', '/'), hostWork.replaceAll('\\', '/'));
  assert.equal(await creator.getByRole('combobox').first().getAttribute('data-value'), hostProject.id);
  assert.equal(await localPage.getByRole('dialog').count(), 0, 'This PC never opens the remote action locally');
  await remotePage.screenshot({ path: join(out, 'remote-new-session.png') });
  // A retained view can still own a dialog when another navigation switches computers. A fresh action replaces it.
  await creator.getByRole('textbox', { name: 'Local path', exact: true }).fill(join(hostWork, 'old-choice'));
  await remotePage.evaluate(() => window.threadterm.machineShow('local'));
  await hostRows.locator('.proj-row-wrap').filter({ hasText: 'Host-only project' }).hover();
  await hostRows.getByRole('button', { name: 'New terminal in Host-only project', exact: true }).click();
  await until(async () => (await creator.getByRole('textbox', { name: 'Local path', exact: true }).inputValue()).replaceAll('\\', '/') === hostWork.replaceAll('\\', '/'), 'a fresh remote action replaces retained dialog defaults');
  await creator.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('remote project menu switches to the host view and opens New session with the host project and directory prefilled');
  await remotePage.locator('.machine-row').filter({ hasText: 'This PC' }).click();
  await until(async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()) === 'ThreadTerm', 'This PC shown for machine menu');
  await assert.rejects(localPage.evaluate(id => window.threadterm.machineShow(id, undefined, { action: 'new-session', path: 42 }), machine.id), /Invalid machine navigation/);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'ThreadTerm', 'invalid navigation never switches views');
  await hostRows.locator('.machine-row-wrap').hover();
  await hostRows.getByRole('button', { name: 'Office-PC actions', exact: true }).click();
  await localPage.getByRole('menuitem', { name: 'New terminal', exact: true }).waitFor();
  await localPage.keyboard.press('Escape');
  assert.equal(await localPage.getByRole('menuitem', { name: 'New terminal', exact: true }).count(), 0);
  await hostRows.getByRole('button', { name: 'Office-PC actions', exact: true }).click();
  await localPage.getByRole('menuitem', { name: 'Add project', exact: true }).click();
  const projectCreator = remotePage.getByRole('dialog', { name: 'Add project', exact: true });
  await projectCreator.waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'ThreadTerm — Office-PC');
  assert.equal(await localPage.getByRole('dialog').count(), 0);
  await projectCreator.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('remote machine menu supports New session and Add project, Escape closes it, and invalid actions cannot switch computers');

  const session = await rpc(remotePage, 'session.create', { projectId: hostProject.id, cwd: hostWork, provider: 'codex', mode: 'chat', title: 'Remote Chat', operationId: randomUUID() });
  await rpc(remotePage, 'session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  let chat = remotePage.getByTestId(`session-chat-${session.id}`);
  await chat.locator('textarea').waitFor();
  await until(async () => {
    if (await chat.locator('textarea').isEnabled()) return true;
    if (hosting) {
      const take = chat.getByRole('button', { name: /^(Take control|Reclaim control)$/ });
      if (await take.isVisible().catch(() => false) && await take.isEnabled()) await take.click();
    }
    return false;
  }, 'remote Chat ready', 45000);
  await chat.locator('textarea').fill('Reply from the host.');
  await chat.locator('button[type=submit]').click();
  if(browserProbe)await chat.getByText(/^BROWSER_QA_RESULT /).waitFor({timeout:30000});else await chat.getByText('TRANSITION-SAVED-ANSWER', { exact: true }).waitFor({ timeout: 30000 });
  await remotePage.screenshot({ path: join(out, 'remote-chat.png') });
  pass('a Chat turn sent through peer TLS displays the fake host provider’s reply');
  if (filesProbe) {
    const { runRemoteFilesProbe } = await import('./remote-machine-files-scenarios.mjs');
    await runRemoteFilesProbe({ app, remotePage, localPage, rpc, until, pass, hostPeer, hostEnv, clientEnv, hostProject, session, hostWork, clientWork, scratch, out });
  }
  if(signInProbe)report.signIn=await signInScenarios.runRemoteSignInProbe({app,remotePage,localPage,rpc,until,pass,hostPeer,hostProject,session,hostWork,clientWork,scratch,out,machine,note,fixtures:signInFixtures});
  if(browserProbe)browserReceipt=await browserScenarios.runRemoteBrowserProbe({app,remotePage,localPage,rpc,until,pass,hostPeer,hostProject,session,hostWork,scratch,out,machine,note,fixtures:browserFixtures});
  const childPromise = app.waitForEvent('window', { predicate: page => page !== localPage && page !== remotePage, timeout: 15000 });
  await remotePage.evaluate(sessionId => window.threadterm.openWindow({ sessionId }), session.id);
  const child = await childPromise;
  await child.waitForFunction(() => !!window.threadterm);
  assert.equal(await child.evaluate(() => window.threadterm.machineId), machine.id);
  assert.ok((await rpc(child, 'runtime.snapshot')).projects.some(item => item.id === hostProject.id));
  assert.equal(await child.evaluate(() => localStorage.getItem('machine-partition-proof')), 'remote');
  await child.evaluate(() => window.threadterm.windowAction('maximize'));
  assert.equal((await child.evaluate(() => window.threadterm.windowState())).maximized, true);
  await child.evaluate(() => window.threadterm.windowAction('close')).catch(() => {});
  assert.equal(await app.evaluate(({ session }, id) => session.fromPartition(`persist:machine-${id}`).getPreloadScripts().filter(script => script.filePath.endsWith('htmlPreviewSandboxPreload.cjs')).length, machine.id), 1);
  pass('remote child windows inherit the machine/partition, share one session preparation and use their own window actions');
  if (treeProbe) {
    // One real local host window and one peer view compete for the same live PTY.
    hostApp = await electron.launch({ args: [built.appDir], env: hostEnv, timeout: 30000 });
    const hostPage = await hostApp.firstWindow();
    await hostPage.waitForFunction(() => !!window.threadterm);
    const terminal = await rpc(hostPage, 'session.create', { projectId: hostProject.id, cwd: hostWork, provider: 'shell', mode: 'terminal', title: 'Shared host terminal', executable: 'cmd.exe', args: ['/Q', '/K'], operationId: randomUUID() });
    await hostPage.locator('button.sess-row').filter({ hasText: 'Shared host terminal' }).first().click();
    await hostPage.locator('.terminal-host').waitFor();
    await until(async () => { try { const lease = await rpc(hostPage, 'session.claim', { sessionId: terminal.id, clientId: 'host-window' }); return lease.leaseEpoch; } catch { return false; } }, 'local window controls the terminal');
    await remotePage.evaluate(({ id, sessionId }) => window.threadterm.machineShow(id, sessionId), { id: machine.id, sessionId: terminal.id });
    const remoteTake = remotePage.getByRole('button', { name: 'Take control', exact: true });
    await remoteTake.waitFor({ timeout: 20000 }); await remoteTake.click(); await remoteTake.waitFor({ state: 'hidden' });
    const remoteLease = await rpc(remotePage, 'session.claim', { sessionId: terminal.id, clientId: 'remote-view' });
    await rpc(remotePage, 'terminal.input', { sessionId: terminal.id, leaseEpoch: remoteLease.leaseEpoch, data: 'echo REMOTE-TAKE-CONTROL\r' });
    await until(async () => { const value = await hostPeer.request('terminal.read', { sessionId: terminal.id, cursor: 0, limit: 65536 }); return Buffer.from(value.data, 'base64').toString().includes('REMOTE-TAKE-CONTROL'); }, 'remote input reaches same host terminal');
    const hostTake = hostPage.getByRole('button', { name: 'Take control', exact: true });
    await hostTake.waitFor({ timeout: 20000 }); await hostTake.click(); await hostTake.waitFor({ state: 'hidden' });
    const localLease = await rpc(hostPage, 'session.claim', { sessionId: terminal.id, clientId: 'host-window' });
    assert.ok(localLease.leaseEpoch > remoteLease.leaseEpoch);
    await assert.rejects(rpc(remotePage, 'terminal.input', { sessionId: terminal.id, leaseEpoch: remoteLease.leaseEpoch, data: 'STALE-MUST-NOT-WRITE' }), /stale_lease/);
    await rpc(hostPage, 'terminal.input', { sessionId: terminal.id, leaseEpoch: localLease.leaseEpoch, data: 'echo LOCAL-TAKE-CONTROL\r' });
    await rpc(hostPage, 'session.stop', { sessionId: terminal.id, operationId: randomUUID() });
    await hostApp.evaluate(({ app }) => app.exit(0)); await hostApp.close(); hostApp = undefined;
    pass('Take control works from local host window to remote view and back; stale peer input is fenced');
    await remotePage.evaluate(({ id, sessionId }) => window.threadterm.machineShow(id, sessionId), { id: machine.id, sessionId: session.id });
    await chat.locator('textarea').waitFor();
    await delay(400);
  }
  if (hosting) {
    ({ hostPeer, remotePage } = await hosting.run({ app, localPage, remotePage, hostPeer, machine, session, hostProject }));
    chat = remotePage.getByTestId(`session-chat-${session.id}`);
  }
  const paired = (await hostPeer.request('device.list')).find(item => item.profile === 'desktop' && (hosting ? !item.revokedAt : item.name === 'Office-PC')); assert.ok(paired);
  await hostPeer.request('device.revoke', { deviceId: paired.id, operationId: randomUUID() });
  await until(async () => (await remotePage.evaluate(() => window.threadterm.machineList())).machines.find(item => item.id === machine.id)?.state === 'disconnected', 'revoke disconnect state');
  if (treeProbe) await until(async () => (await chat.locator('textarea').count()) ? await chat.locator('textarea').isDisabled() : await remotePage.getByRole('heading', { name: 'Runtime unavailable', exact: true }).count() > 0, 'revoked view cannot accept input');
  else assert.equal(await chat.locator('textarea').isDisabled(), true);
  await remotePage.screenshot({ path: join(out, 'remote-disconnected.png') });
  pass('host Remove disconnects the live view and disables Chat input');
  await browserReceipt?.afterRevoke();
  await remotePage.locator('.machine-row').filter({ hasText: 'This PC' }).click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'ThreadTerm');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.getVisible()).length), 1);
  pass('switching back retains the local view and shows exactly one machine');
  await browserReceipt?.afterLocalSwitch();
  const finalLocal = await rpc(localPage, 'runtime.snapshot');
  await rpc(localPage, 'settings.update', { patch: { remoteMachines: { enabled: false } }, expectedRevision: finalLocal.settings.revision, operationId: randomUUID() });
  await until(async () => !(await localPage.evaluate(() => window.threadterm.machineList())).enabled, 'preview disabled');
  await until(() => remotePage.isClosed(), 'remote view closed with gate off');
  await localPage.waitForFunction(() => !document.querySelector('.machine-row'));
  assert.equal(await localPage.locator('.machine-row').count(), 0);
  pass('turning off the preview closes remote views and hides machine rows');
  report.passed = true;
  if(browserProbe)report.acceptancePassed=report.blockedChecks.length===0;
} catch (error) {
  if (hosting) {
    for (const [kind, env] of [['host', hostEnv], ['client', clientEnv]]) {
      await writeFile(join(out, `${kind}-provider-failure.jsonl`), await readFile(env.THREADTERM_QA_TRANSITION_LOG).catch(() => '')).catch(() => {});
    }
  }
  console.error(error);
  report.errors.push(error instanceof Error ? error.stack : String(error));
  await (remotePage ?? localPage)?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await hosting?.cleanup().catch(error => report.cleanup.push(String(error)));
  await browserFixtures?.cleanup();
  await signInFixtures?.cleanup().catch(error=>report.cleanup.push(String(error)));
  if (hostApp) { await hostApp.evaluate(({ app }) => app.exit(0)).catch(() => {}); await hostApp.close().catch(() => {}); }
  if (localPage) await rpc(localPage, 'runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  if (hostPeer) { await hostPeer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); hostPeer.close(); }
  if (host?.exitCode === null) { host.kill(); await Promise.race([new Promise(done => host.once('exit', done)), delay(5000)]); }
  await releaseLock?.();
  await built?.cleanup().catch(() => report.cleanup.push(built.appDir));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => report.cleanup.push(scratch));
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
