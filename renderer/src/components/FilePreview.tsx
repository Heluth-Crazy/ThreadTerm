import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { deletePageShots, onPageContextMenu, openExternal, request, selectAllPageText } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import type { CommentScope } from '../reviewComments';
import { PageCommentControls, PageCommentForm, usePageCommentPreview } from './PageComments';
import { PendingComments, useReviewComments } from './FileComments';
import { showContextMenu } from './ContextMenu';
import { renderedPreviewMenuItems } from '../fileSurfaceContextMenuItems';
import { webContextMenuItems } from '../webContextMenuItems';

export function withoutYamlFrontMatter(content:string):string {
  const match=/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if(!match)return content;
  const first=match[1].split(/\r?\n/).find(line=>line.trim()&&!line.trimStart().startsWith('#'));
  return first&&/^[A-Za-z_][\w-]*\s*:/.test(first.trim())?content.slice(match[0].length):content;
}

/** Normalize relative Markdown assets before the runtime enforces the root. */
export function relativeAsset(documentPath:string,source:string):string|undefined {
  if(!source||/^(?:[a-z][a-z0-9+.-]*:|[\\/]{1,2})/i.test(source))return;
  let decoded:string;try{decoded=decodeURIComponent(source.split(/[?#]/)[0]);}catch{return;}
  const parts=documentPath.replaceAll('\\','/').split('/').slice(0,-1);
  for(const segment of decoded.replaceAll('\\','/').split('/')){
    if(!segment||segment==='.')continue;
    if(segment==='..'){if(!parts.length)return;parts.pop();}
    else if(segment.includes(':')||segment.includes('\0'))return;
    else parts.push(segment);
  }
  return parts.join('/');
}
export function FilePreview({projectId,worktreePath,path,content,savedContent,image,embedded=false,commentScope,commentsHost,onShowSource,onSendToAgent}:{projectId:string;worktreePath?:string;path:string;content:string;savedContent:string;image?:{mime:string;data:string};embedded?:boolean;commentScope?:CommentScope;commentsHost?:FileCommentsHost;onShowSource?:()=>void;onSendToAgent?:()=>void}) {
  const [html,setHtml]=useState('');const [issue,setIssue]=useState<string>();const [loadedImage,setLoadedImage]=useState<{mime:string;data:string}>();
  const [address,setAddress]=useState('');const [liveUrl,setLiveUrl]=useState<string>();
  const [staticFrameName]=useState(()=>`tt-preview-static-${crypto.randomUUID()}`);const staticFrame=useRef<HTMLIFrameElement>(null);
  const markdown=/\.mdx?$/i.test(path),staticHtml=/\.html?$/i.test(path);
  const imageFile=/\.(?:png|jpe?g|gif|webp)$/i.test(path);
  const zh=document.documentElement.lang==='zh-CN';
  const pagePreview=usePageCommentPreview(liveUrl??'',commentScope,commentsHost,zh);
  const comments=useReviewComments(commentScope);
  useEffect(()=>{setLoadedImage(undefined);},[projectId,worktreePath,path]);
  useEffect(()=>{
    pagePreview.cancel();
    let active=true;setIssue(undefined);setLiveUrl(undefined);
    void (async()=>{
      const markdownContent=withoutYamlFrontMatter(content);
      const raw=markdown?await marked.parse(markdownContent,{gfm:true}):savedContent;
      const safe=DOMPurify.sanitize(raw,{FORBID_TAGS:['script','iframe','object','embed','form','input','button','link','meta','base','svg','math','audio','video','source','track',...(markdown?['style']:[])],FORBID_ATTR:markdown?['style','srcset','background','poster']:['srcset'],ADD_TAGS:markdown?[]:['style'],SANITIZE_NAMED_PROPS:true});
      const fragment=new DOMParser().parseFromString(safe,'text/html');
      await Promise.all([...fragment.querySelectorAll('img')].map(async image=>{
        const relative=relativeAsset(path,image.getAttribute('src')??'');
        image.removeAttribute('src');image.removeAttribute('srcset');
        if(!relative){image.alt=image.alt||'Image is outside this workspace';return;}
        try{const asset=await request('filesystem.image',{projectId,worktreePath,path:relative});image.src=`data:${asset.mime};base64,${asset.data}`;}
        catch{image.alt=image.alt||`Image unavailable: ${relative}`;}
      }));
      for(const anchor of fragment.querySelectorAll('a')){
        const href=anchor.getAttribute('href')??'';
        if(!/^https?:\/\//i.test(href)&&!href.startsWith('#'))anchor.removeAttribute('href');
        anchor.removeAttribute('target');anchor.removeAttribute('download');
      }
      if(active)setHtml(fragment.body.innerHTML);
    })().catch(error=>{if(active)setIssue(error instanceof Error?error.message:String(error));});
    return()=>{active=false;};
  },[projectId,worktreePath,path,markdown,content,savedContent]);
  useEffect(()=>{if(!imageFile||image)return;let active=true;void request('filesystem.image',{projectId,worktreePath,path}).then(asset=>{if(active)setLoadedImage(asset);}).catch(error=>{if(active)setIssue(error instanceof Error?error.message:String(error));});return()=>{active=false;};},[projectId,worktreePath,path,imageFile,image]);
  function previewAddress(){try{const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw Error();pagePreview.cancel();setLiveUrl(url.href);setIssue(undefined);}catch{setIssue(zh?'请输入 HTTP 或 HTTPS 地址。':'Use an HTTP or HTTPS address.');}}
  const openPreviewMenu=(event:React.MouseEvent<HTMLElement>)=>{
    event.preventDefault();
    const target=event.currentTarget;
    const selected=window.getSelection()?.toString()??'';
    showContextMenu({x:event.clientX,y:event.clientY,restoreFocus:target,items:renderedPreviewMenuItems({zh,hasSelection:Boolean(selected),send:onSendToAgent,source:onShowSource,copy:()=>selected?navigator.clipboard.writeText(selected):undefined,selectAll:()=>{const range=document.createRange();range.selectNodeContents(target);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);}})});
  };
  useEffect(()=>onPageContextMenu(({frameName,x,y,pick,staticFrame:staticEvent,selectionText})=>{
    if(staticEvent&&frameName===staticFrameName&&staticFrame.current){showContextMenu({x,y,restoreFocus:staticFrame.current,items:renderedPreviewMenuItems({zh,hasSelection:Boolean(selectionText),send:onSendToAgent,source:onShowSource,copy:()=>navigator.clipboard.writeText(selectionText),selectAll:async()=>{await selectAllPageText(frameName);}})});return;}
    if(frameName!==pagePreview.frameName||!pick)return;
    const commentId='file-preview-context-comment-element';
    showContextMenu({x,y,restoreFocus:pagePreview.iframe.current,onDismiss:selected=>{if(selected?.testId!==commentId&&pick.shot)void deletePageShots([pick.shot.id]).catch(()=>undefined);},items:webContextMenuItems({pick,zh,enabled:pagePreview.enabled,comment:()=>pagePreview.acceptPick(pick),reload:()=>{pagePreview.cancel(false);if(pagePreview.iframe.current&&liveUrl)pagePreview.iframe.current.src=liveUrl;},copy:()=>navigator.clipboard.writeText(pick.target.type==='element'?pick.target.text??'':'')}).map(item=>({...item,testId:item.testId?.replace('web-preview','file-preview-context')}))});
  }),[pagePreview.frameName,pagePreview.enabled,pagePreview.acceptPick,staticFrameName,liveUrl,zh,onSendToAgent,onShowSource]);
  const isImage=Boolean(image)||imageFile;const asset=isImage?(image??loadedImage):undefined;
  return <section className="file-preview">{asset?<div className="file-image-preview"><img alt={path.split(/[\\/]/).at(-1)??'Image'} src={`data:${asset.mime};base64,${asset.data}`}/></div>:markdown?<div className="markdown-preview tt-preview-markdown" data-testid="file-preview-rendered" tabIndex={0} onContextMenu={openPreviewMenu} onClick={event=>{const anchor=(event.target as Element).closest('a');if(!anchor)return;const href=anchor.getAttribute('href');if(href&&/^https?:\/\//i.test(href)){event.preventDefault();void openExternal(href).catch(error=>setIssue(String(error)));}}} dangerouslySetInnerHTML={{__html:html}}/>:staticHtml?<><p>{zh?'静态 HTML 显示已保存的文件。':'Static HTML displays the saved file.'}</p><iframe ref={staticFrame} name={staticFrameName} className="tt-preview-frame" title={zh?'已保存的 HTML 预览':'Saved HTML preview'} sandbox="" srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"></head><body>${html}</body></html>`}/></>:<p className="tt-editor-state">{zh?'此文件不支持文档预览。':'Document preview is unavailable for this file type.'}</p>}{(!embedded||Boolean(commentScope&&commentsHost))&&!asset&&!isImage&&<div className="preview-address"><input aria-label={zh?'开发服务地址':'Development preview address'} placeholder="http://localhost:3000" value={address} onChange={event=>setAddress(event.target.value)}/><button type="button" onClick={previewAddress}>{zh?'预览地址':'Preview address'}</button>{liveUrl&&<PageCommentControls preview={pagePreview} zh={zh}/>}</div>}{liveUrl&&<iframe ref={pagePreview.iframe} name={pagePreview.frameName} className="tt-preview-frame" title={zh?'开发服务预览':'Development service preview'} sandbox="allow-scripts allow-forms" src={liveUrl} onLoad={()=>{if(pagePreview.pick||pagePreview.picking)pagePreview.cancel();}}/>}<PageCommentForm preview={pagePreview} scope={commentScope} zh={zh}/>{commentScope&&commentsHost&&<PendingComments scope={commentScope} host={commentsHost} comments={comments} zh={zh}/>} {issue&&<p role="alert">{issue}</p>}{pagePreview.issue&&<p className="wb-issue" role="alert">{pagePreview.issue}</p>}</section>;
}
