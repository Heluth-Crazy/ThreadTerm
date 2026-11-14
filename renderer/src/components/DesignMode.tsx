import { useEffect, useRef, useState } from 'react';
import type { PageCssEdit, PagePick } from '@threadterm/protocol';
import { inspectPageTarget, markPageTarget } from '../bridge';
import { addPageComment, isPageComment, MAX_REVIEW_COMMENT_BODY, pageCommentLabel, pageTargetRef, removeReviewComments, type CommentScope, type PageComment } from '../reviewComments';
import { deliverDesignNotes } from '../designDelivery';
import { useBrowserOcclusion } from '../browserOcclusion';
import { WbIcon } from '../workbench/icons';
import type { usePageCommentPreview } from './PageComments';

type Preview=ReturnType<typeof usePageCommentPreview>;

/** The shared picker also serves saved-file comments; Design Mode is enabled only for the native browser. */
export function DesignToolbar({preview,zh}:{preview:Preview;zh:boolean}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>();
 useBrowserOcclusion(open);
 useEffect(()=>{if(!preview.pending.length)setOpen(false);},[preview.pending.length]);
 const send=async()=>{
  if(!preview.scope||!preview.host||busy)return;
  const revision=preview.revision();
  setBusy(true);setIssue(undefined);
  try{await deliverDesignNotes({scope:preview.scope,host:preview.host,comments:preview.pending,receiverId:preview.provenance.sessionId??preview.host.defaultReceiverId,zh});setOpen(false);if(preview.atRevision(revision))preview.done();}
  catch(error){setIssue(error instanceof Error?error.message:String(error));setOpen(true);}
  finally{setBusy(false);}
 };
 useEffect(()=>{
  if(!preview.enabled)return;
  void markPageTarget({frameName:preview.frameName,pins:preview.pending.map((note,index)=>({number:index+1,target:pageTargetRef(note.target)}))}).catch(()=>undefined);
 },[preview.frameName,preview.url,preview.provenance.documentId,preview.provenance.navigation,preview.pending.map(note=>note.id).join('|')]);
 if(!preview.enabled)return null;
 return <div className="dm-entry" data-testid="design-mode">
  {preview.pending.length>0?<>
   <button ref={preview.commentButton} type="button" className="cg-ghost cg-primary" data-testid="design-send-count" disabled={busy} onClick={()=>void send()}><WbIcon name="arrowUp"/>{copy('Send','发送')} <span className="cg-count">{preview.pending.length}</span></button>
   <button type="button" className="cg-ghost cg-icon" aria-label={copy('Pending notes','待发送标注')} aria-expanded={open} onClick={()=>setOpen(!open)}><WbIcon name="chevD"/></button>
  </>:<button ref={preview.commentButton} type="button" className={`cg-ghost${preview.active?' cg-accent':''}`} title={copy('Comment · Annotate (Ctrl+Shift+D)','评论 · 标注（Ctrl+Shift+D）')} aria-label={copy('Annotate','标注')} aria-pressed={preview.active} onClick={preview.toggle}><WbIcon name="annotate"/>{copy('Annotate','标注')}</button>}
  {open&&<div className="cg-pop dm-pending" role="region" aria-label={copy('Pending notes','待发送标注')} data-testid="design-pending">
   <div className="cg-sec"><span>{copy('Pending notes','待发送标注')}</span><button type="button" className="cg-ghost cg-end" disabled={busy} onClick={()=>{if(preview.scope)void removeReviewComments(preview.scope,preview.pending.map(note=>note.id)).catch(error=>setIssue(String(error)));}}>{copy('Clear all','清除全部')}</button></div>
   {preview.pending.map((note,index)=><div className="dm-pending-row" key={note.id}><span className="dm-pin-inline">{index+1}</span><span><b>{pageCommentLabel(note.target,zh)}</b><small>{note.body}</small></span><button type="button" className="cg-ghost cg-icon" aria-label={copy(`Remove note ${index+1}`,`删除标注 ${index+1}`)} disabled={busy} onClick={()=>{if(preview.scope)void removeReviewComments(preview.scope,[note.id]).catch(error=>setIssue(String(error)));}}><WbIcon name="close"/></button></div>)}
   <button type="button" className="cg-ghost" onClick={()=>{setOpen(false);void preview.begin();}}><WbIcon name="annotate"/>{copy('Continue annotating','继续标注')}</button>
   {issue&&<p role="alert" className="wb-issue">{issue}</p>}
  </div>}
 </div>;
}

