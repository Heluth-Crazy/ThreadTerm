import { lstat, open, realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import type { LargeFileWindow, LargeFileWindowRequest } from '@threadterm/protocol';

export const MAX_FILE_WINDOW_BYTES = 256 * 1024;
const FILE_WINDOW_LOOKAROUND_BYTES = 8 * 1024;
const NANOS_PER_SECOND = 1_000_000_000n;

/** Read at most `maximum` bytes even if a file grows after its initial stat. */
export async function readBoundedFile(path: string, maximum: number, tooLarge: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const metadata = await validateOpenFilePath(handle,path);
    if (!metadata.isFile()) throw new Error('not_a_file');
    if (metadata.size > BigInt(maximum)) throw new Error(tooLarge);

    const bytes = Buffer.allocUnsafe(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) {
        const after=await validateOpenFilePath(handle,path);
        if(metadata.size!==after.size||metadata.mtimeNs!==after.mtimeNs||metadata.ctimeNs!==after.ctimeNs)throw new Error('file_changed');
        return bytes.subarray(0, length);
      }
      length += bytesRead;
      if (length > maximum) throw new Error(tooLarge);
    }
    throw new Error(tooLarge);
  } finally {
    await handle.close();
  }
}

/** Runtime-compatible bounded text window through an already-authorized canonical path. */
export async function readFileWindow(path:string, request:LargeFileWindowRequest):Promise<LargeFileWindow> {
  const limit=request.maxBytes??MAX_FILE_WINDOW_BYTES;
  if(!Number.isSafeInteger(request.offset)||request.offset<0||!Number.isSafeInteger(limit)||limit<4||limit>MAX_FILE_WINDOW_BYTES)throw new Error('invalid_request');
  let handle:Awaited<ReturnType<typeof open>>;
  try{handle=await open(path,'r');}catch(error){throw windowIoError(error);}
  try{
    const before=await validateOpenFilePath(handle,path);
    if(!before.isFile())throw new Error('file_not_file');
    if(before.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('file_unavailable');
    const token=fileWindowToken(before);
    if(request.changeToken!==undefined&&request.changeToken!==token)throw new Error('file_changed');
    const size=Number(before.size);
    if(request.offset>=size)return {content:'',start:size,end:size,size,changeToken:token,startsMidLine:false,endsMidLine:false};

    const requested=Math.min(request.offset,size);
    const readStart=Math.max(0,requested-FILE_WINDOW_LOOKAROUND_BYTES);
    const payloadEnd=Math.min(size,requested+limit);
    const readEnd=Math.min(size,payloadEnd+4);
    const bytes=Buffer.alloc(readEnd-readStart);
    let length=0;
    while(length<bytes.length){
      let bytesRead:number;
      try{({bytesRead}=await handle.read(bytes,length,bytes.length-length,readStart+length));}
      catch(error){throw windowIoError(error);}
      if(bytesRead===0)throw new Error('file_changed');
      length+=bytesRead;
    }

    const requestedIndex=requested-readStart;
    const fileEndIndex=size-readStart;
    const precedingNewline=bytes.subarray(0,requestedIndex).lastIndexOf(0x0a);
    let startIndex=precedingNewline<0?requestedIndex:precedingNewline+1;
    if(requestedIndex-startIndex>Math.floor(limit/2))startIndex=requestedIndex;
    startIndex=advancePastSplitUtf8Scalar(bytes,startIndex);
    if(startIndex>0&&startIndex<bytes.length&&bytes[startIndex-1]===0x0d&&bytes[startIndex]===0x0a)startIndex--;

    const tailRequest=requested+limit>=size;
    let endIndex:number, lineEnd:number|undefined;
    if(tailRequest){
      startIndex=Math.max(startIndex,fileEndIndex-limit);
      endIndex=fileEndIndex;
    }else{
      const desiredEnd=Math.min(bytes.length,startIndex+limit);
      const newline=bytes.subarray(startIndex,desiredEnd).lastIndexOf(0x0a);
      lineEnd=newline<0?undefined:startIndex+newline+1;
      endIndex=lineEnd??desiredEnd;
    }
    startIndex=advancePastSplitUtf8Scalar(bytes,startIndex);
    if(startIndex>0&&startIndex<bytes.length&&bytes[startIndex-1]===0x0d&&bytes[startIndex]===0x0a){
      if(endIndex-startIndex>=limit)startIndex++;else startIndex--;
    }
    if(endIndex<bytes.length&&endIndex>startIndex&&bytes[endIndex-1]===0x0d&&bytes[endIndex]===0x0a)endIndex--;

    const decoded=decodeWindow(bytes,startIndex,endIndex,readStart+endIndex>=size);
    endIndex=decoded.endIndex;
    if(decoded.content.includes('\0'))throw new Error('binary_file');
    const start=readStart+startIndex,end=readStart+endIndex;
    const after=await validateOpenFilePath(handle,path);
    if(fileWindowToken(after)!==token)throw new Error('file_changed');
    if(lineEnd!==endIndex)lineEnd=undefined;
    return {content:decoded.content,start,end,size,changeToken:token,
      startsMidLine:start>0&&(startIndex===0||bytes[startIndex-1]!==0x0a),
      endsMidLine:end<size&&lineEnd===undefined};
  }finally{await handle.close();}
}

export async function validateOpenFilePath(handle: Awaited<ReturnType<typeof open>>, path:string) {
  const [metadata,canonical,lexical]=await Promise.all([
    handle.stat({bigint:true}),
    realpath(path).catch(()=>undefined),
    lstat(path,{bigint:true}).catch(()=>undefined),
  ]);
  if(!canonical||relative(path,canonical)!==''||relative(canonical,path)!=='')throw new Error('path_escape');
  if(!lexical||lexical.isSymbolicLink()||lexical.dev!==metadata.dev||lexical.ino!==metadata.ino)throw new Error('file_changed');
  return metadata;
}

function fileWindowToken(metadata:Awaited<ReturnType<typeof validateOpenFilePath>>):string{
  if(metadata.mtimeNs<0n)throw new Error('file_unavailable');
  return `${metadata.size}:${metadata.mtimeNs/NANOS_PER_SECOND}:${metadata.mtimeNs%NANOS_PER_SECOND}`;
}

/** The `read_window_path` change token (`runtime/src/workspace_services.rs`): size and
 * nanosecond mtime, the same text the Runtime backend returns, so a token survives a
 * backend switch. The sheet host fences on it too (`design.md` §2, §3.4). */
export const fileChangeToken = fileWindowToken;

function advancePastSplitUtf8Scalar(bytes:Buffer,start:number):number{
  if(start>=bytes.length||(bytes[start]&0xc0)!==0x80)return start;
  let leader=start;
  while(leader>0&&(bytes[leader]&0xc0)===0x80)leader--;
  const first=bytes[leader];
  const width=first>=0xc0&&first<=0xdf?2:first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf7?4:0;
  const end=leader+width;
  if(!width||end<=start||end>bytes.length)throw new Error('binary_file');
  try{new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(leader,end));}
  catch{throw new Error('binary_file');}
  return end;
}

function decodeWindow(bytes:Buffer,start:number,end:number,atFileEnd:boolean):{content:string;endIndex:number}{
  try{
    const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(start,end),{stream:!atFileEnd});
    return {content,endIndex:start+Buffer.byteLength(content,'utf8')};
  }catch{throw new Error('binary_file');}
}

function windowIoError(error:unknown):Error{
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined;
  return new Error(code==='ENOENT'?'file_not_found':code==='EISDIR'?'file_not_file':'file_unavailable');
}
