import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PagePick, PageRect } from '@threadterm/protocol';
import { MAX_CHAT_IMAGE_BYTES } from '@threadterm/protocol';
import { browserHandoff, cancelPagePick, deletePageShots, markPageTarget, pickPageTarget, readPageShot } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import { addPageComment, MAX_REVIEW_COMMENT_BODY, pageCommentLabel, pageTargetRef, type CommentScope, type PageCommentProvenance } from '../reviewComments';
import { registerPagePreview } from '../pageComments';
import type { PageShotPacket, ShotDraft, usePageShotDraft } from '../pageShotDraft';
import { SurfaceDialog } from './SurfaceDialog';
import { WbIcon } from '../workbench/icons';
import { Select } from './ui/Select';
import { useBrowserOcclusion } from '../browserOcclusion';
import { useModalFocus } from '../useModalFocus';
import { MARKUP_COLORS, MAX_MARKUP_MARKS, MAX_MARKUP_POINTS, markupArrow, markupPoint, markupRect, serializeMarkup, type MarkupColor, type MarkupMark, type MarkupTool } from '../../../desktop/src/browser/markup';
import type { BrowserCaptureResult } from '../../../desktop/src/browser/handoffTypes';

/** Frame names are the only renderer identity the desktop picker accepts.  Keep this outside the iframe key so reloads
 * do not strand a pending picker in another frame. */

export function usePageCommentPreview(url:string, scope?:CommentScope, host?:FileCommentsHost, zh=false, provenance?:PageCommentProvenance, native?:{element:RefObject<HTMLElement|null>;focus:()=>void}) {
 const [frameName]=useState(()=>`tt-preview-${crypto.randomUUID()}`), iframe=useRef<HTMLIFrameElement>(null), commentButton=useRef<HTMLButtonElement>(null);
 const [picking,setPicking]=useState(false),[pick,setPick]=useState<PagePick>(),[pickScopeKey,setPickScopeKey]=useState(''),[pickProvenance,setPickProvenance]=useState<PageCommentProvenance>(),[issue,setIssue]=useState<string>();
 const pickRef=useRef<PagePick|undefined>(undefined);pickRef.current=pick;
 const generation=useRef(0),pickingRef=useRef(false);
 const enabled=Boolean(scope&&host),scopeKey=scope?`${scope.projectId}\0${scope.root}`:'';
 const error=(value:unknown)=>{const reason=value instanceof Error?value.message:String(value);return reason==='review_comments_full'?(zh?'此文件夹已有 200 条审查意见。请先加入消息或删除一些。':'This folder already has 200 comments. Add them to the message or remove some first.'):reason==='review_comment_empty'?(zh?'请先填写审查意见。':'Enter a comment first.'):reason==='review_comment_too_long'?(zh?'一条审查意见最多 4000 个字符。':'A comment can be at most 4000 characters.'):(zh?'无法完成页面评论。':'The page comment could not be completed.');};
 const fail=(value:unknown)=>setIssue(error(value));
 const surface=()=>native?.element.current??iframe.current;
 const visible=()=>Boolean(surface()?.getClientRects().length);
 const previewId=provenance?.previewId ?? frameName;
 const provenanceKey=[previewId,provenance?.sessionId,provenance?.sessionTitle,provenance?.providerId,provenance?.requestId,provenance?.documentId,provenance?.tabId,provenance?.workspaceId,provenance?.navigation,provenance?.sequence].join('\0');
 const snapshotProvenance=():PageCommentProvenance=>({...provenance,previewId});
 useEffect(()=>registerPagePreview(previewId,provenance?.documentId,provenance?.navigation,frameName,visible),[previewId,provenance?.documentId,provenance?.navigation,frameName]);
 const clear=()=>void markPageTarget({frameName}).catch(fail);
 const discard=(value:PagePick)=>{ clear(); if(value.shot) void deletePageShots([value.shot.id]).catch(fail); };
 const cancel=(focus=true)=>{ const pending=pickingRef.current,selected=pickRef.current;generation.current++;pickingRef.current=false;if(pending)void cancelPagePick(frameName).catch(fail);if(selected)discard(selected);if(pending||selected){setPicking(false);pickRef.current=undefined;setPick(undefined);setPickScopeKey('');setPickProvenance(undefined);if(focus)requestAnimationFrame(()=>commentButton.current?.focus());} };
 useEffect(()=>()=>cancel(false),[frameName]);
 useEffect(()=>{cancel(false);},[url,scopeKey,enabled,provenanceKey]);
 const begin=async()=>{
  if(!enabled||picking)return;
  const rect=surface()?.getBoundingClientRect(); if(!rect)return;
  native?.focus()??iframe.current?.focus();setIssue(undefined);pickingRef.current=true;setPicking(true);const current=++generation.current;
   try { const next=await pickPageTarget({frameName,frameRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}); if(current!==generation.current){if(next?.shot)void deletePageShots([next.shot.id]).catch(fail);return;} pickingRef.current=false;setPicking(false); if(next){pickRef.current=next;setPickScopeKey(scopeKey);setPickProvenance(snapshotProvenance());setPick(next);void markPageTarget({frameName,target:pageTargetRef(next.target)}).catch(fail);}else requestAnimationFrame(()=>commentButton.current?.focus()); }
  catch(error){if(current===generation.current){pickingRef.current=false;setPicking(false);fail(error);}}
 };
 const added=()=>{ if(pickRef.current)clear();pickRef.current=undefined;setPick(undefined);setPickScopeKey('');setPickProvenance(undefined);requestAnimationFrame(()=>commentButton.current?.focus()); };
  const acceptPick=(next:PagePick)=>{if(!enabled)return;generation.current++;if(pickingRef.current)void cancelPagePick(frameName).catch(fail);if(pickRef.current)discard(pickRef.current);pickingRef.current=false;setPicking(false);pickRef.current=next;setPickScopeKey(scopeKey);setPickProvenance(snapshotProvenance());setPick(next);void markPageTarget({frameName,target:pageTargetRef(next.target)}).catch(fail);};
 useEffect(()=>{if(!picking)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();cancel();}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[picking]);
 return {enabled,frameName,iframe,commentButton,picking,pick,pickScopeKey,scopeKey,issue,provenance:pickProvenance??snapshotProvenance(),begin,cancel,added,discard,acceptPick};
}

