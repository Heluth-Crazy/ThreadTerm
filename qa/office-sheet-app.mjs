// Real-app regression probe for the Excel sheet preview (task 11-10, steps 2 and 3).
//
//   $env:TEMP="$env:TEMP\tt-qa-temp"; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to the worktree runtime executable>'
//   node qa/office-sheet-app.mjs [--backend main]
//
// Opens a project workbook from the Explorer and another as a registered external file, checks
// the sheet tabs (including hidden sheets), the used range that starts at C5, scrolling and go-to
// at the far end of a 100 MiB sheet (R12: 300 ms in a loaded sheet), copy as TSV, and that closing
// the tab ends the runtime's `--sheet-worker` helper within 5 s. Screenshots land in
// qa/results/office-sheet/. Fixtures are hard-linked into the scratch project, never modified.
//
// `--backend main` selects Local file access = main first and repeats the same run against the
// WebAssembly reader (task 11-10 step 3): no `--sheet-worker` may start (R22), the reader process
// must be gone within 5 s of closing, the main process must come back within 30 MB and stay under
// 200 MiB, the main-mode time budgets in validation.md must hold, and switching the setting with a
// workbook open must reload cleanly. Reports: qa/results/office-sheet[-main]/report.json.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile,link,mkdir,mkdtemp,open as openFile,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';
import {buildQaApp} from './lib/qa-app.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const runtime=resolve(process.env.THREADTERM_V3_RUNTIME_BIN??(()=>{throw Error('Set THREADTERM_V3_RUNTIME_BIN to this worktree runtime executable');})());
const scratchBase=resolve(process.env.TEMP??(()=>{throw Error('TEMP must point to the shared tt-qa-temp root');})());
assert.match(scratchBase.replaceAll('\\','/').toLowerCase(),/\/tt-qa-temp$/,'TEMP is the approved shared QA root');
assert.ok(existsSync(runtime),`missing runtime ${runtime}`);
const backendIndex=process.argv.indexOf('--backend');
const backend=backendIndex<0?'runtime':process.argv[backendIndex+1];
assert.ok(['runtime','main'].includes(backend),'--backend takes runtime or main');
// The WebAssembly reader needs the module the build script writes (`npm run build:sheet-wasm`).
const sheetWasm=process.env.THREADTERM_SHEET_WASM??join(root,'desktop-dist/sheet-core.wasm');
if(backend==='main')assert.ok(existsSync(sheetWasm),`missing ${sheetWasm}; run npm run build:sheet-wasm`);
const fixtures=resolve(scratchBase,'office-preview/fixtures');
const scratch=await mkdtemp(join(scratchBase,`tt-office-sheet-app-${backend}-`));
const project=join(scratch,'project'),outside=join(scratch,'outside'),appDir=join(scratch,'app');
const out=join(root,backend==='main'?'qa/results/office-sheet-main':'qa/results/office-sheet');
// Main-mode budgets (validation.md, spike C decision 7).
const BUDGETS={numbersFirstWindowMs:10_000,loadedWindowMs:150,sheetsFirstWindowMs:3_000,stringsFirstWindowMs:25_000,mainDeltaMiB:30,mainPeakMiB:200,rendererDeltaMiB:30,runtimeDeltaMiB:10};
const hiddenRelease=process.argv.includes('--hidden-release');
const openAppRecord=join(scratch,'open-file-app.jsonl');
const report={passed:false,backend,startedAt:new Date().toISOString(),runtime,scratch,sheetWasm:backend==='main'?sheetWasm:undefined,checks:[],screenshots:[],measurements:{},budgets:BUDGETS,errors:[],limitations:[
 hiddenRelease?'':'The 5-minute hidden-tab release (R5) was not waited for in this run; pass --hidden-release to run it.',
 backend==='runtime'?'Only the Runtime read method runs here; run with --backend main for step 3.':'Only the main read method runs here; the runtime run is the sibling invocation.',
 'Merged cells and find-in-sheet are left out of step 2 (merged-cell parsing measured over the gate in step 1; find needs a core method).',
 'The reader reports no progress number in main mode: a WebAssembly load is synchronous and cannot call back mid-load (design.md §3.1).',
]};
let app,page,releaseLock,cleanupApp,mainPid;
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const request=(method,params={})=>page.evaluate(([name,value])=>window.threadterm.request(name,value),[method,params]);
const visible=selector=>page.locator(`.ws-pane.selected .pane-tab-surface:not([hidden]) ${selector}`);
const surfaces=()=>page.locator('.ws-pane.selected .pane-tab-surface:not([hidden])');
const shot=async name=>{await page.screenshot({path:join(out,name)});report.screenshots.push(join(out,name).replaceAll('\\','/'));};
async function until(test,label,timeout=60_000){const deadline=Date.now()+timeout;for(;;){try{const value=await test();if(value)return value;}catch{}if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await delay(100);}}

// The generator's own formula (gen_fixtures.py `num_cell_text`), so a visible cell is compared with
// the workbook rather than with a recorded copy.
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

function powershell(script){
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:30_000});
 return {ok:result.status===0,text:(result.stdout??'').trim(),error:String(result.stderr??'')};
}
/** `--sheet-worker` helpers of the runtime this app started, found in one query.
 * Returns `undefined` when the query itself failed, so a probe never mistakes a failed
 * PowerShell call for "no helpers". */
function sheetWorkers(){
 const {ok,text,error}=powershell(`$main=${mainPid}
$workers=New-Object System.Collections.ArrayList
foreach($r in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$main" -ErrorAction Stop)){
 if($r.Name -notlike '*threadterm-v3-runtime*'){continue}
 foreach($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($r.ProcessId)" -ErrorAction Stop)){
  if($c.CommandLine -like '*--sheet-worker*'){[void]$workers.Add([int]$c.ProcessId)}
 }
}
ConvertTo-Json -InputObject @($workers.ToArray()) -Compress`);
 if(!ok)return undefined;
 try{const parsed=JSON.parse(text);return Array.isArray(parsed)?parsed:(typeof parsed==='number'?[parsed]:[]);}catch{return undefined;}
}

/** The sheet readers of the app: a utility process Electron names after its service. The Windows
 * command line of a utility process carries no script path, so `getAppMetrics` is the reliable
 * handle; the reader's memory is read from the OS by pid (Electron under-reports it). */
const readers=()=>app.evaluate(({app:electronApp})=>electronApp.getAppMetrics()
 .filter(entry=>entry.name==='ThreadTerm sheet reader')
 .map(entry=>entry.pid));
