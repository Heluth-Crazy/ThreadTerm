import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ThreadTermMobileNativeModule } from '../../modules/threadterm-mobile';
import type { ConnectionStatus, MachineRecord, PairingPreview, PickedAttachment } from './types';

export interface NativePort {
  readonly available:boolean;
  listMachines():Promise<MachineRecord[]>;
  preparePairing(text:string):Promise<PairingPreview>;
  confirmPairing(pendingId:string,deviceName:string,name:string,color:string):Promise<MachineRecord>;
  cancelPairing(pendingId:string):Promise<void>;
  removeMachine(id:string):Promise<void>;
  renameMachine(id:string,name:string,color:string):Promise<void>;
  connect(id:string):Promise<{epoch:string;permission:'readonly'|'fullcontrol'}>;
  disconnect(id:string):Promise<void>;
  request(id:string,method:string,paramsJson:string):Promise<string>;
  unlockControl():Promise<boolean>;
  lockControl():Promise<void>;
  openPreview(id:string,url:string):Promise<void>;
  chooseAttachment():Promise<PickedAttachment|null>;
  readAttachment(uri:string,offset:number,length:number):Promise<string>;
  onRuntimeEvent(listener:(event:{machineId:string;eventJson:string})=>void):()=>void;
  onConnectionState(listener:(event:{machineId:string;state:ConnectionStatus;message?:string})=>void):()=>void;
  onControlLock(listener:(event:{locked:boolean})=>void):()=>void;
}
const unavailable = () => Promise.reject(new Error('native_unavailable: Use the iPhone development build; native connections are unavailable in the web preview or Expo Go.'));
export function createNativePort():NativePort {
  const module = requireOptionalNativeModule<ThreadTermMobileNativeModule>('ThreadTermMobile');
  return {
    available:!!module,
    listMachines:()=>module ? module.listMachines():Promise.resolve([]),
    preparePairing:text=>module ? module.preparePairing(text):unavailable(),
    confirmPairing:(id,device,name,color)=>module ? module.confirmPairing(id,device,name,color):unavailable(),
    cancelPairing:id=>module ? module.cancelPairing(id):Promise.resolve(),
    removeMachine:id=>module ? module.removeMachine(id):unavailable(),
    renameMachine:(id,name,color)=>module ? module.renameMachine(id,name,color):unavailable(),
    connect:id=>module ? module.connect(id):unavailable(),
    disconnect:id=>module ? module.disconnect(id):Promise.resolve(),
    request:(id,method,params)=>module ? module.request(id,method,params):unavailable(),
    unlockControl:()=>module ? module.unlockControl():unavailable(),
    lockControl:()=>module ? module.lockControl():Promise.resolve(),
    openPreview:(id,url)=>module ? module.openPreview(id,url):unavailable(),
    chooseAttachment:()=>module ? module.chooseAttachment():unavailable(),
    readAttachment:(uri,offset,length)=>module ? module.readAttachment(uri,offset,length):unavailable(),
    onRuntimeEvent:listener=>{
      const subscription=module?.addListener('onRuntimeEvent',listener);
      return ()=>subscription?.remove();
    },
    onConnectionState:listener=>{
      const subscription=module?.addListener('onConnectionState',listener);
      return ()=>subscription?.remove();
    },
    onControlLock:listener=>{
      const subscription=module?.addListener('onControlLock',listener);
      return ()=>subscription?.remove();
    },
  };
}
