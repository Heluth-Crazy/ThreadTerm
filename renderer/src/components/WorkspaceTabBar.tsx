import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { PaneLayout, Session } from '@threadterm/protocol';
import { contentTitle, workspaceTabs, type WorkspaceTabTarget } from '../workspaceTabs';
import { isFileTab, type FileTab } from '../workspaceTabs';
import { useTranslation } from '../i18n';
import { AgentIcon, Icon } from './PrototypeIcon';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';

/** Width of the overflow fade at each strip edge (matches `.workspace-tabs.fade-*`). */
const TAB_FADE=24;
type Props={layout:PaneLayout;sessions:Session[];active?:WorkspaceTabTarget;busy?:boolean;
 onActivate:(target:WorkspaceTabTarget)=>void;
 onClose:(target:WorkspaceTabTarget,mode:'current'|'others'|'all')=>void;
 onReorder:(paneId:string,from:number,to:number)=>void;fileMenuItems?:(tab:FileTab)=>ContextMenuItem[];children?:ReactNode};
export function WorkspaceTabBar({layout,sessions,active,busy,onActivate,onClose,onReorder,fileMenuItems,children}:Props) {
 const zh=useTranslation().locale==='zh-CN';
 const strip=useRef<HTMLDivElement>(null);
 const [fade,setFade]=useState('');
 const tabs=workspaceTabs(layout);
 const openMenu=(target:WorkspaceTabTarget,event:{clientX:number;clientY:number;currentTarget:HTMLElement})=>{const tab=tabs.find(item=>item.paneId===target.paneId&&item.tab.id===target.tabId)?.tab;const fileItems=tab&&isFileTab(tab)?fileMenuItems?.(tab)??[]:[];const blocked=busy?(zh?'正在关闭标签。':'A tab is closing.'):undefined;showContextMenu({x:event.clientX,y:event.clientY,restoreFocus:event.currentTarget.querySelector<HTMLElement>('.workspace-tab-select')??event.currentTarget,items:[...fileItems,...(fileItems.length?[{separator:true,label:''}]:[]),...(['current','others','all'] as const).map(mode=>({id:`workspace-tab-close-${mode}`,label:zh?({current:'关闭当前',others:'关闭其他',all:'关闭所有'}[mode]):({current:'Close current',others:'Close others',all:'Close all'}[mode]),disabled:busy||(mode==='others'&&tabs.length<2),reason:blocked??(mode==='others'&&tabs.length<2?(zh?'没有其他标签可关闭。':'There are no other tabs to close.'):undefined),onSelect:()=>onClose(target,mode),testId:`workspace-tab-close-${mode}`}))]});};
 const onTabContext=(event:MouseEvent<HTMLDivElement>)=>{const element=(event.target as HTMLElement).closest<HTMLElement>('[data-workspace-tab]');if(!element||!event.currentTarget.contains(element))return;event.preventDefault();openMenu({paneId:element.dataset.paneId!,tabId:element.dataset.tabId!},{clientX:event.clientX,clientY:event.clientY,currentTarget:element});};
 const onTabKey=(event:KeyboardEvent<HTMLButtonElement>,target:WorkspaceTabTarget)=>{
  if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();openMenu(target,{clientX:rect.left+Math.min(16,rect.width/2),clientY:rect.top+Math.min(16,rect.height/2),currentTarget:event.currentTarget});}
  if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
   event.preventDefault();const items=Array.from(event.currentTarget.closest('[role=tablist]')!.querySelectorAll<HTMLButtonElement>('[role=tab]'));
   const index=items.indexOf(event.currentTarget),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;
   items[next]?.focus();items[next]?.click();
  }
 };
 const tabKey=tabs.map(item=>`${item.paneId}:${item.tab.id}`).join('|');
 // Keep the active tab fully visible (clear of the edge fade) when it changes and whenever the strip
 // or a tab resizes (side panel toggles, window resize); a one-off scrollIntoView left it clipped.
 useEffect(()=>{
  const element=strip.current;if(!element)return;
  const sync=()=>{
   const start=element.scrollLeft>1,end=element.scrollLeft+element.clientWidth<element.scrollWidth-1;setFade(`${start?' fade-start':''}${end?' fade-end':''}`);
   // A tab cut by an edge hides its close button: otherwise a lone faded × can sit in the edge fade.
   const box=element.getBoundingClientRect();
   element.querySelectorAll<HTMLElement>('.workspace-tab').forEach(tab=>{const rect=tab.getBoundingClientRect();tab.toggleAttribute('data-clipped',rect.left<box.left-1||rect.right>box.right+1);});
  };
  const reveal=()=>{
   const tab=element.querySelector<HTMLElement>('.workspace-tab.active');
   if(tab){const box=element.getBoundingClientRect(),rect=tab.getBoundingClientRect();
    if(rect.left<box.left+TAB_FADE)element.scrollLeft-=box.left+TAB_FADE-rect.left;
    else if(rect.right>box.right-TAB_FADE)element.scrollLeft+=rect.right-(box.right-TAB_FADE);}
   sync();
  };
  const observer=new ResizeObserver(reveal);observer.observe(element);
  element.querySelectorAll('.workspace-tab').forEach(tab=>observer.observe(tab));
  element.addEventListener('scroll',sync,{passive:true});
  return()=>{observer.disconnect();element.removeEventListener('scroll',sync);};
 },[active?.paneId,active?.tabId,tabKey]);
 return <div className="workspace-tabbar ws-strip">
  {/* The strip hides its scrollbar (it would change the row height); a vertical wheel scrolls it sideways
      and the edges fade while more tabs are hidden past them. */}
  <div className={`workspace-tabs${fade}`} ref={strip} role="tablist" aria-label={zh?'已打开的内容':'Open contents'} onWheel={event=>{const element=event.currentTarget;if(event.deltaY&&!event.deltaX&&element.scrollWidth>element.clientWidth)element.scrollLeft+=event.deltaY;}} onContextMenu={onTabContext}>
   {tabs.map(({paneId,tab},index)=>{
    const session=tab.kind==='session'?sessions.find(item=>item.id===tab.sessionId):undefined;
    const title=tab.kind==='session'?(session?.title??tab.sessionId):contentTitle(tab,zh).title;
    const label=tab.kind==='session'?title:contentTitle(tab,zh).label;
    const selected=active?.paneId===paneId&&active.tabId===tab.id;
    const target={paneId,tabId:tab.id};
    return <div className={`workspace-tab${selected?' active':''}`} key={`${paneId}:${tab.id}`} data-workspace-tab data-pane-id={paneId} data-tab-id={tab.id}>
     <button type="button" className="workspace-tab-select" role="tab" aria-selected={selected} tabIndex={selected||(!active&&index===0)?0:-1} data-workspace-tab data-pane-id={paneId} data-tab-id={tab.id}
      title={title} aria-label={title} draggable
      onClick={()=>onActivate(target)}
      onKeyDown={event=>onTabKey(event,target)}
      onDragStart={event=>event.dataTransfer.setData('application/x-threadterm-tab',JSON.stringify(target))}
      onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-threadterm-tab'))event.preventDefault();}}
      onDrop={event=>{
       event.preventDefault();try{const value=JSON.parse(event.dataTransfer.getData('application/x-threadterm-tab')) as WorkspaceTabTarget;
        if(value.paneId!==paneId)return;const same=tabs.filter(item=>item.paneId===paneId);
        const from=same.findIndex(item=>item.tab.id===value.tabId),to=same.findIndex(item=>item.tab.id===tab.id);
        if(from>=0&&to>=0)onReorder(paneId,from,to);
       }catch{/* Ignore foreign drag data. */}
      }}>
      {session?<AgentIcon provider={session.provider}/>:<Icon name={tab.kind==='web'?'popout':'file'}/>}<span>{label}</span>
     </button>
     <button type="button" className="workspace-tab-close" disabled={busy} title={zh?'关闭标签':'Close tab'} aria-label={`${zh?'关闭标签':'Close tab'} ${title}`} onClick={()=>onClose(target,'current')}><Icon name="close"/></button>
    </div>;
   })}
  </div>
  <div className="workspace-tab-actions">{children}</div>
 </div>;
}
