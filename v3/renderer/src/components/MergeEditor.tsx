import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { editorLanguage } from './CodeEditor';
import { revertChunk, revertLineChanges } from './diffRevert';

export type MergeEditorHandle={revertLine:()=>boolean;revertHunk:()=>boolean};
type Props={path:string;oldText:string;newText:string;readOnly:boolean;onChange:(value:string)=>void;onSave:()=>void};
export const MergeEditor=forwardRef<MergeEditorHandle,Props>(function MergeEditor({path,oldText,newText,readOnly,onChange,onSave},ref) {
 const host=useRef<HTMLDivElement>(null),view=useRef<MergeView|undefined>(undefined); const changed=useRef(onChange),save=useRef(onSave);changed.current=onChange;save.current=onSave;
 const revertHunk=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),b=merge.b.state.doc.toString(),spec=revertChunk(chunk.fromA,chunk.toA,chunk.fromB,chunk.toB,a,b);merge.b.dispatch({changes:spec,userEvent:'revert'});return true;};
 const revertLine=()=>{const merge=view.current;if(!merge||readOnly)return false;const head=merge.b.state.selection.main.head,chunk=merge.chunks.find(c=>c.fromB<=head&&head<=c.toB);if(!chunk)return false;const a=merge.a.state.doc.toString(),line=merge.b.state.doc.lineAt(head),specs=revertLineChanges(chunk.changes,chunk.fromA,chunk.fromB,line.from,line.to,a);if(!specs.length)return false;merge.b.dispatch({changes:specs,userEvent:'revert'});return true;};
 useImperativeHandle(ref,()=>({revertLine,revertHunk}),[readOnly]);
 useEffect(()=>{if(!host.current)return;const shared=[lineNumbers(),editorLanguage(path),syntaxHighlighting(defaultHighlightStyle),EditorView.theme({'&':{background:'transparent',color:'inherit'},'.cm-gutters':{background:'transparent',color:'inherit',borderColor:'var(--border)'},'.cm-cursor':{borderLeftColor:'currentColor'}})];const merge=new MergeView({parent:host.current,a:{doc:oldText,extensions:[...shared,EditorState.readOnly.of(true),EditorView.editable.of(false)]},b:{doc:newText,extensions:[...shared,history(),EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),keymap.of([...historyKeymap,{key:'Mod-s',run:()=>{save.current();return true;}}]),EditorView.updateListener.of(update=>{if(update.docChanged)changed.current(update.state.doc.toString());})]},highlightChanges:true,gutter:true,revertControls:readOnly?undefined:'a-to-b',collapseUnchanged:{margin:4,minSize:12},renderRevertControl:()=>{const button=document.createElement('button');button.textContent='↶';button.title=document.documentElement.lang==='zh-CN'?'还原此处更改':'Revert this change';return button;}});view.current=merge;return()=>{merge.destroy();if(view.current===merge)view.current=undefined;};},[path,readOnly]);
 useEffect(()=>{const merge=view.current;if(!merge)return;for(const [editor,text] of [[merge.a,oldText],[merge.b,newText]] as const)if(editor.state.doc.toString()!==text)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:text}});},[oldText,newText]);return <div className="merge-editor tt-diff-host" ref={host}/>;
});
