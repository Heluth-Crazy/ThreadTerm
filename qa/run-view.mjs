// Desktop-1 QA for the Run view (Run 1b): the popover's "Open Run view", a detected dev entry run from the view with
// its URL in Running, Restart giving a new session, Shift+F5 / Ctrl+F5 on the current configuration, the palette's
// "Run: build", and a second worktree's run listed with its worktree label.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-view.mjs
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

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-view-'));
const work = join(scratch, 'work'), second = join(scratch, 'second'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
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
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-view-${randomUUID()}`,
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
const active = session => ['starting', 'running', 'idle', 'waiting'].includes(session?.status ?? '');
const runsOf = (sessions, commandId) => sessions.filter(session => session.run?.commandId === commandId && samePath(session.worktreePath, work));
const runningRow = commandId => page.locator(`[data-testid="run-running-row"][data-run-entry="${commandId}"]`);

const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, completed = false;
try {
  await mkdir(work, {recursive: true});
  const server = `import http from 'node:http';const server=http.createServer((_q,res)=>res.end('<!doctype html><title>Run view</title><h1>run view dev</h1>'));server.listen(0,'127.0.0.1',()=>{console.log('  Local:   http://localhost:'+server.address().port+'/');});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  await writeFile(join(work, 'server.mjs'), server);
  await writeFile(join(work, 'package.json'), JSON.stringify({name: 'run-view-fixture', private: true, scripts: {dev: 'node server.mjs', build: 'node -e "process.exit(0)"'}}, null, 2));
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run view QA');
  git('add', '.'); git('commit', '-m', 'fixture');

  await mkdir(rendererDir, {recursive: true});
  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  const source = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QuickLaunchMenu} from './renderer/src/components/QuickLaunch';
