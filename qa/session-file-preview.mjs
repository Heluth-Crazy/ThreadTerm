// Production SessionWorkspace regression: a file preview belongs to its source
// session. This is an isolated Electron fixture; it uses no daemon, provider,
// user profile, filesystem mutation, or model request.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

const scratchBase=process.env.TEMP;assert.ok(scratchBase,'TEMP must name the isolated QA scratch root');
const scratch=await mkdtemp(join(resolve(scratchBase),'threadterm-session-file-preview-'));
assert.equal(resolve(scratch).startsWith(resolve(scratchBase)),true,'scratch remains under TEMP');
const out=join(resolve(scratchBase),'session-file-preview-results');
await mkdir(out,{recursive:true});
const entry=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {SessionWorkspace} from './renderer/src/components/SessionWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const sessions=['a','b'].map(id=>({id,title:'Session '+id.toUpperCase(),provider:'codex',mode:'terminal',status:'running',projectId:'project',worktreePath:'D:/fixture',createdAt:'now',updatedAt:'now',cols:100,rows:30}));
const files={'a.md':'# A Markdown\\nThis preview belongs only to A.\\n','a.ts':Array.from({length:120},(_,index)=>'export const a'+index+' = '+index+';').join('\\n')+'\\n','b.md':'# B Markdown\\nThis preview belongs only to B.\\n','shared.ts':'export const independent = true;\\n'};
const drafts=new Map(); let revision=0;
window.qa={calls:[],subscriptions:{},terminals:[],saved:undefined};
const originalOpen=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.qa.terminals.push({terminal:this,element});return originalOpen.call(this,element);};
window.threadterm={onPageContextMenu:()=>()=>{},platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},onEvent:()=>()=>{},openExternal:async()=>{},
 subscribeOutput:async(id,cursor,listener)=>{window.qa.subscriptions[id]=(window.qa.subscriptions[id]??0)+1;listener({sessionId:id,cursor:0,data:new TextEncoder().encode('Session '+id+' ready\\r\\n')});return()=>{};},
 request:async(method,params)=>{window.qa.calls.push({method,params});
  if(method==='workspace.save'){if(params.expectedRevision!==revision)throw Error('workspace.save revision was not serialized');revision++;window.qa.saved={...params.layout};return{id:'workspace',revision};}
  if(method==='terminal.read')return{nextCursor:0,data:'',fromCursor:0};
  if(method==='session.claim')return{leaseEpoch:1};
  if(['session.renew','session.release','terminal.resize','terminal.input'].includes(method))return{};
  if(method==='session.launch.read')return{phase:'running'};
  if(method==='worktree.list')return[];
  if(method==='git.status')return{branch:'main',changes:[],ahead:0,behind:0};
  if(method==='filesystem.list')return Object.keys(files).map(path=>({path,name:path,kind:'file'}));
  if(method==='filesystem.read'){const content=files[params.path];if(content===undefined)throw Error('missing fixture file '+params.path);return{path:params.path,content,readonly:false,fingerprint:'disk-'+params.path,size:content.length,modifiedAt:'now'};}
  if(method==='draft.list')return [...drafts.values()];
  if(method==='draft.put'){const value={...params,id:params.path,revision:(drafts.get(params.path)?.revision??0)+1};drafts.set(params.path,value);return value;}
  if(method==='draft.delete'){for(const [key,value] of drafts)if(value.id===params.id)drafts.delete(key);return{};}
  if(method==='filesystem.write')return{path:params.path,content:params.content,readonly:false,fingerprint:'saved-'+params.path,size:params.content.length,modifiedAt:'now'};
  throw Error('Unexpected QA request '+method);
 }};
