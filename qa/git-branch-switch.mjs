// Actual Desktop-1 branch switching -> production preload/main -> Rust -> Git QA.
// This fixture owns every repo, runtime profile and pipe it starts.
import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';
import {connectPeer} from './pipe-client.mjs';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const gitExe=process.env.THREADTERM_TEST_GIT;
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const isAbsoluteFile=path=>typeof path==='string'&&isAbsolute(path)&&existsSync(path)&&statSync(path).isFile();
assert.ok(isAbsoluteFile(gitExe),'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
assert.ok(isAbsoluteFile(runtime),'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
const scratch=await mkdtemp(join(tmpdir(),'tt-git-branch-switch-'));
const work=join(scratch,'work'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const run=promisify(execFile);
const inheritedEnv={...process.env,GIT_DIR:process.env.GIT_DIR ?? join(scratch,'contaminating-git-dir')};
const env=Object.fromEntries(Object.entries(inheritedEnv).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
Object.assign(env,{Path:[dirname(gitExe),dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home/.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-branch-switch-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
assert.equal(Object.keys(env).filter(key=>/^git_/i.test(key)).length,0,'fixture Git and runtime strip inherited GIT_* variables');
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20000,encoding:'utf8',env})).stdout;
let app,page;
let releaseLock;
let cleanupCompleted=false;

try {
await mkdir(work,{recursive:true}); await mkdir(renderer,{recursive:true});
await git('init','-b','main'); await git('config','user.name','ThreadTerm QA'); await git('config','user.email','qa@threadterm.invalid');
await writeFile(join(work,'base.txt'),'base\n'); await git('add','.'); await git('commit','-m','base');
await git('switch','-c','target'); await writeFile(join(work,'obstruction.txt'),'from target\n'); await writeFile(join(work,'other-obstruction.txt'),'from target\n'); await git('add','.'); await git('commit','-m','target obstructions');
await git('switch','main'); await writeFile(join(work,'obstruction.txt'),'untracked local obstruction\n'); await writeFile(join(work,'other-obstruction.txt'),'another untracked local obstruction\n');

for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
const path=${JSON.stringify(work)};const fakeBranches=[{name:'target',remote:false,current:false,lastCommit:{hash:'target',subject:'Target branch',committedAt:'2026-01-01T00:00:00Z'}},{name:'recent',remote:false,current:false,lastCommit:{hash:'recent',subject:'Recent branch',committedAt:'2026-01-02T00:00:00Z'}},{name:'owned',remote:false,current:false,worktreePath:'C:\\\\worktrees\\\\owned'},{name:'missing',remote:false,current:false,worktreePath:'C:\\\\worktrees\\\\missing',worktreeMissing:true},{name:'origin/main',remote:true,current:false}];
function Probe(){const [scope,setScope]=useState(),[status,setStatus]=useState(),[error,setError]=useState();const setProbeStatus=value=>{window.__status=value;setStatus(value)};const refresh=async()=>{if(scope)setProbeStatus(await window.threadterm.request('git.status',{projectId:scope.projectId}))};useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__opened=[];window.__qaRequest=async(method,params)=>{window.__requests.push([method,params]);if(method==='git.branches')return {current:'main',detached:false,branches:fakeBranches};if(method==='git.checkout'&&params.branch!=='target')return {};try{return await raw(method,params)}catch(error){if(method==='git.checkout')window.__checkoutRaw=String(error);throw error}};const snapshot=await raw('runtime.snapshot',{});await raw('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await raw('project.add',{path,name:'Branch QA',operationId:crypto.randomUUID()});const next={projectId:project.id,rootPath:path};window.__scope=next;setScope(next);setProbeStatus(await raw('git.status',{projectId:project.id}));})().catch(e=>setError(String(e)))},[]);return error?<p role="alert">{error}</p>:scope?<I18nProvider locale="en"><main style={{width:560,margin:16}}><SourceControlView scope={scope} actions={{openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{},openWorktree:path=>window.__opened.push(path)}} git={{status,loading:!status,refresh}} zh={false}/></main></I18nProvider>:<p>Starting isolated runtime…</p>}createRoot(document.getElementById('root')).render(<Probe/>);`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-branch-switch-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'qa-source-control-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge$/},args=>args.importer.endsWith('SourceControlView.tsx')?{path:'bridge',namespace:'qa'}:undefined);build.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export const operationId=()=>crypto.randomUUID();export const request=(method,params)=>window.__qaRequest(method,params);',loader:'js'}));}}]});
await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);border:1px solid var(--border);min-height:700px}</style><div id="root"></div><script src="probe.js"></script></html>');
await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-git-branch-switch-qa',version:'0.1.0',main:'main.cjs'}));
const branchMenu=()=>page.locator('.wb-branch-menu');
const openMenu=async()=>{await page.locator('.wb-branch-chip').click();await branchMenu().waitFor();};
const closeDialog=async key=>{await page.keyboard.press(key);await page.locator('[role="dialog"]').waitFor({state:'detached'});};
try {
 releaseLock=await acquireElectronQaLock(); app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60000}); page=await app.firstWindow({timeout:45000}); page.setDefaultTimeout(20000); page.on('pageerror',error=>console.error(`Renderer error: ${error.message}`));
 await page.locator('.wb-branch-chip').waitFor(); await openMenu();
 assert.deepEqual(await branchMenu().locator('.wb-name').allTextContents(),['recent','target','missing','owned','origin/main']);
 const missing=branchMenu().getByRole('menuitem',{name:/missing/}); assert.equal(await missing.isDisabled(),true); assert.match(await missing.textContent(),/Worktree folder is missing.*git worktree prune/);
 await branchMenu().getByRole('menuitem',{name:/owned/}).click(); assert.deepEqual(await page.evaluate(()=>window.__opened),['C:\\worktrees\\owned']);
 await openMenu(); await branchMenu().getByRole('menuitem',{name:/New branch from/}).click(); const baseSelect=branchMenu().getByRole('combobox',{name:'Base branch'}); assert.equal(await baseSelect.inputValue(),'HEAD'); await baseSelect.focus(); await baseSelect.press('ArrowDown'); assert.notEqual(await baseSelect.inputValue(),'HEAD'); assert.equal(await baseSelect.evaluate(element=>element===document.activeElement),true); await branchMenu().getByRole('textbox',{name:'Branch name'}).fill('feature/base'); await baseSelect.selectOption('recent'); await branchMenu().getByRole('menuitem',{name:/Create "feature\/base" from recent/}).click();
 await page.waitForFunction(()=>window.__requests.some(([method,params])=>method==='git.checkout'&&params.branch==='feature/base'));
 const explicit=await page.evaluate(()=>window.__requests.find(([method,params])=>method==='git.checkout'&&params.branch==='feature/base')[1]); assert.equal(explicit.branch,'feature/base'); assert.equal(explicit.create,true); assert.equal(explicit.startPoint,'recent'); assert.ok(explicit.operationId);
 await openMenu(); await branchMenu().getByRole('menuitem',{name:/New branch from/}).click(); await branchMenu().getByRole('textbox',{name:'Branch name'}).fill('feature/default'); await branchMenu().getByRole('menuitem',{name:/Create "feature\/default" from current HEAD/}).click();
 await page.waitForFunction(()=>window.__requests.some(([method,params])=>method==='git.checkout'&&params.branch==='feature/default'));
 assert.equal(await page.evaluate(()=>Object.hasOwn(window.__requests.find(([method,params])=>method==='git.checkout'&&params.branch==='feature/default')[1],'startPoint')),false);
 const assertOverwrite=async()=>{await openMenu(); await branchMenu().getByRole('menuitem',{name:/target/}).click(); const dialog=page.getByRole('dialog'); try { await dialog.waitFor(); } catch(error) { const diagnostic=await page.evaluate(()=>({checkoutRaw:window.__checkoutRaw,status:window.__status,visibleAlert:document.querySelector('[role="alert"]')?.textContent,body:document.body.innerText,requests:window.__requests})); throw new Error(`${error.message}\nCheckout diagnostics: ${JSON.stringify(diagnostic)}`); } assert.match(await page.evaluate(()=>window.__checkoutRaw),/checkout_would_overwrite:\s*\[/); assert.equal(await dialog.getByText('Switching to target would overwrite local changes',{exact:true}).count(),1); assert.equal(await dialog.getByText("Files Git won't overwrite:",{exact:true}).count(),1); assert.equal(await dialog.getByText('Your local changes (2)',{exact:true}).count(),1); const lines=await dialog.locator('.wb-path-line').allTextContents(); assert.deepEqual(lines.slice(0,2).sort(),['obstruction.txt','other-obstruction.txt']); assert.deepEqual(lines.slice(2).sort(),['obstruction.txt','other-obstruction.txt']); return dialog;};
 await assertOverwrite(); await closeDialog('Escape'); await assertOverwrite(); await page.getByRole('button',{name:'Cancel'}).click(); await page.getByRole('dialog').waitFor({state:'detached'}); await assertOverwrite(); await page.getByRole('button',{name:'Open Source Control'}).click(); await page.waitForFunction(()=>document.activeElement?.classList.contains('wb-changes'));
 console.log('PASS branch menu sorts branches, preserves explicit bases, disables missing worktrees, and displays the actual runtime checkout obstruction with deduplicated local changes');
} finally {
 if(app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 let peer;
 let shutdownError;
 try { peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`); const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim(); const challenge=JSON.parse(await peer.next()),clientId=randomUUID(); assert.equal(challenge.contract,PROTOCOL_CONTRACT); peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')}); await peer.next(); await peer.request('runtime.shutdown',{operationId:randomUUID()}); } catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code)) shutdownError=error; } finally { peer?.close(); }
 await app?.close().catch(()=>{}); await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); cleanupCompleted=true; if(shutdownError) throw shutdownError;
}
} finally { if(!cleanupCompleted) { await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); } }
