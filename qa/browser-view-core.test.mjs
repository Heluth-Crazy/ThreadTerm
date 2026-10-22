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
 let ready=false, id=0, findId=0, now=100_000, loadPage=async(wc,url)=>{wc.url=url;}, capture=async()=>({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c25hcHNob3Q='});
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
    setDevToolsWebContents(contents){wc.devToolsWebContents=contents;},openDevTools(){wc.emit('devtools-opened');},closeDevTools(){wc.emit('devtools-closed');},executeJavaScript:async()=>undefined,
    findInPage(text,options){const requestId=++findId;wc.lastFind={text,options,requestId};return requestId;},stopFindInPage(){},
   });
   wc.mainFrame={executeJavaScriptInIsolatedWorld:async()=>null};this.webContents=wc;
  }
  setBounds(value){this.bounds=value;}
  setBorderRadius(value){this.radius=value;}
  setVisible(value){this.visible=value;}
 }
 const electron={app,BrowserWindow:{fromWebContents:wc=>windows.get(wc)},ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)},
  session:{fromPartition(name){assert.equal(ready,true,'browser session must be created after app ready');assert.equal(name,'persist:threadterm-browser');return profile;}},
  shell:{openPath:async path=>{opened.push({action:'open',path});return '';},showItemInFolder:path=>opened.push({action:'show',path})},WebContentsView:FakeView};
 const cache=new Map();
 function load(path) {
  path=resolve(path);if(cache.has(path))return cache.get(path).exports;
  const module={exports:{}};cache.set(path,module);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const localRequire=name=>{
   if(name==='electron')return electron;
   if(name.endsWith('/pageComments.js'))return {nativePageRegistered(){},nativePageClosed(){}};
   if(name==='node:fs'||name==='node:fs/promises')return new Proxy(require(name),{get(target,key){
    // Browser preference persistence is deliberately isolated from the filesystem.
    if(key==='readFileSync')return path=>{if(savedFiles.has(path))return savedFiles.get(path);throw Object.assign(new Error('No saved preferences'),{code:'ENOENT'});};
    if(key==='writeFileSync')return (path,contents)=>savedFiles.set(path,contents);
    if(key==='renameSync')return (from,to)=>{savedFiles.set(to,savedFiles.get(from));savedFiles.delete(from);};
    if(['mkdirSync','mkdir','writeFile','rename'].includes(key))return ()=>undefined;
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
 const show=(tabId='page-one',event=first.event)=>invoke({type:'show',tabId,url:'https://example.test/',frameName:`tt-preview-${tabId.padEnd(8,'a')}`,bounds:{x:20,y:80,width:400,height:600}},event);
 return {invoke,show,first,owner,views,profile,sent,timers,opened,advance(ms){now+=ms;for(const timer of [...timers])timer.fn();},setLoad(fn){loadPage=fn;},setCapture(fn){capture=fn;}};
}

test('native corners track the CSS radius and app zoom through bounds, restore and remount',async()=>{
 const f=fixture(),bounds={x:20,y:80,width:400,height:600},show={type:'show',tabId:'page-one',url:'https://example.test/',frameName:'tt-preview-page-one',bounds};
 f.first.wc.getZoomFactor=()=>1.25;
 await f.invoke({...show,radius:7});const view=f.views[0];assert.equal(view.radius,9);
 await f.invoke({type:'bounds',tabId:'page-one',bounds,radius:6.5});assert.equal(view.radius,8);
 f.first.wc.getZoomFactor=()=>1.5;
 await f.invoke({type:'bounds',tabId:'page-one',bounds,radius:6.5});assert.equal(view.radius,10);
 await f.invoke({type:'occlusion',active:true});const snapshot=await f.invoke({type:'state',tabId:'page-one'});
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:snapshot.snapshotGeneration});
 await f.invoke({type:'bounds',tabId:'page-one',bounds,radius:7});assert.equal(view.radius,11);
 await f.invoke({type:'occlusion',active:false});assert.equal(view.radius,11);
 await f.invoke({type:'hide',tabId:'page-one'});await f.invoke(show);assert.equal(view.radius,11,'omitted radius retains the measured value');
 await f.invoke({type:'bounds',tabId:'page-one',bounds,radius:0});assert.equal(view.radius,0);
 await f.show('legacy');assert.equal(f.views[1].radius,0,'older callers remain square by default');
});

test('native corners reject invalid CSS radii before creating or changing a view',async()=>{
 const f=fixture(),bounds={x:20,y:80,width:400,height:600};
 for(const radius of [-1,32.1,NaN,Infinity,-Infinity,'7',null]){
  await assert.rejects(f.invoke({type:'show',tabId:'page-one',url:'https://example.test/',frameName:'tt-preview-page-one',bounds,radius}),/Invalid browser view/);
 }
 assert.equal(f.views.length,0);
 await f.show();const view=f.views[0];
 for(const radius of [-1,32.1,NaN,Infinity,-Infinity,'7',null]){
  await assert.rejects(f.invoke({type:'bounds',tabId:'page-one',bounds,radius}),/Invalid browser bounds/);
  assert.equal(view.radius,0);
 }
 await f.invoke({type:'bounds',tabId:'page-one',bounds,radius:32});assert.equal(view.radius,32);
});

test('page and DevTools corners stay paired through resize, occlusion and tools reopen',async()=>{
 const f=fixture(),bounds={x:20,y:80,width:400,height:400},devtools={x:20,y:486,width:400,height:194};
 await f.show();await f.invoke({type:'devtools',tabId:'page-one',action:'open',panel:'console'});
 await f.invoke({type:'bounds',tabId:'page-one',bounds,devtools,radius:7});
 const [page,tools]=f.views;assert.equal(f.first.win.contentView.children.length,2);
 assert.equal(page.radius,7);assert.equal(tools.radius,7);
 f.first.wc.getZoomFactor=()=>1.25;
 await f.invoke({type:'bounds',tabId:'page-one',bounds,devtools,radius:7});assert.equal(page.radius,9);assert.equal(tools.radius,9);
 await f.invoke({type:'occlusion',active:true});const snapshot=await f.invoke({type:'state',tabId:'page-one'});
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:snapshot.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,0);
 await f.invoke({type:'bounds',tabId:'page-one',bounds,devtools,radius:6});assert.equal(page.radius,8);assert.equal(tools.radius,8);
 await f.invoke({type:'occlusion',active:false});assert.equal(f.first.win.contentView.children.length,2);
 await f.invoke({type:'devtools',tabId:'page-one',action:'close'});assert.equal(f.first.win.contentView.children.length,1);
 await f.invoke({type:'devtools',tabId:'page-one',action:'open'});assert.equal(f.views.length,2);assert.equal(tools.radius,8);
 assert.equal(f.first.win.contentView.children.length,2);
});

test('native browser is lazy, isolated, and deny-by-default',async()=>{
 const f=fixture();assert.equal(f.views.length,0);await f.show();
 const prefs=f.views[0].options.webPreferences;
 for(const key of ['sandbox','contextIsolation','webSecurity'])assert.equal(prefs[key],true,key);
 assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.preload,undefined);
 assert.equal(prefs.partition,'persist:threadterm-browser');
 assert.equal(f.profile.permissionCheck(null,'camera','https://example.test/'),false);
 let allowed;f.profile.permissionRequest(null,'geolocation',value=>{allowed=value;});assert.equal(allowed,false);
 const event={prevented:false,preventDefault(){this.prevented=true;}};f.views[0].webContents.emit('will-attach-webview',event,{},{});assert.equal(event.prevented,true);
});

