import { app, BrowserWindow, ipcMain, nativeImage, session, shell, WebContentsView, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isBrowserShareCommand, isBrowserStopAgentOperationCommand, sanitizeBrowserTitle } from '../../../renderer/src/browserTypes.js';
import type { BrowserBounds, BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from '../../../renderer/src/browserTypes.js';
import { browserDevtoolsShortcut } from '../../../renderer/src/browserDevtools.js';
import { allowedTopLevelUrl, defaultBrowserPreferences, expiredHidden, lruVictims, normalizeBrowserUrl } from './policy.js';
import { captureNativePageShot, deletePageShots, nativePageClosed, nativePageRegistered } from '../pageComments.js';
import { MAX_PAGE_SHOT_BYTES, pageImageSize, pageShotPath, validPageShotId } from '../pageCommentsCore.js';
import { appendConsoleEntry, consoleCounts, createConsoleRing, formatConsolePageData } from './consoleHandoff.js';
import type { BrowserConsoleEntry, BrowserHandoffCommand, BrowserHandoffEvent, BrowserHandoffResult } from './handoffTypes.js';
import { BrowserAgentController, type BrowserAgentRuntime } from './agentController.js';
import { faviconRequestCurrent, fetchFavicon, settleFavicon } from './favicon.js';

type DevtoolsPanel = 'console'|'network'|'elements';
type Devtools = { view:WebContentsView; bounds?:BrowserBounds; ready:boolean; panel?:DevtoolsPanel; inspectMode:boolean };
type Tab = { preparing?:Promise<void>; partition:string; id:string; owner:WebContents; window:BrowserWindow; url:string; title:string; frameName:string; view?:WebContentsView; bounds?:BrowserBounds; radius:number; devtools?:Devtools; devtoolsWanted:boolean; devtoolsStopped?:number; devtoolsBounds?:BrowserBounds; devtoolsSnapshot?:string; contextPoint?:{x:number;y:number}; visible:boolean; shownAt:number; hiddenAt?:number; loading:boolean; documentGeneration:number; navigationEpoch:number; viewGeneration:number; navigation:BrowserState['navigation']; issue?:string; snapshot?:string; zoom:number; find?:BrowserState['find']; findRequestId?:number; origin?:string; favicon?:string; faviconRequest?:number; faviconAbort?:AbortController; downloads:Map<string,string>; leases:number; download?:{id:string;name:string}; notice?:string; gestureUntil:number; occlusionGeneration:number; contextSequence:number; console:ReturnType<typeof createConsoleRing>; consoleCounts:{errors:number;warnings:number}; consoleUrl?:string; consoleStatus:'pending'|'committed'|'failed'; handoffs:Map<string,{path:string;epoch:number;generation:number;viewGeneration:number;origin?:string;url:string;currentUrl:string}> };
const tabs = new Map<string, Tab>();
const faviconCache = new Map<string,string>();
const FAVICON_CACHE_LIMIT=256;
const agentControllers = new Map<WebContents, BrowserAgentController>();
let nativeViewGeneration = 0;
const devtoolsStoppedIssue='Developer tools stopped. Reload the page to open them again.';
let runtimeForBrowser: ((event:IpcMainInvokeEvent)=>BrowserAgentRuntime) | undefined;
const ownerOccluded = new WeakMap<WebContents, boolean>();
const trustedOwners=new Set<WebContents>();
let preferences: BrowserPreferences = { ...defaultBrowserPreferences };
let devServerOffers=true;
let hiddenTimer: ReturnType<typeof setInterval> | undefined;
let profile: Electron.Session | undefined;
const browserProfile = (partition='persist:threadterm-browser'): Electron.Session => partition==='persist:threadterm-browser' ? profile ??= session.fromPartition(partition) : session.fromPartition(partition);
const configuredProfiles = new WeakSet<Electron.Session>();
type MachineBrowserOptions = { partitionFor:(owner:WebContents)=>string; prepare:(event:IpcMainInvokeEvent)=>Promise<void>; released:(partition:string)=>void; windowFor:(owner:WebContents)=>BrowserWindow };
let machineBrowserOptions: MachineBrowserOptions | undefined;

function validBounds(value: unknown): value is BrowserBounds { return !!value && typeof value === 'object' && ['x','y','width','height'].every(key => Number.isFinite((value as Record<string,unknown>)[key])) && (value as BrowserBounds).width >= 0 && (value as BrowserBounds).height >= 0; }
function validFrameName(value: unknown): value is string { return typeof value === 'string' && /^tt-preview-[a-z0-9-]{8,64}$/.test(value); }
function nativeActionsAvailable():boolean { return Boolean(runtimeForBrowser&&process.platform==='win32'&&process.versions?.electron==='44.3.0'); }
function state(tab: Tab): BrowserState { const wc=tab.view?.webContents; return { tabId:tab.id,sharing:agentControllers.get(tab.owner)?.state(tab.id)??{level:'off',status:'idle',grantEpoch:0,viewGeneration:tab.viewGeneration,navigationEpoch:tab.navigationEpoch,reading:false,controlAvailable:nativeActionsAvailable()},url:tab.url,title:tab.title,loading:tab.loading,canGoBack:wc?.navigationHistory.canGoBack()??false,canGoForward:wc?.navigationHistory.canGoForward()??false,zoom:tab.zoom,documentGeneration:tab.documentGeneration,navigation:tab.navigation,devtools:{open:tab.devtoolsWanted,...(tab.leases&&tab.devtoolsSnapshot?{snapshot:tab.devtoolsSnapshot,snapshotGeneration:tab.occlusionGeneration}:{})},...(tab.favicon?{favicon:tab.favicon}:{}),...(tab.issue?{issue:tab.issue}:{}),...(tab.snapshot?{snapshot:tab.snapshot,snapshotGeneration:tab.occlusionGeneration}:{}),...(tab.view?{}:{unloaded:true}),...(tab.find?{find:tab.find}:{}),...(tab.notice?{notice:tab.notice}:{}),...(tab.download?{download:tab.download}:{}) }; }
function emit(tab: Tab): void { if (!tab.owner.isDestroyed()) tab.owner.send('threadterm:browser-event', { type:'state', state:state(tab) } satisfies BrowserEvent); }
function setIssue(tab: Tab, issue?: string): void { tab.issue=issue; emit(tab); }
function pageOrigin(url: string): string | undefined { try { const parsed=new URL(url); return /^https?:$/.test(parsed.protocol) || parsed.protocol==='blob:'&&/^https?:/.test(parsed.origin) ? parsed.origin : undefined; } catch { return undefined; } }
// Only completed captures current at the previous epoch follow a same-document event. Mutating their epoch/current URL
// keeps an asynchronous save's current() closure valid without changing the capture URL; a cross-document-invalidated
// capture is already behind the previous epoch, so later in-page events cannot revive it.
function advanceSameDocumentHandoffs(tab:Tab,url:string,previousEpoch:number):void { const origin=pageOrigin(url);if(!origin)return;for(const handoff of tab.handoffs.values())if(handoff.epoch===previousEpoch&&handoff.generation===tab.documentGeneration&&handoff.viewGeneration===tab.viewGeneration&&handoff.currentUrl===tab.url&&handoff.origin===origin){handoff.epoch=tab.navigationEpoch;handoff.currentUrl=url;} }
async function updateFavicon(tab:Tab,wc:WebContents,candidates:string[]):Promise<void> {
  tab.faviconAbort?.abort();const controller=new AbortController();tab.faviconAbort=controller;const epoch=tab.navigationEpoch,origin=pageOrigin(tab.url),cacheKey=tab.partition==='persist:threadterm-browser'?origin:`${tab.partition}:${origin}`,request=tab.faviconRequest=(tab.faviconRequest??0)+1;
  const current=()=>!controller.signal.aborted&&tabs.get(tab.id)===tab&&tab.view?.webContents===wc&&!wc.isDestroyed()&&tab.navigationEpoch===epoch&&faviconRequestCurrent(tab.faviconRequest,request);
  try { if(!origin)return;const cached=faviconCache.get(cacheKey!);if(cached&&current()){tab.favicon=cached;emit(tab);return;}await settleFavicon(candidates,candidate=>fetchFavicon(candidate,(target,options)=>browserProfile(tab.partition).fetch(target,options),bytes=>nativeImage.createFromBuffer(bytes),current,controller.signal),current,favicon=>{const victim=faviconCache.keys().next().value;if(!faviconCache.has(cacheKey!)&&faviconCache.size>=FAVICON_CACHE_LIMIT&&victim)faviconCache.delete(victim);faviconCache.set(cacheKey!,favicon);tab.favicon=favicon;emit(tab);}); }
  finally { if(tab.faviconAbort===controller)tab.faviconAbort=undefined; }
}
function allowedFor(tab:Tab, url:string):boolean { const appOrigin=pageOrigin(tab.owner.getURL()), candidate=pageOrigin(url); return allowedTopLevelUrl(url,tab.origin) && !(appOrigin && candidate === appOrigin); }
function preferencePath():string { return join(app.getPath('userData'),'browser-preferences.json'); }
function loadPreferences():void { try { const value=JSON.parse(readFileSync(preferencePath(),'utf8')) as Partial<BrowserPreferences>&{devServerOffers?:unknown}; if(Number.isInteger(value.unloadAfterMinutes)&&value.unloadAfterMinutes!>=0&&value.unloadAfterMinutes!<=1440&&(value.linkTarget==='builtin'||value.linkTarget==='system')) preferences={unloadAfterMinutes:value.unloadAfterMinutes!,linkTarget:value.linkTarget}; if(typeof value.devServerOffers==='boolean')devServerOffers=value.devServerOffers; } catch { /* First run or corrupt browser-only preferences: use safe defaults. */ } }
function savePreferences():void { const file=preferencePath(), temporary=`${file}.${randomUUID()}.tmp`; mkdirSync(join(app.getPath('userData')),{recursive:true}); writeFileSync(temporary,JSON.stringify({...preferences,devServerOffers}),'utf8'); renameSync(temporary,file); }
function configureProfile(browser = browserProfile()): void {
  if(configuredProfiles.has(browser))return;
  configuredProfiles.add(browser);
  browser.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  browser.setPermissionCheckHandler(() => false);
  browser.setCertificateVerifyProc((_request, done) => done(-3)); // Chromium's normal verification; never bypass
  browser.on('will-download', (_event, item, contents) => {
    const owner = [...tabs.values()].find(tab => tab.view?.webContents === contents);
    if(!owner){_event.preventDefault();return;}
    const raw=basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download', extension=extname(raw), stem=raw.slice(0, raw.length-extension.length);
    const name=`${stem.slice(0, Math.max(1, 180-extension.length))}-${randomUUID()}${extension}`;
    const path=join(app.getPath('downloads'), name); item.setSavePath(path);
    const id=randomUUID();
    item.once('done', (_done, status) => { if (status === 'completed') { owner.downloads.set(id,path); owner.download={id,name}; owner.notice=`Downloaded ${name}`; emit(owner); } });
  });
}
function makeView(tab: Tab): WebContentsView {
  const view=new WebContentsView({ webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true, preload:undefined, partition:tab.partition } });
  tab.view=view;tab.viewGeneration=++nativeViewGeneration;
  const wc=view.webContents;
  // A hidden page may replace its History state to save scroll position. Wait for
  // native commit evidence before treating an exact-same-URL event as navigation.
  // Index/length alone are insufficient (traversal and a full history can keep both).
  const historyPosition=()=>{try{return {index:wc.navigationHistory.getActiveIndex(),length:wc.navigationHistory.length()};}catch{return undefined;}};
  let settledHistory: ReturnType<typeof historyPosition>;
  let historyUpdate: {url:string;documentGeneration:number;epoch:number;index:number;length:number;replacement?:boolean;timer?:ReturnType<typeof setTimeout>}|undefined;
  const clearHistoryUpdate=()=>{const pending=historyUpdate;historyUpdate=undefined;if(pending?.timer)clearTimeout(pending.timer);return pending;};
  const beginNavigation=(address:string,crossDocument:boolean)=>{
    const previousEpoch=tab.navigationEpoch;
    agentControllers.get(tab.owner)?.navigationStarted(tab.id,address);tab.navigationEpoch++;if(!crossDocument)advanceSameDocumentHandoffs(tab,address,previousEpoch);tab.contextPoint=undefined;if(crossDocument){tab.faviconAbort?.abort();tab.faviconAbort=undefined;tab.consoleStatus='pending';tab.favicon=undefined;tab.faviconRequest=(tab.faviconRequest??0)+1;} tab.findRequestId=undefined; tab.find=undefined; tab.issue=tab.devtoolsStopped!==undefined?devtoolsStoppedIssue:undefined;tab.loading=true;tab.navigation='pending';tab.url=address;tab.origin=pageOrigin(address);emit(tab);
  };
  // Supplemental native Electron event, intentionally outside its public typings.
  // Absence on a future version falls back to navigation; it never grants access.
  const navigationEvents: NodeJS.EventEmitter=wc;
  navigationEvents.on('navigation-entry-committed', (_event:Electron.Event,url:string,sameDocument:boolean,replaced:boolean) => {
    const pending=historyUpdate;
    if(!pending)return;
    if(pending.replacement===undefined&&sameDocument===true&&replaced===true&&url===pending.url){pending.replacement=true;return;}
    clearHistoryUpdate();if(tab.view?.webContents===wc)beginNavigation(url,sameDocument!==true);
  });
  wc.once('destroyed',clearHistoryUpdate);
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('devtools-opened',()=>{const devtools=tab.devtools;if(tab.view?.webContents!==wc||!devtools)return;devtools.ready=true;selectDevtoolsPanel(tab,devtools);attachDevtools(tab);emit(tab);});
  wc.on('devtools-closed',()=>{if(tab.view?.webContents===wc&&tab.devtools)devtoolsStopped(tab,tab.devtools);});
  wc.on('devtools-open-url',(event,url)=>{event.preventDefault();if(tab.view?.webContents!==wc||tab.owner.isDestroyed())return;const normalized=normalizeBrowserUrl(url);if(normalized.url&&/^https?:/.test(normalized.url)&&allowedFor(tab,normalized.url))tab.owner.send('threadterm:browser-event',{type:'popup',openerId:tab.id,tabId:randomUUID(),url:normalized.url} satisfies BrowserEvent);});
  wc.on('render-process-gone',()=>{clearHistoryUpdate();if(tab.view?.webContents!==wc)return;tab.loading=false;tab.navigation='failed';agentControllers.get(tab.owner)?.invalidate(tab.id,'Sharing stopped — the page process exited.');emit(tab);});
  wc.setWindowOpenHandler(details => {
    const normalized=normalizeBrowserUrl(details.url);
    if (Date.now()>tab.gestureUntil || !normalized.url || !allowedFor(tab, normalized.url)) { setIssue(tab, normalized.issue ?? 'Blocked an unsolicited popup.'); return { action:'deny' }; }
    tab.gestureUntil=0;
    // One recent native input gesture authorizes one app tab; native windows remain denied.
    const id=randomUUID();
    tab.owner.send('threadterm:browser-event', {type:'popup',openerId:tab.id,tabId:id,url:normalized.url} satisfies BrowserEvent);
    return { action:'deny' };
  });
  wc.on('certificate-error', (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  const guardNavigation=(event:Electron.Event,url:string) => { agentControllers.get(tab.owner)?.navigationStarted(tab.id,url);if (!allowedFor(tab,url)) { event.preventDefault(); setIssue(tab, `Blocked navigation to ${safeScheme(url)}.`); } };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-frame-navigate', details => { if(details.isMainFrame)guardNavigation(details,details.url); });
  wc.on('will-redirect', (details,url,_inPage,isMainFrame) => { if(isMainFrame)guardNavigation(details,url); });
  // Screenshot epochs change at navigation start; console ownership changes only at commit.
  // The outgoing document can keep logging while a new response is still pending.
  wc.on('did-start-navigation', (details, url, sameDocument, isMainFrame) => {
    const interrupted=clearHistoryUpdate();
    if(interrupted&&tab.view?.webContents===wc)beginNavigation(interrupted.url,false);
    if (tab.view?.webContents!==wc||!(details.isMainFrame??isMainFrame)) return;
    const address=details.url??url,crossDocument=!(details.isSameDocument??sameDocument);
    const position=!interrupted&&!crossDocument&&address===tab.url&&wc.getURL()===address&&!tab.loading&&tab.navigation==='load_observed'?historyPosition():undefined;
    if(position&&Number.isSafeInteger(position.index)&&position.index>=0&&position.length>position.index&&position.index===settledHistory?.index&&position.length===settledHistory?.length){
      const pending: NonNullable<typeof historyUpdate>={url:address,documentGeneration:tab.documentGeneration,epoch:tab.navigationEpoch,...position};historyUpdate=pending;
      pending.timer=setTimeout(()=>{if(historyUpdate!==pending)return;clearHistoryUpdate();if(tab.view?.webContents===wc&&!wc.isDestroyed())beginNavigation(pending.url,false);},0);
      return;
    }
    beginNavigation(address,crossDocument);
  });
  wc.on('did-navigate', (_event,url) => {
    const pending=clearHistoryUpdate();
    if(tab.view?.webContents!==wc)return;
    if(pending)beginNavigation(url,true);
    tab.console=createConsoleRing();tab.consoleCounts={errors:0,warnings:0};tab.consoleUrl=url;tab.consoleStatus='committed';
    if(!tab.owner.isDestroyed())tab.owner.send('threadterm:browser-handoff-event',{type:'console',tabId:tab.id,documentGeneration:tab.documentGeneration,errors:0,warnings:0} satisfies BrowserHandoffEvent);
  });
  wc.on('did-navigate-in-page', (_event,url,isMainFrame) => {
    const pending=clearHistoryUpdate();
    if(tab.view?.webContents!==wc)return;
    if(!isMainFrame){if(pending)beginNavigation(pending.url,false);return;}
    const position=historyPosition();settledHistory=position;
    // This supplemental event is verified on pinned Electron 44.3.0. If it is
    // missing or inconsistent, keep the normal navigation/authority invalidation.
    if(pending?.replacement&&url===pending.url&&tab.url===url&&wc.getURL()===url&&tab.documentGeneration===pending.documentGeneration&&tab.navigationEpoch===pending.epoch&&!tab.loading&&tab.navigation==='load_observed'&&position?.index===pending.index&&position?.length===pending.length)return;
    const previousEpoch=tab.navigationEpoch;agentControllers.get(tab.owner)?.navigationStarted(tab.id,url);tab.navigationEpoch++;advanceSameDocumentHandoffs(tab,url,previousEpoch);tab.contextPoint=undefined;tab.findRequestId=undefined;tab.find=undefined;tab.loading=false;tab.navigation='load_observed';tab.url=url;tab.origin=pageOrigin(url);if(tab.consoleUrl&&tab.consoleStatus!=='failed')tab.consoleUrl=url;emit(tab);
  });
  wc.on('did-finish-load', () => { const pending=clearHistoryUpdate();if(tab.view?.webContents!==wc||tab.navigation==='failed')return;if(pending)beginNavigation(wc.getURL(),true);settledHistory=historyPosition();if(tab.devtoolsStopped!==undefined&&tab.devtoolsStopped!==tab.viewGeneration){tab.devtoolsStopped=undefined;if(tab.issue===devtoolsStoppedIssue)tab.issue=undefined;}tab.loading=false; tab.url=wc.getURL(); tab.title=sanitizeBrowserTitle(wc.getTitle()); tab.origin=pageOrigin(tab.url); tab.documentGeneration++; tab.navigation='load_observed'; emit(tab); });
  wc.on('console-message', (details, legacyLevel, legacyMessage, legacyLine, legacySourceId) => { if(tab.view?.webContents!==wc)return;const event=details as unknown as {level?:unknown;message?:unknown;line?:unknown;lineNumber?:unknown;sourceId?:unknown},level=event.level??legacyLevel,message=event.message??legacyMessage,line=event.lineNumber??event.line??legacyLine,sourceId=event.sourceId??legacySourceId; const entry:BrowserConsoleEntry={level:typeof level==='number'?['verbose','info','warning','error'][level]??String(level):String(level),text:typeof message==='string'?message:'',sourceUrl:typeof sourceId==='string'?sourceId:'',line:typeof line==='number'&&Number.isSafeInteger(line)&&line>=0?line:0}; appendConsoleEntry(tab.console,entry);const counts=consoleCounts(tab.console.entries);if(counts.errors!==tab.consoleCounts.errors||counts.warnings!==tab.consoleCounts.warnings){tab.consoleCounts=counts;if(!tab.owner.isDestroyed())tab.owner.send('threadterm:browser-handoff-event',{type:'console',tabId:tab.id,documentGeneration:tab.documentGeneration,...counts} satisfies BrowserHandoffEvent);}});
  wc.on('did-fail-load', (_event, _code, description, url, isMainFrame) => { const pending=clearHistoryUpdate();if(pending&&tab.view?.webContents===wc)beginNavigation(pending.url,false);if (tab.view?.webContents!==wc||!isMainFrame||_code===-3) return; tab.consoleStatus='failed';tab.consoleUrl=undefined;tab.loading=false; tab.url=url || tab.url; tab.navigation='failed'; tab.issue=`Page failed to load: ${description}`; emit(tab); });
  wc.on('page-title-updated', (_event, title) => { tab.title=sanitizeBrowserTitle(title); emit(tab); });
  wc.on('page-favicon-updated', (_event, candidates) => { void updateFavicon(tab,wc,candidates); });
  wc.on('did-stop-loading', () => {
    if(tab.view?.webContents!==wc)return;
    tab.loading=false;
    // A download/cancel can start a navigation without replacing the document.
    // Retain Chromium's current page, not the attempted URL, for unload/restore.
    const url=wc.getURL();if(tab.consoleStatus==='pending'&&tab.consoleUrl===url)tab.consoleStatus='committed';if(tab.navigation==='pending'&&tab.documentGeneration>0&&url){tab.url=url;tab.origin=pageOrigin(url);tab.navigation='load_observed';}
    emit(tab);
  });
  wc.on('found-in-page', (_event, result) => { if(result.requestId!==tab.findRequestId)return; tab.find={activeMatchOrdinal:result.activeMatchOrdinal,matches:result.matches}; emit(tab); });
  wc.on('before-input-event', (event, input) => {
    if(tab.view?.webContents!==wc)return;
    if(input.type==='keyDown') tab.gestureUntil=Date.now()+1000;
    if(input.type==='keyDown'&&handleDevtoolsShortcut(tab,event,input))return;
    const control=input.control || input.meta, key=input.key.toLowerCase();
    if(input.type==='keyDown'&&input.key==='Escape'&&tab.find){event.preventDefault();if(tab.window.isFocused())tab.owner.focus();tab.owner.send('threadterm:browser-event',{type:'shortcut',tabId:tab.id,key:input.key,code:input.code,control:input.control,meta:input.meta,shift:input.shift,alt:input.alt} satisfies BrowserEvent);return;}
    const appShortcut=control&&!input.alt&&((!input.shift&&['f','p','b','k','l','t','-','0','='].includes(key))||(input.shift&&['e','f','g','k','+','='].includes(key)));
    const modifierRelease=input.type==='keyUp'&&['Control','Meta'].includes(input.key);
    if(!modifierRelease&&(input.type!=='keyDown'||!control))return;
    if(appShortcut){event.preventDefault();if(tab.window.isFocused())tab.owner.focus();}
    if(!tab.owner.isDestroyed())tab.owner.send('threadterm:browser-event',{type:'shortcut',phase:modifierRelease?'keyup':'keydown',tabId:tab.id,key:input.key,code:input.code,control:input.control,meta:input.meta,shift:input.shift,alt:input.alt} satisfies BrowserEvent);
  });
  wc.on('before-mouse-event', (_event, mouse) => { if(mouse.type==='mouseDown')tab.gestureUntil=Date.now()+1000; });
  wc.on('context-menu', (_event, params) => {if(tab.view?.webContents!==wc)return;tab.contextPoint={x:params.x,y:params.y};void nativeContext(tab, params.x, params.y).catch(()=>undefined);});
  nativePageRegistered(tab.owner, tab.frameName, wc, () => tab.bounds);
  wc.setZoomFactor(tab.zoom);
  tab.loading=true;tab.navigation='pending';tab.consoleStatus='pending';tab.issue=tab.devtoolsStopped!==undefined?devtoolsStoppedIssue:undefined;
  void wc.loadURL(tab.url).catch(error => { if(tab.view?.webContents===wc&&error.code!=='ERR_ABORTED')setIssue(tab, `Page failed to load: ${String(error)}`); });
  return view;
}
function safeScheme(url:string):string { try{return new URL(url).protocol;}catch{return 'an invalid address';} }
async function nativeContext(tab:Tab,x:number,y:number):Promise<void> {
  const wc=tab.view?.webContents; if (!wc || !tab.bounds) return;
  const sequence=++tab.contextSequence,generation=tab.documentGeneration,url=wc.getURL(),current=()=>tab.visible&&tab.view?.webContents===wc&&!wc.isDestroyed()&&tab.contextSequence===sequence&&tab.documentGeneration===generation&&wc.getURL()===url;
  const zoom=wc.getZoomFactor(),appZoom=tab.owner.getZoomFactor();
  // Page-comment picker reads in an isolated world, never the page's main world.
  const { pagePickerSource } = await import('../pagePickerScript.js');
  const { sanitizePagePick } = await import('../pageCommentsCore.js');
  const pick=sanitizePagePick(await wc.executeJavaScriptInIsolatedWorld(999, [{code:pagePickerSource('at',undefined,undefined,{x:x/zoom,y:y/zoom})}], false));
  if(pick&&current()&&!tab.owner.isDestroyed()){const shot=await captureNativePageShot(wc,pick);if(!current()){if(shot)await deletePageShots([shot.id]);return;}tab.owner.send('threadterm:page-context-menu',{frameName:tab.frameName,x:tab.bounds.x+x/appZoom,y:tab.bounds.y+y/appZoom,pick:{...pick,...(shot?{shot}:{})},selectionText:''});}
}
function applyViewRadius(tab:Tab):void { const radius=Math.round(tab.radius*tab.owner.getZoomFactor());for(const view of [tab.view,tab.devtools?.view])if(view&&!view.webContents.isDestroyed())view.setBorderRadius(radius); }
function detachDevtools(tab:Tab):void { const view=tab.devtools?.view;if(view&&!tab.window.isDestroyed()&&appView(tab).children.includes(view))appView(tab).removeChildView(view); }
function attachDevtools(tab:Tab):void { const devtools=tab.devtools;if(!devtools||!tab.devtoolsWanted||!tab.visible||tab.leases||!devtools.bounds||tab.window.isDestroyed()||devtools.view.webContents.isDestroyed()){detachDevtools(tab);return;}const zoom=tab.owner.getZoomFactor(),bounds=devtools.bounds;applyViewRadius(tab);if(!appView(tab).children.includes(devtools.view))appView(tab).addChildView(devtools.view);devtools.view.setBounds({x:Math.round(bounds.x*zoom),y:Math.round(bounds.y*zoom),width:Math.round(bounds.width*zoom),height:Math.round(bounds.height*zoom)}); }
function setDevtoolsBounds(tab:Tab,bounds?:BrowserBounds):void { tab.devtoolsBounds=bounds;if(tab.devtools)tab.devtools.bounds=bounds;if(!bounds)detachDevtools(tab); }
function selectDevtoolsPanel(tab:Tab,devtools:Devtools):void {
  if(tab.devtools!==devtools||!tab.devtoolsWanted||!devtools.ready||devtools.view.webContents.isDestroyed())return;
  const panel=devtools.panel,inspectMode=devtools.inspectMode;devtools.panel=undefined;devtools.inspectMode=false;
  if(!panel&&!inspectMode)return;
  const show=panel?`typeof DevToolsAPI.showPanel==='function'&&DevToolsAPI.showPanel(${JSON.stringify(panel)})`:'undefined';
  const inspect=inspectMode?"if(typeof DevToolsAPI!=='undefined'&&typeof DevToolsAPI.enterInspectElementMode==='function')DevToolsAPI.enterInspectElementMode();":'';
  void devtools.view.webContents.executeJavaScript(`typeof DevToolsAPI!=='undefined'&&Promise.resolve(${show}).then(()=>{${inspect}})`).catch(()=>undefined);
}
function openDevtools(tab:Tab,panel?:DevtoolsPanel,inspectMode=false):void {
  let wc=tab.view?.webContents;if(!wc||wc.isDestroyed())return;
  tab.devtoolsWanted=true;
  // Only a crashed frontend needs a replacement inspected webContents.
  if(tab.devtoolsStopped===tab.viewGeneration){destroyView(tab);wc=makeView(tab).webContents;if(tab.visible&&!tab.leases)attach(tab);}
  let devtools=tab.devtools;const created=!devtools;
  if(!devtools){
    const view=new WebContentsView({webPreferences:{partition:'threadterm-devtools',sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,preload:undefined}});
    devtools={view,bounds:tab.devtoolsBounds,ready:false,inspectMode:false};tab.devtools=devtools;
    const contents=view.webContents,pairing=devtools;
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    contents.on('will-navigate',(event,url)=>{if(!url.startsWith('devtools://'))event.preventDefault();});
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.on('before-input-event',(event,input)=>{if(tab.view?.webContents===wc&&tab.devtools===pairing&&input.type==='keyDown')handleDevtoolsShortcut(tab,event,input);});
    contents.once('destroyed',()=>{if(tab.view?.webContents===wc)devtoolsStopped(tab,pairing);});
    contents.on('render-process-gone',()=>{if(tab.view?.webContents===wc)devtoolsStopped(tab,pairing);});
    wc.setDevToolsWebContents(contents);
  }
  if(panel)devtools.panel=panel;if(inspectMode)devtools.inspectMode=true;
  if(created)wc.openDevTools({mode:'detach',activate:false});else selectDevtoolsPanel(tab,devtools);
  attachDevtools(tab);emit(tab);
}
function destroyDevtools(tab:Tab):void { const devtools=tab.devtools,wc=tab.view?.webContents;detachDevtools(tab);tab.devtools=undefined;tab.devtoolsSnapshot=undefined;if(devtools&&wc&&!wc.isDestroyed())wc.closeDevTools();if(devtools&&!devtools.view.webContents.isDestroyed())devtools.view.webContents.close(); }
function devtoolsStopped(tab:Tab,devtools:Devtools):void { if(tab.devtools!==devtools)return;tab.devtoolsStopped=tab.viewGeneration;tab.devtoolsWanted=false;destroyDevtools(tab);setIssue(tab,devtoolsStoppedIssue); }
function closeDevtools(tab:Tab):void { tab.devtoolsWanted=false;detachDevtools(tab);tab.devtoolsSnapshot=undefined;emit(tab); }
function inspectDevtools(tab:Tab):void {
  const point=tab.contextPoint,previous=tab.view?.webContents,sequence=tab.contextSequence;openDevtools(tab,'elements');
  const wc=tab.view?.webContents,devtools=tab.devtools;if(!point||!wc||!devtools||wc.isDestroyed())return;
  const inspect=()=>{if(tabs.get(tab.id)!==tab||tab.view?.webContents!==wc||wc.isDestroyed()||tab.devtools!==devtools||!tab.devtoolsWanted||tab.contextSequence!==sequence||(wc===previous&&tab.contextPoint!==point))return;if(!devtools.ready){wc.once('devtools-opened',inspect);return;}wc.inspectElement(point.x,point.y);};
  if(wc!==previous)wc.once('did-finish-load',inspect);else inspect();
}
function handleDevtoolsShortcut(tab:Tab,event:Electron.Event,input:Electron.Input):boolean { const shortcut=browserDevtoolsShortcut(input);if(!shortcut)return false;event.preventDefault();if(shortcut.action==='toggle'&&tab.devtoolsWanted)closeDevtools(tab);else openDevtools(tab,shortcut.panel,shortcut.panel==='elements');return true; }
function attach(tab:Tab):void { if (!tab.view || tab.window.isDestroyed() || !tab.bounds) return; applyViewRadius(tab);if (!appView(tab).children.includes(tab.view)) appView(tab).addChildView(tab.view); const zoom=tab.owner.getZoomFactor();tab.view.setBounds({x:Math.round(tab.bounds.x*zoom),y:Math.round(tab.bounds.y*zoom),width:Math.round(tab.bounds.width*zoom),height:Math.round(tab.bounds.height*zoom)});attachDevtools(tab); }
function detach(tab:Tab):void { detachDevtools(tab);if (tab.view && !tab.window.isDestroyed() && appView(tab).children.includes(tab.view)) appView(tab).removeChildView(tab.view); }
function destroyView(tab:Tab):void { tab.faviconAbort?.abort();tab.faviconAbort=undefined;agentControllers.get(tab.owner)?.invalidate(tab.id,'Sharing stopped — the browser view was unloaded.');const contents=tab.view?.webContents,url=contents&&!contents.isDestroyed()?contents.getURL():undefined;if(url){tab.url=url;tab.origin=pageOrigin(url);} tab.findRequestId=undefined; tab.find=undefined; tab.occlusionGeneration++; detach(tab);destroyDevtools(tab);tab.contextPoint=undefined; nativePageClosed(tab.owner,tab.frameName); const view=tab.view; tab.view=undefined; tab.snapshot=undefined; tab.loading=false;tab.consoleStatus='pending';tab.consoleUrl=undefined; if (view && !view.webContents.isDestroyed()) view.webContents.close(); emit(tab); }
function scheduleHidden():void { if (hiddenTimer) { clearInterval(hiddenTimer); hiddenTimer=undefined; } if ([...tabs.values()].some(tab=>!!tab.view&&!tab.visible) && preferences.unloadAfterMinutes>0) { hiddenTimer=setInterval(()=>{ for(const id of expiredHidden([...tabs.values()].filter(tab=>!!tab.view),Date.now(),preferences.unloadAfterMinutes)) destroyView(tabs.get(id)!); scheduleHidden(); },60_000); hiddenTimer.unref(); } }
function trimLive():void { const live=[...tabs.values()].filter(tab=>!!tab.view); for(const id of lruVictims(live,6)) destroyView(tabs.get(id)!); scheduleHidden(); }
async function occlude(tab:Tab):Promise<void> {
  const wc=tab.view?.webContents; if (!wc || !tab.visible) return;
  if(tab.window.isFocused())tab.owner.focus();
  const devtools=tab.devtools,contents=devtools?.view.webContents,attached=!!devtools&&!tab.window.isDestroyed()&&appView(tab).children.includes(devtools.view);
  const token=++tab.occlusionGeneration,current=()=>tab.occlusionGeneration===token&&tab.leases&&tab.visible&&tab.view?.webContents===wc&&!wc.isDestroyed();
  // Keep the live page attached until the renderer has loaded its replacement image.
  // A transient capture may wake a background page, but never focuses its OS window.
  const captureDevtools=async()=>{if(!contents||!attached)return undefined;try{const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw new Error('Empty DevTools snapshot');return image.toDataURL();}catch{if(current()&&tab.devtools===devtools)detachDevtools(tab);return undefined;}};
  const [page,tools]=await Promise.allSettled([wc.capturePage(undefined,{stayHidden:true,stayAwake:true}),captureDevtools()]);
  if(!current())return;
  tab.devtoolsSnapshot=tab.devtoolsWanted&&tab.devtools===devtools&&tools.status==='fulfilled'?tools.value:undefined;
  // A failed page capture keeps the live page attached (existing behaviour); DevTools never stay over an overlay.
  if(page.status==='fulfilled'&&!page.value.isEmpty()){tab.snapshot=page.value.toDataURL();emit(tab);}else{tab.devtoolsSnapshot=undefined;detachDevtools(tab);setIssue(tab,'Could not capture the page for an app overlay.');}
}
function show(tab:Tab,bounds:BrowserBounds,devtoolsBounds?:BrowserBounds,radius?:number):void { const capture=!tab.visible||!tab.view; tab.radius=radius??tab.radius;tab.bounds=bounds;setDevtoolsBounds(tab,devtoolsBounds); tab.visible=true; tab.hiddenAt=undefined; tab.shownAt=Date.now(); tab.leases=ownerOccluded.get(tab.owner)?1:0; if (!tab.view){makeView(tab);if(tab.devtoolsWanted)openDevtools(tab);} applyViewRadius(tab);if (!tab.leases) { tab.snapshot=undefined;tab.devtoolsSnapshot=undefined; attach(tab); } else if(capture)void occlude(tab); trimLive(); emit(tab); }
function hide(tab:Tab):void { tab.occlusionGeneration++; tab.snapshot=undefined;tab.devtoolsSnapshot=undefined; tab.visible=false;tab.hiddenAt=Date.now();detach(tab);scheduleHidden();emit(tab); }
function close(tab:Tab):void { tab.devtoolsWanted=false;destroyView(tab);agentControllers.get(tab.owner)?.invalidate(tab.id,'Browser tab was closed.',true); tabs.delete(tab.id);if(![...tabs.values()].some(other=>other.partition===tab.partition))machineBrowserOptions?.released(tab.partition);scheduleHidden(); }
function tabFor(event:IpcMainInvokeEvent,id:unknown):Tab { if(typeof id!=='string') throw new Error('Invalid browser tab'); const tab=tabs.get(id); if(!tab || tab.owner!==event.sender) throw new Error('Unknown browser tab'); return tab; }
function agentControllerFor(event:IpcMainInvokeEvent):BrowserAgentController {
  const owner=event.sender,existing=agentControllers.get(owner);if(existing)return existing;
  if(!runtimeForBrowser)throw new Error('Browser sharing is unavailable.');
  const destructionObserved=new WeakSet<WebContents>();
  const controller=new BrowserAgentController(runtimeForBrowser(event),{
    // The native action probe covers the pinned Electron/CDP implementation. Eval remains a separate opt-in capability.
    actionCapability:nativeActionsAvailable,
    canControl(id){const tab=tabs.get(id);return !!tab&&tab.owner===owner&&tab.visible&&!tab.leases&&!tab.window.isDestroyed()&&tab.window.isVisible()&&!tab.window.isMinimized();},
    async navigate(id,url){const tab=tabs.get(id),contents=tab?.view?.webContents;if(!tab||tab.owner!==owner||!contents||contents.isDestroyed()||!allowedFor(tab,url))throw new Error('Browser navigation was rejected.');tab.issue=undefined;void contents.loadURL(url).catch(error=>{if(tab.view?.webContents===contents&&error.code!=='ERR_ABORTED')setIssue(tab,`Page failed to load: ${String(error)}`);});controller.navigationAdmitted(id);return {sharingRevoked:true};},
    getTab(id){const tab=tabs.get(id),contents=tab?.view?.webContents;if(!tab||tab.owner!==owner||owner.isDestroyed()||!contents||contents.isDestroyed())return undefined;if(!destructionObserved.has(contents)){destructionObserved.add(contents);contents.once('destroyed',()=>controller.nativeDestroyed(contents));}return {title:tab.title,contents,canCaptureScreenshot:!tab.window.isDestroyed()&&tab.window.isVisible()&&!tab.window.isMinimized(),document:{sourceTabId:id,viewGeneration:tab.viewGeneration,documentGeneration:tab.documentGeneration,navigationEpoch:tab.navigationEpoch,url:tab.url,available:true,loaded:!tab.loading&&tab.navigation==='load_observed'&&tab.consoleStatus==='committed'&&tab.consoleUrl===contents.getURL()&&tab.url===contents.getURL(),appOrigin:pageOrigin(owner.getURL())}};},
    changed(id){const tab=tabs.get(id);if(tab?.owner===owner)emit(tab);},
  });agentControllers.set(owner,controller);return controller;
}
async function handoffDirectory():Promise<string>{const root=await realpath(app.getPath('userData')),directory=join(root,'page-comments');await mkdir(directory,{recursive:true});const actual=await realpath(directory);if(actual!==directory)throw new Error('Page shot directory escaped user data');return actual;}
async function storeHandoffImage(image:Electron.NativeImage):Promise<{shot:import('@threadterm/protocol').PageShot;dataUrl:string}>{let stored=image,size=stored.getSize(),bytes=stored.toPNG(),extension:'png'|'jpg'=bytes.length<=600*1024?'png':'jpg';if(extension==='jpg')bytes=stored.toJPEG(85);while(bytes.length>MAX_PAGE_SHOT_BYTES){const next=pageImageSize(Math.max(1,Math.floor(size.width*.8)),Math.max(1,Math.floor(size.height*.8)),1600);if(next.width===size.width&&next.height===size.height)throw new Error('Screenshot exceeds image size limit');stored=stored.resize({...next,quality:'best'});size=next;extension='jpg';bytes=stored.toJPEG(85);}const thumbnail=stored.resize({...pageImageSize(size.width,size.height,240),quality:'good'}).toJPEG(70),directory=await handoffDirectory(),id=randomUUID(),path=pageShotPath(directory,id,extension),dataUrl=`data:image/${extension==='jpg'?'jpeg':'png'};base64,${bytes.toString('base64')}`;await writeFile(path,bytes,{flag:'wx'});return {shot:{id,path,width:size.width,height:size.height,thumbnail:`data:image/jpeg;base64,${thumbnail.toString('base64')}`},dataUrl};}
function validGeneration(tab:Tab,value:unknown):void{if(!Number.isSafeInteger(value)||value!==tab.documentGeneration)throw new Error('Page changed; capture it again.');}
async function captureHandoff(tab:Tab,generation:unknown):Promise<BrowserHandoffResult>{validGeneration(tab,generation);const expected=generation as number,wc=tab.view?.webContents;if(!wc||!tab.visible||wc.isDestroyed())throw new Error('Browser page is not visible.');const url=wc.getURL(),origin=pageOrigin(url),epoch=tab.navigationEpoch,viewGeneration=tab.viewGeneration,image=await wc.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(error=>{throw new Error(`Page screenshot capture failed: ${String(error)}`);}),current=()=>tab.visible&&tab.view?.webContents===wc&&!wc.isDestroyed()&&tab.documentGeneration===expected&&tab.navigationEpoch===epoch&&tab.viewGeneration===viewGeneration&&wc.getURL()===url;if(!current())throw new Error('Page changed; capture it again.');if(image.isEmpty())throw new Error('Could not capture the page.');const stored=await storeHandoffImage(image).catch(error=>{throw new Error(`Page screenshot save failed: ${String(error)}`);});if(!current()){await deletePageShots([stored.shot.id]);throw new Error('Page changed; capture it again.');}while(tab.handoffs.size>=200)tab.handoffs.delete(tab.handoffs.keys().next().value!);tab.handoffs.set(stored.shot.id,{path:stored.shot.path,epoch,generation:expected,viewGeneration,origin,url,currentUrl:url});return {shot:stored.shot,dataUrl:stored.dataUrl,url,documentGeneration:tab.documentGeneration,width:stored.shot.width,height:stored.shot.height};}
function pngSize(bytes:Buffer):{width:number;height:number}{if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(12)!==0x49484452)throw new Error('Invalid marked-up screenshot.');const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width>10000||height>10000)throw new Error('Invalid marked-up screenshot.');return {width,height};}
async function saveMarkup(tab:Tab,command:Extract<BrowserHandoffCommand,{type:'saveMarkup'}>):Promise<BrowserHandoffResult>{
 validGeneration(tab,command.documentGeneration);const owned=tab.handoffs.get(command.shotId);
 const current=()=>tabs.get(tab.id)===tab&&tab.handoffs.get(command.shotId)===owned&&owned?.epoch===tab.navigationEpoch&&owned.generation===tab.documentGeneration&&owned.viewGeneration===tab.viewGeneration&&owned.currentUrl===tab.url&&!!owned.origin&&owned.origin===pageOrigin(tab.url);
 if(!owned||!current())throw new Error('Screenshot is not available for this page.');
 if(!validPageShotId(command.shotId)||typeof command.dataUrl!=='string'||command.dataUrl.length>MAX_PAGE_SHOT_BYTES*2)throw new Error('Invalid marked-up screenshot.');
 const match=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(command.dataUrl);if(!match)throw new Error('Marked-up screenshot must be a PNG.');
 const bytes=Buffer.from(match[1],'base64');if(!bytes.length||bytes.length>MAX_PAGE_SHOT_BYTES||bytes.toString('base64')!==match[1])throw new Error('Invalid marked-up screenshot.');
 pngSize(bytes);const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw new Error('Invalid marked-up screenshot.');const size=image.getSize();if(size.width>10000||size.height>10000)throw new Error('Invalid marked-up screenshot.');
 const directory=await handoffDirectory(),path=pageShotPath(directory,command.shotId,'png'),temporary=`${path}.${randomUUID()}.tmp`;
 try {
  await writeFile(temporary,bytes,{flag:'wx'});if(!current())throw new Error('Page changed; capture it again.');
  await rename(temporary,path);
  if(!current()){await deletePageShots([command.shotId]);throw new Error('Page changed; capture it again.');}
  if(owned.path!==path)await unlink(owned.path).catch(()=>undefined);
  if(!current()){await deletePageShots([command.shotId]);throw new Error('Page changed; capture it again.');}
  const thumbnail=image.resize({...pageImageSize(size.width,size.height,240),quality:'good'}).toJPEG(70),shot={id:command.shotId,path,width:size.width,height:size.height,thumbnail:`data:image/jpeg;base64,${thumbnail.toString('base64')}`};
  tab.handoffs.set(shot.id,{...owned,path});return {shot,dataUrl:command.dataUrl,url:owned.url,documentGeneration:owned.generation,width:size.width,height:size.height};
 }finally {await unlink(temporary).catch(()=>undefined);}
}

