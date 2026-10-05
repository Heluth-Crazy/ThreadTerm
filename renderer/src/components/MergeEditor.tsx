import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { attachLanguage } from './CodeEditor';
import { editorHighlight } from '../workbench/languages';
import { wbIconMarkup } from '../workbench/icons';
import { revertChunk, revertLineChanges } from './diffRevert';
import type { ChunkRange } from '../workbench/indexEdit';

export type MergeEditorHandle={
 revertLine:()=>boolean;revertHunk:()=>boolean;
 /** Current chunks with the CodeMirror documents they index into. */
 snapshot:()=>{chunks:ChunkRange[];a:string;b:string};
 /** Chunk under the editable side's cursor, or -1. */
 cursorChunk:()=>number;
 focusChunk:(index:number)=>void;
};
/** Lines the user selected (or the cursor's line) in one document: "old" = the left, read-only side. */
export type MergeSelection={side:'old'|'new';startLine:number;endLine:number;text:string};
export type MergeLineMark={side:'old'|'new';startLine:number;endLine:number};
type Props={path:string;oldText:string;newText:string;readOnly:boolean;onChange:(value:string)=>void;onSave:()=>void;onChunks?:(count:number)=>void;
 /** Review comments only (added when present at mount): the focused side's selected lines, and lines to mark.
  * Read-only sides then stay focusable (CodeMirror cannot focus a non-editable view), still without edits. */
 onSelection?:(selection:MergeSelection)=>void;marks?:readonly MergeLineMark[]};
