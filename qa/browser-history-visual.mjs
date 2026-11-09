// Native browser History-state regression: real Electron/WebContentsView/UI, isolated profile.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {freemem,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const root=resolve(import.meta.dirname,'..'),out=join(root,'qa/results/browser-history-visual');
const scratch=await mkdtemp(join(tmpdir(),'tt-browser-history-')),report={passed:false,scope:'Production WebPreview/native browser with an isolated loopback page and mocked BrowserAgentRuntime; no Rust, provider, account, or user profile.',checks:[],errors:[],limitations:['The QA virtual desktop did not deliver visibilitychange when the native view was occluded (scrollSaves remained zero); the test invokes the equivalent same-URL History replacement and records that limitation rather than claiming the user page lifecycle was reproduced.']};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
async function replyFor(operationId){for(let attempt=0;attempt<200;attempt++){const reply=await app.evaluate((_,id)=>globalThis.qaControl.replies.find(value=>value.operationId===id),operationId);if(reply)return reply;await new Promise(done=>setTimeout(done,25));}throw Error(`Timed out waiting for ${operationId} receipt`);}
const server=createServer((_req,res)=>res.end(`<!doctype html><title>History fixture</title><script>
window.scrollSaves=0;addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&history.state){window.scrollSaves++;history.replaceState({...history.state,scroll:{left:scrollX,top:scrollY}},'')}});
</script><h1>History fixture</h1><button id="fixture-button">Fixture control</button>`));
const foreignServer=createServer((_req,res)=>res.end('<!doctype html><title>Foreign fixture</title><h1>Foreign fixture</h1>'));
let app,release;
try {
 await mkdir(out,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));await new Promise(done=>foreignServer.listen(0,'127.0.0.1',done));
 const url=`http://127.0.0.1:${server.address().port}/?roundId=fixture`;
 const foreign=`http://127.0.0.1:${foreignServer.address().port}/`;
 const renderer=`import React from 'react';import{createRoot}from'react-dom/client';import{WebPreview}from'./renderer/src/components/WebPreview';import{I18nProvider}from'./renderer/src/i18n';import'./renderer/src/styles.css';
createRoot(document.getElementById('root')).render(<I18nProvider locale='en'><WebPreview activeSessionId='qa-session' tabId='qa-tab' url={${JSON.stringify(url)}} visible zh={false} prepareBrowserShare={async()=>({id:'workspace',revision:1,sessionId:'qa-session'})}/></I18nProvider>);`;
 await build({stdin:{contents:renderer,resolveDir:root,loader:'tsx'},bundle:true,jsx:'automatic',outfile:join(scratch,'ui.js'),loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'});
 await writeFile(join(scratch,'index.html'),'<link rel="stylesheet" href="ui.css"><style>html,body,#root{height:100%;margin:0}#root,.wb-web-preview{display:flex;flex:1}</style><div id="root"></div><script src="ui.js"></script>');
 await writeFile(join(scratch,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');const on=c=>f=>{const l=(_e,v)=>f(v);ipcRenderer.on(c,l);return()=>ipcRenderer.removeListener(c,l)};contextBridge.exposeInMainWorld('threadterm',{browserCommand:x=>ipcRenderer.invoke('threadterm:browser-command',x),browserHandoff:x=>ipcRenderer.invoke('threadterm:browser-handoff',x),onBrowserEvent:on('threadterm:browser-event'),onBrowserHandoffEvent:on('threadterm:browser-handoff-event'),onPageContextMenu:()=>()=>{}});`);
 const main=`import{app,BrowserWindow}from'electron';import{registerBrowser}from'./desktop/src/browser/index';import{BrowserAgentSnapshotRefs}from'./desktop/src/browser/agentSnapshot';
app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});let n=0,registered,frameListener;const replies=[],resolvedRefs=[],boundRefs=[];const originalResolve=BrowserAgentSnapshotRefs.prototype.resolve,originalBind=BrowserAgentSnapshotRefs.prototype.bind;BrowserAgentSnapshotRefs.prototype.bind=function(fence,frame,node,role){const value=originalBind.call(this,fence,frame,node,role);if(value)boundRefs.push({instance:this,fence,ref:value.ref});return value};const workspace={id:'workspace',revision:1,projectId:'project',layout:{kind:'pane',id:'root',tabs:[{id:'qa-tab',kind:'web',url:${JSON.stringify(url)}}],activeTabId:'qa-tab'}};
let releaseSnapshot,snapshotGate;const emit=(tool,sequence,args={})=>{const r=registered;if(!r)throw Error('no registration');const{tabId,sourceTabId,...attachment}=r;const toolArguments=tool==='browser_list_tabs'?args:{tabId,...args};frameListener?.({method:'browser.execute',params:{...attachment,operationId:\`qa:\${sequence}\`,invocationId:\`qa-invocation-\${sequence}\`,callerSessionId:'qa-session',workerGeneration:'qa-worker',deadlineUnixMs:Date.now()+10000,tool,arguments:toolArguments,targets:[r]}})};globalThis.qaControl={holdSnapshot(){if(!snapshotGate)snapshotGate=new Promise(done=>releaseSnapshot=done)},releaseSnapshot(){releaseSnapshot?.();releaseSnapshot=undefined},emit,emitScreenshot(sequence=2){emit('browser_screenshot',sequence)},resolveBoundRef(ref){const entry=boundRefs.find(value=>value.ref===ref);if(!entry)throw Error('bound reference missing');try{originalResolve.call(entry.instance,entry.fence,ref);resolvedRefs.push({ref,ok:true});return true}catch(error){resolvedRefs.push({ref,ok:false,code:error?.code});return false}},replies,resolvedRefs};
const runtime={async snapshot(){if(snapshotGate){await snapshotGate;snapshotGate=undefined}return{workspaces:[workspace]}},async browserRequest(method,params){if(method==='browser.attach')return{attachmentId:'attach-'+(++n),attachmentGeneration:1,runtimeEpoch:'qa',viewGeneration:params.viewGeneration};if(method==='browser.registerTab')return registered={attachmentId:params.attachmentId,attachmentGeneration:params.attachmentGeneration,runtimeEpoch:'qa',viewGeneration:1,sourceTabId:params.sourceTabId,tabId:'registered-'+n};if(method==='browser.desktop.reply'){replies.push(params);return{accepted:true}}if(method==='browser.desktop.dispatch')return{accepted:true};return{}},onBrowserFrame(listener){frameListener=listener;return()=>{if(frameListener===listener)frameListener=undefined}},onBrowserDisconnect(){return()=>{}},onEvent(){return()=>{}}};
app.whenReady().then(()=>{registerBrowser(()=>{},()=>runtime);new BrowserWindow({show:true,width:1280,height:850,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,preload:${JSON.stringify(join(scratch,'preload.cjs'))}}}).loadFile(${JSON.stringify(join(scratch,'index.html'))});});`;
 await build({stdin:{contents:main,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(scratch,'main.cjs'),logLevel:'error'});
 assert.ok(freemem()>=8*1024**3,'Need 8GB free for Electron');release=await acquireElectronQaLock({timeoutMs:1000});
 app=await electron.launch({args:[join(scratch,'main.cjs')],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE'))});
 const page=await app.firstWindow();page.setDefaultTimeout(12_000);page.on('pageerror',e=>report.errors.push(e.message));
 const state=()=>page.evaluate(()=>window.threadterm.browserCommand({type:'state',tabId:'qa-tab'}));
 const native=code=>app.evaluate(async({webContents},source)=>{const wc=webContents.getAllWebContents().find(v=>v.getURL().includes('roundId=fixture'));if(!wc)throw Error('fixture native page missing');return wc.executeJavaScript(source);},code);
 await page.waitForFunction(()=>Boolean(window.threadterm)&&document.querySelector('[aria-label="Agent access Control"]')?.disabled===false);
 // Establish a state entry, mirroring Vue Router's prerequisite for scroll persistence.
 await native("history.replaceState({route:'fixture'},'',location.href)");await page.waitForTimeout(120);
 const before=await state();
 await page.getByRole('button',{name:'Agent access Control',exact:true}).click();await page.getByRole('dialog').waitFor();await page.waitForTimeout(450);
 // A detached WebContentsView remains `visible` in Electron's virtual-desktop
 // host. The production incident separately proves its visibility event; invoke
 // the identical History commit here to validate the native authority boundary.
 await native("history.replaceState({...history.state,scroll:{left:0,top:0}},'')");await page.waitForTimeout(100);
 assert.equal(await page.getByRole('dialog').count(),1,'same-URL scroll-state replacement retains confirmation');
 report.firstOcclusion={scrollSaves:await native('window.scrollSaves'),visibility:await native('document.visibilityState'),snapshotReady:Boolean((await state()).snapshot)};
 const during=await state();assert.equal(during.sharing.navigationEpoch,before.sharing.navigationEpoch,'same-URL scroll-state replacement retains native navigation epoch');
 await page.getByRole('button',{name:'Allow Control',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Agent access Control"]')?.getAttribute('aria-pressed')==='true');
 check('same-URL scroll-state replacement retains confirmation and completes Control grant');
 const controlEpoch=(await state()).sharing.navigationEpoch;
 await native("history.replaceState({route:'again'},'')");await page.waitForTimeout(120);assert.equal((await state()).sharing.navigationEpoch,controlEpoch,'ordinary same-URL replace preserves established control');
 check('same-URL replaceState retains established Control');
 await native("history.pushState({route:'push'},'',location.href)");await page.waitForTimeout(120);assert.ok((await state()).sharing.navigationEpoch>controlEpoch,'pushState invalidates epoch');
 check('same-URL pushState remains navigation');
 const afterPush=(await state()).sharing.navigationEpoch;
 await native('history.back()');await page.waitForTimeout(120);const afterBack=(await state()).sharing.navigationEpoch;assert.ok(afterBack>afterPush,'same-URL back invalidates epoch');
 await native('history.forward()');await page.waitForTimeout(120);assert.ok((await state()).sharing.navigationEpoch>afterBack,'same-URL forward invalidates epoch');
 check('same-URL history traversal remains navigation');
 for(let i=0;i<55;i++)await native(`history.pushState({i:${i}},'',location.href)`);
 await page.waitForTimeout(180);const capped=await state();
 await native("history.pushState({full:true},'',location.href)");await page.waitForTimeout(100);assert.ok((await state()).sharing.navigationEpoch>capped.sharing.navigationEpoch,'full-history push remains navigation');
 check('history-cap pushState remains navigation');
 // Hold the async grant after Allow, then make the native page hidden again.
 // A matching scroll-save must not poison the captured expected fence.
 await page.getByRole('button',{name:'Agent access Off',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Agent access Control"]')?.disabled===false);
 await page.getByRole('button',{name:'Agent access Control',exact:true}).click();await page.getByRole('dialog').waitFor();
 await app.evaluate(()=>globalThis.qaControl.holdSnapshot());await page.getByRole('button',{name:'Allow Control',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.wb-browser-share')?.getAttribute('aria-busy')==='true');
 await page.evaluate(()=>{const menu=document.createElement('div');menu.id='qa-native-menu';menu.setAttribute('role','menu');menu.textContent='Menu';document.body.append(menu)});
 await page.waitForTimeout(160);await native("history.replaceState({...history.state,scroll:{left:0,top:0}},'')");await page.waitForTimeout(100);
 await page.evaluate(()=>document.querySelector('#qa-native-menu')?.remove());
 await app.evaluate(()=>globalThis.qaControl.releaseSnapshot());
 await page.waitForFunction(()=>document.querySelector('[aria-label="Agent access Control"]')?.getAttribute('aria-pressed')==='true');
 check('pending Control grant survives a second native occlusion and scroll-state replacement');
 // Bind a real AX reference before the held screenshot. The later hover proves
 // that the same reference survives the menu/state-update interval.
 await app.evaluate(()=>globalThis.qaControl.emit('browser_snapshot',1));
 const snapshotReply=await replyFor('qa:1');
 assert.equal(snapshotReply.result.isError,undefined,'snapshot captures a usable reference');
 const snapshotText=snapshotReply.result.content.find(block=>block.type==='text')?.text??'';
 const snapshotPayload=JSON.parse(snapshotText.slice(snapshotText.indexOf('{')));
 const refMatch=snapshotPayload.outline.match(/button "Fixture control" \[(ref-[0-9a-f-]{36})\]/);
 assert.ok(refMatch,'snapshot includes a fixture node reference');
 const fixtureRef=refMatch[1];
 const snapshotEpoch=(await state()).sharing.navigationEpoch;
 assert.equal(await app.evaluate((_,ref)=>globalThis.qaControl.resolveBoundRef(ref),fixtureRef),true,'snapshot reference resolves before occlusion');
 await app.evaluate((_,ref)=>globalThis.qaControl.emit('browser_hover',2,{ref}),fixtureRef);
 const baselineHover=await replyFor('qa:2');
 assert.equal(baselineHover.result.outcome,'completed',`snapshot reference is usable before occlusion: ${JSON.stringify(baselineHover.result)}`);
 // Hold a real native screenshot operation. A menu overlay and matching History
 // replacement must not cancel it or invalidate its control binding.
 await app.evaluate(({webContents})=>{const wc=webContents.getAllWebContents().find(v=>v.getURL().includes('roundId=fixture'));const original=wc.capturePage.bind(wc);let first=true,release;globalThis.qaControl.holdCapture=()=>new Promise(done=>release=done);const gate=globalThis.qaControl.holdCapture();globalThis.qaControl.captureStarted=false;globalThis.qaControl.releaseCapture=()=>release?.();wc.capturePage=(...args)=>{if(first){first=false;globalThis.qaControl.captureStarted=true;return gate.then(()=>original(...args))}return original(...args)}});
 await app.evaluate(()=>globalThis.qaControl.emitScreenshot(3));
 await page.waitForFunction(async()=>await window.threadterm.browserCommand({type:'state',tabId:'qa-tab'}).then(value=>value.sharing?.operations?.some(operation=>operation.operationId==='qa:3'&&operation.phase==='running')));
 assert.equal(await app.evaluate(()=>globalThis.qaControl.captureStarted),true,'native capture is held before the menu opens');
 await page.evaluate(()=>{const menu=document.createElement('div');menu.id='qa-operation-menu';menu.setAttribute('role','menu');menu.textContent='Operation menu';document.body.append(menu)});
 await page.waitForTimeout(120);await native("history.replaceState({...history.state,scroll:{left:0,top:0}},'')");await page.evaluate(()=>document.querySelector('#qa-operation-menu')?.remove());
 await app.evaluate(()=>globalThis.qaControl.releaseCapture());
 await page.waitForFunction(async()=>await window.threadterm.browserCommand({type:'state',tabId:'qa-tab'}).then(value=>!value.sharing?.operations?.some(operation=>operation.operationId==='qa:3'&&['queued','running','stopping'].includes(operation.phase))));
 await replyFor('qa:3');
 const screenshotReplies=await app.evaluate(()=>globalThis.qaControl.replies.filter(reply=>reply.operationId==='qa:3'));
 assert.equal(screenshotReplies.length,1,'screenshot has one receipt');assert.equal(screenshotReplies[0].result.isError,undefined,'screenshot survives the menu/history update');
 check('in-flight browser screenshot survives menu occlusion and same-URL History replacement');
 await page.waitForTimeout(300);
 const afterOperation=await state();
 report.refFence={snapshotEpoch,afterEpoch:afterOperation.sharing.navigationEpoch,scrollSaves:await native('window.scrollSaves'),visibility:await native('document.visibilityState')};
 assert.equal(afterOperation.sharing.navigationEpoch,snapshotEpoch,'menu/history update preserves the snapshot reference epoch');
 assert.equal(await app.evaluate((_,ref)=>globalThis.qaControl.resolveBoundRef(ref),fixtureRef),true,'same production snapshot reference resolves after menu/history update');
 const resolveEvents=await app.evaluate((_,ref)=>globalThis.qaControl.resolvedRefs.filter(entry=>entry.ref===ref),fixtureRef);
 assert.equal(resolveEvents.length,2,`same production snapshot reference resolves before and after menu/history update: ${JSON.stringify(resolveEvents)}`);
 assert.ok(resolveEvents.every(entry=>entry.ok===true),'production reference resolve stays valid after menu/history update');
 await app.evaluate((_,ref)=>globalThis.qaControl.emit('browser_hover',4,{ref}),fixtureRef);
 const retainedHover=await replyFor('qa:4');
 assert.equal(retainedHover.result.outcome,'completed',`snapshot reference remains usable after menu/history update: ${JSON.stringify(retainedHover.result)}`);
 check('production snapshot reference remains usable after menu occlusion and same-URL History replacement');
 const beforeHash=(await state()).sharing.navigationEpoch;
 await native('location.hash="#changed"');await page.waitForTimeout(120);assert.ok((await state()).sharing.navigationEpoch>beforeHash,'hash change remains navigation');
 check('hash navigation remains invalidating');
 await native(`location.href=${JSON.stringify(foreign)}`);await page.waitForTimeout(240);
 assert.equal((await state()).sharing.level,'off','cross-origin navigation revokes Control');
 check('cross-origin navigation still revokes Control');
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=String(error.stack??error);process.exitCode=1;}finally{await app?.close();await release?.();await new Promise(done=>server.close(done));await new Promise(done=>foreignServer.close(done));await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));if(report.failure)console.error(report.failure);console.log(`Report: ${join(out,'report.json')}`);}
