import { deflateSync } from 'node:zlib';

export const FAVICON_RASTER_LIMIT=256*1024;
export const FAVICON_SVG_LIMIT=32*1024;
export const FAVICON_MAX_DIMENSION=1024;
export const FAVICON_MAX_PIXELS=1024*1024;

type NativeImage={isEmpty():boolean;resize(options:{width:number;height:number}):{toPNG():Buffer}};
type Fetcher=(url:string,options:{signal:AbortSignal})=>Promise<Response>;

export function faviconUrl(value:string):boolean { try { const url=new URL(value); return value.length<=350_000&&['http:','https:','data:'].includes(url.protocol); } catch { return false; } }
export function faviconRequestCurrent(current:number|undefined, request:number):boolean { return current===request; }

/** Electron cannot always decode ICO containers, but modern ICO files commonly contain PNG images. */
export function icoPng(bytes:Buffer):Buffer|undefined {
  if(bytes.length<6||bytes.readUInt16LE(0)!==0||bytes.readUInt16LE(2)!==1)return undefined;
  const count=bytes.readUInt16LE(4); if(!count||bytes.length<6+count*16)return undefined;
  let best:{size:number;payload:Buffer}|undefined;
  for(let index=0;index<count;index++){
    const entry=6+index*16,width=bytes[entry]||256,height=bytes[entry+1]||256,length=bytes.readUInt32LE(entry+8),offset=bytes.readUInt32LE(entry+12);
    if(!length||offset>bytes.length||length>bytes.length-offset)continue;
    const payload=bytes.subarray(offset,offset+length);
    if(payload.length<8||!payload.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))continue;
    const size=Math.max(width,height); if(!best||Math.abs(size-32)<Math.abs(best.size-32))best={size,payload};
  }
  return best?.payload;
}

function crc32(bytes:Buffer):number { let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^(-(value&1)&0xedb88320);}return(value^0xffffffff)>>>0; }
function pngChunk(kind:string,data:Buffer):Buffer { const type=Buffer.from(kind),chunk=Buffer.alloc(12+data.length);chunk.writeUInt32BE(data.length,0);type.copy(chunk,4);data.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([type,data])),8+data.length);return chunk; }
function rgbaPng(width:number,height:number,rgba:Buffer):Buffer { const rows=Buffer.alloc(height*(width*4+1));for(let row=0;row<height;row++){const target=row*(width*4+1);rgba.copy(rows,target+1,row*width*4,(row+1)*width*4);}const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]); }
function boundedDimensions(width:number,height:number):boolean { return width>0&&height>0&&width<=FAVICON_MAX_DIMENSION&&height<=FAVICON_MAX_DIMENSION&&width*height<=FAVICON_MAX_PIXELS; }
function pngDimensions(bytes:Buffer):{width:number;height:number}|undefined { if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')return undefined;return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}; }
function jpegDimensions(bytes:Buffer):{width:number;height:number}|undefined {
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return undefined;
  let at=2;
  while(at<bytes.length){if(bytes[at++]!==0xff)return undefined;while(at<bytes.length&&bytes[at]===0xff)at++;if(at>=bytes.length)return undefined;const marker=bytes[at++];if(marker===0||marker===0x01||marker===0xd8||(marker>=0xd0&&marker<=0xd7))continue;if(marker===0xd9||marker===0xda||at+2>bytes.length)return undefined;const length=bytes.readUInt16BE(at);if(length<2||length>bytes.length-at)return undefined;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<7)return undefined;return {height:bytes.readUInt16BE(at+3),width:bytes.readUInt16BE(at+5)};}at+=length;
  }
  return undefined;
}
function boundedNativeRaster(bytes:Buffer):Buffer|undefined { const dimensions=pngDimensions(bytes)??jpegDimensions(bytes);return dimensions&&boundedDimensions(dimensions.width,dimensions.height)?bytes:undefined; }

function palette(bytes:Buffer,offset:number,count:number):Buffer|undefined { const length=count*4;if(!count||offset>bytes.length||length>bytes.length-offset)return undefined;return bytes.subarray(offset,offset+length); }
function paletteIndex(bytes:Buffer,row:number,x:number,bits:number):number { const offset=row+(bits===8?x:bits===4?x>>1:x>>3),value=bytes[offset];return bits===8?value:bits===4?(x&1?value&15:value>>4):(value>>(7-(x&7)))&1; }

