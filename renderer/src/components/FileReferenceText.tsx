import { Fragment, createContext, memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { FileReference, ResolvedFileReference } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { extractFileReferences, parseFileReference, parseMarkdownFileReference } from '../fileReferences';
import { useLocale } from '../i18n';
import { showContextMenu } from './ContextMenu';
import { fileLocationLabel, fileLocationMenuItem, revealFileLocation } from '../fileLocation';
import { referenceLocationTarget } from '../referenceLocation';
import { isPackageFile } from '../packageFiles';

type OpenFile = (reference: FileReference) => void;

/** Beside a link to an archive, package or program (a .jar the agent just built): its folder, one click away.
 * Opening such a file only says it is not text, so this is the useful choice. */
function PackageReveal({ reference, sessionId, zh }: { reference: FileReference; sessionId?: string; zh: boolean }) {
  const target = isPackageFile(reference.path) ? referenceLocationTarget(sessionId, reference) : undefined;
  if (!target) return null;
  const label = fileLocationLabel(zh);
  return <button type="button" className="file-reference-reveal" aria-label={`${label}: ${reference.path}`} title={label} data-testid="file-reference-package-reveal" onClick={() => void revealFileLocation(target, zh)} />;
}

/** The same button for Markdown, built as an inert element: the HTML path keeps only data- and aria- attributes. */
function packageRevealButton(reference: FileReference, zh: boolean): HTMLButtonElement | undefined {
  if (!isPackageFile(reference.path)) return undefined;
  const label = fileLocationLabel(zh);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'file-reference-reveal';
  button.dataset.fileReveal = JSON.stringify({ path: reference.path });
  button.dataset.testid = 'file-reference-package-reveal';
  button.setAttribute('aria-label', `${label}: ${reference.path}`); button.title = label;
  return button;
}

function referenceContextMenu(event: MouseEvent<HTMLElement>, reference: FileReference, sessionId: string | undefined, openFile: OpenFile, zh: boolean): void {
  event.preventDefault();
  event.stopPropagation();
  const target = referenceLocationTarget(sessionId, reference);
  const link = event.target instanceof Element ? event.target.closest<HTMLElement>('button.file-reference-link') : null;
  const anchor = link && event.currentTarget.contains(link) ? link : event.currentTarget;
  const rect = anchor.getBoundingClientRect();
  showContextMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, restoreFocus: anchor, items: [
    { id: 'file-reference-open', label: zh ? '在编辑器中打开' : 'Open in editor', onSelect: () => openFile(reference) },
    ...(target ? [{ ...fileLocationMenuItem(target, zh), id: 'file-reference-reveal', testId: 'file-reference-reveal' }] : []),
    { id: 'file-reference-copy-path', label: zh ? '复制路径' : 'Copy path', onSelect: () => navigator.clipboard.writeText(target?.path ?? reference.path) },
    { id: 'file-reference-copy', label: zh ? '复制引用' : 'Copy reference', onSelect: () => navigator.clipboard.writeText(`${reference.path}${reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ''}` : ''}`) },
  ] });
}
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

type VerifiedKeys = { scope:string; keys:ReadonlySet<string> };
const NO_REFERENCES:readonly AutoReference[]=[];
/** The candidates that name existing files. State keeps only the verified keys (tagged with session, root, whether links
 * are interactive and the reconnect revision); the list is derived from the current candidates, so offsets always fit
 * the current text. New text keeps the links already known while its own resolution runs, instead of dropping every
 * link and painting twice per streamed snapshot. A finished resolution covers exactly the current eligible keys (the
 * first `AUTO_REFERENCE_LIMIT` candidates, as `resolveAutoFileReferences` takes them) and replaces the set. */
function useAutoReferences(content:string, candidates:readonly AutoReference[], interactive:boolean, sourceSessionId?:string, canonicalRoot?:string) {
 const [revalidation,setRevalidation]=useState(0);
 const scope=`${interactive?1:0}\u0000${sourceSessionId??''}\u0000${canonicalRoot??''}\u0000${revalidation}`;
 const [verified,setVerified]=useState<VerifiedKeys>(()=>({scope,keys:new Set()}));
 const generation=useRef(0);
 useEffect(()=>{
  if(!sourceSessionId)return;
  return subscribeEvents(event=>{
   if(event.event==='runtime.transport'&&(event.data as {state?:string}|undefined)?.state==='reconnected'){
    generation.current++;invalidateAutoFileReferenceCache();setRevalidation(value=>value+1);
   }
  });
 },[sourceSessionId]);
 useEffect(()=>{
  const id=++generation.current;
  if(!interactive||!sourceSessionId||!candidates.length)return;
  void resolveAutoFileReferences({
   sessionId:sourceSessionId, canonicalRoot, candidates,
   resolve:(sessionId,reference)=>request('filesystem.resolve',{sessionId,...reference}),
   current:()=>generation.current===id,
  }).then(value=>{
   if(generation.current!==id)return;
   const keys=new Set(value.map(referenceKey));
   setVerified(current=>current.scope===scope&&current.keys.size===keys.size&&[...keys].every(key=>current.keys.has(key))?current:{scope,keys});
  });
  return()=>{generation.current++;};
 },[canonicalRoot,candidates,content,interactive,scope,sourceSessionId]);
 return useMemo(()=>{
  if(verified.scope!==scope||!verified.keys.size||!interactive||!sourceSessionId)return NO_REFERENCES;
  const eligible=new Set(candidates.slice(0,AUTO_REFERENCE_LIMIT).map(referenceKey));
  const list=candidates.filter(candidate=>{const key=referenceKey(candidate);return eligible.has(key)&&verified.keys.has(key);});
  return list.length?list:NO_REFERENCES;
 },[candidates,interactive,scope,sourceSessionId,verified]);
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
  const zh = useLocale() === 'zh-CN';
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
    pieces.push(<button type="button" className="file-reference-link" key={candidate.start} onClick={() => openFile(reference)} onContextMenu={event => referenceContextMenu(event, reference, scope.sourceSessionId, openFile, zh)} title={candidate.path}>{text.slice(candidate.start, candidate.end)}</button>);
    pieces.push(<PackageReveal key={`${candidate.start}:reveal`} reference={reference} sessionId={scope.sourceSessionId} zh={zh} />);
    offset = candidate.end;
  }
  pieces.push(text.slice(offset));
  return <Fragment>{pieces}</Fragment>;
}

export function FileReferenceChips({ references, visibleText, visibleReferences, openFile, sourceSessionId }: { references?: FileReference[]; visibleText?: string; visibleReferences?:readonly FileReference[]; openFile?: OpenFile; sourceSessionId?: string }) {
  const locale = useLocale();
  const scope = useFileReferenceScope(sourceSessionId);
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
    <Fragment key={`${reference.path}:${index}`}><button type="button" className="file-reference-link" onClick={() => openFile(reference)} onContextMenu={event => referenceContextMenu(event, reference, scope.sourceSessionId, openFile, locale === 'zh-CN')} title={reference.path}>{reference.path}{reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ''}` : ''}</button><PackageReveal reference={reference} sessionId={scope.sourceSessionId} zh={locale === 'zh-CN'} /></Fragment>
  )}</div>;
}