test('IPC ownership prevents another app window from adopting an existing tab',async()=>{
 const f=fixture();await f.show();const second=f.owner();
 await assert.rejects(f.show('page-one',second.event),/owner|another|Unknown|belongs/i);
 await assert.rejects(f.invoke({type:'reload',tabId:'page-one'},{...f.first.event,trusted:false}),/Untrusted/);
 await assert.rejects(f.invoke({type:'show',tabId:'bad',url:'https://example.test/',frameName:'arbitrary',bounds:{x:0,y:0,width:400,height:400}}),/frame|Invalid/i);
});

test('page navigation cannot load files, executable URLs, or the app origin',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;
 for(const url of ['file:///C:/private.txt','javascript:alert(1)','data:text/html,hello','http://127.0.0.1:5173/']){
  const event={prevented:false,preventDefault(){this.prevented=true;}};wc.emit('will-navigate',event,url);assert.equal(event.prevented,true,url);
 }
 await f.invoke({type:'navigate',tabId:'page-one',url:'http://127.0.0.1:5173/'});assert.notEqual(wc.url,'http://127.0.0.1:5173/');
});

test('a page cannot create an unsolicited native or app tab popup',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;
 const result=wc.popup({url:'https://example.test/popup',frameName:'',features:'',disposition:'new-window',referrer:{url:'https://example.test/'}});
 assert.equal(result.action,'deny');assert.equal(f.sent.some(value=>value.value.type==='popup'),false);
});

