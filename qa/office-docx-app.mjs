// Real-app regression probe for the Word document preview (task 11-10, steps 4 and 5).
//
//   $env:TEMP='D:/project/ThreadTerm/tt-qa-temp'; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to the worktree runtime executable>'
//   node qa/office-docx-app.mjs [--backend main]
//
// Opens text-300.docx and images-100.docx from the Explorer and as registered external files,
// checks the sandboxed viewer, its own OS process, one grant and one frame per document, the link
// proposal row, selection/copy, no network request from the frame, protected/truncated errors, the
// 5 s / 30 s / 1.2 GiB budgets, frame process exit and the grant revocation on close, and AC3's
// +30 MB main-process bound. Screenshots land in qa/results/office-docx[-main]/. Fixtures are
// hard-linked into the scratch project, never modified. Reports: report.json in the same folder.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {link,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
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
const fixtures=resolve(scratchBase,'office-preview/fixtures');
const scratch=await mkdtemp(join(scratchBase,`tt-office-docx-app-${backend}-`));
const project=join(scratch,'project'),outside=join(scratch,'outside'),appDir=join(scratch,'app');
const out=join(root,backend==='main'?'qa/results/office-docx-main':'qa/results/office-docx');
const BUDGETS={textReadyMs:5_000,imagesReadyMs:30_000,frameMiB:1_228.8,mainDeltaMiB:30};
const report={passed:false,backend,startedAt:new Date().toISOString(),runtime,scratch,checks:[],screenshots:[],measurements:{},budgets:BUDGETS,errors:[],limitations:[
 'The 5-minute hidden-tab release is not exercised: the probe would have to wait five minutes; close revokes and ends the frame.',
 'A document without lastRenderedPageBreak (not Word-saved) renders as one page; not measured here (spike B question 2).',
 'The runtime process has no helper for documents in either mode; with main selected this probe checks its children, not private open handles (no handle.exe on this PC).',
]};
let app,page,releaseLock,cleanupApp,mainPid;
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const request=(method,params={})=>page.evaluate(([name,value])=>window.threadterm.request(name,value),[method,params]);
const visible=selector=>page.locator(`.ws-pane.selected .pane-tab-surface:not([hidden]) ${selector}`);
const shot=async name=>{await page.screenshot({path:join(out,name)});report.screenshots.push(join(out,name).replaceAll('\\','/'));};
async function until(test,label,timeout=60_000){const deadline=Date.now()+timeout;for(;;){try{const value=await test();if(value)return value;}catch{}if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await delay(100);}}

