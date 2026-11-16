import { dirname, isAbsolute, resolve } from 'node:path';
import type { FileLocationRequest, FileLocationResult } from '@threadterm/protocol';
import { normalizeRelocationPath } from './relocationPaths.js';
import { isWithinScope } from './revealFile.js';

const validText = (value:unknown, limit:number):value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
export function locationRelativePath(value:string):string {
  if (!validText(value,16384) || isAbsolute(value) || /^[\\/]|^[a-z]:/i.test(value) || value.includes(':')) throw new Error('Invalid file location');
  const parts=value.replaceAll('\\','/').split('/');
  if(parts.some(part=>part==='..'))throw new Error('File is outside its project scope');
  const path=parts.filter(part=>part&&part!=='.').join('/');
  if(!path)throw new Error('Invalid file location');
  return path;
}
export function parseFileLocationRequest(value:unknown):FileLocationRequest {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid file location');
  const v=value as Record<string,unknown>,keys=Object.keys(v);
  if(v.externalId!==undefined){if(keys.length!==1||!validText(v.externalId,256))throw new Error('Invalid file location');return {externalId:v.externalId};}
  if(v.sessionId!==undefined){if(!keys.every(k=>['sessionId','path','workspaceRelative'].includes(k))||!validText(v.sessionId,256)||!validText(v.path,16384)||v.workspaceRelative!==undefined&&v.workspaceRelative!==true)throw new Error('Invalid file location');return {sessionId:v.sessionId,path:v.path,...(v.workspaceRelative?{workspaceRelative:true as const}:{})};}
  if(!keys.every(k=>['projectId','worktreePath','path'].includes(k))||!validText(v.projectId,256)||!validText(v.path,16384)||v.worktreePath!==undefined&&!validText(v.worktreePath,4096))throw new Error('Invalid file location');
  return {projectId:v.projectId,...(v.worktreePath===undefined?{}:{worktreePath:v.worktreePath}),path:locationRelativePath(v.path)};
}
export type ScopedLocationRequest = Exclude<FileLocationRequest,{sessionId:string}>;
export interface FileLocationDependencies {
  workspaceRoot(request:{projectId:string;worktreePath?:string}):Promise<string>;
  externalPath(id:string):Promise<string>;
  canonical(path:string):Promise<string>;
  kind(path:string):Promise<'file'|'directory'|'other'>;
  showItem(path:string):void|Promise<void>;
  openDirectory(path:string):Promise<string>;
}
const missing=(error:unknown)=>!!error&&typeof error==='object'&&['ENOENT','ENOTDIR'].includes(String((error as {code?:string}).code));
/** Only a native location operation; never execute or open a file with its default app. */
export async function revealLocalFileLocation(request:ScopedLocationRequest,deps:FileLocationDependencies):Promise<FileLocationResult>{
  if('externalId' in request){
    const registered=await deps.externalPath(request.externalId),canonical=await deps.canonical(registered);
    // An external registration is authoritative for its exact canonical identity, not a new symlink target.
    const identity=(path:string)=>{const value=resolve(normalizeRelocationPath(path,process.platform));return process.platform==='win32'?value.toLowerCase():value;};
    if(identity(canonical)!==identity(registered))throw new Error('Registered file identity changed');
    if(await deps.kind(canonical)!=='file')throw new Error('File is unavailable');
    await deps.showItem(canonical);return {kind:'file'};
  }
  const root=await deps.canonical(await deps.workspaceRoot(request));
  const target=resolve(root,locationRelativePath(request.path));
  if(!isWithinScope(root,target))throw new Error('File is outside its project scope');
  try{
    const canonical=await deps.canonical(target);
    if(!isWithinScope(root,canonical))throw new Error('File is outside its project scope');
    if(await deps.kind(canonical)==='other')throw new Error('File is unavailable');
    await deps.showItem(canonical);return {kind:'file'};
  }catch(error){if(!missing(error))throw error;}
  let parent=dirname(target);
  while(isWithinScope(root,parent)){
    try{
      const canonical=await deps.canonical(parent);
      if(!isWithinScope(root,canonical)||await deps.kind(canonical)!=='directory')throw new Error('File parent is outside its project scope');
      const error=await deps.openDirectory(canonical);if(error)throw new Error(error);
      return {kind:'parent'};
    }catch(error){if(!missing(error))throw error;}
    const next=dirname(parent);if(next===parent)break;parent=next;
  }
  throw new Error('File parent directory is unavailable');
}
/** Host paths must not be interpreted with the client's node:path platform. */
export function remoteLocationRootEquals(left:string,right:string):boolean{
  // A drive or backslash UNC/verbatim marker identifies Windows without consulting this client.
  // Forward-slash-only POSIX roots (including // roots) retain case-sensitive semantics.
  const windows = (value:string) => /^[a-z]:[\\/]|^\\\\|^\/\/\?\//i.test(value);
  if(windows(left)||windows(right)){
    const identity=(value:string):string|undefined=>{
      const plain=normalizeRelocationPath(value.replaceAll('/','\\'),'win32');
      if(!/^[a-z]:\\|^\\\\[^\\]+\\[^\\]+/i.test(plain)||/^\\\\[?.]\\/.test(plain))return;
      return plain.replace(/\\+$/,'').toLowerCase();
    };
    const a=identity(left),b=identity(right);
    return a!==undefined&&b!==undefined&&a===b;
  }
  const identity=(value:string)=>value.length>1?value.replace(/\/+$/,'')||'/':value;
  return identity(left)===identity(right);
}

export function remoteLocationPath(root:string,path:string):string{
  const relative=locationRelativePath(path),separator=root.includes('\\')?'\\':'/';
  return root.replace(/[\\/]+$/,'')+separator+relative.replaceAll('/',separator);
}