test('occlusion stays active across bounds and show updates and repeated leases',async()=>{
 const f=fixture();await f.show();await f.invoke({type:'occlusion',active:true});
 const snapshot=await f.invoke({type:'state',tabId:'page-one'});await f.invoke({type:'snapshotReady',tabId:'page-one',generation:snapshot.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,0);
 await f.invoke({type:'bounds',tabId:'page-one',bounds:{x:10,y:100,width:400,height:500}});assert.equal(f.first.win.contentView.children.length,0);
 await f.show();assert.equal(f.first.win.contentView.children.length,0);
 await f.invoke({type:'occlusion',active:true});await f.invoke({type:'occlusion',active:false});assert.equal(f.first.win.contentView.children.length,1);
});

test('late snapshot cannot hide a page after its overlay closed',async()=>{
 const f=fixture();await f.show();let finish;
 f.setCapture(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.invoke({type:'occlusion',active:true});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.first.win.contentView.children.length,1,'live page stays attached while its snapshot is pending');
 await f.invoke({type:'occlusion',active:false});finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c25hcHNob3Q='});await pending;
 assert.equal(f.first.win.contentView.children.length,1);
});

test('hidden pages detach and app owner destruction disposes their contents',async()=>{
 const f=fixture();await f.show();await f.invoke({type:'hide',tabId:'page-one'});assert.equal(f.first.win.contentView.children.length,0);assert.equal(f.timers.size,1);
 f.first.wc.emit('destroyed');assert.equal(f.views[0].webContents.closed,true);assert.equal(f.timers.size,0);
});

test('owner destruction never reads an already destroyed native page',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;wc.closed=true;wc.getURL=()=>{throw Error('Object has been destroyed');};
 assert.doesNotThrow(()=>f.first.wc.emit('destroyed'));assert.equal(f.timers.size,0);
});

test('malformed browser commands fail rather than reaching Electron',async()=>{
 const f=fixture();await f.show();
 for(const command of [{type:'zoom',tabId:'page-one',factor:NaN},{type:'occlusion',active:'yes'},{type:'find',tabId:'page-one',text:42},{type:'unknown',tabId:'page-one'},{type:'snapshotReady',tabId:'page-one',generation:NaN},{type:'snapshotReady',tabId:'page-one',generation:0}])await assert.rejects(f.invoke(command),/Invalid|Unknown|Unsupported/i);
});

