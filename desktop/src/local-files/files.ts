import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, toNamespacedPath } from 'node:path';
import type { FileDocument, FileEntry, FileListResult, LargeFileWindow, LargeFileWindowRequest } from '@threadterm/protocol';
import { OFFICE_PREVIEW_MAX_BYTES } from '@threadterm/protocol';
import { readBoundedFile, readFileWindow, validateOpenFilePath } from './bounded-read.js';
import { streamProjectFiles, walkProjectFiles } from './ignore-walk.js';
import {
  canonicalPath,
  containedExisting,
  containedTargetDetails,
  displayPath,
  isContained,
  recheckContainedTarget,
  validateReferencePath,
} from './paths.js';
import { MAX_DOCUMENT_BYTES, searchPaths, type SearchQuery, type SearchResult } from './search.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const PREVIEW_LIMIT = 1024 * 1024;
const MAX_LIST_FILES = 20_000;
const MAX_BROWSE = 1000;
const WALK_MS = 5_000;

export class NoEffectError extends Error { readonly noEffect = true; }
export type LocalFileServiceOptions = { trashItem:(path:string)=>Promise<void> };
export type Preview = {path:string;size:number;offset:number;fingerprint:string;chunk:string;eof:boolean};

/** Stateless, removable Node filesystem parity layer. Caller authorizes roots and owns durable receipts. */
export class LocalFileService {
  constructor(private readonly options: LocalFileServiceOptions) {}

  async browse(path?: string): Promise<{path?:string;parent?:string|null;entries:{name:string;path:string;kind:'directory'|'file';size:number}[];truncated:boolean}> {
    if (!path) return {entries: await roots(), truncated:false};
    if (!isAbsolute(path) || path.includes('\0')) throw Error('invalid_path');
    const root = await canonicalPath(path);
    const entries:{name:string;path:string;kind:'directory'|'file';size:number}[]=[];
    let truncated=false;
    for (const item of await readdir(root,{withFileTypes:true})) {
      if(entries.length>=MAX_BROWSE){truncated=true;break;}
      const target=join(root,item.name);
      const metadata=await stat(target).catch(()=>undefined);
      if (!metadata) continue;
      entries.push({name:item.name,path:displayPath(target),kind:metadata.isDirectory()?'directory':'file',size:Number(metadata.size)});
    }
    entries.sort((left,right)=>Number(left.kind!=='directory')-Number(right.kind!=='directory')||left.name.localeCompare(right.name,undefined,{sensitivity:'base'}));
    return {path:displayPath(root),parent:dirname(root) === root ? null : displayPath(dirname(root)),entries,truncated};
  }

  async list(root:string, params:{path:string}): Promise<FileEntry[]> {
    const directory=params.path ? await containedExisting(root,params.path) : await canonicalPath(root);
    return (await this.directoryEntries(directory,params.path,Number.MAX_SAFE_INTEGER)).entries;
  }

  async read(root:string, params:{path:string}): Promise<FileDocument> {
    const path=await containedExisting(root,params.path);
    const data=await safeText(path);
    return document(params.path,data,await lstat(path));
  }

  async readWindow(root:string, params:{path:string}&LargeFileWindowRequest):Promise<LargeFileWindow>{
    return readFileWindow(await containedExisting(root,params.path),params);
  }

  async image(root:string, params:{path:string}): Promise<{mime:'image/png'|'image/jpeg'|'image/gif'|'image/webp';data:string}> {
    const path=await containedExisting(root,params.path);
    await regular(path);
    const data=await readBoundedFile(path,MAX_IMAGE_BYTES,'image_too_large');
    const mime=imageMime(data);
    if(!mime) throw Error('unsupported_image');
    return {mime,data:data.toString('base64')};
  }

  async write(root:string, params:{path:string;content:string;expectedFingerprint:string}): Promise<FileDocument> {
    if (Buffer.byteLength(params.content,'utf8')>MAX_DOCUMENT_BYTES || params.content.includes('\0')) {
      throw new NoEffectError('invalid_content');
    }
    const path=await containedExisting(root,params.path).catch(error=>{throw noEffect(error);});
    const initial=await regular(path).catch(error=>{throw noEffect(error);});
    if (readonly(initial)) throw new NoEffectError('readonly_file');
    const old=await readBoundedFile(path,MAX_DOCUMENT_BYTES,'file_too_large').catch(error=>{throw noEffect(error);});
    if (fingerprint(old)!==params.expectedFingerprint) throw new NoEffectError('file_conflict');

    const temporary=join(dirname(path),`.threadterm-${randomUUID()}.tmp`);
    const bytes=Buffer.from(params.content,'utf8');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    let effectStarted=false;
    let renamed=false;
    try {
      await verifyExpectedTarget(root,path,params.expectedFingerprint);
      handle=await open(temporary,'wx');
      effectStarted=true;
      temporaryIdentity=identity(await handle.stat());
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle=undefined;

      await recheckContainedTarget(root,path);
      const staged=await lstat(temporary);
      if (staged.isSymbolicLink() || !staged.isFile() || !sameIdentity(identity(staged),temporaryIdentity)) throw Error('path_escape');
      await verifyExpectedTarget(root,path,params.expectedFingerprint);
      await rename(temporary,path);
      renamed=true;
      await syncDirectory(dirname(path));
    } catch(error) {
      if (!effectStarted) throw noEffect(error);
      throw error;
    } finally {
      if (handle) await handle.close().catch(()=>{});
      if (!renamed && temporaryIdentity) await removeOwnedTemporary(temporary,temporaryIdentity);
    }
    return document(params.path,bytes,await lstat(path));
  }

