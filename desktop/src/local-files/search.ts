import { Worker } from 'node:worker_threads';
import picomatch from 'picomatch';
import { readBoundedFile } from './bounded-read.js';

export type SearchQuery = { query:string; regex?:boolean; caseSensitive?:boolean; wholeWord?:boolean; include?:string; exclude?:string };
export type SearchResult = { files:{path:string;matches:{line:number;column:number;length:number;preview:string;previewColumn:number}[]}[];truncated:boolean;searchedFiles:number };
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_MATCHES = 2000, MAX_PER_FILE = 200, BEFORE = 40, CHARS = 240, SEARCH_MS = 5_000;

export function compileSearch(query: SearchQuery): RegExp {
  if (!query.query || Buffer.byteLength(query.query, 'utf8') > 1000) throw Error('invalid_search_query');
  if (query.regex && /\\(?:[1-9]|k<)|\(\?[=!<]/.test(query.query)) throw Error('invalid_search_pattern');
  let source = query.regex ? query.query : escape(query.query);
  // Rust regex uses Unicode word boundaries. JavaScript's \b remains ASCII,
  // so express the same one-code-point boundary explicitly.
  if (query.wholeWord) {
    const word = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]';
    source = `(?<!${word})(?:${source})(?!${word})`;
  }
  try { return new RegExp(source, `gu${query.caseSensitive ? '' : 'i'}`); }
  catch { throw Error('invalid_search_pattern'); }
}

export async function searchPaths(
  paths: AsyncIterable<{path:string;absolute:string}>,
  query: SearchQuery,
  deadline = Date.now() + SEARCH_MS,
): Promise<SearchResult> {
  const matcher = compileSearch(query);
  const includes = compileGlobs(query.include);
  const excludes = compileGlobs(query.exclude);
  if (Date.now() > deadline) return {files:[],truncated:true,searchedFiles:0};
  const worker = await RegexWorker.create(matcher.source, matcher.flags, deadline);
  const files: SearchResult['files'] = [];
  let searchedFiles = 0, total = 0, truncated = false;
  try {
    for await (const item of paths) {
      if (Date.now() > deadline) { truncated = true; break; }
      if (includes && !matchesGlob(item.path, includes) || excludes && matchesGlob(item.path, excludes)) continue;
      const bytes = await readBoundedFile(item.absolute, MAX_DOCUMENT_BYTES, 'file_too_large').catch(() => undefined);
      if (!bytes || bytes.includes(0)) continue;
      let text: string;
      try { text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes); }
      catch { continue; }
      searchedFiles++;
      const maximum = Math.min(MAX_MATCHES - total, MAX_PER_FILE);
      let found: WorkerResult;
      try { found = await worker.find(text, maximum, deadline); }
      catch (error) {
        if ((error as Error).message === 'search_timeout') { truncated = true; break; }
        throw error;
      }
      const matches: SearchResult['files'][number]['matches'] = [];
      const lines = text.split('\n');
      for (const itemMatch of found.matches) {
        const raw = lines[itemMatch.line]!;
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        matches.push(preview(line, itemMatch.line + 1, itemMatch.start, itemMatch.end));
        total++;
      }
      if (matches.length) files.push({path:item.path,matches});
      if (found.truncated || total >= MAX_MATCHES) { truncated = true; break; }
    }
  } finally {
    await worker.close();
  }
  return {files,truncated,searchedFiles};
}

function preview(line:string, number:number, start:number, end:number) {
  const before = [...line.slice(0, start)].length, skip = Math.max(0, before - BEFORE);
  const shown = [...line].slice(skip, skip + CHARS).join('');
  const prefix = [...line].slice(0, skip).join('');
  const column = line.slice(0, start).length + 1;
  return {line:number,column,length:line.slice(start,end).length,preview:shown,previewColumn:column - 1 - prefix.length};
}

function escape(value:string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

type GlobMatcher = (path: string) => boolean;
function compileGlobs(spec: string | undefined): GlobMatcher[] | undefined {
  if (!spec?.trim()) return undefined;
  if (Buffer.byteLength(spec, 'utf8') > 16 * 1024) throw Error('invalid_glob');
  const patterns = spec.split(',').map(value => value.trim()).filter(Boolean);
  if (patterns.length > 256) throw Error('invalid_glob');
  try {
    return patterns.flatMap(raw => {
      const pattern = raw.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!pattern) throw Error('invalid_glob');
      const base = pattern.includes('/') ? pattern : `**/${pattern}`;
      return [base, `${base}/**`].map(candidate => picomatch(candidate, {
        nocase: process.platform === 'win32', bash: true, nonegate: true,
      }));
    });
  } catch { throw Error('invalid_glob'); }
}
function matchesGlob(path:string, matchers: readonly GlobMatcher[]) { return matchers.some(matcher => matcher(path)); }

