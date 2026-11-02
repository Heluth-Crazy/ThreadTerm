import type { CSSProperties } from 'react';
import { lineRangeLabel } from '../contextMenuActions';

export type SelectionActionLines={startLine:number;endLine:number};
export type SelectionActionPosition={left:number;top:number};
export type SelectionActions<T extends SelectionActionLines>= {
  zh:boolean;
  canComment?:boolean;
  onComment?: (selection:T)=>void;
  onSend?: (selection:SelectionActionLines)=>void;
};

/** A short-lived action strip anchored beside an editor's selected lines. */
export function EditorSelectionActions<T extends SelectionActionLines>({selection,position,actions}:{selection:T;position:SelectionActionPosition;actions:SelectionActions<T>}) {
  if(!(actions.canComment&&actions.onComment)&&!actions.onSend)return null;
  const sendLabel=actions.zh?`发送${lineRangeLabel(true,selection.startLine,selection.endLine)}`:`Send ${lineRangeLabel(false,selection.startLine,selection.endLine)}`;
  return <div className="editor-selection-actions file-selection-actions" style={{'--selection-left':`${position.left}px`,'--selection-top':`${position.top}px`} as CSSProperties}>
    {actions.canComment&&actions.onComment&&<button type="button" className="btn btn-sm" onMouseDown={event=>event.preventDefault()} onClick={()=>actions.onComment?.(selection)}>{actions.zh?'评论':'Comment'}</button>}
    {actions.onSend&&<button type="button" className="btn btn-sm" title={`${sendLabel} (Ctrl+L)`} onMouseDown={event=>event.preventDefault()} onClick={()=>actions.onSend?.(selection)}>{sendLabel}</button>}
  </div>;
}
