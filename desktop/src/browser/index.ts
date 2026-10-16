import { app, BrowserWindow, ipcMain, session, shell, WebContentsView, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { sanitizeBrowserTitle } from '../../../renderer/src/browserTypes.js';
import type { BrowserBounds, BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from '../../../renderer/src/browserTypes.js';
import { allowedTopLevelUrl, defaultBrowserPreferences, expiredHidden, lruVictims, normalizeBrowserUrl } from './policy.js';
import { captureNativePageShot, deletePageShots, nativePageClosed, nativePageRegistered } from '../pageComments.js';

type Tab = { id:string; owner:WebContents; window:BrowserWindow; url:string; title:string; frameName:string; view?:WebContentsView; bounds?:BrowserBounds; visible:boolean; shownAt:number; hiddenAt?:number; loading:boolean; documentGeneration:number; navigation:BrowserState['navigation']; issue?:string; snapshot?:string; zoom:number; find?:BrowserState['find']; findRequestId?:number; origin?:string; downloads:Map<string,string>; leases:number; download?:{id:string;name:string}; notice?:string; gestureUntil:number; occlusionGeneration:number; contextSequence:number };
const tabs = new Map<string, Tab>();
const ownerOccluded = new WeakMap<WebContents, boolean>();
let preferences: BrowserPreferences = { ...defaultBrowserPreferences };
let hiddenTimer: ReturnType<typeof setInterval> | undefined;
let profile: Electron.Session | undefined;
const browserProfile = (): Electron.Session => profile ??= session.fromPartition('persist:threadterm-browser');

function validBounds(value: unknown): value is BrowserBounds { return !!value && typeof value === 'object' && ['x','y','width','height'].every(key => Number.isFinite((value as Record<string,unknown>)[key])) && (value as BrowserBounds).width >= 0 && (value as BrowserBounds).height >= 0; }
function validFrameName(value: unknown): value is string { return typeof value === 'string' && /^tt-preview-[a-z0-9-]{8,64}$/.test(value); }
function state(tab: Tab): BrowserState { const wc=tab.view?.webContents; return { tabId:tab.id,url:tab.url,title:tab.title,loading:tab.loading,canGoBack:wc?.navigationHistory.canGoBack()??false,canGoForward:wc?.navigationHistory.canGoForward()??false,zoom:tab.zoom,documentGeneration:tab.documentGeneration,navigation:tab.navigation,...(tab.issue?{issue:tab.issue}:{}),...(tab.snapshot?{snapshot:tab.snapshot,snapshotGeneration:tab.occlusionGeneration}:{}),...(tab.view?{}:{unloaded:true}),...(tab.find?{find:tab.find}:{}),...(tab.notice?{notice:tab.notice}:{}),...(tab.download?{download:tab.download}:{}) }; }
function emit(tab: Tab): void { if (!tab.owner.isDestroyed()) tab.owner.send('threadterm:browser-event', { type:'state', state:state(tab) } satisfies BrowserEvent); }
function setIssue(tab: Tab, issue?: string): void { tab.issue=issue; emit(tab); }
function pageOrigin(url: string): string | undefined { try { const parsed=new URL(url); return /^https?:$/.test(parsed.protocol) || parsed.protocol==='blob:'&&/^https?:/.test(parsed.origin) ? parsed.origin : undefined; } catch { return undefined; } }
function allowedFor(tab:Tab, url:string):boolean { const appOrigin=pageOrigin(tab.owner.getURL()), candidate=pageOrigin(url); return allowedTopLevelUrl(url,tab.origin) && !(appOrigin && candidate === appOrigin); }
function preferencePath():string { return join(app.getPath('userData'),'browser-preferences.json'); }
function loadPreferences():void { try { const value=JSON.parse(readFileSync(preferencePath(),'utf8')) as Partial<BrowserPreferences>; if(Number.isInteger(value.unloadAfterMinutes)&&value.unloadAfterMinutes!>=0&&value.unloadAfterMinutes!<=1440&&(value.linkTarget==='builtin'||value.linkTarget==='system')) preferences={unloadAfterMinutes:value.unloadAfterMinutes!,linkTarget:value.linkTarget}; } catch { /* First run or corrupt browser-only preferences: use safe defaults. */ } }
function savePreferences():void { const file=preferencePath(), temporary=`${file}.${randomUUID()}.tmp`; mkdirSync(join(app.getPath('userData')),{recursive:true}); writeFileSync(temporary,JSON.stringify(preferences),'utf8'); renameSync(temporary,file); }
function configureProfile(): void {
  const browser = browserProfile();
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
  const view=new WebContentsView({ webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true, preload:undefined, partition:'persist:threadterm-browser' } });
  tab.view=view;
  const wc=view.webContents;
  wc.on('will-attach-webview', event => event.preventDefault());
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
  const guardNavigation=(event:Electron.Event,url:string) => { if (!allowedFor(tab,url)) { event.preventDefault(); setIssue(tab, `Blocked navigation to ${safeScheme(url)}.`); } };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-frame-navigate', details => { if(details.isMainFrame)guardNavigation(details,details.url); });
  wc.on('will-redirect', (details,url,_inPage,isMainFrame) => { if(isMainFrame)guardNavigation(details,url); });
  wc.on('did-start-navigation', (details, url, _sameDocument, isMainFrame) => { if (!(details.isMainFrame??isMainFrame)) return; const address=details.url??url; tab.findRequestId=undefined; tab.find=undefined; tab.issue=undefined; tab.loading=true; tab.navigation='pending'; tab.url=address; tab.origin=pageOrigin(address); emit(tab); });
  wc.on('did-navigate-in-page', (_event,url,isMainFrame) => { if(isMainFrame){tab.url=url;emit(tab);} });
  wc.on('did-finish-load', () => { tab.loading=false; tab.url=wc.getURL(); tab.title=sanitizeBrowserTitle(wc.getTitle()); tab.origin=pageOrigin(tab.url); tab.documentGeneration++; tab.navigation='load_observed'; emit(tab); });
  wc.on('did-fail-load', (_event, _code, description, url, isMainFrame) => { if (!isMainFrame||_code===-3) return; tab.loading=false; tab.url=url || tab.url; tab.navigation='failed'; tab.issue=`Page failed to load: ${description}`; emit(tab); });
  wc.on('page-title-updated', (_event, title) => { tab.title=sanitizeBrowserTitle(title); emit(tab); });
  wc.on('did-stop-loading', () => {
    if(tab.view?.webContents!==wc)return;
    tab.loading=false;
    // A download/cancel can start a navigation without replacing the document.
    // Retain Chromium's current page, not the attempted URL, for unload/restore.
    const url=wc.getURL();if(tab.navigation==='pending'&&tab.documentGeneration>0&&url){tab.url=url;tab.origin=pageOrigin(url);tab.navigation='load_observed';}
    emit(tab);
  });
  wc.on('found-in-page', (_event, result) => { if(result.requestId!==tab.findRequestId)return; tab.find={activeMatchOrdinal:result.activeMatchOrdinal,matches:result.matches}; emit(tab); });
  wc.on('before-input-event', (event, input) => {
    if(input.type==='keyDown') tab.gestureUntil=Date.now()+1000;
    const control=input.control || input.meta, key=input.key.toLowerCase();
    if(input.type==='keyDown'&&input.key==='Escape'&&tab.find){event.preventDefault();if(tab.window.isFocused())tab.owner.focus();tab.owner.send('threadterm:browser-event',{type:'shortcut',tabId:tab.id,key:input.key,code:input.code,control:input.control,meta:input.meta,shift:input.shift,alt:input.alt} satisfies BrowserEvent);return;}
    const appShortcut=control&&!input.alt&&((!input.shift&&['f','p','b','k','l','-','0','='].includes(key))||(input.shift&&['e','f','g','k','+','='].includes(key)));
    const modifierRelease=input.type==='keyUp'&&['Control','Meta'].includes(input.key);
    if(!modifierRelease&&(input.type!=='keyDown'||!control))return;
    if(appShortcut){event.preventDefault();if(tab.window.isFocused())tab.owner.focus();}
    if(!tab.owner.isDestroyed())tab.owner.send('threadterm:browser-event',{type:'shortcut',phase:modifierRelease?'keyup':'keydown',tabId:tab.id,key:input.key,code:input.code,control:input.control,meta:input.meta,shift:input.shift,alt:input.alt} satisfies BrowserEvent);
  });
  wc.on('before-mouse-event', (_event, mouse) => { if(mouse.type==='mouseDown')tab.gestureUntil=Date.now()+1000; });
  wc.on('context-menu', (_event, params) => void nativeContext(tab, params.x, params.y).catch(()=>undefined));
  nativePageRegistered(tab.owner, tab.frameName, wc, () => tab.bounds);
  wc.setZoomFactor(tab.zoom);
  tab.loading=true;tab.navigation='pending';tab.issue=undefined;
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
function attach(tab:Tab):void { if (!tab.view || tab.window.isDestroyed() || !tab.bounds) return; if (!tab.window.contentView.children.includes(tab.view)) tab.window.contentView.addChildView(tab.view); const zoom=tab.owner.getZoomFactor();tab.view.setBounds({x:Math.round(tab.bounds.x*zoom),y:Math.round(tab.bounds.y*zoom),width:Math.round(tab.bounds.width*zoom),height:Math.round(tab.bounds.height*zoom)}); }
function detach(tab:Tab):void { if (tab.view && !tab.window.isDestroyed() && tab.window.contentView.children.includes(tab.view)) tab.window.contentView.removeChildView(tab.view); }
function destroyView(tab:Tab):void { const contents=tab.view?.webContents,url=contents&&!contents.isDestroyed()?contents.getURL():undefined;if(url){tab.url=url;tab.origin=pageOrigin(url);} tab.findRequestId=undefined; tab.find=undefined; tab.occlusionGeneration++; detach(tab); nativePageClosed(tab.owner,tab.frameName); const view=tab.view; tab.view=undefined; tab.snapshot=undefined; tab.loading=false; if (view && !view.webContents.isDestroyed()) view.webContents.close(); emit(tab); }
function scheduleHidden():void { if (hiddenTimer) { clearInterval(hiddenTimer); hiddenTimer=undefined; } if ([...tabs.values()].some(tab=>!!tab.view&&!tab.visible) && preferences.unloadAfterMinutes>0) { hiddenTimer=setInterval(()=>{ for(const id of expiredHidden([...tabs.values()].filter(tab=>!!tab.view),Date.now(),preferences.unloadAfterMinutes)) destroyView(tabs.get(id)!); scheduleHidden(); },60_000); hiddenTimer.unref(); } }
function trimLive():void { const live=[...tabs.values()].filter(tab=>!!tab.view); for(const id of lruVictims(live,6)) destroyView(tabs.get(id)!); scheduleHidden(); }
async function occlude(tab:Tab):Promise<void> {
  const wc=tab.view?.webContents; if (!wc || !tab.visible) return;
  if(tab.window.isFocused())tab.owner.focus();
  const token=++tab.occlusionGeneration,current=()=>tab.occlusionGeneration===token&&tab.leases&&tab.visible&&tab.view?.webContents===wc;
  // Keep the live page attached until the renderer has loaded its replacement image.
  // A transient capture may wake a background page, but never focuses its OS window.
  try { const image=await wc.capturePage(undefined,{stayHidden:true,stayAwake:true}); if(current()) { if(image.isEmpty())throw new Error('Empty page snapshot'); tab.snapshot=image.toDataURL(); emit(tab); } }
  catch { if(current())setIssue(tab,'Could not capture the page for an app overlay.'); }
}
function show(tab:Tab,bounds:BrowserBounds):void { const capture=!tab.visible||!tab.view; tab.bounds=bounds; tab.visible=true; tab.hiddenAt=undefined; tab.shownAt=Date.now(); tab.leases=ownerOccluded.get(tab.owner)?1:0; if (!tab.view) makeView(tab); if (!tab.leases) { tab.snapshot=undefined; attach(tab); } else if(capture)void occlude(tab); trimLive(); emit(tab); }
function hide(tab:Tab):void { tab.occlusionGeneration++; tab.snapshot=undefined; tab.visible=false;tab.hiddenAt=Date.now();detach(tab);scheduleHidden();emit(tab); }
function close(tab:Tab):void { destroyView(tab); tabs.delete(tab.id);scheduleHidden(); }
function tabFor(event:IpcMainInvokeEvent,id:unknown):Tab { if(typeof id!=='string') throw new Error('Invalid browser tab'); const tab=tabs.get(id); if(!tab || tab.owner!==event.sender) throw new Error('Unknown browser tab'); return tab; }

export function lookupNativePage(sender: WebContents, frameName: string): WebContents | undefined { const tab=[...tabs.values()].find(value=>value.owner===sender&&value.frameName===frameName); return tab?.view?.webContents; }
export function registerBrowser(assertTrustedRenderer:(event:IpcMainInvokeEvent)=>void):void {
  loadPreferences();
  configureProfile();
  app.on('web-contents-created', (_event, contents) => contents.once('destroyed',()=>{ for(const tab of [...tabs.values()]) if(tab.owner===contents) close(tab); }));
  ipcMain.handle('threadterm:browser-command', async (event, value:unknown) => {
    assertTrustedRenderer(event); const command=value as BrowserCommand; if(!command || typeof command!=='object'||typeof command.type!=='string') throw new Error('Invalid browser command');
    if(command.type==='preferences'){ if(command.patch){ const next=command.patch; if(next.unloadAfterMinutes!==undefined && (!Number.isInteger(next.unloadAfterMinutes)||next.unloadAfterMinutes<0||next.unloadAfterMinutes>24*60)) throw new Error('Invalid unload setting'); if(next.linkTarget!==undefined&&next.linkTarget!=='builtin'&&next.linkTarget!=='system') throw new Error('Invalid link target'); preferences={...preferences,...next}; savePreferences(); scheduleHidden(); } return preferences; }
    if(command.type==='clearData'){ const browser=browserProfile(); await browser.clearStorageData(); await browser.clearCache(); return; }
    if(command.type==='download'){ if(typeof command.id!=='string'||!['open','show'].includes(command.action))throw new Error('Invalid download action'); for(const tab of tabs.values()) if(tab.owner===event.sender){ const path=tab.downloads.get(command.id); if(path) command.action==='open' ? void shell.openPath(path) : shell.showItemInFolder(path); } return; }
    if(command.type==='occlusion'){if(typeof command.active!=='boolean')throw new Error('Invalid occlusion command');ownerOccluded.set(event.sender,command.active);const captures:Promise<void>[]=[];for(const tab of tabs.values())if(tab.owner===event.sender){const wasOccluded=tab.leases;tab.leases=command.active?1:0;if(tab.leases){if(!wasOccluded)captures.push(occlude(tab));}else{tab.occlusionGeneration++;if(tab.visible){tab.snapshot=undefined;attach(tab);emit(tab);}}}await Promise.all(captures);return;}
    if(command.type==='show'){ if(!validBounds(command.bounds)||typeof command.url!=='string'||!validFrameName(command.frameName)||typeof command.tabId!=='string'||!command.tabId||command.tabId.length>128) throw new Error('Invalid browser view'); let tab=tabs.get(command.tabId); if(tab&&tab.owner!==event.sender) throw new Error('Unknown browser tab'); if(!tab){const normalized=normalizeBrowserUrl(command.url);if(!normalized.url) throw new Error(normalized.issue);const window=BrowserWindow.fromWebContents(event.sender);if(!window)throw new Error('Browser window is unavailable');tab={id:command.tabId,owner:event.sender,window,url:normalized.url,title:'',frameName:command.frameName,visible:false,shownAt:Date.now(),loading:false,documentGeneration:0,navigation:'pending',zoom:1,downloads:new Map(),leases:0,gestureUntil:0,occlusionGeneration:0,contextSequence:0};if(!allowedFor(tab,normalized.url))throw new Error('Blocked app address.');tabs.set(tab.id,tab);} if(tab.frameName!==command.frameName){nativePageClosed(tab.owner,tab.frameName);tab.frameName=command.frameName;if(tab.view)nativePageRegistered(tab.owner,tab.frameName,tab.view.webContents,()=>tab!.bounds);} show(tab,command.bounds); return state(tab); }
    const tab=tabFor(event,(command as {tabId?:unknown}).tabId);
    if(command.type==='bounds'){if(!validBounds(command.bounds))throw new Error('Invalid browser bounds');tab.bounds=command.bounds;if(tab.visible&&!tab.leases)attach(tab);return state(tab);}
    if(command.type==='hide'){hide(tab);return state(tab);} if(command.type==='close'){close(tab);return;}
    if(command.type==='state') return state(tab);
    if(command.type==='snapshotReady'){if(!Number.isSafeInteger(command.generation)||command.generation<1)throw new Error('Invalid snapshot generation');if(tab.visible&&tab.leases&&tab.snapshot&&tab.occlusionGeneration===command.generation)detach(tab);return;}
    const wc=tab.view?.webContents;if(!wc)return state(tab);
    if(command.type==='back'){if(wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();} else if(command.type==='forward'){if(wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();} else if(command.type==='reload'){wc.reload();} else if(command.type==='stop'){wc.stop();tab.loading=false;tab.navigation='failed';emit(tab);} else if(command.type==='focus'){if(tab.window.isFocused())wc.focus();} else if(command.type==='navigate'){const normalized=normalizeBrowserUrl(command.url);if(!normalized.url||!allowedFor(tab,normalized.url))setIssue(tab,normalized.issue??'Blocked app address.');else {tab.issue=undefined;void wc.loadURL(normalized.url).catch(error=>{if(tab.view?.webContents===wc&&error.code!=='ERR_ABORTED')setIssue(tab,`Page failed to load: ${String(error)}`);});}} else if(command.type==='find'){if(typeof command.text!=='string'||command.text.length>10000)throw new Error('Invalid find text');tab.findRequestId=undefined;tab.find={activeMatchOrdinal:0,matches:0};if(command.text)tab.findRequestId=wc.findInPage(command.text,{forward:command.forward,findNext:!command.findNext});else{wc.stopFindInPage('clearSelection');emit(tab);}} else if(command.type==='stopFind'){tab.findRequestId=undefined;wc.stopFindInPage('clearSelection');tab.find=undefined;emit(tab);} else if(command.type==='zoom'){if(!Number.isFinite(command.factor))throw new Error('Invalid zoom');const factor=Math.min(3,Math.max(.25,command.factor));tab.zoom=factor;wc.setZoomFactor(factor);emit(tab);} else throw new Error('Unsupported browser command'); return state(tab);
  });
}
