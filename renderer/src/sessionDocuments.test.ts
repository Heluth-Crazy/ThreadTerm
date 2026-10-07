import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewCheckpoint, SessionDocument } from '@threadterm/protocol';
import { documentPath, documentTitle, firstReadyCheckpoint, isDocumentPinned, sessionDocumentError, suggestedDocuments } from './sessionDocuments';
import { createSessionDocumentsStore } from './sessionDocumentsStore';

const pin = (path:string):SessionDocument => ({path, pinnedAt:'2026-10-06T00:00:00Z'});
const deferred = <T,>() => { let resolve!:(value:T)=>void; const promise = new Promise<T>(yes => {resolve=yes;}); return {promise, resolve}; };
const flush = async () => { for(let index=0;index<10;index++) await Promise.resolve(); };

test('document display and suggestion rules normalize paths, exclude pins/deletions and cap five', () => {
 assert.equal(documentPath('docs\\.\\plan.md'), 'docs/plan.md');
 assert.equal(documentTitle(pin('docs/plan.md')), 'plan.md');
 assert.equal(documentTitle({...pin('docs/plan.md'), title:'Checkout plan'}), 'Checkout plan');
 assert.ok(isDocumentPinned([pin('docs/plan.md')], 'docs\\plan.md'));
 const files = ['docs/plan.md','a.MARKDOWN','notes.txt','gone.md','a.MARKDOWN','b.md','c.md','d.md','e.md','f.md'].map(path => ({path, status:path==='gone.md'?'D' as const:'M' as const}));
 assert.deepEqual(suggestedDocuments(files, [pin('docs/plan.md')]), ['a.MARKDOWN','b.md','c.md','d.md','e.md']);
});

test('suggestion baseline is the first ready checkpoint regardless of returned order', () => {
 const checkpoint = (id:string, status:'ready'|'failed', createdAt:string):ReviewCheckpoint => ({id, status, createdAt, sessionId:'a',kind:'manual',skipped:[]});
 assert.equal(firstReadyCheckpoint([checkpoint('later','ready','2026-10-07'),checkpoint('failed','failed','2026-10-05'),checkpoint('first','ready','2026-10-06')])?.id, 'first');
 assert.equal(firstReadyCheckpoint([]), undefined);
 assert.match(sessionDocumentError(new Error('too_many_documents'), false), /up to 20 files per session/);
 assert.match(sessionDocumentError('file_too_large', true), /2 MiB/);
});

test('cache shares lists, reads only while retained, and refreshes on reopen and targeted events', async () => {
 let calls=0, observations=0;
 const callbacks = new Map<string,()=>void>();
 const store = createSessionDocumentsStore({list:async id=>{calls++;return [pin(`${id}.md`)];}, change:async()=>[], observe:(id, changed)=>{observations++; callbacks.set(id,changed);return()=>{observations--;callbacks.delete(id);};}});
 const entry = store.session('a');
 assert.equal(entry, store.session('a'));
 const unsubscribe=entry.subscribe(()=>{});
 assert.equal(calls,0);
 const release=entry.retain(), second=entry.retain();
 await flush(); assert.equal(calls,1); assert.equal(observations,1);
 callbacks.get('a')?.(); await flush(); assert.equal(calls,2);
 const inspector=entry.retain(); await flush(); assert.equal(calls,3); inspector();
 release(); second(); assert.equal(observations,0);
 entry.refresh(); await flush(); assert.equal(calls,3);
 const reopen=entry.retain(); await flush(); assert.equal(calls,4);
 assert.deepEqual(entry.getSnapshot().documents,[pin('a.md')]);
 reopen(); unsubscribe();
});

test('invalidated in-flight reads never publish stale lists, and mutation results update all consumers', async () => {
 const old=deferred<SessionDocument[]>(); let reads=0, changed=()=>{};
 const store=createSessionDocumentsStore({list:()=>++reads===1?old.promise:Promise.resolve([pin('fresh.md')]),change:async()=>[pin('pinned.md')],observe:(_,listener)=>{changed=listener;return()=>{};}});
 const entry=store.session('a'), snapshots:string[][]=[];
 const unsub=entry.subscribe(()=>snapshots.push(entry.getSnapshot().documents.map(doc=>doc.path)));
 const release=entry.retain();
 changed(); old.resolve([pin('stale.md')]); await flush();
 assert.equal(reads,2); assert.ok(!snapshots.some(paths=>paths.includes('stale.md')));
 await entry.change('pinned.md',true); assert.deepEqual(entry.getSnapshot().documents,[pin('pinned.md')]);
 release(); unsub();
});

test('session isolation, errors and serialized writes preserve confirmed state', async () => {
 const writing=deferred<SessionDocument[]>(); let writes=0;
 const store=createSessionDocumentsStore({list:async()=>[],change:async()=>{writes++; if(writes===1)return writing.promise; throw new Error('too_many_documents');},observe:()=>()=>{}});
 const a=store.session('a'), b=store.session('b');
 const first=a.change('one.md',true), second=a.change('two.md',true);
 const rejected=assert.rejects(second,/too_many_documents/);
 await flush(); assert.equal(writes,1);
 writing.resolve([pin('one.md')]); await first; await rejected;
 assert.deepEqual(a.getSnapshot().documents,[pin('one.md')]);
 assert.deepEqual(b.getSnapshot().documents,[]);
 assert.equal(a.getSnapshot().loading,false);
});