  async create(root:string, params:{path:string;kind:'file'|'directory'}): Promise<FileEntry> {
    if (params.kind!=='file' && params.kind!=='directory') throw new NoEffectError('invalid_request');
    try { validateReferencePath(params.path); }
    catch(error) { throw noEffect(error); }
    const target=await containedTargetDetails(root,params.path,true);
    if (await exists(target.path)) {
      if (target.createdParents===0) throw new NoEffectError('file_exists');
      throw Error('file_exists');
    }
    try {
      if(params.kind==='file') await writeFile(target.path,'',{flag:'wx'});
      else await (await import('node:fs/promises')).mkdir(target.path);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='EEXIST' && target.createdParents===0) throw new NoEffectError('file_exists');
      throw error;
    }
    return entry(target.path,await lstat(target.path),relative(target.root,target.path));
  }

  async rename(root:string, params:{path:string;newPath:string}): Promise<FileEntry> {
    try { validateReferencePath(params.path); validateReferencePath(params.newPath); }
    catch(error) { throw noEffect(error); }
    const source=await containedTargetDetails(root,params.path,false).catch(error=>{throw noEffect(error);});
    const sourceMetadata=await lstat(source.path).catch(error=>{throw noEffect(error);});
    const target=await containedTargetDetails(root,params.newPath,true);
    const failBeforeRename=(code:string):never=>{
      if(target.createdParents===0)throw new NoEffectError(code);
      throw Error(code);
    };
    if(sourceMetadata.isDirectory()&&!sourceMetadata.isSymbolicLink()&&isContained(source.path,dirname(target.path))) failBeforeRename('invalid_path');
    if(await exists(target.path)&&!await isCaseOnlyRename(source.path,target.path)) failBeforeRename('file_exists');

    try {
      await recheckContainedTarget(root,source.path);
      await recheckContainedTarget(root,target.path);
      const current=await lstat(source.path);
      if(!sameIdentity(identity(current),identity(sourceMetadata))) failBeforeRename('file_conflict');
      if(await exists(target.path)&&!await isCaseOnlyRename(source.path,target.path)) failBeforeRename('file_exists');
    } catch(error) {
      if(error instanceof NoEffectError) throw error;
      if(target.createdParents===0) throw noEffect(error);
      throw error;
    }
    // Once native rename is attempted, a failed/uncertain result must retain the durable claim.
    await rename(source.path,target.path);
    return entry(target.path,await lstat(target.path),relative(target.root,target.path));
  }

  async delete(root:string, params:{path:string;permanent?:boolean}): Promise<{path:string;recycled:boolean}> {
    try { validateReferencePath(params.path); }
    catch(error) { throw noEffect(error); }
    const target=await containedTargetDetails(root,params.path,false).catch(error=>{throw noEffect(error);});
    const metadata=await lstat(target.path).catch(error=>{throw noEffect(error);});
    await recheckContainedTarget(root,target.path).catch(error=>{throw noEffect(error);});
    const current=await lstat(target.path).catch(error=>{throw noEffect(error);});
    if(!sameIdentity(identity(current),identity(metadata))) throw new NoEffectError('file_conflict');

    if(metadata.isSymbolicLink()) {
      await unlinkLexical(target.path);
      return {path:params.path,recycled:false};
    }
    if(params.permanent) {
      await rm(target.path,{recursive:metadata.isDirectory(),force:false});
      return {path:params.path,recycled:false};
    }
    await this.options.trashItem(target.path);
    return {path:params.path,recycled:true};
  }

  async files(root:string): Promise<FileListResult> {
    const walked=await this.walk(root,Date.now()+WALK_MS);
    return {paths:walked.items.map(item=>item.path),truncated:walked.truncated};
  }

  async search(root:string, query:SearchQuery): Promise<SearchResult> {
    const deadline=Date.now()+WALK_MS;
    const walked=streamProjectFiles(await canonicalPath(root),deadline);
    const result=await searchPaths(walked.items,query,deadline);
    return {...result,truncated:result.truncated||walked.state.truncated};
  }

  async preview(root:string, params:{path:string;offset:number;limit:number}): Promise<Preview> {
    // Keep host_files::dispatch parity: preview wire paths are portable `/` paths,
    // even though ordinary existing-file operations accept native scoped paths.
    if(typeof params.path!=='string'||params.path.includes(':')||params.path.includes('\\')) throw Error('invalid_path');
    if(!Number.isSafeInteger(params.offset)||params.offset<0) throw Error('invalid_offset');
    if(!Number.isSafeInteger(params.limit)||params.limit<=0||params.limit>PREVIEW_LIMIT) throw Error('invalid_limit');
    const path=await containedExisting(root,params.path);
    const handle=await open(path,'r');
    try {
      await recheckContainedTarget(root,path);
      const before=await validateOpenFilePath(handle,path);
      if(!before.isFile()) throw Error('not_a_file');
      if(before.size>BigInt(MAX_PREVIEW_BYTES)) throw Error('file_too_large');
      if(BigInt(params.offset)>before.size) throw Error('invalid_offset');
      const bytes=Buffer.alloc(Math.min(params.limit,Number(before.size)-params.offset));
      let length=0;
      while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,params.offset+length);if(!read.bytesRead)break;length+=read.bytesRead;}
      const after=await validateOpenFilePath(handle,path);
      await recheckContainedTarget(root,path);
      if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs) throw Error('file_changed');
      return {path:toNamespacedPath(path),size:Number(before.size),offset:params.offset,fingerprint:previewFingerprint(before),chunk:bytes.subarray(0,length).toString('base64'),eof:params.offset+length>=Number(before.size)};
    } finally { await handle.close(); }
  }

  /** Word preview (`design.md` §4.1): the preview chunk shape, `.docx .docm` only, the Office
   * size cap and the signature at offset 0 (S8). The sandboxed viewer parses the bytes. */
  async document(root:string, params:{path:string;offset:number;limit:number}): Promise<Preview> {
    if(typeof params.path!=='string'||params.path.includes(':')||params.path.includes('\\')) throw Error('invalid_path');
    if(!Number.isSafeInteger(params.offset)||params.offset<0) throw Error('invalid_offset');
    if(!Number.isSafeInteger(params.limit)||params.limit<=0||params.limit>PREVIEW_LIMIT) throw Error('invalid_limit');
    const extension=params.path.slice(params.path.lastIndexOf('.')+1).toLowerCase();
    if(extension!=='docx'&&extension!=='docm') throw Error('unsupported_document');
    const path=await containedExisting(root,params.path);
    const handle=await open(path,'r');
    try {
      await recheckContainedTarget(root,path);
      const before=await validateOpenFilePath(handle,path);
      if(!before.isFile()) throw Error('not_a_file');
      if(before.size>BigInt(OFFICE_PREVIEW_MAX_BYTES)) throw Error('file_too_large');
      if(BigInt(params.offset)>before.size) throw Error('invalid_offset');
      if(params.offset===0){
        const signature=Buffer.alloc(8);
        const read=await handle.read(signature,0,8,0);
        const first=signature.subarray(0,read.bytesRead);
        if(!first.subarray(0,4).equals(Buffer.from('PK\x03\x04','binary'))){
          if(first.length===8&&first.equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) throw Error('document_protected');
          throw Error('unsupported_document');
        }
      }
      const bytes=Buffer.alloc(Math.min(params.limit,Number(before.size)-params.offset));
      let length=0;
      while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,params.offset+length);if(!read.bytesRead)break;length+=read.bytesRead;}
      const after=await validateOpenFilePath(handle,path);
      await recheckContainedTarget(root,path);
      if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs) throw Error('file_changed');
      return {path:toNamespacedPath(path),size:Number(before.size),offset:params.offset,fingerprint:previewFingerprint(before),chunk:bytes.subarray(0,length).toString('base64'),eof:params.offset+length>=Number(before.size)};
    } finally { await handle.close(); }
  }

  private async directoryEntries(directory:string, prefix:string, maximum:number): Promise<{entries:FileEntry[];truncated:boolean}> {
    const entries:FileEntry[]=[];
    for(const item of await readdir(directory,{withFileTypes:true})){
      if(entries.length>=maximum)return {entries,truncated:true};
      const path=`${prefix ? `${prefix}/` : ''}${item.name}`;
      const target=join(directory,item.name);
      entries.push(entry(target,await lstat(target),path));
    }
    entries.sort((left,right)=>Number(left.kind!=='directory')-Number(right.kind!=='directory')||left.name.localeCompare(right.name,undefined,{sensitivity:'base'}));
    return {entries,truncated:false};
  }

  private async walk(root:string, deadline:number): Promise<{items:{path:string;absolute:string}[];truncated:boolean}> {
    return walkProjectFiles(await canonicalPath(root),deadline,MAX_LIST_FILES);
  }
}