test('app-origin rejection applies to initial loads and redirects',async()=>{
 const f=fixture();
 await assert.rejects(f.invoke({type:'show',tabId:'app-origin',url:'http://127.0.0.1:5173/',frameName:'tt-preview-apporigin',bounds:{x:0,y:0,width:400,height:400}}),/app|Blocked|address/i);
 await f.show();const wc=f.views[0].webContents;
 const event={prevented:false,preventDefault(){this.prevented=true;}};
 wc.emit('will-redirect',event,'http://127.0.0.1:5173/',false,true);assert.equal(event.prevented,true);
});

test('tabs shown after an occlusion message inherit the owner overlay state',async()=>{
 const f=fixture();await f.invoke({type:'occlusion',active:true});await f.show();assert.equal(f.first.win.contentView.children.length,0);
 await f.show('page-two');assert.equal(f.first.win.contentView.children.length,0);
 await f.invoke({type:'occlusion',active:false});assert.equal(f.first.win.contentView.children.length,2);
});

test('a trusted page click allows one popup while native windows remain denied',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;
 wc.emit('before-mouse-event',{preventDefault(){}},{type:'mouseDown',button:'left',x:10,y:10});
 const details={url:'https://example.test/popup',frameName:'',features:'',disposition:'new-window',referrer:{url:'https://example.test/'}};
 assert.equal(wc.popup(details).action,'deny');assert.equal(f.sent.filter(value=>value.value.type==='popup').length,1);
 wc.popup(details);assert.equal(f.sent.filter(value=>value.value.type==='popup').length,1,'one gesture cannot authorize a popup flood');
});

test('downloads announce completion and remain owner-scoped explicit actions',async()=>{
 const f=fixture();await f.show();let destination;
 const item=Object.assign(new EventEmitter(),{getFilename:()=> 'browser-qa.txt',setSavePath:path=>{destination=path;}});
 f.profile.emit('will-download',{preventDefault(){}},item,f.views[0].webContents);
 assert.ok(destination);assert.match(destination,/browser-qa.*\.txt$/);assert.doesNotMatch(destination,/\.txt-.*\.txt$/);
 item.emit('done',{},'completed');
 const completion=f.sent.filter(value=>value.value.type==='state').at(-1).value.state;
 assert.ok(completion.notice);assert.ok(completion.download?.id);assert.equal(f.opened.length,0,'download never auto-opens');
 await f.invoke({type:'download',id:completion.download.id,action:'show'},f.owner().event);assert.equal(f.opened.length,0);
 await f.invoke({type:'download',id:completion.download.id,action:'show'});assert.equal(f.opened.length,1);assert.equal(f.opened[0].path,destination);
});

test('live browser view count is capped while visible views stay mounted',async()=>{
 const f=fixture();for(let index=0;index<8;index++){await f.show(`page-${index}`);await f.invoke({type:'hide',tabId:`page-${index}`});}
 assert.equal(f.views.filter(view=>!view.webContents.closed).length,6);
 assert.equal(f.views[0].webContents.closed,true);assert.equal(f.views[1].webContents.closed,true);
 await f.show('page-0');assert.equal(f.first.win.contentView.children.length,1);assert.equal(f.views.length,9);
});

