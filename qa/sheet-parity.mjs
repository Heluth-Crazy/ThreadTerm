// Parity gate for the Excel sheet core (task 11-10, step 3, design.md §8): the native
// helper and the WebAssembly reader must answer the same request list with the same JSON.
//
//   $env:TEMP="$env:TEMP"; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<runtime executable built from this tree>'
//   npm run build:sheet-wasm
//   node qa/sheet-parity.mjs [--allow-missing-fixtures]
//
// Native host: `<runtime> --sheet-worker` (the shipped helper, JSON lines on stdin/stdout).
// WebAssembly host: the product's own reader core (`desktop/src/local-files/sheet-reader-core.ts`
// over `sheet-wasm.ts`), bundled here and fed the same bytes in 1 MiB chunks — the code the
// `utilityProcess` reader runs.
//
// Every fixture opens under both hosts; the replies are compared as JSON. The only value that
// legitimately differs is `progress` on a `loading` reply: the native helper reports it through
// the core's progress callback on its load thread, and a synchronous WebAssembly load cannot
// call back into the host mid-load (design.md §3.1), so it is dropped before the comparison.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'..');
const scratchBase=resolve(process.env.TEMP??(()=>{throw Error('TEMP must point to the shared tt-qa-temp root');})());
assert.match(scratchBase.replaceAll('\\','/').toLowerCase(),/\/tt-qa-temp$/,'TEMP is the approved shared QA root');
// The large generated workbooks are scratch-only; the small ones committed beside the core
// (calamine's samples, 1904 dates, protected and truncated files) are always compared, so the
// full gate keeps a parity check after the scratch folder is gone.
const fixtures=resolve(scratchBase,'office-preview/fixtures');
const committedFixtures=join(root,'runtime/sheet-core/tests/fixtures');
const wasmFile=join(root,'desktop-dist/sheet-core.wasm');
const runtime=resolve(process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const allowMissing=process.argv.includes('--allow-missing-fixtures');
const CHUNK=1024*1024;
const READY_TIMEOUT_MS=240_000;

if(!existsSync(wasmFile)||!existsSync(runtime)){
 const message=`missing ${existsSync(wasmFile)?runtime:wasmFile}; build the wasm (npm run build:sheet-wasm) and the QA runtime first`;
 if(!allowMissing)throw Error(message);
 console.log(`SHEET PARITY SKIPPED: ${message}`);
 process.exit(0);
}
if(!existsSync(fixtures)){
 const message=`missing the large fixtures at ${fixtures}; comparing the committed ones only`;
 if(!allowMissing)throw Error(message);
 console.log(`SHEET PARITY: ${message}`);
}

await mkdir(join(scratchBase,'office-preview/step3'),{recursive:true});
const scratch=await mkdtemp(join(scratchBase,'office-preview/step3/parity-'));
const report={passed:false,wasmFile,runtime,fixtures,scratch,fixturesCompared:{},differences:[],errors:[],checks:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};

/** The product reader core, bundled so plain Node can import these two modules. */
async function loadReaderCore(){
 const entry=join(scratch,'entry.ts');
 const quote=path=>JSON.stringify(path.replaceAll('\\','/'));
 await writeFile(entry,`export { loadSheetWasm, createSheetEngine } from ${quote(join(root,'desktop/src/local-files/sheet-wasm.ts'))};\nexport { createReaderSession } from ${quote(join(root,'desktop/src/local-files/sheet-reader-core.ts'))};\n`);
 const {build}=await import('esbuild');
 await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',target:'node22',outfile:join(scratch,'reader-core.mjs'),logLevel:'error'});
 return await import(pathToFileURL(join(scratch,'reader-core.mjs')).href);
}

/** `<runtime> --sheet-worker`: one JSON line out, one back, exactly as the runtime host uses it. */
function nativeHost(){
 const child=spawn(runtime,['--sheet-worker'],{windowsHide:true,stdio:['pipe','pipe','inherit']});
 let buffer='';
 const lines=[];
 let notify;
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',text=>{
  buffer+=text;
  let index;
  while((index=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
   if(!line.trim())continue;
   lines.push(JSON.parse(line));
   notify?.();
  }
 });
 const next=async(predicate,label,timeout=READY_TIMEOUT_MS)=>{
  const deadline=Date.now()+timeout;
  for(;;){
   const index=lines.findIndex(predicate);
   if(index>=0)return lines.splice(index,1)[0];
   if(Date.now()>deadline)throw Error(`native timeout: ${label}`);
   await new Promise(done=>{notify=done;setTimeout(done,25);});
  }
 };
 return {
  send:value=>child.stdin.write(`${JSON.stringify(value)}\n`),
  next,
  end:()=>{child.stdin.end();child.kill();},
 };
}