// The HTML has already passed DOMPurify. Only create textContent and inert
// buttons here; never carry raw model HTML into an attribute or URL.
// Remote-image placeholders carry author-chosen alt and host text, not prose to linkify.
/** The auto-reference candidates (prose that looks like a file) and Markdown links to files in sanitized HTML. */
export function analyzeMarkdownHtml(sanitized: string): { candidates: AutoReference[]; anchors: FileReference[] } {
  const root = document.createElement('div'); root.innerHTML = sanitized;
  const candidates: AutoReference[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('button, a, .md-remote-image')) continue;
    candidates.push(...extractFileReferences(node.textContent ?? ''));
  }
  const anchors: FileReference[] = [];
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    let reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    const encoded = anchor.getAttribute('data-threadterm-file-reference');
    if (encoded) try {
      const value = JSON.parse(encoded) as FileReference;
      if (value && typeof value.path === 'string' && parseFileReference(value.path)) reference = value;
    } catch { /* Ignore malformed inert metadata. */ }
    if (reference) anchors.push(reference);
  }
  return { candidates, anchors };
}

function decorateMarkdown(sanitized: string, interactive: boolean, accepted:ReadonlySet<string>, reveal?: { zh: boolean }): string {
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
    const revealButton = reveal && packageRevealButton(reference, reveal.zh);
    if (revealButton) anchor.replaceWith(button, revealButton); else anchor.replaceWith(button);
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
      const revealButton = reveal && packageRevealButton({ path: candidate.path }, reveal.zh);
      if (revealButton) fragment.append(revealButton);
      offset = candidate.end;
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

/** Clicks on the inert buttons decorateMarkdown leaves in rendered Markdown. */
function markdownReferenceHandlers(openFile: OpenFile | undefined, sourceSessionId: string | undefined, zh: boolean) {
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const reveal = event.target instanceof Element ? event.target.closest<HTMLElement>('button[data-file-reveal]') : null;
    if (reveal && event.currentTarget.contains(reveal)) {
      try {
        const reference = JSON.parse(reveal.dataset.fileReveal ?? '') as FileReference;
        const location = isPackageFile(reference.path) ? referenceLocationTarget(sourceSessionId, reference) : undefined;
        if (location) void revealFileLocation(location, zh);
      } catch { /* Ignore malformed display metadata. */ }
      return;
    }
    const target = event.target instanceof Element ? event.target.closest('button[data-file-reference]') : null;
    if (!target || !event.currentTarget.contains(target) || !openFile) return;
    try {
      const reference = JSON.parse((target as HTMLElement).dataset.fileReference ?? '') as FileReference;
      if (parseFileReference(reference.path)) openFile(reference);
    } catch { /* Ignore malformed display metadata. */ }
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-file-reference]') : null;
    if (!target || !event.currentTarget.contains(target) || !openFile) return;
    try {
      const reference = JSON.parse((target as HTMLElement).dataset.fileReference ?? '') as FileReference;
      if (typeof reference.path === 'string' && parseFileReference(reference.path)) referenceContextMenu(event, reference, sourceSessionId, openFile, zh);
    } catch { /* Ignore malformed display metadata. */ }
  };
  return { onClick, onContextMenu };
}

