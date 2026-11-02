import { useState } from 'react';
import { BROWSER_NEW_TAB_URL } from './browserNewTab';
import { canonicalScopePath } from './projectScope';

type RecentPage = {url:string;openedAt:number};
type PanelBrowserState = {tabId:string;url:string;recent:RecentPage[]};
export const panelBrowserKey=(projectId:string,root:string)=>`threadterm.workspace.browser:${JSON.stringify([projectId,canonicalScopePath(root)])}`;
function readPanelBrowser(key:string):PanelBrowserState {
 try {
  const value=JSON.parse(localStorage.getItem(key)??'null');
  if(value&&typeof value.tabId==='string'&&/^workspace-browser:[0-9a-f-]{36}$/.test(value.tabId))return {tabId:value.tabId,url:typeof value.url==='string'?value.url:BROWSER_NEW_TAB_URL,recent:Array.isArray(value.recent)?value.recent.filter((page:RecentPage)=>typeof page?.url==='string'&&Number.isFinite(page.openedAt)).slice(0,10):[]};
 } catch { /* storage disabled or invalid */ }
 return {tabId:`workspace-browser:${crypto.randomUUID()}`,url:BROWSER_NEW_TAB_URL,recent:[]};
}
export function usePanelBrowser(projectId:string,root:string) {
 const key=panelBrowserKey(projectId,root);
 const [saved,setSaved]=useState(()=>({key,value:readPanelBrowser(key)}));
 const current=saved.key===key?saved.value:readPanelBrowser(key);
 if(saved.key!==key)setSaved({key,value:current});
 const [request,setRequest]=useState<{key:string;url:string;generation:string}>();
 const update=(url:string,remember:boolean)=>setSaved(previous=>{
  const value=previous.key===key?previous.value:current;
  const next={...value,url,recent:remember?[{url,openedAt:Date.now()},...value.recent.filter(page=>page.url!==url)].slice(0,10):value.recent};
  try {localStorage.setItem(key,JSON.stringify(next));} catch { /* keep this session usable */ }
  return {key,value:next};
 });
 return {...current,key,request:request?.key===key?request:undefined,
  open:(url:string)=>{update(url,true);setRequest({key,url,generation:crypto.randomUUID()});},
  observe:(url:string)=>update(url,url!==BROWSER_NEW_TAB_URL),
  reset:()=>{update(BROWSER_NEW_TAB_URL,false);setRequest(undefined);},
 };
}