export function PageCommentControls({preview,zh}:{preview:ReturnType<typeof usePageCommentPreview>;zh:boolean}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 if(!preview.enabled)return null;
 if(preview.pick)return null;
 return <><button ref={preview.commentButton} type="button" className="btn btn-sm" aria-pressed={preview.picking} onClick={preview.picking?()=>preview.cancel():()=>void preview.begin()}>{preview.picking?copy('Cancel','取消'):copy('Comment','评论')}</button>{preview.picking&&<span className="wb-page-comment-hint" role="status">{copy('Click an element or drag an area · ↑ parent · Esc cancels','点击元素或拖动选择区域 · ↑ 选择父级 · Esc 取消')}</span>}</>;
}

export function PageCommentForm({preview,scope,zh}:{preview:ReturnType<typeof usePageCommentPreview>;scope?:CommentScope;zh:boolean}) {
 const [body,setBody]=useState(''),[issue,setIssue]=useState<string>(); const copy=(en:string,cn:string)=>zh?cn:en;
 const pick=preview.pick;
 useEffect(()=>{setBody('');setIssue(undefined);},[pick]);
 if(!scope||!pick||preview.pickScopeKey!==preview.scopeKey)return null;
 const cancel=()=>{preview.discard(pick);preview.added();};
 const add=()=>{if(!body.trim())return;try{addPageComment({...scope,...pick,body,provenance:preview.provenance});preview.added();}catch(error){const reason=error instanceof Error?error.message:'';setIssue(reason==='review_comments_full'?copy('This folder already has 200 comments. Add them to the message or remove some first.','此文件夹已有 200 条审查意见。请先加入消息或删除一些。'):reason==='review_comment_empty'?copy('Enter a comment first.','请先填写审查意见。'):reason==='review_comment_too_long'?copy('A comment can be at most 4000 characters.','一条审查意见最多 4000 个字符。'):copy('The page comment could not be saved.','无法保存页面评论。'));}};
 return <div className="wb-review-comment-form wb-page-comment-form">
  <div className="wb-page-comment-target">{pick.shot&&<img src={pick.shot.thumbnail} alt={copy('Selected page area','已选页面区域')}/>}<span className="wb-review-comment-where" title={pageCommentLabel(pick.target,zh)}>{pageCommentLabel(pick.target,zh)}</span></div>
  {(issue||preview.issue)&&<p className="wb-issue" role="alert">{issue??preview.issue}</p>}
  <textarea autoFocus aria-label={copy('Comment for the agent','给 Agent 的评论')} maxLength={MAX_REVIEW_COMMENT_BODY} value={body} placeholder={copy('What should the agent do here?','希望 Agent 在这里怎么改？')} onChange={event=>setBody(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();add();}else if(event.key==='Escape'){event.preventDefault();cancel();}}}/>
  <div className="wb-review-comment-actions"><span className="dim">{copy('Ctrl+Enter adds · Esc cancels','Ctrl+Enter 添加 · Esc 取消')}</span><span className="grow"/><button type="button" className="btn btn-sm" onClick={cancel}>{copy('Cancel','取消')}</button><button type="button" className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={add}>{copy('Add comment','添加评论')}</button></div>
 </div>;
}