export function FileLinkedMarkdown({ sanitizedHtml, references, openFile, sourceSessionId, canonicalRoot, renderHtml }: { sanitizedHtml: string; references?: FileReference[]; openFile?: OpenFile; sourceSessionId?:string; canonicalRoot?:string; renderHtml?: (html: string) => ReactNode }) {
  const scope=useFileReferenceScope(sourceSessionId,canonicalRoot);
  const zh = useLocale() === 'zh-CN';
  const interactive = Boolean(openFile);
  const { candidates, anchors } = useMemo(() => analyzeMarkdownHtml(sanitizedHtml), [sanitizedHtml]);
  const verified=useAutoReferences(sanitizedHtml,candidates,interactive,scope.sourceSessionId,scope.canonicalRoot);
  const accepted=useMemo(()=>new Set(verified.map(referenceKey)),[verified]);
  const visibleReferences=useMemo(()=>[...anchors,...verified],[anchors,verified]);
  const rendered = useMemo(() => ({ innerHtml: { __html: decorateMarkdown(sanitizedHtml, interactive, accepted, scope.sourceSessionId ? { zh } : undefined) } }),
    [accepted, interactive, sanitizedHtml, scope.sourceSessionId, zh]);
  const rich = useMemo(() => renderHtml?.(rendered.innerHtml.__html), [renderHtml, rendered]);
  const { onClick, onContextMenu } = markdownReferenceHandlers(openFile, scope.sourceSessionId, zh);
  return <>
    {renderHtml ? <div className="v3-message-text codex-markdown" onClick={onClick} onContextMenu={onContextMenu}>{rich}</div> : <div className="v3-message-text codex-markdown" dangerouslySetInnerHTML={rendered.innerHtml} onClick={onClick} onContextMenu={onContextMenu} />}
    <FileReferenceChips references={references} visibleReferences={visibleReferences} openFile={openFile} sourceSessionId={scope.sourceSessionId} />
  </>;
}

