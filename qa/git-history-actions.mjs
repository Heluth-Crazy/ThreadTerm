// Actual Desktop-1 history actions -> production preload/main -> Rust -> real Git QA.
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
assert.ok(process.platform!=='win32'||shellDir,'Git for Windows requires its usr/bin/sh.exe for fixture Git');
const run=promisify(execFile);
const scratch=await mkdtemp(join(tmpdir(),'tt-git-history-actions-'));
const work=join(scratch,'work'),remote=join(scratch,'remote.git'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const inheritedEnv={...process.env,GIT_DIR:process.env.GIT_DIR??join(scratch,'contaminating-git-dir')};
const env=Object.fromEntries(Object.entries(inheritedEnv).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
const fixturePath=[dirname(gitExe),shellDir,dirname(process.execPath),join(process.env.SystemRoot,'System32')].filter(Boolean).join(';');
Object.assign(env,{Path:fixturePath,PATH:fixturePath,LANGUAGE:'C',HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-history-actions-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime});
assert.equal(Object.keys(env).filter(key=>/^git_/i.test(key)).length,0,'fixture strips inherited GIT_* variables');
const gitAt=async(cwd,...args)=>(await run(gitExe,args,{cwd,windowsHide:true,timeout:20_000,encoding:'utf8',env})).stdout;
const git=async(...args)=>gitAt(work,...args);
let app,page,releaseLock,cleanupCompleted=false;

try {
 await mkdir(work,{recursive:true}); await mkdir(renderer,{recursive:true});
 await gitAt(scratch,'init','--bare',remote);
 await git('init','-b','main'); await git('config','user.name','ThreadTerm QA'); await git('config','user.email','qa@threadterm.invalid');
 await writeFile(join(work,'conflict.txt'),'base\n'); await git('add','.'); await git('commit','-m','base');
 const base=(await git('rev-parse','HEAD')).trim();
 await git('remote','add','origin',remote); await git('push','-u','origin','main');
 await git('switch','-c','topic'); await writeFile(join(work,'conflict.txt'),'topic\n'); await git('add','conflict.txt'); await git('commit','-m','topic change');
 const topic=(await git('rev-parse','HEAD')).trim();
 await git('switch','main'); await writeFile(join(work,'conflict.txt'),'main\n'); await git('add','conflict.txt'); await git('commit','-m','main conflict'); await git('push');

 for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import {GitHistoryView} from './renderer/src/components/GitHistoryView';import {useGitStatus} from './renderer/src/components/WorkbenchSideBar';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
 const path=${JSON.stringify(work)};const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}};function Probe(){const[scope,setScope]=useState(),[historyKey,setHistoryKey]=useState(0),[focusCommit,setFocusCommit]=useState(),[error,setError]=useState();const git=useGitStatus(scope??{projectId:'pending'},Boolean(scope),false);useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__request=async(method,params)=>{const record={method,params,completed:false};window.__requests.push(record);try{const result=await raw(method,params);record.result=result;return result}catch(error){record.error=String(error);throw error}finally{record.completed=true}};const snapshot=await raw('runtime.snapshot',{});await raw('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await raw('project.add',{path,name:'History actions QA',operationId:crypto.randomUUID()});setScope({projectId:project.id,rootPath:path,worktreePath:path});})().catch(value=>setError(String(value)))},[]);window.__refreshStatus=()=>git.refresh();window.__focusHistory=setFocusCommit;window.__refresh=()=>{void git.refresh();setHistoryKey(value=>value+1)};return error?<p role='alert'>{error}</p>:!scope?<p>Starting isolated runtime…</p>:<I18nProvider locale='en'><main style={{width:900,margin:16}}><SourceControlView scope={scope} actions={actions} git={git} zh={false}/><GitHistoryView key={historyKey} projectId={scope.projectId} worktreePath={scope.rootPath} focusCommit={focusCommit} zh={false}/></main></I18nProvider>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-history-actions-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'qa-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge$/},()=>({path:'bridge',namespace:'qa'}));build.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export * from "./renderer/src/bridge.ts";export const request=(method,params)=>(window.__request??window.threadterm.request)(method,params);',resolveDir:root,loader:'js'}));}}]});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);border:1px solid var(--border);min-height:850px}</style><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-git-history-actions-qa',version:'0.1.0',main:'main.cjs'}));
 const waitForRuntimeExit=async()=>{for(let attempt=0;attempt<100;attempt++){try{const late=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);late.close();}catch{return;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('runtime control pipe stayed available after runtime.shutdown');};
 const historyRow=hash=>page.locator(`[data-commit-hash^="${hash.slice(0,7)}"]`);
 const menuFor=async(hash,keyboard=false)=>{const row=historyRow(hash);await row.waitFor();if(keyboard){await row.focus();await page.keyboard.press('Shift+F10');}else await row.click({button:'right'});const menu=page.getByTestId('context-menu');await menu.waitFor();return menu;};
 const refresh=async()=>{await page.evaluate(()=>window.__refresh());await page.locator('.wb-history-list [role="option"]').first().waitFor();};
 const ensureAllBranches=async()=>{const button=page.getByRole('radio',{name:'All branches',exact:true});if(await button.getAttribute('aria-checked')!=='true')await button.click();};
 let primaryError;
 try {
  releaseLock=await acquireElectronQaLock(); app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60_000}); page=await app.firstWindow({timeout:45_000}); page.setDefaultTimeout(20_000); page.on('pageerror',error=>console.error(`Renderer error: ${error.message}`));
  await ensureAllBranches(); await historyRow(topic).waitFor();
  let menu=await menuFor(base,true); await menu.getByTestId('history-new-branch').click();
  const branchName=page.getByRole('textbox',{name:'Branch name'}); await branchName.fill('from-history'); await page.getByRole('button',{name:'Create branch',exact:true}).click();
  await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.checkout'&&request.completed&&!request.error)); assert.equal((await git('branch','--show-current')).trim(),'from-history'); assert.equal((await git('rev-parse','HEAD')).trim(),base,'new branch uses the selected commit as its base');
  await git('switch','main'); await refresh(); await ensureAllBranches(); await historyRow(topic).waitFor();
  menu=await menuFor(topic); await menu.getByTestId('history-cherry-pick').click();
  const banner=page.getByTestId('git-operation-banner'); await banner.waitFor(); assert.match(await banner.textContent(),/Cherry-picking.*topic change/); assert.equal(await banner.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true,'Continue is disabled while conflicts remain');
  await page.evaluate(hash=>window.__focusHistory(hash),base);await page.locator(`[data-commit-hash="${base}"][aria-selected="true"]`).waitFor();
  await banner.getByRole('button',{name:'Abort',exact:true}).click();await banner.waitFor({state:'detached'});
  assert.equal(await historyRow(base).getAttribute('aria-selected'),'true','Abort preserves an explicit History target');
  menu=await menuFor(topic);await menu.getByTestId('history-cherry-pick').click();await banner.waitFor();
  const continuedTarget=(await git('rev-parse','HEAD')).trim();
  await page.evaluate(hash=>window.__focusHistory(hash),continuedTarget);await page.locator(`[data-commit-hash="${continuedTarget}"][aria-selected="true"]`).waitFor();
  await git('checkout','--theirs','conflict.txt'); await git('add','conflict.txt'); await page.evaluate(()=>window.__refreshStatus()); await banner.getByRole('button',{name:'Continue',exact:true}).waitFor({state:'visible'}); await banner.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.operation.continue'&&request.completed&&!request.error)); assert.equal((await git('log','-1','--format=%s')).trim(),'topic change');
  const picked=(await git('rev-parse','HEAD')).trim();await historyRow(picked).waitFor();assert.equal(await historyRow(continuedTarget).getAttribute('aria-selected'),'true','Continue after conflict preserves the explicit target'); await refresh(); menu=await menuFor(picked); await menu.getByTestId('history-revert').click();
  const revertDialog=page.getByRole('dialog'); await revertDialog.waitFor(); assert.match(await revertDialog.textContent(),/topic change/); await revertDialog.getByRole('button',{name:'Revert commit',exact:true}).click(); await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.revert'&&request.completed&&!request.error)); assert.match((await git('log','-1','--format=%s')).trim(),/^Revert /); const reverted=(await git('rev-parse','HEAD')).trim();await page.locator(`[data-commit-hash="${reverted}"][aria-selected="true"]`).waitFor();
  await writeFile(join(work,'pushed.txt'),'pushed\n'); await git('add','pushed.txt'); await git('commit','-m','pushed reset candidate'); const pushed=(await git('rev-parse','HEAD')).trim(); await git('push');
  await writeFile(join(work,'local.txt'),'local\n'); await git('add','local.txt'); await git('commit','-m','local reset candidate'); const resetHead=(await git('rev-parse','HEAD')).trim(); await refresh(); menu=await menuFor(picked); await menu.getByTestId('history-reset').click();
  const resetDialog=page.getByRole('dialog'); await resetDialog.waitFor(); assert.match(await resetDialog.textContent(),/already pushed|force push/i,'reset warns when commits leaving the branch are upstream'); const mixed=resetDialog.getByRole('radio',{name:/Mixed/i}); await mixed.check(); await resetDialog.getByRole('button',{name:'Reset branch',exact:true}).click(); await page.waitForFunction(()=>window.__requests.some(request=>request.method==='git.reset'&&request.completed&&!request.error)); assert.equal((await git('rev-parse','HEAD')).trim(),picked); const resetStatus=await git('status','--porcelain'); assert.match(resetStatus,/\?\? pushed\.txt/,'mixed reset keeps pushed changes unstaged'); assert.match(resetStatus,/\?\? local\.txt/,'mixed reset keeps local changes unstaged');
  const undo=page.getByRole('button',{name:/Undo reset/i}); await undo.waitFor(); await undo.click(); await page.waitForFunction(()=>window.__requests.filter(request=>request.method==='git.reset'&&request.completed&&!request.error).length>=2); assert.equal((await git('rev-parse','HEAD')).trim(),resetHead,'Undo reset restores the previous head'); assert.equal((await git('rev-parse','HEAD~1')).trim(),pushed);
  await page.waitForFunction(()=>[...document.querySelectorAll('.wb-commit-head button')].some(button=>button.textContent.startsWith('Reset main')&&!button.disabled));
  menu=await menuFor(picked);await menu.getByTestId('history-reset').click();await page.getByRole('dialog').getByRole('button',{name:'Reset branch',exact:true}).click();
  await page.waitForFunction(()=>window.__requests.filter(request=>request.method==='git.reset'&&request.completed&&!request.error).length>=3);await undo.waitFor();
  await git('branch','same-reset-target');
  await page.evaluate(async()=>{const reset=window.__requests.filter(request=>request.method==='git.reset'&&request.completed&&!request.error).at(-1);await window.__request('git.checkout',{projectId:reset.params.projectId,worktreePath:reset.params.worktreePath,branch:'same-reset-target',operationId:crypto.randomUUID()});});
  await undo.waitFor({state:'detached'});assert.equal((await git('rev-parse','main')).trim(),picked);assert.equal((await git('rev-parse','same-reset-target')).trim(),picked);
  console.log('PASS history branch base, explicit target preserved on Abort, explicit target preserved on conflicted Continue, revert, pushed mixed-reset/Undo, and Undo hidden after same-OID branch switch');
 } catch(error) {
  primaryError=error; throw error;
 } finally {
  if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); let peer,shutdownError; try { peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`); const credential=(await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim(); const challenge=JSON.parse(await peer.next()),clientId=randomUUID(); assert.equal(challenge.contract,PROTOCOL_CONTRACT); peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')}); await peer.next(); await peer.request('runtime.shutdown',{operationId:randomUUID()}); } catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code)) shutdownError=error; } finally { peer?.close(); } await app?.close().catch(()=>{}); await waitForRuntimeExit().catch(error=>{shutdownError??=error;}); await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); cleanupCompleted=true; if(shutdownError&&!primaryError)throw shutdownError;
 }
} finally { if(!cleanupCompleted) { await releaseLock?.().catch(()=>{}); await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}); } }
