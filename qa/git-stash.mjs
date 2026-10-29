// Actual Desktop-1 stash UI -> production preload/main -> Rust -> Git QA.
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
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root,'runtime','target-qa','debug','threadterm-v3-runtime.exe');
const isAbsoluteFile=path=>typeof path==='string'&&isAbsolute(path)&&existsSync(path)&&statSync(path).isFile();
assert.ok(isAbsoluteFile(gitExe),'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
assert.ok(isAbsoluteFile(runtime),'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
const scratch=await mkdtemp(join(tmpdir(),'tt-git-stash-'));
const work=join(scratch,'work'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const run=promisify(execFile);
const inheritedEnv={...process.env,GIT_DIR:process.env.GIT_DIR ?? join(scratch,'contaminating-git-dir')};
const env=Object.fromEntries(Object.entries(inheritedEnv).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
Object.assign(env,{Path:[dirname(gitExe),dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home/.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-stash-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
assert.equal(Object.keys(env).filter(key=>/^git_/i.test(key)).length,0,'fixture Git and runtime strip inherited GIT_* variables');
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20000,encoding:'utf8',env})).stdout;
let app,page;
let releaseLock;
let cleanupCompleted=false;

try {
 await mkdir(work,{recursive:true}); await mkdir(renderer,{recursive:true});
 await git('init','-b','main'); await git('config','user.name','ThreadTerm QA'); await git('config','user.email','qa@threadterm.invalid');
 await writeFile(join(work,'base.txt'),'base\n'); await git('add','.'); await git('commit','-m','base');
 await git('switch','-c','target'); await writeFile(join(work,'obstruction.txt'),'tracked on target\n'); await git('add','.'); await git('commit','-m','target obstruction'); await git('switch','main');
 await writeFile(join(work,'base.txt'),'stashed tracked change\n'); await writeFile(join(work,'notes.txt'),'stashed untracked change\n');

 for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
 const path=${JSON.stringify(work)};function Probe(){const [scope,setScope]=useState(),[status,setStatus]=useState(),[error,setError]=useState();const refresh=async()=>{if(scope)setStatus(await window.threadterm.request('git.status',{projectId:scope.projectId}))};useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__qaRequest=async(method,params)=>{window.__requests.push([method,params]);return raw(method,params)};const snapshot=await raw('runtime.snapshot',{});await raw('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await raw('project.add',{path,name:'Stash QA',operationId:crypto.randomUUID()});const next={projectId:project.id,rootPath:path};window.__scope=next;window.__refresh=async()=>setStatus(await raw('git.status',{projectId:project.id}));await window.__refresh();setScope(next);})().catch(e=>setError(String(e)))},[]);return error?<p role="alert">{error}</p>:scope?<I18nProvider locale="en"><main style={{width:620,margin:16}}><SourceControlView scope={scope} actions={{openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}}} git={{status,loading:!status,refresh}} zh={false}/></main></I18nProvider>:<p>Starting isolated runtime…</p>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-stash-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'qa-source-control-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge$/},args=>args.importer.endsWith('SourceControlView.tsx')?{path:'bridge',namespace:'qa'}:undefined);build.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export const operationId=()=>crypto.randomUUID();export const subscribeEvents=()=>()=>{};export const request=(method,params)=>window.__qaRequest(method,params);',loader:'js'}));}}]});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);border:1px solid var(--border);min-height:700px}</style><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-git-stash-qa',version:'0.1.0',main:'main.cjs'}));
const stashes=()=>page.locator('.wb-stashes');
const openBranches=async()=>{await page.locator('.wb-branch-chip').click();await page.locator('.wb-branch-menu').waitFor();};
 const waitForRuntimeExit=async()=>{
  for(let attempt=0;attempt<100;attempt++) {
   try { const late=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`); late.close(); }
   catch { return; }
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('runtime control pipe stayed available after runtime.shutdown');
 };
 try {
  releaseLock=await acquireElectronQaLock(); app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60000}); page=await app.firstWindow({timeout:45000}); page.setDefaultTimeout(20000); page.on('pageerror',error=>console.error(`Renderer error: ${error.message}`));
  await page.locator('.wb-branch-chip').waitFor();
  await page.getByRole('button',{name:'Stash changes…'}).click();
  const stashDialog=page.getByRole('dialog'); await stashDialog.waitFor();
  assert.equal(await stashDialog.getByRole('checkbox').isChecked(),true);
  await stashDialog.getByRole('textbox',{name:'Stash message'}).fill('Electron stash');
  await stashDialog.getByRole('button',{name:'Stash changes',exact:true}).click();
  await stashDialog.waitFor({state:'detached'}); await stashes().waitFor();
  assert.equal(await stashes().getByRole('button',{name:/Stashes/}).getAttribute('aria-expanded'),'false');
  await stashes().getByRole('button',{name:/Stashes/}).click();
  const stashRow=stashes().getByRole('listitem').first(); await stashRow.waitFor();
  assert.match(await stashRow.textContent(),/Electron stash/); assert.match(await stashRow.textContent(),/untracked/);
  const narrow=await page.evaluate(()=>{const main=document.querySelector('main'),row=document.querySelector('.wb-stash-row'); if(!main||!row)throw new Error('stash row is missing'); main.style.width='220px'; return {scrollWidth:row.scrollWidth,clientWidth:row.clientWidth};});
  assert.ok(narrow.scrollWidth<=narrow.clientWidth+1,`stash row overflows 220px sidebar (${narrow.scrollWidth}px > ${narrow.clientWidth}px)`);
  await page.locator('main').evaluate(main=>{main.style.width='620px';});
  await stashRow.getByRole('button',{name:/Show files in Electron stash/}).click();
  await page.locator('.wb-stash-file').filter({hasText:'base.txt'}).waitFor();
  const untrackedFile=page.locator('.wb-stash-file').filter({hasText:'notes.txt'}); await untrackedFile.waitFor();
  assert.equal(await untrackedFile.count(),1);
  await stashRow.getByRole('button',{name:/Drop Electron stash/}).click();
  const dropDialog=page.getByRole('dialog'); await dropDialog.waitFor(); assert.equal(await dropDialog.getByText('Drop stash?',{exact:true}).count(),1);
  await dropDialog.getByRole('button',{name:'Drop stash',exact:true}).click(); await dropDialog.waitFor({state:'detached'}); await stashes().waitFor({state:'detached'});

  await writeFile(join(work,'obstruction.txt'),'untracked local obstruction\n'); await page.evaluate(()=>window.__refresh());
  await openBranches(); await page.locator('.wb-branch-menu').getByRole('menuitem',{name:/target/}).click();
  const overwrite=page.getByRole('dialog'); await overwrite.waitFor();
  assert.equal(await overwrite.getByRole('button',{name:'Stash and switch'}).count(),1);
  assert.match(await overwrite.textContent(),/includes untracked files/);
  await overwrite.getByRole('button',{name:'Stash and switch'}).click(); await overwrite.waitFor({state:'detached'});
  await page.getByText(/Switched to target; your changes stay in stash/,{exact:false}).waitFor();
  assert.equal((await git('branch','--show-current')).trim(),'target');
  assert.equal((await git('stash','list')).split(/\r?\n/).filter(Boolean).length,1);
  await stashes().waitFor(); const stashToggle=stashes().getByRole('button',{name:/Stashes/}); if(await stashToggle.getAttribute('aria-expanded')==='false') await stashToggle.click();
  assert.match(await stashes().getByRole('listitem').first().textContent(),/ThreadTerm: switch to target/);
  const smart=await page.evaluate(()=>window.__requests.find(([method,params])=>method==='git.checkout'&&params.branch==='target'&&params.stash)?.[1]);
  assert.equal(smart.stash,true); assert.ok(smart.operationId);
  console.log('PASS stash dialog, collapsed Stashes section, file list, drop confirmation, and untracked-obstruction stash-and-switch outcome');
 } finally {
  if(app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  let peer; let shutdownError;
  try { peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`); const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim(); const challenge=JSON.parse(await peer.next()),clientId=randomUUID(); assert.equal(challenge.contract,PROTOCOL_CONTRACT); peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')}); await peer.next(); await peer.request('runtime.shutdown',{operationId:randomUUID()}); } catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code)) shutdownError=error; } finally { peer?.close(); }
  await app?.close().catch(()=>{}); await waitForRuntimeExit().catch(error=>{shutdownError ??= error;}); await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); cleanupCompleted=true; if(shutdownError) throw shutdownError;
 }
} finally { if(!cleanupCompleted) { await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); } }
