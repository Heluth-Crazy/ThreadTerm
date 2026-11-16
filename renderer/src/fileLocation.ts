import type { FileLocationRequest } from '@threadterm/protocol';
import { revealFileLocation as revealNativeLocation } from './bridge';
import { referenceLocationTarget } from './referenceLocation';
import { isRemoteFiles } from './remoteFiles';
import type { ContextMenuItem } from './components/ContextMenu';

export type FileLocationTarget = FileLocationRequest;
export const fileLocationLabel=(zh:boolean)=>isRemoteFiles()?(zh?'在远程文件中显示':'Reveal in remote files'):(zh?'在资源管理器中显示':'Reveal in Explorer');
/** References may contain line/column suffixes; actual project filenames must remain literal. */
export function normalizedFileLocation(target:FileLocationTarget):FileLocationTarget{
  if(!('sessionId' in target)||target.workspaceRelative)return target;
  const reference=referenceLocationTarget(target.sessionId,{path:target.path});
  if(!reference)throw new Error('Unresolved file reference');
  return {...target,path:reference.path};
}
function locationNotice(message:string):void{
  if(typeof document==='undefined')return;
  document.querySelector('[data-file-location-notice]')?.remove();
  const notice=document.createElement('aside');notice.className='attention-toast';notice.dataset.fileLocationNotice='true';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const text=document.createElement('span');text.textContent=message;
  const close=document.createElement('button');close.type='button';close.className='btn btn-sm';close.textContent='×';close.setAttribute('aria-label',document.documentElement.lang.startsWith('zh')?'关闭':'Dismiss');close.onclick=()=>notice.remove();
  notice.append(text,close);document.body.append(notice);setTimeout(()=>notice.remove(),8000);
}
export async function revealFileLocation(target:FileLocationTarget,zh:boolean,onIssue?:(message:string)=>void):Promise<void>{
  try{
    const result=await revealNativeLocation(normalizedFileLocation(target));
    if(result.kind==='parent')(onIssue??locationNotice)(zh?'文件已不存在，已打开所在文件夹。':'The file no longer exists. Its folder was opened.');
  }catch{(onIssue??locationNotice)(isRemoteFiles()?(zh?'无法在远程文件中定位此路径。':'Could not locate this path on the remote computer.'):(zh?'无法定位此文件，请检查路径、文件是否存在及访问权限。':'Could not locate this file. Check its path, existence and access permissions.'));}
}
export function fileLocationMenuItem(target:FileLocationTarget,zh:boolean,onIssue?:(message:string)=>void):ContextMenuItem{
  const unavailable='externalId' in target&&isRemoteFiles();
  return {id:'file-reveal-system',label:fileLocationLabel(zh),testId:'file-reveal-system',disabled:unavailable,reason:unavailable?(zh?'此文件仅在本地登记。':'This file is registered on the local computer only.'):undefined,onSelect:()=>revealFileLocation(target,zh,onIssue)};
}
