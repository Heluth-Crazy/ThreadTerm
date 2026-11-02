import { diffFilePosition } from '../diffFileNavigation';
import { useEffect, useRef } from 'react';
import { isKeyboardEditableTarget } from '../workbench/scmKeyboard';
import { diffFileKey, isDiffFileKey } from '../workbench/diffKeyboard';
import { WbIcon } from '../workbench/icons';
import './diff-file-navigation.css';

export function DiffFileNavigation({paths,path,zh,disabled,onNavigate}:{paths:readonly string[];path:string;zh:boolean;disabled?:boolean;onNavigate?:(path:string)=>void}) {
 const {position,total,previous,next}=diffFilePosition(paths,path);
 const host=useRef<HTMLSpanElement>(null);
 const previousKey=diffFileKey('previous'),nextKey=diffFileKey('next');
 useEffect(()=>{
  const surface=host.current?.closest<HTMLElement>('.tt-diff-shell');if(!surface) return;
  const key=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||!surface.isConnected||!surface.getClientRects().length) return;
   // Diff navigation deliberately remains available from CodeMirror: F7 leaves its cursor in the diff before this key selects another file.
   const target=event.target;if(!(target instanceof Node)||!surface.contains(target)) return;
   if(isKeyboardEditableTarget(target)&&!(target instanceof Element&&target.closest('.cm-editor'))) return;
   const nextPath=isDiffFileKey(event,'next')?next:isDiffFileKey(event,'previous')?previous:undefined;
   if(!nextPath||disabled||!onNavigate) return;
   event.preventDefault();onNavigate(nextPath);
  };
  document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
 },[disabled,next,onNavigate,previous]);
 return <span ref={host} className="wb-hunk-nav wb-file-nav" role="group" aria-label={zh?'文件导航':'File navigation'}>
  <button type="button" className="icon-btn icon-btn-sm" title={`${zh?'上一个文件':'Previous file'} (${previousKey.label})`} aria-label={zh?'上一个文件':'Previous file'} aria-keyshortcuts={previousKey.aria} disabled={disabled||!onNavigate||!previous} onClick={()=>previous&&onNavigate?.(previous)}><WbIcon name="arrow-left" /></button>
  <span className="wb-hunk-count" aria-label={zh?'文件位置':'File position'}><span className="file-nav-label">{zh?'文件 ':'File '}</span>{position}/{total}</span>
  <button type="button" className="icon-btn icon-btn-sm" title={`${zh?'下一个文件':'Next file'} (${nextKey.label})`} aria-label={zh?'下一个文件':'Next file'} aria-keyshortcuts={nextKey.aria} disabled={disabled||!onNavigate||!next} onClick={()=>next&&onNavigate?.(next)}><WbIcon name="arrow-right" /></button>
 </span>;
}
