// Actual Desktop-1 push preview -> production preload/main -> Rust -> real Git QA.
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
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime','target-qa','debug','threadterm-v3-runtime.exe');
const isAbsoluteFile=path=>typeof path==='string'&&isAbsolute(path)&&existsSync(path)&&statSync(path).isFile();
assert.ok(isAbsoluteFile(gitExe),'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
assert.ok(isAbsoluteFile(runtime),'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
const shellDir=[resolve(dirname(gitExe),'../..','usr/bin'),resolve(dirname(gitExe),'..','usr/bin')].find(path=>existsSync(join(path,'sh.exe')));
assert.ok(process.platform!=='win32'||shellDir,'Git for Windows requires its usr/bin/sh.exe for local-remote pushes');

const run=promisify(execFile);
const scratch=await mkdtemp(join(tmpdir(),'tt-git-push-preview-'));
const work=join(scratch,'work'),rival=join(scratch,'rival'),remote=join(scratch,'remote.git'),pushRemote=join(scratch,'push-remote.git'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const inheritedEnv={...process.env,GIT_DIR:process.env.GIT_DIR??join(scratch,'contaminating-git-dir')};
const env=Object.fromEntries(Object.entries(inheritedEnv).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
const fixturePath=[dirname(gitExe),shellDir,dirname(process.execPath),join(process.env.SystemRoot,'System32')].filter(Boolean).join(';');
Object.assign(env,{Path:fixturePath,PATH:fixturePath,LANGUAGE:'C',HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-push-preview-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime});
assert.equal(Object.keys(env).filter(key=>/^git_/i.test(key)).length,0,'fixture Git and runtime strip inherited GIT_* variables');
const gitAt=async(cwd,...args)=>(await run(gitExe,args,{cwd,windowsHide:true,timeout:20_000,encoding:'utf8',env})).stdout;
const git=async(...args)=>gitAt(work,...args);
let app,page,releaseLock,cleanupCompleted=false;

try {
 await mkdir(work,{recursive:true}); await mkdir(renderer,{recursive:true});
 await gitAt(scratch,'init','--bare',remote);
 await git('init','-b','main'); await git('config','user.name','ThreadTerm QA'); await git('config','user.email','qa@threadterm.invalid');
 await writeFile(join(work,'base.txt'),'base\n'); await git('add','.'); await git('commit','-m','base'); await git('remote','add','origin',remote); await git('push','-u','origin','main');
 await writeFile(join(work,'one.txt'),'one\n'); await git('add','.'); await git('commit','-m','first previewed commit');
 await writeFile(join(work,'two.txt'),'two\n'); await git('add','.'); await git('commit','-m','second previewed commit');

 for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
 const path=${JSON.stringify(work)};function Probe(){const [scope,setScope]=useState(),[status,setStatus]=useState(),[error,setError]=useState();const refresh=async projectId=>{const id=projectId??scope?.projectId;if(id)setStatus(await window.threadterm.request('git.status',{projectId:id}))};useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__qaRequest=async(method,params)=>{const record={method,params};window.__requests.push(record);try{return await raw(method,params)}catch(error){record.error=String(error);throw error}};const snapshot=await raw('runtime.snapshot',{});await raw('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await raw('project.add',{path,name:'Push preview QA',operationId:crypto.randomUUID()});const next={projectId:project.id,rootPath:path};window.__scope=next;setScope(next);await refresh(project.id);})().catch(error=>setError(String(error)))},[]);window.__refresh=refresh;return error?<p role='alert'>{error}</p>:scope?<I18nProvider locale='en'><main style={{width:720,margin:16}}><SourceControlView scope={scope} actions={{openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}}} git={{status,loading:!status,refresh}} zh={false}/></main></I18nProvider>:<p>Starting isolated runtime…</p>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-push-preview-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'qa-source-control-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge$/},args=>args.importer.endsWith('SourceControlView.tsx')?{path:'bridge',namespace:'qa'}:undefined);build.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export const operationId=()=>crypto.randomUUID();export const subscribeEvents=()=>()=>{};export const request=(method,params)=>window.__qaRequest(method,params);',loader:'js'}));}}]});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);border:1px solid var(--border);min-height:700px}</style><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-git-push-preview-qa',version:'0.1.0',main:'main.cjs'}));
 const dialog=()=>page.getByRole('dialog');
 const openPush=async()=>{await page.getByRole('button',{name:/^(Push|Publish branch)$/}).click();await dialog().waitFor();};
 const runtimeRequests=method=>page.evaluate(method=>window.__requests.filter(request=>request.method===method),method);
 const waitForRuntimeExit=async()=>{for(let attempt=0;attempt<100;attempt++){try{const late=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);late.close()}catch{return}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('runtime control pipe stayed available after runtime.shutdown');};
 let primaryError;
 try {
  releaseLock=await acquireElectronQaLock(); app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60_000}); page=await app.firstWindow({timeout:45_000}); page.setDefaultTimeout(20_000); page.on('pageerror',error=>console.error(`Renderer error: ${error.message}`));
  await page.locator('button[title="Push · 2 ahead"]').waitFor(); await openPush();
  const preview=dialog(); await preview.getByText('first previewed commit',{exact:true}).waitFor(); await preview.getByText('second previewed commit',{exact:true}).waitFor(); assert.match(await preview.textContent(),/Push main.*origin\/main/);
  await preview.press('Escape'); await preview.waitFor({state:'detached'}); await openPush();
  const reopened=dialog(),plainPush=reopened.getByRole('button',{name:'Push',exact:true}); await plainPush.focus(); assert.equal(await plainPush.evaluate(element=>element===document.activeElement),true,'Enter targets the primary push action'); await page.keyboard.press('Enter'); await reopened.waitFor({state:'detached'});
  assert.equal((await gitAt(scratch,'--git-dir',remote,'log','--format=%s','-2','refs/heads/main')).trim(),'second previewed commit\nfirst previewed commit');

  await gitAt(scratch,'init','--bare',pushRemote); await git('remote','add','publish',pushRemote); await git('push','publish','main'); await git('config','branch.main.pushRemote','publish');
  await page.evaluate(()=>window.__refresh()); await openPush(); assert.match(await dialog().textContent(),/Push main.*publish\/main/); await dialog().getByRole('button',{name:'Fetch and refresh'}).click();
  await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.fetch'&&request.params.remote==='publish'&&!request.error));
  assert.equal((await runtimeRequests('git.fetch')).at(-1).params.remote,'publish','preview Fetch targets the resolved push remote in a triangular setup');
  await dialog().press('Escape'); await dialog().waitFor({state:'detached'}); await git('config','--unset','branch.main.pushRemote');

  await writeFile(join(work,'rewritten.txt'),'local rewrite\n'); await git('add','.'); await git('commit','-m','local rewritten commit');
  await gitAt(scratch,'clone','-b','main',remote,rival); await gitAt(rival,'config','user.name','Remote QA'); await gitAt(rival,'config','user.email','remote@threadterm.invalid'); await writeFile(join(rival,'rival.txt'),'remote update\n'); await gitAt(rival,'add','.'); await gitAt(rival,'commit','-m','remote competing commit'); await gitAt(rival,'push','origin','main');
  await git('fetch','origin'); await page.evaluate(()=>window.__refresh()); await page.locator('button[title="Push · 1 ahead"]').waitFor(); await openPush();
  assert.match(await dialog().textContent(),/remote has 1 commit/i); await dialog().getByRole('button',{name:'Push',exact:true}).click();
  await page.getByRole('button',{name:/Force push/}).waitFor(); await page.getByRole('button',{name:/Force push/}).click();
  const force=page.locator('.git-push-force-dialog'); await force.getByText(/Force push will replace origin\/main/).waitFor(); const discarded=force.getByRole('list',{name:'Remote commits to discard'}); await discarded.focus(); assert.equal(await discarded.evaluate(element=>element===document.activeElement),true,'discarded remote commits are keyboard focusable'); await page.keyboard.press('PageDown'); assert.equal(await discarded.evaluate(element=>element===document.activeElement),true,'keyboard scrolling stays within discarded remote commits'); const confirm=force.getByRole('button',{name:/Force push \(with lease\)/}); assert.equal(await confirm.isDisabled(),true,'default branch force push requires its name');
  const expectedRemoteOid=(await git('rev-parse','refs/remotes/origin/main')).trim();
  const input=force.getByRole('textbox'); await input.fill('main'); assert.equal(await confirm.isDisabled(),false); await confirm.click(); await force.waitFor({state:'detached'});
  await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.push'&&request.params.force==='with-lease'&&!request.error));
  assert.equal((await gitAt(scratch,'--git-dir',remote,'log','-1','--format=%s','refs/heads/main')).trim(),'local rewritten commit');
  const pushes=await runtimeRequests('git.push'),forcePush=pushes.find(request=>request.params.force==='with-lease'); assert.equal(pushes.filter(request=>request.params.force==='with-lease').length,1,'only the reviewed force push carries the lease option'); assert.deepEqual({remote:forcePush.params.remote,remoteBranch:forcePush.params.remoteBranch,localBranch:forcePush.params.localBranch,expectedRemoteOid:forcePush.params.expectedRemoteOid},{remote:'origin',remoteBranch:'main',localBranch:'refs/heads/main',expectedRemoteOid},'force push carries the exact destination tuple that the preview reviewed');
  console.log('PASS push preview lists two commits, Fetch targets the resolved triangular push remote, regular Push updates the bare remote, rejection offers a destination-bound lease-protected force push, and main requires typed confirmation');
 } catch(error) { primaryError=error; throw error; } finally {
  if(app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  let peer,shutdownError; if(app) {try {peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim();const challenge=JSON.parse(await peer.next()),clientId=randomUUID();assert.equal(challenge.contract,PROTOCOL_CONTRACT);peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});await peer.next();await peer.request('runtime.shutdown',{operationId:randomUUID()});}catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))shutdownError=error;}finally{peer?.close();}}
  await app?.close().catch(()=>{}); if(app) await waitForRuntimeExit().catch(error=>{shutdownError??=error;}); await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); cleanupCompleted=true; if(shutdownError&&!primaryError) throw shutdownError;
 }
} finally {if(!cleanupCompleted){await releaseLock?.().catch(()=>{});await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}}
