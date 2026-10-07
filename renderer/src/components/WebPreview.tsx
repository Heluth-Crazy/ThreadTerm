import { useEffect, useState } from 'react';
import { deletePageShots, onPageContextMenu, openExternal } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import type { CommentScope } from '../reviewComments';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { PageCommentControls, PageCommentForm, usePageCommentPreview } from './PageComments';
import { PendingComments, useReviewComments } from './FileComments';
import { showContextMenu } from './ContextMenu';
import { webContextMenuItems } from '../webContextMenuItems';
import '../workbench/workbench.css';

/** A web page opened from a terminal link, in a tab beside its session. Same sandbox as the development-address
 * preview in FilePreview: scripts and forms run, but the page gets no storage of its own and cannot reach the app. */
export function WebPreview({url, zh, commentScope, commentsHost}:{url:string;zh:boolean;commentScope?:CommentScope;commentsHost?:FileCommentsHost}) {
 const [load, setLoad] = useState(0);
 const [issue, setIssue] = useState<string>();
 const preview=usePageCommentPreview(url,commentScope,commentsHost,zh);
 const comments=useReviewComments(commentScope);
 const copy = (en:string, cn:string) => zh ? cn : en;
 useEffect(()=>onPageContextMenu(({frameName,x,y,pick})=>{
  if(frameName!==preview.frameName||!pick)return;
  showContextMenu({x,y,restoreFocus:preview.iframe.current,onDismiss:selected=>{if(selected?.testId!=='web-preview-comment-element'&&pick.shot)void deletePageShots([pick.shot.id]).catch(()=>undefined);},items:webContextMenuItems({pick,zh,enabled:preview.enabled,comment:()=>preview.acceptPick(pick),reload:()=>{preview.cancel(false);setLoad(value=>value+1);},copy:()=>navigator.clipboard.writeText(pick.target.type==='element' ? (pick.target.text ?? '') : '')})});
 }),[preview.frameName,preview.acceptPick,zh]);
 return <section className="wb-web-preview">
  <div className="file-bar">
   <Icon name="popout"/>
   <span className="path" title={url}>{url}</span>
   <span className="grow"/>
   <PageCommentControls preview={preview} zh={zh}/>
   <button type="button" className="icon-btn" title={copy('Reload', '重新加载')} aria-label={copy('Reload', '重新加载')} onClick={() => { preview.cancel();setLoad(value => value + 1); }}><WbIcon name="refresh"/></button>
   <button type="button" className="btn btn-sm" onClick={() => void openExternal(url).catch(error => setIssue(String(error)))}>{copy('Open in browser', '在浏览器中打开')}</button>
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {preview.issue && <p className="wb-issue" role="alert">{preview.issue}</p>}
  <iframe ref={preview.iframe} name={preview.frameName} key={load} className="tt-preview-frame" title={copy('Web preview', '网页预览')} sandbox="allow-scripts allow-forms" src={url} onLoad={()=>{if(preview.pick||preview.picking)preview.cancel();}}/>
  <PageCommentForm preview={preview} scope={commentScope} zh={zh}/>
  {commentScope&&commentsHost&&<PendingComments scope={commentScope} host={commentsHost} comments={comments} zh={zh}/>}
  <p className="wb-web-preview-note">{copy('If the page stays blank or refuses to load here, open it in the browser.', '若页面空白或拒绝在此显示，请在浏览器中打开。')}</p>
 </section>;
}
