import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import { revertChunk, type RevertSpec } from '../components/diffRevert';
import { stageChunk, unstageChunk, withLineBreaks, type ChunkRange } from './indexEdit';

export type HunkPreviewLine={kind:'removed'|'added';text:string};
export type HunkPreview={lines:readonly HunkPreviewLine[];remaining:number};

const normalise=(text:string)=>text.replace(/\r\n?/g,'\n');

/** Builds the exact limited diff used by the Git gutter markers. */
export function buildGitHunks(base:string,doc:Text):readonly Chunk[]{
 return Chunk.build(Text.of(normalise(base).split('\n')),doc,{scanLimit:5000,timeout:250});
}

function markerLine(chunk:ChunkRange,doc:Text,position:number){
 if(chunk.fromB>=chunk.toB)return doc.lineAt(Math.min(chunk.fromB,doc.length)).number===position;
 const first=doc.lineAt(Math.min(chunk.fromB,doc.length)).number;
 const last=doc.lineAt(Math.min(Math.max(chunk.fromB,chunk.toB-1),doc.length)).number;
 return first<=position&&position<=last;
}

/** Returns the chunk whose rendered gutter marker occupies `position`'s line. */
export function hunkAtPosition(chunks:readonly ChunkRange[],doc:Text,position:number){
 const line=doc.lineAt(Math.max(0,Math.min(position,doc.length))).number;
 return chunks.findIndex(chunk=>markerLine(chunk,doc,line));
}

/** Finds the next or previous distinct chunk without wrapping at either end. */
export function adjacentGitHunk(chunks:readonly ChunkRange[],head:number,direction:1|-1){
 if(direction>0)return chunks.findIndex(chunk=>chunk.fromB>head);
 for(let index=chunks.length-1;index>=0;index--)if(chunks[index].toB<=head&&chunks[index].fromB<head)return index;
 return -1;
}

/** Replaces one buffer hunk with its index text; callers dispatch the returned transaction spec. */
export function revertGitHunk(base:string,buffer:string,chunk:ChunkRange):RevertSpec{
 const a=normalise(base),b=normalise(buffer);
 return revertChunk(chunk.fromA,chunk.toA,chunk.fromB,chunk.toB,a,b);
}

/** Computes the fenced index payload for a staged or unstaged hunk and preserves its line endings. */
export function indexChunkContent(a:string,b:string,chunk:ChunkRange,staged:boolean,rawIndex:string){
 const left=normalise(a),right=normalise(b);
 return withLineBreaks(staged?unstageChunk(left,right,chunk):stageChunk(left,right,chunk),rawIndex);
}

function hunkLines(text:string,from:number,to:number){
 if(from===to)return [];
 return text.slice(from,Math.max(from,to-1)).split('\n');
}

/** Compact base/current text for the popup, with removals always preceding additions. */
export function hunkPreview(base:string,buffer:string,chunk:ChunkRange,limit=200):HunkPreview{
 const removed=hunkLines(normalise(base),chunk.fromA,chunk.toA).map(text=>({kind:'removed' as const,text}));
 const added=hunkLines(normalise(buffer),chunk.fromB,chunk.toB).map(text=>({kind:'added' as const,text}));
 const all=[...removed,...added],lines=all.slice(0,Math.max(0,limit));
 return {lines,remaining:all.length-lines.length};
}

/** Every gutter-popup entry point yields to read-only and conflict editors. */
export function canUseGitHunks(readOnly:boolean,conflicted:boolean,hasConflictBlocks:boolean){return !readOnly&&!conflicted&&!hasConflictBlocks;}