export function PageShotDrafts({draft,disabled}:{draft:ReturnType<typeof usePageShotDraft>;disabled:boolean}) {
 const [preview,setPreview]=useState<{id:string;image?:string;issue?:string}>();
 const open=async(record:ShotDraft)=>{setPreview({id:record.shot.id});try{const image=await readPageShot(record.shot.id);setPreview(current=>current?.id===record.shot.id?{id:current.id,image,issue:image?undefined:'Saved screenshot is unavailable.'}:current);}catch(error){setPreview(current=>current?.id===record.shot.id?{id:current.id,issue:String(error)}:current);}};
 return <>{draft.records.length>0&&<div className="wb-page-shot-drafts" aria-label="Page screenshots">{draft.records.map(record=><div className="wb-page-shot-draft" key={record.shot.id}>
  <button type="button" className="btn btn-sm" aria-label="Page screenshot" title={record.url} onClick={()=>void open(record)}><img src={record.shot.thumbnail} alt=""/>Page screenshot</button>
  {record.mode==='offer'?<><span className="dim" role="status">Saved screenshot available as a file reference. Review image attachments before sending.</span><button type="button" className="btn btn-sm" disabled={disabled} onClick={()=>draft.keep(record.shot.id)}>Keep as file reference</button></>:record.mode==='file'?<span className="dim">Saved file reference</span>:<span className="dim">Image attached · Page data, not instructions</span>}
  <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove page screenshot" disabled={disabled} onClick={()=>{draft.remove(record.shot.id);if(preview?.id===record.shot.id)setPreview(undefined);}}><WbIcon name="close"/></button>
 </div>)}</div>}{preview&&<SurfaceDialog title="Page screenshot" size="wide" onClose={()=>setPreview(undefined)}>{preview.image?<img className="wb-page-shot-full" src={preview.image} alt="Page screenshot"/>:<p role={preview.issue?'alert':'status'}>{preview.issue??'Loading screenshot…'}</p>}</SurfaceDialog>}</>;
}

