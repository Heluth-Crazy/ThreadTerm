import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Session } from '@threadterm/protocol';
import { browserCommand } from '../bridge';
import { BROWSER_NEW_TAB_URL } from '../browserNewTab';
import type { FileCommentsHost } from '../fileCommentsHost';
import type { PanelBrowserTab, usePanelBrowser } from '../panelBrowser';
import { previewReady, runState } from '../quickLaunch';
import type { CommentScope } from '../reviewComments';
import { WbIcon } from '../workbench/icons';
import { WebPreview } from './WebPreview';
import './panel-browser.css';

type BrowserModel=ReturnType<typeof usePanelBrowser>;
type Comments={activeSessionId?:string;commentScope?:CommentScope;commentsHost?:FileCommentsHost};

export function panelTabLabel(tab:PanelBrowserTab,zh:boolean) {
 if(tab.url===BROWSER_NEW_TAB_URL)return zh?'新标签页':'New tab';
 if(tab.title)return tab.title;
 try{const parsed=new URL(tab.url);return `${parsed.host}${parsed.pathname==='/'?'':parsed.pathname}`;}catch{return tab.url;}
}

/** One tab's page. Its native view lives while the tab does; only the tab in front is shown (and loaded). */
function PanelBrowserPage({browser,tab,active,zh,startPage,comments}:{browser:BrowserModel;tab:PanelBrowserTab;active:boolean;zh:boolean;startPage:ReactNode;comments:Comments}) {
 const [url]=useState(tab.url);
 const [focus]=useState(()=>crypto.randomUUID());
 useEffect(()=>()=>{void browserCommand({type:'close',tabId:tab.tabId}).catch(()=>undefined);},[tab.tabId]);
 const request=browser.request?.tabId===tab.tabId?{key:browser.request.generation,url:browser.request.url}:undefined;
 return <div className="wb-side-browser-page" hidden={!active}>
  <WebPreview tabId={tab.tabId} url={url} visible={active} zh={zh} panelHost navigationRequest={request} addressFocus={url===BROWSER_NEW_TAB_URL?focus:undefined}
   activeSessionId={comments.activeSessionId} commentScope={comments.commentScope} commentsHost={comments.commentsHost}
   onNavigation={observation=>browser.observe(tab.tabId,observation.url,observation.title)}
   onPopup={popup=>browser.openTab(popup.url)} onNewTab={browser.newTab}
   startPage={startPage}/>
 </div>;
}

export function PanelBrowser({browser,sessions,zh,...comments}:{browser:BrowserModel;sessions:Session[];zh:boolean}&Comments) {
 const running=sessions.filter(session=>runState(session).url&&previewReady(session));
 const relative=(at:number)=>{
  const minutes=Math.max(0,Math.floor((Date.now()-at)/60000));
  if(minutes<1)return zh?'刚刚':'Just now';
  const hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return new Intl.RelativeTimeFormat(zh?'zh-CN':'en',{numeric:'auto'}).format(-(days||hours||minutes),days?'day':hours?'hour':'minute');
 };
 const startPage=<div className="wb-browser-start">
  {running.length>0&&<section aria-label={zh?'此工作树中运行的服务':'Running in this worktree'}><h3>{zh?'此工作树中运行的服务':'Running in this worktree'}</h3>{running.map(session=><button type="button" className="wb-browser-start-row" data-browser-running key={session.id} onClick={()=>browser.open(session.run!.url!)}><span>{session.run!.url}</span><small>{session.run!.name}</small></button>)}</section>}
  {browser.recent.length>0&&<section aria-label={zh?'最近访问':'Recent'}><h3>{zh?'最近访问':'Recent'}</h3>{browser.recent.map(page=><button type="button" className="wb-browser-start-row" data-browser-recent key={page.url} onClick={()=>browser.open(page.url)}><span>{page.url}</span><small>{relative(page.openedAt)}</small></button>)}</section>}
  {!running.length&&!browser.recent.length&&<p>{zh?'输入网址，或运行服务后在这里打开。':'Enter an address, or run a server to open it here.'}</p>}
 </div>;
 return <div className="wb-side-browser">{browser.tabs.map(tab=><PanelBrowserPage key={tab.tabId} browser={browser} tab={tab} active={tab.tabId===browser.active} zh={zh} startPage={startPage} comments={comments}/>)}</div>;
}

/** The panel's tab strip, shown in its header in place of the "Browser" title once there are two tabs. */
export function PanelBrowserTabs({browser,zh}:{browser:BrowserModel;zh:boolean}) {
 const auxClose=(event:MouseEvent,tabId:string)=>{if(event.button===1){event.preventDefault();browser.close(tabId);}};
 return <div className="wb-browser-tabs" role="tablist" aria-label={zh?'浏览器标签页':'Browser tabs'}>
  {browser.tabs.map(tab=>{
   const selected=tab.tabId===browser.active,label=panelTabLabel(tab,zh);
   return <div key={tab.tabId} className={`wb-browser-tab${selected?' is-active':''}`} title={tab.url===BROWSER_NEW_TAB_URL?label:`${label}\n${tab.url}`} onAuxClick={event=>auxClose(event,tab.tabId)} onMouseDown={event=>{if(event.button===1)event.preventDefault();}}>
    <button type="button" role="tab" aria-selected={selected} className="wb-browser-tab-main" onClick={()=>browser.select(tab.tabId)}>{label}</button>
    <button type="button" className="cg-ghost cg-sm cg-icon wb-browser-tab-close" aria-label={zh?`关闭 ${label}`:`Close ${label}`} title={zh?'关闭标签页':'Close tab'} onClick={()=>browser.close(tab.tabId)}><WbIcon name="close"/></button>
   </div>;
  })}
 </div>;
}
