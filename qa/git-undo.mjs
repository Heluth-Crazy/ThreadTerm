// Real Electron + real Git regression probe for discard/branch undo journal UI.
import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';
import {connectPeer} from './pipe-client.mjs';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const gitExe=process.env.THREADTERM_TEST_GIT;
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime','target-qa','debug','threadterm-v3-runtime.exe');
const file=path=>typeof path==='string'&&isAbsolute(path)&&existsSync(path)&&statSync(path).isFile();
// Validate all prerequisites before allocating a scratch directory.
assert.ok(file(gitExe),'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
assert.ok(file(runtime),'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
const shellDir=[resolve(dirname(gitExe),'../..','usr/bin'),resolve(dirname(gitExe),'..','usr/bin')].find(path=>existsSync(join(path,'sh.exe')));
assert.ok(process.platform!=='win32'||shellDir,'Git for Windows requires its usr/bin/sh.exe');

const run=promisify(execFile),scratch=await mkdtemp(join(tmpdir(),'tt-git-undo-'));
const work=join(scratch,'work'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
const fixturePath=[dirname(gitExe),shellDir,dirname(process.execPath),join(process.env.SystemRoot,'System32')].filter(Boolean).join(';');
Object.assign(env,{Path:fixturePath,PATH:fixturePath,LANGUAGE:'C',HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-undo-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,THREADTERM_TEST_GIT:gitExe});
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20_000,encoding:'utf8',env})).stdout;
let app,page,releaseLock,cleaned=false;
const wait=async(fn,label)=>{const until=Date.now()+30_000;let last;while(Date.now()<until){try{if(await fn())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`${label}${last?`: ${last.message}`:''}`);};
const waitForRuntimeExit=async()=>{for(let attempt=0;attempt<100;attempt++){try{const late=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);late.close();}catch{return;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('runtime control pipe stayed available after runtime.shutdown');};
let primaryError;

try {
 await mkdir(work,{recursive:true});await mkdir(renderer,{recursive:true});
 await git('init','-b','main');await git('config','user.name','ThreadTerm QA');await git('config','user.email','qa@threadterm.invalid');
 await writeFile(join(work,'note.txt'),'base\n');await git('add','note.txt');await git('commit','-m','base');await git('branch','delete-me');
 for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 const source=`import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{SourceControlView}from'./renderer/src/components/SourceControlView';import{useGitStatus}from'./renderer/src/components/WorkbenchSideBar';import{I18nProvider}from'./renderer/src/i18n';import'./renderer/src/styles.css';import'./renderer/src/workbench/workbench.css';const path=${JSON.stringify(work)};const actions={openFile(){},openDiff(){},dirtyPaths(){return[]},renamed(){},deleted(){}};function App(){const[scope,setScope]=useState(),[error,setError]=useState(),[toolbar,setToolbar]=useState();const git=useGitStatus(scope??{projectId:'pending'},Boolean(scope),false);useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__request=async(m,p)=>{const row={method:m,params:p};window.__requests.push(row);return raw(m,p)};const project=await raw('project.add',{path,name:'Git undo QA',operationId:crypto.randomUUID()});setScope({projectId:project.id,rootPath:path,worktreePath:path});})().catch(e=>setError(String(e)))},[]);window.__refresh=()=>git.refresh();return error?<p role='alert'>{error}</p>:!scope?<p>Starting…</p>:<I18nProvider locale='en'><div ref={setToolbar}/><SourceControlView scope={scope} actions={actions} git={git} zh={false} toolbarHost={toolbar}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-undo-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'bridge',setup(b){b.onResolve({filter:/^\.\.\/bridge$/},()=>({path:'bridge',namespace:'qa'}));b.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export * from "./renderer/src/bridge.ts";export const request=(m,p)=>(window.__request??window.threadterm.request)(m,p);',resolveDir:root,loader:'js'}));}}]});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html><body><div id="root"></div><script src="probe.js"></script></body></html>');await writeFile(join(appDir,'package.json'),JSON.stringify({name:'git-undo-qa',version:'0.1.0',main:'main.cjs'}));
 releaseLock=await acquireElectronQaLock();app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60_000});page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(20_000);
 await page.locator('.wb-branch-chip').waitFor();await writeFile(join(work,'note.txt'),'changed\n');await page.evaluate(()=>window.__refresh());await page.getByLabel('Discard changes').waitFor();await page.getByLabel('Discard changes').click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Discard',exact:true}).click();await page.getByRole('button',{name:'Undo',exact:true}).click();await wait(async()=>await readFile(join(work,'note.txt'),'utf8')==='changed\n','discard Undo restores working bytes');
	 await git('checkout','--','note.txt');await page.evaluate(()=>window.__refresh());await page.locator('.wb-branch-chip').click();await page.getByLabel('Delete delete-me').click();await page.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();await wait(async()=>!(await git('branch','--list','delete-me')).trim(),'branch deleted');await page.getByLabel('More actions').click();await page.getByRole('menuitem',{name:'Recent actions',exact:true}).click();const recentActions=page.getByRole('dialog'),branchUndo=recentActions.locator('.wb-undo-entry').filter({hasText:/Delete.*delete-me/});await branchUndo.waitFor();await branchUndo.getByRole('button',{name:'Undo',exact:true}).click();await wait(async()=>Boolean((await git('branch','--list','delete-me')).trim()),'Recent actions Undo recreates branch');
 console.log('PASS discard Undo restores content; branch delete Recent actions Undo restores branch');
} catch(error) {
 primaryError=error;throw error;
} finally {
 let peer,shutdownError;
 await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});
 try {peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);const credential=(await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim(),challenge=JSON.parse(await peer.next()),clientId=randomUUID();assert.equal(challenge.contract,PROTOCOL_CONTRACT);peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});await peer.next();await peer.request('runtime.shutdown',{operationId:randomUUID()});} catch(error) {if(!['ENOENT','ECONNREFUSED'].includes(error?.code))shutdownError=error;} finally {peer?.close();}
 await app?.close().catch(()=>{});await waitForRuntimeExit().catch(error=>{shutdownError??=error;});await releaseLock?.().catch(error=>{shutdownError??=error;});await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});cleaned=true;if(shutdownError&&!primaryError)throw shutdownError;
}
if(!cleaned) throw Error('Git undo QA cleanup did not complete');