const setMarks=StateEffect.define<DecorationSet>();
const markField=StateField.define<DecorationSet>({create:()=>Decoration.none,update:(value,tr)=>{for(const effect of tr.effects)if(effect.is(setMarks))return effect.value;return value.map(tr.changes);},provide:field=>EditorView.decorations.from(field)});
const markedLine=Decoration.line({class:'cm-review-commented'});
function selectionReport(side:MergeSelection['side'],report:{current?:(selection:MergeSelection)=>void}) {
 return EditorView.updateListener.of(update=>{
  if(!(update.selectionSet||update.focusChanged||update.docChanged)||!update.view.hasFocus)return;
  const {state}=update,range=state.selection.main,first=state.doc.lineAt(range.from);
  let last=state.doc.lineAt(range.to);
  // A selection of whole lines ends at the start of the next line; that line is not part of it.
  if(range.to>range.from&&range.to===last.from&&last.number>first.number)last=state.doc.line(last.number-1);
  report.current?.({side,startLine:first.number,endLine:last.number,text:state.sliceDoc(first.from,last.to)});
 });
}
export const MergeEditor=forwardRef<MergeEditorHandle,Props>(function MergeEditor({path,oldText,newText,readOnly,onChange,onSave,onChunks,onSelection,marks},ref) {
 const host=useRef<HTMLDivElement>(null),view=useRef<MergeView|undefined>(undefined); const changed=useRef(onChange),save=useRef(onSave),chunksChanged=useRef(onChunks);changed.current=onChange;save.current=onSave;chunksChanged.current=onChunks;
 const selected=useRef(onSelection);selected.current=onSelection;
 const revertHunk=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),b=merge.b.state.doc.toString(),spec=revertChunk(chunk.fromA,chunk.toA,chunk.fromB,chunk.toB,a,b);merge.b.dispatch({changes:spec,userEvent:'revert'});return true;};
 const revertLine=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),line=merge.b.state.doc.lineAt(head),specs=revertLineChanges(chunk.changes,chunk.fromA,chunk.fromB,line.from,line.to,a);if(!specs.length)return false;merge.b.dispatch({changes:specs,userEvent:'revert'});return true;};
 const snapshot=()=>{const merge=view.current;if(!merge)return {chunks:[],a:'',b:''};return {chunks:merge.chunks.map(({fromA,toA,fromB,toB})=>({fromA,toA,fromB,toB})),a:merge.a.state.doc.toString(),b:merge.b.state.doc.toString()};};
 const cursorChunk=()=>{const merge=view.current;if(!merge)return -1;const head=merge.b.state.selection.main.head;return merge.chunks.findIndex(c=>c.fromB<=head&&head<=c.toB);};
 const focusChunk=(index:number)=>{const merge=view.current,chunk=merge?.chunks[index];if(!merge||!chunk)return;const at=Math.min(chunk.fromB,merge.b.state.doc.length);merge.b.dispatch({selection:readOnly?undefined:EditorSelection.single(at),effects:EditorView.scrollIntoView(at,{y:'center'})});merge.a.dispatch({effects:EditorView.scrollIntoView(Math.min(chunk.fromA,merge.a.state.doc.length),{y:'center'})});};
 useImperativeHandle(ref,()=>({revertLine,revertHunk,snapshot,cursorChunk,focusChunk}),[readOnly]);
 useEffect(()=>{if(!host.current)return;const languageA=new Compartment(),languageB=new Compartment();const comments=Boolean(selected.current);const shared=[lineNumbers(),editorHighlight,EditorView.theme({'&':{background:'transparent',color:'inherit'},'.cm-gutters':{background:'transparent',color:'inherit',borderColor:'var(--border)'},'.cm-cursor':{borderLeftColor:'currentColor'},'.cm-scroller':{fontFamily:'inherit'}})];const report=()=>queueMicrotask(()=>{if(view.current===merge)chunksChanged.current?.(merge.chunks.length);});const merge=new MergeView({parent:host.current,a:{doc:oldText,extensions:[...shared,languageA.of([]),EditorState.readOnly.of(true),EditorView.editable.of(comments),...(comments?[markField,selectionReport('old',selected)]:[])]},b:{doc:newText,extensions:[...shared,languageB.of([]),history(),...(comments?[markField,selectionReport('new',selected)]:[]),EditorState.readOnly.of(readOnly),EditorView.editable.of(comments||!readOnly),keymap.of([...historyKeymap,{key:'Mod-s',run:()=>{save.current();return true;}}]),EditorView.updateListener.of(update=>{if(update.docChanged){changed.current(update.state.doc.toString());report();}})]},highlightChanges:true,gutter:true,revertControls:readOnly?undefined:'a-to-b',collapseUnchanged:{margin:4,minSize:12},renderRevertControl:()=>{const button=document.createElement('button');button.innerHTML=wbIconMarkup('undo');button.title=document.documentElement.lang==='zh-CN'?'还原此处更改':'Revert this change';button.setAttribute('aria-label',button.title);return button;}});view.current=merge;report();const detachA=attachLanguage(merge.a,languageA,path),detachB=attachLanguage(merge.b,languageB,path);return()=>{detachA();detachB();merge.destroy();if(view.current===merge)view.current=undefined;};},[path,readOnly]);
 useEffect(()=>{const merge=view.current;if(!merge)return;for(const [editor,text] of [[merge.a,oldText],[merge.b,newText]] as const)if(editor.state.doc.toString()!==text)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:text}});chunksChanged.current?.(merge.chunks.length);},[oldText,newText]);
 // Commented lines, re-marked after the documents are created or replaced (after the effects above).
 useEffect(()=>{const merge=view.current;if(!merge||!marks)return;for(const [editor,side] of [[merge.a,'old'],[merge.b,'new']] as const){if(!editor.state.field(markField,false))continue;const lines=new Set<number>();for(const mark of marks)if(mark.side===side)for(let line=mark.startLine;line<=Math.min(mark.endLine,editor.state.doc.lines);line++)lines.add(line);const builder=new RangeSetBuilder<Decoration>();for(const line of [...lines].sort((left,right)=>left-right)){const at=editor.state.doc.line(line).from;builder.add(at,at,markedLine);}editor.dispatch({effects:setMarks.of(builder.finish())});}},[marks,oldText,newText,path,readOnly]);
 return <div className="merge-editor tt-diff-host" ref={host}/>;
});
