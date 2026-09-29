// Production workspace/navigation/xterm/CodeMirror, isolated Electron and mocked
// transport. No daemon, model request, filesystem mutation, or user profile.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const scratch=await mkdtemp(join(tmpdir(),'threadterm-tabs-'));
const out=resolve('qa/results/workspace-tabs');await mkdir(out,{recursive:true});
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';
const sessions=['a','b','c'].map((id,index)=>({id,title:'Session '+id,provider:'codex',mode:'terminal',status:'running',projectId:'project',worktreePath:'D:/fixture',createdAt:'now',updatedAt:'now',cols:110,rows:30}));
const tab=id=>({id:'tab-'+id,kind:'session',sessionId:id});
const initial={kind:'pane',id:'pane',tabs:['a','b','c'].map(tab),activeTabId:'tab-b'};
const files={'note.ts':'first\\nsecond\\nthird\\nfourth\\n','other.ts':'other'};
const drafts=new Map();window.qaCalls=[];window.qaSubscriptions={};window.qaSaved=initial;window.qaBack=0;
window.qaTerminals=[];const originalOpen=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.qaTerminals.push({terminal:this,element});return originalOpen.call(this,element);};
window.threadterm={platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},onEvent:()=>()=>{},openExternal:async()=>{},
 subscribeOutput:async(id,cursor,listener)=>{window.qaSubscriptions[id]=(window.qaSubscriptions[id]??0)+1;listener({sessionId:id,cursor:0,data:new TextEncoder().encode('Session '+id+' ready\\r\\nD:/fixture/note.ts:3:2\\r\\n')});return()=>{};},
 request:async(method,params)=>{window.qaCalls.push({method,params});
  if(method==='workspace.save'){window.qaSaved=params.layout;return{...params,id:'workspace',revision:(params.expectedRevision??0)+1};}
  if(method==='terminal.read')return{nextCursor:0,data:'',fromCursor:0};
  if(method==='session.launch.read')return{phase:'running'};
  if(method==='session.claim')return{leaseEpoch:1};
  if(['session.renew','session.release','terminal.resize','terminal.input'].includes(method))return{};
  if(method==='worktree.list')return[];
  if(method==='git.status')return{branch:'main',changes:[],ahead:0,behind:0};
  if(method==='filesystem.list')return Object.keys(files).map(path=>({path,name:path,kind:'file'}));
  if(method==='filesystem.read')return{path:params.path,content:files[params.path],readonly:false,fingerprint:'v1',size:40,modifiedAt:'now'};
  if(method==='draft.list')return[...drafts.values()];
  if(method==='draft.put'){const value={...params,id:params.path,revision:(params.expectedRevision??0)+1};drafts.set(params.path,value);return value;}
  if(method==='draft.delete'){drafts.delete(params.path);return{};}
  if(method==='filesystem.write'){files[params.path]=params.content;return{path:params.path,content:params.content,readonly:false,fingerprint:'v2',size:40,modifiedAt:'now'};}
  if(method==='filesystem.resolve')return{projectId:'project',worktreePath:'D:/fixture',path:'note.ts',kind:'text',line:params.line,column:params.column};
  throw Error('Unexpected QA request '+method);
 }};
function Fixture(){
 const [sessionId,setSessionId]=useState('b'),[epoch,setEpoch]=useState(0),[tick,setTick]=useState(0),[theme,setTheme]=useState('light');
 window.qaRefresh=()=>setTick(value=>value+1);window.qaNavigate=id=>{setSessionId(id);setEpoch(value=>value+1);};
 window.qaTheme=theme=>{document.documentElement.dataset.theme=theme;setTheme(theme);};
 const data={projects:[{id:'project',name:'Fixture',path:'D:/fixture'}],sessions:sessions.map(item=>({...item})),settings:{terminalCompatibility:{}},providers:[{id:'codex',terminalResumeCapture:'exit-hint'}],workspaces:[{id:'workspace',projectId:'project',worktreePath:'D:/fixture',layout:window.qaSaved,revision:0}]};
 return <I18nProvider locale="en"><SessionWorkspace session={data.sessions.find(item=>item.id===sessionId)} data={data} theme={theme} navigationKey={epoch} onActiveSession={setSessionId} onBack={()=>window.qaBack++} onSelect={window.qaNavigate} onProject={()=>{}} onChanged={window.qaRefresh} onBackgroundPresented={()=>{}}/></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root{display:flex;padding:0;background:var(--bg)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});window.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
