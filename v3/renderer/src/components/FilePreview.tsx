import { useEffect, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openExternal, request } from '../bridge';

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
export function FilePreview({projectId,worktreePath,path,content,savedContent}:{projectId:string;worktreePath?:string;path:string;content:string;savedContent:string}) {
  const [html,setHtml]=useState('');const [issue,setIssue]=useState<string>();
  const [address,setAddress]=useState('');const [liveUrl,setLiveUrl]=useState<string>();
  const markdown=/\.mdx?$/i.test(path),staticHtml=/\.html?$/i.test(path);
  const zh=document.documentElement.lang==='zh-CN';
  useEffect(()=>{
    let active=true;setIssue(undefined);setLiveUrl(undefined);
    void (async()=>{
      const raw=markdown?await marked.parse(content,{gfm:true}):savedContent;
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
  function previewAddress(){try{const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw Error('Use an HTTP or HTTPS address.');setLiveUrl(url.href);setIssue(undefined);}catch(error){setIssue(String(error));}}
  return <section className="file-preview">{markdown?<div className="markdown-preview tt-preview-markdown" onClick={event=>{const anchor=(event.target as Element).closest('a');if(!anchor)return;const href=anchor.getAttribute('href');if(href&&/^https?:\/\//i.test(href)){event.preventDefault();void openExternal(href).catch(error=>setIssue(String(error)));}}} dangerouslySetInnerHTML={{__html:html}}/>:staticHtml?<><p>{zh?'静态 HTML 显示已保存的文件。':'Static HTML displays the saved file.'}</p><iframe className="tt-preview-frame" title="Saved HTML preview" sandbox="" srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"></head><body>${html}</body></html>`}/></>:<p className="tt-editor-state">{zh?'此文件不支持文档预览。':'Document preview is unavailable for this file type.'}</p>}<div className="preview-address"><input aria-label={zh?'开发服务地址':'Development preview address'} placeholder="http://localhost:3000" value={address} onChange={event=>setAddress(event.target.value)}/><button onClick={previewAddress}>{zh?'预览地址':'Preview address'}</button></div>{liveUrl&&<iframe className="tt-preview-frame" title="Development service preview" sandbox="allow-scripts allow-forms" src={liveUrl}/>} {issue&&<p role="alert">{issue}</p>}</section>;
}
