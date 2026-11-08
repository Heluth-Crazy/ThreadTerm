/** Raw PTY chunks: offsets dedupe the host, sequences dedupe the WebView bridge. */
export type TerminalChunk = { seq:number; from:number; to:number; data:string };
export type TerminalStream = { epoch:number; seq:number; chunks:TerminalChunk[] };
const RETAIN_BYTES=256*1024;
export function appendTerminalChunk(previous:TerminalStream|undefined,bytes:Uint8Array,from:number,to:number,reset:boolean):TerminalStream {
  const stream=reset?{epoch:(previous?.epoch??0)+1,seq:previous?.seq??0,chunks:[]}:previous??{epoch:0,seq:0,chunks:[]};
  if(!bytes.length)return stream;
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  const seq=stream.seq+1,chunks=[...stream.chunks,{seq,from,to,data:btoa(binary)}];
  let retained=0,start=chunks.length;
  while(start>0&&retained<RETAIN_BYTES){start--;retained+=chunks[start].data.length*0.75;}
  return {epoch:stream.epoch,seq,chunks:chunks.slice(start)};
}
