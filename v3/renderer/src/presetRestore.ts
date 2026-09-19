import type { ContentRef, PaneLayout, Preset } from "@threadterm/protocol";
import { request } from "./bridge";
import { visibleCatalogSnapshot } from "./catalogVisibility";
import { sameCanonicalScope } from "./projectScope";

export function sessionIds(layout:PaneLayout):string[]{
  return layout.kind==="pane"?layout.tabs.flatMap(tab=>tab.kind==="session"?[tab.sessionId]:[]):[...sessionIds(layout.first),...sessionIds(layout.second)];
}
export type PresetSessionScope={sessionId:string;projectId?:string;cwd?:string;projectRoot?:string};

/** Restore exactly the chosen scopes, retaining their existing view identities. */
export function selectPresetLayout(layout:PaneLayout,selected:Set<string>,scopes:PresetSessionScope[]):PaneLayout|null{
  if(layout.kind==="split"){
    const first=selectPresetLayout(layout.first,selected,scopes),second=selectPresetLayout(layout.second,selected,scopes);
    return first&&second?{...layout,first,second}:first??second;
  }
  const chosen=scopes.filter(scope=>selected.has(scope.sessionId));
  const keep=(tab:ContentRef)=>tab.kind==="session"?selected.has(tab.sessionId):chosen.some(scope=>scope.projectId===tab.projectId&&sameCanonicalScope(scope.cwd,tab.worktreePath??scope.projectRoot));
  const tabs=layout.tabs.filter(keep);
  if(!tabs.length)return null;
  return {...layout,tabs,activeTabId:tabs.some(tab=>tab.id===layout.activeTabId)?layout.activeTabId:tabs[0].id};
}

/** A preset restores views and a review list. Starting/resuming a provider is
 * a separate explicit lifecycle action, never a side effect of layout restore. */
export async function restorePreset(preset:Preset,selected:Set<string>):Promise<{sessionId:string;layout:PaneLayout}>{
  const [raw,visibility]=await Promise.all([request("runtime.snapshot",{}),request("catalog.visibility.list",{})]);
  const data=visibleCatalogSnapshot(raw,visibility);
  const ids=[...new Set(sessionIds(preset.layout))].filter(id=>selected.has(id));
  if(!ids.length)throw new Error("Select at least one available session to restore.");
  const scopes:PresetSessionScope[]=[];
  for(const id of ids){
    const session=data.sessions.find(item=>item.id===id);
    if(!session||session.archived)throw new Error("A selected session is unavailable. Refresh the preset preview.");
    const project=data.projects.find(item=>item.id===session.projectId);
    const cwd=session.worktreePath??project?.path;
    if(project){
      const trees=await request("worktree.list",{projectId:project.id});
      if(trees.some(tree=>sameCanonicalScope(tree.path,cwd)&&tree.missing))throw new Error("A selected working directory is missing.");
    }
    scopes.push({sessionId:id,projectId:session.projectId,cwd});
  }
  // File refs without worktreePath mean the registered project root.
  const rootScoped=(node:PaneLayout):PaneLayout=>node.kind==="split"?{...node,first:rootScoped(node.first),second:rootScoped(node.second)}:{...node,tabs:node.tabs.map(tab=>tab.kind==="session"||tab.worktreePath?tab:{...tab,worktreePath:data.projects.find(project=>project.id===tab.projectId)?.path})};
  const layout=selectPresetLayout(rootScoped(preset.layout),new Set(ids),scopes);
  if(!layout)throw new Error("The selected preset has no available views.");
  return {sessionId:ids[0],layout};
}