test('idle unload after an aborted download reloads the committed page and observes a fresh load',async()=>{
 const f=fixture();await f.show();const old=f.views[0].webContents,url='https://example.test/last-page';
 old.url=url;old.getTitle=()=> 'Last page';old.emit('did-finish-load');
 old.emit('did-start-navigation',{isMainFrame:true,url:'https://example.test/download'},'https://example.test/download',false,true);
 old.emit('did-fail-load',{},-3,'ERR_ABORTED','https://example.test/download',true);old.emit('did-stop-loading');
 const retained=await f.invoke({type:'state',tabId:'page-one'});assert.equal(retained.url,url);assert.equal(retained.navigation,'load_observed');assert.equal(retained.documentGeneration,1);
 await f.invoke({type:'preferences',patch:{unloadAfterMinutes:1}});await f.invoke({type:'hide',tabId:'page-one'});f.advance(60_000);
 assert.equal(old.closed,true);assert.equal((await f.invoke({type:'state',tabId:'page-one'})).unloaded,true);assert.equal(f.timers.size,0);
 const showing=await f.show(),fresh=f.views.at(-1).webContents;
 assert.equal(f.views.length,2);assert.notEqual(fresh.id,old.id);assert.equal(fresh.loads[0],url,'recreation loads the committed page, never the download or initial prop URL');
 assert.equal(showing.navigation,'pending');assert.equal(showing.loading,true);assert.equal(showing.unloaded,undefined);assert.equal(showing.title,'Last page');
 assert.equal(f.first.win.contentView.children[0].webContents,fresh);
 fresh.emit('did-start-navigation',{isMainFrame:true,url},url,false,true);fresh.emit('did-finish-load');
 const loaded=await f.invoke({type:'state',tabId:'page-one'});assert.equal(loaded.url,url);assert.equal(loaded.navigation,'load_observed');assert.equal(loaded.documentGeneration,2);assert.equal(loaded.loading,false);
 await f.show();assert.equal(f.views.length,2);assert.equal(fresh.loads.length,1,'showing a live view does not reload it');
});

test('unloading before a cancelled navigation stops still saves the current document',async()=>{
 const f=fixture();await f.show();const old=f.views[0].webContents,url='https://example.test/current';old.url=url;old.emit('did-finish-load');
 old.emit('did-start-navigation',{isMainFrame:true,url:`${url}/download`},`${url}/download`,false,true);
 await f.invoke({type:'preferences',patch:{unloadAfterMinutes:1}});await f.invoke({type:'hide',tabId:'page-one'});f.advance(60_000);
 assert.equal((await f.invoke({type:'state',tabId:'page-one'})).url,url,'unload takes its URL from the current document even without did-stop-loading');
 await f.show();assert.equal(f.views.at(-1).webContents.loads[0],url);
});

test('aborted load promises keep the document while real load failures remain visible',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents,url='https://example.test/';wc.emit('did-finish-load');
 f.setLoad(async()=>{throw Object.assign(Error('download aborted'),{code:'ERR_ABORTED',errno:-3});});
 await f.invoke({type:'navigate',tabId:'page-one',url:`${url}download`});await new Promise(resolve=>setImmediate(resolve));
 wc.emit('did-start-navigation',{isMainFrame:true,url:`${url}download`},`${url}download`,false,true);wc.emit('did-fail-load',{},-3,'ERR_ABORTED',`${url}download`,true);wc.emit('did-stop-loading');
 const retained=await f.invoke({type:'state',tabId:'page-one'});assert.equal(retained.url,url);assert.equal(retained.issue,undefined);assert.equal(retained.navigation,'load_observed');
 f.setLoad(async()=>{throw Object.assign(Error('connection refused'),{code:'ERR_CONNECTION_REFUSED'});});
 await f.invoke({type:'navigate',tabId:'page-one',url:`${url}unavailable`});await new Promise(resolve=>setImmediate(resolve));
 wc.emit('did-fail-load',{},-102,'ERR_CONNECTION_REFUSED',`${url}unavailable`,true);wc.emit('did-stop-loading');
 const failed=await f.invoke({type:'state',tabId:'page-one'});assert.equal(failed.navigation,'failed');assert.equal(failed.url,`${url}unavailable`);assert.match(failed.issue,/ERR_CONNECTION_REFUSED/);
});