/** Converts a bounded uncompressed 24/32-bit ICO DIB (including its AND mask) into PNG. */
export function icoDibPng(bytes:Buffer):Buffer|undefined {
  if(bytes.length<40)return undefined;const headerSize=bytes.readUInt32LE(0);if(headerSize<40||headerSize>bytes.length)return undefined;
  const width=bytes.readInt32LE(4),storedHeight=bytes.readInt32LE(8),planes=bytes.readUInt16LE(12),bits=bytes.readUInt16LE(14),compression=bytes.readUInt32LE(16);
  if(width<1||width>256||storedHeight<2||storedHeight%2||planes!==1||![1,4,8,24,32].includes(bits)||compression!==0)return undefined;
  const height=storedHeight/2;if(height>256)return undefined;const colorCount=bits<=8?(bytes.readUInt32LE(32)||1<<bits):0;if(colorCount>1<<bits)return undefined;const colors=colorCount?palette(bytes,headerSize,colorCount):undefined;if(colorCount&&!colors)return undefined;
  const xorOffset=headerSize+colorCount*4,xorStride=Math.floor((width*bits+31)/32)*4,maskStride=Math.floor((width+31)/32)*4,xorBytes=xorStride*height,maskOffset=xorOffset+xorBytes,maskBytes=maskStride*height;
  if(xorOffset>bytes.length||xorBytes>bytes.length-xorOffset||maskOffset>bytes.length||maskBytes>bytes.length-maskOffset)return undefined;
  const rgba=Buffer.alloc(width*height*4);let anyAlpha=false;if(bits===32)for(let y=0;y<height&&!anyAlpha;y++)for(let x=0;x<width;x++)if(bytes[xorOffset+y*xorStride+x*4+3]){anyAlpha=true;break;}
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const row=height-1-y,target=(y*width+x)*4,mask=bytes[maskOffset+row*maskStride+(x>>3)]&(0x80>>(x&7));if(bits<=8){const color=paletteIndex(bytes,xorOffset+row*xorStride,x,bits)*4;if(!colors||color+2>=colors.length)return undefined;rgba[target]=colors[color+2];rgba[target+1]=colors[color+1];rgba[target+2]=colors[color];}else{const source=xorOffset+row*xorStride+x*(bits/8);rgba[target]=bytes[source+2];rgba[target+1]=bytes[source+1];rgba[target+2]=bytes[source];}rgba[target+3]=bits===32&&anyAlpha?bytes[xorOffset+row*xorStride+x*4+3]:(mask?0:255);}
  return rgbaPng(width,height,rgba);
}

function icoDibContainerPng(bytes:Buffer):Buffer|undefined {
  if(bytes.length<6||bytes.readUInt16LE(0)!==0||bytes.readUInt16LE(2)!==1)return undefined;
  const count=bytes.readUInt16LE(4);if(!count||bytes.length<6+count*16)return undefined;let best:{size:number;png:Buffer}|undefined;
  for(let index=0;index<count;index++){const entry=6+index*16,width=bytes[entry]||256,height=bytes[entry+1]||256,length=bytes.readUInt32LE(entry+8),offset=bytes.readUInt32LE(entry+12);if(!length||offset>bytes.length||length>bytes.length-offset)continue;const png=icoDibPng(bytes.subarray(offset,offset+length));if(!png)continue;const size=Math.max(width,height);if(!best||Math.abs(size-32)<Math.abs(best.size-32))best={size,png};}
  return best?.png;
}

