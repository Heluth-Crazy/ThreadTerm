// Desktop-1 QA for the Maven, Gradle and Python detectors (Run 1c): the Run view groups the three ecosystems, a
// source-inferred Flask app shows the Suggested tag, the Gradle rows' disabled state matches the detected
// missingTool (never the machine), and a detected Maven `spring-boot:run` entry launches through the wrapper.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-detect-ecosystems.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, statSync} from 'node:fs';
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

// Prerequisites first: a missing runtime or Git must not leave scratch behind.
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-ecosystems-'));
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
// Fixture PATH: Node, Git's cmd folder and System32 only. Which of mvn/gradle/python are installed is irrelevant:
// the probe asserts on each row's detected missingTool instead of on this machine.
const gitCmd = dirname(gitExe);
const fixturePath = [dirname(process.execPath), gitCmd, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options)$/i.test(key)));
Object.assign(env, {
  Path: fixturePath, PATH: fixturePath, LANGUAGE: 'C',
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-ecosystems-${randomUUID()}`,
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
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, completed = false;
try {
  await mkdir(work, {recursive: true});
  await writeFile(join(work, 'pom.xml'), '<project>\n  <artifactId>probe-maven</artifactId>\n  <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>\n</project>\n');
  // A stand-in wrapper: it records its arguments instead of starting a Spring Boot app.
  await writeFile(join(work, 'mvnw.cmd'), '@echo off\r\necho %* > maven-args.txt\r\n');
  await writeFile(join(work, 'build.gradle'), "plugins {\n    id 'application'\n}\n");
  await writeFile(join(work, 'pyproject.toml'), '[project]\nname = "probe-python"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n');
  await writeFile(join(work, 'app.py'), 'from flask import Flask\napp = Flask(__name__)\n');
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run ecosystems QA');
  git('add', '.'); git('commit', '-m', 'fixture');

  await mkdir(rendererDir, {recursive: true});
  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  const source = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QuickLaunchMenu} from './renderer/src/components/QuickLaunch';
import {WorkbenchSideBar} from './renderer/src/components/WorkbenchSideBar';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const work=${JSON.stringify(work)};
function Probe(){
 const [snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[command,setCommand]=useState(),[switcherHost,setSwitcherHost]=useState(),[opened,setOpened]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run ecosystems QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(value=>setError(String(value)));},[]);
 useEffect(()=>{if(!project)return;let live=true;const poll=async()=>{for(;live;){try{setSnapshot(await window.threadterm.request('runtime.snapshot',{}));}catch{}await new Promise(done=>setTimeout(done,300));}};void poll();return()=>{live=false;};},[project]);
 if(error)return <p role='alert'>{error}</p>;
 if(!project||!snapshot)return <p>Starting isolated runtime…</p>;
 const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{},openSession:id=>setOpened(id),openPreview:()=>{}};
 return <I18nProvider locale='en'><section className='runtime-workspace' data-run-workbench data-run-workbench-host='run-ecosystems-qa' data-run-project-id={project} data-run-worktree-path={work} style={{width:1100}}>
  <QuickLaunchMenu projectId={project} root={work} data={snapshot} onOpenSession={id=>setOpened(id)} onOpenRunView={()=>setCommand({view:'run',key:crypto.randomUUID()})}/>
  <div ref={setSwitcherHost}/>
  <div style={{display:'flex',gap:12,alignItems:'flex-start'}}>
   <WorkbenchSideBar scope={{projectId:project,worktreePath:work,rootPath:work}} actions={actions} sessions={[]} allSessions={snapshot.sessions} command={command} switcherHost={switcherHost} zh={false}/>
   <p data-testid='opened-session' style={{fontSize:11}}>{opened}</p>
  </div>
 </section></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-detect-ecosystems-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-ecosystems-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => console.error(`Renderer error: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
  await page.locator('.ql-trigger').waitFor();

  // The Run view groups each ecosystem from the files alone; no build tool ran to list them.
  await page.locator('.ql-trigger').click();
  await page.getByTestId('quick-launch-menu').waitFor();
  await page.getByTestId('open-run-view').click();
  const view = page.getByTestId('run-view');
  await view.waitFor();
  const mavenGroup = view.getByTestId('run-group-detected:maven');
  const gradleGroup = view.getByTestId('run-group-detected:gradle');
  const pythonGroup = view.getByTestId('run-group-detected:python');
  await mavenGroup.waitFor(); await gradleGroup.waitFor(); await pythonGroup.waitFor();
  assert.match(await mavenGroup.innerText(), /Maven/i);
  assert.match(await mavenGroup.innerText(), /pom\.xml/);
  assert.match(await gradleGroup.innerText(), /Gradle/i);
  assert.match(await pythonGroup.innerText(), /Python/i);
  assert.match(await pythonGroup.innerText(), /-m flask --app app\.py:app run/);
  check('The Run view shows Maven, Gradle and Python groups detected from the fixture files');

  // A source-inferred app is tagged as a suggestion, with the tooltip that asks for a look first.
  const flask = view.getByTestId('quick-launch-detected-entry-python:app.py:flask');
  await flask.waitFor();
  const suggested = flask.locator('[data-suggested="true"]');
  await suggested.waitFor();
  assert.equal((await suggested.innerText()).trim(), 'Suggested');
  assert.equal(await suggested.getAttribute('title'), 'Found in source code; check the command before saving.');
  // The declared pytest entry is not a suggestion.
  const pytest = view.getByTestId('quick-launch-detected-entry-python:pyproject.toml:pytest');
  await pytest.waitFor();
  assert.equal(await pytest.locator('[data-suggested="true"]').count(), 0, 'a manifest entry is not a suggestion');
  check('The Flask row shows the Suggested tag with its tooltip; the pytest row does not');

  // The Gradle rows are disabled exactly when detection reports the missing tool, never per machine.
  const projectId = await page.evaluate(() => window.__projectId);
  const detected = await request('quickLaunch.detect', {projectId, cwd: work});
  const gradleRun = detected.entries.find(entry => entry.key === 'gradle:build.gradle:run');
  assert.ok(gradleRun, `the application plugin produces a run entry: ${JSON.stringify(detected.entries.map(entry => entry.key))}`);
  assert.equal(gradleRun.command, 'gradle run');
  const gradleRow = view.getByTestId('quick-launch-detected-entry-gradle:build.gradle:run');
  await gradleRow.waitFor();
  const gradleRunButton = gradleRow.getByRole('button', {name: 'Run', exact: true});
  if (gradleRun.missingTool) {
    assert.equal(await gradleRunButton.isDisabled(), true, 'a row whose tool is missing cannot run');
    assert.match((await gradleRow.getAttribute('title')) ?? '', new RegExp(`${escape(gradleRun.missingTool)} isn't on PATH`));
  } else {
    assert.equal(await gradleRunButton.isDisabled(), false, 'gradle is on the runtime PATH here, so the row runs');
  }
  check(`The Gradle rows match their detected missingTool (${gradleRun.missingTool ?? 'gradle present'})`);

  // Running the detected Maven service launches the wrapper in the Maven root with the detected goal.
  const mavenRow = view.getByTestId('quick-launch-detected-entry-maven:pom.xml:spring-boot:run');
  await mavenRow.waitFor();
  await mavenRow.getByRole('button', {name: 'Run', exact: true}).click();
  const id = await until(async () => (await page.getByTestId('opened-session').innerText()).trim() || undefined, 'the view opens the Maven run terminal');
  const session = await until(async () => {
    const run = (await snapshot()).sessions.find(candidate => candidate.id === id);
    return run?.run?.commandId === 'detected:maven:pom.xml:spring-boot:run' && run;
  }, 'the Maven run records its detected key');
  assert.equal(session.run.commandId, 'detected:maven:pom.xml:spring-boot:run');
  assert.equal(session.run.kind, 'service');
  await until(() => existsSync(join(work, 'maven-args.txt')), 'the wrapper ran');
  assert.match(readFileSync(join(work, 'maven-args.txt'), 'utf8'), /spring-boot:run/);
  check('Running the Maven spring-boot:run entry starts a session with commandId "detected:maven:pom.xml:spring-boot:run"');

  // Leaving runs active would turn runtime shutdown into failed Inbox items.
  for (const item of (await snapshot()).sessions.filter(item => ['starting', 'running', 'idle', 'waiting'].includes(item.status))) {
    await request('session.stop', {sessionId: item.id, operationId: randomUUID()});
  }
  await until(async () => !(await snapshot()).sessions.some(item => ['starting', 'running', 'idle', 'waiting'].includes(item.status)), 'every run ends');
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
