// Desktop-1 QA for detected run entries (Run 1a): read-only detection, running by key, opening the
// existing run, "Save as command…" prefill and a missing-tool row that stays disabled.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-detected.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
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

// Prerequisites first: a missing runtime, Git or npm must not leave scratch behind.
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
const npm = ['npm.cmd', 'npm.exe', 'npm.bat'].map(name => join(dirname(process.execPath), name)).find(isFile) ?? onPath('npm');
assert.ok(isFile(npm), 'This probe needs npm next to Node or on PATH for the fixture dev script');

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-detected-'));
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
// Fixture PATH: Node (npm), Git's cmd folder and System32 only.
const gitCmd = dirname(gitExe);
const fixturePath = [dirname(process.execPath), gitCmd, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options)$/i.test(key)));
Object.assign(env, {
  Path: fixturePath, PATH: fixturePath, LANGUAGE: 'C',
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-detected-${randomUUID()}`,
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
const samePath = (left, right) => String(left ?? '').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(right ?? '').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const detectedRow = key => page.getByTestId(`quick-launch-detected-entry-${key}`);
const openMenu = async () => {
  await page.locator('.ql-trigger').click();
  await page.getByTestId('quick-launch-menu').waitFor();
};

const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, completed = false;
try {
  await mkdir(work, {recursive: true});
  const server = `import http from 'node:http';const server=http.createServer((_q,res)=>res.end('<!doctype html><title>Run detected</title><h1>detected dev</h1>'));server.listen(0,'127.0.0.1',()=>{console.log('  Local:   http://localhost:'+server.address().port+'/');});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  await writeFile(join(work, 'server.mjs'), server);
  await writeFile(join(work, 'package.json'), JSON.stringify({name: 'run-detected-fixture', private: true, scripts: {dev: 'node server.mjs', build: 'node -e "process.exit(0)"'}}, null, 2));
  await writeFile(join(work, 'Makefile'), 'build:\n\t@echo make build\n\n# comment\ntest:\n\t@echo make test\n');
  await writeFile(join(work, 'Procfile'), 'missing: tt-qa-definitely-missing-tool --serve\n');
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run detected QA');
  git('add', '.'); git('commit', '-m', 'fixture');

  await mkdir(rendererDir, {recursive: true});
  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  const source = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QuickLaunchMenu} from './renderer/src/components/QuickLaunch';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const work=${JSON.stringify(work)};
function Probe(){
 const [snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[opened,setOpened]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run detected QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(value=>setError(String(value)));},[]);
 useEffect(()=>{if(!project)return;let live=true;const poll=async()=>{for(;live;){try{setSnapshot(await window.threadterm.request('runtime.snapshot',{}));}catch{}await new Promise(done=>setTimeout(done,400));}};void poll();return()=>{live=false;};},[project]);
 if(error)return <p role='alert'>{error}</p>;
 if(!project||!snapshot)return <p>Starting isolated runtime…</p>;
 return <I18nProvider locale='en'><main style={{padding:16}}><QuickLaunchMenu data={snapshot} projectId={project} root={work} onOpenSession={id=>setOpened(id)}/>{opened&&<p data-testid='opened-session'>{opened}</p>}</main></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-detected-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-detected-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => console.error(`Renderer error: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 900));
  await page.locator('.ql-trigger').waitFor();

  // Both groups: the saved list is empty, detected entries come from package.json and the Makefile.
  await openMenu();
  const menu = page.getByTestId('quick-launch-menu');
  await menu.getByTestId('quick-launch-detected').waitFor();
  const nodeSection = menu.getByTestId('quick-launch-detected-node');
  const makeSection = menu.getByTestId('quick-launch-detected-make');
  await nodeSection.waitFor(); await makeSection.waitFor();
  assert.match(await nodeSection.innerText(), /Node scripts/);
  assert.match(await makeSection.innerText(), /Makefile/);
  await menu.getByText('No saved commands').waitFor();
  const devRow = detectedRow('node:package.json:dev');
  await devRow.waitFor();
  assert.match(await devRow.innerText(), /npm run dev/);
  assert.ok(await detectedRow('make:Makefile:build').count(), 'Makefile build target is detected');
  assert.ok(await detectedRow('node:package.json:build').count(), 'the non-service build script is detected too');
  check('The popover shows the empty Saved group and Detected groups from package.json and the Makefile');

  // A missing tool disables the row up front and never launches anything.
  const missingRow = detectedRow('procfile:Procfile:missing');
  await missingRow.waitFor();
  const missingRun = missingRow.getByRole('button', {name: 'Run'});
  assert.equal(await missingRun.isDisabled(), true, 'a missing-tool row cannot run');
  assert.match((await missingRow.getAttribute('title')) ?? '', /tt-qa-definitely-missing-tool isn't on PATH/);
  assert.equal((await snapshot()).sessions.filter(session => session.run?.commandId === 'detected:procfile:Procfile:missing').length, 0);
  check('A missing-tool row is disabled with "<tool> isn’t on PATH" and starts no session');

  // Run dev by key: the runtime re-detects and launches it as an ordinary run.
  await devRow.getByRole('button', {name: 'Run'}).click();
  const opened = await page.getByTestId('opened-session').innerText();
  const running = await until(async () => {
    const session = (await snapshot()).sessions.find(item => item.id === opened);
    return session?.run?.commandId === 'detected:node:package.json:dev' && session.run.url && session;
  }, 'detected dev run becomes running with a URL');
  assert.ok(samePath(running.worktreePath, work));
  assert.equal(running.run.kind, 'service');
  assert.match(running.run.url, /^http:\/\/localhost:\d+\/$/);
  check('Run launches the detected dev entry by key and records commandId "detected:<key>" with its printed URL');

  // Reopening the menu offers the existing run instead of a second process.
  await openMenu();
  const existing = detectedRow('node:package.json:dev');
  const openButton = existing.getByRole('button', {name: 'Open terminal'});
  await openButton.waitFor();
  await openButton.click();
  assert.equal(await page.getByTestId('opened-session').innerText(), running.id);
  const same = (await snapshot()).sessions.filter(item => item.run?.commandId === 'detected:node:package.json:dev' && samePath(item.worktreePath, work));
  assert.equal(same.length, 1, 'a second click opens the one existing run');
  check('A second Run opens the existing detected run without starting another process');

  // "Save as command…" opens the ordinary editor prefilled from the detected entry.
  await openMenu();
  await detectedRow('node:package.json:dev').getByRole('button', {name: /Save as command/}).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Save as command/);
  assert.equal(await dialog.getByRole('textbox', {name: 'Name'}).inputValue(), 'dev');
  assert.equal(await dialog.getByRole('textbox', {name: 'Command'}).inputValue(), 'npm run dev');
  assert.equal(await dialog.getByRole('textbox', {name: 'Working directory'}).inputValue(), '');
  await dialog.getByRole('textbox', {name: 'Name'}).fill('detected dev copy');
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
  const projectId = await page.evaluate(() => window.__projectId);
  const saved = await until(async () => (await request('quickLaunch.list', {projectId})).find(command => command.name === 'detected dev copy'), 'the saved copy appears');
  assert.equal(saved.command, 'npm run dev');
  assert.equal(saved.shell, 'cmd');
  assert.equal(saved.kind, 'service');
  check('"Save as command…" opens the editor prefilled and saving creates an ordinary saved command');

  // Leaving the run active would turn runtime shutdown into a failed Inbox item.
  await request('session.stop', {sessionId: running.id, operationId: randomUUID()});
  await until(async () => ['exited', 'error', 'interrupted'].includes((await snapshot()).sessions.find(item => item.id === running.id)?.status ?? ''), 'the detected run ends');
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
