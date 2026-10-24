import type { ContentRef, PaneLayout } from '@threadterm/protocol';

export type WorkspaceTabTarget = { paneId:string; tabId:string };
export type FileTab = Extract<ContentRef,{kind:'file'|'diff'|'preview'}>;
export const isFileTab = (tab:ContentRef):tab is FileTab => tab.kind==='file'||tab.kind==='diff'||tab.kind==='preview';
const baseName = (path:string) => path.split(/[\\/]/).at(-1) || path;
/** Full title (tooltip) and short tab label for any non-session content. */
/** Whether a link can open as a web tab. Same rule as the protocol's `isWebPreviewUrl` (kept out of the renderer
 * bundle, which imports only protocol types); the desktop and the runtime validate the saved layout again. */
export function isWebTabUrl(url:string):boolean {
 if(!url||url.length>2048||/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
 try { const parsed = new URL(url); return (parsed.protocol==='http:'||parsed.protocol==='https:')&&Boolean(parsed.hostname); } catch { return false; }
}
/** "localhost:5173" for a web tab: the host is what tells development pages apart. */
export function webTabLabel(url:string):string {
 try { return new URL(url).host || url; } catch { return url; }
}
export function contentTitle(tab:Exclude<ContentRef,{kind:'session'}>,zh:boolean):{title:string;label:string} {
 if(tab.kind==='map') return {title:zh?'任务图':'Task map',label:zh?'任务图':'Task map'};
 // One Usage page per window (its own tab kind so the runtime validates saved layouts).
 if(tab.kind==='usage') return {title:zh?'用量':'Usage',label:zh?'用量':'Usage'};
 if(tab.kind==='group') return {title:`${zh?'群聊':'Group chat'} · ${tab.title}`,label:tab.title};
 if(tab.kind==='roundtable') return {title:`${zh?'群聊':'Group chat'} · ${tab.title}`,label:tab.title};
 if(tab.kind==='history') return tab.path
  ? {title:`${zh?'文件历史':'File history'} · ${tab.path}`,label:`${baseName(tab.path)} · ${zh?'历史':'history'}`}
  : {title:zh?'Git 历史':'Git history',label:zh?'Git 历史':'Git history'};
 if(tab.kind==='review') return {title:`${zh?'检查点以来的改动':'Changes since checkpoint'} · ${tab.path}`,label:`${baseName(tab.path)} · ${zh?'审查':'review'}`};
 if(tab.kind==='web') return {title:tab.url,label:webTabLabel(tab.url)};
 // Diff tabs sit next to the plain file tab of the same path; say which side of Git they show.
 if(tab.kind==='diff') return tab.staged
  ? {title:`${zh?'已暂存的更改':'Staged changes'} · ${tab.path}`,label:`${baseName(tab.path)} · ${zh?'已暂存':'staged'}`}
  : {title:`${zh?'更改':'Changes'} · ${tab.path}`,label:`${baseName(tab.path)} · ${zh?'更改':'changes'}`};
 return {title:tab.path,label:baseName(tab.path)};
}
export type WorkspaceTab = { paneId:string; tab:ContentRef; active:boolean };
export function workspaceTabs(layout:PaneLayout):WorkspaceTab[] {
 return layout.kind==='pane'
  ? layout.tabs.map(tab=>({paneId:layout.id,tab,active:tab.id===layout.activeTabId}))
  : [...workspaceTabs(layout.first),...workspaceTabs(layout.second)];
}
export function focusedWorkspaceTab(layout:PaneLayout,paneId?:string):WorkspaceTab|undefined {
 const tabs=workspaceTabs(layout);
 const containsPane=(node:PaneLayout):boolean=>node.kind==='pane'?node.id===paneId:containsPane(node.first)||containsPane(node.second);
 if(paneId&&containsPane(layout))return tabs.find(item=>item.paneId===paneId&&item.active);
 return tabs.find(item=>item.paneId===paneId&&item.active)??tabs.find(item=>item.active)??tabs[0];
}
export function tabCloseTargets(layout:PaneLayout,target:WorkspaceTabTarget,mode:'current'|'others'|'all'):WorkspaceTabTarget[] {
 const tabs=workspaceTabs(layout);
 if(!tabs.some(item=>item.paneId===target.paneId&&item.tab.id===target.tabId)) return [];
 return tabs.filter(item=>mode==='all'||(mode==='current')===(item.paneId===target.paneId&&item.tab.id===target.tabId))
  .map(item=>({paneId:item.paneId,tabId:item.tab.id}));
}
/** Apply only captured targets to the latest layout after async dirty confirmation. */
export function removeWorkspaceTabs(layout:PaneLayout,targets:readonly WorkspaceTabTarget[],focusedPaneId?:string):{layout:PaneLayout;focusedPaneId?:string} {
 const before=workspaceTabs(layout), focused=focusedWorkspaceTab(layout,focusedPaneId);
 const has=(paneId:string,tabId:string)=>targets.some(item=>item.paneId===paneId&&item.tabId===tabId);
 const visit=(node:PaneLayout):PaneLayout=>{
  if(node.kind==='pane') {
   const tabs=node.tabs.filter(tab=>!has(node.id,tab.id));
   if(tabs.length===node.tabs.length)return node;
   const index=node.tabs.findIndex(tab=>tab.id===node.activeTabId);
   const activeTabId=tabs.some(tab=>tab.id===node.activeTabId)?node.activeTabId
    : node.tabs.slice(index+1).find(tab=>!has(node.id,tab.id))?.id
      ?? node.tabs.slice(0,Math.max(0,index)).reverse().find(tab=>!has(node.id,tab.id))?.id
      ?? tabs[0]?.id??null;
   return {...node,tabs,activeTabId};
  }
  const first=visit(node.first),second=visit(node.second);
  return first===node.first&&second===node.second?node:{...node,first,second};
 };
 const next=visit(layout), remaining=workspaceTabs(next);
 if(!remaining.length)return {layout:next};
 if(focused&&!has(focused.paneId,focused.tab.id))return {layout:next,focusedPaneId:focused.paneId};
 const inPane=remaining.find(item=>item.paneId===focused?.paneId&&item.active);
 if(inPane)return {layout:next,focusedPaneId:inPane.paneId};
 const index=before.findIndex(item=>item.paneId===focused?.paneId&&item.tab.id===focused?.tab.id);
 const neighbor=before.slice(index+1).find(item=>!has(item.paneId,item.tab.id))
  ??before.slice(0,Math.max(index,0)).reverse().find(item=>!has(item.paneId,item.tab.id))??remaining[0];
 return {layout:next,focusedPaneId:neighbor.paneId};
}
