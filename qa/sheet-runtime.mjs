// Runtime-host regression for the Excel sheet core (task 11-10, step 1).
//
//   $env:TEMP="$env:TEMP\tt-qa-temp"; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to the worktree runtime executable>'
//   node qa/sheet-runtime.mjs
//
// Opens each 100 MiB fixture as a registered external file and inside a project, pages
// through it (first window, middle, far end), asserts values against the generator's own
// formula, and checks the helper and the runtime's private memory after `close`. The
// runtime is started with a two-second sheet idle time so the idle timeout is observable.
// It also checks that no request waits for a load (every poll answers quickly, also for
// another workbook), that a closed control connection ends its principal's helpers, and
// that loads report progress.
//
//   node qa/sheet-runtime.mjs --limit
//
// starts the runtime with a 128 MiB helper memory limit instead and checks that a
// workbook past it is `sheet_out_of_memory` for that handle only.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {link, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {connectPeer} from './pipe-client.mjs';

const root=resolve(import.meta.dirname,'..');
const runtime=resolve(process.env.THREADTERM_V3_RUNTIME_BIN??(()=>{throw Error('Set THREADTERM_V3_RUNTIME_BIN to this worktree runtime executable');})());
const scratchBase=resolve(process.env.TEMP??(()=>{throw Error('TEMP must point to the shared tt-qa-temp root');})());
assert.match(scratchBase.replaceAll('\\','/').toLowerCase(),/\/tt-qa-temp$/,'TEMP is the approved shared QA root');
assert.ok(existsSync(runtime),`missing runtime ${runtime}`);
const fixtures=resolve(scratchBase,'office-preview/fixtures');
const scratch=await mkdtemp(join(scratchBase,'tt-office-sheet-runtime-'));
const data=join(scratch,'data'),project=join(scratch,'project');
const pipe=`\\\\.\\pipe\\tt-office-sheet-${randomUUID()}`;
const idleSeconds=2;
const limitMode=process.argv.includes('--limit');
const limitMebibytes=128;
// A poll may wait for the pipe and the helper's answer, never for a load.
const POLL_BUDGET_MS=1000;

const report={passed:false,startedAt:new Date().toISOString(),runtime,scratch,checks:[],measurements:{},fixtures:{},errors:[],limitations:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));

function isolatedEnv(){
 const dropped=/^(path|temp|tmp|home|userprofile|codex_home|threadterm_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!dropped.test(key)));
 Object.assign(env,{TEMP:scratchBase,TMP:scratchBase,Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),
  HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),
  THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe});
 assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path'],'isolated environment has one PATH');
 return env;
}

// One PowerShell query per look: the helper list and the runtime's private bytes.
function powershell(script){
 try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}).trim();}catch{return '';}
}
function helperPids(runtimePid){
 const raw=powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${runtimePid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`);
 if(!raw)return [];
 const parsed=JSON.parse(raw);
 const list=Array.isArray(parsed)?parsed:[parsed];
 return list.filter(entry=>(entry.CommandLine??'').includes('--sheet-worker')).map(entry=>Number(entry.ProcessId));
}
function privateBytes(pid){
 const raw=powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PrivateMemorySize64`);
 const value=Number(raw);
 return Number.isFinite(value)&&value>0?value:null;
}
async function until(test,label,timeout=60_000){
 const deadline=Date.now()+timeout;
 for(;;){
  const value=await test();
  if(value)return value;
  if(Date.now()>deadline)throw Error(`Timed out: ${label}`);
  await delay(150);
 }
}

