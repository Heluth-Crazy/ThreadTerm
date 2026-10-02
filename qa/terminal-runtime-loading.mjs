// Production Rust + RuntimeClient + sandboxed preload + React/xterm.
// Only IPC registration is a small harness; no mocked output/cursors or CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { terminalWindowArguments } from '../desktop/src/terminalEnvironment.ts';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-runtime-loading-'));
const data = join(scratch, 'data'); await mkdir(data);
// Codex's directory-trust prompt is intentionally not auto-accepted. Use the
// existing user-scoped repository that is already trusted, while keeping all
// ThreadTerm state (DATA, PIPE, USER_DATA) in this test's private directory.
const cwd = resolve(process.env.THREADTERM_QA_CODEX_CWD ?? '..');
const pipe = `\\\\.\\pipe\\threadterm-loading-${randomUUID()}`;
const exe = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target/debug/threadterm-v3-runtime.exe');
const runtimeEnv = {...process.env, THREADTERM_V3_DATA:data, THREADTERM_V3_PIPE:pipe, THREADTERM_V3_RUNTIME:exe};
const checks = [];
async function until(check, label, timeout=30000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,150))}
 throw new Error(`Timed out: ${label}`);
}
const entry = `
import React, {useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {TerminalSurface} from './renderer/src/components/TerminalSurface';
import {SessionCreateDialog} from './renderer/src/components/SessionCreateDialog';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const open=Terminal.prototype.open;
Terminal.prototype.open=function(el){window.term=this;window.replayed=[];return open.call(this,el)};
const write=Terminal.prototype.write;
Terminal.prototype.write=function(data,callback){if(data instanceof Uint8Array)window.replayed.push(Array.from(data));return write.call(this,data,callback)};
function Fixture(){
 const [session,setSession]=useState(),[dialog,setDialog]=useState(false),[snapshot,setSnapshot]=useState();
 window.showSession=setSession; window.showDialog=()=>{window.created=undefined;setSession(undefined);setDialog(true)};
 useEffect(()=>{const update=()=>window.threadterm.request('runtime.snapshot',{}).then(s=>{setSnapshot(s);setSession(old=>old?s.sessions.find(x=>x.id===old.id)??old:old)});update();const t=setInterval(update,300);return()=>clearInterval(t)},[]);
 return <I18nProvider locale="zh-CN"><div className="fixture">{session&&<TerminalSurface key={session.id} sessionId={session.id} session={session} provider={session.provider} theme="light" terminalCompatibility={{}}/>}{dialog&&snapshot&&<SessionCreateDialog data={snapshot} initialPath={${JSON.stringify(cwd)}} initialProvider="codex" onClose={()=>setDialog(false)} onCreated={s=>{window.created=s;setDialog(false);setSession(s)}}/>}</div></I18nProvider>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<link rel="stylesheet" href="qa.css"><style>html,body,#root,.fixture{height:100%;margin:0}.fixture{display:flex}.fixture>.terminal-wrap{flex:1;min-width:0;min-height:0}</style><div id="root"></div><script src="qa.js"></script>');
const main = `
import {app,BrowserWindow,ipcMain} from 'electron';
import {RuntimeClient} from './desktop/src/runtime-client';
import {validateRequest} from './protocol/index';
app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});
const client=new RuntimeClient(), subs=new Map();
const calls=[]; globalThis.__terminalLoadingCalls=calls;
function close(id){const s=subs.get(id);if(!s)return;subs.delete(id);s.unsubscribe?.();for(const ack of s.acks)ack()}
ipcMain.handle('threadterm:request',(_e,m,p)=>{calls.push({method:m,params:p});validateRequest(m,p);return client.request(m,p)});
ipcMain.handle('threadterm:subscribe-output',async(e,sessionId,cursor,id)=>{
 subs.set(id,{acks:[]});
 try{const unsubscribe=await client.subscribeOutput(sessionId,cursor,chunk=>new Promise(resolve=>{const s=subs.get(id);if(!s||e.sender.isDestroyed()){resolve();return}s.acks.push(resolve);e.sender.send('threadterm:output',{id,chunk})}));const s=subs.get(id);if(!s){unsubscribe();throw Error('cancelled')}s.unsubscribe=unsubscribe;return{id}}catch(err){close(id);throw err}
});
ipcMain.handle('threadterm:ack-output',(_e,id)=>subs.get(id)?.acks.shift()?.());
ipcMain.handle('threadterm:unsubscribe-output',(_e,id)=>close(id));
app.on('before-quit',()=>{for(const id of subs.keys())close(id);client.dispose()});
app.whenReady().then(()=>new BrowserWindow({width:1050,height:800,show:false,webPreferences:{preload:${JSON.stringify(resolve('desktop-dist/preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,additionalArguments:${JSON.stringify(terminalWindowArguments(process.platform,release()))}}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));
`;
await build({stdin:{contents:main,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(scratch,'main.cjs')});
let app;
const daemon = spawn(exe, [], {env:runtimeEnv, windowsHide:true, stdio:'ignore'});
try {
 app=await electron.launch({args:[join(scratch,'main.cjs')],env:runtimeEnv});
 const page=await app.firstWindow(); page.setDefaultTimeout(20000); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.showSession&&window.threadterm);
 const request=(method,params={})=>page.evaluate(({method,params})=>window.threadterm.request(method,params),{method,params});
 await request('project.add',{path:cwd,operationId:randomUUID()});
 // Chat records have legitimately empty terminal history, without synthesizing DB rows.
 const empty=await request('session.create',{cwd,provider:'codex',mode:'chat',operationId:randomUUID()});
 const boundary=await request('terminal.read',{sessionId:empty.id,tail:true,limit:1});
 assert.equal(boundary.fromCursor,0);assert.equal(boundary.nextCursor,0);assert.equal(boundary.data,'');
 await page.evaluate(s=>window.showSession(s),empty);
 await page.waitForFunction(()=>document.querySelector('.terminal-host')&&getComputedStyle(document.querySelector('.terminal-host')).visibility==='visible'&&!document.querySelector('.term-replaying'));
 checks.push('real empty history cursor is zero and replay ends');
 const large=await request('session.create',{cwd,provider:'custom',mode:'terminal',executable:'cmd.exe',args:['/D','/C','for /L %i in (1,1,2400) do @echo LINE-%i-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'],operationId:randomUUID()});
 await until(async ()=>(await request('runtime.snapshot')).sessions.find(x=>x.id===large.id)?.status==='exited','shell exit',60000);
 await until(async ()=>(await request('terminal.read',{sessionId:large.id,tail:true,limit:1})).nextCursor>65536,'large output flush');
 const retained=await request('terminal.read',{sessionId:large.id,cursor:0,limit:1048576});
 assert.ok(retained.nextCursor>65536,`test must exceed initial credit: ${retained.nextCursor} bytes; ${Buffer.from(retained.data,'base64').toString().slice(0,800)}`);
 await page.evaluate(async id=>{window.firstBytes=0;window.firstUnsub=await window.threadterm.subscribeOutput(id,0,c=>{window.firstBytes+=c.data.length})},large.id);
 await page.waitForFunction(end=>window.firstBytes>=end,retained.nextCursor);
 // Keep first subscriber alive; the actual xterm is a late second consumer.
 await page.evaluate(s=>window.showSession(s),large);
 await page.waitForFunction(()=>window.term?.buffer.active.getLine(window.term.buffer.active.baseY+window.term.rows-1)!==undefined&&!document.querySelector('.term-replaying'),null,{timeout:30000});
 await page.waitForFunction(()=>Array.from({length:window.term.buffer.active.length},(_,i)=>window.term.buffer.active.getLine(i)?.translateToString(true)).join('\n').includes('LINE-2400-'),null,{timeout:30000});
 assert.equal(await page.evaluate(()=>window.firstBytes),retained.nextCursor,'late replay must not rewind first subscriber');
 const replayed=await page.evaluate(()=>window.replayed.flat());
 assert.deepEqual(Buffer.from(replayed),Buffer.from(retained.data,'base64'),'late xterm must receive every retained byte exactly once');
 await page.evaluate(()=>window.firstUnsub());
 checks.push('late shared consumer receives >64KiB through real preload ACKs without duplicates');
 if(process.env.THREADTERM_QA_CODEX_LOADING==='1'){
   await page.evaluate(()=>window.showDialog());
   const create=page.getByRole('button',{name:'创建',exact:true});await create.waitFor();
   const started=Date.now();await create.click();
   await page.waitForFunction(()=>Boolean(window.created),null,{timeout:10000});
   const created=await page.evaluate(()=>window.created);
   assert.ok(['starting','running'].includes(created.status));assert.ok(Date.now()-started<10000,'creation must not wait for CLI preparation');
   await page.waitForFunction(()=>document.querySelector('.terminal-host'));
   const launch=await request('session.launch.read',{sessionId:created.id});assert.ok(['preparing','launching','running'].includes(launch.phase),JSON.stringify(launch));
   await until(async ()=>(await request('session.launch.read',{sessionId:created.id})).phase==='running','Codex launch',90000);
   const startupScreen=await until(async ()=>{
     const frame=await request('terminal.read',{sessionId:created.id,cursor:0,limit:65536});
     const text=Buffer.from(frame.data,'base64').toString('utf8');
     if(text.includes('Update available')&&text.includes('2. Skip'))return 'update';
     if(text.includes('Do you trust the contents of this directory?'))return 'trust';
     if(text.includes('Ask Codex to do anything'))return 'prompt';
     return undefined;
   },'Codex native startup screen',30000);
   await page.waitForFunction(()=>!document.querySelector('.term-loading-overlay'),null,{timeout:15000});
   // The visual gate and the independent control lease settle asynchronously;
   // wait for both instead of treating their short hand-off as a stuck input.
   await page.waitForFunction(()=>window.term&&!window.term.options.disableStdin&&!document.querySelector('.term-loading-overlay'),null,{timeout:10000});
   if(startupScreen==='trust')throw new Error('Codex requested directory trust in the isolated project; QA will not consent because persistence semantics are not established');
   if(startupScreen==='update'){
     const updateMenuEnd=(await request('terminal.read',{sessionId:created.id,tail:true,limit:1})).nextCursor;
     // The observed native menu offers 1 Update, 2 Skip, 3 Skip until next
     // version. Select only Skip; this never downloads, installs, or changes a
     // global Codex setting.
     await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
     await until(async ()=>{
       const frame=await request('terminal.read',{sessionId:created.id,cursor:updateMenuEnd,limit:65536});
       return Buffer.from(frame.data,'base64').toString('utf8').includes('Ask Codex to do anything');
     },'Codex input prompt after Skip',30000);
   }
   await page.screenshot({path:join(scratch,'codex-started.png')});
   await page.waitForFunction(()=>Array.from({length:window.term.buffer.active.length},(_,i)=>window.term.buffer.active.getLine(i)?.translateToString(true)??'').join('\\n').includes('Ask Codex to do anything'),null,{timeout:30000});
   const live=(await request('runtime.snapshot')).sessions.find(s=>s.id===created.id);assert.ok(live.nativeId);
   await request('session.stop',{sessionId:created.id,force:true,operationId:randomUUID()});
   await until(async ()=>(await request('runtime.snapshot')).sessions.find(s=>s.id===created.id)?.status==='exited','Codex stop');
   await page.waitForFunction(()=>!document.querySelector('.term-loading-overlay'),null,{timeout:10000});
   const stopped=(await request('runtime.snapshot')).sessions.find(s=>s.id===created.id);
   const stoppedOutputEnd=(await request('terminal.read',{sessionId:created.id,tail:true,limit:1})).nextCursor;
   assert.equal(stopped.id,created.id);assert.equal(stopped.nativeId,live.nativeId,'stopping must retain the original native Codex identity');
   await page.evaluate(()=>window.showSession(undefined));
   await page.waitForFunction(()=>!document.querySelector('.terminal-host'));
   await page.evaluate(s=>window.showSession(s),stopped);
   await page.waitForFunction(()=>document.querySelector('.terminal-host')&&!document.querySelector('.term-loading-overlay'),null,{timeout:15000});
   assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true,'an ended Codex history must remain read-only before the user explicitly resumes it');
   const claimsBefore=await app.evaluate((_electron,id)=>globalThis.__terminalLoadingCalls.filter(call=>call.method==='session.claim'&&call.params.sessionId===id).length,created.id);
   await page.getByRole('button',{name:/继续会话|Resume/}).click();
   const resumed=await until(async ()=>{
     const current=(await request('runtime.snapshot')).sessions.find(s=>s.id===created.id);
     return current?.status==='running'?current:undefined;
   },'same Codex session native resume',90000);
   assert.equal(resumed.id,created.id,'Resume must retain the ThreadTerm session ID');
   assert.equal(resumed.nativeId,live.nativeId,'Resume must retain the exact native Codex ID');
   await until(async ()=>{
     const boundary=await request('terminal.read',{sessionId:created.id,tail:true,limit:1});
     return boundary.nextCursor>stoppedOutputEnd;
   },'a new native Codex frame after resume',30000);
   await page.waitForFunction(()=>window.term&&!window.term.options.disableStdin&&!document.querySelector('.term-replaying')&&!document.querySelector('.term-loading-overlay'),null,{timeout:30000});
   await until(async ()=>await app.evaluate((_electron,{id,before})=>globalThis.__terminalLoadingCalls.filter(call=>call.method==='session.claim'&&call.params.sessionId===id).length>before,{id:created.id,before:claimsBefore}),'lease after Codex resume',30000);
   const inputBefore=await app.evaluate((_electron,id)=>globalThis.__terminalLoadingCalls.filter(call=>call.method==='terminal.input'&&call.params.sessionId===id).length,created.id);
   const marker='THREADTERM_RESUME_UNSENT_'+randomUUID().replaceAll('-','').slice(0,12);
   await page.locator('.xterm-helper-textarea').focus();
   assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),true,'the resumed xterm input target must own keyboard focus');
   await page.keyboard.type(marker);
   await until(async ()=>await app.evaluate((_electron,{id,before})=>globalThis.__terminalLoadingCalls.filter(call=>call.method==='terminal.input'&&call.params.sessionId===id).length>before,{id:created.id,before:inputBefore}),'unsubmitted terminal input after resume',10000);
   await page.screenshot({path:join(scratch,'codex-resumed-marker.png')});
   try{
     await page.waitForFunction(value=>Array.from({length:window.term.rows},(_,row)=>window.term.buffer.active.getLine(window.term.buffer.active.baseY+row)?.translateToString(true)??'').join('\\n').includes(value),marker,{timeout:10000});
   }catch(error){
     const visible=await page.evaluate(()=>Array.from({length:window.term.rows},(_,row)=>window.term.buffer.active.getLine(window.term.buffer.active.baseY+row)?.translateToString(true)??'').join('\\n'));
     await page.screenshot({path:join(scratch,'codex-resumed-marker-failed.png')});
     throw new Error(`${error.message}; visible xterm rows=${JSON.stringify(visible)}`);
   }
   await page.keyboard.press('Control+U');
   await page.screenshot({path:join(scratch,'codex-resumed-cleared.png')});
   await page.waitForFunction(value=>!Array.from({length:window.term.rows},(_,row)=>window.term.buffer.active.getLine(window.term.buffer.active.baseY+row)?.translateToString(true)??'').join('\\n').includes(value),marker,{timeout:10000});
   checks.push('stopped Codex resumes through the visible same-session action with stable native identity, a renewed lease and unsubmitted xterm input');
   checks.push('real Codex dialog returns durable starting session before native prepare; same session launches');
   checks.push('stopped quiet Codex reopens without a permanent loading mask');
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks,scratch}));
 await request('runtime.shutdown',{operationId:randomUUID()});
} finally {
 await app?.close();
 if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill();
}
