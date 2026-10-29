// Actual Desktop-1 Git gutter hunk popup -> production preload/main -> Rust -> Git QA.
// This fixture owns every repo, runtime profile and pipe it starts.
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
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
const isAbsoluteFile=path=>typeof path==='string'&&isAbsolute(path)&&existsSync(path)&&statSync(path).isFile();
assert.ok(isAbsoluteFile(gitExe),'Set THREADTERM_TEST_GIT to an absolute existing Git executable');
assert.ok(isAbsoluteFile(runtime),'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
const electronExecutable=join(root,'node_modules','electron','dist',process.platform==='win32'?'electron.exe':'electron');
assert.ok(isAbsoluteFile(electronExecutable),'Electron executable is unavailable');
const prerequisiteRun=promisify(execFile);const gitVersion=await prerequisiteRun(gitExe,['--version'],{windowsHide:true,timeout:20000,encoding:'utf8'});
assert.match(gitVersion.stdout,/^git version /,'THREADTERM_TEST_GIT must execute Git');
const scratch=await mkdtemp(join(tmpdir(),'tt-git-gutter-hunk-'));
const work=join(scratch,'work'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const run=promisify(execFile);
const inheritedEnv={...process.env,GIT_DIR:process.env.GIT_DIR??join(scratch,'contaminating-git-dir')};
const env=Object.fromEntries(Object.entries(inheritedEnv).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|git_.*)$/i.test(key)));
const fixturePath=[dirname(gitExe),dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';');
Object.assign(env,{Path:fixturePath,PATH:fixturePath,HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home/.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-git-gutter-hunk-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
assert.equal(Object.keys(env).filter(key=>/^git_/i.test(key)).length,0,'fixture Git and runtime strip inherited GIT_* variables');
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20000,encoding:'utf8',env})).stdout;
async function until(probe,label,timeout=20_000) {const deadline=Date.now()+timeout;let error;for(;;){try{const value=await probe();if(value)return value;}catch(value){error=value;}if(Date.now()>=deadline)throw Error(`Timed out: ${label}${error?`: ${error.message}`:''}`);await new Promise(resolve=>setTimeout(resolve,100));}}
let app,page,releaseLock,cleanupCompleted=false;

