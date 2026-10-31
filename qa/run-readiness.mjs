// Desktop-1 QA for Run 1e: a saved service command starts a tiny Node TCP server on a free
// port after ~1.5 s and prints no URL at all. The Run view's Running row must go Starting →
// Ready on the port readiness found (with `:port`), the URL link must appear only then, must
// open the preview at that exact address, and Stop must still end the run.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-readiness.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build as esbuild} from 'esbuild';
import {electron} from './lib/desktop1.mjs'; // virtual Desktop 1; never focuses the user's desktop
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe');
const gitExe = process.env.THREADTERM_TEST_GIT ?? onPath('git');
const delay = ms => new Promise(done => setTimeout(done, ms));
const isFile = path => typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isFile();
function onPath(name) {
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const extension of ['', ...extensions]) {
      const candidate = join(directory, name + extension);
      if (directory && isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// Prerequisites first: a missing runtime or Git must not leave scratch behind.
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-readiness-'));
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
// Fixture PATH: Node and System32 only.
const fixturePath = [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options)$/i.test(key)));
Object.assign(env, {
  Path: fixturePath, PATH: fixturePath, LANGUAGE: 'C',
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-readiness-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime,
});
assert.equal(Object.keys(env).filter(key => /^git_/i.test(key)).length, 0, 'fixture strips inherited GIT_* variables');

const git = (...args) => execFileSync(gitExe, args, {cwd: work, windowsHide: true, encoding: 'utf8', env});
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const snapshot = () => request('runtime.snapshot');
async function until(test, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const value = await test();
      if (value) return value;
    } catch {}
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await delay(200);
  }
}
const active = session => ['starting', 'running', 'idle', 'waiting'].includes(session?.status ?? '');
const runningRow = commandId => page.locator(`[data-testid="run-running-row"][data-run-entry="${commandId}"]`);

const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, completed = false;
try {
  await mkdir(work, {recursive: true});
  // A TCP listener that says nothing: only the process tree's listening port can reveal it.
  const server = `import net from 'node:net';import {writeFileSync} from 'node:fs';\n`
    + `const server=net.createServer(socket=>socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\nContent-Type: text/plain\\r\\n\\r\\nlistens'));\n`
    + `setTimeout(()=>server.listen(0,'127.0.0.1',()=>writeFileSync('port.txt',String(server.address().port))),1500);\n`
    + `process.on('SIGTERM',()=>process.exit(0));\n`;
  await writeFile(join(work, 'server.mjs'), server);
  // The "quiet idle" scenario runs this service: it stays alive without ever listening, so the run is
  // deterministically still waiting (not racing an immediate exit) until the probe stops it.
  await writeFile(join(work, 'idle.mjs'), `setInterval(()=>{}, 1000);\nprocess.on('SIGTERM',()=>process.exit(0));\n`);
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run readiness QA');
  git('add', '.'); git('commit', '-m', 'fixture');

  await mkdir(rendererDir, {recursive: true});
  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  // The production Run view through its real side bar host, run from a saved command.
  const source = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QuickLaunchMenu} from './renderer/src/components/QuickLaunch';
