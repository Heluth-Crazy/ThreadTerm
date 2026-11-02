// Real Electron + real Git regression probe for the Source Control "Branch" scope (branch vs base).
//
// Fixture: `feature` is one commit ahead of `origin/main` (a modified file and a committed rename),
// plus an uncommitted tracked change and an untracked file. `base2` points one commit further back.
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

const run=promisify(execFile),scratch=await mkdtemp(join(tmpdir(),'tt-git-branch-scope-'));
const work=join(scratch,'work'),originDir=join(scratch,'origin.git'),peerDir=join(scratch,'peer'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
// GIT_* variables (author identity, index, default branch) must never leak into the fixture repository.
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
const fixturePath=[dirname(gitExe),shellDir,dirname(process.execPath),join(process.env.SystemRoot,'System32')].filter(Boolean).join(';');
Object.assign(env,{Path:fixturePath,PATH:fixturePath,LANGUAGE:'C',HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-branch-scope-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,THREADTERM_TEST_GIT:gitExe});
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20_000,encoding:'utf8',env})).stdout;
const gitIn=async(dir,...args)=>(await run(gitExe,args,{cwd:dir,windowsHide:true,timeout:20_000,encoding:'utf8',env})).stdout;
let app,page,releaseLock,cleaned=false;
const wait=async(fn,label)=>{const until=Date.now()+30_000;let last;while(Date.now()<until){try{if(await fn())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`${label}${last?`: ${last.message}`:''}`);};
const waitForRuntimeExit=async()=>{for(let attempt=0;attempt<100;attempt++){try{const late=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);late.close();}catch{return;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('runtime control pipe stayed available after runtime.shutdown');};
const write=async(name,text)=>{await writeFile(join(work,name),text);};
const listedPaths=()=>page.locator('[data-branch-path]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-branch-path')));
const diffPath=()=>page.locator('.tt-diff-shell .path').innerText();
let primaryError;

