import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

// Exercise the production main-process module in-process: no Electron, provider,
// subprocess, user profile, or network access is needed for these regressions.
const require = createRequire(import.meta.url);
// Keep the compiler external when the standard QA runner bundles this test as ESM.
const ts = require('typescript');
function fixture(savedFiles=new Map()) {
 const handlers=new Map(), views=[], windows=new Map(), timers=new Set(), sent=[], opened=[];
 let ready=false, id=0, findId=0, now=100_000, diskStep=async()=>{}, loadPage=async(wc,url)=>{wc.url=url;}, capture=async()=>({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c25hcHNob3Q='});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLf8AAAAASUVORK5CYII=','base64');
 const bitmap=()=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>png,toJPEG:()=>png,resize(){return this;}});
 const app=Object.assign(new EventEmitter(),{isPackaged:false,isReady:()=>ready,getPath:()=>resolve('qa/results/browser-unit-unused')});
 const profile=Object.assign(new EventEmitter(),{
  setPermissionRequestHandler(fn){this.permissionRequest=fn;},setPermissionCheckHandler(fn){this.permissionCheck=fn;},
  setCertificateVerifyProc(fn){this.verify=fn;},clearStorageData:async()=>{},clearCache:async()=>{},
 });
 function owner() {
  const wc=Object.assign(new EventEmitter(),{id:++id,isDestroyed:()=>false,getURL:()=> 'http://127.0.0.1:5173/',send:(channel,value)=>sent.push({owner:wc,channel,value}),focus(){wc.focused=true;},getZoomFactor:()=>1});
  wc.mainFrame={url:wc.getURL()};
  const children=[];
  const win=Object.assign(new EventEmitter(),{webContents:wc,isDestroyed:()=>false,isFocused:()=>true,getContentSize:()=>[1440,920],contentView:{children,addChildView(view){if(!children.includes(view))children.push(view);},removeChildView(view){const at=children.indexOf(view);if(at>=0)children.splice(at,1);}}});
  windows.set(wc,win);app.emit('web-contents-created',{},wc);return {wc,win,event:{sender:wc,senderFrame:wc.mainFrame,trusted:true}};
 }
 class FakeView {
  constructor(options) {
   this.options=options;this.bounds=undefined;views.push(this);
   const wc=Object.assign(new EventEmitter(),{id:++id,url:'about:blank',isDestroyed:()=>!!wc.closed,getURL:()=>wc.url,getTitle:()=> 'Fixture',
    loads:[],loadURL:async url=>{wc.loads.push(url);return loadPage(wc,url);},setWindowOpenHandler:fn=>{wc.popup=fn;},capturePage:(...args)=>capture(...args),
    canGoBack:()=>false,canGoForward:()=>false,goBack(){},goForward(){},reload(){},stop(){},
    navigationHistory:{canGoBack:()=>false,canGoForward:()=>false,goBack(){},goForward(){}},
    close(){wc.closed=true;wc.emit('destroyed');},focus(){wc.focused=true;},setZoomFactor(){},getZoomFactor:()=>1,
    findInPage(text,options){const requestId=++findId;wc.lastFind={text,options,requestId};return requestId;},stopFindInPage(){},
   });
   wc.mainFrame={executeJavaScriptInIsolatedWorld:async()=>null};this.webContents=wc;
  }
  setBounds(value){this.bounds=value;}
  setVisible(value){this.visible=value;}
 }
 const electron={app,nativeImage:{createFromBuffer:bitmap},BrowserWindow:{fromWebContents:wc=>windows.get(wc)},ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)},
  session:{fromPartition(name){assert.equal(ready,true,'browser session must be created after app ready');assert.equal(name,'persist:threadterm-browser');return profile;}},
  shell:{openPath:async path=>{opened.push({action:'open',path});return '';},showItemInFolder:path=>opened.push({action:'show',path})},WebContentsView:FakeView};
 const cache=new Map();
 function load(path) {
  path=resolve(path);if(cache.has(path))return cache.get(path).exports;
  const module={exports:{}};cache.set(path,module);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const localRequire=name=>{
   if(name==='electron')return electron;
   if(name.endsWith('/pageComments.js'))return {nativePageRegistered(){},nativePageClosed(){},deletePageShots:async ids=>{for(const key of savedFiles.keys())if(ids.some(id=>key.endsWith(`${id}.png`)||key.endsWith(`${id}.jpg`)))savedFiles.delete(key);}};
   if(name==='node:fs'||name==='node:fs/promises')return new Proxy(require(name),{get(target,key){
    // Browser preference persistence is deliberately isolated from the filesystem.
    if(key==='readFileSync')return path=>{if(savedFiles.has(path))return savedFiles.get(path);throw Object.assign(new Error('No saved preferences'),{code:'ENOENT'});};
    if(key==='writeFileSync')return (path,contents)=>savedFiles.set(path,contents);
    if(key==='renameSync')return (from,to)=>{savedFiles.set(to,savedFiles.get(from));savedFiles.delete(from);};
    if(key==='writeFile')return async(path,bytes)=>{await diskStep('write',path);savedFiles.set(path,bytes);};
    if(key==='rename')return async(from,to)=>{await diskStep('rename',to);savedFiles.set(to,savedFiles.get(from));savedFiles.delete(from);};
    if(key==='unlink')return async path=>{savedFiles.delete(path);};
    if(['mkdirSync','mkdir'].includes(key))return ()=>undefined;
    if(key==='realpath')return async value=>value;
    return target[key];
   }});
   if(name.startsWith('.')){let next=resolve(dirname(path),name);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';if(existsSync(next))return load(next);}
   return require(name);
  };
  const context={require:localRequire,module,exports:module.exports,console,URL,Buffer,process:{env:{THREADTERM_V3_DEV_SERVER_URL:'http://127.0.0.1:5173'},platform:process.platform},
   setInterval(fn){const timer={fn,unref(){}};timers.add(timer);return timer;},clearInterval(timer){timers.delete(timer);},
   setTimeout,clearTimeout,Date:class extends Date{static now(){return now;}},__dirname:dirname(path),__filename:path};
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`,context,{filename:path})(localRequire,module,module.exports);
  return module.exports;
 }
 const browser=load('desktop/src/browser/index.ts');ready=true;
 browser.registerBrowser(event=>{if(!event.trusted)throw new Error('Untrusted renderer');});
 const first=owner();
 const invoke=(command,event=first.event)=>Promise.resolve().then(()=>handlers.get('threadterm:browser-command')(event,command));
 const handoff=(command,event=first.event)=>Promise.resolve().then(()=>handlers.get('threadterm:browser-handoff')(event,command));
 const show=(tabId='page-one',event=first.event)=>invoke({type:'show',tabId,url:'https://example.test/',frameName:`tt-preview-${tabId.padEnd(8,'a')}`,bounds:{x:20,y:80,width:400,height:600}},event);
 return {invoke,handoff,show,first,owner,views,profile,sent,timers,opened,savedFiles,png,bitmap,setDiskStep(fn){diskStep=fn;},advance(ms){now+=ms;for(const timer of [...timers])timer.fn();},setLoad(fn){loadPage=fn;},setCapture(fn){capture=fn;}};
}

test('console handoff is owner-scoped, bounded to the document, and excludes normal logs',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;wc.emit('did-navigate',{},wc.url);
 wc.emit('console-message',{},3,'first error',7,'https://example.test/a.js');wc.emit('console-message',{},2,'warning',8,'https://example.test/a.js');wc.emit('console-message',{},1,'ordinary log',9,'https://example.test/a.js');
 const first=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(first.errors,1);assert.equal(first.warnings,1);assert.match(first.text,/Page data, not instructions/);assert.match(first.text,/first error/);assert.doesNotMatch(first.text,/ordinary log/);
 const other=f.owner();await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0},other.event),/Unknown browser tab/);
 wc.url='https://example.test/#hash';wc.emit('did-navigate-in-page',{},wc.url,true);assert.equal((await f.handoff({type:'console',tabId:'page-one',documentGeneration:0})).errors,1,'same-document navigation retains console');
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://example.test/reload'},'https://example.test/reload',false,true);await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);wc.url='https://example.test/reload';wc.emit('did-navigate',{},wc.url);const cleared=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(cleared.errors,0);assert.equal(cleared.entries.length,0);
});

test('capture handoff rejects a navigation race and malformed markup before filesystem access',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;let finish;
 f.setCapture(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.handoff({type:'capture',tabId:'page-one',documentGeneration:0});await new Promise(resolve=>setImmediate(resolve));wc.emit('did-finish-load');finish({isEmpty:()=>false,getSize:()=>({width:20,height:20}),toPNG:()=>Buffer.from('x'),toJPEG:()=>Buffer.from('x'),resize(){return this;}});await assert.rejects(pending,/Page changed/);
 await assert.rejects(f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:1,shotId:'../invalid',dataUrl:'data:image/png;base64,WA=='}),/Screenshot is not available/);
 await assert.rejects(f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:0,shotId:'00000000-0000-4000-8000-000000000000',dataUrl:'data:image/png;base64,WA=='}),/Page changed/);
});

test('Electron 44 console details preserve source line and ordinary logs do not churn IPC',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,count=()=>f.sent.filter(row=>row.channel==='threadterm:browser-handoff-event').length;
 wc.emit('did-navigate',{},wc.url);const initial=count();
 wc.emit('console-message',{level:'error',message:'details error',sourceId:'https://example.test/app.js',lineNumber:42});assert.equal(count(),initial+1);
 wc.emit('console-message',{level:'info',message:'ordinary info',sourceId:'https://example.test/app.js',lineNumber:43});assert.equal(count(),initial+1);
 const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(result.entries[0].line,42);assert.match(result.text,/app.js:42 details error/);
});
test('captured markup remains owner-scoped and atomic failures retain the original shot',async()=>{
 const f=fixture();await f.show();f.setCapture(async()=>f.bitmap());const capture=await f.handoff({type:'capture',tabId:'page-one',documentGeneration:0}),dataUrl=`data:image/png;base64,${f.png.toString('base64')}`;
 assert.ok(f.savedFiles.has(capture.shot.path));const other=f.owner();await assert.rejects(f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:0,shotId:capture.shot.id,dataUrl},other.event),/Unknown browser tab/);
 f.setDiskStep(async step=>{if(step==='rename')throw new Error('write unavailable');});await assert.rejects(f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:0,shotId:capture.shot.id,dataUrl}),/write unavailable/);assert.ok(f.savedFiles.has(capture.shot.path));assert.equal([...f.savedFiles.keys()].some(key=>key.endsWith('.tmp')),false);
 f.setDiskStep(async()=>{});const saved=await f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:0,shotId:capture.shot.id,dataUrl});assert.equal(saved.shot.id,capture.shot.id);assert.equal(saved.dataUrl,dataUrl);assert.ok(f.savedFiles.has(saved.shot.path));
});
test('same-URL navigation during markup rename cannot return a stale screenshot',async()=>{
 const f=fixture();await f.show();f.setCapture(async()=>f.bitmap());const capture=await f.handoff({type:'capture',tabId:'page-one',documentGeneration:0}),wc=f.views[0].webContents;
 f.setDiskStep(async step=>{if(step==='rename')wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:wc.url},wc.url,false,true);});
 await assert.rejects(f.handoff({type:'saveMarkup',tabId:'page-one',documentGeneration:0,shotId:capture.shot.id,dataUrl:`data:image/png;base64,${f.png.toString('base64')}`}),/Page changed/);assert.equal(f.savedFiles.has(capture.shot.path),false);assert.equal([...f.savedFiles.keys()].some(key=>key.endsWith('.tmp')),false);
});
test('browser preferences reach terminal-only renderer owners and persist after restart',async()=>{
 const files=new Map(),f=fixture(files),other=f.owner();await f.handoff({type:'preferences'},other.event);await f.handoff({type:'preferences',patch:{devServerOffers:false}});assert.ok(f.sent.some(row=>row.owner===other.wc&&row.value.type==='preferences'&&row.value.devServerOffers===false));
 const restored=fixture(files);assert.equal((await restored.handoff({type:'preferences'})).devServerOffers,false);
});

test('capture and save failures identify the failed stage and retain no partial screenshot',async()=>{
 const f=fixture();await f.show();
 f.setCapture(async()=>{throw new Error('capture unavailable');});
 await assert.rejects(f.handoff({type:'capture',tabId:'page-one',documentGeneration:0}),/Page screenshot capture failed: Error: capture unavailable/);
 f.setCapture(async()=>f.bitmap());f.setDiskStep(async()=>{throw new Error('disk unavailable');});
 await assert.rejects(f.handoff({type:'capture',tabId:'page-one',documentGeneration:0}),/Page screenshot save failed: Error: disk unavailable/);
 assert.equal([...f.savedFiles.keys()].some(path=>/\.(png|jpg)$/.test(path)),false);
});


test('a slow cross-origin navigation cannot export outgoing logs under its destination',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,origin=wc.url,destination='https://destination.test/page';
 wc.emit('did-navigate',{},origin);wc.emit('did-finish-load');
 wc.emit('console-message',{},3,'old document error',1,origin);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:destination});
 wc.emit('console-message',{},3,'outgoing timer during pending response',2,origin);
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:1}),/wait for navigation to settle/);
 // A stale finish from the outgoing page is not a commit of the pending destination.
 wc.emit('did-finish-load');
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:2}),/wait for navigation to settle/);
 wc.url=destination;wc.emit('did-navigate',{},destination);
 wc.emit('console-message',{level:'error',message:'inline script before load',sourceId:destination,lineNumber:1});
 const early=await f.handoff({type:'console',tabId:'page-one',documentGeneration:2});assert.equal(early.url,destination);assert.match(early.text,/inline script before load/);assert.doesNotMatch(early.text,/old document|outgoing timer/);
 wc.emit('did-finish-load');const loaded=await f.handoff({type:'console',tabId:'page-one',documentGeneration:3});assert.equal(loaded.errors,1);assert.match(loaded.text,/inline script before load/);
});

test('same-URL reloads clear at commit while same-document and subframe navigations retain logs',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
 wc.emit('console-message',{},3,'original error',1,url);
 wc.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false,url:'https://frame.test/'});
 wc.emit('did-frame-navigate',{},'https://frame.test/',200,'OK',false);
 wc.emit('did-fail-load',{},-102,'frame failed','https://frame.test/',false);
 assert.equal((await f.handoff({type:'console',tabId:'page-one',documentGeneration:0})).errors,1);
 const hash=url+'#part';wc.emit('did-start-navigation',{},hash,true,true);wc.url=hash;wc.emit('did-navigate-in-page',{},hash,true);
 const same=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(same.url,hash);assert.equal(same.errors,1);
 wc.emit('did-start-navigation',{},hash,false,true);wc.emit('console-message',{},3,'outgoing reload error',2,hash);
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
 wc.emit('did-navigate',{},hash);wc.emit('console-message',{},2,'fresh reload warning',3,hash);
 const reloaded=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(reloaded.errors,0);assert.equal(reloaded.warnings,1);assert.doesNotMatch(reloaded.text,/original error|outgoing reload error/);
});

test('cancelled, stopped, and download navigations retain only the surviving document console',async()=>{
 for(const outcome of ['cancel','stop','download']){
  const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);wc.emit('did-finish-load');
  wc.emit('console-message',{},3,'retained error',1,url);const destination='https://elsewhere.test/'+outcome;
  wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:destination});wc.emit('console-message',{},2,'outgoing warning',2,url);
  await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:1}),/wait for navigation to settle/);
  if(outcome==='stop')await f.invoke({type:'stop',tabId:'page-one'});
  if(outcome!=='download')wc.emit('did-fail-load',{},-3,'ERR_ABORTED',destination,true);
  wc.emit('did-stop-loading');
  const retained=await f.handoff({type:'console',tabId:'page-one',documentGeneration:1});assert.equal(retained.url,url,outcome);assert.equal(retained.errors,1,outcome);assert.equal(retained.warnings,1,outcome);assert.doesNotMatch(retained.text,/elsewhere.test/);
 }
});

test('failed loads stay unavailable without a document commit and recover on the next successful navigation',async()=>{
 for(const destination of ['https://unavailable.test/','https://example.test/']){
  const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
  wc.emit('console-message',{},3,'previous page error',1,url);wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:destination});
  wc.emit('did-fail-load',{},-102,'ERR_CONNECTION_REFUSED',destination,true);wc.emit('did-stop-loading');
  await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
  wc.emit('console-message',{},3,'unattributed failure output',2,destination);
  const recovered='https://recovered.test/';wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:recovered});wc.url=recovered;wc.emit('did-navigate',{},recovered);
  wc.emit('console-message',{},3,'recovered inline error',1,recovered);const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(result.url,recovered);assert.equal(result.errors,1);assert.doesNotMatch(result.text,/previous page|unattributed/);
 }
});

test('redirected and superseded navigations reset once at the committed final document',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://first.test/'});
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://second.test/'});
 wc.emit('did-fail-load',{},-3,'ERR_ABORTED','https://first.test/',true);
 wc.emit('console-message',{},3,'still the outgoing document',1,url);
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
 const final='https://final.test/';wc.url=final;wc.emit('did-navigate',{},final);wc.emit('console-message',{},3,'final inline error',1,final);
 wc.emit('did-fail-load',{},-3,'ERR_ABORTED','https://second.test/',true);wc.emit('did-stop-loading');
 const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(result.url,final);assert.equal(result.errors,1);assert.doesNotMatch(result.text,/outgoing document/);
});

test('console handoff rejects the initial and unloaded page and ignores its replaced native view',async()=>{
 const f=fixture();await f.show();const old=f.views[0].webContents,url=old.url;
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
 old.emit('did-navigate',{},url);old.emit('did-finish-load');old.emit('console-message',{},3,'evicted document',1,url);
 await f.invoke({type:'preferences',patch:{unloadAfterMinutes:1}});await f.invoke({type:'hide',tabId:'page-one'});f.advance(60_000);
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:1}),/wait for navigation to settle/);
 await f.show();const fresh=f.views.at(-1).webContents;
 // The recreated view can have the same URL, but it is a different document.
 fresh.emit('did-stop-loading');await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:1}),/wait for navigation to settle/);
 fresh.emit('did-navigate',{},url);old.emit('did-navigate',{},'https://stale.test/');old.emit('console-message',{},3,'late old-view error',1,url);
 fresh.emit('console-message',{},3,'new view error',1,url);const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:1});assert.equal(result.url,url);assert.equal(result.errors,1);assert.doesNotMatch(result.text,/evicted|old-view/);
});

test('outgoing console remains bounded during a long pending navigation and is reset at commit',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://next.test/'});
 for(let line=0;line<240;line++)wc.emit('console-message',{},3,'timer '+line,line,url);
 wc.emit('did-fail-load',{},-3,'ERR_ABORTED','https://next.test/',true);wc.emit('did-stop-loading');
 const retained=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(retained.entries.length,200);assert.equal(retained.entries[0].text,'timer 40');assert.equal(retained.truncated,true);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://next.test/'});wc.url='https://next.test/';wc.emit('did-navigate',{},wc.url);
 const cleared=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(cleared.entries.length,0);assert.equal(cleared.truncated,false);
});

test('an aborted retry cannot restore console provenance invalidated by a failed load',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
 wc.emit('console-message',{},3,'original page error',1,url);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://failed.test/'});
 wc.emit('did-fail-load',{},-102,'ERR_CONNECTION_REFUSED','https://failed.test/',true);
 wc.emit('console-message',{},3,'unattributed failure output',2,'https://failed.test/');
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://retry.test/'});
 wc.emit('did-fail-load',{},-3,'ERR_ABORTED','https://retry.test/',true);wc.emit('did-stop-loading');
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url});wc.emit('did-navigate',{},url);
 wc.emit('console-message',{},3,'fresh same-URL document',3,url);
 const recovered=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(recovered.errors,1);assert.doesNotMatch(recovered.text,/original page|unattributed/);
});

test('same-document changes during a cancelled navigation preserve the surviving document URL',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url=wc.url;wc.emit('did-navigate',{},url);
 wc.emit('console-message',{},3,'surviving error',1,url);
 wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://pending.test/'});
 wc.url=url+'#surviving';wc.emit('did-navigate-in-page',{},wc.url,true);
 await assert.rejects(f.handoff({type:'console',tabId:'page-one',documentGeneration:0}),/wait for navigation to settle/);
 wc.emit('did-fail-load',{},-3,'ERR_ABORTED','https://pending.test/',true);wc.emit('did-stop-loading');
 const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:0});assert.equal(result.url,wc.url);assert.equal(result.errors,1);
});

test('late lifecycle events from a destroyed native view cannot alter its replacement provenance',async()=>{
 const f=fixture();await f.show();const old=f.views[0].webContents,url=old.url;old.emit('did-navigate',{},url);old.emit('did-finish-load');
 await f.invoke({type:'preferences',patch:{unloadAfterMinutes:1}});await f.invoke({type:'hide',tabId:'page-one'});f.advance(60_000);await f.show();
 const fresh=f.views.at(-1).webContents;fresh.emit('did-navigate',{},url);fresh.emit('console-message',{},3,'replacement error',1,url);
 old.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:'https://stale.test/'});
 old.emit('did-navigate-in-page',{},'https://stale.test/#hash',true);old.emit('did-finish-load');
 old.emit('did-fail-load',{},-102,'ERR_CONNECTION_REFUSED','https://stale.test/',true);old.emit('did-stop-loading');
 const result=await f.handoff({type:'console',tabId:'page-one',documentGeneration:1});assert.equal(result.url,url);assert.equal(result.errors,1);assert.match(result.text,/replacement error/);
});