type FileIdentity={dev:number;ino:number};
const identity=(metadata:{dev:number|bigint;ino:number|bigint}):FileIdentity=>({dev:Number(metadata.dev),ino:Number(metadata.ino)});
const sameIdentity=(left:FileIdentity,right:FileIdentity)=>left.dev===right.dev&&left.ino===right.ino;
const fingerprint=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const noEffect=(error:unknown)=>error instanceof NoEffectError?error:new NoEffectError(error instanceof Error?error.message:String(error));
const readonly=(metadata:{mode:number|bigint})=>(Number(metadata.mode)&0o222)===0;

async function exists(path:string){try{await lstat(path);return true;}catch{return false;}}
async function regular(path:string){const metadata=await lstat(path);if(!metadata.isFile()||metadata.isSymbolicLink())throw Error('not_a_file');return metadata;}
async function safeText(path:string){await regular(path);const data=await readBoundedFile(path,MAX_DOCUMENT_BYTES,'file_too_large');if(data.includes(0))throw Error('binary_file');try{new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);return data;}catch{throw Error('binary_file');}}

async function verifyExpectedTarget(root:string,path:string,expectedFingerprint:string):Promise<void>{
  await recheckContainedTarget(root,path);
  const metadata=await regular(path);
  if(readonly(metadata))throw Error('readonly_file');
  const bytes=await readBoundedFile(path,MAX_DOCUMENT_BYTES,'file_too_large');
  if(fingerprint(bytes)!==expectedFingerprint)throw Error('file_conflict');
}

