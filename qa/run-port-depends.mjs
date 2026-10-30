// Isolated Desktop 1 phase 4 QA: silent allocated-port services, dependency ordering,
// restart reuse, and manual/automatic setup through the Run view.
// Set THREADTERM_V3_RUNTIME_BIN and THREADTERM_TEST_GIT, then:
//   node qa/run-port-depends.mjs
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

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-port-depends-'));
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
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-port-depends-${randomUUID()}`,
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
  // Both services are silent: readiness must follow their allocated process-tree port.
  await writeFile(join(work, 'db.mjs'), "import net from 'node:net';import{writeFileSync}from'node:fs';setTimeout(()=>net.createServer(s=>s.end()).listen(Number(process.argv[2]),'127.0.0.1',()=>writeFileSync('db-ready',String(Date.now()))),1000);\n");
  await writeFile(join(work, 'api.mjs'), "import http from 'node:http';import{writeFileSync}from'node:fs';writeFileSync('api-env',process.env.RUN_PORT);writeFileSync('api-started',String(Date.now()));http.createServer((_q,r)=>r.end('ok')).listen(Number(process.argv[2]),'127.0.0.1');\n");
  await writeFile(join(work, 'setup.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('setup.done','done');\n");
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run port dependencies QA');
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
 const [snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[command,setCommand]=useState(),[opened,setOpened]=useState(),[preview,setPreview]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run port dependencies QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(value=>setError(String(value)));},[]);
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
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-port-depends-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-port-depends-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
  await page.locator('.ql-trigger').waitFor();

  const projectId = await page.evaluate(() => window.__projectId);
  const save = (name, command, kind, extra = {}) => request('quickLaunch.save', {projectId, name, command, shell: 'cmd', cwd: '', kind, env: [], ...extra, operationId: randomUUID()});
  const db = await save('db', 'node db.mjs ${port}', 'service');
  const api = await save('api', 'node api.mjs ${port}', 'service', {dependsOn: [db.id], env: [{name: 'RUN_PORT', value: '${port}'}], previewUrl: 'http://localhost:${port}/'});
  const setup = await save('fixture setup', 'node setup.mjs', 'task');
  await page.locator('.ql-trigger').click();
  await page.getByTestId('open-run-view').click();
  const view = page.getByTestId('run-view');
  await view.waitFor();
  await until(async () => await view.getByTestId(`quick-launch-command-${api.id}`).count(), 'api saved row');
  await view.getByTestId(`quick-launch-command-${api.id}`).getByRole('button', {name: 'Run'}).click();
  await until(async () => (await view.getByTestId('run-sequence-chip').innerText()).includes('Starting db (1/2)'), 'dependency sequence progress');
  const startingDb = await until(async () => (await snapshot()).sessions.find(s => s.run?.commandId === db.id && s.run?.readiness === 'waiting'), 'db waiting for its allocated listener');
  assert.match(await runningRow(db.id).innerText(), new RegExp(`:${startingDb.run.allocatedPort ?? startingDb.run.port}`), 'allocated port appears before readiness');

  const apiRun = await until(async () => (await snapshot()).sessions.find(s => s.run?.commandId === api.id && s.run?.readiness === 'ready'), 'api ready after db');
  const dbRun = (await snapshot()).sessions.find(s => s.run?.commandId === db.id && active(s));
  assert.equal(dbRun.run.readiness, 'ready');
  assert.equal(apiRun.run.url, `http://localhost:${apiRun.run.allocatedPort ?? apiRun.run.port}/`);
  const apiPort = apiRun.run.allocatedPort ?? apiRun.run.port;
  const dbPort = dbRun.run.allocatedPort ?? dbRun.run.port;
  assert.ok(apiPort && dbPort && apiPort !== dbPort, 'services use distinct allocated ports');
  assert.equal(await readFile(join(work, 'api-env'), 'utf8'), String(apiPort));
  assert.ok(Number(await readFile(join(work, 'api-started'), 'utf8')) >= Number(await readFile(join(work, 'db-ready'), 'utf8')), 'api starts after db listens');
  assert.match(await runningRow(api.id).innerText(), new RegExp(`:${apiPort}`));
  assert.match(await runningRow(db.id).innerText(), new RegExp(`:${dbPort}`));
  check('dependency sequence waits for the silent db; silent api receives its distinct port in command, env and preview');
  await runningRow(api.id).getByTestId('run-restart').click();
  const restarted = await until(async () => (await snapshot()).sessions.find(s => s.id !== apiRun.id && s.run?.commandId === api.id && s.run?.readiness === 'ready' && active(s)), 'api restart ready');
  assert.equal(restarted.run.allocatedPort ?? restarted.run.port, apiPort, 'restart reuses free allocation');
  assert.equal((await snapshot()).sessions.filter(s => s.run?.commandId === db.id && active(s)).length, 1);
  check('restart preserves the port and reuses the active dependency');

  await view.getByTestId(`run-row-menu-${api.id}`).click();
  await page.getByRole('menuitem', {name: 'Edit command…'}).click();
  const editor = page.getByRole('dialog');
  await editor.waitFor();
  await until(async () => (await editor.getByTestId('quick-launch-port-preview').innerText()).includes(String(apiPort)), 'editor resolved allocation preview');
  await editor.getByRole('button', {name: 'Save', exact: true}).click();
  await editor.waitFor({state: 'hidden'});
  assert.equal((await request('quickLaunch.list', {projectId})).find(command => command.id === api.id).previewUrl, 'http://localhost:${port}/');
  check('editor saves the preview template and displays the allocated value');

  const section = view.getByTestId('run-setup-section');
  await section.waitFor();
  await section.getByRole('button', {name: /Edit setup|Edit|编辑/}).click();
  await section.getByRole('checkbox', {name: /fixture setup/}).check();
  await section.getByRole('button', {name: /^(Save|保存)$/}).click();
  assert.deepEqual((await request('quickLaunch.setup.read', {projectId})).commandIds, [setup.id]);
  await section.getByRole('button', {name: /Run now|立即运行/}).click();
  await until(async () => existsSync(join(work, 'setup.done')), 'Run view setup writes marker');
  const second = join(scratch, 'second');
  await request('worktree.create', {projectId, path: second, branch: 'phase4-setup', createBranch: true, operationId: randomUUID()});
  await until(async () => existsSync(join(second, 'setup.done')), 'new worktree automatic setup writes marker');
  await until(async () => (await request('quickLaunch.setup.status', {projectId})).some(run => run.trigger === 'worktree.create' && run.state === 'completed'), 'automatic setup completes');
  check('setup is edited and run in the Run view and automatically runs in a new worktree');
  assert.deepEqual(pageErrors, []);
  for (const session of (await snapshot()).sessions.filter(active)) await request('session.stop', {sessionId: session.id, operationId: randomUUID()});
  await until(async () => !(await snapshot()).sessions.some(active), 'every fixture run stops');
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