// The generator's own formula (gen_fixtures.py `num_cell_text`), so a window's text is
// compared with the workbook rather than with a recorded copy.
function numCellText(row,col){
 const m=(row*7919+col*104729)%1000003;
 const frac=(row*13+col*3)%4;
 const pad=(value,width)=>String(value).padStart(width,'0');
 if(m%11===0)return String(Math.trunc(m/3));
 if(frac===0)return String(m);
 if(frac===1)return `${Math.trunc(m/10)}.${m%10}`;
 if(frac===2)return `${Math.trunc(m/100)}.${pad(m%100,2)}`;
 return `-${Math.trunc(m/1000)}.${pad(m%1000,3)}`;
}
const ADJ=['amber','basal','cobalt','dense','early','faint','grand','hollow','inner','joint','keen','lucid','minor','north','open','prime','quiet','rough','solid','terse','upper','vivid','west','xenon','young','zonal'];
const NOUN=['anchor','bearing','cable','drum','engine','filter','gasket','housing','impeller','jacket','knuckle','latch','manifold','nozzle','orifice'];
function sstText(i){
 const tail=[...Array(i%23).keys()].map(k=>String.fromCharCode(97+((i*7+k*13)%26))).join('');
 return `${ADJ[i%ADJ.length]} ${NOUN[Math.trunc(i/ADJ.length)%NOUN.length]} batch ${String(i).padStart(7,'0')} ${tail}`;
}
function strCellText(row,col,ncols,nsst){return sstText(((row*ncols+col)*7919+row)%nsst);}

let daemon,peer,stderr='';
const peers=[];
async function connect(name){const socketPeer=await connectPeer(name);peers.push(socketPeer);return socketPeer;}

async function prepare(){
 await mkdir(data,{recursive:true});
 await mkdir(project,{recursive:true});
 // Hard links: no 300 MiB of copies, and the fixtures folder is untouched.
 for(const name of ['numbers-100.xlsx','strings-100.xlsx','sheets-10x10.xlsx','features.xlsx'])await link(join(fixtures,name),join(project,name));
 await mkdir(join(root,'qa/results'),{recursive:true});
 const args=['--sheet-idle-seconds',String(idleSeconds)];
 if(limitMode)args.push('--sheet-helper-memory-mib',String(limitMebibytes));
 daemon=spawn(runtime,args,{env:isolatedEnv(),windowsHide:true,stdio:['ignore','ignore','pipe']});
 daemon.stderr.on('data',bytes=>{stderr+=bytes;});
 const credential=await until(async()=>{
  try{return (await readFile(join(data,'runtime.credential'),'utf8')).trim();}catch{return null;}
 },'the runtime credential',30_000);
 peer=await until(async()=>{
  try{const candidate=await connect(`${pipe}-control`);await candidate.auth(credential);return candidate;}catch{return null;}
 },'the control pipe',30_000);
 return credential;
}

async function request(method,params={},timeout=120_000){return peer.request(method,params,timeout);}

/** Poll a window until it is ready; every poll is timed, and progress is collected. */
async function pollReady(handle,window,label,timeout=120_000,ask=request){
 const started=Date.now();
 let slowest=0;
 const progress=[];
 for(;;){
  const clock=Date.now();
  const reply=await ask('filesystem.sheet.rows',{handle,...window});
  slowest=Math.max(slowest,Date.now()-clock);
  if(reply.state==='ready')return {reply,ms:Date.now()-started,slowest,progress};
  if(typeof reply.progress==='number')progress.push(reply.progress);
  if(Date.now()-started>timeout)throw Error(`Timed out: ${label}`);
  await delay(120);
 }
}

/** Page a sheet: first window, a middle window and the far end. */
async function pageThrough(handle,name,label,expected){
 const polled=await pollReady(handle,{sheet:0,start:0,count:100},`${label}: first window`);
 const first=polled.reply,firstMs=polled.ms;
 assert.ok(polled.slowest<POLL_BUDGET_MS,`${label}: a poll waited ${polled.slowest} ms during the load`);
 const rising=polled.progress.every((value,index,list)=>value>=0&&value<=1&&(index===0||value>=list[index-1]));
 assert.ok(rising,`${label}: progress stays in 0..1 and never goes back`);
 assert.equal(first.totalRows,expected.rows,`${label}: totalRows`);
 assert.equal(first.totalColumns,expected.columns,`${label}: totalColumns`);
 const middleStart=Math.floor(first.totalRows/2);
 const middleClock=Date.now();
 const middle=await request('filesystem.sheet.rows',{handle,sheet:0,start:middleStart,count:500});
 const middleMs=Date.now()-middleClock;
 assert.equal(middle.state,'ready',`${label}: middle window`);
 assert.equal(middle.rows.length,500,`${label}: a loaded 500-row window`);
 const farStart=Math.max(0,first.totalRows-50);
 const far=await request('filesystem.sheet.rows',{handle,sheet:0,start:farStart,count:50});
 assert.equal(far.state,'ready',`${label}: far end`);
 assert.ok(far.rows.length>0,`${label}: the last rows hold data`);
 const values=expected.values(farStart,far.rows);
 for(const [rowIndex,columnIndex,text] of values){
  const cell=far.rows[rowIndex]?.[columnIndex];
  // Numbers, dates, booleans and errors are `[text, kind]`; text cells are bare strings.
  const shown=Array.isArray(cell)?cell[0]:cell;
  assert.equal(shown,text,`${label}: cell at ${farStart+rowIndex}:${columnIndex}`);
 }
 report.measurements[label]={firstWindowMs:firstMs,middleWindowMs:middleMs,slowestPollMs:polled.slowest,progressSamples:polled.progress.length,lastProgress:polled.progress.at(-1)??null,totalRows:first.totalRows,totalColumns:first.totalColumns,bytes:expected.bytes};
 check(`${label}: first window ${firstMs} ms, 500-row window ${middleMs} ms, ${first.totalRows}x${first.totalColumns}; slowest poll ${polled.slowest} ms, ${polled.progress.length} progress values`);
 return {firstMs,middleMs,totalRows:first.totalRows};
}

