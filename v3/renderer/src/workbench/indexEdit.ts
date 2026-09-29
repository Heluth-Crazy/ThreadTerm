/** Hunk-level staging without patches: the renderer computes the next index text
 * from the diff it displays, and `git.index.write` fences it with the fingerprint
 * of the index blob that diff was based on.
 *
 * Offsets are @codemirror/merge chunk offsets over CodeMirror documents (line
 * breaks normalised to "\n"). They follow MergeView's own revert semantics:
 * `to` may point one past the end of the document. */
export type ChunkRange = { fromA:number; toA:number; fromB:number; toB:number };

function replaceChunk(dest:string, destFrom:number, destTo:number, source:string, sourceFrom:number, sourceTo:number) {
 let insert = source.slice(sourceFrom, Math.max(sourceFrom, sourceTo - 1));
 if(sourceFrom !== sourceTo && destTo <= dest.length) insert += '\n';
 return dest.slice(0, destFrom) + insert + dest.slice(Math.min(dest.length, destTo));
}

/** Keep the index's own line-break style; CodeMirror documents always use "\n". */
export function withLineBreaks(text:string, rawIndex:string) {
 const crlf = (rawIndex.match(/\r\n/g) ?? []).length;
 const lf = (rawIndex.match(/\n/g) ?? []).length - crlf;
 return crlf > lf ? text.replace(/\r?\n/g, '\r\n') : text;
}

/** Unstaged view (A = index, B = working file): index text with one chunk taken from the working file. */
export function stageChunk(index:string, working:string, chunk:ChunkRange) {
 return replaceChunk(index, chunk.fromA, chunk.toA, working, chunk.fromB, chunk.toB);
}

/** Staged view (A = HEAD, B = index): index text with one chunk restored to HEAD. */
export function unstageChunk(head:string, index:string, chunk:ChunkRange) {
 return replaceChunk(index, chunk.fromB, chunk.toB, head, chunk.fromA, chunk.toA);
}