/** The product's WebAssembly reader core with the same message protocol in memory. */
let nextId=1;
async function wasmHost(core,module,file){
 const bytes=readFileSync(file);
 const engine=core.createSheetEngine(module);
 const inbox=[];
 const waiters=[];
 const deliver=message=>{
  const index=waiters.findIndex(waiter=>waiter.match(message));
  if(index<0){inbox.push(message);return;}
  const [waiter]=waiters.splice(index,1);
  waiter.resolve(message);
 };
 const session=core.createReaderSession(engine,deliver,run=>setImmediate(run),()=>({rss:0,peak:0}));
 const next=async(predicate,label,timeout=READY_TIMEOUT_MS)=>{
  const index=inbox.findIndex(predicate);
  if(index>=0)return inbox.splice(index,1)[0];
  return await new Promise((resolvePromise,reject)=>{
   const waiter={match:predicate,resolve:message=>{clearTimeout(timer);resolvePromise(message);}};
   const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error(`wasm timeout: ${label}`));},timeout);
   waiters.push(waiter);
  });
 };
 for(let offset=0;offset<bytes.length;offset+=CHUNK){
  session.feed(new Uint8Array(bytes.subarray(offset,offset+CHUNK)));
  await next(message=>message.t==='fed','a fed credit');
 }
 return {
  session,
  next,
  feedDone:true,
  open:async format=>{
   session.open(format);
   const message=await next(value=>value.t==='opened'||value.t==='failed','the sheet list');
   return message;
  },
  rows:async request=>{
   const id=nextId++;
   session.rows(id,request);
   const message=await next(value=>value.t==='rows'&&value.id===id,'a rows reply');
   return message.reply;
  },
  end:()=>{session.memory();engine.close();},
 };
}

const formatOf=name=>{
 const extension=name.slice(name.lastIndexOf('.')+1).toLowerCase();
 return ['xlsx','xlsm'].includes(extension)?'xlsx':['xlsb','xls','ods'].includes(extension)?extension:undefined;
};

/** `progress` is the native host's load-thread callback and has no WebAssembly equivalent. */
const normalize=value=>{
 if(Array.isArray(value))return value.map(normalize);
 if(!value||typeof value!=='object')return value;
 const out={};
 for(const [key,entry] of Object.entries(value)){
  if(key==='progress')continue;
  out[key]=normalize(entry);
 }
 return out;
};