function Fixture(){
 const [sessionId,setSessionId]=useState('a'),[navigationKey,setNavigationKey]=useState(0),[tick,setTick]=useState(0);
 window.qa.navigate=id=>{if(id!==sessionId){setSessionId(id);setNavigationKey(key=>key+1);}}; window.qa.refresh=()=>setTick(value=>value+1);
 // A restored session workspace deliberately projects away independent file tabs.  The
 // ownerless case below must therefore exercise the real Explorer open action after mount.
 const layout=window.qa.saved??{kind:'pane',id:'pane',tabs:[{id:'session-a',kind:'session',sessionId:'a'},{id:'session-b',kind:'session',sessionId:'b'}],activeTabId:'session-a'};
 const data={projects:[{id:'project',name:'Fixture',path:'D:/fixture'}],sessions:sessions.map(item=>({...item})),settings:{terminalCompatibility:{}},providers:[{id:'codex',terminalResumeCapture:'exit-hint'}],workspaces:[{id:'workspace',projectId:'project',worktreePath:'D:/fixture',layout,revision}]};
 return <I18nProvider locale="en"><SessionWorkspace session={data.sessions.find(item=>item.id===sessionId)} data={data} theme="light" navigationKey={navigationKey} onActiveSession={setSessionId} onBack={()=>{window.qa.back=(window.qa.back??0)+1}} onSelect={window.qa.navigate} onProject={()=>{}} onChanged={window.qa.refresh} onBackgroundPresented={()=>{}}/></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="root"></div><script>window.__qaBootstrapErrors=[];addEventListener("error",event=>window.__qaBootstrapErrors.push(event.message));</script><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);

