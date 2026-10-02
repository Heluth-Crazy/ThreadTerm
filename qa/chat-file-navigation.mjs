// Production ChatView -> SessionWorkspace -> filesystem.resolve navigation in an
// isolated Electron renderer. No daemon, provider, model call, or user profile.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch=await mkdtemp(join(tmpdir(),'threadterm-chat-files-'));
let liveSamples={};
try{
 const live=JSON.parse(await readFile(resolve('qa/results/agent-file-navigation-live.json'),'utf8'));
 liveSamples=Object.fromEntries((live.providers??[]).filter(item=>item?.passed&&['kimi','grok'].includes(item.provider)&&typeof item.assistantSample==='string').map(item=>[item.provider,item.assistantSample]));
}catch{}
const markdown=[
  '[absolute](D:\\project\\ThreadTerm\\AGENTS.md#L12)',
  '[relative](./src/main.ts#L7C3)',
  '`README.md:4`',
  '[missing](./missing.ts)',
  '[website](https://example.test/AGENTS.md)',
  '<img id="evil-img" src="x" onerror="window.qaPwned=1">',
  '<a id="js-link" href="javascript:window.qaPwned=2">javascript</a>',
  '<a id="forged-reference" data-threadterm-file-reference=\'{"path":"D:\\\\forged.ts"}\'>forged</a>',
].join(' · ');
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';
const provider=new URLSearchParams(location.search).get('provider')??'codex';
const session={id:'chat-'+provider,title:'Chat '+provider,provider,mode:'chat',status:'idle',readOnly:false,projectId:'project',worktreePath:'D:/fixture',createdAt:'now',updatedAt:'now'};
// ?mixed: an earlier narrow open left a Chat-owned file tab inside the Chat pane.
const mixed=new URLSearchParams(location.search).has('mixed');
const initial={kind:'pane',id:'chat-pane',tabs:[{id:'session-chat',kind:'session',sessionId:session.id},...(mixed?[{id:'old-file',kind:'file',projectId:'project',worktreePath:'D:/fixture',path:'README.md',ownerSessionId:session.id}]:[])],activeTabId:'session-chat'};
const files={'AGENTS.md':'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight\\nnine\\nten\\neleven\\ntwelve\\n','src/main.ts':'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\n','README.md':'one\\ntwo\\nthree\\nfour\\n','sample.md':'# Sample\\n\\nLive provider fixture.\\n','tool.ts':'one\\ntwo\\nthree\\nfour\\nfive\\n','updated.md':'# Updated\\n'};
const chatOptions={options:[],commands:[],loadState:'ready'};
const liveSamples=${JSON.stringify(liveSamples)};
const answerText=${JSON.stringify(markdown)}+(liveSamples[provider]?'\\n\\n'+liveSamples[provider]: '');
const toolPart={type:'tool',toolName:'Read',status:'failed',text:'Read failed',fileReferences:[{path:'D:\\\\project\\\\ThreadTerm\\\\tool.ts',line:5,column:2}]};
const listeners=new Set();let pointerTarget;
window.qaCalls=[];window.qaSaved=initial;window.qaEvents=0;window.qaPwned=0;window.qaPointerEvents=[];
for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])addEventListener(type,event=>{const target=event.target instanceof Element?event.target.closest('button[data-file-reference]'):null;if(!target)return;if(type==='pointerdown')pointerTarget=target;window.qaPointerEvents.push({type,text:target.textContent,reference:target.getAttribute('data-file-reference'),sameNode:target===pointerTarget});},true);
window.threadterm={platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},openExternal:async()=>{},subscribeOutput:async()=>()=>{},onEvent:listener=>{window.qaEvents++;listeners.add(listener);return()=>listeners.delete(listener);},
 request:async(method,params)=>{window.qaCalls.push({method,params});
  if(method==='chat.snapshot')return{revision:1,items:[{id:'answer',role:'assistant',createdAt:'now',parts:[{type:'text',text:answerText},toolPart]}]};
  if(method==='chat.draft.read')return{text:'draft stays',revision:0};
  if(method==='chat.options')return chatOptions;
  if(method==='chat.connection'||method==='chat.connect')return{sessionId:params.sessionId,runtimeEpoch:'qa',connectionGeneration:1,revision:1,phase:'ready',optionsLoadState:'ready'};
  if(method==='session.claim'||method==='session.renew')return{leaseEpoch:1};
  if(method==='session.release')return null;
  if(method==='workspace.save'){window.qaSaved=params.layout;return{...params,id:'workspace',revision:(params.expectedRevision??0)+1};}
  if(method==='worktree.list')return[];
  if(method==='filesystem.list')return Object.keys(files).map(path=>({path,name:path.split('/').at(-1),kind:'file'}));
  if(method==='git.status')return{branch:'main',changes:[],ahead:0,behind:0};
  if(method==='draft.list')return[];
  if(method==='filesystem.resolve'){
   if(params.path==='./missing.ts')throw Error('file_reference_not_found');
   const path=params.path.includes('AGENTS.md')?'AGENTS.md':params.path.includes('main.ts')?'src/main.ts':params.path.includes('README.md')?'README.md':params.path.includes('sample.md')?'sample.md':params.path.includes('updated.md')?'updated.md':'tool.ts';
   return{projectId:'project',worktreePath:'D:/fixture',path,kind:'text',line:params.line,column:params.column};
  }
  if(method==='filesystem.read')return{path:params.path,content:files[params.path],readonly:false,fingerprint:'v1',size:files[params.path].length,modifiedAt:'now'};
 throw Error('Unexpected QA request '+method);
 }};
