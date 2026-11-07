import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { createNativePort } from './native';
import { createCompanion } from './controller';

type Store=ReturnType<typeof createCompanion>;
const Context=createContext<Store|null>(null);
export function CompanionProvider({children,store:injected}:{children:React.ReactNode;store?:Store}) {
  const ref=useRef<Store|null>(null);
  if(!ref.current)ref.current=injected??createCompanion(createNativePort(),AsyncStorage,randomUUID,{initialLocale:Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh')?'zh-CN':'en'});
  const store=ref.current;
  useEffect(()=>{
    if(AppState.currentState==='background')void store.setForeground(false);
    void store.controller.initialize();
    const subscription=AppState.addEventListener('change',state=>{
      // Face ID temporarily makes iOS inactive; only actual backgrounding locks it.
      if(state==='background')void store.setForeground(false);
      else if(state==='active')void store.setForeground(true);
    });
    return()=>{subscription.remove();void store.dispose();};
  },[store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useCompanion() {
  const store=useContext(Context);if(!store)throw new Error('CompanionProvider is required');
  const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  return {state,controller:store.controller};
}