export function lookupNativePage(sender: WebContents, frameName: string): WebContents | undefined { const tab=[...tabs.values()].find(value=>value.owner===sender&&value.frameName===frameName); return tab?.view?.webContents; }
let appViewFor: ((owner: WebContents) => Electron.View | undefined) | undefined;
function appView(tab: Tab): Electron.View { return appViewFor?.(tab.owner) ?? tab.window.contentView; }
export function registerBrowser(assertTrustedRenderer:(event:IpcMainInvokeEvent)=>void, runtimeFor?:(event:IpcMainInvokeEvent)=>BrowserAgentRuntime, contentViewFor?: (owner: WebContents) => Electron.View | undefined, machineOptions?: MachineBrowserOptions):void {
  machineBrowserOptions=machineOptions;
  appViewFor = contentViewFor;
  runtimeForBrowser=runtimeFor;
  loadPreferences();
  configureProfile();
  app.on('web-contents-created', (_event, contents) => contents.once('destroyed',()=>{ trustedOwners.delete(contents);agentControllers.get(contents)?.dispose();agentControllers.delete(contents);for(const tab of [...tabs.values()]) if(tab.owner===contents) close(tab); }));
  ipcMain.handle('threadterm:browser-handoff', async (event, value:unknown) => {
    assertTrustedRenderer(event);trustedOwners.add(event.sender);const command=value as BrowserHandoffCommand;if(!command||typeof command!=='object'||typeof command.type!=='string')throw new Error('Invalid browser handoff command');
    if(command.type==='preferences'){if(command.patch!==undefined&&(!command.patch||typeof command.patch!=='object'||typeof command.patch.devServerOffers!=='boolean'))throw new Error('Invalid browser handoff preferences');if(command.patch){devServerOffers=command.patch.devServerOffers!;savePreferences();for(const owner of trustedOwners)if(!owner.isDestroyed())owner.send('threadterm:browser-handoff-event',{type:'preferences',devServerOffers} satisfies BrowserHandoffEvent);}return {devServerOffers};}
    const tab=tabFor(event,command.tabId);
    if(command.type==='capture')return captureHandoff(tab,command.documentGeneration);
    if(command.type==='saveMarkup')return saveMarkup(tab,command);
    if(command.type==='console'){validGeneration(tab,command.documentGeneration);const wc=tab.view?.webContents;if(!wc||wc.isDestroyed()||tab.consoleStatus!=='committed'||!tab.consoleUrl||wc.getURL()!==tab.consoleUrl)throw new Error('Page changed; wait for navigation to settle before sending console errors.');const counts=consoleCounts(tab.console.entries);return {url:tab.consoleUrl,documentGeneration:tab.documentGeneration,entries:[...tab.console.entries],...counts,truncated:tab.console.truncated,text:formatConsolePageData(tab.consoleUrl,tab.console.entries,tab.console.truncated)};}
    throw new Error('Unsupported browser handoff command');
  });
  ipcMain.handle('threadterm:browser-command', async (event, value:unknown) => {
    assertTrustedRenderer(event); const command=value as BrowserCommand; if(!command || typeof command!=='object'||typeof command.type!=='string') throw new Error('Invalid browser command');
    if(command.type==='preferences'){ if(command.patch){ const next=command.patch; if(next.unloadAfterMinutes!==undefined && (!Number.isInteger(next.unloadAfterMinutes)||next.unloadAfterMinutes<0||next.unloadAfterMinutes>24*60)) throw new Error('Invalid unload setting'); if(next.linkTarget!==undefined&&next.linkTarget!=='builtin'&&next.linkTarget!=='system') throw new Error('Invalid link target'); preferences={...preferences,...next}; savePreferences(); scheduleHidden(); } return preferences; }
    if(command.type==='open'){if(!machineBrowserOptions||machineBrowserOptions.partitionFor(event.sender)==='persist:threadterm-browser')throw new Error('Machine browser opening requires a remote view');const normalized=normalizeBrowserUrl(command.url);if(!normalized.url)throw new Error(normalized.issue);event.sender.send('threadterm:browser-event',{type:'open',url:normalized.url} satisfies BrowserEvent);return;}
    if(command.type==='clearData'){ const partition=machineBrowserOptions?.partitionFor(event.sender)??'persist:threadterm-browser';await Promise.all([...agentControllers].filter(([owner])=>(machineBrowserOptions?.partitionFor(owner)??'persist:threadterm-browser')===partition).map(([,controller])=>controller.stopAll('Sharing stopped — browsing data was cleared.')));const browser=browserProfile(partition); await browser.clearStorageData(); await browser.clearCache(); return; }
    if(command.type==='download'){ if(typeof command.id!=='string'||!['open','show'].includes(command.action))throw new Error('Invalid download action'); for(const tab of tabs.values()) if(tab.owner===event.sender){ const path=tab.downloads.get(command.id); if(path) command.action==='open' ? void shell.openPath(path) : shell.showItemInFolder(path); } return; }
    if(command.type==='occlusion'){if(typeof command.active!=='boolean')throw new Error('Invalid occlusion command');ownerOccluded.set(event.sender,command.active);const captures:Promise<void>[]=[];for(const tab of tabs.values())if(tab.owner===event.sender){const wasOccluded=tab.leases;tab.leases=command.active?1:0;if(tab.leases){if(!wasOccluded)captures.push(occlude(tab));}else{tab.occlusionGeneration++;tab.snapshot=undefined;tab.devtoolsSnapshot=undefined;if(tab.visible)attach(tab);emit(tab);}}await Promise.all(captures);return;}
    if(command.type==='show'){
      if((command.radius!==undefined&&(!Number.isFinite(command.radius)||command.radius<0||command.radius>32))||!validBounds(command.bounds)||(command.devtools!==undefined&&!validBounds(command.devtools))||typeof command.url!=='string'||!validFrameName(command.frameName)||typeof command.tabId!=='string'||!command.tabId||command.tabId.length>128)throw new Error('Invalid browser view');
      let tab=tabs.get(command.tabId);
      if(tab&&tab.owner!==event.sender)throw new Error('Unknown browser tab');
      if(!tab){
        const normalized=normalizeBrowserUrl(command.url);if(!normalized.url)throw new Error(normalized.issue);
        const partition=machineBrowserOptions?.partitionFor(event.sender)??'persist:threadterm-browser';
        const window=machineBrowserOptions?.windowFor(event.sender)??BrowserWindow.fromWebContents(event.sender);if(!window)throw new Error('Browser window is unavailable');
        tab={partition,id:command.tabId,owner:event.sender,window,url:normalized.url,title:'',frameName:command.frameName,radius:command.radius??0,devtoolsWanted:false,visible:false,shownAt:Date.now(),loading:false,documentGeneration:0,navigationEpoch:0,viewGeneration:0,navigation:'pending',zoom:1,downloads:new Map(),leases:0,gestureUntil:0,occlusionGeneration:0,contextSequence:0,console:createConsoleRing(),consoleCounts:{errors:0,warnings:0},consoleStatus:'pending',handoffs:new Map()};
        if(!allowedFor(tab,normalized.url))throw new Error('Blocked app address.');
        // Reserve ownership before proxy setup yields. Closing the old panel during
        // Open as tab must not tear down this new tab's machine proxy.
        tabs.set(tab.id,tab);
        if(partition!=='persist:threadterm-browser')tab.preparing=machineBrowserOptions?.prepare(event);
      }
      if(tab.preparing){
        try{await tab.preparing;}catch(error){if(tabs.get(tab.id)===tab)close(tab);throw error;}
        finally{tab.preparing=undefined;}
        if(event.sender.isDestroyed()||tabs.get(tab.id)!==tab)throw new Error('Browser owner was closed');
        configureProfile(browserProfile(tab.partition));
      }
      if(tab.frameName!==command.frameName){nativePageClosed(tab.owner,tab.frameName);tab.frameName=command.frameName;if(tab.view)nativePageRegistered(tab.owner,tab.frameName,tab.view.webContents,()=>tab!.bounds);}
      show(tab,command.bounds,command.devtools,command.radius);return state(tab);
    }
    const tab=tabFor(event,(command as {tabId?:unknown}).tabId);
    if(command.type==='stopAgentOperation'){
      if(!isBrowserStopAgentOperationCommand(command))throw new Error('Invalid browser operation stop command');
      agentControllers.get(tab.owner)?.stopAgentOperation(tab.id,command.operationId);return state(tab);
    }
    if(command.type==='share'){
      if(!isBrowserShareCommand(command))throw new Error('Invalid browser sharing command');
      const existing=agentControllers.get(tab.owner);
      if(command.level==='off'&&!existing)return state(tab);
      await (existing??agentControllerFor(event)).share(command);return state(tab);
    }
    if(command.type==='bounds'){if((command.radius!==undefined&&(!Number.isFinite(command.radius)||command.radius<0||command.radius>32))||!validBounds(command.bounds)||(command.devtools!==undefined&&!validBounds(command.devtools)))throw new Error('Invalid browser bounds');tab.radius=command.radius??tab.radius;applyViewRadius(tab);tab.bounds=command.bounds;setDevtoolsBounds(tab,command.devtools);if(tab.visible&&!tab.leases)attach(tab);return state(tab);}
    if(command.type==='hide'){hide(tab);return state(tab);} if(command.type==='close'){close(tab);return;}
    if(command.type==='state') return state(tab);
    if(command.type==='snapshotReady'){if(!Number.isSafeInteger(command.generation)||command.generation<1)throw new Error('Invalid snapshot generation');if(tab.visible&&tab.leases&&(tab.snapshot||tab.devtoolsSnapshot)&&tab.occlusionGeneration===command.generation)detach(tab);return;}
    if(command.type==='devtools'){
      if(!['toggle','open','close','inspect'].includes(command.action)||(command.panel!==undefined&&!['console','network','elements'].includes(command.panel)))throw new Error('Invalid developer tools command');
      if(command.action==='close'||command.action==='toggle'&&tab.devtoolsWanted)closeDevtools(tab);
      else if(command.action==='inspect')inspectDevtools(tab);
      else openDevtools(tab,command.panel,command.panel==='elements');
      return state(tab);
    }
    const wc=tab.view?.webContents;if(!wc)return state(tab);
    if(command.type==='back'){if(wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();} else if(command.type==='forward'){if(wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();} else if(command.type==='reload'){wc.reload();} else if(command.type==='stop'){wc.stop();tab.loading=false;tab.navigation='failed';emit(tab);} else if(command.type==='focus'){if(tab.window.isFocused())wc.focus();} else if(command.type==='navigate'){const normalized=normalizeBrowserUrl(command.url);if(!normalized.url||!allowedFor(tab,normalized.url)){agentControllers.get(tab.owner)?.navigationStarted(tab.id,normalized.url??command.url);setIssue(tab,normalized.issue??'Blocked app address.');}else {tab.issue=undefined;void wc.loadURL(normalized.url).catch(error=>{if(tab.view?.webContents===wc&&error.code!=='ERR_ABORTED')setIssue(tab,`Page failed to load: ${String(error)}`);});}} else if(command.type==='find'){if(typeof command.text!=='string'||command.text.length>10000)throw new Error('Invalid find text');tab.findRequestId=undefined;tab.find={activeMatchOrdinal:0,matches:0};if(command.text)tab.findRequestId=wc.findInPage(command.text,{forward:command.forward,findNext:!command.findNext});else{wc.stopFindInPage('clearSelection');emit(tab);}} else if(command.type==='stopFind'){tab.findRequestId=undefined;wc.stopFindInPage('clearSelection');tab.find=undefined;emit(tab);} else if(command.type==='zoom'){if(!Number.isFinite(command.factor))throw new Error('Invalid zoom');const factor=Math.min(3,Math.max(.25,command.factor));tab.zoom=factor;wc.setZoomFactor(factor);emit(tab);} else throw new Error('Unsupported browser command'); return state(tab);
  });
}

export async function clearBrowserPartition(partition:string):Promise<void> {
  for(const tab of [...tabs.values()])if(tab.partition===partition)close(tab);
  const browser=browserProfile(partition);await browser.closeAllConnections();await browser.clearStorageData();await browser.clearCache();
}