let app;let page;let releaseLock;const report={passed:false,checks:[],screenshots:[]};
function environment(){const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe'].includes(key.toLowerCase())));Object.assign(env,{PATH:[dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),TEMP:resolve(scratchBase),TMP:resolve(scratchBase),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-session-file-preview-${process.pid}`,THREADTERM_V3_RUNTIME:process.env.THREADTERM_V3_RUNTIME_BIN??resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe')});assert.equal(Object.keys(env).filter(key=>key.toLowerCase()==='path').length,1,'fake-only environment has one PATH spelling');return env;}
try{
 releaseLock=await acquireElectronQaLock({directory:resolve(scratchBase)});app=await electron.launch({args:[join(scratch,'main.cjs')],cwd:resolve('.'),env:environment(),timeout:15_000});page=await app.firstWindow({timeout:15_000});page.setDefaultTimeout(12_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.qa?.terminals.length===1&&document.querySelector('.xterm'));
 // Session-owned previews come from the side bar Explorer's "Open beside session" (owner = active session).
 const openFiles=async()=>{const files=page.locator('.wb-switcher').getByRole('button',{name:'Files',exact:true});if(await files.getAttribute('aria-pressed')!=='true')await files.click();};
 const openOwnerless=async file=>{await openFiles();await page.locator(`.wb-tree [data-path="${file}"]`).click();};
 const openBeside=async file=>{await openFiles();const row=page.locator(`.wb-tree [data-path="${file}"]`);for(let attempt=0;attempt<3;attempt++){await row.focus();await row.press('Shift+F10');const action=page.getByRole('menuitem',{name:'Open beside session',exact:true});await action.waitFor();try{await action.focus();await action.press('Enter');return;}catch(error){if(attempt===2)throw error;await page.keyboard.press('Escape').catch(()=>{});}}};
 const visiblePanes=()=>page.locator('[data-pane-id]:not([hidden])');
 const visibleTab=(name)=>visiblePanes().getByRole('tab',{name,exact:true});
 const visiblePaneFor=(name)=>visiblePanes().filter({has:page.getByRole('tab',{name,exact:true})});
 const closeVisibleTab=async name=>{const tab=visibleTab(name);for(let attempt=0;attempt<3;attempt++){await tab.focus();await tab.press('Shift+F10');const action=page.getByRole('menuitem',{name:'Close current',exact:true});await action.waitFor();try{await action.focus();await action.press('Enter');return;}catch(error){if(attempt===2)throw error;await page.keyboard.press('Escape').catch(()=>{});}}};
 const closeOtherTabs=async name=>{const tab=visibleTab(name);for(let attempt=0;attempt<3;attempt++){await tab.scrollIntoViewIfNeeded();await tab.focus();await tab.press('Shift+F10');const action=page.getByRole('menuitem',{name:'Close others',exact:true});await action.waitFor();try{await action.focus();await action.press('Enter');return;}catch(error){if(attempt===2)throw error;await page.keyboard.press('Escape').catch(()=>{});}}};
 const waitForActiveSession=label=>page.waitForFunction(name=>[...document.querySelectorAll('[role=tab][aria-selected="true"]')].some(tab=>tab.getAttribute('aria-label')===name)&&Boolean(document.querySelector('.pane-tab-surface:not([hidden]) .xterm')),label);
 await openOwnerless('shared.ts');await visibleTab('shared.ts').waitFor();
 assert.equal(await visiblePaneFor('shared.ts').count(),1,'Explorer opens shared.ts in exactly one visible pane');
 await visibleTab('Session A').click();await waitForActiveSession('Session A');
 // Use the production side bar and pointer clicks for both preview types.
 await openBeside('a.md');await page.getByText('This preview belongs only to A.',{exact:true}).waitFor();
 await openBeside('a.ts');
 assert.equal(await page.locator('[data-pane-id]').count(),3,'the ownerless file has its own pane and the first owned preview opens in a separate companion pane');
 assert.equal(await visiblePaneFor('shared.ts').count(),1,'A companion does not move the ownerless shared.ts tab');
 await visibleTab('a.md').click();await page.getByText('This preview belongs only to A.',{exact:true}).waitFor();await visibleTab('a.ts').click();
 const editor=visiblePaneFor('a.ts').locator('.pane-tab-surface:not([hidden]) .cm-content[contenteditable=true]');const codeText=()=>editor.evaluate(element=>{const view=element.cmView?.view??element.parentElement?.cmView?.view;return view?.state.doc.toString()??'';});await editor.waitFor();await editor.click();await editor.press('Control+End');await editor.pressSequentially('// A DIRTY TEXT');
 const scroller=visiblePaneFor('a.ts').locator('.pane-tab-surface:not([hidden]) .cm-scroller');await scroller.evaluate(element=>{element.scrollTop=240;});const aScroll=await scroller.evaluate(element=>element.scrollTop);assert.ok(aScroll>0,'fixture code must be genuinely scrollable');
 await page.waitForTimeout(550); // The production draft debounce must run before A is hidden.
 await editor.evaluate((element,aScroll)=>{window.qa.aEditor=element;window.qa.aScroller=element.closest('.pane-tab-surface')?.querySelector('.cm-scroller');window.qa.aScroll=aScroll;window.qa.aTerminal=window.qa.terminals[0];window.qa.aSubscription=window.qa.subscriptions.a;},aScroll);assert.ok((await editor.innerText()).includes('// A DIRTY TEXT'),'fixture input must enter the visible CodeMirror surface');
 report.checks.push('A opens Markdown and code through actual SessionWorkspace controls, then has a dirty CodeMirror draft and scroll position');

 await page.evaluate(()=>window.qa.navigate('b'));await page.getByRole('tab',{name:'Session B',exact:true}).waitFor();
 await page.waitForFunction(()=>window.qa.terminals.length>=2&&window.qa.subscriptions.b===1);
 assert.equal(await visibleTab('a.md').count(),0,'B must not expose A markdown tab in any visible pane');
 assert.equal(await visibleTab('a.ts').count(),0,'B must not expose A code tab in any visible pane');
 assert.equal(await visiblePaneFor('shared.ts').count(),1,'A/B switching retains the ownerless shared.ts tab in its visible pane');
 const aPreview=page.getByText('This preview belongs only to A.',{exact:true});
 assert.ok((await aPreview.count())===0||!await aPreview.first().isVisible(),'B must not display A preview body');
 const hiddenA=await page.evaluate(()=>{const editor=window.qa.aEditor;const scroll=window.qa.aScroller;const hidden=editor?.closest('[hidden],[inert],[aria-hidden="true"]');return{editorConnected:editor?.isConnected,scrollConnected:scroll?.isConnected,hidden:Boolean(hidden),activeIsA:editor?.contains(document.activeElement)};});
 assert.equal(hiddenA.editorConnected,true,'visited A editor must be cached rather than unmounted');
 assert.equal(hiddenA.scrollConnected,true,'visited A editor scroll surface must be cached rather than unmounted');
 assert.equal(hiddenA.hidden,true,'cached A content must be inert or hidden while B is active');
 assert.equal(hiddenA.activeIsA,false,'hidden A editor must not retain interactive focus');
 assert.equal(await page.evaluate(()=>window.qa.subscriptions.a),1,'switching sessions must not resubscribe A terminal');
 assert.equal(await page.evaluate(()=>window.qa.aTerminal.element.isConnected),true,'A xterm host must remain connected while hidden');
 report.checks.push('B sees no A file tab or preview; cached A editor/xterm are hidden, unfocusable, and retain their original subscription');

 await openBeside('b.md');await page.getByText('This preview belongs only to B.',{exact:true}).waitFor();
 assert.equal(await visibleTab('a.md').count(),0);
 assert.equal(await visibleTab('a.ts').count(),0);
 assert.equal(await visiblePaneFor('shared.ts').count(),1,'B companion preview leaves the ownerless tab in its own pane');
 await visiblePaneFor('b.md').getByRole('button',{name:'Workspace actions',exact:true}).click();
 assert.deepEqual(await page.locator('[role=menu] .menu-item').allTextContents(),['Fullscreen pane','Split right','Split down','Close pane'],'only B’s focused file surface may portal its four workspace actions');
 await page.keyboard.press('Escape');
 await closeVisibleTab('Session A');await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).count(),1,'cancelling a hidden dirty A close must retain its session tab');
 report.checks.push('B opens its own file through the same production controls; B menu has no actions leaked from hidden A surfaces');

 await page.getByRole('tab',{name:'Session A',exact:true}).click();await editor.waitFor();
 assert.ok((await codeText()).includes('// A DIRTY TEXT'),'returning to A must restore its unsaved CodeMirror text');
 assert.equal(await scroller.evaluate(element=>element.scrollTop),await page.evaluate(()=>window.qa.aScroll),'returning to A must restore its editor scroll position');
 await editor.click();await page.keyboard.press('Control+z');assert.equal((await codeText()).includes('// A DIRTY TEXT'),false,'returning to A must retain CodeMirror undo history');
 assert.equal(await visibleTab('b.md').count(),0,'A must not expose B preview tab after returning');
 assert.equal(await visiblePaneFor('shared.ts').count(),1,'returning to A retains the ownerless project tab in its pane');
 assert.equal(await page.evaluate(()=>window.qa.aTerminal.terminal===window.qa.terminals[0].terminal&&window.qa.subscriptions.a===window.qa.aSubscription),true,'A terminal identity and subscription must survive A → B → A');
 await closeOtherTabs('a.ts');
 assert.equal(await visibleTab('a.ts').count(),1,'local Close others keeps its captured companion tab');
 assert.equal(await visibleTab('a.md').count(),0,'local Close others removes the other tab in the companion pane');
 assert.equal(await visibleTab('Session B').count(),1,'local Close others does not sweep session tabs in another pane');
 assert.equal(await visibleTab('shared.ts').count(),1,'local Close others does not sweep the ownerless file in another pane');
 await editor.click();await editor.press('Control+End');await editor.pressSequentially('// CLOSE DIRTY');await page.waitForTimeout(50);
 await page.getByRole('tab',{name:'Session A',exact:true}).click();await visiblePaneFor('Session A').getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('button',{name:'Close pane',exact:true}).click();await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).count(),1,'cancelling source-pane close keeps Session A');
 assert.equal(await page.getByRole('tab',{name:'Session B',exact:true}).count(),1,'cancelling source-pane close keeps the sibling Session B');
 assert.ok((await codeText()).includes('// CLOSE DIRTY'),'cancelling source-pane close keeps its hidden dirty companion');
 await visiblePaneFor('Session A').getByRole('button',{name:'Open session files',exact:true}).click();await editor.waitFor();
 await visiblePaneFor('a.ts').getByRole('button',{name:'Close tab a.ts',exact:true}).click();await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.ok((await codeText()).includes('// CLOSE DIRTY'),'cancelling a dirty file-preview close must retain its text');
 await closeVisibleTab('Session A');await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).count(),1,'cancelling a dirty-session close must retain the session tab');
 assert.ok((await codeText()).includes('// CLOSE DIRTY'),'cancelling a dirty-session close must retain the dirty file text');
 await closeVisibleTab('Session A');await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Discard changes',exact:true}).click();
 await page.getByRole('tab',{name:'Session A',exact:true}).waitFor({state:'detached'});
 assert.equal(await visibleTab('a.md').count(),0,'discarding A must close its associated markdown tab');
 assert.equal(await visibleTab('a.ts').count(),0,'discarding A must close its associated code tab');
 assert.equal(await page.getByRole('tab',{name:'Session B',exact:true}).count(),1,'discarding A must not close Session B');
 await page.waitForFunction(text=>[...document.querySelectorAll('p')].some(element=>element.textContent===text&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none'&&element.getClientRects().length>0),'This preview belongs only to B.');
 const bPreviewState=await page.locator('p').filter({hasText:'This preview belongs only to B.'}).evaluateAll(elements=>elements.map(element=>({text:element.textContent,visible:getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none'&&element.getClientRects().length>0,hiddenAncestor:element.closest('[hidden],[inert],[aria-hidden="true"]')?.outerHTML.slice(0,240)??null})));
 assert.deepEqual(bPreviewState.filter(item=>item.visible).map(item=>item.text),['This preview belongs only to B.'],`discarding A must leave exactly one visible B preview: ${JSON.stringify(bPreviewState)}`);
 const mainSaveCount=await page.evaluate(()=>window.qa.calls.filter(call=>call.method==='workspace.save').length);
 assert.ok(mainSaveCount>=4,'wide session/file navigation must persist each layout transition');
 const independentSaved=await page.evaluate(()=>{const visit=node=>!node?[]:node.kind==='pane'?node.tabs:visit(node.first).concat(visit(node.second));const tab=visit(window.qa.saved).find(tab=>tab.path==='shared.ts');return{exists:Boolean(tab),hasOwner:Boolean(tab&&Object.hasOwn(tab,'ownerSessionId')),owner:tab?.ownerSessionId};});
 assert.equal(independentSaved.exists,true,'the independent project file must remain in the saved workspace');
 assert.equal(independentSaved.owner,undefined,`restoring session companions must not claim the independent project file: ${JSON.stringify(independentSaved)}`);
 // A fresh narrow scenario is intentionally separate from the wide split flow.
 await page.setViewportSize({width:760,height:860});await page.reload();await page.waitForFunction(()=>window.qa?.terminals.length===1&&document.querySelector('.xterm'));
 await waitForActiveSession('Session A');await openBeside('a.ts');const narrowEditor=visiblePaneFor('a.ts').locator('.pane-tab-surface:not([hidden]) .cm-content[contenteditable=true]');await narrowEditor.waitFor();
 assert.equal(await page.locator('[data-pane-id]').count(),1,'at 760px, A file navigation must keep its session and file in one pane');
 await page.getByRole('tab',{name:'Session B',exact:true}).click();await page.waitForFunction(()=>window.qa.subscriptions.b===1);
 await page.getByRole('tab',{name:'Session A',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.xterm')].filter(element=>getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none'&&element.getClientRects().length>0).length===1);
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).getAttribute('aria-selected'),'true','narrow A click must reactivate the A terminal before returning to its file');
 await visiblePaneFor('Session A').getByRole('button',{name:'Open session files',exact:true}).click();await narrowEditor.waitFor();
 assert.equal(await page.locator('[data-pane-id]').count(),1,'narrow A/B navigation and file restore must not introduce a split');
 await closeOtherTabs('Session A');
 assert.equal(await page.getByRole('tab',{name:'Session A',exact:true}).count(),1,'Close others keeps its captured current session');
 assert.equal(await page.getByRole('tab',{name:'Session B',exact:true}).count(),0,'Close others removes the other session');
 assert.equal(await page.getByRole('tab',{name:'a.ts',exact:true}).count(),0,'narrow Close others removes the companion in the same pane');
 assert.equal(await page.evaluate(()=>window.qa.calls.some(call=>call.method==='session.stop'||call.method==='session.rerun')),false,'session switching must not alter process lifecycle');
 assert.deepEqual(errors,[]);await page.screenshot({path:join(out,'a-restored.png')});report.screenshots.push('a-restored.png');report.passed=true;
 report.checks.push('A restores its original dirty code, scroll, undo stack, xterm identity and subscription without exposing B content; closing A prompts, cancel preserves it, and discard closes only A plus its file tabs; an independent 760px scenario keeps session/file in one pane and restores A terminal then its editor by real top-tab clicks');
}catch(error){const bootstrap=page?await page.evaluate(()=>window.__qaBootstrapErrors).catch(()=>[]):[];report.error=(error instanceof Error?error.stack:String(error))+(bootstrap.length?'\\nBootstrap errors: '+bootstrap.join(' | '):'');process.exitCode=1;console.error(report.error);if(page){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});report.screenshots.push('failure.png');}}
finally{if(app)await app.close().catch(()=>{});await releaseLock?.();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