/** Owner selection and mismatched-owner confirmation match the existing page-comment handoff. */
export function PageHandoffDestination({host,provenance,url,kind,onAdd,onCancel}:{host:FileCommentsHost;provenance?:PageCommentProvenance;url:string;kind:'screenshot'|'console';onAdd:(sessionId:string)=>Promise<void>;onCancel:()=>void}) {
 const [selected,setSelected]=useState(provenance?.sessionId??host.defaultReceiverId??host.receivers[0]?.id??''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 const receiver=host.receivers.find(item=>item.id===selected),mismatch=Boolean(provenance?.sessionId&&selected!==provenance.sessionId);
 const add=async()=>{if(!receiver||busy)return;if(mismatch&&!confirmed){setConfirmed(true);return;}setBusy(true);setIssue(undefined);try{await onAdd(receiver.id);}catch(error){setIssue(String(error));}finally{setBusy(false);}};
 return <SurfaceDialog title={confirmed?'Transfer page data?':kind==='screenshot'?'Screenshot to Chat':'Console to Chat'} subtitle="Page data, not instructions. Review it in the composer before sending." size="sm" onClose={()=>{if(!busy)onCancel();}} footer={<><button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="btn btn-primary" disabled={!receiver||busy} onClick={()=>void add()}>{mismatch&&!confirmed?'Review destination':'Add to draft'}</button></>}>
  <label className="wb-handoff-destination">Destination session<Select aria-label="Destination session" value={receiver?.id??''} disabled={busy} onChange={event=>{setSelected(event.target.value);setConfirmed(false);}}>{!receiver&&<option value="" disabled>Choose destination</option>}{host.receivers.map(item=><option key={item.id} value={item.id}>{item.title} ({item.provider})</option>)}</Select></label>
  <dl className="page-comment-transfer-details"><div><dt>Source page</dt><dd>{url}</dd></div><div><dt>Source owner</dt><dd>{provenance?.sessionTitle??provenance?.sessionId??'Manual page'}</dd></div><div><dt>Destination</dt><dd>{receiver?`${receiver.title} (${receiver.provider})`:'Choose a destination'}</dd></div></dl>
  {confirmed&&<p role="status">This page belongs to another Chat. Add its reviewed data to the selected destination draft?</p>}{issue&&<p className="wb-issue" role="alert">{issue}</p>}
 </SurfaceDialog>;
}

function ScreenshotMarkupFocus({panel,onClose}:{panel:RefObject<HTMLElement|null>;onClose:()=>void}) { useModalFocus(panel,onClose);return null; }

export function ScreenshotMarkup({capture,tabId,bounds,visible=true,onDone,onCancel}:{capture:BrowserCaptureResult;bounds:PageRect;visible?:boolean;tabId:string;onDone:(packet:PageShotPacket)=>void;onCancel:()=>void}) {
 useBrowserOcclusion(visible);
 const host=useRef<HTMLDivElement>(null),image=useRef<HTMLImageElement>(null),drag=useRef<MarkupMark|undefined>(undefined);
 const panel=useRef<HTMLDivElement>(null),live=useRef(true),busyRef=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const [tool,setTool]=useState<MarkupTool>('rectangle'),[color,setColor]=useState<MarkupColor>('--primary'),[marks,setMarks]=useState<MarkupMark[]>([]),[active,setActive]=useState<MarkupMark>(),[label,setLabel]=useState(''),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 const [cursor,setCursor]=useState({x:.25,y:.25}),[anchor,setAnchor]=useState<{x:number;y:number}>();
 const commit=(mark:MarkupMark)=>{if(marks.length>=MAX_MARKUP_MARKS){setIssue('Use Undo before adding more markup.');return;}setMarks([...marks,mark]);};
 const point=(event:{clientX:number;clientY:number})=>{const rect=host.current!.getBoundingClientRect();return markupPoint(event.clientX-rect.left,event.clientY-rect.top,rect.width,rect.height);};
 const start=(p:{x:number;y:number})=>{if(tool==='text'){if(!label.trim()){setIssue('Enter a text label first.');return;}commit({tool,color,points:[p],text:label});return;}const mark:MarkupMark={tool,color,points:[p,p]};drag.current=mark;setActive(mark);};
 const move=(p:{x:number;y:number})=>{const mark=drag.current;if(!mark)return;const points=mark.tool==='pen'?(mark.points.length<MAX_MARKUP_POINTS?[...mark.points,p]:mark.points):[mark.points[0],p];drag.current={...mark,points};setActive(drag.current);};
 const end=()=>{if(drag.current)commit(drag.current);drag.current=undefined;setActive(undefined);};
 const finish=async()=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setIssue(undefined);
  try {
   const canvas=document.createElement('canvas');canvas.width=capture.width;canvas.height=capture.height;const ctx=canvas.getContext('2d');if(!ctx||!image.current?.complete)throw new Error('Screenshot is not ready.');
   ctx.drawImage(image.current,0,0,canvas.width,canvas.height);const tokens=getComputedStyle(host.current!);
   // Round-trip validation bounds every path and label before rasterizing.
   const verified:MarkupMark[]=JSON.parse(serializeMarkup(marks));
   for(const mark of verified){ctx.strokeStyle=tokens.getPropertyValue(mark.color).trim();ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';const [a,b=a]=mark.points,w=canvas.width,h=canvas.height;
    if(mark.tool==='text'){ctx.font='20px sans-serif';ctx.fillText(mark.text!,a.x*w,a.y*h);}
    else if(mark.tool==='rectangle'){const rect=markupRect(a,b);ctx.strokeRect(rect.x*w,rect.y*h,rect.width*w,rect.height*h);}
    else{ctx.beginPath();ctx.moveTo(a.x*w,a.y*h);for(const p of mark.points.slice(1))ctx.lineTo(p.x*w,p.y*h);if(mark.tool==='arrow')for(const tip of markupArrow(a,b,w,h)){ctx.moveTo(b.x*w,b.y*h);ctx.lineTo(tip.x*w,tip.y*h);}ctx.stroke();}
   }
   let output=canvas,dataUrl=output.toDataURL('image/png');
   while(dataUrl.length>MAX_CHAT_IMAGE_BYTES-1024){const smaller=document.createElement('canvas');smaller.width=Math.max(1,Math.floor(output.width*.8));smaller.height=Math.max(1,Math.floor(output.height*.8));if(smaller.width===output.width&&smaller.height===output.height)throw new Error('Screenshot exceeds image size limit.');const context=smaller.getContext('2d');if(!context)throw new Error('Could not resize the screenshot.');context.drawImage(output,0,0,smaller.width,smaller.height);output=smaller;dataUrl=output.toDataURL('image/png');}
   const saved=await browserHandoff({type:'saveMarkup',tabId,documentGeneration:capture.documentGeneration,shotId:capture.shot.id,dataUrl});
   if(!('shot' in saved))throw new Error('Screenshot could not be saved.');if(!live.current){void deletePageShots([saved.shot.id]).catch(()=>undefined);return;}onDone({shot:saved.shot,url:capture.url,dataUrl:saved.dataUrl});
  }catch(error){if(live.current)setIssue(String(error));}finally{busyRef.current=false;if(live.current)setBusy(false);}
 };
 return <div ref={panel} className="wb-screenshot-editor" hidden={!visible} style={{left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height,display:visible?undefined:'none'}} role="dialog" aria-modal="true" aria-label="Screenshot markup" onKeyDown={event=>{if(event.key==='Enter'&&!(event.target instanceof HTMLButtonElement)&&!(event.target instanceof Element&&event.target.closest('[role="combobox"]'))){event.preventDefault();if(!drag.current&&!anchor)void finish();}}}>
  {visible&&<ScreenshotMarkupFocus panel={panel} onClose={()=>{if(!busyRef.current)onCancel();}}/>}
  <div className="wb-markup-toolbar">{(['rectangle','arrow','pen','text'] as const).map(name=><button type="button" className="btn btn-sm btn-ghost" key={name} aria-pressed={tool===name} onClick={()=>setTool(name)}>{name[0].toUpperCase()+name.slice(1)}</button>)}<button type="button" className="btn btn-sm" disabled={!marks.length||busy} onClick={()=>setMarks(marks.slice(0,-1))}>Undo</button></div>
  <div className="wb-markup-toolbar"><label>Colour<Select aria-label="Markup colour" value={color} onChange={event=>setColor(event.target.value as MarkupColor)}>{MARKUP_COLORS.map((token,index)=><option key={token} value={token}>{['Accent','Danger','Text'][index]}</option>)}</Select></label>{tool==='text'&&<label>Text label<input aria-label="Text label" maxLength={120} value={label} onChange={event=>setLabel(event.target.value)}/></label>}</div>
  <div className="wb-markup-stage" ref={host} tabIndex={0} autoFocus aria-label="Screenshot canvas" onPointerDown={event=>{if(busy||event.button!==0)return;event.preventDefault();host.current?.focus();event.currentTarget.setPointerCapture(event.pointerId);start(point(event));}} onPointerMove={event=>{if(drag.current)move(point(event));}} onPointerUp={end} onPointerCancel={()=>{drag.current=undefined;setActive(undefined);}} onKeyDown={event=>{
   if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();const delta=event.shiftKey?.05:.01,next={x:Math.max(0,Math.min(1,cursor.x+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0))),y:Math.max(0,Math.min(1,cursor.y+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)))};setCursor(next);if(anchor)move(next);}
   if(event.key===' '){event.preventDefault();event.stopPropagation();if(tool==='text')start(cursor);else if(anchor){end();setAnchor(undefined);}else{setAnchor(cursor);start(cursor);}}
  }}>
   <img ref={image} src={capture.dataUrl} alt="Page screenshot for markup" draggable={false}/>
   <svg viewBox={`0 0 ${capture.width} ${capture.height}`} aria-hidden="true">{[...marks,...(active?[active]:[])].map((mark,index)=>{const [a,b=a]=mark.points,w=capture.width,h=capture.height,style={stroke:`var(${mark.color})`,fill:'none',strokeWidth:3,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};if(mark.tool==='text')return <text key={index} x={a.x*w} y={a.y*h} fill={`var(${mark.color})`} fontSize={20}>{mark.text}</text>;if(mark.tool==='rectangle'){const rect=markupRect(a,b);return <rect key={index} x={rect.x*w} y={rect.y*h} width={rect.width*w} height={rect.height*h} style={style}/>;}return <g key={index} style={style}><polyline points={mark.points.map(p=>`${p.x*w},${p.y*h}`).join(' ')}/>{mark.tool==='arrow'&&markupArrow(a,b,w,h).map((tip,i)=><line key={i} x1={b.x*w} y1={b.y*h} x2={tip.x*w} y2={tip.y*h}/>)}</g>;})}<circle className="wb-markup-cursor" cx={cursor.x*capture.width} cy={cursor.y*capture.height} r={5}/></svg>
  </div>
  <p className="dim">Drag to draw. Keyboard: arrows move, Space starts/ends a mark. Enter confirms · Esc cancels.</p>{issue&&<p className="wb-issue" role="alert">{issue}</p>}
  <div className="wb-markup-toolbar"><button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="btn btn-sm btn-primary" disabled={busy||Boolean(active)} onClick={()=>void finish()}>Done</button></div>
 </div>;
}