export function DesignHint({preview,zh,onMarkup}:{preview:Preview;zh:boolean;onMarkup:(tool:'pen'|'ellipse'|'rectangle'|'arrow')=>void}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 if(!preview.active)return null;
 return <div className="dm-hint" data-testid="design-hint">
  <div className="cg-seg" role="group" aria-label={copy('Pick a target','选择目标')}>{(['element','area'] as const).map(tool=><button type="button" key={tool} title={tool==='element'?copy('Select element','选择元素'):copy('Mark area','标记区域')} aria-label={tool==='element'?copy('Select element','选择元素'):copy('Mark area','标记区域')} aria-pressed={preview.tool===tool} onClick={()=>{preview.cancel(false);preview.setTool(tool);requestAnimationFrame(()=>void preview.begin(tool));}}><WbIcon name={tool==='element'?'pick-element':'pick-area'}/></button>)}</div>
  <div className="cg-seg" role="group" aria-label={copy('Markup tools','绘图工具')}>{([['pen','mark-draw','Draw','绘制'],['ellipse','mark-ellipse','Ellipse','椭圆'],['rectangle','mark-rect','Rectangle','矩形'],['arrow','mark-arrow','Arrow','箭头']] as const).map(([tool,icon,en,cn])=><button type="button" key={tool} aria-label={copy(en,cn)} title={copy(en,cn)} onClick={()=>onMarkup(tool)}><WbIcon name={icon}/></button>)}</div>
  <span className="dm-hint-text">{preview.tool==='area'?copy('Drag an area · Shift locks axis · Alt draws from centre','拖动选择区域 · Shift 锁定轴 · Alt 从中心绘制'):copy('Click an element · Shift+click to add · ↑ ↓ parent / child · Double-click text to edit','点击元素 · Shift+点击添加 · ↑ ↓ 父级 / 子级 · 双击编辑文字')}</span>
  <label className="dm-batch"><span>{copy('Batch edits','批量')}</span><input type="checkbox" role="switch" aria-label={copy('Batch edits','批量')} checked={preview.batch} onChange={event=>preview.setBatch(event.target.checked)}/></label>
  <span className="dm-divider"/><button type="button" className="cg-ghost" aria-label={copy('Done','完成')} onClick={preview.done}>{copy('Done','完成')}<kbd className="cg-kbd">Esc</kbd></button>
 </div>;
}

