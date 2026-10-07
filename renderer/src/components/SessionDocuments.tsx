import { useCallback, useEffect, useState } from 'react';
import type { ReviewFile } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { documentTitle, firstReadyCheckpoint, sessionDocumentError, suggestedDocuments } from '../sessionDocuments';
import type { useSessionDocuments } from '../useSessionDocuments';
import { FILES_CHANGED_EVENT } from '../workbench/types';
import { Icon } from './PrototypeIcon';
import './session-documents.css';

type Props = {sessionId:string; zh:boolean; state:ReturnType<typeof useSessionDocuments>; onPick:()=>void; openFile:(path:string)=>void};

export function SessionDocuments({sessionId, zh, state, onPick, openFile}:Props) {
 const [changes, setChanges] = useState<ReviewFile[]>([]), [suggestionError, setSuggestionError] = useState<string>();
 const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>();
 const text = (en:string, cn:string) => zh ? cn : en;
 useEffect(() => state.retain(), [state.retain]);
 useEffect(() => {
  let live = true, generation = 0;
  setChanges([]); setSuggestionError(undefined); setIssue(undefined);
  const load = async () => {
   const ticket = ++generation;
   try {
    const review = await request('review.list', {sessionId});
    if(!live || ticket !== generation) return;
    const first = firstReadyCheckpoint(review.checkpoints);
    const files = review.available && first ? (await request('review.changes', {sessionId, from:first.id})).files : [];
    if(live && ticket === generation) { setChanges(files); setSuggestionError(undefined); }
   } catch(error) { if(live && ticket === generation) { setChanges([]); setSuggestionError(sessionDocumentError(error, zh)); } }
  };
  const changed = () => { state.refresh(); void load(); };
  void load();
  addEventListener(FILES_CHANGED_EVENT, changed);
  addEventListener('focus', changed);
  const unsubscribe = subscribeEvents(event => {
   const data = event.data as {kind?:string;sessionId?:string}|undefined;
   if(data?.sessionId === sessionId && (event.event === 'session.status' || event.event === 'session.activity' || (event.event === 'state.changed' && data.kind !== 'session.documents'))) void load();
  });
  return () => { live = false; generation++; unsubscribe(); removeEventListener(FILES_CHANGED_EVENT, changed); removeEventListener('focus', changed); };
 }, [sessionId, zh, state.refresh]);
 const mutate = useCallback(async (path:string, pin:boolean) => {
  setBusy(true); setIssue(undefined);
  try { await (pin ? state.pin(path) : state.unpin(path)); }
  catch(error) { setIssue(sessionDocumentError(error, zh)); }
  finally { setBusy(false); }
 }, [state.pin, state.unpin, zh]);
 const suggestions = suggestedDocuments(changes, state.documents);
 const error = issue || state.error || suggestionError;
 return <div className="ins-block session-documents" data-testid="session-documents">
  <div className="session-documents-head"><h3>{text('Plans & docs', '计划与文档')} <span className="session-documents-count">{state.documents.length}</span></h3>
   <button type="button" className="btn-subtle" onClick={onPick} disabled={busy}>{text('Add file…', '添加文件…')}</button>
  </div>
  {error && <p className="session-documents-error" role="alert">{error}</p>}
  {state.loading && !state.documents.length ? <p className="session-documents-empty" role="status">{text('Loading documents…', '正在读取文档…')}</p> : !state.documents.length && <p className="session-documents-empty" title={text('Add plans or notes to keep them one click away.', '添加计划或笔记，随时一键打开。')}>{text('Add plans or notes to keep them one click away.', '添加计划或笔记，随时一键打开。')}</p>}
  <div role="list" aria-label={text('Plans & docs', '计划与文档')}>
   {state.documents.map(document => <div role="listitem" className={`session-document-row${document.missing ? ' missing' : ''}`} data-path={document.path} key={document.path}>
    <button type="button" className="session-document-open" title={document.path} disabled={document.missing} onClick={() => openFile(document.path)}>
     <Icon name="file"/><span className="session-document-label"><b title={documentTitle(document)}>{documentTitle(document)}</b><span className="mono" title={document.path}>{document.path}</span></span>
    </button>
    {document.missing && <span className="chip session-document-missing">{text('Missing', '缺失')}</span>}
    <button type="button" className="icon-btn session-document-unpin" title={text('Remove', '移除')} aria-label={text(`Remove ${document.path}`, `移除 ${document.path}`)} disabled={busy || state.loading} onClick={() => void mutate(document.path, false)}><Icon name="close"/></button>
   </div>)}
  </div>
  {suggestions.length > 0 && <div className="session-document-suggestions"><h4>{text('Changed in this session', '此会话中的更改')}</h4>
   {suggestions.map(path => <div className="session-document-row" key={path} data-suggested-path={path}>
    <button type="button" className="session-document-open" title={path} onClick={() => openFile(path)}><Icon name="file"/><span className="session-document-label"><b>{path.split('/').at(-1)}</b><span className="mono" title={path}>{path}</span></span></button>
    <button type="button" className="btn-subtle session-document-pin" disabled={busy || state.loading} aria-label={text(`Add ${path}`, `添加 ${path}`)} onClick={() => void mutate(path, true)}>{text('Add', '添加')}</button>
   </div>)}
  </div>}
 </div>;
}
