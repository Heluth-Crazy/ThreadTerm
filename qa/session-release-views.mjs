// Session release: the production ChatView/TerminalSurface mounted in Electron
// with a recording `window.threadterm` mock. No Rust, provider, or account: the
// runtime is a canned responder, so every request the views make is observed.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {freemem,tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const root=resolve(import.meta.dirname,'..'),out=join(root,'qa/results/session-release-views');
const scratch=await mkdtemp(join(tmpdir(),'tt-session-release-views-'));
const report={passed:false,scope:'Production ChatView and TerminalSurface mounted in Electron with a recording window.threadterm mock; no Rust, provider, account, or user data.',checks:[],errors:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
let app,release;
try {
  await mkdir(out,{recursive:true});
  const renderer=`import React,{useEffect,useState}from 'react';import{createRoot}from'react-dom/client';import{ChatView}from'./renderer/src/components/ChatView';import{TerminalSurface}from'./renderer/src/components/TerminalSurface';import{RunningAgentsView}from'./renderer/src/components/RunningAgents';import{I18nProvider}from'./renderer/src/i18n';import'./renderer/src/styles.css';
const view=new URLSearchParams(location.search).get('view')??'chat';
const chat={id:'qa-chat',projectId:'qa-project',title:'Released chat',provider:'codex',mode:'chat',status:'exited',createdAt:'2026-11-09T00:00:00Z',updatedAt:'2026-11-09T00:00:00Z',released:true,nativeId:'native-qa-chat'};
const terminal={id:'qa-term',projectId:'qa-project',title:'Released terminal',provider:'codex',mode:'terminal',status:'exited',createdAt:'2026-11-09T00:00:00Z',updatedAt:'2026-11-09T00:00:00Z',released:true,nativeId:'native-qa-term',cols:80,rows:24};
function Harness(){
  const [session,setSession]=useState(view==='chat'?chat:terminal);
  useEffect(()=>{const onSession=event=>setSession(current=>({...current,...event.detail}));addEventListener('qa-session',onSession);return()=>removeEventListener('qa-session',onSession)},[]);
  return view==='chat'?<ChatView session={session}/>:<TerminalSurface sessionId={session.id} provider={session.provider} session={session} theme='dark'/>;
}
const project={id:'qa-project',name:'ThreadTerm',path:'D:/project/ThreadTerm',createdAt:'2026-11-09T00:00:00Z'};
const agents=[
  {id:'a',title:'Fix the login redirect race',provider:'codex',mode:'chat',status:'idle',createdAt:'',updatedAt:'',projectId:'qa-project',worktreePath:'D:/project/ThreadTerm/tt-login'},
  {id:'b',title:'Review the session release diff',provider:'claude',mode:'chat',status:'running',createdAt:'',updatedAt:'',projectId:'qa-project',worktreePath:'D:/project/ThreadTerm/tt-session-release'},
  {id:'c',title:'Approve the deployment plan',provider:'opencode',mode:'chat',status:'waiting',createdAt:'',updatedAt:'',projectId:'qa-project',worktreePath:'D:/project/ThreadTerm/tt-docs'},
  {id:'d',title:'Run the migration checks',provider:'grok',mode:'chat',status:'idle',createdAt:'',updatedAt:'',projectId:'qa-project',worktreePath:'D:/project/ThreadTerm/tt-session-release'},
  {id:'e',title:'Build the release package',provider:'codex',mode:'terminal',status:'idle',createdAt:'',updatedAt:'',projectId:'qa-project',worktreePath:'D:/project/ThreadTerm/tt-release'},
];
const processes={sessions:[
  {sessionId:'a',processCount:24,memoryBytes:588000000,idleSeconds:14*60,visible:false,idle:true},
  {sessionId:'b',processCount:31,memoryBytes:812000000,idleSeconds:4,visible:false,idle:false,blocked:'the session is working or waiting for your answer'},
  {sessionId:'c',processCount:8,memoryBytes:146000000,idleSeconds:52*60,visible:false,idle:false,blocked:'the session is working or waiting for your answer'},
  {sessionId:'d',processCount:12,memoryBytes:241000000,idleSeconds:40,visible:false,idle:false,blocked:'a background task is running'},
  {sessionId:'e',processCount:6,memoryBytes:96000000,idleSeconds:22*60,visible:false,idle:true},
],memoryBytes:1883000000,idleReleaseMinutes:30};
function RunningAgentsQa(){return <div style={{width:900,padding:24,background:'var(--bg)',color:'var(--text)'}}><RunningAgentsView processes={processes} sessions={agents} projects={[project]} zh={false} idleMinutes={30} onStopIdle={()=>{}} onStop={()=>{}} onOpen={()=>{}} onIdleMinutes={()=>{}}/></div>;}
function App(){return view==='running-agents'?<RunningAgentsQa/>:<Harness/>;}
createRoot(document.getElementById('root')).render(<I18nProvider locale='en'><App/></I18nProvider>);`;
  await build({stdin:{contents:renderer,resolveDir:root,loader:'tsx'},bundle:true,jsx:'automatic',outfile:join(scratch,'ui.js'),loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'});
  await writeFile(join(scratch,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script>window.__qaErrors=[];addEventListener("error",event=>window.__qaErrors.push(String(event.message||event.error)));addEventListener("unhandledrejection",event=>window.__qaErrors.push("rejection "+String(event.reason)));</script><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex:1}</style><div id="root"></div><script src="ui.js"></script>');
  const preload=`const{contextBridge}=require('electron');
const calls=[],listeners=new Set();let phase='disconnected',generation=0,revision=0,nativeId='native-qa-chat',directory=null;const failures=new Map();
const connection=()=>({sessionId:'qa-chat',runtimeEpoch:'qa',connectionGeneration:generation,revision:++revision,phase,nativeId,optionsLoadState:'ready'});
const respond=(method,params)=>{switch(method){
 case 'chat.connection':return connection();
 case 'chat.connect':phase='ready';generation++;nativeId='native-qa-chat';return connection();
 case 'session.claim':return{leaseEpoch:1};
 case 'session.renew':return{leaseEpoch:1};
 case 'session.release':return null;
 case 'session.resume':return{id:params.sessionId,status:'running',released:false};
 case 'chat.snapshot':return{items:[],revision:0,hasEarlier:false};
 case 'chat.draft.read':return{text:'',revision:0};
 case 'chat.queue.read':return{sessionId:params.sessionId,items:[],revision:0};
 case 'chat.options':return{options:[],commands:[],loadState:'ready'};
 case 'chat.send':return{turnId:'qa-turn',sessionId:params.sessionId,itemId:'qa-item'};
 case 'chat.cancel':return{};
 case 'chat.repair':return{phase:'complete'};
 case 'session.update':case 'session.stop':return{id:params.sessionId};
 case 'terminal.read':return{cursor:0,nextCursor:0,data:'',eof:true,tail:true,limit:1};
 case 'terminal.input':case 'terminal.resize':return null;
 default:return{};}};
contextBridge.exposeInMainWorld('threadterm',{platform:'win32',request:async(method,params)=>{calls.push({method,params:JSON.parse(JSON.stringify(params??{}))});const failure=failures.get(method);if(failure)return Promise.reject(failure);return respond(method,params??{})},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},subscribeOutput:async()=>()=>{},onDesktopNavigate:()=>()=>{},windowState:async()=>({maximized:false}),onWindowState:()=>()=>{},chooseDirectory:async()=>directory,attachFiles:async()=>[],openExternalFiles:async()=>[],chooseSavePath:async()=>null,exportFile:async()=>null,activateDataRelocation:async()=>({activated:false}),windowAction:async()=>{},openWindow:async()=>{},openExternal:async()=>{},openPluginsFolder:async()=>{},pickPageTarget:async()=>null,cancelPagePick:async()=>{},markPageTarget:async()=>false,readPageShot:async()=>undefined,deletePageShots:async()=>{},onPageContextMenu:()=>()=>{},openDirectory:async()=>{},desktopPreferences:async()=>({shortcuts:{}}),testNotification:async()=>({sent:false}),exportDiagnostics:async()=>null,scheduleElectronCacheCleanup:async()=>({scheduled:false,available:false})});
contextBridge.exposeInMainWorld('qa',{calls:()=>JSON.parse(JSON.stringify(calls)),clear:()=>{calls.length=0},fail:(method,code,message)=>{if(code)failures.set(method,{code,message});else failures.delete(method)},chooseFolder:value=>{directory=value},emit:event=>{for(const listener of [...listeners])listener(JSON.parse(JSON.stringify(event)))}});`;
  await writeFile(join(scratch,'preload.cjs'),preload);
  const main=`import{app,BrowserWindow}from'electron';
app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});
app.whenReady().then(()=>{const view=(process.argv.find(argument=>argument.startsWith('--qa-view='))??'--qa-view=chat').split('=')[1];new BrowserWindow({show:true,width:1200,height:820,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,preload:${JSON.stringify(join(scratch,'preload.cjs'))}}}).loadFile(${JSON.stringify(join(scratch,'index.html'))},{query:{view}});});`;
  await build({stdin:{contents:main,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(scratch,'main.cjs'),logLevel:'error'});
  assert.ok(freemem()>=8*1024**3,'Need 8GB free for Electron');
  release=await acquireElectronQaLock({timeoutMs:1000});
  const launch=async view=>{
    await app?.close();app=await electron.launch({args:[join(scratch,'main.cjs'),`--qa-view=${view}`],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE'))});
    const page=await app.firstWindow();page.setDefaultTimeout(15_000);page.on('pageerror',error=>report.errors.push(String(error.stack??error.message)));page.on('console',message=>{if(message.type()==='error')report.errors.push('console: '+message.text())});
    await page.waitForFunction(()=>Boolean(window.threadterm)&&Boolean(window.qa));
    return page;
  };
  // `--qa-view` reaches the file URL through argv only; the entry reads the query.
  const chatPage=await launch('chat');
  const calls=async (page,method)=>page.evaluate(name=>window.qa.calls().filter(entry=>entry.method===name),method);
  await chatPage.waitForSelector('.chat-stopped');
  check('a released chat mounts the compact Stopped row');

  // 1. An automatic reconnect (phase disconnected) must not connect.
  await chatPage.evaluate(()=>{window.qa.emit({event:'chat.connection',data:{sessionId:'qa-chat',runtimeEpoch:'qa',connectionGeneration:1,revision:1,phase:'disconnected',optionsLoadState:'ready'}})});
  await chatPage.waitForTimeout(500);
  assert.equal((await calls(chatPage,'chat.connect')).length,0,'a disconnected phase on a released chat sends no chat.connect');
  check('a disconnected event on a released chat sends no chat.connect');

  // 2. Continue sends exactly one connect, with the explicit resume flag.
  await chatPage.getByRole('button',{name:'Continue',exact:true}).click();
  await chatPage.waitForFunction(()=>window.qa.calls().filter(entry=>entry.method==='chat.connect').length>0);
  await chatPage.waitForTimeout(300);
  const continueConnects=await calls(chatPage,'chat.connect');
  assert.equal(continueConnects.length,1,`Continue sends one chat.connect: ${JSON.stringify(continueConnects)}`);
  assert.equal(continueConnects[0].params.resume,true,'Continue carries resume:true');
  check('Continue sends exactly one chat.connect with resume:true');
  const connectEpoch=continueConnects[0].params.leaseEpoch;

  // 3. After Continue a Stop (released snapshot + disconnected phase) must not reconnect.
  await chatPage.evaluate(()=>{dispatchEvent(new CustomEvent('qa-session',{detail:{released:false}}))});
  await chatPage.waitForTimeout(200);
  await chatPage.evaluate(()=>{dispatchEvent(new CustomEvent('qa-session',{detail:{released:true}}));window.qa.emit({event:'chat.connection',data:{sessionId:'qa-chat',runtimeEpoch:'qa',connectionGeneration:2,revision:5,phase:'disconnected',optionsLoadState:'ready'}})});
  await chatPage.waitForTimeout(600);
  assert.equal((await calls(chatPage,'chat.connect')).length,1,`a second Stop does not reconnect: ${JSON.stringify(await calls(chatPage,'chat.connect'))}`);
  check('after Continue, a second Stop does not reconnect');
  assert.ok(connectEpoch>=1);

  // 4. Sending to a stopped chat reconnects once, then sends once.
  await chatPage.reload();
  await chatPage.waitForSelector('.chat-stopped');
  await chatPage.evaluate(()=>{window.qa.clear();window.qa.emit({event:'chat.connection',data:{sessionId:'qa-chat',runtimeEpoch:'qa',connectionGeneration:1,revision:1,phase:'disconnected',optionsLoadState:'ready'}})});
  const composer=chatPage.locator('#chat-message-qa-chat');
  await composer.waitFor();
  await composer.fill('hello after stop');
  await composer.press('Enter');
  await chatPage.waitForFunction(()=>window.qa.calls().some(entry=>entry.method==='chat.send'),null,{timeout:15_000});
  await chatPage.waitForTimeout(400);
  const sendConnects=await calls(chatPage,'chat.connect');
  const sends=await calls(chatPage,'chat.send');
  assert.equal(sendConnects.length,1,`send reconnects once: ${JSON.stringify(sendConnects)}`);
  assert.equal(sendConnects[0].params.resume,true,'the send reconnect carries resume:true');
  assert.equal(sends.length,1,`send sends once: ${JSON.stringify(sends)}`);
  assert.equal(sends[0].params.text,'hello after stop','the typed message is sent');
  assert.equal(await composer.inputValue(),'','the sent message leaves the composer');
  check('sending to a stopped chat connects once with resume:true and sends once');

  // 5. The released terminal offers the same row and resumes only on the click.
  const termPage=await launch('terminal');
  await termPage.waitForSelector('.chat-stopped');
  await termPage.waitForTimeout(400);
  assert.equal((await calls(termPage,'session.resume')).length,0,'a released terminal sends no session.resume on mount');
  check('a released terminal mounts without session.resume');
  await termPage.getByRole('button',{name:'Continue',exact:true}).click();
  await termPage.waitForFunction(()=>window.qa.calls().some(entry=>entry.method==='session.resume'));
  await termPage.waitForTimeout(200);
  const resumes=await calls(termPage,'session.resume');
  assert.equal(resumes.length,1,`Continue resumes once: ${JSON.stringify(resumes)}`);
  assert.equal(resumes[0].params.resume,true,'the terminal Continue carries resume:true');
  check('terminal Continue sends exactly one session.resume with resume:true');

  // 6. An explicit Continue whose resume fails must not stay pending: the
  //    failure names the reason, Continue stays usable, and a retry works.
  //    (A released delegated child whose worktree was deleted after merge.)
  const retryPage=await launch('chat');
  await retryPage.waitForSelector('.chat-stopped');
  await retryPage.evaluate(()=>{window.qa.clear();window.qa.fail('chat.connect','cwd_missing_choose_relocation','cwd_missing_choose_relocation: choose a folder')});
  await retryPage.getByRole('button',{name:'Continue',exact:true}).click();
  await retryPage.waitForSelector('[data-stopped-issue]');
  const issue=await retryPage.locator('[data-stopped-issue]').innerText();
  assert.match(issue,/folder is gone/i,`the stopped row explains the refusal: ${issue}`);
  const continueButton=retryPage.getByRole('button',{name:'Continue',exact:true});
  assert.equal(await continueButton.isDisabled(),false,'Continue is enabled again after a failed resume');
  assert.equal((await calls(retryPage,'chat.connect')).length,1,`one explicit attempt: ${JSON.stringify(await calls(retryPage,'chat.connect'))}`);
  check('a failed explicit resume keeps Continue enabled and shows the reason');

  await retryPage.evaluate(()=>window.qa.fail('chat.connect',null));
  await continueButton.click();
  await retryPage.waitForFunction(()=>window.qa.calls().filter(entry=>entry.method==='chat.connect').length===2);
  const retried=await calls(retryPage,'chat.connect');
  assert.equal(retried[1].params.resume,true,'the retry is still an explicit resume');
  await retryPage.waitForTimeout(200);
  assert.equal(await retryPage.locator('[data-stopped-issue]').count(),0,'the failure message is cleared by the retry');
  check('Continue retries the resume after a failure');

  // 7. A missing folder offers the relocation the runtime asks for, and it is
  //    an explicit resume too.
  await retryPage.reload();
  await retryPage.waitForSelector('.chat-stopped');
  await retryPage.evaluate(()=>{window.qa.clear();window.qa.chooseFolder('D:/qa/relocated');window.qa.fail('chat.connect','cwd_missing_choose_relocation','cwd_missing_choose_relocation: choose a folder')});
  await retryPage.getByRole('button',{name:'Continue',exact:true}).click();
  await retryPage.waitForSelector('.chat-stopped-relocate');
  await retryPage.getByRole('button',{name:'Choose folder',exact:true}).click();
  await retryPage.waitForFunction(()=>window.qa.calls().some(entry=>entry.method==='session.resume'));
  const relocated=await calls(retryPage,'session.resume');
  assert.equal(relocated.length,1,`relocation resumes once: ${JSON.stringify(relocated)}`);
  assert.equal(relocated[0].params.resume,true,'relocation carries resume:true');
  assert.equal(relocated[0].params.cwd,'D:/qa/relocated','the chosen folder is sent');
  check('a missing folder offers Choose folder, which resumes explicitly');

  // 8. The Running agents diagnostics: realistic rows, the setting, and one
  //    screenshot the owner can judge.
  const agentsPage=await launch('running-agents');
  await agentsPage.waitForSelector('.running-agents-row');
  assert.equal(await agentsPage.locator('.running-agents-row').count(),5,'five realistic agent rows');
  const agentsText=await agentsPage.locator('.running-agents').innerText();
  assert.match(agentsText,/5 running · 1\.8 GB/);
  assert.match(agentsText,/Idle 14 min/);
  assert.match(agentsText,/Waiting for you/);
  assert.match(agentsText,/Stop idle \(2 · 652\.3 MB\)/);
  assert.match(agentsText,/Release idle sessions after/);
  const shot=join('D:/project/ThreadTerm/tt-qa-temp/session-release-idle','running-agents.png');
  await mkdir(dirname(shot),{recursive:true});
  await agentsPage.screenshot({path:shot,fullPage:true});
  check('the Running agents section shows its rows, memory, setting and Stop idle action');

  assert.deepEqual(report.errors,[]);report.passed=true;
} catch (error) { report.failure=String(error.stack??error); try{const current=await app?.firstWindow();report.html=(await current.content()).slice(0,3000);report.pageErrors=await current.evaluate(()=>window.__qaErrors);report.calls=await current.evaluate(()=>window.qa.calls())}catch{} process.exitCode=1; }
finally { await app?.close(); await release?.(); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)); if(report.failure)console.error(report.failure); console.log(`Report: ${join(out,'report.json')}`); }
