// Real-app regression probe for the Excel sheet preview (task 11-10, step 2).
//
//   $env:TEMP="$env:TEMP\tt-qa-temp"; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to the worktree runtime executable>'
//   node qa/office-sheet-app.mjs
//
// Opens a project workbook from the Explorer and another as a registered external file, checks
// the sheet tabs (including hidden sheets), the used range that starts at C5, scrolling and go-to
// at the far end of a 100 MiB sheet (R12: 300 ms in a loaded sheet), copy as TSV, and that closing
// the tab ends the runtime's `--sheet-worker` helper within 5 s. Screenshots land in
// qa/results/office-sheet/. Fixtures are hard-linked into the scratch project, never modified.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {link,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
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
const fixtures=resolve(scratchBase,'office-preview/fixtures');
const scratch=await mkdtemp(join(scratchBase,'tt-office-sheet-app-'));
const project=join(scratch,'project'),outside=join(scratch,'outside'),appDir=join(scratch,'app');
const out=join(root,'qa/results/office-sheet');
const report={passed:false,startedAt:new Date().toISOString(),runtime,scratch,checks:[],screenshots:[],measurements:{},errors:[],limitations:[
 'The 5-minute hidden-tab release (R5) is not exercised: the probe would have to wait five minutes; the close path is.',
 'Only the Runtime read method runs here; Local file access = main is step 3.',
 'Merged cells and find-in-sheet are left out of step 2 (merged-cell parsing measured over the gate in step 1; find needs a core method).',
]};
let app,page,releaseLock,cleanupApp,mainPid;
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const request=(method,params={})=>page.evaluate(([name,value])=>window.threadterm.request(name,value),[method,params]);
const visible=selector=>page.locator(`.ws-pane.selected .pane-tab-surface:not([hidden]) ${selector}`);
const surfaces=()=>page.locator('.ws-pane.selected .pane-tab-surface:not([hidden])');
const shot=async name=>{await page.screenshot({path:join(out,name)});report.screenshots.push(join('qa/results/office-sheet',name));};
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

async function prepare(){
 await Promise.all([mkdir(project,{recursive:true}),mkdir(outside,{recursive:true}),mkdir(out,{recursive:true})]);
 // Hard links: no 300 MiB of copies, and the fixtures folder keeps its bytes.
 for(const name of ['features.xlsx','sheets-10x10.xlsx','numbers-100.xlsx'])await link(join(fixtures,name),join(project,name));
 await link(join(fixtures,'strings-100.xlsx'),join(outside,'strings-100.xlsx'));
 ({cleanup:cleanupApp}=await buildQaApp({root,outDir:appDir}));
}
function environment(){
 const dropped=/^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!dropped.test(key)));
 Object.assign(env,{Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),TEMP:scratchBase,TMP:scratchBase,
  HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),CODEX_HOME:join(scratch,'home','.codex'),
  THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-office-sheet-${randomUUID()}`,
  THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,
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
 const session=await request('session.create',{projectId:added.id,cwd:project,provider:'grok',mode:'chat',title:'Sheet preview QA',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor();
 await request('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.ws-pane.selected').waitFor({state:'visible',timeout:45_000});
 assert.equal(await page.evaluate(()=>window.threadterm.localFiles?.setBackend('runtime')),'runtime','Local file access is the runtime');

 await theme('en','light');
 assert.deepEqual(sheetWorkers()??['unavailable'],[],'no sheet helper before any workbook opens');

 // features.xlsx: two sheets, the second hidden and marked; the used range starts at C5.
 report.measurements.featuresOpenMs=await openProjectSheet('features.xlsx');
 report.measurements.workersAfterFeaturesOpen=sheetWorkers();
 report.measurements.surfacesAfterFeaturesOpen=await sheetSurfaces();
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
 check('switching to the hidden sheet works and closing the tab ends the helper');

 // sheets-10x10.xlsx: ten dense sheet tabs.
 report.measurements.sheetsOpenMs=await openProjectSheet('sheets-10x10.xlsx');
 report.measurements.workersAfterSheetsOpen=sheetWorkers();
 report.measurements.surfacesAfterSheetsOpen=await sheetSurfaces();
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

 // numbers-100.xlsx from the Explorer: far end, go-to, measurement, then close ends the helper.
 report.measurements.numbersOpenMs=await openProjectSheet('numbers-100.xlsx');
 assert.equal(await attribute('data-total-rows'),'727044','the used range is 727,044 rows');
 assert.equal(await attribute('data-total-columns'),'20','the used range is 20 columns');
 assert.equal(await cellText(0,0),numCellText(0,0),'A1 matches the generator');
 assert.match(await visible('[data-testid="sheet-used-range"]').textContent(),/727,044 rows × 20 columns|727,044 行 × 20 列/,'the sheet size is shown');
 assert.equal(sheetWorkers()?.length,1,'one helper for the open workbook');

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

 // strings-100.xlsx as a registered external file.
 await theme('zh-CN','dark');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const openExternal=page.getByRole('button',{name:/Open file outside workspace|打开工作区外的文件/}).first();
 await openExternal.waitFor({timeout:30_000});await openExternal.click();
 await until(()=>page.getByRole('tab').filter({hasText:'strings-100.xlsx'}).count(),'the external sheet tab');
 const externalStarted=performance.now();
 await page.getByRole('tab',{name:/strings-100\.xlsx/}).first().click();
 // R12: a loading sheet reports progress and never blocks the rest of the app.
 report.measurements.progressDuringLoad=await until(async()=>{
  const text=await sheet().locator('[data-testid="sheet-status"]').textContent().catch(()=>null);
  return text&&/\d+%/.test(text)?text:null;
 },'a load percentage',120_000);
 await waitSheetLoaded('strings-100.xlsx');
 report.measurements.externalOpenMs=Math.round(performance.now()-externalStarted);
 assert.equal(await attribute('data-total-rows'),'802851','the external sheet reports its used range');
 assert.ok((await sheet().getAttribute('data-file-path')??'').endsWith('strings-100.xlsx'),'the external tab shows its own path');
 assert.equal(await surfaces().locator('[data-testid="external-file-boundary"]').count(),1,'an external workbook keeps the read-only boundary');
 assert.equal(sheetWorkers()?.length,1,'one helper for the external workbook');
 await shot('zh-dark-strings.png');
 await theme('en','light');
 await shot('en-light-strings.png');
 await closeActiveTab();
 released=await waitNoWorkers('the external helper to exit');
 assert.ok(released.gone,'the external workbook helper ends within 5 s');
 check('strings-100.xlsx opens as a registered external file through the same viewer and releases its helper');

 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error instanceof Error?(error.stack??error.message):String(error));if(page)await shot('failure.png').catch(()=>{});}
finally{
 if(page)await request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app:electronApp})=>electronApp.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 report.completedAt=new Date().toISOString();await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 await cleanupApp?.().catch(()=>{});await releaseLock?.();
 console.log(report.passed?'OFFICE SHEET APP QA PASSED':`OFFICE SHEET APP QA FAILED\n${report.errors.join('\n')}`);
 process.exitCode=report.passed?0:1;
}