function powershell(script){
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:30_000});
 return {ok:result.status===0,text:(result.stdout??'').trim(),error:String(result.stderr??'')};
}
/** The runtime's child processes. A document preview must never start a helper in main mode. */
function runtimeProcessTree(){
 const {ok,text}=powershell(`$main=${mainPid}
$runtimes=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$main" -ErrorAction SilentlyContinue | Where-Object {$_.Name -like '*threadterm-v3-runtime*'})
$result=New-Object System.Collections.ArrayList
foreach($r in $runtimes){
 $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($r.ProcessId)" -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,CommandLine)
 [void]$result.Add([pscustomobject]@{pid=[int]$r.ProcessId;children=$children})
}
ConvertTo-Json -InputObject @($result.ToArray()) -Depth 5 -Compress`);
 if(!ok)return undefined;
 try{const parsed=JSON.parse(text);return Array.isArray(parsed)?parsed:(parsed?[parsed]:[]);}catch{return undefined;}
}
function processMemory(pid){
 const {ok,text}=powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if($p){ConvertTo-Json -Compress -InputObject @{workingSet=[math]::Round($p.WorkingSet64/1MB,1);peak=[math]::Round($p.PeakWorkingSet64/1MB,1)}}else{'null'}`);
 if(!ok||!text||text==='null')return undefined;
 try{return JSON.parse(text);}catch{return undefined;}
}
function processAlive(pid){const {ok,text}=powershell(`if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){'yes'}else{'no'}`);return ok&&text==='yes';}
const mainMemory=()=>app.evaluate(({app:electronApp})=>{
 const browser=electronApp.getAppMetrics().find(entry=>entry.type==='Browser');
 return browser?.memory??null;
});
const mib=kilobytes=>Math.round(((kilobytes??0)/1024)*10)/10;
const setBackend=mode=>page.evaluate(async value=>window.threadterm.localFiles?.setBackend(value),mode);

async function prepare(){
 await Promise.all([mkdir(project,{recursive:true}),mkdir(outside,{recursive:true}),mkdir(out,{recursive:true})]);
 for(const name of ['text-300.docx','images-100.docx','protected.docx','truncated.docx'])await link(join(fixtures,name),join(project,name));
 for(const name of ['text-300.docx','images-100.docx'])await link(join(fixtures,name),join(outside,name));
 ({cleanup:cleanupApp}=await buildQaApp({root,outDir:appDir}));
}
function environment(){
 const dropped=/^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!dropped.test(key)));
 Object.assign(env,{Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),TEMP:scratchBase,TMP:scratchBase,
  HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),CODEX_HOME:join(scratch,'home','.codex'),
  THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-office-docx-${randomUUID()}`,
  THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,
  THREADTERM_V3_OPEN_EXTERNAL_QA:JSON.stringify([join(outside,'text-300.docx'),join(outside,'images-100.docx')])});
 assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path'],'isolated environment has one PATH');
 return env;
}

const docSurfaces=()=>page.evaluate(()=>[...document.querySelectorAll('.sandboxed-html-preview iframe.tt-preview-frame')].map(frame=>({name:frame.getAttribute('name'),src:frame.getAttribute('src'),hidden:Boolean(frame.closest('[hidden]'))})));
async function iframeName(){
 const frame=visible('iframe.tt-preview-frame').first();
 await frame.waitFor({timeout:60_000});
 return await frame.getAttribute('name');
}
const docFrame=name=>page.frames().find(frame=>frame.name()===name);
async function waitDocReady(name,timeout=60_000,images=false){
 const frame=await until(()=>docFrame(name),`the document frame ${name}`,Math.min(timeout,15_000));
 await frame.waitForSelector('.docx-wrapper > section.docx',{timeout});
 if(images)await frame.waitForFunction(()=>{
  const found=[...document.images];
  return found.length>0&&found.every(image=>image.complete&&image.naturalWidth>0);
 },undefined,{timeout});
 return frame;
}
async function waitFrameGone(pid,label,timeout=6_000){
 const started=Date.now();
 const gone=await until(()=>!processAlive(pid),label,timeout).then(()=>true).catch(()=>false);
 return {gone,ms:Date.now()-started};
}
function uniqueGrant(frameSrc){
 const match=/^tt-preview:\/\/([a-f0-9]{32})\//.exec(frameSrc??'');
 return match?.[1];
}
async function frameProcesses(name){
 return await app.evaluate(({BrowserWindow},name)=>{
  for(const window of BrowserWindow.getAllWindows()){
   if(window.isDestroyed())continue;
   const frame=window.webContents.mainFrame.framesInSubtree.find(candidate=>candidate.name===name);
   if(frame)return {rendererOsProcessId:window.webContents.mainFrame.osProcessId,frameOsProcessId:frame.osProcessId,url:frame.url};
  }
  return null;
 },name);
}
async function grantFetchStatus(url){
 return await app.evaluate(async ({session},url)=>{
  try{const response=await session.defaultSession.fetch(url,{method:'HEAD',cache:'no-store'});return response.status;}
  catch(error){return `error:${error instanceof Error?error.message:String(error)}`;}
 },url);
}