type WorkerMatch = {line:number;start:number;end:number};
type WorkerResult = {matches: WorkerMatch[]; truncated: boolean};
const workerSource = String.raw`
const { parentPort } = require('node:worker_threads'); let matcher;
parentPort.on('message', value => { try {
 if (value.type === 'init') { matcher = new RegExp(value.source, value.flags); parentPort.postMessage({type:'ready'}); return; }
 const rows = value.text.split('\n'), matches = []; let truncated = false;
 outer: for (let line=0; line<rows.length; line++) {
   const row = rows[line].endsWith('\r') ? rows[line].slice(0, -1) : rows[line];
   matcher.lastIndex=0; let hit;
   while ((hit=matcher.exec(row))) {
     if (!hit[0]) {
       const point = row.codePointAt(matcher.lastIndex);
       matcher.lastIndex += point !== undefined && point > 0xffff ? 2 : 1;
       continue;
     }
     if (matches.length >= value.max) { truncated = true; break outer; }
     matches.push({line,start:hit.index,end:hit.index+hit[0].length});
   }
 }
 parentPort.postMessage({type:'result',id:value.id,matches,truncated});
} catch(error) { parentPort.postMessage({type:value.type === 'init' ? 'initError' : 'error',id:value.id,error:String(error && error.message || error)}); } });`;

type Waiter = {grant:()=>void; reject:(error:Error)=>void; timer:NodeJS.Timeout};

/** Regex matching is isolated in a resource-bounded worker, never Electron main. */
class RegexWorker {
  private static active = 0;
  private static readonly waiting: Waiter[] = [];
  private next = 0;
  private closed = false;
  private readonly pending = new Map<number,{resolve:(value:WorkerResult)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();

  private constructor(private readonly worker: Worker) {
    worker.on('message', message => this.message(message));
    worker.on('error', error => this.failAll(error));
    worker.on('exit', code => { if (!this.closed && code !== 0) this.failAll(Error('search_worker_exit')); });
  }

  static async create(source:string, flags:string, deadline:number): Promise<RegexWorker> {
    await this.acquire(deadline);
    let worker: Worker;
    try {
      worker = new Worker(workerSource, {
        eval:true,
        resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2},
      });
    } catch(error) {
      this.release();
      throw error;
    }
    const instance = new RegexWorker(worker);
    try {
      await new Promise<void>((resolve,reject) => {
        const remaining = Math.max(1, Math.min(1_000, deadline - Date.now()));
        const timer = setTimeout(() => finish(Error('search_timeout')), remaining);
        const onMessage = (message: {type?:string;error?:string}) => {
          if (message.type === 'ready') finish();
          else if (message.type === 'initError') finish(Error(message.error ?? 'invalid_search_pattern'));
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number) => { if (code !== 0) finish(Error('search_worker_exit')); };
        const finish = (error?: Error) => {
          clearTimeout(timer);
          instance.worker.off('message', onMessage);
          instance.worker.off('error', onError);
          instance.worker.off('exit', onExit);
          error ? reject(error) : resolve();
        };
        instance.worker.on('message', onMessage);
        instance.worker.on('error', onError);
        instance.worker.on('exit', onExit);
        instance.worker.postMessage({type:'init',source,flags});
      });
      return instance;
    } catch(error) {
      instance.closed = true;
      await instance.worker.terminate().catch(() => undefined);
      this.release();
      throw error;
    }
  }

  find(text:string, max:number, deadline:number): Promise<WorkerResult> {
    if (this.closed) return Promise.reject(Error('search_worker_exit'));
    const id=++this.next;
    return new Promise((resolve,reject) => {
      const remaining = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const timer=setTimeout(() => {
        this.pending.delete(id);
        void this.worker.terminate();
        reject(Error('search_timeout'));
      }, remaining);
      this.pending.set(id,{resolve,reject,timer});
      this.worker.postMessage({type:'find',id,text,max});
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(Error('search_cancelled'));
    await this.worker.terminate().catch(() => undefined);
    RegexWorker.release();
  }

  private message(message: {type:string;id?:number;matches?:WorkerMatch[];truncated?:boolean;error?:string}) {
    if (message.type === 'ready' || message.type === 'initError') return;
    const item=this.pending.get(message.id!);
    if(!item)return;
    this.pending.delete(message.id!);
    clearTimeout(item.timer);
    message.type==='result'
      ? item.resolve({matches:message.matches??[],truncated:message.truncated===true})
      : item.reject(Error(message.error??'invalid_search_pattern'));
  }

  private failAll(error:Error) {
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}
    this.pending.clear();
  }

  private static acquire(deadline: number): Promise<void> {
    if (this.active < 2) { this.active++; return Promise.resolve(); }
    if (this.waiting.length >= 16) return Promise.reject(Error('search_busy'));
    return new Promise((resolve,reject) => {
      const remaining = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const waiter = {grant:() => { clearTimeout(waiter.timer); this.active++; resolve(); }, reject, timer:undefined as unknown as NodeJS.Timeout};
      waiter.timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(Error('search_busy'));
      }, remaining);
      this.waiting.push(waiter);
    });
  }

  private static release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.grant();
  }
}
