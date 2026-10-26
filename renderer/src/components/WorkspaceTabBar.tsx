import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { PaneLayout, Session } from '@threadterm/protocol';
import { contentTitle, workspaceTabs, type WorkspaceTabTarget } from '../workspaceTabs';
import { isFileTab, type FileTab } from '../workspaceTabs';
import { useTranslation } from '../i18n';
import { AgentIcon, Icon } from './PrototypeIcon';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';

/** Width of the overflow fade at each strip edge (matches `.workspace-tabs.fade-*`). */
const TAB_FADE=24;
export type WorkspaceTabPresentation={label?:string;title?:string;favicon?:string;loading?:boolean;provider?:string;onFaviconError?:()=>void;marker?:{icon:ReactNode;tooltip:string;description:string}};
type Props={layout:PaneLayout;sessions:Session[];active?:WorkspaceTabTarget;busy?:boolean;
 onActivate:(target:WorkspaceTabTarget)=>void;
 onClose:(target:WorkspaceTabTarget,mode:'current'|'others'|'all')=>void;
 onReorder:(paneId:string,from:number,to:number)=>void;fileMenuItems?:(tab:FileTab)=>ContextMenuItem[];children?:ReactNode;
 paneLabel:string;prefix?:ReactNode;onAdd?:()=>void;addLabel?:string;presentation?:ReadonlyMap<string,WorkspaceTabPresentation>};