test('every LRU eviction victim reloads its saved page when shown',async()=>{
 const f=fixture();await f.invoke({type:'preferences',patch:{unloadAfterMinutes:0}});
 for(let index=0;index<8;index++){
  const tabId=`page-${index}`,url=`https://example.test/saved-${index}`;await f.show(tabId);const wc=f.views.at(-1).webContents;
  wc.url=url;wc.emit('did-finish-load');wc.emit('did-start-navigation',{isMainFrame:true,url:`${url}/download`},`${url}/download`,false,true);
  wc.emit('did-fail-load',{},-3,'ERR_ABORTED',`${url}/download`,true);wc.emit('did-stop-loading');await f.invoke({type:'hide',tabId});f.advance(1);
 }
 for(let index=0;index<2;index++){
  const tabId=`page-${index}`,url=`https://example.test/saved-${index}`;assert.equal((await f.invoke({type:'state',tabId})).unloaded,true);
  const showing=await f.show(tabId),fresh=f.views.at(-1).webContents;assert.equal(showing.navigation,'pending');assert.equal(fresh.loads[0],url);assert.equal(f.views.filter(view=>!view.webContents.closed).length,6);
  fresh.emit('did-finish-load');const loaded=await f.invoke({type:'state',tabId});assert.equal(loaded.navigation,'load_observed');assert.equal(loaded.url,url);assert.equal(loaded.documentGeneration,2);
  await f.invoke({type:'hide',tabId});f.advance(1);
 }
 assert.equal(f.timers.size,0,'LRU recovery adds no idle timer when unloading is disabled');
});

test('a retained tab can bind a newly mounted placeholder without losing its page',async()=>{
 const f=fixture();await f.show();await f.invoke({type:'hide',tabId:'page-one'});
 await f.invoke({type:'show',tabId:'page-one',url:'https://example.test/',frameName:'tt-preview-remounted',bounds:{x:20,y:80,width:400,height:600}});
 assert.equal(f.views.length,1);assert.equal(f.first.win.contentView.children.length,1);
});

test('app focus moves only inside an already-focused window and page typing remains untouched',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;
 let prevented=false;const event={preventDefault(){prevented=true;}};
 wc.emit('before-input-event',event,{type:'keyDown',key:'g',code:'KeyG',control:true,meta:false,shift:false,alt:false});assert.equal(prevented,false,'Ctrl+G belongs to the page');
 f.first.win.isFocused=()=>false;
 await f.invoke({type:'occlusion',active:true});assert.equal(f.first.wc.focused,undefined,'a background window must not steal OS focus');
});

test('each page captures while attached and detaches only after its replacement image is ready',async()=>{
 const f=fixture();await f.show();await f.show('page-two');const finishes=[];
 f.setCapture((_rect,options)=>{assert.equal(options.stayHidden,true);assert.equal(options.stayAwake,true);assert.equal(f.first.win.contentView.children.length,2,'capture precedes every detach');return new Promise(resolve=>finishes.push(resolve));});
 const pending=f.invoke({type:'occlusion',active:true});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.first.win.contentView.children.length,2);assert.equal(finishes.length,2);
 for(const finish of finishes)finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c25hcHNob3Q='});await pending;
 for(const tabId of ['page-one','page-two']){
  const snapshot=await f.invoke({type:'state',tabId});assert.ok(snapshot.snapshot);assert.ok(snapshot.snapshotGeneration);
  assert.ok(f.sent.some(event=>event.value.state?.tabId===tabId&&event.value.state?.snapshotGeneration===snapshot.snapshotGeneration),'snapshot was published before readiness');
  await f.invoke({type:'snapshotReady',tabId,generation:snapshot.snapshotGeneration});
  assert.equal(f.first.win.contentView.children.length,tabId==='page-one'?1:0,'readiness is per page');
 }
 await f.invoke({type:'occlusion',active:false});assert.equal(f.first.win.contentView.children.length,2);
 assert.equal((await f.invoke({type:'state',tabId:'page-one'})).snapshot,undefined);
});

