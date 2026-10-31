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
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {CommandPalette} from './renderer/src/components/CommandPalette';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const work=${JSON.stringify(work)};
function Probe(){
 const [state,setState]=useState(),[palette,setPalette]=useState(false),[opened,setOpened]=useState(''),[error,setError]=useState();
 useEffect(()=>{let live=true;(async()=>{for(;;){const id=window.__runViewSession;if(id){const data=await window.threadterm.request('runtime.snapshot',{}),session=data.sessions.find(item=>item.id===id);if(session){if(live)setState({data,session});return;}}await new Promise(done=>setTimeout(done,100));}})().catch(value=>setError(String(value)));return()=>{live=false;};},[]);
 useEffect(()=>{if(!state)return;let live=true;const timer=setInterval(async()=>{const data=await window.threadterm.request('runtime.snapshot',{}),session=data.sessions.find(item=>item.id===state.session.id);if(live&&session)setState({data,session});},200);return()=>{live=false;clearInterval(timer);};},[state?.session.id]);
 if(error)return <p role='alert'>{error}</p>;
 if(!state)return <p>Starting isolated runtime…</p>;const {data,session}=state;
 return <I18nProvider locale='en'><><button type='button' onClick={()=>setPalette(true)}>Open palette</button><p data-testid='opened-session'>{opened}</p><SessionWorkspace session={session} data={data} theme='light' onBack={()=>{}} onSelect={id=>setOpened(id)} onProject={()=>{}} onChanged={()=>{}} onBackgroundPresented={()=>{}}/>{palette&&<CommandPalette data={data} workbench onClose={()=>setPalette(false)} onSession={()=>{}} onProject={()=>{}} onCreate={()=>{}} onCreateGroup={()=>{}} onAll={()=>{}} onInbox={()=>{}} onSettings={()=>{}}/>}</></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-view-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', charset:'utf8', jsx: 'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}, outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);min-height:860px}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-view-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => console.error(`Renderer error: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
  const initial=await snapshot();
  await request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:initial.settings.revision,operationId:randomUUID()});
  const project=await request('project.add',{path:work,name:'Run view QA',operationId:randomUUID()});
  const seed=await request('session.create',{projectId:project.id,cwd:work,title:'Run view host',provider:'custom',mode:'terminal',executable:process.execPath,args:['-e','setTimeout(()=>{},60000)'],operationId:randomUUID()});
  await page.evaluate(([projectId,sessionId])=>{window.__projectId=projectId;window.__runViewSession=sessionId;},[project.id,seed.id]);
  await page.locator('[data-testid="quick-launch-split"]').waitFor();

  // Open the actual sidebar Run tab; production F5/palette routing below is exercised through SessionWorkspace.
  await page.locator('.wb-switch-btn[data-view="run"]').click();
  const view = page.getByTestId('run-view');
  await view.waitFor();
  await view.getByTestId('quick-launch-detected-entry-node:package.json:dev').waitFor();
  assert.match(await view.getByTestId('run-entries').innerText(), /Node/i);
  // The view has no shortcut of its own: Ctrl+Shift+R is Electron's Force Reload.
  const runTitle = await page.locator('.wb-switch-btn[data-view="run"]').getAttribute('title');
  assert.match(runTitle, /^Run/);
  assert.doesNotMatch(runTitle, /Ctrl\+Shift\+R/);
  check('The Run view lists detected entries through the real SessionWorkspace sidebar');

  // Roving arrows move between the rows' primary buttons; Enter activates and Delete does nothing.
  const buildButton = view.getByTestId('quick-launch-detected-entry-node:package.json:build').locator('[data-run-primary]');
  const devButton = view.getByTestId('quick-launch-detected-entry-node:package.json:dev').locator('[data-run-primary]');
  await buildButton.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await devButton.evaluate(element => element === document.activeElement), true, 'ArrowDown moves to the next row');
  await page.keyboard.press('ArrowUp');
  assert.equal(await buildButton.evaluate(element => element === document.activeElement), true, 'ArrowUp moves back');
  await page.keyboard.press('Delete');
  assert.equal(await buildButton.evaluate(element => element === document.activeElement), true, 'Delete does nothing on a run row');
  check('Arrow keys rove between run rows while Delete does nothing');

  await page.getByTestId('quick-launch-main').focus();
  await page.keyboard.press('Control+F5');
  await page.getByTestId('quick-launch-menu').waitFor();
  assert.equal(await view.isVisible(), true, 'Ctrl+F5 with no current entry keeps the active Run view in place');
  await page.keyboard.press('Escape');
  await page.getByTestId('run-view-menu').click();
  for (const [action,shortcut] of [['run','Ctrl+F5'],['stop','Shift+F5'],['restart','Ctrl+Shift+F5']]) {
    const item=page.getByTestId(`run-current-${action}`);
    await item.waitFor();
    assert.equal(await item.getAttribute('aria-keyshortcuts'), shortcut);
    assert.equal(await item.getAttribute('aria-disabled'), 'true');
    assert.match((await item.getAttribute('aria-description'))??'', /Choose an entry for the Run button first/);
  }
  assert.equal(await page.locator('[role="alert"]').count(), 0, 'disabled shortcut help is contained in the menu, not a red view alert');
  await page.keyboard.press('Escape');
  check('Production SessionWorkspace Ctrl+F5 opens the quick pick before a current entry exists, while Run options explain disabled shortcuts');

  // Running a detected entry from the view lists it in Running with its printed URL.
  const dev = 'detected:node:package.json:dev';
  const openedBeforeRun=(await page.getByTestId('opened-session').innerText()).trim();
  await view.getByTestId('quick-launch-detected-entry-node:package.json:dev').locator('[data-run-primary]').click();
  const first = await until(async () => {
    const row = runningRow(dev).first();
    if (!await row.count()) return undefined;
    const id = await row.getAttribute('data-session-id');
    const session = (await snapshot()).sessions.find(candidate => candidate.id === id);
    return session?.run?.url && session;
  }, 'the dev run is listed in Running with its URL');
  assert.match(first.run.url, /^http:\/\/localhost:\d+\/$/);
  await runningRow(dev).first().getByTestId('run-url').waitFor();
  assert.match((await runningRow(dev).first().getByTestId('run-url').getAttribute('href'))??'', /^http:\/\/localhost:\d+\/$/);
  assert.equal((await page.getByTestId('opened-session').innerText()).trim(), openedBeforeRun, 'Run leaves output unopened');
  await page.getByTestId('quick-launch-stop').waitFor();
  // The running entry's left glyph opens output explicitly and never launches a second process.
  await view.getByTestId('quick-launch-detected-entry-node:package.json:dev').locator('[data-run-primary]').click();
  assert.equal((await page.getByTestId('opened-session').innerText()).trim(), first.id);
  assert.equal(runsOf((await snapshot()).sessions, dev).filter(active).length, 1, 'opening output does not start another run');
  check('Run starts the detected dev entry from the view, lists it inline, and opens output only from its running glyph');

  // Run options expose controller shortcuts for the current entry; Restart relaunches it as a new session.
  const restarted = await (async () => {
    await page.getByTestId('run-view-menu').click();
    for (const [action,shortcut] of [['run','Ctrl+F5'],['stop','Shift+F5'],['restart','Ctrl+Shift+F5']]) {
      const item=page.getByTestId(`run-current-${action}`);
      await item.waitFor();
      assert.equal(await item.getAttribute('aria-keyshortcuts'), shortcut);
      assert.equal(await item.getAttribute('aria-disabled'), null);
    }
    await page.getByTestId('run-current-restart').click();
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
  assert.equal((await page.getByTestId('opened-session').innerText()).trim(), first.id, 'Restart does not change the explicitly opened output');
  check('Restart stops the run and relaunches the same detected entry as a new session without navigation');

  // Shift+F5 stops and Ctrl+F5 runs from Files without opening Run.
  const runViewShown = () => page.evaluate(() => { const element = document.querySelector('[data-testid="run-view"]'); return Boolean(element && !element.closest('[hidden]')); });
  await page.locator('.wb-switch-btn[data-view="files"]').click();
  await until(async () => !(await runViewShown()), 'the Files view replaces the Run view');
  await page.getByRole('button', {name: 'Open palette'}).focus();
  await page.keyboard.press('Shift+F5');
  await until(async () => !active((await snapshot()).sessions.find(session => session.id === restarted.id)), 'Shift+F5 stops the current run');
  assert.equal(await runViewShown(), false, 'Shift+F5 keeps the Files view active');
  await page.keyboard.press('Control+F5');
  const third = await until(async () => {
    const session = runsOf((await snapshot()).sessions, dev).find(candidate => candidate.id !== first.id && candidate.id !== restarted.id && active(candidate));
    return session?.run?.url && session;
  }, 'Ctrl+F5 runs the current configuration again');
  assert.equal(third.run.name, 'dev');
  assert.equal(await runViewShown(), false, 'Ctrl+F5 keeps the Files view active');
  await page.keyboard.press('Control+Shift+F5');
  const fourth=await until(async()=>runsOf((await snapshot()).sessions,dev).find(candidate=>candidate.id!==first.id&&candidate.id!==restarted.id&&candidate.id!==third.id&&active(candidate)),'Ctrl+Shift+F5 restarts the current configuration');
  assert.equal(await runViewShown(),false,'Ctrl+Shift+F5 keeps the Files view active');
  check('Shift+F5, Ctrl+F5, and Ctrl+Shift+F5 use production controller routing from Files without opening Run');

  // A pinned twin replaces its detected entry in the palette, as it does in the Run view and the toolbar list.
  const projectId = await page.evaluate(() => window.__projectId);
  const detectedDev = (await request('quickLaunch.detect', {projectId, cwd: work})).entries.find(entry => entry.key === 'node:package.json:dev');
  const twin = await request('quickLaunch.save', {projectId, name: 'dev', command: detectedDev.command, shell: detectedDev.shell, cwd: detectedDev.cwd, kind: detectedDev.kind, env: [], operationId: randomUUID()});
  await page.getByRole('button', {name: 'Open palette'}).click();
  const palette = page.getByRole('dialog', {name: 'Command palette'});
  await palette.waitFor();
  await palette.getByRole('textbox').fill('Run: dev');
  const devRows = palette.locator('.cmd-row', {hasText: 'Run: dev'});
  await devRows.first().waitFor();
  assert.equal(await devRows.count(), 1, 'a pinned command and its detected twin share one palette row');
  await page.keyboard.press('Escape');
  await palette.waitFor({state: 'hidden'});
  await request('quickLaunch.delete', {id: twin.id, expectedRevision: twin.revision, operationId: randomUUID()});
  check('The palette lists a pinned command once, without its detected twin');

  // The palette's "Run: build" starts a task through the captured host.
  await page.getByRole('button', {name: 'Open palette'}).click();
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

  // The same palette entry works while Run is unmounted and does not mount it.
  await page.locator('.wb-panel-close').click();
  assert.equal(await page.getByTestId('run-view').count(),0,'closing the sidebar unmounts Run before the palette command');
  await page.getByRole('button', {name: 'Open palette'}).click();
  await palette.getByRole('textbox').fill('Run: build');
  await palette.locator('.cmd-row', {hasText: 'Run: build'}).waitFor();
  await page.keyboard.press('Enter');
  const laterBuild = await until(async () => (await snapshot()).sessions.find(session => session.run?.commandId === 'detected:node:package.json:build' && session.id !== build.id), 'the palette runs the entry while Run is unmounted');
  assert.equal(await page.getByTestId('run-view').count(),0,'palette keeps Run unmounted');
  await until(async () => !active((await snapshot()).sessions.find(session => session.id === laterBuild.id)), 'the second build task ends');
  check('The palette starts an entry while Run is unmounted without changing the view');

  // A second worktree's run is listed in Running with its own worktree label.
  const tree = await request('worktree.create', {projectId: await page.evaluate(() => window.__projectId), path: second, branch: 'qa-run-view', createBranch: true, operationId: randomUUID()});
  assert.ok(samePath(tree.path, second));
  const other = await request('quickLaunch.run', {detectedKey: 'node:package.json:dev', projectId: await page.evaluate(() => window.__projectId), cwd: second, operationId: randomUUID()});
  await page.locator('.wb-switch-btn[data-view="run"]').click();
  const foreign = await until(async () => {
    const row = page.locator(`[data-testid="run-running-row"][data-session-id="${other.session.id}"]`);
    return await row.count() ? row : undefined;
  }, 'the second worktree run appears in Running');
  assert.match(await foreign.innerText(), /second/, 'the row names its worktree');
  assert.equal(await foreign.getAttribute('data-current'), null, 'a run of another worktree is not the current one');
  assert.equal(await runningRow(dev).first().locator('.ql-worktree').count(),0,'the current worktree row has no redundant worktree label');
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