/** One rendered block of a streaming reply: its sanitized HTML and the file references in it, found with one parse. */
export type MarkdownBlock = { id: number; html: string; candidates: readonly AutoReference[]; anchors: readonly FileReference[] };

type BlockProps = { html: string; interactive: boolean; accepted: ReadonlySet<string>; acceptedKey: string; revealZh?: boolean; renderHtml?: (html: string) => ReactNode; renderKey: string };
/** Re-rendered only when its own HTML, its own verified links or the rendering mode change: an unchanged block keeps
 * its DOM (and the selection in it) while the reply streams on. `display: contents`, so the blocks lay out as if the
 * reply were one container (styles.css restates the position rules for it). */
const MarkdownHtmlBlock = memo(function MarkdownHtmlBlock({ html, interactive, accepted, revealZh, renderHtml }: BlockProps) {
  const decorated = decorateMarkdown(html, interactive, accepted, revealZh === undefined ? undefined : { zh: revealZh });
  return renderHtml ? <div className="md-stream-block">{renderHtml(decorated)}</div> : <div className="md-stream-block" dangerouslySetInnerHTML={{ __html: decorated }} />;
}, (a, b) => a.html === b.html && a.interactive === b.interactive && a.acceptedKey === b.acceptedKey && a.revealZh === b.revealZh
  && Boolean(a.renderHtml) === Boolean(b.renderHtml) && a.renderKey === b.renderKey);

/** `FileLinkedMarkdown` for a reply rendered block by block (ChatView `CodexMarkdownPart`): the same links, buttons and
 * chips, with one part-wide reference budget, but only changed blocks are decorated and put into the DOM again.
 * `renderHtml` (the rich path for Markdown extras) must stay valid for the same `renderKey`. */
export function FileLinkedMarkdownBlocks({ blocks, references, openFile, sourceSessionId, canonicalRoot, renderHtml, renderKey }: { blocks: readonly MarkdownBlock[]; references?: FileReference[]; openFile?: OpenFile; sourceSessionId?: string; canonicalRoot?: string; renderHtml?: (html: string) => ReactNode; renderKey: string }) {
  const scope = useFileReferenceScope(sourceSessionId, canonicalRoot);
  const zh = useLocale() === 'zh-CN';
  const interactive = Boolean(openFile);
  // Stable while the set of references is unchanged, so a snapshot that only adds prose resolves nothing again.
  const candidateList = blocks.flatMap(block => block.candidates);
  const candidateKey = candidateList.map(referenceKey).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const candidates = useMemo(() => candidateList, [candidateKey]);
  const anchorList = blocks.flatMap(block => block.anchors);
  const anchorKey = anchorList.map(referenceKey).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => anchorList, [anchorKey]);
  const verified = useAutoReferences(candidateKey, candidates, interactive, scope.sourceSessionId, scope.canonicalRoot);
  const accepted = useMemo(() => new Set(verified.map(referenceKey)), [verified]);
  const visibleReferences = useMemo(() => [...anchors, ...verified], [anchors, verified]);
  const revealZh = scope.sourceSessionId ? zh : undefined;
  const { onClick, onContextMenu } = markdownReferenceHandlers(openFile, scope.sourceSessionId, zh);
  return <>
    <div className="v3-message-text codex-markdown" onClick={onClick} onContextMenu={onContextMenu}>
      {blocks.map(block => <MarkdownHtmlBlock key={block.id} html={block.html} interactive={interactive} accepted={accepted}
        acceptedKey={block.candidates.map(referenceKey).filter(key => accepted.has(key)).join('\n')} revealZh={revealZh} renderHtml={renderHtml} renderKey={renderKey} />)}
    </div>
    <FileReferenceChips references={references} visibleReferences={visibleReferences} openFile={openFile} sourceSessionId={scope.sourceSessionId} />
  </>;
}
