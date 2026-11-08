import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import type { CompanionController,CompanionState,SessionRef,SessionView } from '../core/types';
import { controlPermissionNotice } from './format';
import { Button } from './primitives';
import type { Theme } from './theme';
import { TerminalWebView,type TerminalWebHandle } from './TerminalWebView';
import { mobileTerminalTheme } from './terminalDocument';

export function TerminalPanel({theme,state,controller,ref,view}:{theme:Theme;state:CompanionState;controller:CompanionController;ref:SessionRef;view?:SessionView}) {
  const machine=state.machines.find(m=>m.id===ref.machineId),session=machine?.snapshot?.sessions.find(s=>s.id===ref.sessionId);
  const permitted=machine?.permission==='fullcontrol'&&!session?.readOnly&&!session?.archived;
  const control=!!(state.controlUnlocked&&permitted&&machine?.status==='connected'&&!machine.syncing&&!view?.syncing&&view?.leaseEpoch);
  const zh=state.preferences.locale==='zh-CN',copy=(en:string,cn:string)=>zh?cn:en;
  const web=useRef<TerminalWebHandle>(null),[ready,setReady]=useState(0),[ctrl,setCtrl]=useState(false),[busy,setBusy]=useState(false);
  const latest=useRef({control,epoch:0,identity:''});
  const identity=`${ref.machineId}:${ref.sessionId}:${machine?.connectionGeneration}:${view?.leaseEpoch}`;
  if(latest.current.control!==control||latest.current.identity!==identity)latest.current={control,identity,epoch:latest.current.epoch+1};
  const failure=(error:unknown)=>Alert.alert(copy('Input was not sent','输入未发送'),error instanceof Error?error.message:String(error));
  const input=(data:string)=>{
    if(!latest.current.control)return;
    // The controller captures generations before serializing this chunk. Passing
    // the displayed connection/lease also fences messages ahead of React renders.
    void controller.terminalInput(ref,data,{connectionGeneration:machine?.connectionGeneration??0,leaseEpoch:view?.leaseEpoch??0}).catch(failure);
  };
  useEffect(()=>{
    if(!ready)return;
    web.current?.send({config:{cols:session?.cols??120,rows:session?.rows??40,control,inputToken:latest.current.epoch,windowsPty:machine?.snapshot?.capabilities.windowsPty,theme:mobileTerminalTheme(theme.background.toLowerCase()==='#262624')},stream:view?.terminalStream});
    if(!control){setCtrl(false);web.current?.send({ctrl:false,token:latest.current.epoch,blur:true});}
  },[ready,control,identity,session?.cols,session?.rows,machine?.snapshot?.capabilities.windowsPty,theme,view?.terminalStream]);
  const claim=(takeover=false)=>{
    setBusy(true);void controller.unlockControl().then(ok=>{if(ok)return controller.claimControl(ref,takeover);}).catch(failure).finally(()=>setBusy(false));
  };
  const keys=[['Esc','\x1b'],['Tab','\t'],['Ctrl',''],['←','\x1b[D'],['↑','\x1b[A'],['↓','\x1b[B'],['→','\x1b[C'],['Ctrl-C','\x03']];
  return <View style={{flex:1,minHeight:0}}>
    {!!view?.error&&<Text style={{color:theme.red,paddingHorizontal:12,fontSize:12}}>{view.error}</Text>}
    {view?.terminalGap&&<Text accessibilityRole="text" style={{color:theme.muted,fontSize:11,paddingHorizontal:12,paddingVertical:3}}>{copy('Earlier output unavailable','较早输出不可用')}</Text>}
    <View style={{flex:1,minHeight:0}}><TerminalWebView key={`${ref.machineId}:${ref.sessionId}`} ref={web} onMessage={raw=>{
      try {const message=JSON.parse(raw);if(message.type==='ready')setReady(value=>value+1);else if(message.type==='input'&&message.token===latest.current.epoch&&typeof message.data==='string')input(message.data);else if(message.type==='ctrl')setCtrl(false);}catch{}
    }} /></View>
    {!control&&<View style={{flexDirection:'row',alignItems:'center',paddingHorizontal:12,gap:8}}>
      <Text style={{flex:1,color:theme.amber,fontSize:13}}>{!permitted&&machine?.permission==='fullcontrol'?copy('This session is read-only.','此会话仅允许查看。'):controlPermissionNotice(machine?.permission,state.controlUnlocked,state.preferences.locale)}</Text>
      {permitted&&<><Button theme={theme} small disabled={busy||machine?.status!=='connected'||machine.syncing} label={state.controlUnlocked?copy('Control','获取控制'):copy('Unlock','解锁')} onPress={()=>claim()} /><Button theme={theme} small tone="secondary" disabled={busy||machine?.status!=='connected'||machine.syncing} label={copy('Take over','接管')} onPress={()=>Alert.alert(copy('Take over terminal?','接管终端？'),copy('Control will move to this phone.','控制权将移到此手机。'),[{text:copy('Cancel','取消'),style:'cancel'},{text:copy('Take over','接管'),style:'destructive',onPress:()=>claim(true)}])} /></>}
    </View>}
    {control&&<ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={{flexGrow:0,backgroundColor:theme.surface}} contentContainerStyle={{gap:8,paddingHorizontal:8,paddingVertical:4}}>
      <Pressable accessibilityRole="button" accessibilityLabel={copy('Toggle keyboard','切换键盘')} onPress={()=>web.current?.send({toggleKeyboard:true})} style={{minWidth:44,height:44,alignItems:'center',justifyContent:'center'}}><Text style={{color:theme.primary}}>⌨</Text></Pressable>
      {keys.map(([label,data])=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={label==='Ctrl'?{selected:ctrl}:undefined} onPress={()=>{if(label==='Ctrl'){setCtrl(!ctrl);web.current?.send({ctrl:!ctrl,token:latest.current.epoch,focus:true});}else web.current?.send({key:data,token:latest.current.epoch});}} style={{minWidth:44,height:44,paddingHorizontal:6,borderRadius:8,backgroundColor:label==='Ctrl'&&ctrl?theme.chip:theme.raised,alignItems:'center',justifyContent:'center'}}><Text style={{color:theme.text,fontSize:13}}>{label}</Text></Pressable>)}
    </ScrollView>}
  </View>;
}