async function closeAndCheck(handle,label,pid){
 const baseline=privateBytes(pid);
 await request('filesystem.sheet.close',{handle});
 const gone=await until(async()=>helperPids(pid).length===0,'the helper to exit after close',5_000).catch(()=>false);
 assert.ok(gone,`${label}: the helper is gone within 5 s of close`);
 const after=privateBytes(pid);
 if(baseline&&after){
  const growth=after-baseline;
  report.measurements[`${label}-runtimeMemory`]={before:baseline,after,growthBytes:growth};
  assert.ok(growth<=10*1024*1024,`${label}: runtime private memory grew ${(growth/1048576).toFixed(1)} MiB`);
  check(`${label}: helper gone within 5 s; runtime private memory ${(growth/1048576).toFixed(1)} MiB`);
 }else{
  report.limitations.push(`${label}: runtime private memory unavailable`);
  check(`${label}: helper gone within 5 s (runtime memory unavailable)`);
 }
}

const EXPECTED={
 'numbers-100.xlsx':{rows:727044,columns:20,bytes:103688072,values:(start,rows)=>[[0,0,numCellText(start,0)],[0,1,numCellText(start,1)],[7,19,numCellText(start+7,19)]]},
 'strings-100.xlsx':{rows:802851,columns:12,bytes:102511372,values:(start,rows)=>[[0,0,strCellText(start,0,12,7325569)],[3,11,strCellText(start+3,11,12,7325569)]]},
 'sheets-10x10.xlsx':{rows:103156,columns:14,bytes:103529998,values:(start,rows)=>[[0,0,numCellText(start,0)],[2,13,numCellText(start+2,13)]]},
};

/** No request waits for another workbook's load. */
async function otherWorkbookStaysResponsive(projectId){
 const small=await request('filesystem.sheet.open',{projectId,path:'features.xlsx'});
 await pollReady(small.handle,{sheet:0,start:4,count:1},'the small fixture',30_000);
 const large=await request('filesystem.sheet.open',{projectId,path:'numbers-100.xlsx'});
 const first=await request('filesystem.sheet.rows',{handle:large.handle,sheet:0,start:0,count:50});
 assert.equal(first.state,'loading','the large workbook starts loading');
 let slowest=0,asked=0,progressSeen=false;
 for(;;){
  const clock=Date.now();
  const other=await request('filesystem.sheet.rows',{handle:small.handle,sheet:0,start:4,count:1});
  slowest=Math.max(slowest,Date.now()-clock);
  asked++;
  assert.equal(other.state,'ready');
  const window=await request('filesystem.sheet.rows',{handle:large.handle,sheet:0,start:0,count:50});
  if(typeof window.progress==='number'&&window.progress>0)progressSeen=true;
  if(window.state==='ready')break;
  await delay(100);
 }
 assert.ok(slowest<POLL_BUDGET_MS,`another workbook waited ${slowest} ms during a load`);
 assert.ok(progressSeen,'the 100 MiB load reported progress');
 report.measurements.otherWorkbookDuringLoad={requests:asked,slowestMs:slowest};
 check(`another workbook answered ${asked} windows during a 100 MiB load, slowest ${slowest} ms; the load reported progress`);
 await request('filesystem.sheet.close',{handle:large.handle});
 await request('filesystem.sheet.close',{handle:small.handle});
}

