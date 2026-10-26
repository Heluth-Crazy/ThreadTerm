import { FILE_DRAG_TYPE } from './fileDrag';
import { groupDropFilePaths } from './groupFileDrop';

export function acceptsExternalFileDrop(types:readonly string[],inComposer:boolean):boolean {
 return !inComposer&&types.includes('Files')&&!types.includes(FILE_DRAG_TYPE);
}
/** The native path capability is injected so browser-only/synthetic Files never become path guesses. */
export function externalFileDrop(transfer:Pick<DataTransfer,'types'|'files'>,inComposer:boolean,getPathForFile:((file:File)=>string)|undefined,open:(paths:string[],source:'drop')=>void):boolean {
 if(!acceptsExternalFileDrop(transfer.types,inComposer))return false;
 const paths=groupDropFilePaths(transfer.files,getPathForFile);
 if(paths.length)open(paths,'drop');
 return true;
}
