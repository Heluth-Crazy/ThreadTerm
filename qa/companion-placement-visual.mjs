// Full four-pane companion placement through the production SessionWorkspace.
// Isolated Electron profile and mocked transport: no daemon or model calls.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const scratch=await mkdtemp(join(tmpdir(),'threadterm-companion-placement-'));
const out=resolve('qa/results/companion-placement-visual');
await mkdir(out,{recursive:true});
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const sessions=['b','c','a','d'].map(id=>({id,title:'Session '+id.toUpperCase(),provider:'codex',mode:'terminal',status:'running',projectId:'project',worktreePath:'D:/fixture',createdAt:'now',updatedAt:'now',cols:100,rows:30}));
const session=id=>({id:'session-'+id,kind:'session',sessionId:id});
const pane=(id,tabs,activeTabId)=>({kind:'pane',id,tabs,activeTabId});
const split=(id,first,second)=>({kind:'split',id,direction:'horizontal',ratio:0.5,first,second});
const initial=split('outer',
 split('left',pane('pane-b',[session('b'),{id:'b-mixed-file',kind:'preview',projectId:'project',worktreePath:'D:/fixture',path:'b.md',ownerSessionId:'b'}],'session-b'),pane('pane-c',[session('c')],'session-c')),
 split('right',pane('pane-a',[session('a')],'session-a'),pane('pane-d',[session('d')],'session-d')));
const files={'a.ts':'export const owner = "A";\\n','b.md':'# B preview\\n'};
let revision=0;
window.qa={calls:[],subscriptions:{},terminals:{},saved:initial};
const originalOpen=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.qa.terminals[element.closest('[data-pane-id]')?.getAttribute('data-pane-id')??'unknown']={terminal:this,element};return originalOpen.call(this,element);};
window.threadterm={platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},onEvent:()=>()=>{},openExternal:async()=>{},
 subscribeOutput:async(id,cursor,listener)=>{window.qa.subscriptions[id]=(window.qa.subscriptions[id]??0)+1;listener({sessionId:id,cursor:0,data:new TextEncoder().encode('Session '+id+' ready\\r\\n')});return()=>{};},
 request:async(method,params)=>{window.qa.calls.push({method,params});
  if(method==='workspace.save'){if(params.expectedRevision!==revision)throw Error('workspace.save revision was not serialized');revision++;window.qa.saved=params.layout;return{id:'workspace',revision};}
  if(method==='terminal.read')return{nextCursor:0,data:'',fromCursor:0};
  if(method==='session.claim')return{leaseEpoch:1};
  if(['session.renew','session.release','terminal.resize','terminal.input'].includes(method))return{};
  if(method==='session.launch.read')return{phase:'running'};
  if(method==='worktree.list')return[];
  if(method==='git.status')return{branch:'main',changes:[],ahead:0,behind:0};
  if(method==='filesystem.list')return Object.keys(files).map(path=>({path,name:path,kind:'file'}));
  if(method==='filesystem.read'){const content=files[params.path];if(content===undefined)throw Error('missing fixture file '+params.path);return{path:params.path,content,readonly:false,fingerprint:'disk-'+params.path,size:content.length,modifiedAt:'now'};}
  if(method==='draft.list')return[];
  throw Error('Unexpected QA request '+method);
 }};
const data={projects:[{id:'project',name:'Fixture',path:'D:/fixture'}],sessions,settings:{terminalCompatibility:{}},providers:[{id:'codex',terminalResumeCapture:'exit-hint'}],workspaces:[{id:'workspace',projectId:'project',worktreePath:'D:/fixture',layout:initial,revision}]};
createRoot(document.getElementById('root')).render(<I18nProvider locale="en"><SessionWorkspace session={sessions.find(item=>item.id==='a')} data={data} theme="light" initialLayout={initial} onBack={()=>{}} onSelect={()=>{}} onProject={()=>{}} onChanged={()=>{}} onBackgroundPresented={()=>{}}/></I18nProvider>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="root"></div><script>window.__qaBootstrapErrors=[];addEventListener("error",event=>window.__qaBootstrapErrors.push(event.message));</script><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);

let app;let page;const report={passed:false,checks:[],screenshots:[]};
try{
 app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:15_000});page=await app.firstWindow({timeout:15_000});page.setDefaultTimeout(12_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.qa&&Object.keys(window.qa.terminals).length===4&&window.qa.subscriptions.a===1);
 assert.equal(await page.locator('[data-pane-id]').count(),4,'fixture must stay at the four-pane cap');
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).getAttribute('aria-selected'),'true');
 const initialState=await page.evaluate(()=>({b:Boolean(window.qa.terminals['pane-b']?.element.isConnected),a:Boolean(window.qa.terminals['pane-a']?.element.isConnected)}));
 assert.ok(initialState.a&&initialState.b,'both source and other session xterm surfaces must mount');
 // Production path for a session-owned companion: side bar Files → context menu → Open beside session.
 await page.locator('.wb-switcher').getByRole('button',{name:'Files',exact:true}).click();
 await page.locator('.wb-tree [data-path="a.ts"]').click({button:'right'});
 await page.getByRole('menuitem',{name:'Open beside session',exact:true}).click();
 await page.locator('[data-pane-id="pane-a"] .cm-content[contenteditable=true]').waitFor();
 const state=await page.evaluate(()=>{
  const visit=node=>node.kind==='pane'?[node]:visit(node.first).concat(visit(node.second));
  const panes=visit(window.qa.saved);const byId=Object.fromEntries(panes.map(pane=>[pane.id,pane]));
  return {panes:panes.length,a:byId['pane-a'],b:byId['pane-b'],subscriptions:window.qa.subscriptions,
   aTerminalConnected:window.qa.terminals['pane-a']?.element.isConnected,bTerminalConnected:window.qa.terminals['pane-b']?.element.isConnected,
   stopped:window.qa.calls.some(call=>call.method==='session.stop'||call.method==='session.rerun')};
 });
 assert.equal(state.panes,4,'opening a companion at cap must not create a fifth pane');
 assert.equal(state.a.tabs.length,2,'A file must enter its own source pane, not the first pane');
 assert.equal(state.a.tabs[0].id,'session-a');
 assert.equal(state.a.activeTabId,state.a.tabs[1].id,'A file must become active only in A pane');
 assert.equal(state.a.tabs[1].ownerSessionId,'a');
 assert.equal(state.a.tabs[1].path,'a.ts');
 assert.deepEqual(state.b.tabs.map(tab=>tab.id),['session-b','b-mixed-file'],'B mixed preview must not be reused for A');
 assert.equal(state.b.activeTabId,'session-b','B session must not be covered by A file');
 assert.equal(state.aTerminalConnected,true,'A terminal remains mounted behind its file');
 assert.equal(state.bTerminalConnected,true,'B terminal remains mounted');
 assert.equal(state.subscriptions.a,1);assert.equal(state.subscriptions.b,1);
 assert.equal(state.stopped,false,'file navigation must not change a native session');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:join(out,'full-four-pane-a-file.png')});report.screenshots.push('full-four-pane-a-file.png');
 report.checks.push('At four-pane cap, Explorer "Open beside session" opens the file in non-first owner A pane; B mixed preview and session remain intact; terminal nodes and subscriptions survive');
 report.passed=true;
}finally{
 if(app)await app.close();
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({scratch,out,...report},null,2));
