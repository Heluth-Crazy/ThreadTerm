import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { WebView } from 'react-native-webview';
import { terminalDocument } from './terminalDocument';
export type TerminalWebHandle={send:(message:unknown)=>void};
export type TerminalWebProps={onMessage:(data:string)=>void};
const source={html:terminalDocument(),baseUrl:'about:blank'};
export const TerminalWebView=forwardRef<TerminalWebHandle,TerminalWebProps>(function TerminalWebView({onMessage},ref){
  const web=useRef<WebView<{}>>(null);
  useImperativeHandle(ref,()=>({send:message=>web.current?.injectJavaScript(`window.__ttReceive&&window.__ttReceive(${JSON.stringify(message)});true;`)}),[]);
  return <WebView<{}> ref={web} source={source} style={{flex:1,backgroundColor:'transparent'}} originWhitelist={['about:*']} onShouldStartLoadWithRequest={request=>request.url==='about:blank'} onMessage={event=>onMessage(event.nativeEvent.data)} onContentProcessDidTerminate={()=>web.current?.reload()} javaScriptEnabled domStorageEnabled={false} scrollEnabled={false} keyboardDisplayRequiresUserAction={false} hideKeyboardAccessoryView autoManageStatusBarEnabled={false} allowsLinkPreview={false} dataDetectorTypes="none" bounces={false} />;
});
