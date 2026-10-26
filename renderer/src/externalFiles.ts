import type { RequestParams, RequestResult } from '@threadterm/protocol';
import { request } from './bridge';
import { sameCanonicalScope } from './projectScope';
import type { QuoteContextItem } from './chatContext';
import type { EditorState } from '@codemirror/state';

export type ExternalFileSource = RequestParams<'filesystem.external.open'>['source'];
export const isAbsoluteFilePath = (path:string) => /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path);

const errors:Record<string,[string,string]> = {
 invalid_request:['This file request is invalid. Try opening the file again.','文件请求无效，请重新打开文件。'],
 invalid_path:['Choose a valid absolute file path. Device paths and file streams are not supported.','请选择有效的绝对文件路径。不支持设备路径或文件流。'],
 external_file_not_found:['This file no longer exists. Choose it again or remove it from recent files.','此文件已不存在。请重新选择，或从最近文件中移除。'],
 external_file_not_file:['This path is not a regular file. Choose a file instead.','此路径不是普通文件，请选择一个文件。'],
 external_file_unavailable:['This file cannot be accessed. Check its permissions or network connection and retry.','无法访问此文件。请检查权限或网络连接后重试。'],
 external_file_unknown:['This recent file entry is no longer registered. Open the file again.','此最近文件记录已失效，请重新打开文件。'],
 file_too_large:['This file exceeds the 1 MiB text preview limit.','此文件超过 1 MiB 的文本预览上限。'],
 binary_file:['This file is not supported UTF-8 text.','此文件不是受支持的 UTF-8 文本。'],
 image_too_large:['This image exceeds the 4 MiB preview limit.','此图片超过 4 MiB 的预览上限。'],
 unsupported_image:['This file is not a supported PNG, JPEG, GIF, or WebP image.','此文件不是受支持的 PNG、JPEG、GIF 或 WebP 图片。'],
 file_reference_session_not_found:['The source Chat is no longer available. Open the file from the current Chat.','来源聊天已不可用，请从当前聊天重新打开文件。'],
 file_reference_config_missing:['The source Chat has no saved launch configuration.','来源聊天没有已保存的启动配置。'],
 file_reference_project_missing:['The source Chat is not bound to a workspace project.','来源聊天未绑定工作区项目。'],
 file_reference_scope_mismatch:["The source Chat’s workspace has changed. Reopen the file from the current Chat.",'来源聊天的工作区已变更，请从当前聊天重新打开文件。'],
 file_reference_cwd_unavailable:["The source Chat’s launch folder is unavailable.",'来源聊天的启动目录不可用。'],
 file_reference_relative_requires_absolute:["This terminal’s current folder is unverified. Use an absolute file path.",'无法确认此终端的当前目录，请使用绝对文件路径。'],
 operation_conflict:['This operation ID was already used for a different request. Retry with a new operation.','此操作编号已用于其他请求，请使用新操作重试。'],
 runtime_error:['The file request could not be completed. Retry after reconnecting.','无法完成文件请求，请重新连接后重试。'],
};
export function externalFileErrorCode(error:unknown):string|undefined {
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined;
 if(code)return code;
 const message=error instanceof Error?error.message:String(error);
 return Object.keys(errors).find(key=>new RegExp(`\\b${key}\\b`).test(message));
}
export function externalFileError(error:unknown,zh:boolean):string {
 const code=externalFileErrorCode(error);
 return code&&errors[code]?errors[code][zh?1:0]:(zh?'无法打开文件，请重新连接后重试。':'Unable to open the file. Reconnect and retry.');
}

export type ExternalOpenTarget = {projectId:string;worktreePath?:string;path:string;kind:'file'|'preview';assetKind:'image'|'text';externalId?:string;ownerSessionId:string;line?:number;column?:number};
/** One ordered user action; opening a registry row never changes the Chat's scope or launch settings. */
export async function openExternalPaths(options:{paths:readonly string[];source:ExternalFileSource;sessionId:string;projectId:string;worktreePath?:string;projectPath?:string;line?:number;column?:number;zh:boolean;onOpen:(target:ExternalOpenTarget)=>void|Promise<void>;onNotice:(message:string)=>void},open:(params:RequestParams<'filesystem.external.open'>)=>Promise<RequestResult<'filesystem.external.open'>>=params=>request('filesystem.external.open',params)) {
 const failures:string[]=[];
 for(const path of options.paths.slice(0,10)){
  try{
   const result=await open({path,source:options.source,sessionId:options.sessionId});
   const file='file' in result?result.file:undefined,inside='inWorkspace' in result?result.inWorkspace:undefined;
   const currentPath=file?.path??inside!.path,image=file?.image??/\.(png|jpe?g|gif|webp)$/i.test(currentPath);
   await options.onOpen({projectId:inside?.projectId??options.projectId,worktreePath:inside?(sameCanonicalScope(inside.worktreePath,options.projectPath)?undefined:inside.worktreePath):options.worktreePath,path:currentPath,kind:image||/\.md$/i.test(currentPath)?'preview':'file',assetKind:image?'image':'text',...(file?{externalId:file.id}:{}),ownerSessionId:options.sessionId,line:options.line,column:options.column});
  }catch(error){failures.push(`${path}: ${externalFileError(error,options.zh)}`);}
 }
 if(options.paths.length>10)failures.push(options.zh?'一次最多打开 10 个文件，其余文件未打开。':'Up to 10 files can be opened at once; the remaining files were skipped.');
 if(failures.length)options.onNotice(failures.join('\n'));
}

/** Exact selected characters; cursor-only Ctrl+L sends the current line. */
export function externalSelectionText(state:EditorState):string {
 const range=state.selection.main;
 return range.empty?state.doc.lineAt(range.head).text:state.sliceDoc(range.from,range.to);
}

/** Includes the truncation marker in both the line and UTF-8 byte budgets. */
export function externalSelectionQuote(path:string,selection:string,startLine?:number,endLine?:number,zh=false):QuoteContextItem {
 const normalized=selection.replace(/\r\n/g,'\n'),lines=normalized.split('\n'),encoder=new TextEncoder();
 const marker=zh?'[选区已截断]':'[Selection truncated]';
 let text=lines.slice(0,200).join('\n');
 if(lines.length>200||encoder.encode(text).length>16*1024){
  text=lines.slice(0,199).join('\n');
  const budget=16*1024-encoder.encode('\n'+marker).length;
  let bytes=0,end=0;
  for(const char of text){const size=encoder.encode(char).length;if(bytes+size>budget)break;bytes+=size;end+=char.length;}
  text=text.slice(0,end)+'\n'+marker;
 }
 const range=startLine?`:${startLine}${endLine&&endLine!==startLine?`-${endLine}`:''}`:'';
 return {kind:'quote',id:crypto.randomUUID(),sourceTitle:`${path}${range}`,text};
}
