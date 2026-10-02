import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
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
type Props={path:string;oldText:string;newText:string;readOnly:boolean;onChange:(value:string)=>void;onSave:()=>void;onChunks?:(count:number)=>void};
export const MergeEditor=forwardRef<MergeEditorHandle,Props>(function MergeEditor({path,oldText,newText,readOnly,onChange,onSave,onChunks},ref) {
 const host=useRef<HTMLDivElement>(null),view=useRef<MergeView|undefined>(undefined); const changed=useRef(onChange),save=useRef(onSave),chunksChanged=useRef(onChunks);changed.current=onChange;save.current=onSave;chunksChanged.current=onChunks;
 const revertHunk=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),b=merge.b.state.doc.toString(),spec=revertChunk(chunk.fromA,chunk.toA,chunk.fromB,chunk.toB,a,b);merge.b.dispatch({changes:spec,userEvent:'revert'});return true;};
 const revertLine=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),line=merge.b.state.doc.lineAt(head),specs=revertLineChanges(chunk.changes,chunk.fromA,chunk.fromB,line.from,line.to,a);if(!specs.length)return false;merge.b.dispatch({changes:specs,userEvent:'revert'});return true;};
 const snapshot=()=>{const merge=view.current;if(!merge)return {chunks:[],a:'',b:''};return {chunks:merge.chunks.map(({fromA,toA,fromB,toB})=>({fromA,toA,fromB,toB})),a:merge.a.state.doc.toString(),b:merge.b.state.doc.toString()};};
 const cursorChunk=()=>{const merge=view.current;if(!merge)return -1;const head=merge.b.state.selection.main.head;return merge.chunks.findIndex(c=>c.fromB<=head&&head<=c.toB);};
 const focusChunk=(index:number)=>{const merge=view.current,chunk=merge?.chunks[index];if(!merge||!chunk)return;const at=Math.min(chunk.fromB,merge.b.state.doc.length);merge.b.dispatch({selection:readOnly?undefined:EditorSelection.single(at),effects:EditorView.scrollIntoView(at,{y:'center'})});merge.a.dispatch({effects:EditorView.scrollIntoView(Math.min(chunk.fromA,merge.a.state.doc.length),{y:'center'})});};
 useImperativeHandle(ref,()=>({revertLine,revertHunk,snapshot,cursorChunk,focusChunk}),[readOnly]);
 useEffect(()=>{if(!host.current)return;const languageA=new Compartment(),languageB=new Compartment();const shared=[lineNumbers(),editorHighlight,EditorView.theme({'&':{background:'transparent',color:'inherit'},'.cm-gutters':{background:'transparent',color:'inherit',borderColor:'var(--border)'},'.cm-cursor':{borderLeftColor:'currentColor'},'.cm-scroller':{fontFamily:'inherit'}})];const report=()=>queueMicrotask(()=>{if(view.current===merge)chunksChanged.current?.(merge.chunks.length);});const merge=new MergeView({parent:host.current,a:{doc:oldText,extensions:[...shared,languageA.of([]),EditorState.readOnly.of(true),EditorView.editable.of(false)]},b:{doc:newText,extensions:[...shared,languageB.of([]),history(),EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),keymap.of([...historyKeymap,{key:'Mod-s',run:()=>{save.current();return true;}}]),EditorView.updateListener.of(update=>{if(update.docChanged){changed.current(update.state.doc.toString());report();}})]},highlightChanges:true,gutter:true,revertControls:readOnly?undefined:'a-to-b',collapseUnchanged:{margin:4,minSize:12},renderRevertControl:()=>{const button=document.createElement('button');button.innerHTML=wbIconMarkup('undo');button.title=document.documentElement.lang==='zh-CN'?'还原此处更改':'Revert this change';button.setAttribute('aria-label',button.title);return button;}});view.current=merge;report();const detachA=attachLanguage(merge.a,languageA,path),detachB=attachLanguage(merge.b,languageB,path);return()=>{detachA();detachB();merge.destroy();if(view.current===merge)view.current=undefined;};},[path,readOnly]);
 useEffect(()=>{const merge=view.current;if(!merge)return;for(const [editor,text] of [[merge.a,oldText],[merge.b,newText]] as const)if(editor.state.doc.toString()!==text)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:text}});chunksChanged.current?.(merge.chunks.length);},[oldText,newText]);return <div className="merge-editor tt-diff-host" ref={host}/>;
});
