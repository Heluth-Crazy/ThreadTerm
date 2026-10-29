import type { ReviewCheckpoint, ReviewFile } from '@threadterm/protocol';

export type TurnWindow = {from:string;to?:string;key:string};
export type TurnTicket = TurnWindow & {epoch:symbol};
export type AgentChangesCache = {sessionId?:string;epoch:symbol;windows:Record<string,TurnWindow>;entries:Record<string,{files?:ReviewFile[];ticket?:TurnTicket;live:boolean}>;rows:Record<string,ReviewFile[]>};

export function createAgentChangesCache(sessionId?:string):AgentChangesCache {
 return {sessionId, epoch:Symbol(), windows:{}, entries:{}, rows:{}};
}

// Keep displayed rows while invalidating live data and any in-flight live response.
export function refreshAgentChangesCache(cache:AgentChangesCache):AgentChangesCache {
 return {...cache, entries:Object.fromEntries(Object.entries(cache.entries).filter(([, entry]) => !entry.live))};
}

export function resolveAgentChangesWindows(cache:AgentChangesCache, checkpoints:Pick<ReviewCheckpoint,'id'|'status'>[]):AgentChangesCache {
 const windows:Record<string,TurnWindow> = {};
 let to:string|undefined;
 for(const checkpoint of checkpoints) {
  if(checkpoint.status !== 'ready') continue;
  const from = checkpoint.id, key = JSON.stringify([from, to ?? null]);
  windows[from] = {from, ...(to ? {to} : {}), key}; to = from;
 }
 const keys = new Set(Object.values(windows).map(window => window.key));
 const entries = Object.fromEntries(Object.entries(cache.entries).filter(([key, entry]) => entry.files || keys.has(key)));
 const rows = {...cache.rows};
 for(const window of Object.values(windows)) {
  const files = entries[window.key]?.files;
  if(files) rows[window.from] = files;
 }
 return {...cache, windows, entries, rows};
}

export function beginAgentChangesRequest(cache:AgentChangesCache, from:string):{cache:AgentChangesCache;ticket?:TurnTicket} {
 const window = cache.windows[from];
 if(!window || cache.entries[window.key]) return {cache};
 const ticket = {...window, epoch:cache.epoch};
 return {cache:{...cache, entries:{...cache.entries, [window.key]:{ticket, live:!window.to}}}, ticket};
}

export function agentChangesRequestIsCurrent(cache:AgentChangesCache, ticket:TurnTicket):boolean {
 return cache.epoch === ticket.epoch && cache.windows[ticket.from]?.key === ticket.key && cache.entries[ticket.key]?.ticket === ticket;
}

export function finishAgentChangesRequest(cache:AgentChangesCache, ticket:TurnTicket, files?:ReviewFile[]):AgentChangesCache {
 if(!agentChangesRequestIsCurrent(cache, ticket)) return cache;
 const entries = {...cache.entries};
 if(files) entries[ticket.key] = {files, live:!ticket.to}; else delete entries[ticket.key];
 return {...cache, entries, rows:files ? {...cache.rows, [ticket.from]:files} : cache.rows};
}
