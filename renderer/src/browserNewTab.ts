import type { PaneLayout } from '@threadterm/protocol';

// Saved layouts accept HTTP(S) only. This reserved URL is a DOM-only blank tab, never a page to fetch.
export const BROWSER_NEW_TAB_URL = 'https://threadterm.invalid/new-tab';

/** Apply page metadata to a still-open tab without replacing newer tabs or changing selection. */
export function updateBrowserTab(layout:PaneLayout,id:string,url:string,title:string):PaneLayout {
 if(layout.kind==='pane'){
  const tab=layout.tabs.find(item=>item.id===id&&item.kind==='web');
  if(!tab||tab.kind!=='web'||tab.url===url&&tab.title===title)return layout;
  return {...layout,tabs:layout.tabs.map(item=>item===tab?{...tab,url,title}:item)};
 }
 const first=updateBrowserTab(layout.first,id,url,title),second=updateBrowserTab(layout.second,id,url,title);
 return first===layout.first&&second===layout.second?layout:{...layout,first,second};
}
