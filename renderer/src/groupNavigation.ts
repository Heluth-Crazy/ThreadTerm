import type { Group, GroupSummary, PaneLayout } from '@threadterm/protocol';

type GroupTarget=Pick<Group,'id'|'title'|'members'>|Pick<GroupSummary,'id'|'title'|'members'>;
export type GroupNavigation={kind:'open';group:GroupTarget}|{kind:'start';context?:{sessionId:string}};

let pending:GroupNavigation|undefined;
const listeners=new Set<(navigation:GroupNavigation)=>void>();
const publish=(navigation:GroupNavigation)=>{pending=navigation;for(const listener of listeners)listener(navigation);};

/** Opens a Group from catalog and inbox surfaces, including before App mounts. */
export const openGroup=(group:GroupTarget):void=>publish({kind:'open',group});
/** Opens the shared Group creation dialog, optionally seeded from a Chat member. */
export const startGroup=(context?:{sessionId:string}):void=>publish({kind:'start',context});
export const observeGroupNavigation=(listener:(navigation:GroupNavigation)=>void):(()=>void)=>{listeners.add(listener);if(pending)listener(pending);return()=>listeners.delete(listener);};
export const acknowledgeGroupNavigation=(navigation:GroupNavigation):void=>{if(pending===navigation)pending=undefined;};

/** Updates persisted Group and legacy Roundtable tabs without disturbing unrelated layout branches. */
export const retitleGroupTabs=(layout:PaneLayout,id:string,title:string):PaneLayout=>{
 const visit=(node:PaneLayout):PaneLayout=>{
  if(node.kind==='pane'){
   let changed=false;
   const tabs=node.tabs.map(tab=>{
    const matches=(tab.kind==='group'&&tab.groupId===id)||(tab.kind==='roundtable'&&tab.roundtableId===id);
    if(!matches||tab.title===title)return tab;
    changed=true;
    return {...tab,title};
   });
   return changed?{...node,tabs}:node;
  }
  const first=visit(node.first),second=visit(node.second);
  return first===node.first&&second===node.second?node:{...node,first,second};
 };
 return visit(layout);
};
