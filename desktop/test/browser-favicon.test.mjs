import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { FAVICON_MAX_DIMENSION, FAVICON_RASTER_LIMIT, FAVICON_SVG_LIMIT, bmpPng, faviconBytes, faviconUrl, fetchFavicon, gifPng, icoDibPng, icoPng, settleFavicon } from '../src/browser/favicon.ts';

function response(body,options={}){const value=new Response(body,options);Object.defineProperty(value,'url',{value:'https://example.test/favicon'});return value;}
const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+N0q0XQAAAABJRU5ErkJggg==','base64');
function pngPixels(png){const width=png.readUInt32BE(16),height=png.readUInt32BE(20),chunks=[];for(let at=8;at<png.length;){const length=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8);if(kind==='IDAT')chunks.push(png.subarray(at+8,at+8+length));at+=12+length;}const rows=inflateSync(Buffer.concat(chunks)),rgba=Buffer.alloc(width*height*4);for(let row=0;row<height;row++){assert.equal(rows[row*(width*4+1)],0);rows.copy(rgba,row*width*4,row*(width*4+1)+1,(row+1)*(width*4+1));}return {width,height,rgba};}
function gifFixture(width,height,{local=false,interlaced=false,transparent}={}){const palette=Buffer.from([0,0,0,255,0,0,0,255,0,0,0,255]),display=Buffer.alloc(width*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)display[y*width+x]=(x+y)%4;const rows=[];if(interlaced)for(const [start,step] of [[0,8],[4,8],[2,4],[1,2]])for(let row=start;row<height;row+=step)rows.push(row);else for(let row=0;row<height;row++)rows.push(row);const pixels=Buffer.concat(rows.map(row=>display.subarray(row*width,(row+1)*width))),bits=[];let size=3,next=6,previous=false;const write=code=>{for(let bit=0;bit<size;bit++)bits.push((code>>bit)&1);};write(4);for(const pixel of pixels){write(pixel);if(previous&&next<4096){next++;if(next===1<<size&&size<12)size++;}previous=true;}write(5);const compressed=Buffer.alloc(Math.ceil(bits.length/8));bits.forEach((value,index)=>compressed[index>>3]|=value<<(index&7));const blocks=[];for(let at=0;at<compressed.length;at+=255){const chunk=compressed.subarray(at,at+255);blocks.push(Buffer.from([chunk.length]),chunk);}blocks.push(Buffer.from([0]));const header=Buffer.from([0x47,0x49,0x46,0x38,0x39,0x61,width&255,width>>8,height&255,height>>8,local?0:0x81,0,0]),control=transparent===undefined?Buffer.alloc(0):Buffer.from([0x21,0xf9,4,1,0,0,transparent,0]),descriptor=Buffer.from([0x2c,0,0,0,0,width&255,width>>8,height&255,height>>8,(local?0x81:0)|(interlaced?0x40:0)]);return {bytes:Buffer.concat([header,...(local?[]:[palette]),control,descriptor,...(local?[palette]:[]),Buffer.from([2]),...blocks,Buffer.from([0x3b])]),display,palette,transparent};}

test('favicon candidates permit only bounded http, https and data URLs',()=>{
 assert.equal(faviconUrl('https://example.test/favicon.png'),true);
 assert.equal(faviconUrl('data:image/png;base64,AA=='),true);
 assert.equal(faviconUrl('file:///favicon.png'),false);
 assert.equal(faviconUrl('javascript:alert(1)'),false);
 assert.equal(faviconUrl(`https://example.test/${'x'.repeat(350_000)}`),false);
});

test('favicon response reads are bounded before decode',async()=>{
 const value=response(new Uint8Array(FAVICON_RASTER_LIMIT+1),{headers:{'content-type':'image/png'}});
 assert.equal(await faviconBytes(value,FAVICON_RASTER_LIMIT),undefined);
});

test('declared oversize favicon bodies are cancelled without reading',async()=>{
 let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}}),value=new Response(body,{headers:{'content-length':String(FAVICON_RASTER_LIMIT+1)}});
 assert.equal(await faviconBytes(value,FAVICON_RASTER_LIMIT),undefined);assert.equal(cancelled,true);
});

