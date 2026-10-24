import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { FileReference, ResolvedFileReference } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { extractFileReferences, parseFileReference, parseMarkdownFileReference } from '../fileReferences';
import { useLocale } from '../i18n';

type OpenFile = (reference: FileReference) => void;
export type FileReferenceScope = { sourceSessionId?: string; canonicalRoot?: string };
const FileReferenceScopeContext = createContext<FileReferenceScope | undefined>(undefined);

/** Supplies one session/root to nested prose-reference renderers in a chat surface. */
export function FileReferenceScopeProvider({ sourceSessionId, canonicalRoot, children }: FileReferenceScope & { children: ReactNode }) {
 const value = useMemo(() => ({ sourceSessionId, canonicalRoot }), [canonicalRoot, sourceSessionId]);
 return <FileReferenceScopeContext.Provider value={value}>{children}</FileReferenceScopeContext.Provider>;
}

function useFileReferenceScope(sourceSessionId?: string, canonicalRoot?: string): FileReferenceScope {
 const scope = useContext(FileReferenceScopeContext);
 return {
  sourceSessionId: sourceSessionId ?? scope?.sourceSessionId,
  canonicalRoot: canonicalRoot ?? scope?.canonicalRoot,
 };
}

type AutoReference = ReturnType<typeof extractFileReferences>[number];
type AutoReferenceResolver = (sessionId:string, reference:FileReference)=>Promise<ResolvedFileReference>;
type CachedReference = { exists:boolean; expiresAt?:number };
type PendingReference = { promise:Promise<ResolvedFileReference|undefined>; interested:Set<()=>boolean> };
const AUTO_REFERENCE_LIMIT=32;
const AUTO_REFERENCE_CONCURRENCY=4;
const AUTO_REFERENCE_CACHE_LIMIT=512;
const AUTO_REFERENCE_QUEUE_LIMIT=128;
const AUTO_REFERENCE_NEGATIVE_TTL=30_000;
const autoReferenceCache=new Map<string,CachedReference>();
const sourceRoots=new Map<string,string>();
const pendingAutoReferences=new Map<string,PendingReference>();
const queuedAutoReferences:{run:()=>Promise<void>; current:()=>boolean}[]=[];
let activeAutoReferences=0;
let transportEpoch=0;

const referenceKey=(reference:FileReference)=>`${reference.path}\u0000${reference.line??''}\u0000${reference.column??''}`;
const cacheKey=(sessionId:string, root:string, reference:FileReference)=>`${sessionId}\u0000${root}\u0000${referenceKey(reference)}`;
const pendingKey=(key:string)=>`${transportEpoch}\u0000${key}`;
const asReference=({path,line,column}:FileReference):FileReference=>({path,...(line===undefined?{}:{line}),...(column===undefined?{}:{column})});
const cacheReference=(key:string, value:CachedReference)=>{
 autoReferenceCache.delete(key); autoReferenceCache.set(key,value);
 if(autoReferenceCache.size>AUTO_REFERENCE_CACHE_LIMIT) autoReferenceCache.delete(autoReferenceCache.keys().next().value!);
};
const rememberSourceRoot=(sessionId:string, root:string)=>{
 sourceRoots.delete(sessionId); sourceRoots.set(sessionId,root);
 if(sourceRoots.size>128) sourceRoots.delete(sourceRoots.keys().next().value!);
};
const drainAutoReferenceQueue=()=>{
 while(activeAutoReferences<AUTO_REFERENCE_CONCURRENCY&&queuedAutoReferences.length){
 const next=queuedAutoReferences.shift()!;
  if(!next.current()){void next.run();continue;}
  activeAutoReferences++;
  void next.run().finally(()=>{activeAutoReferences--;drainAutoReferenceQueue();});
 }
};
const sharedResolution=(key:string, current:()=>boolean, run:()=>Promise<ResolvedFileReference>)=>{
 const existing=pendingAutoReferences.get(key);
 if(existing){existing.interested.add(current);return existing.promise;}
 let settle:(value:ResolvedFileReference|undefined)=>void=()=>{};
 const promise=new Promise<ResolvedFileReference|undefined>(resolve=>{settle=resolve;});
 const interested=new Set<()=>boolean>([current]);
 const pending:PendingReference={promise,interested};
 pendingAutoReferences.set(key,pending);
 const execute=async()=>{
  try { settle([...interested].some(check=>check())?await run():undefined); }
  catch { settle(undefined); }
  finally { if(pendingAutoReferences.get(key)===pending)pendingAutoReferences.delete(key); }
 };
 if(queuedAutoReferences.length>=AUTO_REFERENCE_QUEUE_LIMIT){pendingAutoReferences.delete(key);settle(undefined);}
 else {queuedAutoReferences.push({run:execute,current:()=>[...interested].some(check=>check())});drainAutoReferenceQueue();}
 return promise;
};
export const invalidateAutoFileReferenceCache=()=>{transportEpoch++;autoReferenceCache.clear();sourceRoots.clear();};