try {
 await mkdir(work,{recursive:true});await mkdir(renderer,{recursive:true});await mkdir(originDir,{recursive:true});
 await git('init','-q','--bare',originDir);
 await git('init','-q','-b','main');
 await git('config','user.name','ThreadTerm QA');await git('config','user.email','qa@threadterm.invalid');await git('config','core.autocrlf','false');
 await write('a.txt','a1\n');await write('committed.txt','c1\n');await write('working.txt','w1\n');await write('rename-src.txt','one\ntwo\nthree\n');
 await git('add','.');await git('commit','-qm','base');
 const base2=await git('rev-parse','HEAD');
 await git('branch','base2',base2.trim());
 await write('a.txt','a2\n');
 await git('commit','-qam','main moves on');
 await git('remote','add','origin',originDir);
 await git('push','-qu','origin','main');
 // The bare remote's HEAD is the default branch a fresh clone would pick.
 await gitIn(originDir,'symbolic-ref','HEAD','refs/heads/main');
 await git('switch','-qc','feature');
 await write('committed.txt','c2\n');
 await git('mv','rename-src.txt','renamed.txt');
 await git('add','-A');
 await git('commit','-qm','feature commit');
 await write('working.txt','w2\n');
 await write('fresh.txt','new\n');
 assert.equal((await git('rev-parse','--abbrev-ref','HEAD')).trim(),'feature');

 for(const name of ['main','preload']) await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 // The fixture keeps one diff tab per path and re-points it at the compare it is asked for, like the session
 // workspace reusing a tab; the file workspace must adopt the new compare instead of keeping the old scope.
 const source=`import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{SourceControlView}from'./renderer/src/components/SourceControlView';import{FileWorkspace}from'./renderer/src/components/FileWorkspace';import{useGitStatus}from'./renderer/src/components/WorkbenchSideBar';import{I18nProvider}from'./renderer/src/i18n';import'./renderer/src/styles.css';import'./renderer/src/workbench/workbench.css';const path=${JSON.stringify(work)};function App(){const[scope,setScope]=useState(),[error,setError]=useState(),[toolbar,setToolbar]=useState(),[tab,setTab]=useState();const git=useGitStatus(scope??{projectId:'pending'},Boolean(scope),false);useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);window.__requests=[];window.__request=async(m,p)=>{window.__requests.push(m);return raw(m,p)};window.__count=m=>window.__requests.filter(entry=>entry===m).length;const project=await raw('project.add',{path,name:'Git branch scope QA',operationId:crypto.randomUUID()});setScope({projectId:project.id,rootPath:path,worktreePath:path});})().catch(e=>setError(String(e)))},[]);window.__refresh=()=>git.refresh();const actions={openFile(){},openDiff(file,staged,compare){setTab(current=>current&&current.path===file?{...current,compare}:{path:file,compare,key:crypto.randomUUID()})},dirtyPaths(){return[]},renamed(){},deleted(){}};if(error)return <p role='alert'>{error}</p>;if(!scope)return <p>Starting…</p>;return <I18nProvider locale='en'><div className='probe-layout'><div ref={setToolbar}/><div className='probe-scm'><SourceControlView scope={scope} actions={actions} git={git} zh={false} toolbarHost={toolbar}/></div>{tab&&<div className='probe-diff'><FileWorkspace key={tab.key} projectId={scope.projectId} worktreePath={scope.worktreePath} rootPath={scope.rootPath} initialPath={tab.path} initialView='diff' initialCompare={tab.compare} editorId='probe-editor'/></div>}</div></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-branch-scope-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error',plugins:[{name:'bridge',setup(b){b.onResolve({filter:/^\.\.\/bridge$/},()=>({path:'bridge',namespace:'qa'}));b.onLoad({filter:/^bridge$/,namespace:'qa'},()=>({contents:'export * from "./renderer/src/bridge.ts";export const request=(m,p)=>(window.__request??window.threadterm.request)(m,p);',resolveDir:root,loader:'js'}));}}]});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html><body><div id="root"></div><script src="probe.js"></script></body></html>');
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'git-branch-scope-qa',version:'0.1.0',main:'main.cjs'}));
 releaseLock=await acquireElectronQaLock();
 app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60_000});
 page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(25_000);
 page.on('pageerror',error=>console.error('PAGE ERROR:',error.message));
 page.on('console',message=>{ if(message.type()==='error') console.error('CONSOLE ERROR:',message.text()); });
 await page.locator('.wb-branch-chip').waitFor();
 const compareFilesCalls=()=>page.evaluate(()=>window.__count('git.compare.files'));

 // 1. The Branch scope lists everything the current branch changes against its base, from one request.
 await page.getByRole('tab',{name:'Branch'}).click();
 const summary=page.locator('[data-testid="branch-scope-summary"]');
 await page.locator('[data-branch-path]').first().waitFor();
 await wait(async()=>/4 files/.test(await summary.innerText()),'four files against origin/main');
 assert.match(await summary.innerText(),/feature vs origin\/main · 4 files · \+\d+ −\d+/);
 assert.deepEqual(await listedPaths(),['committed.txt','fresh.txt','renamed.txt','working.txt']);
 assert.equal(await page.locator('[data-branch-path="fresh.txt"]').getAttribute('data-branch-status'),'added');
 assert.equal(await page.locator('[data-branch-path="renamed.txt"]').getAttribute('data-branch-status'),'renamed');
 assert.equal(await compareFilesCalls(),1,'entering the Branch scope costs exactly one git.compare.files');
 // Showing the panel again (focus/visibility) refreshes the list without a second entry load.
 const beforeFocus=await compareFilesCalls();
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await wait(async()=>await compareFilesCalls()>beforeFocus,'focus refreshes the Branch list');

 // 2. A renamed file's diff reads its base side from the pre-rename path...
 await page.locator('[data-branch-path="renamed.txt"] button.wb-change-open').click();
 const diffSurface=page.locator('.tt-diff-shell');
 await diffSurface.waitFor();
 await wait(async()=>/renamed\.txt/.test(await diffPath()),'renamed.txt diff opens');
 await wait(async()=>/one\ntwo\nthree/.test(await diffSurface.innerText()),'the base side comes from the pre-rename path');
 // ...and Alt+→ must not carry that path to the next file: its own base side is read from its own path.
 await wait(async()=>/File 3\/4/.test(await page.locator('[aria-label="File navigation"] .wb-hunk-count').innerText()),'navigation counts the branch files');
 await diffSurface.locator('.cm-editor').first().click();
 await page.keyboard.press('Alt+ArrowRight');
 await wait(async()=>/working\.txt/.test(await diffPath()),'Alt+ArrowRight reaches the next file');
 await wait(async()=>/w1/.test(await diffSurface.innerText()),'the next file shows its own base side');
 assert.doesNotMatch(await diffSurface.innerText(),/three/,'the rename source is not reused for another file');

 // 2b. The task 9 roving keys work here: ArrowDown moves, Enter opens, Space and Delete do nothing.
 await page.locator('[data-branch-path="committed.txt"] button.wb-change-open').focus();
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.evaluate(()=>document.activeElement?.closest('[data-branch-path]')?.getAttribute('data-branch-path')),'fresh.txt');
 await page.keyboard.press('Enter');
 await wait(async()=>/fresh\.txt/.test(await diffPath()),'Enter opens the focused row');
 await page.locator('[data-branch-path="committed.txt"] button.wb-change-open').focus();
 await page.keyboard.press('Space');
 await page.keyboard.press('Delete');
 assert.equal(await page.locator('[data-branch-path]').count(),4,'Space and Delete leave the Branch list untouched');
 assert.match(await diffPath(),/fresh\.txt/,'Space does not open a file in this scope');

 // 3. Committed only drops the uncommitted and untracked files.
 await page.getByLabel('Committed only').check();
 await wait(async()=>/2 files/.test(await summary.innerText()),'committed-only leaves the committed files');
 await wait(async()=>await page.locator('[data-branch-path="fresh.txt"]').count()===0,'untracked file leaves the list');
 assert.deepEqual(await listedPaths(),['committed.txt','renamed.txt']);

 // 3b. Re-opening a file for another scope makes that tab adopt it (working tree ↔ committed only).
 await page.getByLabel('Committed only').uncheck();
 await wait(async()=>/4 files/.test(await summary.innerText()),'the working-tree scope is back');
 await page.locator('[data-branch-path="renamed.txt"] button.wb-change-open').click();
 await wait(async()=>/Working tree · vs origin\/main/.test((await diffSurface.locator('.file-bar-compare').getAttribute('title'))??''),'the tab follows the working-tree scope again');
 assert.equal(await diffSurface.getByRole('button',{name:'Save changes',exact:true}).count(),0,'a clean working side hides Save');
 const workingEditor=diffSurface.locator('.cm-merge-b .cm-content');await workingEditor.click();await workingEditor.press('Control+End');await page.keyboard.type('scope-qa');await diffSurface.getByRole('button',{name:'Save changes',exact:true}).waitFor();await workingEditor.press('Control+z');await wait(async()=>await diffSurface.getByRole('button',{name:'Save changes',exact:true}).count()===0,'working-side edits reveal Save and undo restores the clean state');
 await page.getByLabel('Committed only').check();
 await page.locator('[data-branch-path="renamed.txt"] button.wb-change-open').click();
 await wait(async()=>/Committed changes only · vs origin\/main/.test((await diffSurface.locator('.file-bar-compare').getAttribute('title'))??''),'the same tab adopts the committed-only scope');
 assert.equal(await diffSurface.getByRole('button',{name:'Save changes',exact:true}).count(),0,'the committed side has no Save');
 const committedEditor=diffSurface.locator('.cm-merge-b .cm-content');const committedText=await committedEditor.innerText();await committedEditor.click();await committedEditor.press('Control+End');await page.keyboard.type('readonly-qa');assert.equal(await committedEditor.innerText(),committedText,'the committed side rejects edits');
 await page.getByLabel('Committed only').uncheck();
 await wait(async()=>/4 files/.test(await summary.innerText()),'the working-tree scope is back again');
 await page.locator('[data-branch-path="renamed.txt"] button.wb-change-open').click();
 await wait(async()=>/Working tree · vs origin\/main/.test((await diffSurface.locator('.file-bar-compare').getAttribute('title'))??''),'the tab is back in the working-tree scope');

 // 4. A base that moved under an open compare tab offers a reload, and the tab adopts the fresh base.
 await mkdir(peerDir,{recursive:true});
 await gitIn(peerDir,'clone','-q',originDir,'.');
 await gitIn(peerDir,'config','user.name','ThreadTerm QA');
 await gitIn(peerDir,'config','user.email','qa@threadterm.invalid');
 await writeFile(join(peerDir,'peer.txt'),'peer\n');
 await gitIn(peerDir,'add','.');
 await gitIn(peerDir,'commit','-qm','peer pushes');
 await gitIn(peerDir,'push','-q');
 await git('fetch','-q','origin');
 await diffSurface.locator('.cm-editor').first().click();
 await page.keyboard.press('Alt+ArrowRight');
 const stale=page.locator('[data-testid="compare-stale"]');
 await stale.waitFor();
 assert.match(await stale.innerText(),/The base branch changed/);
 await stale.getByRole('button',{name:'Reload against the current base',exact:true}).click();
 await wait(async()=>await stale.count()===0,'the tab reloads against the current base');
 await wait(async()=>/working\.txt/.test(await diffPath()),'the diff renders again after the reload');
 assert.doesNotMatch(await diffSurface.innerText(),/three/,'the reloaded diff has no stale base content');

 // 5. Choosing another base compares from that commit instead.
 await page.locator('select[aria-label="Base branch"] option[value="base2"]').waitFor({state:'attached'});
 await page.getByLabel('Base branch').selectOption('base2');
 await wait(async()=>/base2/.test(await summary.innerText()),'the header names the chosen base');
 await wait(async()=>/5 files/.test(await summary.innerText()),'base2 adds the file that only main changed');
 assert.equal(await page.locator('[data-branch-path="a.txt"]').getAttribute('data-branch-status'),'modified');

 // Switching the same standalone tab back to an ordinary diff restores its gutter actions.
 assert.equal(await diffSurface.locator('.cm-merge-stage:visible').count(),0,'compare scope has no index staging action');
 await page.getByRole('tab',{name:'Changes',exact:true}).click();
 await page.locator('.probe-scm .wb-changes .wb-change-open',{hasText:'working.txt'}).first().click();
 await wait(async()=>await diffSurface.locator('.file-bar-compare').count()===0,'ordinary scope replaces the compare pill');
 await diffSurface.getByRole('button',{name:'Stage hunk',exact:true}).first().waitFor();

 const requests=await page.evaluate(()=>window.__requests??[]);
 assert.ok(requests.includes('git.compare.diff'),'the diff uses git.compare.diff');
 console.log('PASS Branch scope lists files, renames keep their own base side across Alt+ArrowRight, committed-only adopts the tab, base switching and a moved base reload');
} catch(error) {
 primaryError=error;throw error;
} finally {
 let peer,shutdownError;
 await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});
 try {peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);const credential=(await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim(),challenge=JSON.parse(await peer.next()),clientId=randomUUID();assert.equal(challenge.contract,PROTOCOL_CONTRACT);peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});await peer.next();await peer.request('runtime.shutdown',{operationId:randomUUID()});} catch(error) {if(!['ENOENT','ECONNREFUSED'].includes(error?.code))shutdownError=error;} finally {peer?.close();}
 await app?.close().catch(()=>{});
 await waitForRuntimeExit().catch(error=>{shutdownError??=error;});
 await releaseLock?.().catch(error=>{shutdownError??=error;});
 await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 cleaned=true;
 if(shutdownError&&!primaryError)throw shutdownError;
}
if(!cleaned) throw Error('Git branch scope QA cleanup did not complete');
