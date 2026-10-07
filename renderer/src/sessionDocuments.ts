import type { ReviewCheckpoint, ReviewFile, SessionDocument } from '@threadterm/protocol';
import { workbenchError } from './workbench/errors';

export const documentPath = (path:string) => path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
export const documentTitle = (document:SessionDocument) => document.title || document.path.split('/').at(-1) || document.path;
export const isDocumentPinned = (documents:readonly SessionDocument[], path:string) => documents.some(document => document.path === documentPath(path));

export function firstReadyCheckpoint(checkpoints:readonly ReviewCheckpoint[]):ReviewCheckpoint|undefined {
 return checkpoints.filter(checkpoint => checkpoint.status === 'ready').slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
}

export function suggestedDocuments(files:readonly ReviewFile[], documents:readonly SessionDocument[]):string[] {
 const pins = new Set(documents.map(document => documentPath(document.path)));
 return [...new Set(files.filter(file => file.status !== 'D' && /\.(md|markdown)$/i.test(file.path)).map(file => documentPath(file.path)))].filter(path => !pins.has(path)).slice(0, 5);
}

export function sessionDocumentError(error:unknown, zh:boolean):string {
 const raw = error instanceof Error ? error.message : String(error);
 const messages:Record<string,[string,string]> = {
  too_many_documents:['Plans & docs holds up to 20 files per session.', '每个会话的计划与文档最多 20 个文件。'],
  path_outside_root:['Choose a file inside this session’s worktree.', '请选择此会话工作树内的文件。'],
  not_a_file:['Choose an existing regular file.', '请选择存在的普通文件。'],
  file_too_large:['The file is too large to add (over 2 MiB).', '文件太大，无法添加（超过 2 MiB）。'],
  session_not_found:['This session no longer exists.', '此会话已不存在。'],
 };
 const code = Object.keys(messages).find(code => raw.includes(code));
 return code ? messages[code][zh ? 1 : 0] : workbenchError(error, zh);
}