import {WorkbenchSideBar} from './renderer/src/components/WorkbenchSideBar';
import {CommandPalette} from './renderer/src/components/CommandPalette';
import {runKeyCommand} from './renderer/src/workbench/runView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const work=${JSON.stringify(work)};
const host='run-view-qa';
function Probe(){
 const [snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[command,setCommand]=useState(),[palette,setPalette]=useState(false),[switcherHost,setSwitcherHost]=useState(),[opened,setOpened]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run view QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(value=>setError(String(value)));},[]);
 useEffect(()=>{if(!project)return;let live=true;const poll=async()=>{for(;live;){try{setSnapshot(await window.threadterm.request('runtime.snapshot',{}));}catch{}await new Promise(done=>setTimeout(done,300));}};void poll();return()=>{live=false;};},[project]);
 useEffect(()=>{const receive=event=>{const detail=event.detail;if(detail?.view!=='run')return;if(detail.run){if(detail.hostKey!==host)return;setCommand({view:'run',key:detail.key??crypto.randomUUID(),run:{...detail.run,key:detail.run.key??detail.key??crypto.randomUUID()}});}else setCommand({view:'run',key:detail.key??crypto.randomUUID()});};addEventListener('threadterm:workbench',receive);return()=>removeEventListener('threadterm:workbench',receive);},[]);
 // The F5 keys reach the Run view exactly as SessionWorkspace routes them, from any side bar view.
 useEffect(()=>{const key=event=>{const run=runKeyCommand(event);if(run){event.preventDefault();setCommand({view:'run',key:run.key,run});}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[]);
 if(error)return <p role='alert'>{error}</p>;
 if(!project||!snapshot)return <p>Starting isolated runtime…</p>;
 const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{},openSession:id=>setOpened(id),openPreview:url=>{window.__preview=url;}};
 return <I18nProvider locale='en'><section className='runtime-workspace' data-run-workbench data-run-workbench-host={host} data-run-project-id={project} data-run-worktree-path={work} style={{width:1100}}>
  <button type='button' onClick={()=>setPalette(true)}>Open palette</button>
  <QuickLaunchMenu projectId={project} root={work} data={snapshot} onOpenSession={id=>setOpened(id)} onOpenPreview={url=>{window.__preview=url;}} onOpenRunView={()=>setCommand({view:'run',key:crypto.randomUUID()})}/>
  <div ref={setSwitcherHost}/>
  <div style={{display:'flex',gap:12,alignItems:'flex-start'}}>
   <WorkbenchSideBar scope={{projectId:project,worktreePath:work,rootPath:work}} actions={actions} sessions={[]} allSessions={snapshot.sessions} command={command} switcherHost={switcherHost} zh={false}/>
   <p data-testid='opened-session' style={{fontSize:11}}>{opened}</p>
  </div>
  {palette&&<CommandPalette data={{...snapshot,inbox:[],providers:[]}} workbench onClose={()=>setPalette(false)} onSession={()=>{}} onProject={()=>{}} onCreate={()=>{}} onCreateGroup={()=>{}} onAll={()=>{}} onInbox={()=>{}} onSettings={()=>{}}/>}
 </section></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-view-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-view-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => console.error(`Renderer error: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
  await page.locator('.ql-trigger').waitFor();

  // The popover stays a compact launcher and opens the Run view from its footer.
  await page.locator('.ql-trigger').click();
  await page.getByTestId('quick-launch-menu').waitFor();
  await page.getByTestId('open-run-view').click();
  const view = page.getByTestId('run-view');
  await view.waitFor();
  await view.getByTestId('run-group-detected:node').waitFor();
  assert.match(await view.getByTestId('run-group-detected:node').innerText(), /Node scripts/i);
  assert.equal((await view.getByTestId('run-current').innerText()).trim(), 'None yet');
  // The view has no shortcut of its own: Ctrl+Shift+R is Electron's Force Reload.
  const runTitle = await page.locator('.wb-switch-btn[data-view="run"]').getAttribute('title');
  assert.match(runTitle, /^Run/);
  assert.doesNotMatch(runTitle, /Ctrl\+Shift\+R/);
  check('The popover opens the Run view; it lists detected entries and no current configuration yet');

  // Roving arrows move between the rows' primary buttons; Enter activates and Delete does nothing.
  const buildButton = view.getByTestId('quick-launch-detected-entry-node:package.json:build').getByRole('button', {name: 'Run'});
  const devButton = view.getByTestId('quick-launch-detected-entry-node:package.json:dev').getByRole('button', {name: 'Run'});
  await buildButton.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await devButton.evaluate(element => element === document.activeElement), true, 'ArrowDown moves to the next row');
  await page.keyboard.press('ArrowUp');
  assert.equal(await buildButton.evaluate(element => element === document.activeElement), true, 'ArrowUp moves back');
  await page.keyboard.press('Delete');
  assert.equal(await buildButton.evaluate(element => element === document.activeElement), true, 'Delete does nothing on a run row');
  check('Arrow keys rove between run rows while Delete does nothing');

  // The three keys are advertised exactly once on the header buttons.
  assert.equal(await page.getByTestId('run-current-run').getAttribute('aria-keyshortcuts'), 'Control+F5');
  assert.equal(await page.getByTestId('run-current-stop').getAttribute('aria-keyshortcuts'), 'Shift+F5');
  assert.equal(await page.getByTestId('run-current-restart').getAttribute('aria-keyshortcuts'), 'Control+Shift+F5');
  assert.match(await page.getByTestId('run-current-run').getAttribute('title'), /Ctrl\+F5/);
  assert.match(await page.getByTestId('run-current-restart').getAttribute('title'), /Ctrl\+Shift\+F5/);
  await page.getByRole('button', {name: 'About the current configuration'}).click();
  await view.locator('[role="note"]').waitFor();
  assert.match(await view.locator('[role="note"]').innerText(), /Ctrl\+F5/);
  await page.getByRole('button', {name: 'About the current configuration'}).click();
  check('The header advertises Ctrl+F5, Shift+F5 and Ctrl+Shift+F5 in its tooltips and aria-keyshortcuts');

  // Running a detected entry from the view lists it in Running with its printed URL.
  const dev = 'detected:node:package.json:dev';
  await view.getByTestId('quick-launch-detected-entry-node:package.json:dev').getByRole('button', {name: 'Run'}).click();
  const first = await until(async () => {
    const row = runningRow(dev).first();
    if (!await row.count()) return undefined;
    const id = await row.getAttribute('data-session-id');
    const session = (await snapshot()).sessions.find(candidate => candidate.id === id);
    return session?.run?.url && session;
  }, 'the dev run is listed in Running with its URL');
  assert.match(first.run.url, /^http:\/\/localhost:\d+\/$/);
  await runningRow(dev).first().getByTestId('run-url').waitFor();
  assert.match(await runningRow(dev).first().getByTestId('run-url').innerText(), /^http:\/\/localhost:\d+\/$/);
  await until(async () => (await page.getByTestId('opened-session').innerText()).trim() === first.id, 'the view opens the launched terminal');
  assert.equal((await view.getByTestId('run-current').innerText()).trim(), 'dev', 'the last run of this worktree becomes the current configuration');
  await page.getByTestId('run-current-restart').waitFor();
  assert.equal(await page.getByTestId('run-current-stop').isDisabled(), false);
  check('Run starts the detected dev entry from the view, lists it in Running with its URL and makes it current');

  // Restart stops the run and relaunches the same entry as a new session.
  const restarted = await (async () => {
    await runningRow(dev).first().getByTestId('run-restart').click();
    return until(async () => {
      const sessions = (await snapshot()).sessions;
      const next = runsOf(sessions, dev).find(session => session.id !== first.id && active(session));
      if (!next?.run?.url) return undefined;
      const previous = sessions.find(session => session.id === first.id);
      return previous && !active(previous) && previous.run?.stopRequested ? next : undefined;
    }, 'Restart gives a new session of the same entry');
  })();
  assert.equal(restarted.run.commandId, dev);
  assert.equal(await runningRow(dev).count(), 1, 'one active run per entry and worktree');
  await until(async () => (await page.getByTestId('opened-session').innerText()).trim() === restarted.id, 'Restart opens its new terminal');
  check('Restart stops the run and relaunches the same detected entry as a new session');

  // Shift+F5 stops the current configuration from another side bar view and shows the Run view; Ctrl+F5 runs it again.
  const runViewShown = () => page.evaluate(() => { const element = document.querySelector('[data-testid="run-view"]'); return Boolean(element && !element.closest('[hidden]')); });
  await page.locator('.wb-switch-btn[data-view="files"]').click();
  await until(async () => !(await runViewShown()), 'the Files view replaces the Run view');
  await page.getByRole('button', {name: 'Open palette'}).focus();
  await page.keyboard.press('Shift+F5');
  await until(async () => !active((await snapshot()).sessions.find(session => session.id === restarted.id)), 'Shift+F5 stops the current run');
  await until(runViewShown, 'Shift+F5 shows the Run view');
  await page.waitForFunction(() => !document.querySelector('[data-testid="run-running-row"]'));
  await page.getByTestId('run-current-restart').focus();
  await page.keyboard.press('Control+F5');
  const third = await until(async () => {
    const session = runsOf((await snapshot()).sessions, dev).find(candidate => candidate.id !== first.id && candidate.id !== restarted.id && active(candidate));
    return session?.run?.url && session;
  }, 'Ctrl+F5 runs the current configuration again');
  assert.equal(third.run.name, 'dev');
  await runningRow(dev).first().waitFor();
  check('Shift+F5 stops the current configuration from the Files view and shows Run; Ctrl+F5 runs it again');

  // The palette's "Run: build" starts a task through the captured host.
  await page.getByRole('button', {name: 'Open palette'}).click();
  const palette = page.getByRole('dialog', {name: 'Command palette'});
  await palette.waitFor();
  // The palette loads the captured worktree's entries asynchronously; wait for the row before pressing Enter.
  await palette.getByRole('textbox').fill('Run: build');
  const buildRow = palette.locator('.cmd-row', {hasText: 'Run: build'});
  await buildRow.waitFor();
  assert.equal(await buildRow.count(), 1, 'one palette row runs the build entry');
  await page.keyboard.press('Enter');
  const build = await until(async () => (await snapshot()).sessions.find(session => session.run?.commandId === 'detected:node:package.json:build'), 'the palette starts the build task');
  assert.equal(build.run.name, 'build');
  await until(async () => !active((await snapshot()).sessions.find(session => session.id === build.id)), 'the build task ends');
  assert.equal((await snapshot()).sessions.find(session => session.id === build.id).exitCode, 0);
  check('The palette\'s "Run: build" starts the detected build task for the captured worktree');

  // The same palette entry also works when the workspace has not shown the Run view yet: the view mounts on the
  // command and resolves it once its first catalog read settled.
  await page.locator('.wb-switch-btn[data-view="run"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="run-view"]'));
  await page.getByRole('button', {name: 'Open palette'}).click();
  await palette.getByRole('textbox').fill('Run: build');
  await palette.locator('.cmd-row', {hasText: 'Run: build'}).waitFor();
  await page.keyboard.press('Enter');
  const laterBuild = await until(async () => (await snapshot()).sessions.find(session => session.run?.commandId === 'detected:node:package.json:build' && session.id !== build.id), 'the palette opens the Run view and runs the entry');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="run-view"]')));
  await until(async () => !active((await snapshot()).sessions.find(session => session.id === laterBuild.id)), 'the second build task ends');
  check('The palette opens the Run view for a workspace that never showed it and starts the entry');

  // A second worktree's run is listed in Running with its own worktree label.
  const tree = await request('worktree.create', {projectId: await page.evaluate(() => window.__projectId), path: second, branch: 'qa-run-view', createBranch: true, operationId: randomUUID()});
  assert.ok(samePath(tree.path, second));
  const other = await request('quickLaunch.run', {detectedKey: 'node:package.json:dev', projectId: await page.evaluate(() => window.__projectId), cwd: second, operationId: randomUUID()});
  const foreign = await until(async () => {
    const row = page.locator(`[data-testid="run-running-row"][data-session-id="${other.session.id}"]`);
    return await row.count() ? row : undefined;
  }, 'the second worktree run appears in Running');
  assert.match(await foreign.innerText(), /second/, 'the row names its worktree');
  assert.equal(await foreign.getAttribute('data-current'), null, 'a run of another worktree is not the current one');
  assert.match(await runningRow(dev).first().innerText(), /work/, 'the current worktree row keeps its own label');
  assert.equal((await snapshot()).sessions.filter(session => active(session) && session.run?.commandId === dev).length, 2);
  check('A second worktree\'s run appears in Running with its worktree label');

  // Leaving runs active would turn runtime shutdown into failed Inbox items.
  for (const session of (await snapshot()).sessions.filter(active)) await request('session.stop', {sessionId: session.id, operationId: randomUUID()});
  await until(async () => !(await snapshot()).sessions.some(active), 'every run ends');
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
