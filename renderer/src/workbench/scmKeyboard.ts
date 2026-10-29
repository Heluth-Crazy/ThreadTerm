import type { ChangeGroup } from './gitDecorations';

export type ChangeFocus = {group:ChangeGroup;path:string};
export const changeFocusKey = (row:ChangeFocus) => `${row.group}\0${row.path}`;
export const changeRowOrder:readonly ChangeGroup[] = ['conflicts','staged','changes','untracked'];
export const orderedChangeRows = (groups:Record<ChangeGroup,readonly {path:string}[]>, collapsed:ReadonlySet<ChangeGroup>):ChangeFocus[] => changeRowOrder.flatMap(group=>collapsed.has(group)?[]:groups[group].map(({path})=>({group,path})));

export function changeFocusAfterToggle(rows:readonly ChangeFocus[], source:ChangeFocus):ChangeFocus|undefined {
 const group=rows.filter(row=>row.group===source.group), index=group.findIndex(row=>row.path===source.path);
 return group[index+1] ?? group[index-1] ?? rows.find(row=>changeFocusKey(row)!==changeFocusKey(source));
}

export function rovingChangeTarget(rows:readonly ChangeFocus[], current:ChangeFocus|undefined, key:string):ChangeFocus|undefined {
 const index=current?rows.findIndex(row=>changeFocusKey(row)===changeFocusKey(current)):-1;
 if(key==='Home')return rows[0];
 if(key==='End')return rows.at(-1);
 if(key==='ArrowDown')return rows[Math.min(rows.length-1,index+1)];
 if(key==='ArrowUp')return rows[Math.max(0,index-1)];
 return undefined;
}

export function isKeyboardEditableTarget(target:EventTarget|null):boolean {
 return target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),.cm-editor'));
}
