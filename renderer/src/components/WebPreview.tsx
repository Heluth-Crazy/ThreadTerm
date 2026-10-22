import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageRect } from '@threadterm/protocol';
import { addPageShotToDraft } from '../pageShotDraft';
import { browserCommand, browserHandoff, deletePageShots, onBrowserEvent, onBrowserHandoffEvent, onPageContextMenu, openExternal, type BrowserState } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import type { CommentScope } from '../reviewComments';
import type { PageCommentProvenance } from '../reviewComments';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { browserAddressParts } from '../browserAddress';
import { browserDevtoolsShortcut, clampDevtoolsHeight } from '../browserDevtools';
import { PageCommentControls, PageCommentForm, PageHandoffDestination, ScreenshotMarkup, usePageCommentPreview } from './PageComments';
import type { BrowserCaptureResult, BrowserConsoleResult } from '../../../desktop/src/browser/handoffTypes';
import { PendingComments, useReviewComments } from './FileComments';
import { showContextMenu } from './ContextMenu';
import { webContextMenuItems } from '../webContextMenuItems';
import { updateBrowserOverlayBounds, usePassiveBrowserOcclusion, watchBrowserOverlays } from '../browserOcclusion';
import type { BrowserShareWorkspace, BrowserSharingLevel } from '../browserTypes';
import { browserControlOrigin, browserShareFence, canRequestBrowserControl, createBrowserShareIntents, createBrowserStateSequence, prepareBrowserShareCommand, sameBrowserShareFence, type BrowserShareIntent } from '../browserAgentUi';
import { BrowserTabActivity } from './BrowserTabActivity';
import { SurfaceDialog } from './SurfaceDialog';
import '../workbench/workbench.css';
import './browser-chrome.css';