window.qaEmitUpdated=()=>listeners.forEach(listener=>listener({event:'chat.item',seq:2,epoch:'qa',data:{sessionId:session.id,item:{id:'answer',role:'assistant',createdAt:'now',parts:[{type:'text',text:answerText+'\\n\\n[updated](updated.md)'},toolPart]}}}));
const other={...session,id:session.id+'-other',title:'Other '+provider};
const data={projects:[{id:'project',name:'Fixture',path:'D:/fixture'}],sessions:[session,other],settings:{terminalCompatibility:{}},providers:[{id:provider}],workspaces:[{id:'workspace',projectId:'project',worktreePath:'D:/fixture',layout:initial,revision:0}]};
function Fixture(){const [id,setId]=useState(session.id),[epoch,setEpoch]=useState(0);window.qaNavigate=id=>{setId(id);setEpoch(value=>value+1);};return <I18nProvider locale="en"><SessionWorkspace session={data.sessions.find(item=>item.id===id)} data={data} theme="light" initialLayout={initial} navigationKey={epoch} onActiveSession={setId} onBack={()=>{}} onSelect={window.qaNavigate} onProject={()=>{}} onChanged={()=>{}} onBackgroundPresented={()=>{}}/></I18nProvider>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{width:100%;height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1400,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);

let app,page;
try{
 app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:15_000});
 page=await app.firstWindow({timeout:15_000});page.setDefaultTimeout(10_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const provider of ['codex','claude','kimi','grok']){
  await page.goto(pathToFileURL(join(scratch,'index.html')).href+'?provider='+provider);
  const composer=page.locator('.chat-compose textarea:visible');
  await composer.waitFor();assert.equal(await composer.inputValue(),'draft stays');
  assert.equal(await page.getByRole('tab').count(),1);
  assert.ok(await page.locator('.ws-content > .ws-pane').evaluate(element=>element.clientWidth)>=692,'pane area must be wide enough to split (two 340 px panes)');
  const before=await page.evaluate(()=>{const node=document.querySelector('[data-testid^="session-chat-"]');window.qaChatNode=node;return{snapshots:window.qaCalls.filter(call=>call.method==='chat.snapshot').length,events:window.qaEvents};});

  await page.getByRole('button',{name:'absolute',exact:true}).click();
  await page.getByRole('button',{name:'Close file preview',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab').count(),1,'a chat-owned file preview must not enter the global tab bar');
  const absolute=await page.evaluate(()=>window.qaCalls.find(call=>call.method==='filesystem.resolve'));
  assert.deepEqual(absolute.params,{sessionId:'chat-'+provider,path:'D:\\project\\ThreadTerm\\AGENTS.md',line:12});
  assert.equal(await composer.inputValue(),'draft stays');
  assert.equal(await page.evaluate(()=>window.qaChatNode?.isConnected),true);
  assert.deepEqual(await page.evaluate(()=>({snapshots:window.qaCalls.filter(call=>call.method==='chat.snapshot').length,events:window.qaEvents})),before);
  assert.equal(await page.evaluate(()=>window.qaPwned),0);
  assert.equal(await page.locator('[id$="evil-img"]').getAttribute('onerror'),null);
  assert.equal(await page.locator('[id$="js-link"]').getAttribute('href'),null);
  assert.equal(await page.locator('[id$="forged-reference"]').getAttribute('data-threadterm-file-reference'),null);
  assert.equal(await page.locator('[onerror],a[href^="javascript:"],[data-threadterm-file-reference]').count(),0);
  assert.equal(await page.getByRole('button',{name:'javascript',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'forged',exact:true}).count(),0);
  if(provider==='codex')await page.screenshot({path:resolve('qa/results/chat-file-navigation.png'),fullPage:true});

  if(liveSamples[provider]){
   const samples=page.getByRole('button',{name:'sample.md',exact:true});
   assert.equal(await samples.count(),2);
   const count=await page.evaluate(()=>window.qaCalls.filter(call=>call.method==='filesystem.resolve'&&call.params.path==='sample.md').length);
   await samples.nth(0).click();
   await page.waitForFunction(previous=>window.qaCalls.filter(call=>call.method==='filesystem.resolve'&&call.params.path==='sample.md').length>previous,count);
   await page.getByRole('button',{name:'sample.md',exact:true}).nth(1).click();
   await page.waitForFunction(previous=>window.qaCalls.filter(call=>call.method==='filesystem.resolve'&&call.params.path==='sample.md').length>previous,count+1);
  }
  // Same workspace, same physical file, different source session. Hidden chats
  // remain mounted and subscribed, but only the current owner's file tabs show.
  await page.evaluate(()=>{window.qaOriginalComposer=document.querySelector('.chat-compose textarea');});
  await page.evaluate(id=>window.qaNavigate(id),'chat-'+provider+'-other');
  await page.getByRole('tab',{name:'Other '+provider,exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'AGENTS.md',exact:true}).count(),0);
  await page.getByRole('button',{name:'absolute',exact:true}).click();
  await page.getByRole('button',{name:'Close file preview',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.qaChatNode.isConnected&&window.qaChatNode.getClientRects().length===0),true);
  const owners=await page.evaluate(()=>{const visit=node=>node.kind==='pane'?node.tabs:visit(node.first).concat(visit(node.second));return visit(window.qaSaved).filter(tab=>tab.path==='AGENTS.md').map(tab=>tab.ownerSessionId).sort();});
  assert.deepEqual(owners,['chat-'+provider,'chat-'+provider+'-other'].sort());
  await page.getByRole('tab',{name:'Chat '+provider,exact:true}).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(),'draft stays');
  assert.equal(await composer.evaluate(element=>element===window.qaOriginalComposer),true);
  assert.equal(await page.evaluate(id=>window.qaCalls.filter(call=>call.method==='chat.snapshot'&&call.params.sessionId===id).length,'chat-'+provider),1);
  assert.equal(await page.evaluate(()=>window.qaEvents),before.events+1);
  assert.equal(await page.getByRole('tab',{name:'AGENTS.md',exact:true}).count(),0,'restored chat companion remains local, not global');
  if(provider!=='codex')continue;

  await page.getByRole('button',{name:'relative',exact:true}).click();
  await page.waitForFunction(()=>window.qaCalls.some(call=>call.method==='filesystem.resolve'&&call.params.path==='./src/main.ts'));
  assert.deepEqual((await page.evaluate(()=>window.qaCalls.filter(call=>call.method==='filesystem.resolve').at(-1))).params,{sessionId:'chat-codex',path:'./src/main.ts',line:7,column:3});
  const relativeEvents=await page.evaluate(()=>window.qaPointerEvents.filter(event=>event.text==='relative'));
  assert.deepEqual(relativeEvents.map(event=>event.type),['pointerdown','mousedown','pointerup','mouseup','click']);
  assert.equal(relativeEvents.every(event=>event.sameNode),true);
  await page.getByRole('button',{name:'README.md:4',exact:true}).click();
  await page.waitForFunction(()=>window.qaCalls.some(call=>call.method==='filesystem.resolve'&&call.params.path==='README.md'));
  assert.equal((await page.evaluate(()=>window.qaCalls.filter(call=>call.method==='filesystem.resolve').at(-1))).params.line,4);

  await page.locator('.codex-tool-disclosure summary:visible').click();
  await page.locator('.codex-tool-disclosure .file-reference-chips .file-reference-link:visible').click();
  await page.waitForFunction(()=>window.qaCalls.some(call=>call.method==='filesystem.resolve'&&call.params.path.endsWith('tool.ts')));
  assert.deepEqual((await page.evaluate(()=>window.qaCalls.filter(call=>call.method==='filesystem.resolve').at(-1))).params,{sessionId:'chat-codex',path:'D:\\project\\ThreadTerm\\tool.ts',line:5,column:2});

  assert.equal(await page.getByRole('link',{name:'website',exact:true}).getAttribute('href'),'https://example.test/AGENTS.md');
  assert.equal(await page.getByRole('button',{name:'website',exact:true}).count(),0);
  await page.evaluate(()=>window.qaEmitUpdated());
  await page.getByRole('button',{name:'updated',exact:true}).click();
  await page.waitForFunction(()=>window.qaCalls.some(call=>call.method==='filesystem.resolve'&&call.params.path==='updated.md'));
  await page.getByRole('button',{name:'missing',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'missing or has moved'}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'missing.ts',exact:true}).count(),0);
  assert.equal(await composer.inputValue(),'draft stays');
 }
 // The default 1440 px app window with the Files side panel open leaves an 854 px pane area,
 // under the former 900 px rule. A Chat link must open beside Chat, also when an earlier
 // narrow open left a file tab inside the Chat pane.
 const splitChecks=[];
 for(const mixed of [false,true]){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1400,900));
  await page.goto(pathToFileURL(join(scratch,'index.html')).href+'?provider=codex'+(mixed?'&mixed=1':''));
  await page.locator('.chat-compose textarea:visible').waitFor();
  if(!await page.locator('.wb-sidebar').count())await page.locator('.wb-switcher .wb-switch-btn').first().click();
  await page.locator('.wb-sidebar').waitFor();
  const wide=await page.locator('.ws-content > .ws-pane').evaluate(element=>element.clientWidth);
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),1400-(wide-854));
  await page.waitForFunction(()=>Math.abs(document.querySelector('.ws-content > .ws-pane').clientWidth-854)<=2);
  await page.getByRole('button',{name:'absolute',exact:true}).click();
  await page.getByRole('button',{name:'Close file preview',exact:true}).waitFor();
  const placed=await page.evaluate(()=>({panes:document.querySelectorAll('[data-pane-id]').length,chatWidth:Math.round(document.querySelector('.chat-compose textarea')?.getBoundingClientRect().width??0)}));
  assert.equal(placed.panes,2,`${mixed?'mixed':'fresh'}: an 854 px pane area opens the file beside Chat`);
  assert.ok(placed.chatWidth>250,`${mixed?'mixed':'fresh'}: Chat stays visible, not covered by the file`);
  splitChecks.push({mixed,...placed});
  if(!mixed)await page.screenshot({path:resolve('qa/results/chat-file-navigation-854.png')});
 }
 assert.deepEqual(errors,[]);
 const report={passed:true,checks:['Codex/Claude/Kimi/Grok body click and retained chat draft/subscription','A/B session-owned same-path previews and retained hidden chat/composer/subscriptions','single-pane first navigation creates sibling without remount','non-focused pane click retains the original button through pointerdown/click','Markdown text updates still replace rendered content','encoded absolute Markdown href','relative #L/C anchor','inline code','Kimi/Grok captured provider samples (no live call this run)','structured tool chip','HTTP remains external','resolver failure visible','inert pre-sanitize HTML and forged metadata rejection'],liveSampleProviders:Object.keys(liveSamples),splitChecks,screenshot:resolve('qa/results/chat-file-navigation.png'),scratch};
 await writeFile(resolve('qa/results/chat-file-navigation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}catch(error){console.error(error);if(page)console.error(await page.evaluate(()=>({calls:window.qaCalls,pointerEvents:window.qaPointerEvents,buttons:[...document.querySelectorAll('button[data-file-reference]')].map(element=>({text:element.textContent,data:element.getAttribute('data-file-reference')})),alerts:[...document.querySelectorAll('[role=alert]')].map(element=>element.textContent)})));process.exitCode=1;}
finally{await app?.close();}
