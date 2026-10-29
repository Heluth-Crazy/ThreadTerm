import type { GitChange, PaneLayout } from '@threadterm/protocol';
import { changeGroups } from './workbench/gitDecorations';

/** No wrapping: a missing current file cannot silently choose a different file. */
export function diffFilePosition(paths:readonly string[], path:string) {
 const index=paths.indexOf(path);
 return {position:index+1,total:paths.length,previous:index>0?paths[index-1]:undefined,next:index>=0&&index<paths.length-1?paths[index+1]:undefined};
}

export function gitDiffFiles(changes:readonly GitChange[], staged:boolean):string[] {
 return changes.filter(change=>changeGroups(change).some(group=>staged?group==='staged':group==='changes'||group==='untracked')).map(change=>change.path);
}

/** Compare the captured tab object after confirmation, so closing/moving/retargeting it wins. */
export function retargetDiffFile(layout:PaneLayout,paneId:string,tab:Extract<import('@threadterm/protocol').ContentRef,{path:string}>,path:string):PaneLayout {
 if(tab.kind!=='review'&&tab.kind!=='diff')return layout;
 if(layout.kind==='split') {
  const first=retargetDiffFile(layout.first,paneId,tab,path),second=retargetDiffFile(layout.second,paneId,tab,path);
  return first===layout.first&&second===layout.second?layout:{...layout,first,second};
 }
 if(layout.id!==paneId||!layout.tabs.includes(tab)||tab.path===path)return layout;
 // A compare tab's `originalPath` is the base path of the file it was opened with: retargeting to
 // another file must not carry it along, or the new file's base side would be read from it.
 let retargeted:typeof tab = {...tab,path};
 if(tab.kind==='diff'&&tab.compare) {
  const kept={...tab.compare};
  delete kept.originalPath;
  retargeted={...tab,path,compare:kept};
 }
 return {...layout,tabs:layout.tabs.map(item=>item===tab?retargeted:item)};
}
