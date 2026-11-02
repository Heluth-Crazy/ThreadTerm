import { useEffect, useState } from 'react';
import type { Session } from '@threadterm/protocol';
import { browserCommand } from '../bridge';
import { BROWSER_NEW_TAB_URL } from '../browserNewTab';
import type { usePanelBrowser } from '../panelBrowser';
import { previewReady, runState } from '../quickLaunch';
import { WebPreview } from './WebPreview';
import './panel-browser.css';

type BrowserModel=ReturnType<typeof usePanelBrowser>;
export function PanelBrowser({browser,sessions,zh,onOpenTab}:{browser:BrowserModel;sessions:Session[];zh:boolean;onOpenTab:(url:string)=>void}) {
 const [url]=useState(browser.url);
 const [focus]=useState(()=>crypto.randomUUID());
 useEffect(()=>()=>{void browserCommand({type:'close',tabId:browser.tabId}).catch(()=>undefined);},[browser.tabId]);
 const running=sessions.filter(session=>runState(session).url&&previewReady(session));
 const relative=(at:number)=>{
  const minutes=Math.max(0,Math.floor((Date.now()-at)/60000));
  if(minutes<1)return zh?'刚刚':'Just now';
  const hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return new Intl.RelativeTimeFormat(zh?'zh-CN':'en',{numeric:'auto'}).format(-(days||hours||minutes),days?'day':hours?'hour':'minute');
 };
 return <div className="wb-side-browser"><WebPreview tabId={browser.tabId} url={url} visible zh={zh} panelHost navigationRequest={browser.request&&{key:browser.request.generation,url:browser.request.url}} addressFocus={url===BROWSER_NEW_TAB_URL?focus:undefined}
  onNavigation={observation=>{if(observation.url&&observation.url!==BROWSER_NEW_TAB_URL)browser.observe(observation.url);}}
  onPopup={popup=>onOpenTab(popup.url)}
  startPage={<div className="wb-browser-start">
   {running.length>0&&<section aria-label={zh?'此工作树中运行的服务':'Running in this worktree'}><h3>{zh?'此工作树中运行的服务':'Running in this worktree'}</h3>{running.map(session=><button type="button" className="wb-browser-start-row" data-browser-running key={session.id} onClick={()=>browser.open(session.run!.url!)}><span>{session.run!.url}</span><small>{session.run!.name}</small></button>)}</section>}
   {browser.recent.length>0&&<section aria-label={zh?'最近访问':'Recent'}><h3>{zh?'最近访问':'Recent'}</h3>{browser.recent.map(page=><button type="button" className="wb-browser-start-row" data-browser-recent key={page.url} onClick={()=>browser.open(page.url)}><span>{page.url}</span><small>{relative(page.openedAt)}</small></button>)}</section>}
   {!running.length&&!browser.recent.length&&<p>{zh?'输入网址，或运行服务后在这里打开。':'Enter an address, or run a server to open it here.'}</p>}
  </div>}/></div>;
}
