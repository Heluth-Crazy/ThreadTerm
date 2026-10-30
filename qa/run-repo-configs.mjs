// Desktop-1 QA for Run phase 5: shared .threadterm/run.json entries retain secrets locally and
// require an explicit trust review after a repository edit.
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to this worktree runtime executable>'
//   $env:THREADTERM_TEST_GIT='D:\\Git\\mingw64\\bin\\git.exe'
//   node qa/run-repo-configs.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build as esbuild} from 'esbuild';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe');
const delay = ms => new Promise(done => setTimeout(done, ms));
const isFile = path => typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isFile();
function onPath(name) {
 const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
 for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) for (const extension of ['', ...extensions]) {
  const candidate = join(directory, name + extension); if (directory && isFile(candidate)) return candidate;
 }
}
const gitExe = process.env.THREADTERM_TEST_GIT ?? onPath('git');
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');

const scratch = await mkdtemp(join(tmpdir(), 'tt-run-repo-configs-'));
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), rendererDir = join(appDir, 'renderer');
const fixturePath = [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const isolatedHome = join(scratch, 'home');
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options|electron_run_as_node)$/i.test(key)));
Object.assign(env, {Path:fixturePath, LANGUAGE:'C', HOME:isolatedHome, USERPROFILE:isolatedHome, HOMEDRIVE:isolatedHome.slice(0, 2), HOMEPATH:isolatedHome.slice(2), CODEX_HOME:join(isolatedHome, '.codex'), APPDATA:join(scratch, 'appdata'), LOCALAPPDATA:join(scratch, 'localappdata'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:join(scratch, 'gitconfig'), GIT_TERMINAL_PROMPT:'0', THREADTERM_V3_DATA:join(scratch, 'data'), THREADTERM_V3_USER_DATA:join(scratch, 'profile'), THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-run-repo-configs-${randomUUID()}`, THREADTERM_V3_RUNTIME:runtime, THREADTERM_V3_RUNTIME_BIN:runtime});
assert.deepEqual(Object.keys(env).filter(key => /^git_/i.test(key)).sort(), ['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_TERMINAL_PROMPT'], 'fixture replaces inherited GIT_* variables with isolated settings');
const git = (...args) => execFileSync(gitExe, args, {cwd:work, windowsHide:true, encoding:'utf8', env});
let page;
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const snapshot = () => request('runtime.snapshot');
async function until(test, label, timeout = 45_000) { const end = Date.now() + timeout; for (;;) { try { const value = await test(); if (value) return value; } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(200); } }
const active = session => ['starting', 'running', 'idle', 'waiting'].includes(session?.status ?? '');
const secret = 'repo-only-secret';
const secretHash = createHash('sha256').update(secret).digest('hex');
const passed = []; const check = message => { passed.push(message); console.log(`PASS ${message}`); };
let app, releaseLock, completed = false;
const pageErrors = [];
try {
 await mkdir(work, {recursive:true});
 await writeFile(join(work, 'server.mjs'), `import crypto from 'node:crypto';import http from 'node:http';console.log('SECRET_SHA256='+crypto.createHash('sha256').update(process.env.API_TOKEN??'').digest('hex'));const server=http.createServer((_q,r)=>r.end('repo config'));server.listen(0,'127.0.0.1',()=>console.log('Local: http://localhost:'+server.address().port+'/'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
 await writeFile(join(work, 'package.json'), JSON.stringify({name:'run-repo-configs-fixture', private:true}));
 git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run repo configs QA'); git('add', '.'); git('commit', '-m', 'fixture');
 await mkdir(rendererDir, {recursive:true});
 for (const name of ['main', 'preload']) await esbuild({entryPoints:[join(root, `desktop/src/${name}.ts`)], bundle:true, platform:'node', target:'node22', format:'cjs', external:['electron'], outfile:join(appDir, `${name}.cjs`), logLevel:'error'});
 const source = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{CommandEditor,QuickLaunchMenu}from'./renderer/src/components/QuickLaunch';import{RunViewPanel}from'./renderer/src/components/RunViewPanel';import{I18nProvider}from'./renderer/src/i18n';import'./renderer/src/styles.css';import'./renderer/src/workbench/workbench.css';const work=${JSON.stringify(work)};function Probe(){const[snapshot,setSnapshot]=useState(),[project,setProject]=useState(),[editing,setEditing]=useState(false),[error,setError]=useState();useEffect(()=>{(async()=>{const first=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:first.settings.revision,operationId:crypto.randomUUID()});const added=await window.threadterm.request('project.add',{path:work,name:'Run repo configs QA',operationId:crypto.randomUUID()});window.__projectId=added.id;setProject(added.id);setSnapshot(await window.threadterm.request('runtime.snapshot',{}));})().catch(x=>setError(String(x)));},[]);useEffect(()=>{if(!project)return;let live=true;(async()=>{while(live){try{setSnapshot(await window.threadterm.request('runtime.snapshot',{}));}catch{}await new Promise(done=>setTimeout(done,250));}})();return()=>{live=false};},[project]);if(error)return <p role='alert'>{error}</p>;if(!project||!snapshot)return <p>Starting isolated runtime…</p>;const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{},openSession:id=>window.__opened=id,openPreview:()=>{}};return <I18nProvider locale='en'><main style={{padding:16}}><button onClick={()=>setEditing(true)}>New shared command</button><QuickLaunchMenu data={snapshot} projectId={project} root={work} onOpenSession={id=>window.__opened=id}/><RunViewPanel scope={{projectId:project,worktreePath:work,rootPath:work}} sessions={snapshot.sessions} actions={actions} zh={false} visible/>{editing&&<CommandEditor projectId={project} root={work} onClose={()=>setEditing(false)} onChanged={async()=>{}} onReload={async id=>(await window.threadterm.request('quickLaunch.list',{projectId:project})).find(x=>x.id===id)} onRun={async()=>{}}/>}</main></I18nProvider>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await esbuild({stdin:{contents:source, resolveDir:root, sourcefile:'run-repo-configs-probe.tsx', loader:'tsx'}, bundle:true, platform:'browser', format:'iife', jsx:'automatic', outfile:join(rendererDir, 'probe.js'), logLevel:'error'});
 await writeFile(join(rendererDir, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(appDir, 'package.json'), JSON.stringify({name:'threadterm-run-repo-configs-qa', version:'0.1.0', main:'main.cjs'}));
 releaseLock = await acquireElectronQaLock(); app = await electron.launch({args:['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd:root, env, timeout:60_000}); page = await app.firstWindow({timeout:45_000}); page.setDefaultTimeout(20_000); page.on('pageerror', error => pageErrors.push(error.message)); await page.waitForFunction(() => Boolean(window.threadterm)); await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));

 // Save through the editor, including the Secret control; the runtime response confirms it is the local override.
 await page.getByRole('button', {name:'New shared command'}).click(); const editor = page.getByRole('dialog'); await editor.waitFor();
 await editor.getByRole('textbox', {name:'Name'}).fill('API'); await editor.getByRole('textbox', {name:'Command'}).fill('node server.mjs');
 await editor.getByTestId('repo-storage-toggle').check(); await editor.getByText('Advanced').click(); await editor.getByRole('button', {name:'Add variable'}).click();
 await editor.getByRole('textbox', {name:'Environment name 1'}).fill('API_TOKEN'); await editor.getByRole('textbox', {name:'Environment value 1'}).fill(secret); await editor.getByTestId('repo-secret-0').check(); await editor.getByRole('button', {name:'Save', exact:true}).click(); await editor.waitFor({state:'hidden'});
 const projectId = await page.evaluate(() => window.__projectId); const config = join(work, '.threadterm', 'run.json'); await until(async () => existsSync(config) && (await request('quickLaunch.repo.list', {projectId, cwd:work})).entries.length === 1, 'the shared entry is saved');
 assert.deepEqual((await request('quickLaunch.repo.list',{projectId,cwd:work})).entries[0].env,[{name:'API_TOKEN',secret:true,hasValue:true}]);
 const bytes = await readFile(config, 'utf8'); assert.doesNotMatch(bytes, new RegExp(secret)); assert.match(bytes, /"secret":\s*true/); git('add', '.threadterm/run.json'); git('commit', '-m', 'shared run config'); check('Store in repo writes and commits .threadterm/run.json without the secret value');

 const row = page.getByTestId('quick-launch-repo-entry-api'); await row.waitFor(); await row.getByRole('button', {name:'Run'}).click(); const run = await until(async () => (await snapshot()).sessions.find(item => item.run?.commandId === 'repo:api' && active(item)), 'the shared service starts');
 const output = await until(async () => { const value = await request('terminal.read', {sessionId:run.id, cursor:0, limit:32_768}); const text = Buffer.from(value.data ?? '', 'base64').toString('utf8'); return text.includes(secretHash) && text; }, 'the secret hash reaches the process'); assert.match(output, new RegExp(secretHash)); check('A repo entry runs with its local secret override in the process environment');

 const document = JSON.parse(await readFile(config, 'utf8')); document.entries[0].command = 'node server.mjs --changed'; await writeFile(config, JSON.stringify(document)); await page.evaluate(() => dispatchEvent(new Event('focus'))); const changed = page.getByTestId('repo-changed-api'); await changed.waitFor(); await changed.click(); await page.getByTestId('repo-diff-api').waitFor(); assert.match(await page.getByTestId('repo-diff-api').innerText(), /node server\.mjs[\s\S]*--changed/); await page.getByTestId('repo-trust-api').click(); await until(async () => !(await request('quickLaunch.repo.list', {projectId, cwd:work})).entries[0]?.changed, 'the reviewed fingerprint becomes trusted'); check('An external edit shows Changed in repo with a diff, and Trust accepts exactly that fingerprint');

 await request('session.stop', {sessionId:run.id, operationId:randomUUID()}); await until(async () => !active((await snapshot()).sessions.find(item => item.id === run.id)), 'the original service stops before moving');
 // Both storage moves preserve Save and run through their confirmation.
 await page.locator('.ql-trigger').click(); await page.getByTestId('quick-launch-menu').getByTestId('quick-launch-repo-entry-api').getByRole('button', {name:'Edit'}).click(); await editor.waitFor(); await editor.getByTestId('repo-storage-toggle').uncheck(); await editor.getByRole('button', {name:'Save and run', exact:true}).click(); const moveLocal = page.getByTestId('repo-move-local-api'); await moveLocal.waitFor(); assert.match(await page.getByRole('dialog').last().innerText(), /\.threadterm\/run\.json/); await moveLocal.click(); await until(async () => (await request('quickLaunch.list', {projectId})).some(item => item.name === 'API'), 'Move to local creates a saved entry');
 const localEntry = (await request('quickLaunch.list', {projectId})).find(item => item.name === 'API'); assert.ok(localEntry); assert.deepEqual(localEntry.env,[{name:'API_TOKEN',secret:true,hasValue:true}]); const localRun = await until(async () => (await snapshot()).sessions.find(item => item.run?.commandId === localEntry.id && active(item)), 'Save and run launches after Move to local'); await until(async () => { const value=await request('terminal.read',{sessionId:localRun.id,cursor:0,limit:32768}); return Buffer.from(value.data??'','base64').toString('utf8').includes(secretHash); }, 'the moved local run receives its secret'); await request('session.stop',{sessionId:localRun.id,operationId:randomUUID()}); await until(async () => !active((await snapshot()).sessions.find(item=>item.id===localRun.id)), 'the local run stops before moving back'); await page.locator('.ql-trigger').click(); const local = page.getByTestId('quick-launch-menu').getByTestId(`quick-launch-command-${localEntry.id}`); await local.waitFor(); await local.getByRole('button', {name:'Edit'}).click(); await editor.waitFor(); await editor.getByTestId('repo-storage-toggle').check(); await editor.getByText('Advanced').click(); await editor.getByTestId('repo-secret-0').check(); await editor.getByRole('button', {name:'Save and run', exact:true}).click(); const moveRepo = page.getByTestId(`repo-move-repo-${localEntry.id}`); await moveRepo.waitFor(); assert.match(await page.getByRole('dialog').last().innerText(), /\.threadterm\/run\.json/); await moveRepo.click(); await until(async () => (await request('quickLaunch.repo.list', {projectId, cwd:work})).entries.some(item => item.id === 'api'), 'Move to repo recreates the shared entry'); assert.doesNotMatch(await readFile(config, 'utf8'), new RegExp(secret)); check('Move to local and Move to repo are explicit UI actions with .threadterm/run.json confirmations, and the moved secret stays local'); const movedRun=await until(async () => (await snapshot()).sessions.find(item=>item.run?.commandId==='repo:api'&&active(item)), 'Save and run launches after Move to repo'); await until(async () => { const value=await request('terminal.read',{sessionId:movedRun.id,cursor:0,limit:32768}); return Buffer.from(value.data??'','base64').toString('utf8').includes(secretHash); }, 'the moved repo run receives its secret'); await request('session.stop',{sessionId:movedRun.id,operationId:randomUUID()}); check('Save and run survives both storage confirmations and copies secrets without exposing values');

 await writeFile(config, '{not json'); await page.evaluate(() => dispatchEvent(new Event('focus'))); await until(async () => (await request('quickLaunch.repo.list', {projectId, cwd:work})).error, 'the malformed config is reported'); await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /repo|shared|invalid/i); assert.deepEqual(pageErrors, [], 'a malformed repo file causes no renderer crash'); check('A malformed repo file reports an error without crashing the Run view');
 await request('session.stop', {sessionId:run.id, operationId:randomUUID()}); await until(async () => !active((await snapshot()).sessions.find(item => item.id === run.id)), 'the repo run ends'); completed = true; console.log(`PASS ${passed.length} checks`);
} finally { if (page) await Promise.race([page.evaluate(() => window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})), delay(3000)]).catch(() => {}); if (app) { await Promise.race([app.evaluate(({app:e}) => e.exit(0)), delay(2000)]).catch(() => {}); await Promise.race([app.close(), delay(5000)]).catch(() => {}); try { app.process()?.kill(); } catch {} } await releaseLock?.().catch(() => {}); await rm(scratch, {recursive:true, force:true, maxRetries:10, retryDelay:250}).catch(() => {}); }
if (!completed) process.exitCode = 1;
