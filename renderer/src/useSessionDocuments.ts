import { useMemo, useSyncExternalStore } from 'react';
import { operationId, request, subscribeEvents } from './bridge';
import { documentPath, isDocumentPinned, sessionDocumentError } from './sessionDocuments';
import { createSessionDocumentsStore } from './sessionDocumentsStore';

const cache = createSessionDocumentsStore({
 list:sessionId => request('session.documents.list', {sessionId}),
 change:(sessionId, path, pinned) => request(pinned ? 'session.documents.pin' : 'session.documents.unpin', {sessionId, path, operationId:operationId()}),
 observe:(sessionId, changed) => subscribeEvents(event => {
  const data = event.data as {kind?:string;sessionId?:string}|undefined;
  if(event.event === 'state.changed' && data?.kind === 'session.documents' && data.sessionId === sessionId) changed();
 }),
});

export function useSessionDocuments(sessionId:string, zh:boolean) {
 const entry = useMemo(() => cache.session(sessionId), [sessionId]);
 const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
 return useMemo(() => ({
  documents:state.documents, loading:state.loading,
  error:state.error ? sessionDocumentError(state.error, zh) : undefined,
  retain:entry.retain, refresh:entry.refresh,
  pin:(path:string) => entry.change(documentPath(path), true),
  unpin:(path:string) => entry.change(documentPath(path), false),
  toggle:(path:string) => entry.change(documentPath(path), !isDocumentPinned(entry.getSnapshot().documents, path)),
 }), [entry, state, zh]);
}