/** Resolves only bounded auto-prose candidates. Structured provider references bypass this gate. */
export async function resolveAutoFileReferences({
 sessionId,
 canonicalRoot,
 candidates,
 resolve,
 current=()=>true,
}: {
 sessionId:string;
 canonicalRoot?:string;
 candidates:readonly AutoReference[];
 resolve:AutoReferenceResolver;
 current?:()=>boolean;
}):Promise<AutoReference[]> {
 const root=canonicalRoot??sourceRoots.get(sessionId)??'';
 const unique=[...new Map(candidates.slice(0,AUTO_REFERENCE_LIMIT).map(candidate=>[referenceKey(candidate),candidate])).values()];
 const accepted=new Set<string>();
 let next=0;
 const worker=async()=>{
  while(current()){
   const candidate=unique[next++]; if(!candidate)return;
   const key=referenceKey(candidate);
   const cachedKey=cacheKey(sessionId,root,candidate);
   const cache=autoReferenceCache.get(cachedKey);
   if(cache?.expiresAt!==undefined&&cache.expiresAt<=Date.now())autoReferenceCache.delete(cachedKey);
   else if(cache) { if(cache.exists) accepted.add(key); continue; }
   const resolved=await sharedResolution(pendingKey(cachedKey),current,()=>resolve(sessionId,asReference(candidate)));
   if(!current())continue;
   if(!resolved) { cacheReference(cachedKey,{exists:false,expiresAt:Date.now()+AUTO_REFERENCE_NEGATIVE_TTL}); continue; }
   const resolvedRoot=resolved.worktreePath??root;
   if(resolvedRoot) rememberSourceRoot(sessionId,resolvedRoot);
   cacheReference(cacheKey(sessionId,root,candidate),{exists:true});
   cacheReference(cacheKey(sessionId,resolvedRoot,candidate),{exists:true});
   accepted.add(key);
  }
 };
 await Promise.all(Array.from({length:Math.min(AUTO_REFERENCE_CONCURRENCY,unique.length)},worker));
 return current()?candidates.filter(candidate=>accepted.has(referenceKey(candidate))):[];
}

function useAutoReferences(content:string, candidates:readonly AutoReference[], interactive:boolean, sourceSessionId?:string, canonicalRoot?:string) {
 const [verified,setVerified]=useState<AutoReference[]>([]);
 const [revalidation,setRevalidation]=useState(0);
 const generation=useRef(0);
 useEffect(()=>{
  if(!sourceSessionId)return;
  return subscribeEvents(event=>{
   if(event.event==='runtime.transport'&&(event.data as {state?:string}|undefined)?.state==='reconnected'){
    generation.current++;invalidateAutoFileReferenceCache();setVerified([]);setRevalidation(value=>value+1);
   }
  });
 },[sourceSessionId]);
 useEffect(()=>{
  const id=++generation.current;
  setVerified([]);
  if(!interactive||!sourceSessionId||!candidates.length)return;
  void resolveAutoFileReferences({
   sessionId:sourceSessionId, canonicalRoot, candidates,
   resolve:(sessionId,reference)=>request('filesystem.resolve',{sessionId,...reference}),
   current:()=>generation.current===id,
  }).then(value=>{if(generation.current===id)setVerified(value);});
  return()=>{generation.current++;};
 },[canonicalRoot,candidates,content,interactive,revalidation,sourceSessionId]);
 return verified;
}

const sameReference = (a: FileReference, b: FileReference) =>
  a.path === b.path && a.line === b.line && a.column === b.column;
