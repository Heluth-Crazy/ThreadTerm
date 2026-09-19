import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

export const editorLanguage=(path:string)=>path.endsWith(".json")?json():/\.mdx?$/.test(path)?markdown():/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(path)?javascript({typescript:/\.(ts|tsx)$/.test(path),jsx:/\.(jsx|tsx)$/.test(path)}):[];
export function CodeEditor({path,value,readOnly,onChange,onSave}:{path:string;value:string;readOnly:boolean;onChange:(value:string)=>void;onSave:()=>void}){
 const host=useRef<HTMLDivElement>(null); const view=useRef<EditorView | undefined>(undefined); const changed=useRef(onChange); changed.current=onChange; const save=useRef(onSave); save.current=onSave;
 useEffect(()=>{if(!host.current)return; const state=EditorState.create({doc:value,extensions:[lineNumbers(),foldGutter(),history(),indentOnInput(),editorLanguage(path),syntaxHighlighting(defaultHighlightStyle),EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),EditorView.theme({'&':{height:'100%',backgroundColor:'transparent',color:'inherit'},'.cm-scroller':{overflow:'auto',fontFamily:'"Cascadia Code",Consolas,monospace'},'.cm-gutters':{backgroundColor:'transparent',color:'inherit',borderRight:'1px solid var(--border)'},'.cm-cursor':{borderLeftColor:'currentColor'}}),keymap.of([...historyKeymap,...searchKeymap,indentWithTab,{key:"Mod-s",run:()=>{save.current();return true}}]),EditorView.updateListener.of(update=>{if(update.docChanged)changed.current(update.state.doc.toString())})]});const editor=new EditorView({state,parent:host.current});view.current=editor;return()=>{editor.destroy();if(view.current===editor)view.current=undefined}},[path,readOnly]);
 useEffect(()=>{const current=view.current;if(current&&current.state.doc.toString()!==value)current.dispatch({changes:{from:0,to:current.state.doc.length,insert:value}})},[value]); return <div className="cm-host tt-editor-host" ref={host}/>;
}
