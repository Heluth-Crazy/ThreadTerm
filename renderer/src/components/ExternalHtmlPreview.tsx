import { useMemo } from 'react';
import DOMPurify from 'dompurify';

/** External registration grants one file, never its directory or linked resources. */
export function ExternalHtmlPreview({content,zh}:{content:string;zh:boolean}) {
 const document=useMemo(()=>{
  const safe=DOMPurify.sanitize(content,{WHOLE_DOCUMENT:true,FORBID_TAGS:['script','iframe','frame','frameset','object','embed','base','meta','form','link'],FORBID_ATTR:['src','srcset','href','xlink:href','action','formaction','poster','background','ping','srcdoc']});
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">${safe}`;
 },[content]);
 return <div className="external-html-preview"><p className="dim">{zh?'静态沙箱预览 · 脚本和外部资源已阻止':'Static sandboxed preview · scripts and external resources blocked'}</p><iframe title={zh?'工作区外 HTML 预览':'Outside workspace HTML preview'} sandbox="" srcDoc={document}/></div>;
}