/** Bounded uncompressed standalone BMP (24/32-bit, <=256px) to PNG. */
export function bmpPng(bytes:Buffer):Buffer|undefined {
  if(bytes.length<54||bytes.toString('ascii',0,2)!=='BM')return undefined;const headerSize=bytes.readUInt32LE(14);if(headerSize<40||headerSize>bytes.length-14)return undefined;
  const offset=bytes.readUInt32LE(10),width=bytes.readInt32LE(18),height=bytes.readInt32LE(22),planes=bytes.readUInt16LE(26),bits=bytes.readUInt16LE(28),compression=bytes.readUInt32LE(30),rows=Math.abs(height);
  if(!boundedDimensions(width,rows)||!height||planes!==1||![1,4,8,24,32].includes(bits)||compression!==0)return undefined;const colorCount=bits<=8?(bytes.readUInt32LE(46)||1<<bits):0;if(colorCount>1<<bits)return undefined;const colors=colorCount?palette(bytes,14+headerSize,colorCount):undefined;if(colorCount&&!colors)return undefined;
  const stride=Math.floor((width*bits+31)/32)*4;if(offset<14+headerSize+colorCount*4||offset>bytes.length||stride*rows>bytes.length-offset)return undefined;const rgba=Buffer.alloc(width*rows*4);let anyAlpha=false;if(bits===32)for(let y=0;y<rows&&!anyAlpha;y++)for(let x=0;x<width;x++)if(bytes[offset+y*stride+x*4+3]){anyAlpha=true;break;}
  for(let y=0;y<rows;y++)for(let x=0;x<width;x++){const row=height>0?rows-1-y:y,target=(y*width+x)*4;if(bits<=8){const color=paletteIndex(bytes,offset+row*stride,x,bits)*4;if(!colors||color+2>=colors.length)return undefined;rgba[target]=colors[color+2];rgba[target+1]=colors[color+1];rgba[target+2]=colors[color];}else{const source=offset+row*stride+x*(bits/8);rgba[target]=bytes[source+2];rgba[target+1]=bytes[source+1];rgba[target+2]=bytes[source];rgba[target+3]=bits===32&&anyAlpha?bytes[source+3]:255;}if(bits<=8)rgba[target+3]=255;}
  return rgbaPng(width,rows,rgba);
}

