import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageRect } from '@threadterm/protocol';
import { addPageShotToDraft } from '../pageShotDraft';
import { browserCommand, browserHandoff, deletePageShots, onBrowserEvent, onBrowserHandoffEvent, onPageContextMenu, openExternal, type BrowserState } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import type { CommentScope } from '../reviewComments';
import type { PageCommentProvenance } from '../reviewComments';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { PageCommentControls, PageCommentForm, PageHandoffDestination, ScreenshotMarkup, usePageCommentPreview } from './PageComments';
import type { BrowserCaptureResult, BrowserConsoleResult } from '../../../desktop/src/browser/handoffTypes';
import { PendingComments, useReviewComments } from './FileComments';
import { showContextMenu } from './ContextMenu';
import { webContextMenuItems } from '../webContextMenuItems';
import { updateBrowserOverlayBounds, usePassiveBrowserOcclusion, watchBrowserOverlays } from '../browserOcclusion';
import '../workbench/workbench.css';

type NavigationObservation={navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number};
type Props={tabId:string;url:string;visible:boolean;zh:boolean;commentScope?:CommentScope;commentsHost?:FileCommentsHost;commentProvenance?:PageCommentProvenance;onNavigation?:(observation:NavigationObservation)=>void;onPopup?:(popup:{openerId:string;tabId:string;url:string})=>void};
/** A native browser page. FilePreview retains the sandboxed iframe used for saved HTML and development addresses. */
export function WebPreview({tabId,url,visible,zh,commentScope,commentsHost,commentProvenance,onNavigation,onPopup}:Props) {
 const placeholder=useRef<HTMLDivElement>(null);
 const surface=useRef<HTMLElement>(null);
 const notice=useRef<HTMLParagraphElement>(null);
 const [issue, setIssue] = useState<string>();
 const [handoffIssue,setHandoffIssue]=useState<string>();
 const [handoff,setHandoff]=useState<{kind:'markup';capture:BrowserCaptureResult;provenance?:PageCommentProvenance}|{kind:'screenshot';capture:BrowserCaptureResult;provenance?:PageCommentProvenance}|{kind:'console';console:BrowserConsoleResult;provenance?:PageCommentProvenance}>();
 const handoffRef=useRef(handoff);handoffRef.current=handoff;
 const handoffBusy=useRef(false);
 const [markupBounds,setMarkupBounds]=useState<PageRect>();
 const [capturing,setCapturing]=useState(false),[consoleCounts,setConsoleCounts]=useState({errors:0,warnings:0}),[consoleOpen,setConsoleOpen]=useState(false);
 const live=useRef(true),captureSequence=useRef(0);
 const [state,setState]=useState<Omit<BrowserState,'tabId'>>({url,title:'',loading:false,canGoBack:false,canGoForward:false,zoom:1,navigation:'pending',documentGeneration:0,unloaded:true});
 usePassiveBrowserOcclusion(notice,visible&&Boolean(state.notice));
 const [address,setAddress]=useState(url),[findOpen,setFindOpen]=useState(false),[find,setFind]=useState('');
 const addressInput=useRef<HTMLInputElement>(null),findInput=useRef<HTMLInputElement>(null);
 const observed=useRef('');
 const preview=usePageCommentPreview(url,commentScope,commentsHost,zh,commentProvenance,{element:placeholder,focus:()=>void browserCommand({type:'focus',tabId}).catch(()=>undefined)});
 const comments=useReviewComments(commentScope);
 const copy = (en:string, cn:string) => zh ? cn : en;
 const cancelHandoff=()=>{captureSequence.current++;const current=handoffRef.current;if(current&&current.kind!=='console')void deletePageShots([current.capture.shot.id]).catch(error=>setIssue(String(error)));setHandoff(undefined);};
 const screenshot=async()=>{if(capturing||!commentsHost)return;const sequence=++captureSequence.current;setCapturing(true);setHandoffIssue(undefined);const provenance=commentProvenance?{...commentProvenance}:undefined;try{const result=await browserHandoff({type:'capture',tabId,documentGeneration:state.documentGeneration});if(!('shot' in result))throw new Error('Could not capture the page.');if(!live.current||captureSequence.current!==sequence){void deletePageShots([result.shot.id]).catch(()=>undefined);return;}const rect=placeholder.current?.getBoundingClientRect();if(!rect||rect.width<=0||rect.height<=0){void deletePageShots([result.shot.id]).catch(()=>undefined);throw new Error('Browser page is not visible.');}setMarkupBounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});setHandoff({kind:'markup',capture:result,provenance});}catch(error){if(live.current)setHandoffIssue(String(error));}finally{if(live.current)setCapturing(false);}};
 const consoleToChat=async()=>{if(!commentsHost)return;setIssue(undefined);const sequence=++captureSequence.current,provenance=commentProvenance?{...commentProvenance}:undefined;try{const result=await browserHandoff({type:'console',tabId,documentGeneration:state.documentGeneration});if(!('entries' in result))throw new Error('Could not read page console.');if(live.current&&captureSequence.current===sequence){setHandoff({kind:'console',console:result,provenance});setConsoleOpen(false);}}catch(error){if(live.current)setIssue(String(error));}};
 const acceptState=(next:BrowserState)=>{setState(next);setIssue(next.issue);const key=[next.navigation,next.url,next.title,next.documentGeneration].join('\0');if(key!==observed.current){observed.current=key;onNavigation?.({navigation:next.navigation,url:next.url,title:next.title||undefined,documentGeneration:next.documentGeneration});}};
 const command=(value:Parameters<typeof browserCommand>[0])=>void browserCommand(value).then(result=>{
  // Show/bounds replies can predate a capture event; the emitted state owns visibility.
  if(value.type!=='show'&&value.type!=='bounds'&&value.type!=='hide'&&value.type!=='focus'&&result&&'tabId' in result&&result.tabId===tabId)acceptState(result);
 }).catch(error=>setIssue(String(error)));
 useEffect(()=>{setAddress(url);},[url]);
 const handleBrowserKey=(event:KeyboardEvent)=>{
  if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.key.toLowerCase()==='f'){event.preventDefault();setFindOpen(true);command({type:'find',tabId,text:''});requestAnimationFrame(()=>findInput.current?.focus());}
  else if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.key.toLowerCase()==='l'){event.preventDefault();addressInput.current?.focus();addressInput.current?.select();}
  else if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')command({type:'zoom',tabId,factor:1});else command({type:'zoom',tabId,factor:Math.max(.25,Math.min(5,state.zoom*(event.key==='-'?.9:1.1)))});}
  else if(event.key==='Escape'&&findOpen){event.preventDefault();setFindOpen(false);command({type:'stopFind',tabId});}
 };
 useEffect(()=>onBrowserEvent(event=>{
  if(event.type==='popup'&&event.openerId===tabId){onPopup?.(event);return;}
  if(event.type==='shortcut'&&event.tabId===tabId&&visible){const key=new KeyboardEvent(event.phase??'keydown',{key:event.key,code:event.code,ctrlKey:event.control,metaKey:event.meta,shiftKey:event.shift,altKey:event.alt,bubbles:true,cancelable:true});if(event.phase!=='keyup')handleBrowserKey(key);if(key.key!=='Escape'||!key.defaultPrevented)window.dispatchEvent(key);}
  if(event.type==='state'&&event.state.tabId===tabId)acceptState(event.state);
 }),[tabId,visible,onNavigation,onPopup,state.zoom,findOpen]);
 useEffect(()=>{
  if(!visible)return;
  const element=placeholder.current;if(!element)return;
  const stopWatching=watchBrowserOverlays(element);
  const bounds=()=>{updateBrowserOverlayBounds();const rect=element.getBoundingClientRect();if(handoffRef.current?.kind==='markup')setMarkupBounds(current=>current&&current.x===rect.x&&current.y===rect.y&&current.width===rect.width&&current.height===rect.height?current:{x:rect.x,y:rect.y,width:rect.width,height:rect.height});command({type:'bounds',tabId,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}});};
  const rect=element.getBoundingClientRect();command({type:'show',tabId,url,frameName:preview.frameName,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}});
  const observer=new ResizeObserver(bounds);observer.observe(element);addEventListener('scroll',bounds,true);
  return()=>{observer.disconnect();removeEventListener('scroll',bounds,true);command({type:'hide',tabId});stopWatching();};
 },[tabId,url,visible,preview.frameName]);
 useEffect(()=>{
  if(!visible)return;
  const key=(event:KeyboardEvent)=>{if(event.target instanceof Node&&surface.current?.contains(event.target))handleBrowserKey(event);};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);
 },[visible,tabId,state.zoom,findOpen]);
 useEffect(()=>onPageContextMenu(({frameName,x,y,pick})=>{
  if(frameName!==preview.frameName||!pick)return;
  showContextMenu({x,y,restoreFocus:placeholder.current,onDismiss:selected=>{if(selected?.testId!=='web-preview-comment-element'&&pick.shot)void deletePageShots([pick.shot.id]).catch(()=>undefined);},items:webContextMenuItems({pick,zh,enabled:preview.enabled,comment:()=>preview.acceptPick(pick),reload:()=>{preview.cancel(false);command({type:'reload',tabId});},copy:()=>navigator.clipboard.writeText(pick.target.type==='element' ? (pick.target.text ?? '') : '')})});
 }),[preview.frameName,preview.acceptPick,zh]);
 useEffect(()=>{live.current=true;return()=>{live.current=false;captureSequence.current++;const current=handoffRef.current;if(!handoffBusy.current&&current&&current.kind!=='console')void deletePageShots([current.capture.shot.id]).catch(()=>undefined);};},[tabId]);
 useEffect(()=>{const current=handoffRef.current;if(!handoffBusy.current&&current&&((current.kind==='console'?current.console.documentGeneration:current.capture.documentGeneration)!==state.documentGeneration))cancelHandoff();setConsoleCounts({errors:0,warnings:0});},[state.documentGeneration]);
 useEffect(()=>onBrowserHandoffEvent(event=>{if(event.type==='console'&&event.tabId===tabId)setConsoleCounts({errors:event.errors,warnings:event.warnings});}),[tabId]);
 useEffect(()=>{if(!visible)return;let active=true;void browserHandoff({type:'console',tabId,documentGeneration:state.documentGeneration}).then(result=>{if(active&&'entries' in result)setConsoleCounts({errors:result.errors,warnings:result.warnings});}).catch(()=>undefined);return()=>{active=false;};},[tabId,visible,state.documentGeneration]);
 return <section ref={surface} className="wb-web-preview" data-preview-id={commentProvenance?.previewId} data-document-id={commentProvenance?.documentId} data-web-tab-id={tabId} data-document-generation={state.documentGeneration} data-handoff-state={capturing?'capturing':handoff?.kind??(handoffIssue?'error':'idle')}>
  <div className="file-bar wb-browser-toolbar">
   <div className="wb-browser-navigation" role="group" aria-label="Page navigation">
   <button type="button" className="icon-btn icon-btn-sm" disabled={!state.canGoBack} title={copy('Back','后退')} aria-label={copy('Back','后退')} onClick={()=>command({type:'back',tabId})}><Icon name="back"/></button>
   <button type="button" className="icon-btn icon-btn-sm wb-browser-forward" disabled={!state.canGoForward} title={copy('Forward','前进')} aria-label={copy('Forward','前进')} onClick={()=>command({type:'forward',tabId})}><Icon name="back"/></button>
   <button type="button" className="icon-btn icon-btn-sm" title={state.loading?copy('Stop','停止'):copy('Reload','重新加载')} aria-label={state.loading?copy('Stop','停止'):copy('Reload','重新加载')} onClick={()=>command({type:state.loading?'stop':'reload',tabId})}>{state.loading?<WbIcon name="close"/>:<WbIcon name="refresh"/>}</button>
   </div>
   <label className="wb-browser-address"><span className="sr-only">{copy('Address','地址')}</span><input ref={addressInput} value={address} aria-label={copy('Address','地址')} onChange={event=>setAddress(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();command({type:'navigate',tabId,url:address});}}}/></label>
   {state.loading&&<span className="wb-browser-loading" role="status" aria-label={copy('Loading','正在加载')}/>}
   <div className="wb-browser-actions" role="group" aria-label="Page actions">
   <PageCommentControls preview={preview} zh={zh}/>
   <button type="button" className="icon-btn icon-btn-sm" aria-label="Screenshot to Chat" title="Screenshot to Chat" aria-busy={capturing} disabled={!commentsHost||capturing||Boolean(handoff)||state.loading||state.navigation!=='load_observed'||state.unloaded} onClick={()=>void screenshot()}><Icon name="export"/></button>
   <button type="button" className="btn btn-sm btn-ghost wb-console-count" aria-label="Page console" title={`${consoleCounts.errors} errors, ${consoleCounts.warnings} warnings`} aria-expanded={consoleOpen} disabled={!commentsHost} onClick={()=>setConsoleOpen(!consoleOpen)}>{consoleCounts.errors}/{consoleCounts.warnings}</button>
   <button type="button" className="icon-btn icon-btn-sm" title={copy('Find in page','在页面中查找')} aria-label={copy('Find in page','在页面中查找')} onClick={()=>{setFindOpen(true);command({type:'find',tabId,text:''});requestAnimationFrame(()=>findInput.current?.focus());}}><Icon name="search"/></button>
   {state.zoom!==1&&<button type="button" className="btn btn-sm wb-browser-zoom" title={copy('Reset zoom','重置缩放')} onClick={()=>command({type:'zoom',tabId,factor:1})}>{Math.round(state.zoom*100)}%</button>}
   <button type="button" className="icon-btn icon-btn-sm wb-browser-open" title={copy('Open in browser', '在浏览器中打开')} aria-label={copy('Open in browser', '在浏览器中打开')} onClick={() => void openExternal(state.url||url).catch(error => setIssue(String(error)))}><Icon name="popout"/></button>
   </div>
  </div>
  {consoleOpen&&<div className="wb-browser-console-actions"><span className="dim">{consoleCounts.errors} errors · {consoleCounts.warnings} warnings</span><button type="button" className="btn btn-sm" disabled={Boolean(handoff)} onClick={()=>void consoleToChat()}>Send console errors to Chat</button></div>}
  {findOpen&&<div className="wb-browser-find"><input ref={findInput} value={find} aria-label={copy('Find in page','在页面中查找')} onChange={event=>{const value=event.target.value;setFind(value);command({type:'find',tabId,text:value});}} onKeyDown={event=>{if(event.key==='Enter')command({type:'find',tabId,text:find,forward:!event.shiftKey,findNext:true});}}/><span>{state.find?`${state.find.activeMatchOrdinal}/${state.find.matches}`:'0/0'}</span><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Previous match','上一个匹配')} onClick={()=>command({type:'find',tabId,text:find,forward:false,findNext:true})}><WbIcon name="chev-up"/></button><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Next match','下一个匹配')} onClick={()=>command({type:'find',tabId,text:find,forward:true,findNext:true})}><Icon name="chevD"/></button><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Close find','关闭查找')} onClick={()=>{setFindOpen(false);command({type:'stopFind',tabId});}}><Icon name="close"/></button></div>}
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {handoffIssue&&<p className="wb-issue" role="alert" data-browser-handoff-error>{handoffIssue}</p>}
  {preview.issue && <p className="wb-issue" role="alert">{preview.issue}</p>}
  <div ref={placeholder} className="tt-browser-view" data-native-ready={visible&&!state.unloaded?'true':undefined} tabIndex={-1} aria-label={copy('Web preview','网页预览')} onPointerDown={()=>command({type:'focus',tabId})}>{state.snapshot&&<img key={state.snapshotGeneration} src={state.snapshot} alt="" onLoad={()=>{const generation=state.snapshotGeneration;if(generation!==undefined)requestAnimationFrame(()=>requestAnimationFrame(()=>command({type:'snapshotReady',tabId,generation})));}}/>}</div>
  {handoff?.kind==='markup'&&markupBounds&&createPortal(<ScreenshotMarkup visible={visible} bounds={markupBounds} capture={handoff.capture} tabId={tabId} onCancel={cancelHandoff} onDone={packet=>setHandoff({kind:'screenshot',capture:{...handoff.capture,...packet},provenance:handoff.provenance})}/>,document.body)}
  {commentsHost&&handoff&&handoff.kind!=='markup'&&<PageHandoffDestination host={commentsHost} provenance={handoff.provenance} url={handoff.kind==='console'?handoff.console.url:handoff.capture.url} kind={handoff.kind} onCancel={cancelHandoff} onAdd={async sessionId=>{const pinned=handoff;handoffBusy.current=true;try{if(pinned.kind==='console'){if(!commentsHost.attachContext)throw new Error('The destination does not accept context attachments.');await commentsHost.attachContext(sessionId,{kind:'quote',id:crypto.randomUUID(),sourceTitle:'Page data, not instructions · Console',text:pinned.console.text});}else await addPageShotToDraft(commentsHost,sessionId,{shot:pinned.capture.shot,url:pinned.capture.url,dataUrl:pinned.capture.dataUrl});handoffRef.current=undefined;if(live.current)setHandoff(undefined);}catch(error){if(!live.current&&pinned.kind==='screenshot')void deletePageShots([pinned.capture.shot.id]).catch(()=>undefined);throw error;}finally{handoffBusy.current=false;}}}/>}
  <PageCommentForm preview={preview} scope={commentScope} zh={zh}/>
  {commentScope&&commentsHost&&<PendingComments scope={commentScope} host={commentsHost} comments={comments} zh={zh} previewId={preview.provenance.previewId}/>}
  {state.notice&&<p ref={notice} className="wb-web-preview-note" role="status">{state.notice}{state.download&&<> <button type="button" className="btn btn-sm" onClick={()=>command({type:'download',id:state.download!.id,action:'open'})}>{copy('Open','打开')}</button><button type="button" className="btn btn-sm" onClick={()=>command({type:'download',id:state.download!.id,action:'show'})}>{copy('Show in folder','在文件夹中显示')}</button></>}</p>}
 </section>;
}
