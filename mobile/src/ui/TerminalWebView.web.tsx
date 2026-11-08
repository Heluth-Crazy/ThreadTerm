import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { terminalDocument } from './terminalDocument';
import type { TerminalWebHandle,TerminalWebProps } from './TerminalWebView';
const document=terminalDocument();
export const TerminalWebView=forwardRef<TerminalWebHandle,TerminalWebProps>(function TerminalWebView({onMessage},ref){
  const frame=useRef<HTMLIFrameElement>(null),callback=useRef(onMessage);callback.current=onMessage;
  useImperativeHandle(ref,()=>({send:message=>frame.current?.contentWindow?.postMessage({threadtermHost:message},'*')}),[]);
  useEffect(()=>{const listener=(event:MessageEvent)=>{if(event.source===frame.current?.contentWindow&&typeof event.data?.threadtermTerminal==='string')callback.current(event.data.threadtermTerminal);};window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);},[]);
  return <iframe ref={frame} title="Terminal" srcDoc={document} sandbox="allow-scripts" style={{border:0,width:'100%',height:'100%',flex:1}} />;
});
