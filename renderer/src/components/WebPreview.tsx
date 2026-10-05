import { useState } from 'react';
import { openExternal } from '../bridge';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import '../workbench/workbench.css';

/** A web page opened from a terminal link, in a tab beside its session. Same sandbox as the development-address
 * preview in FilePreview: scripts and forms run, but the page gets no storage of its own and cannot reach the app. */
export function WebPreview({url, zh}:{url:string;zh:boolean}) {
 const [load, setLoad] = useState(0);
 const [issue, setIssue] = useState<string>();
 const copy = (en:string, cn:string) => zh ? cn : en;
 return <section className="wb-web-preview">
  <div className="file-bar">
   <Icon name="popout"/>
   <span className="path" title={url}>{url}</span>
   <span className="grow"/>
   <button type="button" className="icon-btn" title={copy('Reload', '重新加载')} aria-label={copy('Reload', '重新加载')} onClick={() => setLoad(value => value + 1)}><WbIcon name="refresh"/></button>
   <button type="button" className="btn btn-sm" onClick={() => void openExternal(url).catch(error => setIssue(String(error)))}>{copy('Open in browser', '在浏览器中打开')}</button>
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  <iframe key={load} className="tt-preview-frame" title={copy('Web preview', '网页预览')} sandbox="allow-scripts allow-forms" src={url}/>
  <p className="wb-web-preview-note">{copy('If the page stays blank or refuses to load here, open it in the browser.', '若页面空白或拒绝在此显示，请在浏览器中打开。')}</p>
 </section>;
}
