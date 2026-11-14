import { useReducer, useRef } from 'react';
import { BROWSER_NEW_TAB_URL } from './browserNewTab';
import { canonicalScopePath } from './projectScope';

type RecentPage = {url:string;openedAt:number};
export type PanelBrowserTab = {tabId:string;url:string;title?:string};
type PanelBrowserState = {tabs:PanelBrowserTab[];active:string;recent:RecentPage[]};
const TAB_ID=/^workspace-browser:[0-9a-f-]{36}$/;
const blankTab=(url=BROWSER_NEW_TAB_URL):PanelBrowserTab=>({tabId:`workspace-browser:${crypto.randomUUID()}`,url});
const fresh=():PanelBrowserState=>{const tab=blankTab();return {tabs:[tab],active:tab.tabId,recent:[]};};
export const panelBrowserKey=(projectId:string,root:string)=>`threadterm.workspace.browser:${JSON.stringify([projectId,canonicalScopePath(root)])}`;
function readPanelBrowser(key:string):PanelBrowserState {
 try {
  const value=JSON.parse(localStorage.getItem(key)??'null');
  if(value&&typeof value==='object'){
   const recent=Array.isArray(value.recent)?value.recent.filter((page:RecentPage)=>typeof page?.url==='string'&&Number.isFinite(page.openedAt)).slice(0,10):[];
   // Until 2026-11-14 the panel held one page, saved as {tabId,url}.
   const saved:unknown[]=Array.isArray(value.tabs)?value.tabs:[{tabId:value.tabId,url:value.url}];
   const tabs:PanelBrowserTab[]=[];
   for(const item of saved){
    const tab=item as Partial<PanelBrowserTab>|null;
    if(typeof tab?.tabId!=='string'||!TAB_ID.test(tab.tabId)||tabs.some(other=>other.tabId===tab.tabId))continue;
    tabs.push({tabId:tab.tabId,url:typeof tab.url==='string'?tab.url:BROWSER_NEW_TAB_URL,...(typeof tab.title==='string'&&tab.title?{title:tab.title}:{})});
   }
   if(tabs.length)return {tabs,active:tabs.some(tab=>tab.tabId===value.active)?value.active:tabs[0].tabId,recent};
  }
 } catch { /* storage disabled or invalid */ }
 return fresh();
}

/**
 * The Browser panel of one worktree: its tabs, the tab in front, and the last ten pages. Pages stay in this panel,
 * beside the chat, until the user moves one to its own pane (owner 2026-11-14: a page must never take the chat's
 * place). The state lives in a ref so handlers registered once (browser events) always act on the current tabs.
 */
export function usePanelBrowser(projectId:string,root:string) {
 const key=panelBrowserKey(projectId,root);
 const store=useRef<{key:string;value:PanelBrowserState;request?:{tabId:string;url:string;generation:string}}>(undefined);
 if(!store.current||store.current.key!==key)store.current={key,value:readPanelBrowser(key)};
 const [,render]=useReducer((count:number)=>count+1,0);
 const current=store.current.value;
 const commit=(next:PanelBrowserState,request?:{tabId:string;url:string})=>{
  if(store.current?.key!==key)return;
  store.current={key,value:next,request:request?{...request,generation:crypto.randomUUID()}:store.current.request};
  try {localStorage.setItem(key,JSON.stringify(next));} catch { /* keep this session usable */ }
  render();
 };
 const latest=()=>store.current?.key===key?store.current.value:current;
 const remember=(value:PanelBrowserState,url:string)=>url===BROWSER_NEW_TAB_URL?value.recent:[{url,openedAt:Date.now()},...value.recent.filter(page=>page.url!==url)].slice(0,10);
 const insertAfterActive=(value:PanelBrowserState,tab:PanelBrowserTab)=>{
  const at=value.tabs.findIndex(item=>item.tabId===value.active);
  return [...value.tabs.slice(0,at+1),tab,...value.tabs.slice(at+1)];
 };
 const front=current.tabs.find(tab=>tab.tabId===current.active)??current.tabs[0];
 return {key,tabs:current.tabs,active:front.tabId,tabId:front.tabId,url:front.url,recent:current.recent,
  request:store.current.request,
  /** Show a page here: the tab that already has it, else the empty tab in front, else a new tab after it. */
  open:(url:string)=>{
   const value=latest(),same=value.tabs.find(tab=>tab.url===url),active=value.tabs.find(tab=>tab.tabId===value.active);
   if(same){commit({...value,active:same.tabId,recent:remember(value,url)});return;}
   if(active&&active.url===BROWSER_NEW_TAB_URL){commit({...value,tabs:value.tabs.map(tab=>tab.tabId===active.tabId?{...tab,url}:tab),recent:remember(value,url)},{tabId:active.tabId,url});return;}
   const tab=blankTab(url);commit({...value,tabs:insertAfterActive(value,tab),active:tab.tabId,recent:remember(value,url)});
  },
  /** A page's own new window (target=_blank, window.open) opens as the next tab. */
  openTab:(url:string)=>{const value=latest(),tab=blankTab(url);commit({...value,tabs:insertAfterActive(value,tab),active:tab.tabId,recent:remember(value,url)});},
  newTab:()=>{
   const value=latest(),empty=value.tabs.find(tab=>tab.url===BROWSER_NEW_TAB_URL);
   if(empty){commit({...value,active:empty.tabId});return;}
   const tab=blankTab();commit({...value,tabs:insertAfterActive(value,tab),active:tab.tabId});
  },
  select:(tabId:string)=>{const value=latest();if(value.tabs.some(tab=>tab.tabId===tabId)&&value.active!==tabId)commit({...value,active:tabId});},
  /** Closing the last tab leaves an empty one, so the panel shows its start page. */
  close:(tabId:string)=>{
   const value=latest(),at=value.tabs.findIndex(tab=>tab.tabId===tabId);if(at<0)return;
   const tabs=value.tabs.filter(tab=>tab.tabId!==tabId);
   if(!tabs.length){const tab=blankTab();commit({...value,tabs:[tab],active:tab.tabId});return;}
   commit({...value,tabs,active:value.active===tabId?(tabs[at]??tabs[at-1]).tabId:value.active});
  },
  observe:(tabId:string,url:string|undefined,title:string|undefined)=>{
   const value=latest(),tab=value.tabs.find(item=>item.tabId===tabId);if(!tab)return;
   const nextUrl=url&&url!==BROWSER_NEW_TAB_URL?url:tab.url,nextTitle=title||(nextUrl===tab.url?tab.title:undefined);
   if(nextUrl===tab.url&&nextTitle===tab.title)return;
   commit({...value,tabs:value.tabs.map(item=>item.tabId===tabId?{tabId,url:nextUrl,...(nextTitle?{title:nextTitle}:{})}:item),recent:nextUrl===tab.url?value.recent:remember(value,nextUrl)});
  },
 };
}