/** A handle belongs to its principal; the principal's last connection takes it along. */
async function connectionCloseEndsHelpers(credential,projectId,runtimePid){
 const owner=await connect(`${pipe}-control`);
 const ownerId=await owner.auth(credential);
 const opened=await owner.request('filesystem.sheet.open',{projectId,path:'features.xlsx'},60_000);
 await pollReady(opened.handle,{sheet:0,start:4,count:1},'the owner connection',30_000,(method,params)=>owner.request(method,params,60_000));
 await assert.rejects(request('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:0,count:10}),/sheet_not_found/);
 assert.equal(helperPids(runtimePid).length,1,'one helper for the owner');
 owner.close();
 const gone=await until(async()=>helperPids(runtimePid).length===0,'the helper to exit after the connection closed',5_000).catch(()=>false);
 assert.ok(gone,'the helper ends within 5 s of its connection closing');
 const again=await connect(`${pipe}-control`);
 await again.auth(credential,ownerId);
 await assert.rejects(again.request('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:0,count:10},30_000),/sheet_not_found/);
 again.close();
 check('another principal gets sheet_not_found; closing the owner connection ends its helper and its handle');
}

/** `--limit`: past the helper memory limit, that handle fails and the next one works. */
async function memoryLimit(projectId,runtimePid){
 // The limit may stop the helper while it opens the workbook or while it loads the sheet.
 let large=null;
 const outcome=await request('filesystem.sheet.open',{projectId,path:'numbers-100.xlsx'})
  .then(opened=>{large=opened;return pollReady(opened.handle,{sheet:0,start:0,count:50},'the limited load',120_000);})
  .then(()=>'ready',error=>String(error?.message??error));
 assert.match(outcome,/sheet_out_of_memory/,`a load past ${limitMebibytes} MiB is sheet_out_of_memory (got ${outcome})`);
 check(`a load past the ${limitMebibytes} MiB helper limit answers sheet_out_of_memory`);
 const small=await request('filesystem.sheet.open',{projectId,path:'features.xlsx'});
 const loaded=await pollReady(small.handle,{sheet:0,start:4,count:1},'a small workbook after the limit stop',30_000);
 assert.equal(loaded.reply.rows[0]?.[2]?.[0],'42');
 await request('filesystem.sheet.close',{handle:small.handle});
 if(large)await request('filesystem.sheet.close',{handle:large.handle});
 const gone=await until(async()=>helperPids(runtimePid).length===0,'all helpers to exit',5_000).catch(()=>false);
 assert.ok(gone,'no helper is left after close');
 check('the stop is an error for that handle only: the next workbook loads and both close cleanly');
}

async function main(){
 const credential=await prepare();
 const runtimePid=daemon.pid;
 const project_=await request('project.add',{path:project,name:'Office sheet QA',operationId:randomUUID()});
 check('runtime, project and control pipe are up');
 if(limitMode){
  await memoryLimit(project_.id,runtimePid);
  return;
 }
 await otherWorkbookStaysResponsive(project_.id);
 await connectionCloseEndsHelpers(credential,project_.id,runtimePid);

 for(const [name,expected] of Object.entries(EXPECTED)){
  const path=join(project,name);
  // As a registered external file.
  const registered=await request('filesystem.external.open',{path,source:'dialog'});
  const openedAt=Date.now();
  const workbook=await request('filesystem.external.sheet.open',{id:registered.file.id});
  const openMs=Date.now()-openedAt;
  assert.equal(workbook.size,expected.bytes,`${name}: size`);
  assert.match(workbook.handle,/^[0-9a-f]{32}$/);
  assert.ok(workbook.sheets.length>=1);
  assert.equal(workbook.sheets[0].visible,true);
  if(name==='sheets-10x10.xlsx')assert.equal(workbook.sheets.length,10);
  report.fixtures[name]={openMs,...(await pageThrough(workbook.handle,name,`${name} (external)`,expected))};
  check(`${name}: open ${openMs} ms over ${workbook.sheets.length} sheet(s)`);
  await closeAndCheck(workbook.handle,`${name} (external)`,runtimePid);
  await request('filesystem.external.forget',{id:registered.file.id,operationId:randomUUID()});

  // Inside the project, through the FileScope path.
  const inProject=await request('filesystem.sheet.open',{projectId:project_.id,path:name});
  const first=await request('filesystem.sheet.rows',{handle:inProject.handle,sheet:0,start:0,count:50});
  assert.ok(['loading','ready'].includes(first.state),`${name}: in-project first window`);
  const loaded=await until(async()=>{
   const window=await request('filesystem.sheet.rows',{handle:inProject.handle,sheet:0,start:0,count:50});
   return window.state==='ready'?window:null;
  },`${name}: in-project load`,90_000);
  assert.equal(loaded.totalRows,expected.rows,`${name}: in-project totalRows`);
  await closeAndCheck(inProject.handle,`${name} (project)`,runtimePid);
 }

 // Idle: the helper ends by itself and the next window starts a new one.
 const idleOpen=await request('filesystem.sheet.open',{projectId:project_.id,path:'features.xlsx'});
 const idleLoaded=await until(async()=>{
  const window=await request('filesystem.sheet.rows',{handle:idleOpen.handle,sheet:0,start:4,count:1});
  return window.state==='ready'?window:null;
 },'the small fixture to load',30_000);
 assert.equal(idleLoaded.rows[0]?.[2]?.[0],'42');
 const idleAt=Date.now();
 await until(async()=>helperPids(runtimePid).length===0,`the helper to idle out after ${idleSeconds} s`,10_000);
 report.measurements.idleMs=Date.now()-idleAt-idleSeconds*1000;
 check(`an idle helper ends ${report.measurements.idleMs} ms after the ${idleSeconds} s idle time`);
 const restarted=await request('filesystem.sheet.rows',{handle:idleOpen.handle,sheet:0,start:4,count:1});
 assert.ok(['loading','ready'].includes(restarted.state),'the next window starts a new helper');
 await until(async()=>{
  const window=await request('filesystem.sheet.rows',{handle:idleOpen.handle,sheet:0,start:4,count:1});
  return window.state==='ready'?window:null;
 },'the reload after the idle timeout',30_000);
 check('a window after the idle timeout reloads the workbook');

 // A wrong handle is sheet_not_found, and close is idempotent.
 await request('filesystem.sheet.close',{handle:idleOpen.handle});
 await request('filesystem.sheet.close',{handle:idleOpen.handle});
 await assert.rejects(request('filesystem.sheet.rows',{handle:idleOpen.handle,sheet:0,start:0,count:10}),/sheet_not_found/);
 check('close is idempotent and the forgotten handle answers sheet_not_found');

 // The size cap is checked from metadata, before anything is read.
 const tooLarge=join(project,'too-large.xlsx');
 await writeFile(tooLarge,Buffer.alloc(100*1024*1024+1));
 const largeRegistered=await request('filesystem.external.open',{path:tooLarge,source:'dialog'});
 await assert.rejects(request('filesystem.external.sheet.open',{id:largeRegistered.file.id}),/file_too_large/);
 check('a 100 MiB + 1 byte workbook is refused with file_too_large');
 await rm(tooLarge,{force:true});
}

try{
 await main();
 report.passed=true;
 console.log('\n'+JSON.stringify({passed:report.passed,measurements:report.measurements,fixtures:report.fixtures},null,2));
 await writeFile(join(root,`qa/results/sheet-runtime${limitMode?'-limit':''}.json`),JSON.stringify(report,null,2));
}catch(error){
 report.errors.push(String(error?.stack??error));
 console.error(error);
 if(stderr)console.error(stderr);
 await writeFile(join(root,`qa/results/sheet-runtime${limitMode?'-limit':''}.json`),JSON.stringify(report,null,2));
 process.exitCode=1;
}finally{
 for(const item of peers)item.close();
 if(daemon&&daemon.exitCode===null){
  try{await request('runtime.shutdown',{operationId:randomUUID()},10_000);}catch{}
  await delay(500);
  if(daemon.exitCode===null)daemon.kill();
 }
 await rm(scratch,{recursive:true,force:true}).catch(()=>{});
}