/** A reader's working set and peak, read from the OS (the reader's own report arrives on main's stdout). */
function readerMemory(pid){
 const {ok,text}=powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if($p){ConvertTo-Json -Compress -InputObject @{workingSet=[math]::Round($p.WorkingSet64/1MB,1);peak=[math]::Round($p.PeakWorkingSet64/1MB,1)}}else{'null'}`);
 if(!ok||!text||text==='null')return undefined;
 try{return JSON.parse(text);}catch{return undefined;}
}
/** The main process's own memory, as Electron reports the Browser process (KiB). */
const mainMemory=()=>app.evaluate(({app:electronApp})=>{
 const browser=electronApp.getAppMetrics().find(entry=>entry.type==='Browser');
 return browser?.memory??null;
});
const mib=kilobytes=>Math.round(((kilobytes??0)/1024)*10)/10;
/** The app renderer's process id (its WebContents), then its private memory from the OS. */
const rendererPid=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(candidate=>!candidate.isDestroyed())?.webContents.getOSProcessId()??0);
const rendererMiB=async()=>privateMemory(await rendererPid());
/** The local runtime process this app started. */
function runtimePid(){
 const {ok,text}=powershell(`$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" -ErrorAction SilentlyContinue | Where-Object {$_.Name -like '*threadterm-v3-runtime*'} | Select-Object -First 1
if($p){[int]$p.ProcessId}else{0}`);
 return ok&&/^\d+$/.test(text)&&Number(text)>0?Number(text):undefined;
}
function privateMemory(pid){
 const {ok,text}=powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if($p){[math]::Round($p.PrivateMemorySize64/1MB,1)}else{'null'}`);
 return ok&&text!=='null'&&text!==''&&Number.isFinite(Number(text))?Number(text):0;
}
const memorySnapshot=async()=>({renderer:await rendererMiB(),runtime:privateMemory(runtimePid()??0)});
const openAppRecords=async()=>{try{return (await readFile(openAppRecord,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};
const resetOpenAppRecords=()=>writeFile(openAppRecord,'');
/** A 500-row window timed inside the app renderer, so the figure is the wire method (renderer IPC →
 * main → reader → back) and not Playwright's own marshalling of the reply. */
async function loadedWindowTiming(projectId,name,rowStart){
 return await page.evaluate(async ([projectId,name,rowStart])=>{
  const call=(method,params)=>window.threadterm.request(method,params);
  const opened=await call('filesystem.sheet.open',{projectId,path:name});
  try{
   const started=performance.now();
   let reply=await call('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:rowStart,count:500});
   while(reply.state==='loading'&&performance.now()-started<180_000){
    await new Promise(done=>setTimeout(done,100));
    reply=await call('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:rowStart,count:500});
   }
   const loadMs=Math.round(performance.now()-started);
   const samples=[];
   for(let attempt=0;attempt<7;attempt+=1){
    const before=performance.now();
    const window=await call('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:rowStart,count:500,columnStart:0,columnCount:20});
    samples.push(Math.round((performance.now()-before)*10)/10);
    if(!Array.isArray(window.rows)||window.rows.length===0)throw Error('a loaded 500-row window returned no rows');
   }
   return {loadMs,samples,totalRows:reply.totalRows};
  }finally{await call('filesystem.sheet.close',{handle:opened.handle}).catch(()=>{});}
 },[projectId,name,rowStart]);
}
/** `open` plus the first ready window, timed inside the app renderer: the host-mode budget figure
 * (validation.md: numbers-100 first window, sheets-10x10 first window), free of UI noise. */
async function hostFirstWindow(projectId,name,columnCount=20){
 return await page.evaluate(async ([projectId,name,columnCount])=>{
  const call=(method,params)=>window.threadterm.request(method,params);
  const started=performance.now();
  const opened=await call('filesystem.sheet.open',{projectId,path:name});
  try{
   const openMs=Math.round(performance.now()-started);
   let reply=await call('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:0,count:50,columnStart:0,columnCount});
   while(reply.state==='loading'&&performance.now()-started<180_000){
    await new Promise(done=>setTimeout(done,100));
    reply=await call('filesystem.sheet.rows',{handle:opened.handle,sheet:0,start:0,count:50,columnStart:0,columnCount});
   }
   if(reply.state!=='ready')throw Error('the first window never became ready');
   return {openMs,firstWindowMs:Math.round(performance.now()-started),totalRows:reply.totalRows};
  }finally{await call('filesystem.sheet.close',{handle:opened.handle}).catch(()=>{});}
 },[projectId,name,columnCount]);
}

const setBackend=mode=>page.evaluate(async value=>window.threadterm.localFiles?.setBackend(value),mode);

async function prepare(){
 await Promise.all([mkdir(project,{recursive:true}),mkdir(outside,{recursive:true}),mkdir(out,{recursive:true})]);
 // Hard links: no 300 MiB of copies, and the fixtures folder keeps its bytes.
 for(const name of ['features.xlsx','sheets-10x10.xlsx','numbers-100.xlsx','date.xls','any_sheets.xlsb','any_sheets.ods','special_cells.ods','truncated.xlsx','features-encrypted.xlsx'])await link(join(fixtures,name),join(project,name));
 await link(join(fixtures,'strings-100.xlsx'),join(outside,'strings-100.xlsx'));
 // Mutable copies for the changed-while-open case, and the wrong extension for an OLE2 workbook.
 await copyFile(join(fixtures,'sheets-10x10.xlsx'),join(project,'changed.xlsx'));
 await copyFile(join(fixtures,'password_protected.xls'),join(project,'protected-wrong.xlsx'));
 await writeFile(join(project,'evil.exe'),'not a document');
 await writeFile(openAppRecord,'');
 // 100 MiB + 1 byte: a sparse file is enough, because the size is checked before any content read.
 const over=await openFile(join(project,'numbers-100-over.xlsx'),'w');try{await over.truncate(100*1024*1024+1);}finally{await over.close();}
 ({cleanup:cleanupApp}=await buildQaApp({root,outDir:appDir}));
}
function environment(){
 const dropped=/^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!dropped.test(key)));
 Object.assign(env,{Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),TEMP:scratchBase,TMP:scratchBase,
  HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),CODEX_HOME:join(scratch,'home','.codex'),
  THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-office-sheet-${randomUUID()}`,
  THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,
  THREADTERM_V3_OPEN_FILE_APP_QA:openAppRecord,
  ...(backend==='main'?{THREADTERM_SHEET_WASM:sheetWasm}:{}),
  THREADTERM_V3_OPEN_EXTERNAL_QA:JSON.stringify([join(outside,'strings-100.xlsx')])});
 assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path'],'isolated environment has one PATH');
 return env;
}

const sheet=()=>visible('.sheet-view');
const attribute=async name=>await sheet().getAttribute(name);
const cellText=(row,column)=>page.evaluate(([row,column])=>{
 const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
 return view?.querySelector(`.sheet-cell[data-row="${row}"][data-column="${column}"]`)?.textContent??null;
},[row,column]);
const cellAlign=(row,column)=>page.evaluate(([row,column])=>{
 const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
 const cell=view?.querySelector(`.sheet-cell[data-row="${row}"][data-column="${column}"]`);
 return cell?getComputedStyle(cell).justifyContent:null;
},[row,column]);
const sheetSurfaces=()=>page.evaluate(()=>[...document.querySelectorAll('.sheet-view')].map(view=>({path:view.getAttribute('data-file-path'),hidden:Boolean(view.closest('[hidden]')),rows:view.getAttribute('data-total-rows')})));

async function waitSheetLoaded(name,timeout=240_000){
 await page.waitForFunction(name=>{
  const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
  const path=(view?.getAttribute('data-file-path')??'').replaceAll('\\','/');
  return (path===name||path.endsWith('/'+name))&&view.getAttribute('aria-busy')==='false'&&Number(view.getAttribute('data-total-rows'))>0;
 },name,{timeout});
 await sheet().waitFor({timeout:20_000});
}
async function openProjectSheet(name){
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const row=page.locator(`.wb-tree [data-path="${name}"]`).first();await row.waitFor({timeout:60_000});
 const started=performance.now();await row.click();
 await waitSheetLoaded(name);
 return Math.round(performance.now()-started);
}
async function activateTab(name){
 const tab=page.getByRole('tab',{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).first();
 await tab.click();
 await waitSheetLoaded(name);
}
async function closeActiveTab(){
 await page.locator('.ws-pane.selected .workspace-tab.active .workspace-tab-close').click();
 await until(async()=>await sheet().count()===0,'the sheet view to unmount',10_000);
}
async function waitNoWorkers(label,timeout=6_000){
 const started=Date.now();
 let last;
 const gone=await until(()=>{const workers=sheetWorkers();if(!workers)return false;last=workers;return workers.length===0;},label,timeout).then(()=>true).catch(()=>false);
 return {gone,ms:Date.now()-started,remaining:gone?0:(last?.length??-1),pids:last??[]};
}
/** Scroll (and keep nudging) until `row` is painted, or report the view text. Used after a Local
 * file access switch, where the view must reopen once and then serve the new window. */
const forceWindow=row=>page.evaluate(async row=>{
 const view=()=>document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
 const deadline=performance.now()+120_000;
 let nudges=0;
 for(;;){
  const v=view();
  if(!v)return {ok:false,reason:'no sheet view'};
  const cell=v.querySelector(`.sheet-cell[data-row="${row}"]`);
  if(cell&&cell.textContent)return {ok:true,text:cell.textContent};
  const grid=v.querySelector('.sheet-grid');
  if(grid){
   const sample=grid.querySelector('.sheet-row');
   const rowHeight=sample?.getBoundingClientRect().height||24;
   const target=Math.min(Math.round(row*rowHeight),grid.scrollHeight);
   if(Math.abs(grid.scrollTop-target)>1||nudges%8===0)grid.scrollTop=target;
   nudges+=1;
  }
  if(performance.now()>deadline)return {ok:false,reason:(v.innerText??'').slice(0,300)};
  await new Promise(done=>setTimeout(done,250));
 }
},row);

/** Time from a scroll assignment to the first painted cell of `row` (R12). */
async function scrollToBottomAndTime(row){
 return await page.evaluate(async row=>{
  const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
  const grid=view?.querySelector('.sheet-grid');if(!grid)return{ms:-1,text:null};
  const started=performance.now();
  grid.scrollTop=grid.scrollHeight;
  const deadline=started+10_000;
  return await new Promise(done=>{
   const tick=()=>{
    const text=view.querySelector(`.sheet-cell[data-row="${row}"]`)?.textContent??'';
    if(text)return done({ms:performance.now()-started,text});
    if(performance.now()>deadline)return done({ms:-1,text:null});
    requestAnimationFrame(tick);
   };
   requestAnimationFrame(tick);
  });
 },row);
}
async function goToAndTime(target,row,column){
 const input=visible('[data-testid="sheet-goto"]');
 await input.fill(target);
 const started=performance.now();
 await input.press('Enter');
 const text=await page.evaluate(async ([row,column])=>{
  const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
  const deadline=performance.now()+10_000;
  for(;;){
   const value=view?.querySelector(`.sheet-cell[data-row="${row}"][data-column="${column}"]`)?.textContent??'';
   if(value)return value;
   if(performance.now()>deadline)return null;
   await new Promise(done=>requestAnimationFrame(done));
  }
 },[row,column]);
 return {ms:text?performance.now()-started:-1,text};
}
async function theme(language,tone){
 const state=await request('runtime.snapshot');
 await request('settings.update',{patch:{language,theme:tone,themeSelection:`preset:threadterm-${tone}`},expectedRevision:state.settings.revision,operationId:randomUUID()});
 await page.waitForFunction(next=>document.documentElement.lang===next,language);
 await delay(300);
}

try{
 await prepare();releaseLock=await acquireElectronQaLock({directory:scratchBase});
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:environment(),timeout:60_000});
 page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(30_000);
 mainPid=await app.evaluate(()=>process.pid);
 page.on('pageerror',error=>report.errors.push(`pageerror: ${error.message}`));
 page.on('console',message=>{if(message.type()==='error')report.errors.push(`console: ${message.text()}`);});
 await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60_000});
 const added=await request('project.add',{path:project,name:'Office sheet QA',operationId:randomUUID()});
 const projectId=added.id;
 const session=await request('session.create',{projectId:added.id,cwd:project,provider:'grok',mode:'chat',title:'Sheet preview QA',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor();
 await request('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.ws-pane.selected').waitFor({state:'visible',timeout:45_000});
 assert.equal(await setBackend(backend),backend,`Local file access is ${backend}`);
 if(backend==='main'){
  report.measurements.readersAfterSwitch=await readers();
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'main mode starts no runtime helper');
  report.measurements.mainBeforeMiB=mib((await mainMemory())?.privateBytes);
 }

 await theme('en','light');
 assert.deepEqual(sheetWorkers()??['unavailable'],[],'no sheet helper before any workbook opens');
 assert.deepEqual(backend==='main'?await readers():[], [], 'no sheet reader before any workbook opens');

 // features.xlsx: two sheets, the second hidden and marked; the used range starts at C5.
 report.measurements.featuresOpenMs=await openProjectSheet('features.xlsx');
 report.measurements.workersAfterFeaturesOpen=sheetWorkers();
 report.measurements.surfacesAfterFeaturesOpen=await sheetSurfaces();
 if(backend==='main'){
  report.measurements.readersAfterFeaturesOpen=await readers();
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'main mode starts no --sheet-worker helper (R22)');
  assert.equal((await readers()).length,1,'one WebAssembly reader for the open workbook');
 }
 assert.equal(await attribute('data-total-rows'),'13','the used range ends on row 13');
 assert.equal(await attribute('data-total-columns'),'6','the used range ends on column F');
 assert.equal(await visible('[data-testid="sheet-tab"]').count(),2,'both sheets are in the tab row');
 const hiddenTab=visible('[data-testid="sheet-tab"]').nth(1);
 assert.equal(await hiddenTab.getAttribute('data-sheet-visible'),'false','the hidden sheet sorts last and is marked');
 assert.match(await hiddenTab.innerText(),/hidden-Rates[\s\S]*Hidden/,'the hidden tab is labelled');
 assert.equal(await cellText(4,2),'42','C5 holds 42 with real row and column coordinates');
 assert.equal(await cellText(4,3),'Used range starts here','D5 keeps its text');
 assert.equal(await visible('.sheet-row-head').filter({hasText:/^5$/}).count(),1,'row number 5 is shown for sheet row 5');
 assert.equal(await visible('.sheet-col-label').filter({hasText:/^C$/}).count(),1,'column letter C is shown');
 assert.match(await visible('[data-testid="sheet-used-range"]').textContent(),/13 rows × 6 columns/,'the sheet size is shown');
 assert.match(await visible('[data-testid="sheet-file-size"]').textContent(),/^\d+(\.\d)? KiB$/,'a small file size reads in KiB');
 await shot('en-light-features.png');
 await theme('zh-CN','dark');
 await shot('zh-dark-features.png');
 await theme('en','light');
 check('features.xlsx: two tabs with the hidden sheet last and marked, C5 addressed as C5, used range 13 x 6 and file size shown');

 // R20: the system-app IPC opens only allow-listed files inside their scope; the QA seam records
 // the path instead of starting Excel.
 await resetOpenAppRecords();
 await page.evaluate(([projectId,path])=>window.threadterm.openFileDefaultApp({projectId,path}),[projectId,'features.xlsx']);
 await until(async()=>(await openAppRecords()).length===1,'the project file system-app record');
 let appRecords=await openAppRecords();
 assert.equal(appRecords[0].path.toLowerCase(),join(project,'features.xlsx').toLowerCase(),'the project workbook path is the one that would open');
 const externalOpen=await request('filesystem.external.open',{path:join(outside,'strings-100.xlsx'),source:'recent'});
 assert.ok('file' in externalOpen,'the external fixture is registered');
 await page.evaluate(id=>window.threadterm.openFileDefaultApp({externalId:id}),externalOpen.file.id);
 appRecords=await until(async()=>{const values=await openAppRecords();return values.length===2?values:null;},'the external file system-app record');
 assert.equal(appRecords[1].path.toLowerCase(),join(outside,'strings-100.xlsx').toLowerCase(),'the registered external workbook path is the one that would open');
 await assert.rejects(page.evaluate(([projectId,path])=>window.threadterm.openFileDefaultApp({projectId,path}),[projectId,'evil.exe']),/system app/i,'an executable is refused');
 await assert.rejects(page.evaluate(([projectId,path])=>window.threadterm.openFileDefaultApp({projectId,path}),[projectId,'../outside/strings-100.xlsx']),/outside its project scope/i,'a path outside the project is refused');
 await assert.rejects(page.evaluate(()=>window.threadterm.openFileDefaultApp({externalId:'not-a-registration'})),/external_file_unknown|unknown/i,'an unknown registration is refused');
 await shot('en-light-system-app-action.png');
 check('Open with system app opens only an allow-listed project or registered external file; executables and escapes are refused');

 // Number formats and dates come from the core; alignment follows the cell kind (R13, R16).
 assert.equal(await cellText(6,2),'2023-03-15','a date cell renders YYYY-MM-DD');
 assert.match(await cellText(6,3),/^2023-03-15 12:30:00$/,'a date-time adds HH:MM:SS when it is not midnight');
 assert.equal(await cellText(7,2),'18.75%','a percent cell keeps its format');
 assert.equal(await cellText(7,3),'1,234,567.89','a thousands cell keeps separators and decimals');
 assert.equal(await cellText(11,3),'#DIV/0!','an error value is drawn as text');
 assert.equal(await cellAlign(4,2),'flex-end','numbers are right-aligned');
 assert.notEqual(await cellAlign(4,3),'flex-end','text stays left-aligned');
 check('cells keep core formatting (dates, percent, thousands, errors) and numbers are right-aligned');

 // Copy C5:D6 as tab-separated text (R15) and check the detail line (R16).
 await visible('.sheet-cell[data-row="4"][data-column="2"]').click();
 await visible('.sheet-cell[data-row="5"][data-column="3"]').click({modifiers:['Shift']});
 await visible('[data-testid="sheet-copy"]').click();
 await until(async()=>/Selection copied|已复制选区/.test(await sheet().innerText()),'the copy notice');
 const clipboardRaw=await app.evaluate(({clipboard})=>clipboard.readText());
 report.measurements.clipboard={raw:clipboardRaw};
 // Windows clipboard text uses CRLF; the viewer writes '\n' and the platform normalizes it.
 const clipboard=clipboardRaw.replace(/\r\n/g,'\n');
 assert.equal(clipboard,'42\tUsed range starts here\n1.5\t6','the clipboard holds the selected range as TSV');
 report.measurements.copiedText=clipboard;
 const longText=await cellText(11,4);
 assert.ok(longText.length>=1990,`the long cell keeps its 2,000-character limit (got ${longText.length})`);
 await visible('.sheet-cell[data-row="11"][data-column="4"]').click();
 const detail=await visible('[data-testid="sheet-detail"]');
 await until(async()=>(await detail.textContent()??'').startsWith('E12'),'the E12 detail line');
 const detailText=await detail.textContent();
 report.measurements.detail={cellLength:longText.length,detailLength:detailText?.length};
 assert.equal(detailText,`E12${longText}`,`the detail line names the cell and shows its whole text (${report.measurements.detail.cellLength} vs ${report.measurements.detail.detailLength})`);
 assert.equal(await detail.getAttribute('title'),longText,'the detail line carries the full text as its tooltip');
 check('a selected range copies as tab-separated text and the detail line shows the full cell text');

 // The hidden sheet tab opens its own window and keeps its percent format.
 await hiddenTab.click();
 await until(async()=>await attribute('data-sheet')==='1'&&Boolean(await cellText(0,1)),'the hidden sheet loads');
 assert.match(await cellText(0,1)??'',/^25(\.00)?%$/,'the hidden sheet keeps its percent format');
 await visible('[data-testid="sheet-tab"]').nth(0).click();
 await until(async()=>await attribute('data-sheet')==='0','back on the visible sheet');
 await closeActiveTab();
 let released=await waitNoWorkers('the features helper to exit');
 assert.ok(released.gone,'closing a small workbook ends its helper within 5 s');
 if(backend==='main'){
  const closedAt=Date.now();
  const gone=await until(async()=>{const list=await readers();return list.length===0;},'the reader to exit after close',6_000).then(()=>true).catch(()=>false);
  report.measurements.readerExitMs=Date.now()-closedAt;
  assert.ok(gone,`the reader ends within 5 s of the tab closing (waited ${report.measurements.readerExitMs} ms, pids ${JSON.stringify(await readers())})`);
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'still no helper');
 }
 check('switching to the hidden sheet works and closing the tab ends the helper');

 // Every other Excel format D6 allows opens through the same viewer, under both read methods.
 for(const name of ['date.xls','any_sheets.xlsb','any_sheets.ods','special_cells.ods']){
  const started=Date.now();
  await openProjectSheet(name);
  const rows=Number(await attribute('data-total-rows'));
  assert.ok(rows>0,`${name} reports its used range (${rows} rows)`);
  assert.ok(await cellText(0,0)||await cellText(0,1),`${name} draws a first cell`);
  report.measurements[`${name}OpenMs`]=Date.now()-started;
  await closeActiveTab();
 }
 if(backend==='main'){
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'the legacy formats start no helper either');
  await until(async()=>(await readers()).length===0,'the legacy-format readers to exit',10_000);
 }
 check('date.xls, any_sheets.xlsb, any_sheets.ods and special_cells.ods open through the same viewer');

 // AC2 / AC7: the 100 MiB + 1 byte file, the truncated file, the OLE2 workbook with a .xlsx
 // extension and a workbook changed while open each give their one line, plus the action.
 const openProjectRow=async name=>{
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
  const row=page.locator(`.wb-tree [data-path="${name}"]`).first();await row.waitFor({timeout:60_000});await row.click();
 };
 const errorRow=async(name,pattern,testId='sheet-error')=>{
  const row=visible(`[data-testid="${testId}"]`);
  await row.waitFor({timeout:120_000});
  const text=await row.innerText();
  assert.match(text,pattern,`${name}: ${text}`);
  return {text,buttons:await row.locator('[data-testid="sheet-open-system-app"],[data-testid="sheet-changed-open-system-app"]').count()};
 };
 await openProjectRow('numbers-100-over.xlsx');
 const tooLarge=await errorRow('numbers-100-over.xlsx',/Too large to preview|文件过大/);
 assert.match(tooLarge.text,/100 MiB/,'the size line names the 100 MiB limit');
 assert.equal(tooLarge.buttons,1,'the too-large row offers Open with system app');
 await shot('en-light-too-large.png');
 await closeActiveTab();
 await openProjectRow('truncated.xlsx');
 const corrupt=await errorRow('truncated.xlsx',/damaged|损坏/);
 assert.equal(corrupt.buttons,1,'the damaged row offers Open with system app');
 await shot('en-light-corrupt.png');
 await closeActiveTab();
 await openProjectRow('protected-wrong.xlsx');
 const protectedSheet=await errorRow('protected-wrong.xlsx',/password-protected|密码保护/);
 assert.equal(protectedSheet.buttons,1,'the password row offers Open with system app');
 await shot('en-light-protected.png');
 await closeActiveTab();
 await openProjectSheet('changed.xlsx');
 await writeFile(join(project,'changed.xlsx'),'changed on disk');
 await (async()=>{
  const input=visible('[data-testid="sheet-goto"]');await input.fill('A50000');await input.press('Enter');
 })();
 const changedRow=await errorRow('changed.xlsx',/changed|已更改/,'sheet-changed');
 assert.equal(changedRow.buttons,1,'the changed row offers Open with system app');
 await shot('en-light-changed.png');
 await closeActiveTab();
 await until(async()=>{const list=await readers();return list.length===0;},'the changed-file readers to exit',10_000).catch(()=>{});
 check('100 MiB + 1 byte, truncated, wrong-extension OLE2 and changed-while-open each give their line and the system-app action');

 // sheets-10x10.xlsx: ten dense sheet tabs.
 const sheetsBefore=await memorySnapshot();
 report.measurements.sheetsOpenMs=await openProjectSheet('sheets-10x10.xlsx');
 report.measurements.workersAfterSheetsOpen=sheetWorkers();
 report.measurements.surfacesAfterSheetsOpen=await sheetSurfaces();
 report.measurements.sheetsHostFirstWindow=await hostFirstWindow(projectId,'sheets-10x10.xlsx',14);
 if(backend==='main'){
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'main mode starts no --sheet-worker helper');
  assert.ok(report.measurements.sheetsHostFirstWindow.firstWindowMs<=BUDGETS.sheetsFirstWindowMs,
   `sheets-10x10 first window (open + first window, in the app) within ${BUDGETS.sheetsFirstWindowMs} ms (took ${report.measurements.sheetsHostFirstWindow.firstWindowMs} ms)`);
 }
 const tabs=await visible('[data-testid="sheet-tab"]').allInnerTexts();
 assert.equal(tabs.length,10,'ten tabs');
 for(let index=0;index<10;index++)assert.match(tabs[index],new RegExp(`Q${index+1}-2026`),`tab ${index+1} names its sheet`);
 await theme('zh-CN','dark');
 report.measurements.workersAfterTheme=sheetWorkers();
 await shot('zh-dark-sheets.png');
 check('sheets-10x10.xlsx shows ten dense sheet tabs, readable in Chinese/dark');

 await closeActiveTab();
 released=await waitNoWorkers('the ten-sheet helper to exit');
 report.measurements.sheetsClosedWorkers=released;
 assert.ok(released.gone,`closing the ten-sheet workbook ends its helper within 5 s (remaining ${released.remaining}: ${JSON.stringify(released.pids)})`);
 if(backend==='main'){
  const closedAt=Date.now();
  const gone=await until(async()=>{const list=await readers();return list.length===0;},'the ten-sheet reader to exit',6_000).then(()=>true).catch(()=>false);
  report.measurements.sheetsReaderExitMs=Date.now()-closedAt;
  assert.ok(gone,`the ten-sheet reader ends within 5 s of the tab closing (waited ${report.measurements.sheetsReaderExitMs} ms)`);
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'still no helper');
 }
 await delay(5_000);
 report.measurements.sheetsMemory={before:sheetsBefore,after:await memorySnapshot()};
 report.measurements.sheetsMemory.rendererDeltaMiB=Math.round((report.measurements.sheetsMemory.after.renderer-report.measurements.sheetsMemory.before.renderer)*10)/10;
 report.measurements.sheetsMemory.runtimeDeltaMiB=Math.round((report.measurements.sheetsMemory.after.runtime-report.measurements.sheetsMemory.before.runtime)*10)/10;
 assert.ok(report.measurements.sheetsMemory.rendererDeltaMiB<=BUDGETS.rendererDeltaMiB,`the app renderer is back within ${BUDGETS.rendererDeltaMiB} MB after sheets-10x10 (${report.measurements.sheetsMemory.rendererDeltaMiB} MiB)`);
 assert.ok(report.measurements.sheetsMemory.runtimeDeltaMiB<=BUDGETS.runtimeDeltaMiB,`the runtime is back within ${BUDGETS.runtimeDeltaMiB} MB after sheets-10x10 (${report.measurements.sheetsMemory.runtimeDeltaMiB} MiB)`);

 // numbers-100.xlsx from the Explorer: far end, go-to, measurement, then close ends the helper.
 const numbersBefore=await memorySnapshot();
 const mainBeforeNumbers=backend==='main'?mib((await mainMemory())?.privateBytes):undefined;
 report.measurements.numbersOpenMs=await openProjectSheet('numbers-100.xlsx');
 assert.equal(await attribute('data-total-rows'),'727044','the used range is 727,044 rows');
 assert.equal(await attribute('data-total-columns'),'20','the used range is 20 columns');
 assert.equal(await cellText(0,0),numCellText(0,0),'A1 matches the generator');
 assert.match(await visible('[data-testid="sheet-used-range"]').textContent(),/727,044 rows × 20 columns|727,044 行 × 20 列/,'the sheet size is shown');
 if(backend==='main'){
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'a 100 MiB workbook also starts no --sheet-worker helper (R22)');
  const list=await readers();
  report.measurements.readersAfterNumbersOpen=list;
  assert.equal(list.length,1,'one WebAssembly reader for the 100 MiB workbook');
  report.measurements.readerNumbersMemory=readerMemory(list[0]);
  report.measurements.mainDuringFeedMiB=mib((await mainMemory())?.privateBytes);
  assert.ok(report.measurements.mainDuringFeedMiB-mainBeforeNumbers<=BUDGETS.mainPeakMiB,
   `the main process stays under ${BUDGETS.mainPeakMiB} MiB during the feed (was ${report.measurements.mainDuringFeedMiB} MiB)`);
  report.measurements.numbersHostFirstWindow=await hostFirstWindow(projectId,'numbers-100.xlsx',20);
  assert.ok(report.measurements.numbersHostFirstWindow.firstWindowMs<=BUDGETS.numbersFirstWindowMs,
   `numbers-100 first window (open + first window, in the app) within ${BUDGETS.numbersFirstWindowMs} ms (took ${report.measurements.numbersHostFirstWindow.firstWindowMs} ms)`);
 }else{
  assert.equal(sheetWorkers()?.length,1,'one helper for the open workbook');
 }
 report.measurements.loadedWindow=await loadedWindowTiming(projectId,'numbers-100.xlsx',200_000);
 report.measurements.loadedWindow.medianMs=report.measurements.loadedWindow.samples.slice().sort((left,right)=>left-right)[Math.floor(report.measurements.loadedWindow.samples.length/2)];
 if(backend==='main'){
  // The budget is per window (validation.md): every sample counts, not the average.
  assert.ok(Math.max(...report.measurements.loadedWindow.samples)<=BUDGETS.loadedWindowMs,
   `a loaded 500-row window within ${BUDGETS.loadedWindowMs} ms (samples ${JSON.stringify(report.measurements.loadedWindow.samples)} ms)`);
  report.measurements.mainAfterWindowRequestMiB=mib((await mainMemory())?.privateBytes);
 }

 const bottomRow=727043;
 report.measurements.scrollToFarEnd=await scrollToBottomAndTime(bottomRow);
 assert.ok(report.measurements.scrollToFarEnd.ms>=0,'the far end paints');
 assert.equal(report.measurements.scrollToFarEnd.text,numCellText(bottomRow,0),'the last used row shows its value');
 assert.ok(report.measurements.scrollToFarEnd.ms<=300,`scroll to painted data within 300 ms (took ${Math.round(report.measurements.scrollToFarEnd.ms)} ms)`);
 report.measurements.goTo=await goToAndTime('A700000',699999,0);
 assert.equal(report.measurements.goTo.text,numCellText(699999,0),'go-to A700000 lands on that cell');
 assert.ok(report.measurements.goTo.ms<=300,`go-to within 300 ms (took ${Math.round(report.measurements.goTo.ms)} ms)`);
 const goToRow=await goToAndTime('712345',712344,0);
 assert.equal(goToRow.text,numCellText(712344,0),'go-to by row number lands on that row');
 report.measurements.goToRow={ms:goToRow.ms,text:goToRow.text};
 assert.ok(goToRow.ms<=300,`go-to by row number within 300 ms (took ${Math.round(goToRow.ms)} ms)`);
 // The window holds the visible columns only, so horizontal scrolling paints as well.
 report.measurements.horizontal=await page.evaluate(async ()=>{
  const view=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-view');
  const grid=view.querySelector('.sheet-grid');
  const row=Number(view.querySelector('.sheet-cell')?.dataset.row??0);
  const started=performance.now();
  grid.scrollLeft=grid.scrollWidth;
  const deadline=started+10_000;
  return await new Promise(done=>{
   const tick=()=>{
    const text=view.querySelector(`.sheet-cell[data-row="${row}"][data-column="19"]`)?.textContent??'';
    if(text)return done({ms:performance.now()-started,text,row});
    if(performance.now()>deadline)return done({ms:-1,text:null,row});
    requestAnimationFrame(tick);
   };
   requestAnimationFrame(tick);
  });
 });
 assert.equal(report.measurements.horizontal.text,numCellText(report.measurements.horizontal.row,19),'the rightmost column paints');
 assert.ok(report.measurements.horizontal.ms<=300,`horizontal scroll within 300 ms (took ${Math.round(report.measurements.horizontal.ms)} ms)`);
 report.measurements.geometry=await page.evaluate(()=>{
  const grid=document.querySelector('.ws-pane.selected .pane-tab-surface:not([hidden]) .sheet-grid');
  const box=node=>{const rect=node.getBoundingClientRect();return {left:Math.round(rect.left),width:Math.round(rect.width),top:Math.round(rect.top),height:Math.round(rect.height)};};
  const rowHead=grid.querySelector('.sheet-row-head'),colHead=grid.querySelector('.sheet-col-head'),row=grid.querySelector('.sheet-row');
  return {grid:box(grid),scrollLeft:grid.scrollLeft,rowHead:box(rowHead),rowHeadText:rowHead.textContent,colHead:box(colHead),
   labels:[...grid.querySelectorAll('.sheet-col-label')].slice(0,3).map(node=>({text:node.textContent,left:Math.round(node.getBoundingClientRect().left)})),
   cells:[...row.querySelectorAll('.sheet-cell')].slice(0,3).map(node=>({column:node.dataset.column,left:Math.round(node.getBoundingClientRect().left)}))};
 });
 await shot('zh-dark-numbers-end.png');
 await theme('en','light');
 await shot('en-light-numbers-end.png');
 check('the far end, A700000 and a row number reach their cells; scroll and go-to paint within 300 ms');

 await closeActiveTab();
 const closedAt=Date.now();
 const gone=await until(()=>{const workers=sheetWorkers();return Boolean(workers)&&workers.length===0;},'the sheet helper to exit after close',6_000).then(()=>true).catch(()=>false);
 report.measurements.helperExitMs=Date.now()-closedAt;
 assert.ok(gone,`the helper ends within 5 s of the tab closing (waited ${report.measurements.helperExitMs} ms, pids ${JSON.stringify(sheetWorkers())})`);
 check(`closing the workbook tab ends the --sheet-worker helper in ${report.measurements.helperExitMs} ms`);
 await delay(5_000);
 report.measurements.numbersMemory={before:numbersBefore,after:await memorySnapshot()};
 report.measurements.numbersMemory.rendererDeltaMiB=Math.round((report.measurements.numbersMemory.after.renderer-report.measurements.numbersMemory.before.renderer)*10)/10;
 report.measurements.numbersMemory.runtimeDeltaMiB=Math.round((report.measurements.numbersMemory.after.runtime-report.measurements.numbersMemory.before.runtime)*10)/10;
 assert.ok(report.measurements.numbersMemory.rendererDeltaMiB<=BUDGETS.rendererDeltaMiB,`the app renderer is back within ${BUDGETS.rendererDeltaMiB} MB after numbers-100 (${report.measurements.numbersMemory.rendererDeltaMiB} MiB)`);
 assert.ok(report.measurements.numbersMemory.runtimeDeltaMiB<=BUDGETS.runtimeDeltaMiB,`the runtime is back within ${BUDGETS.runtimeDeltaMiB} MB after numbers-100 (${report.measurements.numbersMemory.runtimeDeltaMiB} MiB)`);
 if(backend==='main'){
  const readerClosedAt=Date.now();
  const readerGone=await until(async()=>{const list=await readers();return list.length===0;},'the 100 MiB reader to exit',6_000).then(()=>true).catch(()=>false);
  report.measurements.numbersReaderExitMs=Date.now()-readerClosedAt;
  assert.ok(readerGone,`the 100 MiB reader ends within 5 s of the tab closing (waited ${report.measurements.numbersReaderExitMs} ms, pids ${JSON.stringify(await readers())})`);
  // AC3: the main process comes back within 30 MB of where it started, five seconds after closing.
  await delay(5_000);
  const after=mib((await mainMemory())?.privateBytes);
  report.measurements.mainAfterCloseMiB=after;
  report.measurements.mainDeltaAfterCloseMiB=Math.round((after-mainBeforeNumbers)*10)/10;
  report.measurements.mainPeakMiB=mib((await mainMemory())?.peakWorkingSetSize);
  assert.ok(report.measurements.mainDeltaAfterCloseMiB<=BUDGETS.mainDeltaMiB,
   `the main process is back within ${BUDGETS.mainDeltaMiB} MB after closing (${report.measurements.mainDeltaAfterCloseMiB} MiB)`);
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'no helper ever started in main mode');
  check(`main mode: no --sheet-worker helper, the ${report.measurements.numbersReaderExitMs} ms reader exit, main back within ${report.measurements.mainAfterCloseMiB-mainBeforeNumbers>0?'+':''}${report.measurements.mainDeltaAfterCloseMiB} MiB`);
 }

 // strings-100.xlsx as a registered external file.
 const stringsBefore=await memorySnapshot();
 await theme('zh-CN','dark');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const openExternal=page.getByRole('button',{name:/Open file outside workspace|打开工作区外的文件/}).first();
 await openExternal.waitFor({timeout:30_000});await openExternal.click();
 await until(()=>page.getByRole('tab').filter({hasText:'strings-100.xlsx'}).count(),'the external sheet tab');
 const externalStarted=performance.now();
 await page.getByRole('tab',{name:/strings-100\.xlsx/}).first().click();
 // R12: a loading sheet reports progress and never blocks the rest of the app. Main mode has no
 // progress number (a synchronous WebAssembly load cannot report one), so the status text is taken.
 if(backend==='main'){
  report.measurements.progressDuringLoad=await until(async()=>{
   const text=await sheet().locator('[data-testid="sheet-status"]').textContent().catch(()=>null);
   return text&&!/Strings|文本/.test(text)?text:null;
  },'a loading status',180_000).catch(()=>null);
 }else{
  report.measurements.progressDuringLoad=await until(async()=>{
   const text=await sheet().locator('[data-testid="sheet-status"]').textContent().catch(()=>null);
   return text&&/\d+%/.test(text)?text:null;
  },'a load percentage',120_000);
 }
 // One tab, one parse: a remount used to open the workbook twice, so two readers (or helpers)
 // parsed it side by side and the 25 s budget was missed. Sample the count while it loads.
 const sampling={done:false};
 const concurrent=(async()=>{
  let most=0;
  while(!sampling.done){
   const list=await (backend==='main'?readers():Promise.resolve(sheetWorkers())).catch(()=>null);
   most=Math.max(most,Array.isArray(list)?list.length:0);
   await new Promise(done=>setTimeout(done,200));
  }
  return most;
 })();
 await waitSheetLoaded('strings-100.xlsx');
 sampling.done=true;
 report.measurements.externalOpenMs=Math.round(performance.now()-externalStarted);
 report.measurements.externalMostParsers=await concurrent;
 assert.equal(report.measurements.externalMostParsers,1,`one ${backend==='main'?'reader':'helper'} parses the external workbook, never two`);
 assert.equal(await attribute('data-total-rows'),'802851','the external sheet reports its used range');
 assert.ok((await sheet().getAttribute('data-file-path')??'').endsWith('strings-100.xlsx'),'the external tab shows its own path');
 assert.equal(await surfaces().locator('[data-testid="external-file-boundary"]').count(),1,'an external workbook keeps the read-only boundary');
 if(backend==='main'){
  assert.deepEqual(sheetWorkers()??['unavailable'],[],'the external workbook starts no helper');
  assert.equal((await readers()).length,1,'one reader for the external workbook');
  assert.ok(report.measurements.externalOpenMs<=BUDGETS.stringsFirstWindowMs,
   `strings-100 first window within ${BUDGETS.stringsFirstWindowMs} ms (took ${report.measurements.externalOpenMs} ms)`);
 }else{
  assert.equal(sheetWorkers()?.length,1,'one helper for the external workbook');
 }
 await shot(backend==='main'?'zh-dark-strings-main.png':'zh-dark-strings.png');
 await theme('en','light');
 await shot(backend==='main'?'en-light-strings-main.png':'en-light-strings.png');
 await closeActiveTab();
 released=await waitNoWorkers('the external helper to exit');
 assert.ok(released.gone,'the external workbook helper ends within 5 s');
 if(backend==='main'){
  const gone=await until(async()=>{const list=await readers();return list.length===0;},'the external reader to exit',6_000).then(()=>true).catch(()=>false);
  assert.ok(gone,`the external workbook reader ends within 5 s (pids ${JSON.stringify(await readers())})`);
 }
 check('strings-100.xlsx opens as a registered external file through the same viewer and releases its helper');
 await delay(5_000);
 report.measurements.stringsMemory={before:stringsBefore,after:await memorySnapshot()};
 report.measurements.stringsMemory.rendererDeltaMiB=Math.round((report.measurements.stringsMemory.after.renderer-report.measurements.stringsMemory.before.renderer)*10)/10;
 report.measurements.stringsMemory.runtimeDeltaMiB=Math.round((report.measurements.stringsMemory.after.runtime-report.measurements.stringsMemory.before.runtime)*10)/10;
 assert.ok(report.measurements.stringsMemory.rendererDeltaMiB<=BUDGETS.rendererDeltaMiB,`the app renderer is back within ${BUDGETS.rendererDeltaMiB} MB after strings-100 (${report.measurements.stringsMemory.rendererDeltaMiB} MiB)`);
 assert.ok(report.measurements.stringsMemory.runtimeDeltaMiB<=BUDGETS.runtimeDeltaMiB,`the runtime is back within ${BUDGETS.runtimeDeltaMiB} MB after strings-100 (${report.measurements.stringsMemory.runtimeDeltaMiB} MiB)`);

 // Task 11-10 step 3 / AC5: switching Local file access with a workbook open reloads cleanly. This
 // runs last: the runtime keeps the handle the view abandons at the switch (the renderer's close
 // goes to the new backend), so that helper ends on its own idle timer, not here. Each step asks for
 // a different row, so each switch must really reopen the workbook under the new backend.
 if(backend==='main'){
  await theme('en','light');
  await openProjectSheet('sheets-10x10.xlsx');
  const far=await forceWindow(103155);
  report.measurements.switchFarEnd={ok:far.ok,text:far.text??far.reason};
  assert.ok(far.ok&&far.text===numCellText(103155,0),`the far end paints under main (${far.text??far.reason})`);
  assert.equal(await setBackend('runtime'),'runtime','the setting switches to the runtime with a workbook open');
  const afterSwitch=await forceWindow(90000);
  report.measurements.switchToRuntime={ok:afterSwitch.ok,text:afterSwitch.text??afterSwitch.reason};
  assert.ok(afterSwitch.ok&&afterSwitch.text===numCellText(90000,0),`the workbook reopens under the runtime and serves row 90,001 (${afterSwitch.text??afterSwitch.reason})`);
  const switchedReaders=await readers();
  report.measurements.readersAfterRuntimeSwitch=switchedReaders;
  assert.deepEqual(switchedReaders,[],'the main-mode reader is gone after switching to the runtime');
  await until(()=>(sheetWorkers()??[]).length===1,'the runtime helper for the reopened workbook',30_000);
  report.measurements.workersAfterRuntimeSwitch=sheetWorkers();
  assert.equal(await setBackend('main'),'main','the setting switches back to main with the workbook open');
  const backToMain=await forceWindow(95000);
  report.measurements.switchToMain={ok:backToMain.ok,text:backToMain.text??backToMain.reason};
  assert.ok(backToMain.ok&&backToMain.text===numCellText(95000,0),`the workbook reopens under main again and serves row 95,001 (${backToMain.text??backToMain.reason})`);
  await until(async()=>(await readers()).length===1,'one reader after switching back',30_000);
  report.measurements.abandonedRuntimeHelpers=(sheetWorkers()??[]).length;
  assert.deepEqual(report.errors,[],report.errors.join('\n'));
  check('switching Local file access with a workbook open reopens the same sheet under the new backend, without a page error');
  await closeActiveTab();
  await until(async()=>(await readers()).length===0,'the reader of the switch test to exit',6_000);
 }

 // R5 / AC4: a hidden tab releases its helper or reader after five real minutes and reloads when shown.
 if(hiddenRelease){
  await theme('en','light');
  await openProjectSheet('features.xlsx');
  await openProjectSheet('date.xls');
  const live=async()=>backend==='main'?(await readers()).length:(sheetWorkers()??[]).length;
  await until(async()=>await live()===2,'two live parsers before the hidden wait',30_000);
  const started=Date.now();
  await delay(5*60*1000+15_000);
  report.measurements.hiddenRelease={waitedMs:Date.now()-started,liveBeforeHide:2,liveAfterWait:await live()};
  // The 300 s idle timer ends an untouched helper too, so the hidden tab's parser may be the only
  // one left or both may be gone; never two.
  assert.ok(report.measurements.hiddenRelease.liveAfterWait<=1,`the hidden tab released its ${backend==='main'?'reader':'helper'} after five minutes`);
  await page.getByRole('tab',{name:/features\.xlsx/}).first().click();
  await waitSheetLoaded('features.xlsx');
  report.measurements.hiddenRelease.liveAfterResume=await live();
  assert.ok(report.measurements.hiddenRelease.liveAfterResume>=1,'showing the tab again reloads and starts a parser');
  await shot('en-light-hidden-release.png');
  // The second workbook may still be present; the app exit below ends it.
  await closeActiveTab().catch(()=>{});
  check('a hidden tab released its helper or reader after five minutes and reloaded when shown');
 }

 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error instanceof Error?(error.stack??error.message):String(error));if(page)await shot('failure.png').catch(()=>{});}
finally{
 if(page)await request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app:electronApp})=>electronApp.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 report.completedAt=new Date().toISOString();await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 await cleanupApp?.().catch(()=>{});await releaseLock?.();
 // The scratch project holds hard links to the fixtures plus a runtime data dir; keep it only for a failure.
 if(report.passed)await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:500}).catch(()=>{});
 console.log(report.passed?'OFFICE SHEET APP QA PASSED':`OFFICE SHEET APP QA FAILED\n${report.errors.join('\n')}`);
 process.exitCode=report.passed?0:1;
}
