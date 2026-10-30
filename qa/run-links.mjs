// Desktop-1 QA for Run 1d: a real Run terminal prints a fixture Java stack trace, a Maven
// `[ERROR] /D:/…/Hello.java:[3,5]` line, a Python traceback and a cargo-style relative location.
// Ctrl+click drives the real SessionWorkspace path — filesystem.resolve, then the editor tab that
// actually opens — against the real runtime's bounded source search.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-links.mjs
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

// Prerequisites first: a missing runtime or Git must not leave scratch behind.
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');

const scratch = await mkdtemp(join(tmpdir(), 'tl-'));
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
const java = join(work, 'api', 'src', 'main', 'java', 'com', 'example', 'Hello.java');
const python = join(work, 'pkg', 'mod.py');
const rust = join(work, 'src', 'main.rs');
const mavenPath = `/${java.replace(/\\/g, '/')}`;
const gitCmd = dirname(gitExe);
const fixturePath = [dirname(process.execPath), gitCmd, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options)$/i.test(key)));
Object.assign(env, {
  Path: fixturePath, PATH: fixturePath, LANGUAGE: 'C',
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-links-${randomUUID()}`,
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

// Fixture lines that can be asserted in the editor: an early marker and one far enough down that
// only a reveal scrolls it into the rendered viewport.
const javaLines = ['package com.example;', '', 'public class Hello { // java_line_three_marker', '  public static void main(String[] args) {'];
while (javaLines.length < 40) javaLines.push(`  // filler ${javaLines.length}`);
javaLines.push('  // java_far_marker', '}', '');
const rustLines = ['fn main() {'];
while (rustLines.length < 49) rustLines.push(`    // filler ${rustLines.length}`);
rustLines.push('    // rust_line_fifty_marker', '}', '');

const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, page, releaseLock, completed = false;
try {
  await Promise.all([mkdir(dirname(java), {recursive: true}), mkdir(dirname(python), {recursive: true}), mkdir(dirname(rust), {recursive: true}), mkdir(rendererDir, {recursive: true})]);
  await writeFile(java, javaLines.join('\n'));
  await writeFile(python, 'def run():  # python_line_one_marker\n    raise RuntimeError("fixture")  # python_line_two_marker\n');
  await writeFile(rust, rustLines.join('\n'));
  // The console text a JVM, Maven, Python tool and cargo produce, written as CRLF like a console log.
  await writeFile(join(work, 'trace.txt'), [
    'Exception in thread "main" java.lang.IllegalStateException: fixture',
    '\tat com.example.Hello.main(Hello.java:3)',
    `[ERROR] ${mavenPath}:[3,5] cannot find symbol`,
    'Traceback (most recent call last):',
    `  File "pkg\\mod.py", line 2`,
    'error: cannot find value `x` in this scope',
    '  --> src/main.rs:50:5',
    '',
  ].join('\r\n'));
  git('init'); git('config', 'core.autocrlf', 'false'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run links QA');
  git('add', '.'); git('commit', '-m', 'fixture');

  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  // The production SessionWorkspace, its real terminal and its real file tabs. `openFile` is the
  // workspace's own `openReference`, so a Ctrl+click resolves and opens a tab exactly as in the app.
  const source = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {EditorView} from '@codemirror/view';
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const originalOpen=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.term=this;return originalOpen.call(this,element)};
const originalLinks=Terminal.prototype.registerLinkProvider;
Terminal.prototype.registerLinkProvider=function(provider){window.fileProvider=provider;return originalLinks.call(this,provider)};
// The editor's cursor line is the reveal the workspace applied; read it from CodeMirror itself.
window.qaEditors=()=>[...document.querySelectorAll('.cm-content')].map(content=>{const view=EditorView.findFromDOM(content);if(!view)return undefined;return{line:view.state.doc.lineAt(view.state.selection.main.head).number,visible:content.getClientRects().length>0};}).filter(Boolean);
function Probe(){
 const [state,setState]=useState(),[error,setError]=useState();
 useEffect(()=>{(async()=>{for(;;){const wanted=window.runSessionId;if(wanted){const data=await window.threadterm.request('runtime.snapshot',{});const session=data.sessions.find(item=>item.id===wanted);if(session){setState({data,session});return;}}await new Promise(done=>setTimeout(done,100));}})().catch(value=>setError(String(value)));},[]);
 if(error)return <p role='alert'>{error}</p>;
 if(!state)return <p>Starting isolated runtime…</p>;
 const {data,session}=state;
 const initial={kind:'pane',id:'qa-pane',tabs:[{id:'session-run',kind:'session',sessionId:session.id}],activeTabId:'session-run'};
 return <I18nProvider locale="en"><div style={{display:'flex',width:1280,height:760}}><SessionWorkspace session={session} data={data} theme="light" initialLayout={initial} navigationKey={0} onActiveSession={()=>{}} onBack={()=>{}} onSelect={()=>{}} onProject={()=>{}} onChanged={()=>{}} onBackgroundPresented={()=>{}}/></div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Probe/>);`;
  await esbuild({stdin: {contents: source, resolveDir: root, sourcefile: 'run-links-probe.tsx', loader: 'tsx'}, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: {'.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl'}, outfile: join(rendererDir, 'probe.js'), logLevel: 'error'});
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text);margin:0}</style><div id="root"></div><script src="probe.js"></script></html>');
  await writeFile(join(appDir, 'package.json'), JSON.stringify({name: 'threadterm-run-links-qa', version: '0.1.0', main: 'main.cjs'}));

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.locator('#root').waitFor();

  const first = await snapshot();
  await request('settings.update', {patch: {language: 'en', notifications: {native: false, attention: false, completed: false, sound: false}}, expectedRevision: first.settings.revision, operationId: randomUUID()});
  const project = await request('project.add', {path: work, name: 'Run links QA', operationId: randomUUID()});
  await request('worktree.list', {projectId: project.id});
  const command = await request('quickLaunch.save', {projectId: project.id, name: 'print trace', command: 'type trace.txt', shell: 'cmd', cwd: '', kind: 'task', env: [], operationId: randomUUID()});
  const run = await request('quickLaunch.run', {commandId: command.id, cwd: work, operationId: randomUUID()});
  const done = await until(async () => { const found = (await snapshot()).sessions.find(item => item.id === run.session.id); return found?.status === 'exited' && found; }, 'the fixture run exits');
  assert.equal(done.exitCode, 0, 'the fixture command printed its file');
  assert.ok(done.run, 'the fixture session is a Quick Launch run');

  await page.evaluate(id => { window.runSessionId = id; }, run.session.id);
  await page.waitForFunction(() => Boolean(window.term && window.fileProvider));
  // The rendered cells are the evidence: the buffer must hold the fixture lines before any click.
  const buffer = await until(async () => page.evaluate(() => {
    const active = window.term.buffer.active;
    const text = Array.from({length: active.length}, (_, row) => active.getLine(row)?.translateToString(true) ?? '').join('\n');
    return /Hello\.java:3/.test(text) && /\[3,5\]/.test(text) && /line 2/.test(text) && /src\/main\.rs:50/.test(text) && text;
  }), 'the trace is rendered in the run terminal');
  assert.match(buffer, /at com\.example\.Hello\.main\(Hello\.java:3\)/);
  check('A saved Run command prints the fixture trace into the real workspace terminal');

  // A real Ctrl+click through xterm's own link provider, exactly as a user navigates Run output.
  async function ctrlClick(needle) {
    const range = await page.evaluate(async needle => {
      for (let row = 1; row <= window.term.buffer.active.length; row++) {
        const links = await new Promise(done => window.fileProvider.provideLinks(row, done));
        const link = links?.find(item => item.text.includes(needle));
        if (link) return {range: link.range, text: link.text};
      }
    }, needle);
    assert.ok(range, `the terminal links ${needle}`);
    const point = await page.evaluate(range => {
      const term = window.term, screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {x: screen.left + (range.start.x - .5) * screen.width / term.cols, y: screen.top + (range.start.y - term.buffer.active.viewportY - .5) * screen.height / term.rows};
    }, range.range);
    const before = await tabs();
    await page.keyboard.down('Control');
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(point => document.elementFromPoint(point.x, point.y)?.className === 'terminal-file-link-hit', point);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    return {...range, before};
  }

  // The tabs the workspace actually saved: path is relative to the worktree root, as the runtime returned it.
  const tabs = () => page.evaluate(async () => {
    const data = await window.threadterm.request('runtime.snapshot', {});
    const tabs = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.tabs)) { for (const tab of node.tabs) tabs.push(tab); return; }
      visit(node.first); visit(node.second);
    };
    for (const workspace of data.workspaces ?? []) visit(workspace.layout);
    return tabs.filter(tab => tab.kind === 'file').map(tab => ({path: tab.path, kind: tab.kind}));
  });
  const openedTab = async (path, label) => until(async () => (await tabs()).find(tab => tab.path === path && tab.kind === 'file'), `${label} opens ${path}`);
  const editorLine = async line => until(async () => {
    const editors = await page.evaluate(() => window.qaEditors?.());
    return editors?.some(editor => editor.visible && editor.line === line) && editors;
  }, `the visible editor reveals line ${line}`);

  const frame = await ctrlClick('Hello.java:3');
  assert.equal(frame.text, 'Hello.java:3');
  await openedTab('api/src/main/java/com/example/Hello.java', 'the Java frame');
  await editorLine(3);
  check('Ctrl+click on the Java stack frame opens api/src/main/java/com/example/Hello.java at line 3');
  const afterFrame = await tabs();
  assert.equal(afterFrame.filter(tab => tab.path === 'api/src/main/java/com/example/Hello.java').length, 1, 'one tab per file');

  const maven = await ctrlClick(':[3,5]');
  assert.equal(maven.text, `${mavenPath}:[3,5]`);
  await openedTab('api/src/main/java/com/example/Hello.java', 'the Maven bracket line');
  await editorLine(3);
  const afterMaven = await tabs();
  assert.deepEqual(afterMaven.filter(tab => tab.path === 'api/src/main/java/com/example/Hello.java').length, 1, 'the bracket line reuses the same tab');
  check('Ctrl+click on the Maven [ERROR] /D:/…:[3,5] line opens api/src/main/java/com/example/Hello.java at line 3');

  const pythonLine = await ctrlClick('mod.py');
  await openedTab('pkg/mod.py', 'the Python traceback');
  await editorLine(2);
  check('Ctrl+click on the Python traceback path opens pkg/mod.py at line 2');

  // The cargo-style relative location: a `custom` run session resolves it against the run cwd.
  const relative = await ctrlClick('src/main.rs:50');
  assert.equal(relative.text, 'src/main.rs:50:5');
  await openedTab('src/main.rs', 'the relative location');
  await editorLine(50);
  check('Ctrl+click on the relative cargo location opens src/main.rs at line 50');

  const files = (await tabs()).map(tab => tab.path).sort();
  assert.deepEqual(files, ['api/src/main/java/com/example/Hello.java', 'pkg/mod.py', 'src/main.rs'], 'exactly the three files opened, by relative path');
  assert.deepEqual(pageErrors, [], 'the probe page raised no error');

  for (const item of (await snapshot()).sessions.filter(item => ['starting', 'running', 'idle', 'waiting'].includes(item.status))) {
    await request('session.stop', {sessionId: item.id, operationId: randomUUID()});
  }
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