async function compareFixture(core,module,file){
 const name=file.split(/[\\/]/).pop();
 const format=formatOf(name);
 const native=nativeHost();
 const wasm=await wasmHost(core,module,file);
 const differences=[];
 const compare=(label,left,right)=>{
  const a=JSON.stringify(normalize(left)),b=JSON.stringify(normalize(right));
  if(a!==b)differences.push(`${name} ${label}: native ${a.slice(0,300)} vs wasm ${b.slice(0,300)}`);
 };
 try{
  // open
  native.send({method:'open',path:file,format});
  const nativeOpen=await native.next(value=>typeof value.ok==='boolean','the open reply');
  const wasmOpen=await wasm.open(format);
  const nativeOpened=nativeOpen.ok?normalize(nativeOpen.result):{error:nativeOpen.error};
  const wasmOpened=wasmOpen.t==='opened'?{sheets:normalize(wasmOpen.sheets)}:{error:wasmOpen.code};
  if(nativeOpened.error||wasmOpened.error)compare('open',nativeOpened,wasmOpened);
  else compare('sheets',nativeOpened.sheets,wasmOpened.sheets);
  if(nativeOpened.error||wasmOpened.error)return {name,format,replies:1,differences,error:nativeOpened.error??wasmOpened.error};

  let replies=1;
  /** One rows request on both hosts, polling until the sheet is ready (R12: polling is the contract).
   * Only the settled reply is compared: a `loading` reply carries the host's own notion of
   * progress and the native host's load thread may need one poll more or less than the
   * synchronous WebAssembly load, which is when a window is ready, not what it holds. */
  const rows=async request=>{
   let nativeReply,wasmReply,firstNative,firstWasm;
   for(let poll=0;poll<400;poll+=1){
    native.send({method:'rows',...request});
    const nativeMessage=await native.next(value=>typeof value.ok==='boolean','a rows reply');
    const wasmMessage=await wasm.rows(request);
    replies+=2;
    nativeReply=nativeMessage.ok?nativeMessage.result:{error:nativeMessage.error};
    wasmReply=wasmMessage.ok?wasmMessage.result:{error:wasmMessage.code};
    if(poll===0){firstNative=nativeReply;firstWasm=wasmReply;}
    const nativeLoading=nativeReply.state==='loading',wasmLoading=wasmReply.state==='loading';
    if(!nativeLoading&&!wasmLoading)break;
    await new Promise(done=>setTimeout(done,100));
   }
   compare(`rows ${JSON.stringify(request)}`,nativeReply,wasmReply);
   return {reply:nativeReply,first:firstNative,firstWasm};
  };

  const first=await rows({sheet:0,start:0,count:50});
  // Both hosts answer the very first window with `loading` and load the sheet afterwards.
  assert.equal(first.first?.state,'loading',`${name}: the native host answers loading first`);
  assert.equal(first.firstWasm?.state,'loading',`${name}: the wasm host answers loading first`);
  assert.equal(first.reply.state,'ready',`${name}: the first window settles`);
  const totalRows=first.reply.totalRows??0;
  const totalColumns=first.reply.totalColumns??0;
  await rows({sheet:0,start:0,count:500,columnStart:0,columnCount:200});
  await rows({sheet:0,start:1,count:37,columnStart:3,columnCount:10});
  if(totalRows>500){
   await rows({sheet:0,start:Math.floor((totalRows-500)/2),count:500,columnStart:0,columnCount:200});
   await rows({sheet:0,start:totalRows-500,count:500,columnStart:0,columnCount:200});
  }
  await rows({sheet:9,start:0,count:20});

  native.send({method:'close'});
  await native.next(value=>typeof value.ok==='boolean','the close reply');
  // The reader has no `close` command: the host ends the reader process (`design.md` §3.5).
  wasm.end();
  native.send({method:'rows',sheet:0,start:0,count:5});
  const afterClose=await native.next(value=>typeof value.ok==='boolean','a rows reply after close');
  compare('rows after close',afterClose.ok?afterClose.result:{error:afterClose.error},{error:'sheet_not_found'});
  return {name,format,replies,totalRows,totalColumns,differences};
 } finally{
  native.end();
  try{wasm.end();}catch{}
 }
}

try{
 const core=await loadReaderCore();
 const module=await core.loadSheetWasm(readFileSync(wasmFile));
 const listed=async folder=>existsSync(folder)?(await readdir(folder)).filter(name=>formatOf(name)).map(name=>({name,path:join(folder,name)})):[];
 const seen=new Set();
 const entries=[...await listed(fixtures),...await listed(committedFixtures)]
  .filter(entry=>!seen.has(entry.name)&&seen.add(entry.name)).sort((left,right)=>left.name.localeCompare(right.name));
 const names=entries.map(entry=>entry.name);
 assert.ok(names.length>0,`no workbook fixtures in ${fixtures} or ${committedFixtures}`);
 for(const {name,path} of entries){
  const started=Date.now();
  const outcome=await compareFixture(core,module,path);
  report.fixturesCompared[name]={...outcome,ms:Date.now()-started};
  if(outcome.differences.length)report.differences.push(...outcome.differences);
  console.log(`${outcome.differences.length?'DIFFERS':'IDENTICAL'} ${name} (${outcome.replies} replies, ${Date.now()-started} ms${outcome.error?`, ${outcome.error}`:''})`);
 }
 assert.deepEqual(report.differences,[],report.differences.join('\n'));
 check(`native and WebAssembly hosts returned identical replies for ${names.length} fixtures`);
 report.passed=true;
}catch(error){
 report.errors.push(error instanceof Error?error.stack??error.message:String(error));
 process.exitCode=1;
}finally{
 await mkdir(join(root,'qa/results'),{recursive:true});
 await writeFile(join(root,'qa/results/sheet-parity.json'),`${JSON.stringify(report,null,2)}\n`);
 await rm(scratch,{recursive:true,force:true});
 console.log(`${report.passed?'SHEET PARITY PASSED':'SHEET PARITY FAILED'}; report: qa/results/sheet-parity.json`);
}