import {WorkbenchSideBar} from './renderer/src/components/WorkbenchSideBar';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const work=${JSON.stringify(work)};
function Probe(){
 const [snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[command,setCommand]=useState({view:'run',key:'initial'}),[opened,setOpened]=useState(),[preview,setPreview]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run readiness QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(value=>setError(String(value)));},[]);
 useEffect(()=>{if(!project)return;let live=true;const poll=async()=>{for(;live;){try{setSnapshot(await window.threadterm.request('runtime.snapshot',{}));}catch{}await new Promise(done=>setTimeout(done,300));}};void poll();return()=>{live=false;};},[project]);
 if(error)return <p role='alert'>{error}</p>;
 if(!project||!snapshot)return <p>Starting isolated runtime…</p>;
 const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{},openSession:id=>setOpened(id),openPreview:url=>setPreview(url)};
 return <I18nProvider locale='en'><section className='runtime-workspace' data-run-workbench style={{width:1100}}>
  <QuickLaunchMenu projectId={project} root={work} data={snapshot} onOpenSession={id=>setOpened(id)} onOpenPreview={url=>setPreview(url)} onOpenRunView={()=>setCommand({view:'run',key:crypto.randomUUID()})}/>
  <div style={{display:'flex',gap:12,alignItems:'flex-start'}}>
   <WorkbenchSideBar scope={{projectId:project,worktreePath:work,rootPath:work}} actions={actions} sessions={[]} allSessions={snapshot.sessions} command={command} zh={false}/>
   <p data-testid='opened-session' style={{fontSize:11}}>{opened}</p>
   <p data-testid='preview-url' style={{fontSize:11}}>{preview}</p>
  </div>
 </section></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-readiness-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-readiness-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
  // One saved service command: a Node server that prints nothing at all.
  const projectId = await until(async () => await page.evaluate(() => window.__projectId), 'the fixture project is ready');
  const command = await request('quickLaunch.save', {projectId, name: 'quiet server', command: 'node server.mjs', shell: 'cmd', cwd: '', kind: 'service', env: [], operationId: randomUUID()});
  const view = page.getByTestId('run-view');
  await view.waitFor();

  // Run it from its row.
  await until(async () => await view.getByTestId(`quick-launch-command-${command.id}`).count(), 'the saved command is listed');
  await view.getByTestId(`quick-launch-command-${command.id}`).locator('[data-run-primary]').click();
  const row = runningRow(command.id);
  await row.first().waitFor();
  // The runtime marks a service run `waiting`, so the row says Starting while the server sleeps.
  const starting = await until(async () => (await snapshot()).sessions.find(candidate => candidate.run?.commandId === command.id && candidate.run?.readiness === 'waiting'), 'the watched run is waiting');
  assert.equal(starting.run.readiness, 'waiting');
  await until(async () => (await row.first().getByTestId('run-running-state').getAttribute('data-state')) === 'starting', 'the row shows Starting');
  assert.equal(await row.first().getByTestId('run-url').count(), 0, 'no URL exists before the server listens');
  check('A service run that has not listened yet shows Starting in the Running row');

  // Ready once the run's own process tree listens, with the port it found.
  const ready = await until(async () => {
    const id = await row.first().getAttribute('data-session-id');
    const session = (await snapshot()).sessions.find(candidate => candidate.id === id);
    return session?.run?.readiness === 'ready' && session;
  }, 'the run becomes ready on its listening port');
  assert.equal(ready.run.urlSource, 'port', 'the address comes from the port');
  assert.match(ready.run.url, /^http:\/\/localhost:\d+\/$/);
  const portFile = await until(async () => { try { return String(await readFile(join(work, 'port.txt'), 'utf8')).trim() || undefined; } catch {} }, 'the fixture wrote the port it listens on');
  assert.equal(ready.run.port, Number(portFile), 'the ready port is the one the fixture listens on');
  assert.equal(ready.run.url, `http://localhost:${portFile}/`);
  await until(async () => (await snapshot()).sessions.find(candidate => candidate.id === ready.id)?.run?.readiness === 'ready', 'the row reaches ready state');
  await until(async () => (await row.first().getByTestId('run-running-state').getAttribute('data-state')) === 'ready', 'the row shows Ready');
  assert.equal((await row.first().getByTestId('run-port').innerText()).trim(), `:${portFile}`);
  assert.equal((await row.first().getAttribute('data-run-entry')), command.id);
  check(`The Running row turns Ready with :${portFile} once the run's own listener appears`);

  // The URL link appears and opens the preview at the port that was found.
  const link = row.first().getByTestId('run-url');
  await link.waitFor();
  assert.equal(await link.getAttribute('data-pending'), null);
  assert.equal(await link.getAttribute('href'), `http://localhost:${portFile}/`);
  await link.click();
  await until(async () => (await page.getByTestId('preview-url').innerText()).trim() === `http://localhost:${portFile}/`, 'Open Preview receives the run URL');
  check('The URL link opens the preview at the port readiness found');

  // Stop still ends the run and empties Running.
  await row.first().getByTestId('run-stop').click();
  await until(async () => !(await snapshot()).sessions.some(candidate => candidate.id === ready.id && active(candidate)), 'Stop ends the run');
  await page.waitForFunction(id => !document.querySelector(`[data-testid="run-running-row"][data-run-entry="${id}"]`), command.id);
  const ended = (await snapshot()).sessions.find(candidate => candidate.id === ready.id);
  assert.equal(ended.run.stopRequested, true);
  check('Stop ends the readiness-ready run and clears its Running row');

  // A service with a configured preview address is not openable until it listens, and a
  // run stopped before it listens must not stay "waiting" for ever: the watcher settles
  // it, so a dead run's configured preview is openable again.
  const project = await page.evaluate(() => window.__projectId);
  const configuredUrl = 'http://localhost:3999/';
  const quiet = await request('quickLaunch.save', {projectId: project, name: 'quiet idle', command: 'node idle.mjs', shell: 'cmd', cwd: '', kind: 'service', env: [], previewUrl: configuredUrl, operationId: randomUUID()});
  await until(async () => await view.getByTestId(`quick-launch-command-${quiet.id}`).count(), 'the configured command is listed');
  await view.getByTestId(`quick-launch-command-${quiet.id}`).locator('[data-run-primary]').click();
  const quietRow = runningRow(quiet.id).first();
  await quietRow.waitFor();
  // The row shows the configured address, but it is not a link yet.
  const pendingLink = quietRow.getByTestId('run-url');
  await pendingLink.waitFor();
  assert.equal(await pendingLink.getAttribute('data-pending'), 'true');
  assert.equal(await pendingLink.getAttribute('aria-disabled'), 'true');
  assert.match(await pendingLink.getAttribute('title'), /Waiting for the server to listen/);
  assert.equal((await pendingLink.innerText()).trim(), ':3999', 'pending preview keeps its compact configured port visible');
  check('A watching service shows its configured preview as disabled in the Running row');

  const quietId = await quietRow.getAttribute('data-session-id');
  await quietRow.getByTestId('run-stop').click();
  await until(async () => !(await snapshot()).sessions.some(candidate => candidate.id === quietId && active(candidate)), 'Stop ends the quiet run');
  await until(async () => (await snapshot()).sessions.find(candidate => candidate.id === quietId)?.run?.readiness !== 'waiting', 'the stopped run settles its readiness');
  assert.equal((await snapshot()).sessions.find(candidate => candidate.id === quietId)?.run?.url, configuredUrl);
  check('Stopping the run before it listens preserves its configured preview address');

  assert.deepEqual(pageErrors, [], 'the probe page raised no error');

  for (const session of (await snapshot()).sessions.filter(active)) await request('session.stop', {sessionId: session.id, operationId: randomUUID()});
  completed = true;
  console.log(`PASS ${passed.length} checks`);
} finally {
  if (page) await Promise.race([page.evaluate(() => window.threadterm.request('runtime.shutdown', {operationId: crypto.randomUUID()})), delay(3000)]).catch(() => {});
  if (app) {
    await Promise.race([app.evaluate(({app: electronApp}) => electronApp.exit(0)), delay(2000)]).catch(() => {});
    await Promise.race([app.close(), delay(5000)]).catch(() => {});
    try { app.process()?.kill(); } catch {}
  }
  await releaseLock?.().catch(() => {});
  await rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 250}).catch(() => {});
}
if (!completed) process.exitCode = 1;