test('overlap rechecks cannot restart an in-flight capture or detach before image readiness',async()=>{
 const f=fixture();await f.show();let finish,captures=0;
 f.setCapture(()=>{captures++;return new Promise(resolve=>{finish=resolve;});});
 const pending=f.invoke({type:'occlusion',active:true});await new Promise(resolve=>setImmediate(resolve));
 await f.invoke({type:'occlusion',active:true});await f.show();
 await f.invoke({type:'bounds',tabId:'page-one',bounds:{x:25,y:85,width:400,height:600}});
 assert.equal(captures,1);assert.equal(f.first.win.contentView.children.length,1);
 finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c25hcHNob3Q='});await pending;
 const snapshot=await f.invoke({type:'state',tabId:'page-one'});
 await f.invoke({type:'occlusion',active:true});assert.equal(captures,1,'recheck also retains a ready snapshot');
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:snapshot.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,0);
});

test('obsolete or foreign image readiness cannot detach a restored or newly captured page',async()=>{
 const f=fixture();await f.show();await f.invoke({type:'occlusion',active:true});
 const old=await f.invoke({type:'state',tabId:'page-one'});
 await assert.rejects(f.invoke({type:'snapshotReady',tabId:'page-one',generation:old.snapshotGeneration},f.owner().event),/Unknown/);
 await f.invoke({type:'occlusion',active:false});await f.invoke({type:'snapshotReady',tabId:'page-one',generation:old.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,1);
 await f.invoke({type:'occlusion',active:true});const current=await f.invoke({type:'state',tabId:'page-one'});assert.notEqual(current.snapshotGeneration,old.snapshotGeneration);
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:old.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,1);
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:current.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,0);
 await f.invoke({type:'hide',tabId:'page-one'});await f.show();
 await f.invoke({type:'occlusion',active:false});await f.invoke({type:'snapshotReady',tabId:'page-one',generation:current.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,1);
});