type NavigationObservation={navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number};
type Props={tabId:string;url:string;visible:boolean;zh:boolean;commentScope?:CommentScope;commentsHost?:FileCommentsHost;commentProvenance?:PageCommentProvenance;prepareBrowserShare?:(tabId:string)=>Promise<BrowserShareWorkspace>;onNavigation?:(observation:NavigationObservation)=>void;onPopup?:(popup:{openerId:string;tabId:string;url:string})=>void};
/** A native browser page. FilePreview retains the sandboxed iframe used for saved HTML and development addresses. */
export function WebPreview({tabId,url,visible,zh,commentScope,commentsHost,commentProvenance,prepareBrowserShare,onNavigation,onPopup}:Props) {
 const placeholder=useRef<HTMLDivElement>(null);
 const devtools=useRef<HTMLDivElement>(null);
 const boundsObserver=useRef<ResizeObserver|undefined>(undefined),sendBounds=useRef<(()=>void)|undefined>(undefined),devtoolsPresented=useRef<boolean|undefined>(undefined);
 const surface=useRef<HTMLElement>(null);
 const notice=useRef<HTMLParagraphElement>(null);
 const [issue, setIssue] = useState<string>();
 const [handoffIssue,setHandoffIssue]=useState<string>();
 const [sharingIssue,setSharingIssue]=useState<string>(),[shareBusy,setShareBusy]=useState(false);
 const [shareTarget,setShareTarget]=useState<BrowserSharingLevel>();
 const [shareIntents]=useState(createBrowserShareIntents),sharingDescription=useId(),controlDescription=useId();
 const [stateSequence]=useState(createBrowserStateSequence);
 const [controlConfirmation,setControlConfirmation]=useState<{intent:BrowserShareIntent;origin:string}>();
 const pendingShare=useRef<BrowserShareIntent|undefined>(undefined);
 const [handoff,setHandoff]=useState<{kind:'markup';capture:BrowserCaptureResult;provenance?:PageCommentProvenance}|{kind:'screenshot';capture:BrowserCaptureResult;provenance?:PageCommentProvenance}|{kind:'console';console:BrowserConsoleResult;provenance?:PageCommentProvenance}>();
 const handoffRef=useRef(handoff);handoffRef.current=handoff;
 const handoffBusy=useRef(false);
 const [markupBounds,setMarkupBounds]=useState<PageRect>();
 const [capturing,setCapturing]=useState(false),[consoleCounts,setConsoleCounts]=useState({errors:0,warnings:0}),[consoleOpen,setConsoleOpen]=useState(false);
 const live=useRef(true),captureSequence=useRef(0);
 const [state,setState]=useState<Omit<BrowserState,'tabId'>>({url,title:'',loading:false,canGoBack:false,canGoForward:false,zoom:1,navigation:'pending',documentGeneration:0,unloaded:true});
 const scope=`${commentScope?.projectId??''}\0${commentScope?.root??''}`;
 const latest=useRef({tabId,state,scope,visible,prepareBrowserShare});latest.current={tabId,state,scope,visible,prepareBrowserShare};
 const shareFence=()=>browserShareFence(latest.current.tabId,latest.current.state,latest.current.scope,latest.current.visible);
 usePassiveBrowserOcclusion(notice,visible&&Boolean(state.notice));
 const [address,setAddress]=useState(url),[findOpen,setFindOpen]=useState(false),[find,setFind]=useState('');
 const [devtoolsHeight,setDevtoolsHeight]=useState(()=>{try{const height=Number(localStorage.getItem('threadterm.browser.devtoolsHeight'));return Number.isFinite(height)&&height>0?height:0;}catch{return 0;}});
 const [addressFocused,setAddressFocused]=useState(false),addressParts=browserAddressParts(address);
 const addressInput=useRef<HTMLInputElement>(null),findInput=useRef<HTMLInputElement>(null);
 const observed=useRef('');
 const preview=usePageCommentPreview(url,commentScope,commentsHost,zh,commentProvenance,{element:placeholder,focus:()=>void browserCommand({type:'focus',tabId}).catch(()=>undefined)});
 const comments=useReviewComments(commentScope);
 const sharing=state.sharing;
 const devtoolsOpen=Boolean(state.devtools?.open);
 const devtoolsPaneHeight=()=>{const pageHeight=placeholder.current?.getBoundingClientRect().height??0,devtoolsHeight=devtools.current?.getBoundingClientRect().height??0;return pageHeight+devtoolsHeight;};
 const canShare=Boolean(prepareBrowserShare&&sharing&&sharing.viewGeneration>0&&!state.loading&&!state.unloaded&&state.navigation==='load_observed');
 const canControl=canRequestBrowserControl(state,visible,Boolean(prepareBrowserShare));
 const copy = (en:string, cn:string) => zh ? cn : en;
 const commitDevtoolsHeight=(height:number,paneHeight:number)=>{const next=clampDevtoolsHeight(height,paneHeight);setDevtoolsHeight(next);try{localStorage.setItem('threadterm.browser.devtoolsHeight',String(next));}catch{}return next;};
 const splitterDrag=useRef<{y:number;height:number}|undefined>(undefined);
 const snapshotLoaded=useRef<{tabId:string;page?:number;devtools?:number}>({tabId});
 const snapshotAcked=useRef<Set<number>>(new Set());
 const acknowledgeSnapshot=(source:'page'|'devtools',generation:number|undefined)=>{
  if(generation===undefined)return;
  const current=latest.current,pageGeneration=current.state.snapshotGeneration,devtoolsGeneration=current.state.devtools?.snapshotGeneration,paired=pageGeneration===generation&&devtoolsGeneration===generation;
  if(current.tabId!==tabId)return;
  if(snapshotLoaded.current.tabId!==tabId){snapshotLoaded.current={tabId};snapshotAcked.current.clear();}
  snapshotLoaded.current[source]=generation;
  for(const acknowledged of snapshotAcked.current)if(acknowledged!==pageGeneration&&acknowledged!==devtoolsGeneration)snapshotAcked.current.delete(acknowledged);
  if((source==='page'?pageGeneration:devtoolsGeneration)!==generation||paired&&(snapshotLoaded.current.page!==generation||snapshotLoaded.current.devtools!==generation)||snapshotAcked.current.has(generation))return;
  snapshotAcked.current.add(generation);const currentTabId=current.tabId;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{const next=latest.current,nextPageGeneration=next.state.snapshotGeneration,nextDevtoolsGeneration=next.state.devtools?.snapshotGeneration,nextPaired=nextPageGeneration===generation&&nextDevtoolsGeneration===generation;if(!live.current||next.tabId!==currentTabId||!next.visible||(nextPageGeneration!==generation&&nextDevtoolsGeneration!==generation)||nextPaired&&(snapshotLoaded.current.page!==generation||snapshotLoaded.current.devtools!==generation)){snapshotAcked.current.delete(generation);return;}void browserCommand({type:'snapshotReady',tabId:currentTabId,generation}).catch(error=>{if(live.current&&latest.current.tabId===currentTabId)setIssue(String(error));});}));
 };
 useEffect(()=>{const loaded=snapshotLoaded.current;if(!visible||loaded.tabId!==tabId)return;if(state.snapshot&&loaded.page===state.snapshotGeneration)acknowledgeSnapshot('page',state.snapshotGeneration);if(state.devtools?.snapshot&&loaded.devtools===state.devtools.snapshotGeneration)acknowledgeSnapshot('devtools',state.devtools.snapshotGeneration);},[tabId,visible,state.snapshot,state.snapshotGeneration,state.devtools?.snapshot,state.devtools?.snapshotGeneration]);
 const cancelHandoff=()=>{captureSequence.current++;const current=handoffRef.current;if(current&&current.kind!=='console')void deletePageShots([current.capture.shot.id]).catch(error=>setIssue(String(error)));setHandoff(undefined);};
 const screenshot=async()=>{if(capturing||!commentsHost)return;const sequence=++captureSequence.current;setCapturing(true);setHandoffIssue(undefined);const provenance=commentProvenance?{...commentProvenance}:undefined;try{const result=await browserHandoff({type:'capture',tabId,documentGeneration:state.documentGeneration});if(!('shot' in result))throw new Error('Could not capture the page.');if(!live.current||captureSequence.current!==sequence){void deletePageShots([result.shot.id]).catch(()=>undefined);return;}const rect=placeholder.current?.getBoundingClientRect();if(!rect||rect.width<=0||rect.height<=0){void deletePageShots([result.shot.id]).catch(()=>undefined);throw new Error('Browser page is not visible.');}setMarkupBounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});setHandoff({kind:'markup',capture:result,provenance});}catch(error){if(live.current)setHandoffIssue(String(error));}finally{if(live.current)setCapturing(false);}};
 const consoleToChat=async()=>{if(!commentsHost)return;setIssue(undefined);const sequence=++captureSequence.current,provenance=commentProvenance?{...commentProvenance}:undefined;try{const result=await browserHandoff({type:'console',tabId,documentGeneration:state.documentGeneration});if(!('entries' in result))throw new Error('Could not read page console.');if(live.current&&captureSequence.current===sequence){setHandoff({kind:'console',console:result,provenance});setConsoleOpen(false);}}catch(error){if(live.current)setIssue(String(error));}};
 const acceptState=(next:BrowserState)=>{
  if(next.tabId!==latest.current.tabId)return;
  stateSequence.advance();
  const before=shareFence();latest.current={...latest.current,state:next};
  if(!sameBrowserShareFence(before,shareFence())){shareIntents.invalidate();pendingShare.current=undefined;setControlConfirmation(undefined);setShareBusy(false);setShareTarget(undefined);}
  setState(next);setIssue(next.issue);const key=[next.navigation,next.url,next.title,next.documentGeneration].join('\0');if(key!==observed.current){observed.current=key;onNavigation?.({navigation:next.navigation,url:next.url,title:next.title||undefined,documentGeneration:next.documentGeneration});}
 };
 const command=(value:Parameters<typeof browserCommand>[0])=>void browserCommand(value).then(result=>{
  // Show/bounds replies can predate a capture event; the emitted state owns visibility.
  if(value.type!=='show'&&value.type!=='bounds'&&value.type!=='hide'&&value.type!=='focus'&&result&&'tabId' in result&&result.tabId===tabId)acceptState(result);
 }).catch(error=>setIssue(String(error)));
 const setShareLevel=async(level:BrowserSharingLevel,confirmed?:BrowserShareIntent)=>{
  const intent=confirmed??shareIntents.capture(shareFence());
  if(!live.current||!shareIntents.current(intent,shareFence())){setControlConfirmation(undefined);return;}
  stateSequence.advance();
  pendingShare.current=intent;setControlConfirmation(undefined);setShareBusy(true);setShareTarget(level);setSharingIssue(undefined);
  try{
   if(confirmed)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   if(!live.current||!shareIntents.current(intent,shareFence()))return;
   if(level==='control'&&!canRequestBrowserControl(latest.current.state,latest.current.visible,Boolean(latest.current.prepareBrowserShare)))throw new Error('Browser control is unavailable for this page.');
   const request=await prepareBrowserShareCommand(level,intent,()=>live.current&&shareIntents.current(intent,shareFence()),latest.current.prepareBrowserShare);
   if(!request||!live.current||!shareIntents.current(intent,shareFence()))return;
   if(level==='control'&&!canRequestBrowserControl(latest.current.state,latest.current.visible,Boolean(latest.current.prepareBrowserShare)))throw new Error('Browser control is unavailable for this page.');
   const result=await browserCommand(request);
   if(live.current&&shareIntents.current(intent,shareFence())&&result&&'tabId' in result)acceptState(result);
  }catch(error){if(live.current&&shareIntents.current(intent,shareFence()))setSharingIssue(String(error));}
  finally{if(pendingShare.current===intent){pendingShare.current=undefined;if(live.current){setShareBusy(false);setShareTarget(undefined);}}}
 };
 const requestControl=()=>{if(!canControl||shareBusy||sharing?.level==='control')return;const origin=browserControlOrigin(state);if(origin){setSharingIssue(undefined);setControlConfirmation({intent:shareIntents.capture(shareFence()),origin});}};
 const cancelControl=()=>{shareIntents.invalidate();setControlConfirmation(undefined);};
 const stopAgentOperation=async(operationId:string)=>{
  const fence=shareFence();
  await stateSequence.reply(()=>browserCommand({type:'stopAgentOperation',tabId,operationId}),result=>{
   if(live.current&&sameBrowserShareFence(fence,shareFence())&&result&&'tabId' in result&&result.tabId===latest.current.tabId)acceptState(result);
  });
 };
 useEffect(()=>()=>{shareIntents.invalidate();pendingShare.current=undefined;void browserCommand({type:'share',tabId,level:'off'}).catch(()=>undefined);},[tabId,commentScope?.projectId,commentScope?.root,shareIntents]);
 useEffect(()=>{const intent=controlConfirmation?.intent??pendingShare.current;if(intent&&!shareIntents.current(intent,shareFence())){shareIntents.invalidate();pendingShare.current=undefined;setControlConfirmation(undefined);setShareBusy(false);setShareTarget(undefined);}},[scope,visible,state.documentGeneration,sharing?.navigationEpoch,sharing?.viewGeneration,sharing?.grantEpoch,sharing?.level,sharing?.controlAvailable,controlConfirmation,shareIntents]);
 useEffect(()=>{setAddress(url);},[url]);
 const handleBrowserKey=(event:KeyboardEvent)=>{
  const devtoolsShortcut=browserDevtoolsShortcut({key:event.key,control:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,alt:event.altKey});
  if(devtoolsShortcut){event.preventDefault();event.stopPropagation();command({type:'devtools',tabId,action:devtoolsShortcut.action,panel:devtoolsShortcut.panel});}
  else if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.key.toLowerCase()==='f'){event.preventDefault();setFindOpen(true);command({type:'find',tabId,text:''});requestAnimationFrame(()=>findInput.current?.focus());}
  else if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.key.toLowerCase()==='l'){event.preventDefault();addressInput.current?.focus();addressInput.current?.select();}
  else if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')command({type:'zoom',tabId,factor:1});else command({type:'zoom',tabId,factor:Math.max(.25,Math.min(5,state.zoom*(event.key==='-'?.9:1.1)))});}
  else if(event.key==='Escape'&&findOpen){event.preventDefault();setFindOpen(false);command({type:'stopFind',tabId});}
 };
 useEffect(()=>onBrowserEvent(event=>{
  if(event.type==='popup'&&event.openerId===tabId){onPopup?.(event);return;}
  if(event.type==='shortcut'&&event.tabId===tabId&&visible){const devtoolsShortcut=browserDevtoolsShortcut({key:event.key,control:event.control,meta:event.meta,shift:event.shift,alt:event.alt}),key=new KeyboardEvent(event.phase??'keydown',{key:event.key,code:event.code,ctrlKey:event.control,metaKey:event.meta,shiftKey:event.shift,altKey:event.alt,bubbles:true,cancelable:true});if(event.phase!=='keyup')handleBrowserKey(key);if(!devtoolsShortcut&&(key.key!=='Escape'||!key.defaultPrevented))window.dispatchEvent(key);}
  if(event.type==='state'&&event.state.tabId===tabId)acceptState(event.state);
 }),[tabId,visible,onNavigation,onPopup,state.zoom,findOpen]);
 useEffect(()=>{
  if(!visible)return;
  const element=placeholder.current;if(!element)return;
  const stopWatching=watchBrowserOverlays(element);
  const bounds=()=>{const currentDevtoolsOpen=Boolean(latest.current.state.devtools?.open);updateBrowserOverlayBounds();const rect=element.getBoundingClientRect(),devtoolsRect=currentDevtoolsOpen?devtools.current?.getBoundingClientRect():undefined;if(currentDevtoolsOpen){const paneHeight=devtoolsPaneHeight();if(paneHeight>0)setDevtoolsHeight(current=>{const next=clampDevtoolsHeight(current||paneHeight*.4,paneHeight);if(next!==current)try{localStorage.setItem('threadterm.browser.devtoolsHeight',String(next));}catch{}return next;});}if(handoffRef.current?.kind==='markup')setMarkupBounds(current=>current&&current.x===rect.x&&current.y===rect.y&&current.width===rect.width&&current.height===rect.height?current:{x:rect.x,y:rect.y,width:rect.width,height:rect.height});command({type:'bounds',tabId,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)},...(devtoolsRect&&{devtools:{x:Math.round(devtoolsRect.x),y:Math.round(devtoolsRect.y),width:Math.round(devtoolsRect.width),height:Math.round(devtoolsRect.height)}})});};
  sendBounds.current=bounds;
  const currentDevtoolsOpen=Boolean(latest.current.state.devtools?.open),rect=element.getBoundingClientRect(),devtoolsRect=currentDevtoolsOpen?devtools.current?.getBoundingClientRect():undefined;command({type:'show',tabId,url,frameName:preview.frameName,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)},...(devtoolsRect&&{devtools:{x:Math.round(devtoolsRect.x),y:Math.round(devtoolsRect.y),width:Math.round(devtoolsRect.width),height:Math.round(devtoolsRect.height)}})});
  const observer=new ResizeObserver(bounds);boundsObserver.current=observer;observer.observe(element);addEventListener('scroll',bounds,true);
  return()=>{if(boundsObserver.current===observer)boundsObserver.current=undefined;if(sendBounds.current===bounds)sendBounds.current=undefined;observer.disconnect();removeEventListener('scroll',bounds,true);command({type:'hide',tabId});stopWatching();};
 },[tabId,url,visible,preview.frameName]);
 useEffect(()=>{
  if(!visible)return;
  const observer=boundsObserver.current,element=devtoolsOpen?devtools.current:null,previous=devtoolsPresented.current;devtoolsPresented.current=devtoolsOpen;
  if(observer&&element)observer.observe(element);
  if(previous!==undefined&&previous!==devtoolsOpen)sendBounds.current?.();
  return()=>{if(observer&&element)observer.unobserve(element);};
 },[tabId,url,visible,preview.frameName,devtoolsOpen]);
 useEffect(()=>{if(!devtoolsOpen||devtoolsHeight>0)return;const paneHeight=devtoolsPaneHeight();if(paneHeight>0)commitDevtoolsHeight(paneHeight*.4,paneHeight);},[devtoolsOpen,devtoolsHeight]);
 useEffect(()=>{
  if(!visible)return;
  const key=(event:KeyboardEvent)=>{if(event.target instanceof Node&&surface.current?.contains(event.target))handleBrowserKey(event);};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);
 },[visible,tabId,state.zoom,findOpen]);
 useEffect(()=>onPageContextMenu(({frameName,x,y,pick})=>{
  if(frameName!==preview.frameName||!pick)return;
  showContextMenu({x,y,restoreFocus:placeholder.current,onDismiss:selected=>{if(selected?.testId!=='web-preview-comment-element'&&pick.shot)void deletePageShots([pick.shot.id]).catch(()=>undefined);},items:webContextMenuItems({pick,zh,enabled:preview.enabled,comment:()=>preview.acceptPick(pick),reload:()=>{preview.cancel(false);command({type:'reload',tabId});},copy:()=>navigator.clipboard.writeText(pick.target.type==='element' ? (pick.target.text ?? '') : ''),inspect:()=>command({type:'devtools',tabId,action:'inspect'})})});
 }),[preview.frameName,preview.acceptPick,zh]);
 useEffect(()=>{live.current=true;return()=>{live.current=false;captureSequence.current++;const current=handoffRef.current;if(!handoffBusy.current&&current&&current.kind!=='console')void deletePageShots([current.capture.shot.id]).catch(()=>undefined);};},[tabId]);
 useEffect(()=>{const current=handoffRef.current;if(!handoffBusy.current&&current&&((current.kind==='console'?current.console.documentGeneration:current.capture.documentGeneration)!==state.documentGeneration))cancelHandoff();setConsoleCounts({errors:0,warnings:0});},[state.documentGeneration]);
 useEffect(()=>onBrowserHandoffEvent(event=>{if(event.type==='console'&&event.tabId===tabId)setConsoleCounts({errors:event.errors,warnings:event.warnings});}),[tabId]);
 useEffect(()=>{if(!visible)return;let active=true;void browserHandoff({type:'console',tabId,documentGeneration:state.documentGeneration}).then(result=>{if(active&&'entries' in result)setConsoleCounts({errors:result.errors,warnings:result.warnings});}).catch(()=>undefined);return()=>{active=false;};},[tabId,visible,state.documentGeneration]);
 return <section ref={surface} className="wb-web-preview" data-preview-id={commentProvenance?.previewId} data-document-id={commentProvenance?.documentId} data-web-tab-id={tabId} data-document-generation={state.documentGeneration} data-handoff-state={capturing?'capturing':handoff?.kind??(handoffIssue?'error':'idle')}>
  <div className="file-bar wb-browser-toolbar">
   <div className="wb-browser-navigation" role="group" aria-label="Page navigation">
   <button type="button" className="icon-btn icon-btn-sm" disabled={!state.canGoBack} title={copy('Back','后退')} aria-label={copy('Back','后退')} onClick={()=>command({type:'back',tabId})}><WbIcon name="arrow-left"/></button>
   <button type="button" className="icon-btn icon-btn-sm wb-browser-forward" disabled={!state.canGoForward} title={copy('Forward','前进')} aria-label={copy('Forward','前进')} onClick={()=>command({type:'forward',tabId})}><WbIcon name="arrow-right"/></button>
   <button type="button" className="icon-btn icon-btn-sm" title={state.loading?copy('Stop','停止'):copy('Reload','重新加载')} aria-label={state.loading?copy('Stop','停止'):copy('Reload','重新加载')} onClick={()=>command({type:state.loading?'stop':'reload',tabId})}>{state.loading?<WbIcon name="close"/>:<WbIcon name="refresh"/>}</button>
   </div>
   <label className="wb-browser-address"><span className="sr-only">{copy('Address','地址')}</span><span className="wb-browser-page-glyph" aria-hidden={!state.loading||undefined}>{state.loading?<span className="wb-browser-loading" role="status" aria-label={copy('Loading','正在加载')}/>:<WbIcon name={addressParts.scheme==='https'?'tune':'info'} aria-hidden="true"/>}</span><input ref={addressInput} value={address} aria-label={copy('Address','地址')} data-url-overlay={!addressFocused||undefined} onFocus={event=>{setAddressFocused(true);event.currentTarget.select();}} onBlur={()=>setAddressFocused(false)} onChange={event=>setAddress(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();command({type:'navigate',tabId,url:address});}}}/>{!addressFocused&&<span className="wb-browser-url" aria-hidden="true"><span>{addressParts.host}</span><span className="wb-browser-url-rest">{addressParts.rest}</span></span>}{state.zoom!==1&&<button type="button" className="icon-btn icon-btn-sm wb-browser-zoom" title={copy(`Reset zoom (${Math.round(state.zoom*100)}%)`,`重置缩放（${Math.round(state.zoom*100)}%）`)} aria-label={`${Math.round(state.zoom*100)}%`} onClick={()=>command({type:'zoom',tabId,factor:1})}><WbIcon name={state.zoom>1?'zoom-in':'zoom-out'}/></button>}</label>
   <div className="wb-browser-actions" role="group" aria-label="Page actions">
   <div className="wb-browser-share" role="group" aria-label={copy('Agent access','智能体访问')} aria-describedby={sharingDescription} aria-busy={shareBusy||Boolean(sharing&&sharing.status!=='idle')}>
    <span><WbIcon name="agent-access"/><span className="sr-only">{copy('Agents','智能体')}</span></span><button type="button" className="btn btn-sm btn-ghost" aria-label={copy('Agent access Off','关闭智能体访问')} aria-pressed={!sharing||sharing.level==='off'} disabled={(!sharing||sharing.level==='off')&&!shareBusy&&!controlConfirmation&&(!sharing||sharing.status==='idle')} onClick={()=>void setShareLevel('off')}>Off</button><button type="button" className="btn btn-sm btn-ghost" aria-label={copy('Agent access Read','允许智能体读取')} aria-pressed={sharing?.level==='read'} disabled={!canShare||(shareBusy&&shareTarget!=='control')||sharing?.status!=='idle'||sharing.level==='read'&&!controlConfirmation&&shareTarget!=='control'} onClick={()=>void setShareLevel('read')}>Read</button><button type="button" className="btn btn-sm btn-ghost" aria-label={copy('Agent access Control','允许智能体控制')} aria-pressed={sharing?.level==='control'} disabled={!canControl||shareBusy||sharing?.level==='control'} onClick={requestControl}>Control</button>
   </div>
   {sharing?.reading&&<span role="status" className="wb-browser-reading">{copy('Reading…','正在读取…')}</span>}
   <PageCommentControls preview={preview} zh={zh} variant="icon" hint={false}/>
   <button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Screenshot to Chat','截图到对话')} title={copy('Screenshot to Chat','截图到对话')} aria-busy={capturing} disabled={!commentsHost||capturing||Boolean(handoff)||state.loading||state.navigation!=='load_observed'||state.unloaded} onClick={()=>void screenshot()}><WbIcon name="screenshot"/></button>
   <button type="button" className="icon-btn icon-btn-sm wb-console-count" aria-label={copy('Page console','页面控制台')} title={copy(`${consoleCounts.errors} errors, ${consoleCounts.warnings} warnings`,`${consoleCounts.errors} 个错误，${consoleCounts.warnings} 个警告`)} data-count={consoleCounts.errors>0?consoleCounts.errors:consoleCounts.warnings} data-severity={consoleCounts.errors>0?'error':'warning'} aria-expanded={consoleOpen} disabled={!commentsHost} onClick={()=>setConsoleOpen(!consoleOpen)}><Icon name="terminal"/></button>
   <button type="button" className="icon-btn icon-btn-sm" title={copy('Find in page','在页面中查找')} aria-label={copy('Find in page','在页面中查找')} onClick={()=>{setFindOpen(true);command({type:'find',tabId,text:''});requestAnimationFrame(()=>findInput.current?.focus());}}><Icon name="search"/></button>
   <button type="button" className="icon-btn icon-btn-sm wb-browser-devtools" title={copy('Developer tools (F12)','开发者工具（F12）')} aria-label={copy('Developer tools','开发者工具')} aria-pressed={devtoolsOpen} onClick={()=>command({type:'devtools',tabId,action:'toggle'})}><WbIcon name="devtools"/></button>
   <button type="button" className="icon-btn icon-btn-sm wb-browser-open" title={copy('Open in browser', '在浏览器中打开')} aria-label={copy('Open in browser', '在浏览器中打开')} onClick={() => void openExternal(state.url||url).catch(error => setIssue(String(error)))}><Icon name="popout"/></button>
   </div>
  </div>
  <p id={sharingDescription} className={`wb-browser-sharing-status${sharing&&sharing.level!=='off'||shareBusy||sharing?.status==='stopping'||sharing?.reason?' wb-browser-infobar':' sr-only'}`} data-level={sharing?.level} role="status">{(sharing&&sharing.level!=='off'||shareBusy||sharing?.status==='stopping'||sharing?.reason)&&<WbIcon name="agent-access"/>}{sharing&&sharing.level!=='off'?<>{sharing.level==='control'?copy('Agents can control this page in this worktree','此工作树中的智能体可以控制此页面'):copy('Shared with agents in this worktree','已与此工作树中的智能体共享')} · <span>{sharing.origin}</span></>:shareBusy||sharing?.status==='sharing'?copy('Updating agent access…','正在更新智能体访问…'):sharing?.status==='stopping'?copy('Stopping sharing…','正在停止共享…'):sharing?.reason??copy('Off. Read shares page data; Control also allows page actions. Sharing stops when the page moves to another site.','已关闭。Read 共享页面数据；Control 还允许页面操作。页面转到其他网站时将停止共享。')}</p>
  <BrowserTabActivity operations={sharing?.operations??[]} zh={zh} onStop={stopAgentOperation}/>
  {controlConfirmation&&<SurfaceDialog size="sm" title={copy('Allow agents to control this page?','允许智能体控制此页面？')} subtitle={controlConfirmation.origin} descriptionId={controlDescription} onClose={cancelControl} footer={<>
   <button type="button" className="btn" onClick={()=>void setShareLevel('off')}>{copy('Turn off sharing','关闭共享')}</button>
   <button type="button" className="btn" autoFocus onClick={cancelControl}>{copy('Cancel','取消')}</button>
   <button type="button" className="btn btn-primary" onClick={()=>void setShareLevel('control',controlConfirmation.intent)}>{copy('Allow Control','允许 Control')}</button>
  </>}><div id={controlDescription}><p>{copy('Agents in this worktree can read this tab, navigate, click, type, hover, press page keys and select options. These actions can change the page or have external effects.','此工作树中的智能体可以读取此标签页、导航、点击、填写内容、悬停、按页面按键和选择选项。这些操作可能改变页面或产生外部影响。')}</p><p>{copy('Stopping an operation does not undo changes already made. You can switch to Read or Off at any time.','停止操作不会撤销已发生的更改。你可以随时切换到 Read 或 Off。')}</p></div></SurfaceDialog>}
  {consoleOpen&&<div className="wb-browser-infobar wb-browser-console-actions"><Icon name="terminal"/><span className="dim">{copy(`${consoleCounts.errors} errors · ${consoleCounts.warnings} warnings`,`${consoleCounts.errors} 个错误 · ${consoleCounts.warnings} 个警告`)}</span><button type="button" className="btn btn-sm wb-browser-open-devtools" onClick={()=>command({type:'devtools',tabId,action:'open',panel:'console'})}>{copy('Open in DevTools','在开发者工具中打开')}</button><button type="button" className="btn btn-sm" disabled={Boolean(handoff)} onClick={()=>void consoleToChat()}>{copy('Send console errors to Chat','将控制台错误发送到对话')}</button></div>}
  {preview.picking&&<p className="wb-browser-infobar wb-page-comment-hint" role="status"><WbIcon name="comment"/>{copy('Click an element or drag an area · ↑ parent · Esc cancels','点击元素或拖动选择区域 · ↑ 选择父级 · Esc 取消')}</p>}
  {findOpen&&<div className="wb-browser-find-row"><div className="wb-browser-find"><input ref={findInput} value={find} aria-label={copy('Find in page','在页面中查找')} onChange={event=>{const value=event.target.value;setFind(value);command({type:'find',tabId,text:value});}} onKeyDown={event=>{if(event.key==='Enter')command({type:'find',tabId,text:find,forward:!event.shiftKey,findNext:true});}}/><span>{state.find?`${state.find.activeMatchOrdinal}/${state.find.matches}`:'0/0'}</span><i className="wb-browser-find-divider" aria-hidden="true"/><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Previous match','上一个匹配')} onClick={()=>command({type:'find',tabId,text:find,forward:false,findNext:true})}><WbIcon name="chev-up"/></button><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Next match','下一个匹配')} onClick={()=>command({type:'find',tabId,text:find,forward:true,findNext:true})}><Icon name="chevD"/></button><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Close find','关闭查找')} onClick={()=>{setFindOpen(false);command({type:'stopFind',tabId});}}><Icon name="close"/></button></div></div>}
  {issue && <p className="wb-issue wb-browser-infobar" role="alert">{issue==='Developer tools stopped. Reload the page to open them again.'?copy('Developer tools stopped. Reload the page to open them again.','开发者工具已停止。重新加载页面后可再次打开。'):issue}</p>}
  {handoffIssue&&<p className="wb-issue wb-browser-infobar" role="alert" data-browser-handoff-error>{handoffIssue}</p>}
  {sharingIssue&&<p className="wb-issue wb-browser-infobar" role="alert" data-browser-sharing-error>{sharingIssue}</p>}
  {preview.issue && <p className="wb-issue wb-browser-infobar" role="alert">{preview.issue}</p>}
  <div ref={placeholder} className="tt-browser-view" data-native-ready={visible&&!state.unloaded?'true':undefined} tabIndex={-1} aria-label={copy('Web preview','网页预览')} onPointerDown={()=>command({type:'focus',tabId})}>{state.snapshot&&<img key={state.snapshotGeneration} src={state.snapshot} alt="" onLoad={()=>acknowledgeSnapshot('page',state.snapshotGeneration)}/>}</div>
  {devtoolsOpen&&<><div className="wb-browser-devtools-splitter" role="separator" aria-orientation="horizontal" aria-label={copy('Resize developer tools','调整开发者工具大小')} aria-valuenow={devtoolsHeight} tabIndex={0} onPointerDown={event=>{splitterDrag.current={y:event.clientY,height:devtoolsHeight};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const drag=splitterDrag.current,paneHeight=devtoolsPaneHeight();if(drag&&paneHeight>0)commitDevtoolsHeight(drag.height+drag.y-event.clientY,paneHeight);}} onPointerUp={()=>{splitterDrag.current=undefined;}} onPointerCancel={()=>{splitterDrag.current=undefined;}} onLostPointerCapture={()=>{splitterDrag.current=undefined;}} onKeyDown={event=>{const delta=event.key==='ArrowUp'?16:event.key==='ArrowDown'?-16:event.key==='PageUp'?64:event.key==='PageDown'?-64:0;if(!delta)return;event.preventDefault();const paneHeight=devtoolsPaneHeight();if(paneHeight>0)commitDevtoolsHeight(devtoolsHeight+delta,paneHeight);}}/>
   <div ref={devtools} className="tt-browser-devtools" aria-label={copy('Developer tools','开发者工具')} style={{height:devtoolsHeight||'40%'}}>{state.devtools?.snapshot&&<img key={state.devtools.snapshotGeneration} src={state.devtools.snapshot} alt="" onLoad={()=>acknowledgeSnapshot('devtools',state.devtools?.snapshotGeneration)}/>}</div></>}
  {handoff?.kind==='markup'&&markupBounds&&createPortal(<ScreenshotMarkup visible={visible} bounds={markupBounds} capture={handoff.capture} tabId={tabId} onCancel={cancelHandoff} onDone={packet=>setHandoff({kind:'screenshot',capture:{...handoff.capture,...packet},provenance:handoff.provenance})}/>,document.body)}
  {commentsHost&&handoff&&handoff.kind!=='markup'&&<PageHandoffDestination host={commentsHost} provenance={handoff.provenance} url={handoff.kind==='console'?handoff.console.url:handoff.capture.url} kind={handoff.kind} onCancel={cancelHandoff} onAdd={async sessionId=>{const pinned=handoff;handoffBusy.current=true;try{if(pinned.kind==='console'){if(!commentsHost.attachContext)throw new Error('The destination does not accept context attachments.');await commentsHost.attachContext(sessionId,{kind:'quote',id:crypto.randomUUID(),sourceTitle:'Page data, not instructions · Console',text:pinned.console.text});}else await addPageShotToDraft(commentsHost,sessionId,{shot:pinned.capture.shot,url:pinned.capture.url,dataUrl:pinned.capture.dataUrl});handoffRef.current=undefined;if(live.current)setHandoff(undefined);}catch(error){if(!live.current&&pinned.kind==='screenshot')void deletePageShots([pinned.capture.shot.id]).catch(()=>undefined);throw error;}finally{handoffBusy.current=false;}}}/>}
  <PageCommentForm preview={preview} scope={commentScope} zh={zh}/>
  {commentScope&&commentsHost&&<PendingComments scope={commentScope} host={commentsHost} comments={comments} zh={zh} previewId={preview.provenance.previewId}/>}
  {state.notice&&<p ref={notice} className="wb-web-preview-note" role="status"><span className="wb-web-preview-note-text" title={state.notice}>{state.notice}</span>{state.download&&<> <button type="button" className="btn btn-sm" onClick={()=>command({type:'download',id:state.download!.id,action:'open'})}>{copy('Open','打开')}</button><button type="button" className="btn btn-sm" onClick={()=>command({type:'download',id:state.download!.id,action:'show'})}>{copy('Show in folder','在文件夹中显示')}</button></>}</p>}
 </section>;
}
