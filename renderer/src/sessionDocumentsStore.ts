import type { SessionDocument } from '@threadterm/protocol';

export type DocumentsState = {documents:readonly SessionDocument[]; loading:boolean; error?:unknown};
type Transport = {
 list:(sessionId:string)=>Promise<SessionDocument[]>;
 change:(sessionId:string, path:string, pinned:boolean)=>Promise<SessionDocument[]>;
 observe:(sessionId:string, changed:()=>void)=>()=>void;
};

/** One list per session, fetched only while a visible consumer retains it. No polling. */
export function createSessionDocumentsStore(transport:Transport) {
 const entries = new Map<string,ReturnType<typeof createEntry>>();
 function createEntry(sessionId:string) {
  let state:DocumentsState = {documents:[], loading:true}, consumers = 0, version = 0, dirty = true;
  let reading:Promise<void>|undefined, mutations = 0, stop:undefined|(()=>void);
  let writes:Promise<void> = Promise.resolve();
  const listeners = new Set<()=>void>();
  const publish = (next:DocumentsState) => { state = next; for(const listener of listeners) listener(); };
  const refresh = ():Promise<void> => {
   if(reading) return reading;
   if(!consumers || mutations || !dirty) return Promise.resolve();
   reading = (async () => {
    while(consumers && dirty && !mutations) {
     dirty = false;
     const ticket = version;
     publish({...state, loading:true, error:undefined});
     try {
      const documents = await transport.list(sessionId);
      if(ticket === version) publish({documents, loading:false});
     } catch(error) { if(ticket === version) publish({...state, loading:false, error}); }
    }
   })().finally(() => { reading = undefined; });
   return reading;
  };
  const invalidate = () => { version++; dirty = true; void refresh(); };
  const retain = () => {
   consumers++;
   if(consumers === 1) { stop = transport.observe(sessionId, invalidate); invalidate(); }
   else if(!reading && !mutations) invalidate();
   let released = false;
   return () => { if(released) return; released = true; if(--consumers === 0) { stop?.(); stop = undefined; } };
  };
  const change = (path:string, pinned:boolean):Promise<void> => {
   mutations++; version++;
   publish({...state, loading:true, error:undefined});
   const result = writes.then(async () => {
    try { const documents = await transport.change(sessionId, path, pinned); publish({documents, loading:mutations > 1}); }
    catch(error) { publish({...state, loading:mutations > 1, error}); throw error; }
    finally { mutations--; }
   });
   writes = result.catch(() => {}).then(() => { if(dirty) void refresh(); });
   return result;
  };
  return {getSnapshot:()=>state, subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}, retain, refresh:invalidate, change};
 }
 return {session:(sessionId:string) => {
  let entry = entries.get(sessionId);
  if(!entry) { entry = createEntry(sessionId); entries.set(sessionId, entry); }
  return entry;
 }};
}