test('a dismissed passive capture cannot overwrite a newer overlapping capture',async()=>{
 const f=fixture();await f.show();const finishes=[];
 f.setCapture(()=>new Promise(resolve=>finishes.push(resolve)));
 const old=f.invoke({type:'occlusion',active:true});await new Promise(resolve=>setImmediate(resolve));
 await f.invoke({type:'occlusion',active:false});
 const current=f.invoke({type:'occlusion',active:true});await new Promise(resolve=>setImmediate(resolve));
 finishes[1]({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,bmV3'});await current;
 const snapshot=await f.invoke({type:'state',tabId:'page-one'});assert.equal(snapshot.snapshot,'data:image/png;base64,bmV3');
 await f.invoke({type:'snapshotReady',tabId:'page-one',generation:snapshot.snapshotGeneration});assert.equal(f.first.win.contentView.children.length,0);
 finishes[0]({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,b2xk'});await old;
 const after=await f.invoke({type:'state',tabId:'page-one'});assert.equal(after.snapshot,snapshot.snapshot);assert.equal(after.snapshotGeneration,snapshot.snapshotGeneration);
 await f.invoke({type:'occlusion',active:false});assert.equal(f.first.win.contentView.children.length,1);
});

test('capture failure or an empty bitmap leaves the live page attached and reports the failure',async()=>{
 for(const capture of [async()=>{throw Error('capture failed');},async()=>({isEmpty:()=>true})]){
  const f=fixture();await f.show();f.setCapture(capture);await f.invoke({type:'occlusion',active:true});
  const state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.snapshot,undefined);assert.match(state.issue,/Could not capture/);assert.equal(f.first.win.contentView.children.length,1);
  await f.invoke({type:'snapshotReady',tabId:'page-one',generation:1});assert.equal(f.first.win.contentView.children.length,1,'no image means no detach');
 }
});

test('browser preferences survive module restart and reject invalid values',async()=>{
 const files=new Map(),first=fixture(files);await first.invoke({type:'preferences',patch:{unloadAfterMinutes:7,linkTarget:'system'}});
 const second=fixture(files),preferences=await second.invoke({type:'preferences'});assert.equal(preferences.unloadAfterMinutes,7);assert.equal(preferences.linkTarget,'system');
 for(const patch of [{unloadAfterMinutes:-1},{unloadAfterMinutes:1.5},{linkTarget:'unsafe'}])await assert.rejects(second.invoke({type:'preferences',patch}),/Invalid/);
});


test('Find starts a new Electron search, continues in either direction, and ignores obsolete results',async()=>{
 const f=fixture();await f.show();const wc=f.views[0].webContents;
 await f.invoke({type:'find',tabId:'page-one',text:'needle'});
 const first=wc.lastFind.requestId;
 assert.equal(wc.lastFind.options.findNext,true,'Electron 44 uses true to begin a search session');
 wc.emit('found-in-page',{}, {requestId:first,activeMatchOrdinal:1,matches:2});
 let state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find.matches,2);assert.equal(state.find.activeMatchOrdinal,1);
 for(const forward of [true,false]){
  await f.invoke({type:'find',tabId:'page-one',text:'needle',forward,findNext:true});
  assert.equal(wc.lastFind.options.findNext,false,'next/previous continue the existing Electron search');assert.equal(wc.lastFind.options.forward,forward);
  wc.emit('found-in-page',{}, {requestId:wc.lastFind.requestId,activeMatchOrdinal:forward?2:1,matches:2});
  state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find.matches,2);assert.equal(state.find.activeMatchOrdinal,forward?2:1);
 }
 await f.invoke({type:'find',tabId:'page-one',text:'different'});
 const latest=wc.lastFind.requestId;assert.equal(wc.lastFind.options.findNext,true);
 wc.emit('found-in-page',{}, {requestId:first,activeMatchOrdinal:1,matches:99});
 state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find.matches,0,'older search must not replace the current count');
 wc.emit('found-in-page',{}, {requestId:latest,activeMatchOrdinal:1,matches:3});
 state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find.matches,3);
 await f.invoke({type:'find',tabId:'page-one',text:''});
 wc.emit('found-in-page',{}, {requestId:latest,activeMatchOrdinal:1,matches:3});
 state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find.matches,0,'clearing invalidates pending results');
 await f.invoke({type:'stopFind',tabId:'page-one'});
 wc.emit('found-in-page',{}, {requestId:latest,activeMatchOrdinal:1,matches:3});
 state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find,undefined,'closing Find cannot resurrect its count');
 await f.invoke({type:'find',tabId:'page-one',text:'needle'});const navigating=wc.lastFind.requestId;
 wc.emit('did-start-navigation',{isMainFrame:true,url:'https://example.test/other'},'https://example.test/other',false,true);
 wc.emit('found-in-page',{}, {requestId:navigating,activeMatchOrdinal:1,matches:2});
 state=await f.invoke({type:'state',tabId:'page-one'});assert.equal(state.find,undefined,'navigation invalidates the previous document search');
});

test('same-URL tabs have distinct native contents and retain ownership through hide and show',async()=>{
 const f=fixture();await f.show('owner-a');const first=f.views[0].webContents;
 await f.invoke({type:'hide',tabId:'owner-a'});await f.show('owner-b');const second=f.views[1].webContents;
 assert.notEqual(first.id,second.id);assert.equal(first.url,second.url);assert.equal(f.first.win.contentView.children.length,1);
 await f.invoke({type:'find',tabId:'owner-b',text:'owned'});
 second.emit('found-in-page',{}, {requestId:second.lastFind.requestId,activeMatchOrdinal:1,matches:2});
 assert.equal((await f.invoke({type:'state',tabId:'owner-a'})).find,undefined);
 assert.equal((await f.invoke({type:'state',tabId:'owner-b'})).find.matches,2);
 await f.invoke({type:'hide',tabId:'owner-b'});await f.show('owner-a');assert.equal(f.views.length,2);
 assert.equal(f.first.win.contentView.children[0].webContents,first);assert.equal(second.closed,undefined);
 await f.invoke({type:'close',tabId:'owner-b'});assert.equal(second.closed,true);assert.equal(first.closed,undefined);
});