export function WorkspaceTabBar({layout,sessions,active,busy,onActivate,onClose,onReorder,fileMenuItems,children,paneLabel,prefix,onAdd,addLabel,presentation}:Props) {
 const zh=useTranslation().locale==='zh-CN';
 const strip=useRef<HTMLDivElement>(null);
 const revealActive=useRef<(()=>void)|undefined>(undefined);
 const [fade,setFade]=useState('');
 const tabs=workspaceTabs(layout);
 const openMenu=(target:WorkspaceTabTarget,event:{clientX:number;clientY:number;currentTarget:HTMLElement})=>{const tab=tabs.find(item=>item.paneId===target.paneId&&item.tab.id===target.tabId)?.tab;const fileItems=tab&&isFileTab(tab)?fileMenuItems?.(tab)??[]:[];const browser=tab?.kind==='web';const closeableTabs=browser?tabs.filter(item=>item.tab.kind==='web'):tabs;const blocked=busy?(zh?'正在关闭标签。':'A tab is closing.'):undefined;showContextMenu({x:event.clientX,y:event.clientY,restoreFocus:event.currentTarget.querySelector<HTMLElement>('.workspace-tab-select')??event.currentTarget,items:[...fileItems,...(fileItems.length?[{separator:true,label:''}]:[]),...(['current','others','all'] as const).map(mode=>({id:`${browser?'browser':'workspace'}-tab-close-${mode}`,label:browser?(zh?({current:'关闭当前页面',others:'关闭其他页面',all:'关闭所有页面'}[mode]):({current:'Close page',others:'Close other pages',all:'Close all pages'}[mode])):(zh?({current:'关闭当前',others:'关闭其他',all:'关闭所有'}[mode]):({current:'Close current',others:'Close others',all:'Close all'}[mode])),disabled:busy||(mode==='others'&&closeableTabs.length<2),reason:blocked??(mode==='others'&&closeableTabs.length<2?(zh?'没有其他标签可关闭。':'There are no other tabs to close.'):undefined),onSelect:()=>onClose(target,mode),testId:`${browser?'browser':'workspace'}-tab-close-${mode}`}))]});};
 const onTabContext=(event:MouseEvent<HTMLDivElement>)=>{const element=(event.target as HTMLElement).closest<HTMLElement>('[data-workspace-tab]');if(!element||!event.currentTarget.contains(element))return;event.preventDefault();openMenu({paneId:element.dataset.tabPaneId!,tabId:element.dataset.tabId!},{clientX:event.clientX,clientY:event.clientY,currentTarget:element});};
 const onTabKey=(event:KeyboardEvent<HTMLButtonElement>,target:WorkspaceTabTarget)=>{
  if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();openMenu(target,{clientX:rect.left+Math.min(16,rect.width/2),clientY:rect.top+Math.min(16,rect.height/2),currentTarget:event.currentTarget});}
  if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
   event.preventDefault();const items=Array.from(event.currentTarget.closest('[role=tablist]')!.querySelectorAll<HTMLButtonElement>('[role=tab]'));
   const index=items.indexOf(event.currentTarget),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;
   items[next]?.focus();items[next]?.click();
  }
 };
 const tabKey=tabs.map(item=>`${item.paneId}:${item.tab.id}`).join('|');
 // A visible pane owns one observer. It updates fades and reveals a newly selected tab after a resize.
 useEffect(()=>{
  const element=strip.current;if(!element)return;
  const sync=()=>{
   const start=element.scrollLeft>1,end=element.scrollLeft+element.clientWidth<element.scrollWidth-1;setFade(`${start?' fade-start':''}${end?' fade-end':''}`);
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
  const wheel=(event:WheelEvent)=>{if(event.ctrlKey||event.metaKey||!event.deltaY||event.deltaX||element.scrollWidth<=element.clientWidth)return;const scale=event.deltaMode===1?16:event.deltaMode===2?element.clientWidth:1;element.scrollLeft+=event.deltaY*scale;event.preventDefault();};
  element.addEventListener('scroll',sync,{passive:true});
  element.addEventListener('wheel',wheel,{passive:false});
  revealActive.current=reveal;reveal();
  return()=>{if(revealActive.current===reveal)revealActive.current=undefined;observer.disconnect();element.removeEventListener('scroll',sync);element.removeEventListener('wheel',wheel);};
 },[active?.paneId,active?.tabId,tabKey]);
 return <div className="workspace-tabbar ws-strip">
  {prefix&&<div className="workspace-tab-prefix">{prefix}</div>}
  <div className={`workspace-tabs${fade}`} ref={strip} role="tablist" aria-label={paneLabel} onContextMenu={onTabContext}>
   {tabs.map(({paneId,tab},index)=>{
    const session=tab.kind==='session'?sessions.find(item=>item.id===tab.sessionId):undefined;
    const fallbackTitle=tab.kind==='session'?(session?.title??tab.sessionId):tab.kind==='map'?`${zh?'任务图':'Task map'} · ${sessions.find(item=>item.id===tab.sessionId)?.title??tab.sessionId}`:contentTitle(tab,zh).title;
    const fallbackLabel=tab.kind==='session'?fallbackTitle:contentTitle(tab,zh).label;
    const details=presentation?.get(tab.id),title=details?.title??fallbackTitle,label=details?.label??fallbackLabel;
    const selected=active?.paneId===paneId&&active.tabId===tab.id;
    const target={paneId,tabId:tab.id},browser=tab.kind==='web';
    const tabId=browser?`browser-tab-${paneId}-${tab.id}`:`workspace-tab-${paneId}-${tab.id}`;
    const panelId=browser?`browser-panel-${paneId}-${tab.id}`:`workspace-panel-${paneId}-${tab.id}`;
    const markerId=details?.marker?`${tabId}-marker`:undefined;
    const closeLabel=browser?(zh?`关闭页面 ${label}`:`Close page ${label}`):`${zh?'关闭标签':'Close tab'} ${title}`;
    return <div className={`workspace-tab${selected?' active':''}${browser?' browser-page-tab':''}`} key={`${paneId}:${tab.id}`} data-workspace-tab data-tab-kind={tab.kind} data-tab-pane-id={paneId} data-tab-id={tab.id} onAuxClick={event=>{if(event.button===1&&!busy){event.preventDefault();onClose(target,'current');}}}>
     <button type="button" className={`workspace-tab-select${browser?' browser-page-tab-select':''}`} id={tabId} role="tab" aria-selected={selected} aria-controls={panelId} aria-describedby={markerId} tabIndex={selected||(!active&&index===0)?0:-1}
      title={title} aria-label={title} draggable
      onClick={()=>{onActivate(target);if(selected)revealActive.current?.();}}
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
      {details?.loading?<span className="browser-page-loading" aria-hidden="true"/>:details?.favicon?<img className="browser-page-favicon" src={details.favicon} width={16} height={16} alt="" aria-hidden="true" onError={details.onFaviconError}/>:session?<AgentIcon provider={session.provider}/>:<Icon name={tab.kind==='map'?'flow':tab.kind==='usage'?'layers':tab.kind==='group'||tab.kind==='roundtable'?'agents':browser?'globe':'file'}/>}<span className={browser?'browser-page-tab-title':undefined}>{label}</span>{details?.provider&&<small>{details.provider}</small>}{details?.marker&&<><span className="workspace-tab-marker" title={details.marker.tooltip} aria-hidden="true">{details.marker.icon}</span><span id={markerId} className="workspace-tab-marker-description">{details.marker.description}</span></>}
     </button>
     <button type="button" className={`workspace-tab-close${browser?' browser-page-tab-close':''}`} disabled={busy} title={browser?(zh?'关闭页面':'Close page'):(zh?'关闭标签':'Close tab')} aria-label={closeLabel} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onClose(target,'current');}}><Icon name="close"/></button>
    </div>;
   })}
  </div>
  {onAdd&&<div className="workspace-tab-add-slot"><button type="button" className="icon-btn workspace-tab-add" aria-label={addLabel??(zh?'打开会话':'Open session')} title={addLabel??(zh?'打开会话':'Open session')} onClick={onAdd}><Icon name="plus"/></button></div>}
  <div className="workspace-tab-actions">{children}</div>
 </div>;
}