/** Bounded first-frame GIF decoder. */
export function gifPng(bytes:Buffer):Buffer|undefined {
  if(bytes.length<13||!['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return undefined;const width=bytes.readUInt16LE(6),height=bytes.readUInt16LE(8);if(!width||!height||width>256||height>256)return undefined;let at=13,colors:Buffer|undefined,transparent:number|undefined;
  const table=(packed:number)=>{const count=1<<((packed&7)+1),size=count*3;if(at>bytes.length||size>bytes.length-at)return undefined;const result=bytes.subarray(at,at+size);at+=size;return result;};if(bytes[10]&0x80)colors=table(bytes[10]);
  while(at<bytes.length&&bytes[at]!==0x2c){if(bytes[at++]!==0x21||at>=bytes.length)return undefined;const label=bytes[at++];if(label===0xf9){if(at>=bytes.length||bytes[at++]!==4||at+5>bytes.length)return undefined;const packed=bytes[at],index=bytes[at+3];transparent=packed&1?index:undefined;at+=4;if(bytes[at++]!==0)return undefined;continue;}for(;;){if(at>=bytes.length)return undefined;const size=bytes[at++];if(!size)break;if(size>bytes.length-at)return undefined;at+=size;}}
  if(at+10>bytes.length)return undefined;at++;const left=bytes.readUInt16LE(at),top=bytes.readUInt16LE(at+2),frameWidth=bytes.readUInt16LE(at+4),frameHeight=bytes.readUInt16LE(at+6),packed=bytes[at+8];at+=9;if(!frameWidth||!frameHeight||left+frameWidth>width||top+frameHeight>height)return undefined;if(packed&0x80)colors=table(packed);if(!colors||at>=bytes.length)return undefined;
  const minimum=bytes[at++];if(minimum<2||minimum>8)return undefined;const compressed:Buffer[]=[];for(;;){if(at>=bytes.length)return undefined;const size=bytes[at++];if(!size)break;if(size>bytes.length-at)return undefined;compressed.push(bytes.subarray(at,at+size));at+=size;}const data=Buffer.concat(compressed),clear=1<<minimum,end=clear+1,pixelCount=frameWidth*frameHeight;let codeSize=minimum+1,next=end+1,bit=0,previous:number|undefined;const dictionary:number[][]=[];for(let value=0;value<clear;value++)dictionary[value]=[value];const pixels:number[]=[];
  while(bit+codeSize<=data.length*8&&pixels.length<pixelCount){let code=0;for(let index=0;index<codeSize;index++)code|=((data[(bit+index)>>3]>>((bit+index)&7))&1)<<index;bit+=codeSize;if(code===clear){dictionary.length=clear;for(let value=0;value<clear;value++)dictionary[value]=[value];codeSize=minimum+1;next=end+1;previous=undefined;continue;}if(code===end)break;let entry=dictionary[code];if(!entry){if(code!==next||previous===undefined)return undefined;const prior=dictionary[previous];if(!prior)return undefined;entry=[...prior,prior[0]];}if(pixels.length+entry.length>pixelCount)return undefined;pixels.push(...entry);if(previous!==undefined&&next<4096){const prior=dictionary[previous];if(!prior)return undefined;dictionary[next++]=[...prior,entry[0]];if(next===(1<<codeSize)&&codeSize<12)codeSize++;}previous=code;}
  if(pixels.length!==pixelCount)return undefined;const rows:number[]=[];if(packed&0x40)for(const [start,step] of [[0,8],[4,8],[2,4],[1,2]])for(let row=start;row<frameHeight;row+=step)rows.push(row);else for(let row=0;row<frameHeight;row++)rows.push(row);if(rows.length!==frameHeight)return undefined;
  const rgba=Buffer.alloc(width*height*4);for(let index=0;index<pixels.length;index++){const color=pixels[index]*3;if(color+2>=colors.length)return undefined;const x=left+index%frameWidth,y=top+rows[Math.floor(index/frameWidth)],target=(y*width+x)*4;rgba[target]=colors[color];rgba[target+1]=colors[color+1];rgba[target+2]=colors[color+2];rgba[target+3]=pixels[index]===transparent?0:255;}return rgbaPng(width,height,rgba);
}

export async function faviconBytes(response:Response, limit:number):Promise<Buffer|undefined> {
  const declared=Number(response.headers.get('content-length')); if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel().catch(()=>undefined);return undefined;}
  const reader=response.body?.getReader(); if(!reader)return undefined;
  const chunks:Uint8Array[]=[]; let length=0;
  try { for(;;) { const {done,value}=await reader.read(); if(done)break; if(!value)continue; length+=value.byteLength;if(length>limit)return undefined;chunks.push(value); } }
  finally { void reader.cancel().catch(()=>undefined); }
  return Buffer.concat(chunks,length);
}

export async function fetchFavicon(url:string, fetcher:Fetcher, decode:(bytes:Buffer)=>NativeImage, current:()=>boolean=()=>true, externalSignal?:AbortSignal, timeoutMs=5_000):Promise<string|undefined> {
  const controller=new AbortController(),abort=()=>controller.abort(externalSignal?.reason);if(externalSignal?.aborted)abort();else externalSignal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    if(controller.signal.aborted||!current())return undefined;
    const response=await fetcher(url,{signal:controller.signal});
    if(controller.signal.aborted||!current()){await response.body?.cancel().catch(()=>undefined);return undefined;}
    if(!response.ok)return undefined;
    const type=(response.headers.get('content-type')??'').split(';',1)[0].trim().toLowerCase();
    const svg=type==='image/svg+xml', bytes=await faviconBytes(response,svg?FAVICON_SVG_LIMIT:FAVICON_RASTER_LIMIT); if(!bytes||controller.signal.aborted||!current())return undefined;
    if(svg)return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
    const normalized=icoPng(bytes)??icoDibContainerPng(bytes)??bmpPng(bytes)??gifPng(bytes)??bytes, raster=boundedNativeRaster(normalized);if(!raster)return undefined;
    const image=decode(raster); if(image.isEmpty())return undefined;
    return `data:image/png;base64,${image.resize({width:32,height:32}).toPNG().toString('base64')}`;
  } catch { return undefined; } finally { externalSignal?.removeEventListener('abort',abort);controller.abort();clearTimeout(timer); }
}

export async function settleFavicon(candidates:string[], fetchCandidate:(candidate:string)=>Promise<string|undefined>, current:()=>boolean, accept:(favicon:string)=>void):Promise<void> {
  for(const candidate of candidates) {
    if(!faviconUrl(candidate))continue;
    const favicon=await fetchCandidate(candidate);
    if(!current())return;
    if(favicon){accept(favicon);return;}
  }
}