const utf8 = new TextEncoder();

// Structured tool paths are native candidates, not prose to classify by
// extension or separators. The runtime resolver remains authoritative.
function structuredPath(path: string): string | undefined {
  if (typeof path !== 'string') return;
  const value = path.trim();
  if (!value || value.length > 16 * 1024 || utf8.encode(value).length > 16 * 1024 || /\p{Cc}/u.test(value)) return;
  if (/^file:\/\//i.test(value)) {
    if (/[?#%]/.test(value)) return;
    const rest = value.slice(7);
    if (rest.startsWith('/')) {
      const local = rest.replace(/^\/+/, '');
      return /^[a-z]:[\\/]/i.test(local) ? local : undefined;
    }
    const slash = rest.indexOf('/');
    return slash > 0 && slash < rest.length - 1 ? `\\\\${rest.slice(0, slash)}\\${rest.slice(slash + 1)}` : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
  if (value.includes('://')) return;
  return value;
}

export function FileLinkedText({ text, openFile, sourceSessionId, canonicalRoot }: { text: string; openFile?: OpenFile; sourceSessionId?:string; canonicalRoot?:string }) {
  const scope=useFileReferenceScope(sourceSessionId,canonicalRoot);
  const candidates = useMemo(() => extractFileReferences(text), [text]);
  const interactive=Boolean(openFile);
  const verified=useAutoReferences(text,candidates,interactive,scope.sourceSessionId,scope.canonicalRoot);
  if (!openFile) return text;
  if (!scope.sourceSessionId||!verified.length) return text;
  const pieces: ReactNode[] = [];
  let offset = 0;
  for (const candidate of verified) {
    if (candidate.start < offset) continue;
    pieces.push(text.slice(offset, candidate.start));
    const reference = { path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) };
    pieces.push(<button type="button" className="file-reference-link" key={candidate.start} onClick={() => openFile(reference)} title={candidate.path}>{text.slice(candidate.start, candidate.end)}</button>);
    offset = candidate.end;
  }
  pieces.push(text.slice(offset));
  return <Fragment>{pieces}</Fragment>;
}

export function FileReferenceChips({ references, visibleText, visibleReferences, openFile }: { references?: FileReference[]; visibleText?: string; visibleReferences?:readonly FileReference[]; openFile?: OpenFile }) {
  const locale = useLocale();
  if (!openFile || !references?.length) return null;
  const unique: FileReference[] = [];
  const visible = visibleReferences ?? (visibleText ? extractFileReferences(visibleText) : []);
  for (const reference of references.slice(0, 256)) {
    const path = structuredPath(reference.path);
    if (!path) continue;
    const normalized = { path, ...(reference.line ? { line: reference.line } : {}), ...(reference.column ? { column: reference.column } : {}) };
    if (unique.some(value => sameReference(value, normalized))) continue;
    if (visible.some(value => sameReference(value, normalized))) continue;
    unique.push(normalized);
    if (unique.length === 32) break;
  }
  if (!unique.length) return null;
  return <div className="file-reference-chips" aria-label={locale === 'zh-CN' ? '文件引用' : 'File references'}>{unique.map((reference, index) =>
    <button type="button" className="file-reference-link" key={`${reference.path}:${index}`} onClick={() => openFile(reference)} title={reference.path}>{reference.path}{reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ''}` : ''}</button>
  )}</div>;
}

// The HTML has already passed DOMPurify. Only create textContent and inert
// buttons here; never carry raw model HTML into an attribute or URL.
// Remote-image placeholders carry author-chosen alt and host text, not prose to linkify.
function markdownAutoReferences(sanitized:string):AutoReference[] {
 const root=document.createElement('div'); root.innerHTML=sanitized;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const candidates:AutoReference[]=[];
 while(walker.nextNode()){
  const node=walker.currentNode as Text;
  if(node.parentElement?.closest('button, a, .md-remote-image'))continue;
  candidates.push(...extractFileReferences(node.textContent??''));
 }
 return candidates;
}

function markdownAnchorReferences(sanitized:string):FileReference[] {
 const root=document.createElement('div'); root.innerHTML=sanitized;
 const references:FileReference[]=[];
 for(const anchor of Array.from(root.querySelectorAll('a'))){
  let reference=parseMarkdownFileReference(anchor.getAttribute('href')??'');
  const encoded=anchor.getAttribute('data-threadterm-file-reference');
  if(encoded)try{
   const value=JSON.parse(encoded) as FileReference;
   if(value&&typeof value.path==='string'&&parseFileReference(value.path))reference=value;
  }catch{/* Ignore malformed inert metadata. */}
  if(reference)references.push(reference);
 }
 return references;
}

function decorateMarkdown(sanitized: string, interactive: boolean, accepted:ReadonlySet<string>): string {
  const root = document.createElement('div');
  root.innerHTML = sanitized;
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    let reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    const encoded = anchor.getAttribute('data-threadterm-file-reference');
    if (encoded) try {
      const value = JSON.parse(encoded) as FileReference;
      if (value && typeof value.path === 'string' && parseFileReference(value.path)
        && (value.line === undefined || Number.isSafeInteger(value.line) && value.line >= 1 && value.line <= 1_000_000)
        && (value.column === undefined || Number.isSafeInteger(value.column) && value.column >= 1 && value.column <= 1_000_000)) reference = value;
    } catch { /* Ignore malformed inert metadata. */ }
    if (!reference) continue;
    if (!interactive) {
      anchor.replaceWith(document.createTextNode(anchor.textContent || reference.path));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'file-reference-link';
    button.dataset.fileReference = JSON.stringify(reference);
    button.textContent = anchor.textContent || reference.path;
    anchor.replaceWith(button);
  }
  if (!interactive) return root.innerHTML;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (node.parentElement?.closest('button, a, .md-remote-image')) continue;
    const text = node.textContent ?? '';
    const candidates = extractFileReferences(text).filter(candidate=>accepted.has(referenceKey(candidate)));
    if (!candidates.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const candidate of candidates) {
      if (candidate.start < offset) continue;
      fragment.append(document.createTextNode(text.slice(offset, candidate.start)));
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'file-reference-link';
      button.dataset.fileReference = JSON.stringify({ path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) });
      button.textContent = text.slice(candidate.start, candidate.end);
      fragment.append(button);
      offset = candidate.end;
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

export function FileLinkedMarkdown({ sanitizedHtml, references, openFile, sourceSessionId, canonicalRoot, renderHtml }: { sanitizedHtml: string; references?: FileReference[]; openFile?: OpenFile; sourceSessionId?:string; canonicalRoot?:string; renderHtml?: (html: string) => ReactNode }) {
  const scope=useFileReferenceScope(sourceSessionId,canonicalRoot);
  const interactive = Boolean(openFile);
  const candidates=useMemo(()=>markdownAutoReferences(sanitizedHtml),[sanitizedHtml]);
  const anchors=useMemo(()=>markdownAnchorReferences(sanitizedHtml),[sanitizedHtml]);
  const verified=useAutoReferences(sanitizedHtml,candidates,interactive,scope.sourceSessionId,scope.canonicalRoot);
  const accepted=useMemo(()=>new Set(verified.map(referenceKey)),[verified]);
  const visibleReferences=useMemo(()=>[...anchors,...verified],[anchors,verified]);
  const rendered = useMemo(() => {
    const html = decorateMarkdown(sanitizedHtml, interactive, accepted);
    const container = document.createElement('div');
    container.innerHTML = html;
    return { innerHtml: { __html: html }, visibleText: container.textContent ?? '' };
  }, [accepted, interactive, sanitizedHtml]);
  const rich = useMemo(() => renderHtml?.(rendered.innerHtml.__html), [renderHtml, rendered]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-file-reference]') : null;
    if (!target || !event.currentTarget.contains(target) || !openFile) return;
    try {
      const reference = JSON.parse((target as HTMLElement).dataset.fileReference ?? '') as FileReference;
      if (parseFileReference(reference.path)) openFile(reference);
    } catch { /* Ignore malformed display metadata. */ }
  };
  return <>
    {renderHtml ? <div className="v3-message-text codex-markdown" onClick={onClick}>{rich}</div> : <div className="v3-message-text codex-markdown" dangerouslySetInnerHTML={rendered.innerHtml} onClick={onClick} />}
    <FileReferenceChips references={references} visibleReferences={visibleReferences} openFile={openFile} />
  </>;
}
