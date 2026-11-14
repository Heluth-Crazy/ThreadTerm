import type { FileEntry } from '@threadterm/protocol';
import { sameCanonicalScope } from '../projectScope';
import type { WorkbenchScope } from './types';

/** An explicit command, including repeat requests for the same file and scope. */
export type FilesRevealRequest = { key:string; path:string; scope:WorkbenchScope };

export function createFilesReveal(scope:WorkbenchScope, path:string):FilesRevealRequest {
 const normalized = path.replace(/\\/g, '/');
 if(!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_path');
 return {key:crypto.randomUUID(), path:normalized, scope:{...scope}};
}

export function requestFilesReveal(scope:WorkbenchScope, path:string) {
 const reveal = createFilesReveal(scope, path);
 dispatchEvent(new CustomEvent('threadterm:workbench', {detail:{view:'files', key:reveal.key, reveal}}));
}

export function sameFilesScope(left:WorkbenchScope, right:WorkbenchScope) {
 return left.projectId === right.projectId && sameCanonicalScope(left.worktreePath ?? left.rootPath, right.worktreePath ?? right.rootPath);
}

/** Read each parent afresh: cached/expanded folders cannot prove a file still exists.
 * A missing child falls back to the last existing directory; IO/permission errors propagate.
 */
export async function resolveFilesReveal(path:string, list:(directory:string)=>Promise<FileEntry[]>) {
 const parts = path.split('/'), tree:Record<string,FileEntry[]> = {};
 let directory = '';
 for(let index = 0; index < parts.length; index++) {
  const entries = await list(directory);
  tree[directory] = entries;
  const candidate = directory ? `${directory}/${parts[index]}` : parts[index];
  const entry = entries.find(entry => entry.path === candidate);
  if(!entry || (index < parts.length - 1 && entry.kind !== 'directory')) return {path:directory, tree, expanded:Object.keys(tree), missing:true};
  if(index === parts.length - 1) return {path:entry.path, tree, expanded:Object.keys(tree), missing:false};
  directory = entry.path;
 }
 throw new Error('invalid_path');
}