let app;const report={passed:false,checks:[],screenshots:[]};
try{
 app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:15000});const page=await app.firstWindow({timeout:15000});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const tabs=()=>page.getByRole('tab');
 const ids=()=>tabs().evaluateAll(elements=>elements.map(el=>el.getAttribute('aria-label')));
 const menu=async name=>{await page.getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();await page.keyboard.press('Escape');};
 await page.waitForFunction(()=>window.qaNavigate&&document.querySelector('.xterm'));
 assert.equal(await page.locator('.workspace-tabbar').count(),1);assert.equal(await page.locator('.ws-tile-bar,.term-head,.v3-session-controls,.chat-provider-header').count(),0);
 assert.deepEqual(await ids(),['Session a','Session b','Session c']);assert.equal(await page.getByRole('tab',{name:'Session b'}).getAttribute('aria-selected'),'true');
 await page.getByRole('button',{name:'Close tab Session a',exact:true}).click();await page.waitForFunction(()=>window.qaSaved.tabs.length===2);
 const subscriptions=await page.evaluate(()=>window.qaSubscriptions.b);await page.evaluate(()=>window.qaRefresh());
 assert.deepEqual(await ids(),['Session b','Session c']);assert.equal(await page.evaluate(()=>window.qaSubscriptions.b),subscriptions,'background close and snapshot do not recreate active terminal');
 await page.getByRole('tab',{name:'Session c'}).click({button:'right'});await page.getByRole('menuitem',{name:'Close others',exact:true}).click();
 await page.waitForFunction(()=>window.qaSaved.tabs.length===1);assert.deepEqual(await ids(),['Session c']);assert.equal(await page.getByRole('tab',{name:'Session c'}).getAttribute('aria-selected'),'true');
 assert.equal(await page.evaluate(()=>window.qaCalls.some(call=>['session.stop','catalog.visibility.update','session.rerun'].includes(call.method))),false);
 report.checks.push('one upper bar; background X; no reopen on snapshot; context close others targets clicked tab; close never stops process');
 await page.evaluate(()=>window.qaNavigate('a'));await page.getByRole('tab',{name:'Session a'}).waitFor();
 await page.getByRole('button',{name:'Open session',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('[data-pane-id]').count(),1);assert.equal(await tabs().count(),2);
 report.checks.push('explicit navigation can reopen a closed tab; cancelling picker preserves existing pane');
 await page.evaluate(()=>{window.qaRetainedTerminal=window.qaTerminals.at(-1).terminal;window.qaRetainedElement=window.qaTerminals.at(-1).element;window.qaRetainedSubscriptions=window.qaSubscriptions.a;});
 await menu('Split right');assert.equal(await page.locator('[data-pane-id]').count(),2);
 assert.equal(await page.evaluate(()=>window.qaRetainedElement.isConnected&&window.qaTerminals.some(item=>item.terminal===window.qaRetainedTerminal&&item.element.isConnected)),true,'splitting must not unmount the source terminal');
 assert.equal(await page.evaluate(()=>window.qaSubscriptions.a),await page.evaluate(()=>window.qaRetainedSubscriptions),'splitting must not replay the source stream');
 await page.getByRole('button',{name:'Choose session',exact:true}).click();await page.getByRole('button',{name:'Session b Codex'}).click();
 await page.getByRole('tab',{name:'Session b',exact:true}).click();
 await menu('Fullscreen pane');assert.equal(await page.locator('.workspace-pane.fullscreen').count(),1);await page.keyboard.press('Escape');
 await menu('Close pane');assert.equal(await page.locator('[data-pane-id]').count(),1);
 assert.equal(await page.evaluate(()=>window.qaRetainedElement.isConnected),true,'closing a sibling must retain the original terminal host');
 report.checks.push('empty-pane focus, picker fill, fullscreen/escape and closing pane remain reachable');
 // Session-owned preview through the side bar Explorer ("Open beside session"), then collapse the side bar again.
 const filesView=page.locator('.wb-switcher').getByRole('button',{name:'Files',exact:true});
 await filesView.click();await page.locator('.wb-tree [data-path="note.ts"]').click({button:'right'});await page.getByRole('menuitem',{name:'Open beside session',exact:true}).click();
 await page.locator('.cm-content[contenteditable=true]').waitFor();await filesView.click();
 assert.equal(await page.evaluate(()=>window.qaRetainedElement.isConnected),true,'opening a file beside the session must retain the terminal host');
 assert.equal(await page.evaluate(()=>window.qaSubscriptions.a),await page.evaluate(()=>window.qaRetainedSubscriptions),'file navigation must not resubscribe or replay the session');
 assert.equal(await page.locator('.term-replaying').count(),0,'file navigation must not re-enter screen recovery');
 const editor=page.locator('.cm-content[contenteditable=true]');await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('dirty');
 assert.equal(await page.getByRole('tab',{name:'note.ts',exact:true}).count(),0,'linked preview is not an independent top tab');
 assert.equal(await page.getByRole('tab',{name:'Session a',exact:true}).getAttribute('aria-selected'),'true','focused companion keeps its owner selected');
 await page.getByRole('button',{name:'Close file preview',exact:true}).click();await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.ok((await editor.innerText()).includes('dirty'));
 assert.equal(await page.getByRole('button',{name:'Close file preview',exact:true}).count(),1);
 await page.getByRole('button',{name:'Close file preview',exact:true}).click();await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.file-workspace.embedded'));
 assert.equal(await page.locator('[data-pane-id]').count(),1,'last companion close collapses its empty column');
 assert.equal(await page.evaluate(()=>window.qaRetainedElement.isConnected),true);
 report.checks.push('linked file stays off top bar; owner remains selected; local close cancel keeps dirty input; discard collapses only preview and retains terminal');
 for(const theme of ['light','dark']){await page.evaluate(theme=>window.qaTheme(theme),theme);for(const width of [1280,760]){
  await page.setViewportSize({width,height:860});await page.evaluate(()=>document.documentElement.style.zoom='1.25');
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();
  const geometry=await page.getByRole('menu',{name:'Workspace actions'}).evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.right<=geometry.width+1&&geometry.bottom<=geometry.height+1,JSON.stringify(geometry));
  await page.screenshot({path:join(out,theme+'-'+width+'.png')});report.screenshots.push(theme+'-'+width+'.png');await page.keyboard.press('Escape');
 }}
 await tabs().first().click({button:'right'});await page.getByRole('menuitem',{name:'Close all',exact:true}).click();await page.waitForFunction(()=>window.qaBack===1);
 assert.equal(await tabs().count(),0);assert.equal(await page.evaluate(()=>window.qaCalls.some(call=>call.method==='session.stop')),false);assert.deepEqual(errors,[]);
 report.checks.push('light/dark and 125% zoom at wide/narrow sizes; menu viewport containment; close all persists before returning');report.passed=true;
}catch(error){report.error=String(error);console.error(error);process.exitCode=1;if(app){console.error(await app.windows()[0]?.evaluate(()=>({menus:[...document.querySelectorAll('[role=menu]')].map(el=>el.outerHTML),panes:[...document.querySelectorAll('[data-pane-id]')].map(el=>({class:el.className,id:el.dataset.paneId})),expanded:document.querySelector('[aria-label="Workspace actions"]')?.outerHTML})));await app.windows()[0]?.screenshot({path:join(out,'failure.png')}).catch(()=>{});}}
finally{if(app)await app.close();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