async function removeOwnedTemporary(path:string,expected:FileIdentity):Promise<void>{
  const metadata=await lstat(path).catch(()=>undefined);
  if(metadata&&!metadata.isSymbolicLink()&&metadata.isFile()&&sameIdentity(identity(metadata),expected))await unlink(path).catch(()=>{});
}

async function syncDirectory(path:string):Promise<void>{
  const handle=await open(path,'r').catch(()=>undefined);
  if(!handle)return;
  try{await handle.sync().catch(()=>{});}finally{await handle.close().catch(()=>{});}
}

async function isCaseOnlyRename(source:string,target:string):Promise<boolean>{
  if(basename(source)===basename(target))return false;
  const [left,right]=await Promise.all([canonicalPath(source).catch(()=>undefined),canonicalPath(target).catch(()=>undefined)]);
  return left!==undefined&&right!==undefined&&relative(left,right)===''&&relative(right,left)==='';
}

async function unlinkLexical(path:string):Promise<void>{
  try{await unlink(path);}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code!=='EPERM'&&code!=='EISDIR')throw error;
    await rmdir(path);
  }
}

function document(path:string,data:Buffer,metadata:Awaited<ReturnType<typeof lstat>>):FileDocument{return {path,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data),fingerprint:fingerprint(data),readonly:readonly(metadata),size:Number(metadata.size),modifiedAt:metadata.mtime.toISOString()};}
function entry(full:string,metadata:Awaited<ReturnType<typeof lstat>>,path:string):FileEntry{return {name:basename(full),path:path.replace(/\\/g,'/'),kind:metadata.isSymbolicLink()?'symlink':metadata.isDirectory()?'directory':'file',...(metadata.isFile()?{size:Number(metadata.size)}:{})};}
function imageMime(data:Buffer):'image/png'|'image/jpeg'|'image/gif'|'image/webp'|undefined{if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(data.subarray(0,3).equals(Buffer.from([255,216,255])))return'image/jpeg';if(data.subarray(0,6).toString()==='GIF87a'||data.subarray(0,6).toString()==='GIF89a')return'image/gif';if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';return undefined;}
function previewFingerprint(metadata:Awaited<ReturnType<typeof validateOpenFilePath>>){
  let modified:string;
  if(process.platform==='win32'){
    const intervals=metadata.mtimeNs/100n+116_444_736_000_000_000n;
    modified=`SystemTime { intervals: ${intervals} }`;
  }else{
    let seconds=metadata.mtimeNs/1_000_000_000n, nanos=metadata.mtimeNs%1_000_000_000n;
    if(nanos<0){seconds--;nanos+=1_000_000_000n;}
    modified=`SystemTime { tv_sec: ${seconds}, tv_nsec: ${nanos} }`;
  }
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${modified}`;
}
async function roots():Promise<{name:string;path:string;kind:'directory';size:number}[]>{if(process.platform!=='win32')return [{name:'/',path:'/',kind:'directory',size:0}];const values:{name:string;path:string;kind:'directory';size:number}[]=[];for(let code=65;code<=90;code++){const path=`${String.fromCharCode(code)}:\\`;if(await exists(path))values.push({name:path,path,kind:'directory',size:0});}return values;}
