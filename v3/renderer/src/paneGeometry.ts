import type { PaneLayout } from '@threadterm/protocol';

export const PANE_GAP = 4;
export const PANE_DIVIDER_SIZE = 4;
type Length = { fraction:number; pixels:number };
export type PaneRect = { left:Length; top:Length; width:Length; height:Length };
type Positioned<T> = { node:T; rect:PaneRect };

const add = (a:Length,b:Length):Length => ({fraction:a.fraction+b.fraction,pixels:a.pixels+b.pixels});
const scale = (value:Length,ratio:number):Length => ({fraction:value.fraction*ratio,pixels:value.pixels*ratio});
const pixels = (value:number):Length => ({fraction:0,pixels:value});
const cssLength = (value:Length) => `calc(${value.fraction*100}% ${value.pixels<0?'-':'+'} ${Math.abs(value.pixels)}px)`;
export const paneRectStyle = (rect:PaneRect) => ({
  left:cssLength(rect.left),top:cssLength(rect.top),
  width:`max(0px, ${cssLength(rect.width)})`,height:`max(0px, ${cssLength(rect.height)})`,
});

/** Derive geometry, not component ancestry, from the persisted split tree.
 * All leaf surfaces remain keyed siblings while splits are added or removed.
 */
export function paneGeometry(layout:PaneLayout) {
  const panes:Positioned<Extract<PaneLayout,{kind:'pane'}>>[]=[];
  const splits:Positioned<Extract<PaneLayout,{kind:'split'}>>[]=[];
  const visit=(node:PaneLayout,rect:PaneRect)=>{
    if(node.kind==='pane'){panes.push({node,rect});return;}
    splits.push({node,rect});
    const size=node.direction==='horizontal'?'width':'height';
    const origin=node.direction==='horizontal'?'left':'top';
    const spacing=PANE_GAP*2+PANE_DIVIDER_SIZE;
    const available=add(rect[size],pixels(-spacing));
    const firstSize=scale(available,node.ratio);
    visit(node.first,{...rect,[size]:firstSize});
    visit(node.second,{...rect,[origin]:add(rect[origin],add(firstSize,pixels(spacing))),[size]:scale(available,1-node.ratio)});
  };
  visit(layout,{left:pixels(0),top:pixels(0),width:{fraction:1,pixels:0},height:{fraction:1,pixels:0}});
  return {panes,splits};
}