test('favicon decoding preserves bounded SVG and normalizes rasters to 32px PNG',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"/>';
 const decoded=[];
 // A constructed Fetch Response has an empty url; Electron session.fetch may too.
 const svgResult=await fetchFavicon('https://example.test/favicon.svg',async()=>new Response(svg,{headers:{'content-type':'image/svg+xml'}}),()=>{throw Error('SVG must not use native decode');});
 assert.equal(svgResult,`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
 const pngResult=await fetchFavicon('https://example.test/favicon.png',async()=>response(tinyPng,{headers:{'content-type':'image/png'}}),bytes=>({isEmpty:()=>false,resize:size=>{decoded.push([Buffer.from(bytes),size]);return {toPNG:()=>Buffer.from('png')}}}));
 assert.equal(pngResult,'data:image/png;base64,cG5n');
 assert.deepEqual(decoded,[[tinyPng,{width:32,height:32}]]);
 const oversizedSvg=await fetchFavicon('https://example.test/large.svg',async()=>response(new Uint8Array(FAVICON_SVG_LIMIT+1),{headers:{'content-type':'image/svg+xml'}}),()=>{throw Error('oversized SVG must not decode');});
 assert.equal(oversizedSvg,undefined);
});

test('PNG-backed ICO containers unwrap their closest 32px entry before native decoding',async()=>{
 const png=tinyPng;
 const ico=Buffer.alloc(22);ico.writeUInt16LE(0,0);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=32;ico[7]=32;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
 const bytes=Buffer.concat([ico,png]);assert.deepEqual(icoPng(bytes),png);
 let decoded;const result=await fetchFavicon('https://example.test/favicon.ico',async()=>response(bytes,{headers:{'content-type':'image/x-icon'}}),value=>{decoded=value;return {isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.from('png')})};});
 assert.deepEqual(decoded,png);assert.equal(result,'data:image/png;base64,cG5n');
});

test('uncompressed 32-bit DIB ICO payloads normalize to PNG before native decoding',async()=>{
 const dib=Buffer.alloc(48);dib.writeUInt32LE(40,0);dib.writeInt32LE(1,4);dib.writeInt32LE(2,8);dib.writeUInt16LE(1,12);dib.writeUInt16LE(32,14);dib[40]=0;dib[41]=0;dib[42]=255;dib[43]=255;
 const normalized=icoDibPng(dib);assert.ok(normalized?.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])));
 const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=1;ico[7]=1;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(dib.length,14);ico.writeUInt32LE(22,18);
 let decoded;const result=await fetchFavicon('https://example.test/favicon.ico',async()=>response(Buffer.concat([ico,dib]),{headers:{'content-type':'image/x-icon'}}),value=>{decoded=value;return {isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.from('png')})};});
 assert.deepEqual(decoded,normalized);assert.equal(result,'data:image/png;base64,cG5n');
});

test('standalone BMP and GIF normalize before native decoding',async()=>{
 const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp[54]=0;bmp[55]=0;bmp[56]=255;
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
 for(const [name,body] of [['bmp',bmp],['gif',gif]]){let decoded;const result=await fetchFavicon(`https://example.test/favicon.${name}`,async()=>response(body,{headers:{'content-type':`image/${name}`}}),value=>{decoded=value;return {isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.from('png')})};});assert.ok(decoded.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),name);assert.equal(result,'data:image/png;base64,cG5n');}
});

test('native raster decode rejects compressed dimension bombs before nativeImage',async()=>{
 const png=Buffer.alloc(24);tinyPng.subarray(0,16).copy(png);png.writeUInt32BE(FAVICON_MAX_DIMENSION+1,16);png.writeUInt32BE(1,20);
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,(FAVICON_MAX_DIMENSION+1)>>8,(FAVICON_MAX_DIMENSION+1)&255,1,1,0x11,0,0xff,0xd9]);
 for(const [name,body] of [['png',png],['jpeg',jpeg]]){let decoded=false;const result=await fetchFavicon(`https://example.test/large.${name}`,async()=>response(body,{headers:{'content-type':`image/${name}`}}),()=>{decoded=true;throw Error('oversized raster must not decode');});assert.equal(result,undefined,name);assert.equal(decoded,false,name);}
});

test('bounded JPEG SOF dimensions reach native decoding',async()=>{
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xd9]);let decoded;
 const result=await fetchFavicon('https://example.test/favicon.jpg',async()=>response(jpeg,{headers:{'content-type':'image/jpeg'}}),bytes=>{decoded=bytes;return {isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.from('png')})};});
 assert.deepEqual(decoded,jpeg);assert.equal(result,'data:image/png;base64,cG5n');
});

test('GIF first-frame decoder covers code growth, local palettes, interlace and transparency',()=>{
 for(const [size,options] of [[32,{}],[64,{local:true}],[128,{interlaced:true}],[256,{local:true,interlaced:true,transparent:0}]]){const fixture=gifFixture(size,size,options),png=gifPng(fixture.bytes);assert.ok(png,`${size}px GIF`);const decoded=pngPixels(png);assert.deepEqual([decoded.width,decoded.height],[size,size]);for(let index=0;index<fixture.display.length;index++){const color=fixture.display[index]*3,target=index*4;assert.deepEqual([...decoded.rgba.subarray(target,target+4)],[fixture.palette[color],fixture.palette[color+1],fixture.palette[color+2],fixture.display[index]===fixture.transparent?0:255],`${size}px pixel ${index}`);}}
});