export function DesignNoteCard({preview,scope,zh}:{preview:Preview;scope?:CommentScope;zh:boolean}) {
 const pick=preview.pick,noteKey=pick?.shot?.id??pick,copy=(en:string,cn:string)=>zh?cn:en;
 const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[issue,setIssue]=useState<string>(),[css,setCss]=useState(false),[filter,setFilter]=useState('');
 const [styles,setStyles]=useState<Record<string,string>>({}),[cssEdits,setCssEdits]=useState<PageCssEdit[]>([]);
 const saved=useRef<PageComment|undefined>(undefined),auto=useRef(false),serial=useRef(0);
 const sending=useRef<PagePick|undefined>(undefined);
 useBrowserOcclusion(Boolean(pick));
 useEffect(()=>{setBusy(false);setBody('');setIssue(undefined);setCss(false);setFilter('');setCssEdits(pick?.cssEdits??[]);setStyles(pick?.target.type==='element'?(pick.target.styles??pick.target.computedStyles??{}):{});saved.current=undefined;auto.current=false;serial.current++;},[noteKey]);
 const submit=async(toChat=false)=>{
  if(!scope||!pick||!preview.host||sending.current===pick||busy)return;
  const selected=pick,provenance=preview.provenance,current=()=>preview.isCurrentPick(selected);
  const text=body.trim()||(cssEdits.length?copy('Apply these CSS changes.','应用这些 CSS 修改。'):pick.textEdits?.length?copy('Apply these text changes.','应用这些文字修改。'):toChat?copy('Review this element.','查看此元素。'):'');
  if(!text)return;
  sending.current=selected;setBusy(true);setIssue(undefined);
  try{
   let note=saved.current;
   if(!note){const before=new Set(preview.pending.map(note=>note.id));const notes=await addPageComment({...scope,...selected,cssEdits,body:text,provenance});note=notes.filter(isPageComment).find(note=>!before.has(note.id)&&note.body===text&&note.provenance?.previewId===provenance.previewId);if(!current())return;saved.current=note;}
   if(!note)throw new Error(copy('The note could not be saved.','无法保存标注。'));
   if(toChat||(!preview.batch&&!selected.textEdits?.length))await deliverDesignNotes({scope,host:preview.host,comments:[note],receiverId:provenance.sessionId??preview.host.defaultReceiverId,zh,toChat});
   if(!current())return;
   const revision=preview.added(selected);
   if(!toChat&&revision!==undefined)requestAnimationFrame(()=>preview.resume(revision));
  }catch(error){if(current())setIssue(error instanceof Error?error.message:String(error));}
  finally{if(sending.current===selected)sending.current=undefined;if(current())setBusy(false);}
 };
 useEffect(()=>{if(pick?.toChat&&!auto.current){auto.current=true;void submit(true);}},[pick]);
 if(!scope||!pick||preview.pickScopeKey!==preview.scopeKey)return null;
 const cancel=()=>{if(saved.current){preview.added();return;}preview.cancel();};
 const inspect=async()=>{setCss(!css);if(css||pick.target.type!=='element')return;const generation=++serial.current,selected=pick,current=()=>generation===serial.current&&preview.isCurrentPick(selected);try{const result=await inspectPageTarget({frameName:preview.frameName,target:pageTargetRef(selected.target)});if(!current())return;setStyles(result.styles);setCssEdits(result.cssEdits);}catch{if(current())setIssue(copy('CSS properties are unavailable for this element.','无法读取此元素的 CSS 属性。'));}};
 const edit=async(property:string,value:string)=>{const generation=++serial.current,selected=pick,current=()=>generation===serial.current&&preview.isCurrentPick(selected);setBusy(true);try{const result=await inspectPageTarget({frameName:preview.frameName,target:pageTargetRef(selected.target),property,value});if(!current())return;setStyles(result.styles);setCssEdits(result.cssEdits);setIssue(undefined);await preview.refresh?.();}catch{if(current())setIssue(copy('This CSS value could not be previewed.','无法预览此 CSS 值。'));}finally{if(current())setBusy(false);}};
 const entries=Object.entries(styles).filter(([property])=>property.includes(filter.toLowerCase()));
 const wait=preview.batch||Boolean(pick.textEdits?.length),label=pageCommentLabel(pick.target,zh);
 return <div className="cg-pop dm-note wb-page-comment-form" data-testid="design-note" aria-busy={busy} role="region" aria-label={copy('Design note','设计标注')} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();event.stopPropagation();void submit(true);}}}>
  <div className="dm-note-target"><WbIcon name="element-code"/><span title={label}>{label}</span>{pick.elements&&pick.elements.length>1?<small>{copy(`${pick.elements.length} elements`,`${pick.elements.length} 个元素`)}</small>:pick.target.type==='element'&&pick.target.components?.[0]&&<small>{pick.target.components[0]}</small>}</div>
  <textarea autoFocus className="cg-field" aria-label={copy('Comment for the agent','给 Agent 的评论')} placeholder={copy('What should change?','希望怎么改？')} maxLength={MAX_REVIEW_COMMENT_BODY} disabled={busy||Boolean(saved.current)} value={body} onChange={event=>setBody(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();void submit();}}}/>
  {pick.shot&&<img className="dm-note-shot" src={pick.shot.thumbnail} alt={copy('Selected page area','已选页面区域')}/>}
  {css&&<div className="cg-hair dm-css"><input aria-label={copy('Filter properties','筛选属性')} placeholder={copy('Filter properties','筛选属性')} value={filter} onChange={event=>setFilter(event.target.value)}/><div className="dm-css-rows">{entries.map(([property,value])=>{const changed=cssEdits.find(edit=>edit.property===property);return <div className="dm-css-row" data-changed={Boolean(changed)||undefined} key={property}><span title={property}>{property}</span>{changed&&<s title={changed.before}>{changed.before}</s>}<input key={`${property}:${value}`} aria-label={property} defaultValue={value} disabled={busy} onBlur={event=>{if(event.target.value!==value)void edit(property,event.target.value);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}/></div>;})}{!entries.length&&<p className="dim">{copy('No matching properties','没有匹配属性')}</p>}</div></div>}
  {(issue||preview.issue)&&<p className="wb-issue" role="alert">{issue??preview.issue}</p>}
  <div className="dm-note-foot"><button type="button" className="cg-ghost" disabled={pick.target.type!=='element'||Boolean(pick.elements&&pick.elements.length>1)||busy} aria-pressed={css} onClick={()=>void inspect()}><WbIcon name="css-props"/>CSS</button><button type="button" className="cg-ghost" aria-label={copy('To chat','到对话')} disabled={busy} onClick={()=>void submit(true)}><WbIcon name="to-chat"/><span>{copy('To chat','到对话')}<kbd className="cg-kbd">Ctrl L</kbd></span></button><span className="grow"/><button type="button" className="cg-ghost" disabled={busy} onClick={cancel}>{copy('Cancel','取消')}</button><button type="button" className="cg-ghost cg-primary" aria-label={wait?copy('Save note','保存标注'):copy('Send note','发送标注')} disabled={busy||(!body.trim()&&!cssEdits.length&&!pick.textEdits?.length)} onClick={()=>void submit()}><span>{wait?copy('Save note','保存标注'):copy('Send note','发送标注')}<kbd className="cg-kbd">↵</kbd></span></button></div>
 </div>;
}
