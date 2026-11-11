import { type BigIntStats } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, toNamespacedPath } from 'node:path';
import type { ExternalFile, ExternalFileOpenResult, ExternalFileSource, FileDocument, FileReference, Method, RequestParams, RequestResult, ResolvedFileReference } from '@threadterm/protocol';
import { LocalFileService } from './files.js';
import type { LocalFileCoordination } from './coordination.js';
import { canonicalPath, displayPath, isContained } from './paths.js';
import type { FileRequestTarget } from './router.js';

type UnknownRecord = Record<string, unknown>;
type SessionContext = { kind:'session'; sessionId:string; projectId:string; rootPath:string; worktreePath?:string; cwd:string; provider:string; mode:string; relativeRequiresAbsolute:boolean };
type ExternalRow = { id:string; canonicalPath:string; name:string; source:ExternalFileSource; openedAt:string };
type Coordination = (command:string, params:UnknownRecord)=>Promise<unknown>;

const externalSources = new Set<ExternalFileSource>(['dialog', 'drop', 'link', 'recent']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const unsupportedImageExtensions = new Set(['avif', 'bmp', 'heic', 'heif', 'ico', 'tif', 'tiff']);
const sourceSearchSkipped = new Set(['node_modules', 'target', 'build', 'out', 'bin']);
const maxSourceSearchSegments = 64, maxSourceSearchBases = 256, maxSourceSearchEntries = 1024, sourceSearchBudgetMs = 150;
const fileReferenceMethods = new Set<Method>([
  'filesystem.resolve', 'filesystem.external.open', 'filesystem.external.read',
  'filesystem.external.readWindow', 'filesystem.external.image', 'filesystem.external.list', 'filesystem.external.forget',
]);

const fail = (code:string): never => { throw new Error(code); };
const object = (value:unknown): UnknownRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const text = (value:unknown): value is string => typeof value === 'string';
const nonEmptyText = (value:unknown): value is string => text(value) && value.length > 0;

/** One `external_files` registration row as the private coordination channel returns it. */
function registrationRow(value:unknown):ExternalRow {
  const result = object(value);
  if (!result) fail('desktop_files_invalid_external');
  const item = result!;
  if (!nonEmptyText(item.id) || !nonEmptyText(item.canonicalPath) || !nonEmptyText(item.name)
    || !nonEmptyText(item.openedAt) || !externalSources.has(item.source as ExternalFileSource)) fail('desktop_files_invalid_external');
  if (!absolutePath(item.canonicalPath as string)) fail('desktop_files_invalid_external');
  return {id:item.id as string, canonicalPath:item.canonicalPath as string, name:item.name as string,
    source:item.source as ExternalFileSource, openedAt:item.openedAt as string};
}

/** A **registered** external file's canonical path, by ID only: the main sheet host resolves
 * exactly what `filesystem.external.readWindow` resolves (`design.md` §3.4). */
export async function registeredExternalFilePath(coordination:LocalFileCoordination, id:string):Promise<string> {
  if (!nonEmptyText(id)) fail('invalid_request');
  return (await registeredFile(registrationRow(await coordination('desktop.files.external.get', {id})))).canonical;
}

/** A main-only private coordination channel. It never accepts a renderer-selected root. */
export function createLocalFileReferenceTarget(options:{service:LocalFileService; coordination:Coordination}):FileRequestTarget {
  const context = async (sessionId:unknown):Promise<SessionContext> => {
    if (!nonEmptyText(sessionId)) fail('invalid_request');
    const result = object(await options.coordination('desktop.files.context', {kind:'session', sessionId}));
    if (!result) fail('desktop_files_invalid_context');
    const value = result!;
    if (value.kind !== 'session' || value.sessionId !== sessionId || !nonEmptyText(value.projectId)
      || !nonEmptyText(value.rootPath) || !nonEmptyText(value.cwd) || !nonEmptyText(value.provider)
      || !nonEmptyText(value.mode) || typeof value.relativeRequiresAbsolute !== 'boolean'
      || (value.worktreePath !== undefined && !nonEmptyText(value.worktreePath))) fail('desktop_files_invalid_context');
    // The Runtime supplies DB authority only. Recheck the saved cwd even for absolute references.
    const checkedCwd = await canonicalPath(value.cwd as string).catch(() => fail('file_reference_cwd_unavailable'));
    if (!(await stat(checkedCwd).catch(() => fail('file_reference_cwd_unavailable'))).isDirectory()) fail('file_reference_cwd_unavailable');
    const checkedRoot = await canonicalPath(value.rootPath as string).catch(() => fail('file_reference_scope_mismatch'));
    if (!isContained(checkedRoot, checkedCwd)) fail('file_reference_scope_mismatch');
    return {kind:'session', sessionId:value.sessionId as string, projectId:value.projectId as string,
      rootPath:checkedRoot, ...(value.worktreePath === undefined ? {} : {worktreePath:value.worktreePath as string}),
      cwd:checkedCwd, provider:value.provider as string, mode:value.mode as string,
      relativeRequiresAbsolute:value.relativeRequiresAbsolute as boolean};
  };
  const row = (value:unknown):ExternalRow => registrationRow(value);

  const request = async <M extends Method>(method:M, params:RequestParams<M>):Promise<RequestResult<M>> => {
    if (!fileReferenceMethods.has(method)) fail('desktop_files_forbidden');
    switch (method) {
      case 'filesystem.resolve': return resolveReference(params as RequestParams<'filesystem.resolve'>, context) as Promise<RequestResult<M>>;
      case 'filesystem.external.open': return openExternal(params as RequestParams<'filesystem.external.open'>, context, row, options.coordination) as Promise<RequestResult<M>>;
      case 'filesystem.external.read': return readExternal(params as RequestParams<'filesystem.external.read'>, row, options.service, options.coordination) as Promise<RequestResult<M>>;
      case 'filesystem.external.readWindow': return readExternalWindow(params as RequestParams<'filesystem.external.readWindow'>, row, options.service, options.coordination) as Promise<RequestResult<M>>;
      case 'filesystem.external.image': return imageExternal(params as RequestParams<'filesystem.external.image'>, row, options.service, options.coordination) as Promise<RequestResult<M>>;
      case 'filesystem.external.list': return listExternal(params as RequestParams<'filesystem.external.list'>, row, options.coordination) as Promise<RequestResult<M>>;
      case 'filesystem.external.forget': return forgetExternal(params as RequestParams<'filesystem.external.forget'>, options.coordination) as Promise<RequestResult<M>>;
      default: return fail('desktop_files_forbidden');
    }
  };
  return {request};
}

async function resolveReference(params:RequestParams<'filesystem.resolve'>, context:(sessionId:unknown)=>Promise<SessionContext>):Promise<ResolvedFileReference> {
  rejectExtra(params, ['sessionId', 'path', 'line', 'column', 'sourceSearch']);
  if (!nonEmptyText(params.sessionId) || !nonEmptyText(params.path) || Buffer.byteLength(params.path, 'utf8') > 16 * 1024
    || params.path.includes('\0') || forbiddenColon(params.path) || looksLikeUri(params.path)) fail(looksLikeUri(params.path) ? 'file_reference_uri' : 'file_reference_invalid_path');
  for (const position of [params.line, params.column])
    if (position !== undefined && (!Number.isSafeInteger(position) || position < 1 || position > 1_000_000)) fail('file_reference_invalid_position');
  if (params.sourceSearch !== undefined && typeof params.sourceSearch !== 'boolean') fail('invalid_request');
  const scope = await context(params.sessionId);
  const root = await canonicalForReference(scope.rootPath);
  const candidate = params.sourceSearch ? await sourceSearch(root, scope.cwd, params.path) : absolutePath(params.path) ? params.path : relativeCandidate(scope, params.path);
  const canonical = await canonicalForReference(candidate ?? fail('file_reference_not_found'));
  if (!isContained(root, canonical)) fail('file_reference_outside_scope');
  const metadata = await fileMetadata(canonical, 'file_reference_not_found', 'file_reference_not_file');
  const relativePath = relative(root, canonical).split('\\').join('/');
  const kind = await referenceKind(canonical, Number(metadata.size));
  return {projectId:scope.projectId, worktreePath:toNamespacedPath(root), path:relativePath, kind,
    ...(params.line === undefined ? {} : {line:params.line}), ...(params.column === undefined ? {} : {column:params.column})};
}

async function openExternal(params:RequestParams<'filesystem.external.open'>, context:(sessionId:unknown)=>Promise<SessionContext>, row:(value:unknown)=>ExternalRow, coordination:Coordination):Promise<ExternalFileOpenResult> {
  rejectExtra(params, ['path', 'source', 'sessionId']);
  if (!nonEmptyText(params.path) || !externalSources.has(params.source)) fail('invalid_request');
  validateExternalPath(params.path);
  const scope = params.sessionId === undefined ? undefined : await context(params.sessionId);
  const root = scope ? await canonicalForExternal(scope.rootPath) : undefined;
  const candidate = absolutePath(params.path) ? params.path : scope ? relativeCandidate(scope, params.path) : fail('invalid_path');
  const canonical = await canonicalForExternal(candidate);
  await fileMetadata(canonical, 'external_file_not_found', 'external_file_not_file');
  if (scope && root && isContained(root, canonical)) {
    const path = relative(root, canonical).split('\\').join('/');
    return {inWorkspace:{projectId:scope.projectId, worktreePath:toNamespacedPath(root), path}};
  }
  const external = row(await coordination('desktop.files.external.open', {canonicalPath:toNamespacedPath(canonical), source:params.source}));
  const file = await registeredFile(external);
  return {file:externalFile(external, file.metadata)};
}

async function readExternal(params:RequestParams<'filesystem.external.read'>, row:(value:unknown)=>ExternalRow, service:LocalFileService, coordination:Coordination):Promise<FileDocument> {
  rejectExtra(params, ['id']);
  if (!nonEmptyText(params.id)) fail('invalid_request');
  const external = row(await coordination('desktop.files.external.get', {id:params.id}));
  const file = await registeredFile(external);
  try {
    const document = await service.read(file.root, {path:file.name});
    return {...document, path:displayPath(file.canonical), readonly:true, size:Number(file.metadata.size), modifiedAt:externalModifiedAt(file.metadata)};
  } catch (error) { throw externalReadError(error); }
}

async function readExternalWindow(params:RequestParams<'filesystem.external.readWindow'>, row:(value:unknown)=>ExternalRow, service:LocalFileService, coordination:Coordination):Promise<RequestResult<'filesystem.external.readWindow'>> {
  rejectExtra(params,['id','offset','maxBytes','changeToken']);
  if(!nonEmptyText(params.id))fail('invalid_request');
  const external=row(await coordination('desktop.files.external.get',{id:params.id}));
  const file=await registeredFile(external);
  try{return await service.readWindow(file.root,{path:file.name,offset:params.offset,
    ...(params.maxBytes===undefined?{}:{maxBytes:params.maxBytes}),
    ...(params.changeToken===undefined?{}:{changeToken:params.changeToken})});}
  catch(error){throw externalReadError(error);}
}

async function imageExternal(params:RequestParams<'filesystem.external.image'>, row:(value:unknown)=>ExternalRow, service:LocalFileService, coordination:Coordination):Promise<RequestResult<'filesystem.external.image'>> {
  rejectExtra(params, ['id']);
  if (!nonEmptyText(params.id)) fail('invalid_request');
  const external = row(await coordination('desktop.files.external.get', {id:params.id}));
  const file = await registeredFile(external);
  try { return await service.image(file.root, {path:file.name}); }
  catch (error) { throw externalReadError(error); }
}

async function listExternal(params:RequestParams<'filesystem.external.list'>, row:(value:unknown)=>ExternalRow, coordination:Coordination):Promise<RequestResult<'filesystem.external.list'>> {
  rejectExtra(params, []);
  const result = object(await coordination('desktop.files.external.list', {}));
  const files = result?.files;
  if (!Array.isArray(files)) fail('desktop_files_invalid_external');
  const rows = files as unknown[];
  return {files:await Promise.all(rows.slice(0, 30).map(async (value:unknown) => {
    const external = row(value);
    try { return {...externalFile(external), ...(await externalMetadata(external.canonicalPath)), exists:true}; }
    catch { return {...externalFile(external), size:0, modifiedAt:'', exists:false}; }
  }))};
}

async function forgetExternal(params:RequestParams<'filesystem.external.forget'>, coordination:Coordination):Promise<null> {
  rejectExtra(params, ['id', 'operationId']);
  if (!nonEmptyText(params.id) || !nonEmptyText(params.operationId)) fail('invalid_request');
  const value = await coordination('desktop.files.external.forget', {id:params.id, operationId:params.operationId});
  if (value !== null) fail('desktop_files_invalid_external');
  return null;
}

function externalFile(value:ExternalRow, metadata?:BigIntStats):ExternalFile { return {id:value.id, path:displayPath(value.canonicalPath), name:value.name, openedAt:value.openedAt, image:imageExtensions.has(extension(value.canonicalPath)), size:metadata ? Number(metadata.size) : 0, modifiedAt:metadata ? externalModifiedAt(metadata) : ''}; }
async function externalMetadata(path:string):Promise<Pick<ExternalFile, 'size'|'modifiedAt'>> { const metadata=await fileMetadata(await canonicalForExternal(path), 'external_file_not_found', 'external_file_not_file'); return {size:Number(metadata.size), modifiedAt:externalModifiedAt(metadata)}; }
async function registeredFile(value:ExternalRow):Promise<{canonical:string;root:string;name:string;metadata:BigIntStats}> { validateExternalPath(value.canonicalPath); const canonical=await canonicalForExternal(value.canonicalPath); validateExternalPath(canonical); const metadata=await fileMetadata(canonical, 'external_file_not_found', 'external_file_not_file'); return {canonical,root:await canonicalForExternal(dirname(canonical)),name:basename(canonical),metadata}; }

/** Chrono's to_rfc3339 keeps filesystem precision and uses an explicit UTC offset. */
function externalModifiedAt(metadata:BigIntStats):string {
  let seconds=metadata.mtimeNs/1_000_000_000n, nanos=metadata.mtimeNs%1_000_000_000n;
  if(nanos<0n){seconds-=1n;nanos+=1_000_000_000n;}
  const base=new Date(Number(seconds)*1000).toISOString().replace(/\.000Z$/, '');
  const digits=nanos===0n?0:nanos%1_000_000n===0n?3:nanos%1000n===0n?6:9;
  return `${base}${digits?`.${nanos.toString().padStart(9,'0').slice(0,digits)}`:''}+00:00`;
}
function canonicalForReference(path:string):Promise<string> { return canonicalPath(path).catch(() => fail('file_reference_not_found')); }
function canonicalForExternal(path:string):Promise<string> {
  validateExternalPath(path);
  return realpath(path).catch(error => fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'external_file_not_found' : 'external_file_unavailable'));
}
async function fileMetadata(path:string, missing:string, notFile:string):Promise<BigIntStats> {
  try { const metadata=await stat(path,{bigint:true}); if (!metadata.isFile()) fail(notFile); return metadata; }
  catch (error) {
    if (error instanceof Error && error.message === notFile) throw error;
    if (missing === 'external_file_not_found' && (error as NodeJS.ErrnoException).code !== 'ENOENT') fail('external_file_unavailable');
    return fail(missing);
  }
}
function relativeCandidate(scope:SessionContext, path:string):string {
  if (process.platform === 'win32' && (/^[a-z]:/i.test(path) || /^[\\/]/.test(path))) fail('file_reference_invalid_path');
  if (scope.relativeRequiresAbsolute) fail('file_reference_relative_requires_absolute');
  return resolve(scope.cwd, path);
}
function absolutePath(path:string):boolean {
  return process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path) : isAbsolute(path);
}
function forbiddenColon(path:string):boolean { const plain=path.replace(/^\\\\\?\\|^\/\/\?\//, ''); const drive=/^[a-z]:/i.test(plain); return [...path].some((character,index)=>character === ':' && !(drive && index === (path.length - plain.length) + 1)); }
function looksLikeUri(path:string):boolean { if (/^[a-z]:/i.test(path) || /^\\\\/.test(path)) return false; return /^[a-z][a-z0-9+.-]*:/i.test(path); }
function validateExternalPath(path:string):void {
  if (!path || Buffer.byteLength(path, 'utf8') > 16 * 1024 || /[\x00-\x1f\x7f-\x9f]/.test(path)) fail('invalid_path');
  const windows = path.replace(/\\/g, '/'), plain = windows.replace(/^\/\/\?\//, ''), drive = /^[a-z]:/i.test(plain);
  if (windows.startsWith('//./') || windows.startsWith('/??/') || (windows.startsWith('//?/') && !drive && !plain.startsWith('UNC/')) || [...plain].some((character, index) => character === ':' && !(drive && index === 1))) fail('invalid_path');
  if (process.platform === 'win32') for (const part of plain.split('/')) {
    const stem = part.split('.')[0]!.replace(/ +$/, '').toUpperCase();
    if (['CON','PRN','AUX','NUL','CONIN$','CONOUT$'].includes(stem) || /^(COM|LPT)[1-9]$/.test(stem)) fail('invalid_path');
  }
}
function validSourceSearchPath(path:string):boolean {
  if (path.includes('\\') || Buffer.byteLength(path, 'utf8') > 16 * 1024) return false;
  const parts=path.split('/'); if (parts.length > maxSourceSearchSegments) return false;
  const file=parts.at(-1), directories=parts.slice(0,-1), identifier=(value:string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
  const split=file?.lastIndexOf('.') ?? -1;
  return !!file && directories.every(identifier) && split > 0 && identifier(file.slice(0,split)) && ['java','kt','kts','scala','groovy'].includes(file.slice(split+1).toLowerCase());
}
function sourceSearchRelatives(path:string):string[] { const extension=path.slice(path.lastIndexOf('.')+1).toLowerCase(), language=extension === 'java' ? 'java' : ['kt','kts'].includes(extension) ? 'kotlin' : extension === 'scala' ? 'scala' : extension === 'groovy' ? 'groovy' : undefined; return [...(language ? [`src/main/${language}/${path}`,`src/test/${language}/${path}`] : []),`src/${path}`,path]; }
async function sourceSearch(root:string, cwd:string, path:string):Promise<string|undefined> {
  if (!validSourceSearchPath(path)) fail('file_reference_invalid_path');
  const deadline=Date.now()+sourceSearchBudgetMs, seen=new Set<string>(), relatives=sourceSearchRelatives(path);
  let bases=0;
  const stopped = () => Date.now()>deadline || bases>=maxSourceSearchBases;
  const probe=async(base:string):Promise<string|undefined> => {
    if (stopped() || seen.has(base.toLowerCase())) return;
    seen.add(base.toLowerCase()); bases++;
    for (const relativePath of relatives) {
      if (Date.now()>deadline) break;
      try {
        const candidate=resolve(base,relativePath), metadata=await stat(candidate);
        if (!metadata.isFile()) continue;
        const canonical=await canonicalForReference(candidate);
        if (isContained(root,canonical)) return canonical;
      } catch { /* An escaping or missing hit cannot hide a later real module. */ }
    }
  };
  for (const base of [cwd,root]) { const hit=await probe(base); if(hit) return hit; }
  if (stopped()) return;
  const children=await sourceChildren(root,deadline);
  for (const child of children) { if(stopped()) return; const hit=await probe(child); if(hit) return hit; }
  for (const child of children) {
    if (stopped()) return;
    for (const grandchild of await sourceChildren(child,deadline)) {
      if (stopped()) return;
      const hit=await probe(grandchild); if(hit) return hit;
    }
  }
  return undefined;
}
async function sourceChildren(directory:string, deadline:number):Promise<string[]> {
  if(Date.now()>deadline)return [];
  const values:{name:string;path:string}[]=[];
  const entries = await opendir(directory).catch(() => undefined);
  if (!entries) return [];
  let examined=0;
  try {
    for await (const entry of entries) {
      if(examined++>=maxSourceSearchEntries||Date.now()>deadline)break;
      if(entry.name.startsWith('.')||sourceSearchSkipped.has(entry.name.toLowerCase()))continue;
      const path=resolve(directory,entry.name);
      if(entry.isDirectory() || entry.isSymbolicLink() && await stat(path).then(value=>value.isDirectory()).catch(()=>false)) values.push({name:entry.name,path});
    }
  } catch { /* Match Runtime's best-effort directory enumeration. */ }
  return values.sort((left,right)=>left.name < right.name ? -1 : left.name > right.name ? 1 : 0).map(value=>value.path);
}
function extension(path:string):string { const name=basename(path), index=name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index + 1).toLowerCase(); }
async function referenceKind(path:string, size:number):Promise<'text'|'image'> { const ext=extension(path); if (unsupportedImageExtensions.has(ext)) fail('unsupported_image'); const handle=await open(path, 'r').catch(() => fail('file_reference_not_found')); try { const prefix=Buffer.alloc(12); const {bytesRead}=await handle.read(prefix,0,prefix.length,0); const image=imageMime(prefix.subarray(0,bytesRead)); if (imageExtensions.has(ext) && !image) fail('unsupported_image'); if (image) { if(size>4*1024*1024)fail('image_too_large'); return 'image'; } if(size>1024*1024)fail('file_too_large'); return 'text'; } finally { await handle.close(); } }
function imageMime(value:Buffer):boolean { return value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || value.subarray(0,3).equals(Buffer.from([255,216,255])) || ['GIF87a','GIF89a'].includes(value.subarray(0,6).toString()) || value.subarray(0,4).toString()==='RIFF'&&value.subarray(8,12).toString()==='WEBP'; }
function rejectExtra(value:unknown, allowed:readonly string[]):void { const input=object(value); if (!input || Object.keys(input).some(key=>!allowed.includes(key))) fail('invalid_request'); }
function externalReadError(error:unknown):Error { const message=error instanceof Error ? error.message : String(error); if (message === 'file_not_found') return new Error('external_file_not_found'); if (message === 'not_a_file' || message === 'file_not_file') return new Error('external_file_not_file'); if (['file_too_large','file_changed','image_too_large','binary_file','unsupported_image'].includes(message)) return new Error(message); return new Error('external_file_unavailable'); }