test('GIF decoder rejects invalid future dictionary codes without throwing',()=>{
 const fixture=gifFixture(10,1),at=fixture.bytes.indexOf(Buffer.from([2]),fixture.bytes.indexOf(Buffer.from([0x2c]))+10),malformed=Buffer.from(fixture.bytes),codes=[4,0,7,7],bits=[];for(const code of codes)for(let bit=0;bit<3;bit++)bits.push((code>>bit)&1);const packed=Buffer.alloc(Math.ceil(bits.length/8));bits.forEach((value,index)=>packed[index>>3]|=value<<(index&7));malformed[at+1]=packed.length;packed.copy(malformed,at+2);malformed[at+2+packed.length]=0;
 assert.doesNotThrow(()=>gifPng(malformed));assert.equal(gifPng(malformed),undefined);
});

test('paletted BMP and ICO plus zero-alpha 32-bit BMP normalize correctly',()=>{
 const bmp=Buffer.alloc(66);bmp.write('BM');bmp.writeUInt32LE(66,2);bmp.writeUInt32LE(62,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(2,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(8,28);bmp.writeUInt32LE(2,46);bmp.set([255,0,0,0,0,0,255,0],54);bmp.set([0,1,0,0],62);assert.deepEqual([...pngPixels(bmpPng(bmp)).rgba],[0,0,255,255,255,0,0,255]);
 const dib=Buffer.alloc(56);dib.writeUInt32LE(40,0);dib.writeInt32LE(2,4);dib.writeInt32LE(2,8);dib.writeUInt16LE(1,12);dib.writeUInt16LE(8,14);dib.writeUInt32LE(2,32);dib.set([255,0,0,0,0,0,255,0],40);dib.set([0,1,0,0],48);assert.deepEqual([...pngPixels(icoDibPng(dib)).rgba],[0,0,255,255,255,0,0,255]);
 const rgba=Buffer.alloc(58);rgba.write('BM');rgba.writeUInt32LE(58,2);rgba.writeUInt32LE(54,10);rgba.writeUInt32LE(40,14);rgba.writeInt32LE(1,18);rgba.writeInt32LE(1,22);rgba.writeUInt16LE(1,26);rgba.writeUInt16LE(32,28);rgba.set([0,0,255,0],54);assert.deepEqual([...pngPixels(bmpPng(rgba)).rgba],[255,0,0,255]);
});

test('favicon fetch aborts on its bounded deadline',async()=>{
 let aborted=false;
 const result=await fetchFavicon('https://example.test/slow.png',async(_url,{signal})=>await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));})),()=>{throw Error('must not decode');},()=>true,undefined,1);
 assert.equal(result,undefined);assert.equal(aborted,true);
});

test('stale favicon fetches skip body work and native decoding',async()=>{
 let current=true,resolveFetch,decoded=false,cancelled=false;const fetchPending=new Promise(resolve=>{resolveFetch=resolve;}),first=fetchFavicon('https://example.test/favicon.png',async()=>await fetchPending,()=>{decoded=true;throw Error('stale fetch must not decode');},()=>current);
 current=false;resolveFetch(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}}));assert.equal(await first,undefined);assert.equal(cancelled,true);assert.equal(decoded,false);
 let release,observed;const afterFetch=new Promise(resolve=>{observed=resolve;});current=true;const stream=new ReadableStream({start(controller){release=()=>{controller.enqueue(tinyPng);controller.close();};}}),second=fetchFavicon('https://example.test/favicon.png',async()=>new Response(stream,{headers:{'content-type':'image/png'}}),()=>{decoded=true;throw Error('stale body must not decode');},()=>{observed();return current;});
 await afterFetch;await Promise.resolve();current=false;release();assert.equal(await second,undefined);assert.equal(decoded,false);
});

test('external abort reaches the active fetch and prevents later candidates',async()=>{
 const controller=new AbortController(),calls=[],accepted=[];let fetchSignal;
 const pending=settleFavicon(['https://example.test/first.png','https://example.test/second.png'],candidate=>fetchFavicon(candidate,async(_url,{signal})=>{calls.push(candidate);fetchSignal=signal;return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));},()=>{throw Error('aborted fetch must not decode');},()=>!controller.signal.aborted,controller.signal),()=>!controller.signal.aborted,icon=>accepted.push(icon));
 assert.equal(fetchSignal.aborted,false);controller.abort();await pending;assert.equal(fetchSignal.aborted,true);assert.deepEqual(calls,['https://example.test/first.png']);assert.deepEqual(accepted,[]);
});

test('deferred favicon completion cannot mutate a navigated, closed, or replaced view',async()=>{
 for(const reason of ['navigation epoch changed','tab closed','view replaced']){
  let resolve;const deferred=new Promise(done=>{resolve=done;}),accepted=[];
  const current=()=>false;
  const pending=settleFavicon(['https://example.test/favicon.png'],async()=>await deferred,current,icon=>accepted.push(icon));
  resolve('data:image/png;base64,stale');await pending;
  assert.deepEqual(accepted,[],reason);
 }
});
