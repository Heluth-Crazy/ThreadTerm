import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import { request } from '../bridge';
import type { ContextItem } from '../chatContext';

type Scope = { projectId:string; worktreePath?:string };

const documentText = (value:string) => Text.of(value.replace(/\r\n?/g, '\n').split('\n'));
const range = (start:number, count:number) => count === 1 ? `${start}` : `${start},${count}`;

function hunkLines(document:Text, from:number, to:number, hasFinalNewline:boolean) {
 if(!document.length || from === to) {
  const line = document.lineAt(Math.min(from, document.length));
  return {start:from === line.from ? line.number - 1 : line.number, lines:[] as string[], endsAtDocumentEnd:false};
 }
 const first = document.lineAt(Math.min(from, document.length)).number;
 const last = document.lineAt(Math.min(Math.max(from, to - 1), document.length)).number;
 const endsAtDocumentEnd = last === document.lines;
 const lines = document.sliceString(document.line(first).from, document.line(last).to).split('\n');
 if(endsAtDocumentEnd && hasFinalNewline) lines.pop();
 return {start:first, lines, endsAtDocumentEnd};
}

function patchLines(prefix:string, hunk:ReturnType<typeof hunkLines>, hasFinalNewline:boolean) {
 return hunk.lines.flatMap((line, index) => [
  `${prefix}${line}`,
  ...(index === hunk.lines.length - 1 && hunk.endsAtDocumentEnd && !hasFinalNewline ? ['\\ No newline at end of file'] : []),
 ]);
}

/** Builds the real changed hunks from the same GitDiff source shown in the merge editor. */
export function unifiedGitDiff(path:string, oldText:string, newText:string) {
 const oldDocument = documentText(oldText), newDocument = documentText(newText);
 const chunks = Chunk.build(oldDocument, newDocument, {scanLimit:5000, timeout:250});
 const header = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
 for(const chunk of chunks) {
  const oldHunk = hunkLines(oldDocument, chunk.fromA, chunk.toA, oldText.endsWith('\n'));
  const newHunk = hunkLines(newDocument, chunk.fromB, chunk.toB, newText.endsWith('\n'));
  header.push(`@@ -${range(oldHunk.start, oldHunk.lines.length)} +${range(newHunk.start, newHunk.lines.length)} @@`);
  for(const line of patchLines('-', oldHunk, oldText.endsWith('\n'))) header.push(line);
  for(const line of patchLines('+', newHunk, newText.endsWith('\n'))) header.push(line);
 }
 return header.join('\n');
}

export async function changedFileContext(scope:Scope, path:string, staged:boolean, zh:boolean):Promise<ContextItem> {
 const diff = await request('git.diff', {...scope, path, staged});
 if(diff.binary) throw new Error(zh ? '二进制文件无法作为差异发送。' : 'Binary files cannot be sent as a diff.');
 return {kind:'diff', id:crypto.randomUUID(), path, staged, text:unifiedGitDiff(path, diff.oldText, diff.newText), truncated:false};
}