try {
 await mkdir(work,{recursive:true});await mkdir(renderer,{recursive:true});
 await git('init','-b','main');await git('config','user.name','ThreadTerm QA');await git('config','user.email','qa@threadterm.invalid');
 const base='alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\n';
 const changed=base.replace('bravo','BRAVO current').replace('golf','GOLF current');
 await writeFile(join(work,'note.txt'),base);await git('add','note.txt');await git('commit','-m','base');
 for(const name of ['main','preload'])await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {EditorView} from '@codemirror/view';import {FileWorkspace} from './renderer/src/components/FileWorkspace';import {CommandPalette} from './renderer/src/components/CommandPalette';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
 const path=${JSON.stringify(work)};window.__editorText=()=>{const node=document.querySelector('.cm-content');const view=node&&EditorView.findFromDOM(node);return view?.state.doc.toString()};function Probe(){const[scope,setScope]=useState(),[error,setError]=useState(),[data,setData]=useState(),[palette,setPalette]=useState(false);useEffect(()=>{const key=event=>{if(event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='k'){event.preventDefault();setPalette(true)}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key)},[]);useEffect(()=>{(async()=>{const raw=window.threadterm.request.bind(window.threadterm);const snapshot=await raw('runtime.snapshot',{});await raw('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await raw('project.add',{path,name:'Git gutter hunk QA',operationId:crypto.randomUUID()});setData(await raw('runtime.snapshot',{}));setScope({projectId:project.id,rootPath:path});})().catch(value=>setError(String(value)))},[]);if(error)return <p role='alert'>{error}</p>;return scope?<I18nProvider locale='en'><main style={{width:760,height:620,margin:16}}><FileWorkspace projectId={scope.projectId} rootPath={scope.rootPath} initialPath='note.txt' initialView='file'/></main>{palette&&data&&<CommandPalette data={data} onClose={()=>setPalette(false)} onSession={()=>{}} onProject={()=>{}} onCreate={()=>{}} onCreateGroup={()=>{}} onAll={()=>{}} onInbox={()=>{}} onSettings={()=>{}}/>}</I18nProvider>:<p>Starting isolated runtime…</p>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-gutter-hunk-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(renderer,'probe.js'),logLevel:'error'});
 await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{margin:0;min-height:100%;background:var(--bg);color:var(--text)}main{background:var(--surface);border:1px solid var(--border)}</style><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-git-gutter-hunk-qa',version:'0.1.0',main:'main.cjs'}));
 try {
  releaseLock=await acquireElectronQaLock();app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>console.error(`Renderer error: ${error.message}`));
  const editor=page.locator('.cm-content[contenteditable=true]');await editor.waitFor();await editor.click();await page.keyboard.press('Control+a');await page.keyboard.insertText(changed);await page.keyboard.press('Control+s');
  await page.waitForFunction(text=>window.__editorText?.()===text,changed);await until(async()=>await readFile(join(work,'note.txt'),'utf8')===changed,'saved editor text reaches disk');await page.waitForFunction(()=>document.querySelectorAll('.cm-git-marker').length===2);
  const popup=page.locator('.cm-git-hunk-popup[role="dialog"]');await editor.click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Alt+F7');await popup.waitFor();
  assert.equal(await popup.getAttribute('aria-label'),'Git change');assert.equal(await popup.getByText(/Change 1 of 2/).count(),1);assert.equal(await popup.evaluate(node=>node.contains(document.activeElement)),true,'Alt+F7 moves focus into the popup');
  const popupButtons=popup.locator('button:not(:disabled)');await popupButtons.first().focus();await page.keyboard.press('Shift+Tab');assert.equal(await popupButtons.last().evaluate(node=>node===document.activeElement),true,'Shift+Tab wraps to the last enabled popup button');await page.keyboard.press('Tab');assert.equal(await popupButtons.first().evaluate(node=>node===document.activeElement),true,'Tab wraps to the first enabled popup button');
  await page.keyboard.press('Escape');await popup.waitFor({state:'detached'});await page.locator('.cm-git-marker').first().click();await popup.waitFor();
  assert.match(await popup.innerText(),/bravo[\s\S]*BRAVO current/i,'first popup shows base and current lines');
  await page.keyboard.press('Control+k');const palette=page.getByRole('dialog',{name:'Command palette',exact:true});await palette.waitFor();await popup.waitFor({state:'detached'});await palette.locator('input').fill('New terminal');assert.equal(await palette.getByRole('button',{name:/New terminal/}).count(),1);assert.equal(await palette.locator('input').evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Escape');await palette.waitFor({state:'detached'});await page.locator('.cm-git-marker').first().click();await popup.waitFor();
  await page.keyboard.press('F7');await page.waitForFunction(()=>document.querySelector('.cm-git-hunk-popup')?.textContent?.includes('GOLF current'));
  assert.match(await popup.innerText(),/golf[\s\S]*GOLF current/i,'F7 moves the popup to the second hunk');
  await popup.getByRole('button',{name:'Stage this change'}).click();await page.waitForFunction(()=>document.querySelectorAll('.cm-git-marker').length===1);
  const staged=await git('diff','--cached','--','note.txt'),unstaged=await git('diff','--','note.txt');
  assert.match(staged,/GOLF current/);assert.doesNotMatch(staged,/BRAVO current/);assert.match(unstaged,/BRAVO current/);assert.doesNotMatch(unstaged,/GOLF current/);
  await page.locator('.cm-git-marker').click();await popup.waitFor();await popup.getByRole('button',{name:'Revert'}).click();await page.waitForFunction(text=>window.__editorText?.()===text,base.replace('golf','GOLF current'));assert.equal(await readFile(join(work,'note.txt'),'utf8'),changed,'revert changes only the buffer');
  await editor.focus();await page.keyboard.press('Control+z');await page.waitForFunction(text=>window.__editorText?.()===text,changed);
  await page.keyboard.press('Control+End');await page.keyboard.insertText('unsaved');await page.waitForFunction(text=>window.__editorText?.()===text,`${changed}unsaved`);await page.waitForFunction(()=>document.querySelectorAll('.cm-git-marker').length===2);await page.locator('.cm-git-marker').first().click();await popup.waitFor();const stage=popup.getByRole('button',{name:'Stage this change'});assert.equal(await stage.isDisabled(),true);assert.equal(await stage.getAttribute('title'),'Save the file to stage this change');
  await page.keyboard.press('Escape');await popup.waitFor({state:'detached'});assert.equal(await editor.evaluate(node=>node===document.activeElement),true,'Escape returns focus to the editor');
  await page.locator('.cm-git-marker').first().click();await popup.getByRole('button',{name:'Open in diff'}).click();await page.locator('.tt-diff-shell .merge-editor').waitFor();
  console.log('PASS Git gutter popup opens from Alt+F7 and a marker, traps Tab focus, yields to the command palette, follows F7, stages one hunk with real Git, reverts only the buffer with undo, fences dirty staging, restores editor focus, and opens the diff');
 } catch(error) {
  const diagnostic=await page?.evaluate(()=>({workspace:document.querySelector('.file-workspace')?.innerText?.slice(0,4000),alerts:Array.from(document.querySelectorAll('[role="alert"],.surface-error,.wb-issue')).map(node=>node.textContent),markers:document.querySelectorAll('.cm-git-marker').length,popup:document.querySelector('.cm-git-hunk-popup')?.textContent,editor:window.__editorText?.()})).catch(value=>({diagnosticError:String(value)}));
  console.error(`Git gutter hunk diagnostics: ${JSON.stringify(diagnostic)}`);throw error;
 } finally {
  if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});let peer,shutdownError;try{peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim();const challenge=JSON.parse(await peer.next()),clientId=randomUUID();assert.equal(challenge.contract,PROTOCOL_CONTRACT);peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});await peer.next();await peer.request('runtime.shutdown',{operationId:randomUUID()})}catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))shutdownError=error}finally{peer?.close()}await app?.close().catch(()=>{});await releaseLock?.().catch(()=>{});await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});cleanupCompleted=true;if(shutdownError)throw shutdownError;
 }
} finally {if(!cleanupCompleted){await releaseLock?.().catch(()=>{});await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}