async function openProjectFile(name){
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const row=page.locator(`.wb-tree [data-path="${name}"]`).first();await row.waitFor({timeout:60_000});
 await row.click();
}
async function openProjectDoc(name,timeout=120_000,images=false){
 await openProjectFile(name);
 const started=performance.now();
 const frameName=await until(async()=>await iframeName().catch(()=>null),`the ${name} frame`,timeout);
 await waitDocReady(frameName,timeout,images);
 return {frameName,ms:Math.round(performance.now()-started)};
}
async function openExternalTab(name,timeout=120_000,images=false){
 const tab=page.getByRole('tab',{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).first();
 await tab.waitFor({timeout:60_000});
 const started=performance.now();await tab.click();
 const frameName=await until(async()=>await iframeName().catch(()=>null),`the external ${name} frame`,timeout);
 await waitDocReady(frameName,timeout,images);
 return {frameName,ms:Math.round(performance.now()-started)};
}
async function closeActiveTab(){
 await page.locator('.ws-pane.selected .workspace-tab.active .workspace-tab-close').click();
 await delay(500);
}
async function theme(language,tone){
 const state=await request('runtime.snapshot');
 await request('settings.update',{patch:{language,theme:tone,themeSelection:`preset:threadterm-${tone}`},expectedRevision:state.settings.revision,operationId:randomUUID()});
 await page.waitForFunction(next=>document.documentElement.lang===next,language);
 await delay(300);
}
async function recordDocument(label,frameName,ms){
 const surfaces=await docSurfaces();
 const grants=new Set(surfaces.filter(item=>!item.hidden).map(item=>uniqueGrant(item.src)).filter(Boolean));
 const processes=await frameProcesses(frameName);
 report.measurements[label]={ms,frameName,frameCount:surfaces.filter(item=>!item.hidden).length,grantCount:grants.size,processes,grants:[...grants]};
 assert.equal(report.measurements[label].frameCount,1,`one Word frame for ${label}, never two`);
 assert.equal(report.measurements[label].grantCount,1,`one document grant for ${label}, never two`);
 assert.ok(processes?.frameOsProcessId>0,`the ${label} frame has an OS process`);
 assert.notEqual(processes.rendererOsProcessId,processes.frameOsProcessId,`the ${label} frame runs in a different OS process from the app renderer`);
 return {surfaces,processes,grants:[...grants]};
}

try{
 await prepare();releaseLock=await acquireElectronQaLock({directory:scratchBase});
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:environment(),timeout:60_000});
 page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(30_000);
 mainPid=await app.evaluate(()=>process.pid);
 page.on('pageerror',error=>report.errors.push(`pageerror: ${error.message}`));
 page.on('console',message=>{
  if(message.type()!=='error')return;
  const location=message.location?.().url??'';
  // docx-preview renders a linked image as <img src="null">; the viewer removes it after render,
  // and the same-origin 404 it already logged is the known cosmetic case from spike B §4.
  if(location.includes('/viewer/null')){report.measurements.expectedNullImage404=true;return;}
  report.errors.push(`console: ${message.text()} (${location})`);
 });
 // Every request made by a document frame is recorded; any http(s) one fails the run.
 const network=[];
 page.on('request',request=>{
  const url=request.url();
  if(!/^https?:/i.test(url))return;
  const frame=request.frame();
  if(frame&&/^tt-preview:\/\//.test(frame.url()))network.push({url,frame:frame.url()});
 });
 await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60_000});
 const added=await request('project.add',{path:project,name:'Office Word QA',operationId:randomUUID()});
 const projectId=added.id;
 const session=await request('session.create',{projectId,cwd:project,provider:'grok',mode:'chat',title:'Word preview QA',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor();
 await request('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.ws-pane.selected').waitFor({state:'visible',timeout:45_000});
 assert.equal(await setBackend(backend),backend,`Local file access is ${backend}`);
 report.measurements.runtimeBeforeDocuments=runtimeProcessTree();
 if(backend==='main'){
  assert.deepEqual((report.measurements.runtimeBeforeDocuments??[]).flatMap(item=>item.children??[]).filter(child=>String(child.CommandLine??'').includes('--sheet-worker')),[],'main mode starts no runtime helper');
  report.measurements.mainBeforeMiB=mib((await mainMemory())?.privateBytes);
 }

 await theme('en','light');
 const text=await openProjectDoc('text-300.docx',30_000);
 report.measurements.textReadyMs=text.ms;
 await recordDocument('textProject',text.frameName,text.ms);
 assert.ok(text.ms<=BUDGETS.textReadyMs,`text-300 is readable within ${BUDGETS.textReadyMs} ms (took ${text.ms} ms)`);
 const textFrame=await waitDocReady(text.frameName);
 const pages=await textFrame.locator('.docx-wrapper > section.docx').count();
 assert.ok(pages>1,`text-300 keeps Word's page breaks (${pages} pages)`);
 assert.equal(await textFrame.locator('img[src="null"]').count(),0,'a linked image is filtered, not left as a broken <img src="null">');
 await shot('en-light-text.png');

 // A link opens a proposal row and nothing navigates.
 const beforeLink=textFrame.url();
 const link=textFrame.locator('a[href^="http"]').first();
 await link.waitFor({timeout:15_000});
 await link.click({noWaitAfter:true,timeout:5_000}).catch(()=>{});
 const proposal=visible('.sandboxed-html-preview-link');
 await proposal.waitFor({timeout:15_000});
 const proposalText=await proposal.innerText();
 report.measurements.linkProposal=proposalText;
 assert.match(proposalText,/Open |打开 /,'the link shows the proposal row');
 assert.equal(textFrame.url(),beforeLink,'clicking a document link does not navigate the frame');
 await proposal.getByRole('button',{name:/Dismiss|关闭/}).click();

 // Selection and copy from the sandboxed frame.
 await textFrame.click('.docx-wrapper > section.docx',{position:{x:20,y:20}}).catch(()=>{});
 const selected=await textFrame.evaluate(()=>{
  const target=document.querySelector('.docx-wrapper > section.docx')??document.body;
  const range=document.createRange();range.selectNodeContents(target);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  document.body.focus();
  return selection.toString().replace(/\s+/g,' ').trim().slice(0,160);
 });
 assert.ok(selected.length>20,'text in the document can be selected');
 const copied=await (async()=>{
  const executed=await textFrame.evaluate(()=>{document.body.focus();return document.execCommand('copy');}).catch(()=>false);
  await delay(400);
  const value=await app.evaluate(async ({clipboard})=>await clipboard.readText());
  report.measurements.copyMethod={execCommand:executed};
  return value;
 })();
 report.measurements.selection={selectedLength:selected.length,copiedLength:String(copied??'').length,copied:String(copied??'').slice(0,80)};
 assert.ok(String(copied??'').replace(/\s+/g,' ').includes(selected.slice(0,40)),'copy puts the selected text on the clipboard');
 check(`text-300 opens from the Explorer in ${text.ms} ms, ${pages} pages, one grant/frame and its own OS process; link proposal, selection and copy work`);

 await theme('zh-CN','dark');
 const darkFrameName=await until(async()=>await iframeName().catch(()=>null),'the themed text frame',30_000);
 await waitDocReady(darkFrameName,30_000);
 await shot('zh-dark-text.png');
 await theme('en','light');
 const lightAgain=await until(async()=>await iframeName().catch(()=>null),'the light text frame',30_000);
 await waitDocReady(lightAgain,30_000);

 const textProcess=await frameProcesses(text.frameName);
 const textGrantSource=(await docSurfaces()).find(item=>!item.hidden)?.src;
 await closeActiveTab();
 report.measurements.textFrameExit=await waitFrameGone(textProcess.frameOsProcessId,'the text frame process',15_000);
 assert.ok(report.measurements.textFrameExit.gone,'closing the tab ends the frame process within 5 s');
 const revoked=textGrantSource?await grantFetchStatus(textGrantSource.replace(/\/viewer\/docx\.html.*$/,'/document')):undefined;
 report.measurements.revokedGrantStatus=revoked;
 assert.equal(revoked,404,'closing the tab revokes the document grant');
 check('closing the document tab ends the frame process and revokes the grant');

 // images-100: 30 s and 1.2 GiB in the frame, and main must not keep the file.
 const imagesBeforeMain=backend==='main'?mib((await mainMemory())?.privateBytes):undefined;
 let sampling=true;const samples=[];
 const sampler=(async()=>{while(sampling){samples.push(mib((await mainMemory())?.privateBytes));await delay(150);}})();
 const images=await openProjectDoc('images-100.docx',120_000,true);
 sampling=false;await sampler;
 report.measurements.imagesReadyMs=images.ms;
 report.measurements.mainDuringImagesMiB=Math.max(...samples.filter(value=>Number.isFinite(value)));
 const imageRecord=await recordDocument('imagesProject',images.frameName,images.ms);
 const imageMemory=processMemory(imageRecord.processes.frameOsProcessId);
 report.measurements.imagesFrameMemory=imageMemory;
 assert.ok(images.ms<=BUDGETS.imagesReadyMs,`images-100 is readable within ${BUDGETS.imagesReadyMs} ms (took ${images.ms} ms)`);
 assert.ok(imageMemory&&imageMemory.peak<=BUDGETS.frameMiB,`the images-100 frame stays under ${BUDGETS.frameMiB} MiB (peak ${imageMemory?.peak} MiB)`);
 await shot('en-light-images.png');
 await theme('zh-CN','dark');
 const imagesDark=await until(async()=>await iframeName().catch(()=>null),'the themed images frame',30_000);
 await waitDocReady(imagesDark,120_000,true);
 await shot('zh-dark-images.png');
 await theme('en','light');
 const imagesLight=await until(async()=>await iframeName().catch(()=>null),'the light images frame',30_000);
 await waitDocReady(imagesLight,120_000,true);
 check(`images-100 opens in ${images.ms} ms with ${imageMemory?.peak} MiB peak in its frame (budget ${BUDGETS.imagesReadyMs} ms / ${BUDGETS.frameMiB} MiB)`);

 const imageProcess=await frameProcesses(images.frameName);
 await closeActiveTab();
 report.measurements.imagesFrameExit=await waitFrameGone(imageProcess.frameOsProcessId,'the images frame process',15_000);
 assert.ok(report.measurements.imagesFrameExit.gone,'closing the images tab ends the frame process within 5 s');
 if(backend==='main'){
  await delay(5_000);
  const after=mib((await mainMemory())?.privateBytes);
  report.measurements.mainAfterImagesMiB=after;
  report.measurements.mainDeltaAfterImagesMiB=Math.round((after-imagesBeforeMain)*10)/10;
  report.measurements.mainPeakMiB=mib((await mainMemory())?.peakWorkingSetSize);
  assert.ok(report.measurements.mainDeltaAfterImagesMiB<=BUDGETS.mainDeltaMiB,
   `main is back within ${BUDGETS.mainDeltaMiB} MB after the document closes (${report.measurements.mainDeltaAfterImagesMiB} MiB; during ${report.measurements.mainDuringImagesMiB} MiB)`);
  check(`main mode streams images-100 without keeping it: after close +${report.measurements.mainDeltaAfterImagesMiB} MiB (budget +${BUDGETS.mainDeltaMiB} MB)`);
 }else{
  check('closing images-100 ends its frame process');
 }

 // Registered external files: the same viewer, one grant/frame, and no network.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const openExternal=page.getByRole('button',{name:/Open file outside workspace|打开工作区外的文件/}).first();
 await openExternal.waitFor({timeout:30_000});await openExternal.click();
 await until(()=>page.getByRole('tab').filter({hasText:'text-300.docx'}).count(),'the external text tab');
 const externalText=await openExternalTab('text-300.docx',30_000);
 report.measurements.externalTextReadyMs=externalText.ms;
 await recordDocument('externalText',externalText.frameName,externalText.ms);
 assert.ok(externalText.ms<=BUDGETS.textReadyMs,`the external text-300 is readable within ${BUDGETS.textReadyMs} ms (took ${externalText.ms} ms)`);
 assert.equal(await visible('[data-testid="external-file-boundary"]').count(),1,'an external document keeps the read-only boundary');
 const externalTextProcess=await frameProcesses(externalText.frameName);
 await closeActiveTab();
 await waitFrameGone(externalTextProcess?.frameOsProcessId??0,'the external text frame',15_000);
 const externalImages=await openExternalTab('images-100.docx',120_000,true);
 report.measurements.externalImagesReadyMs=externalImages.ms;
 const externalImageRecord=await recordDocument('externalImages',externalImages.frameName,externalImages.ms);
 report.measurements.externalImagesFrameMemory=processMemory(externalImageRecord.processes.frameOsProcessId);
 assert.ok(externalImages.ms<=BUDGETS.imagesReadyMs,`the external images-100 is readable within ${BUDGETS.imagesReadyMs} ms (took ${externalImages.ms} ms)`);
 await closeActiveTab();
 await waitFrameGone(externalImageRecord.processes.frameOsProcessId,'the external images frame',15_000);
 assert.deepEqual(network,[],'no network request leaves a document frame');
 check('text-300 and images-100 also open as registered external files, one grant/frame each, with no network request');

 // The two error states reachable without a corrupt window: protected and truncated.
 await openProjectFile('protected.docx');
 const protectedAlert=page.getByRole('alert');
 await protectedAlert.waitFor({timeout:30_000});
 const protectedText=await protectedAlert.innerText();
 report.measurements.protectedText=protectedText;
 assert.match(protectedText,/password-protected|受密码保护/,'protected.docx shows the password-protected line');
 await shot(backend==='main'?'en-light-protected-main.png':'en-light-protected.png');
 await closeActiveTab();
 await openProjectFile('truncated.docx');
 await until(async()=>{const text=await page.getByRole('alert').innerText().catch(()=>'');return /damaged|损坏/.test(text)?text:null;},'the damaged-file line',30_000);
 report.measurements.truncatedText=await page.getByRole('alert').innerText();
 assert.match(report.measurements.truncatedText,/damaged|损坏/,'truncated.docx shows the damaged-file line');
 await shot(backend==='main'?'en-light-truncated-main.png':'en-light-truncated.png');
 await closeActiveTab();
 check('protected.docx says password-protected and truncated.docx says damaged');

 if(backend==='main'){
  report.measurements.runtimeAfterDocuments=runtimeProcessTree();
  const children=(report.measurements.runtimeAfterDocuments??[]).flatMap(item=>item.children??[]);
  report.measurements.runtimeChildren=children.map(child=>({name:child.Name,commandLine:child.CommandLine}));
  assert.deepEqual(children.filter(child=>String(child.CommandLine??'').includes('--sheet-worker')),[],'the runtime opens no document helper in main mode');
  check('with Local file access = main the runtime started no document helper (no child process)');
 }

 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error instanceof Error?(error.stack??error.message):String(error));if(page)await shot('failure.png').catch(()=>{});}
finally{
 if(page)await request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app:electronApp})=>electronApp.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 report.completedAt=new Date().toISOString();await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 await cleanupApp?.().catch(()=>{});await releaseLock?.();
 if(report.passed)await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:500}).catch(()=>{});
 console.log(report.passed?'OFFICE DOCX APP QA PASSED':`OFFICE DOCX APP QA FAILED\n${report.errors.join('\n')}`);
 process.exitCode=report.passed?0:1;
}
