// Real-app regression probe for issue #22's bounded large-text viewer.
// Run after the worktree runtime and renderer are built:
//   $env:TEMP="$env:TEMP\tt-qa-temp"; $env:TMP=$env:TEMP
//   $env:THREADTERM_V3_RUNTIME_BIN='<absolute path to the worktree runtime executable>'
//   node qa/large-file-preview.mjs
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile,appendFile} from 'node:fs/promises';
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
const scratch=await mkdtemp(join(scratchBase,'tt-issue-22-large-preview-'));
const project=join(scratch,'project'); const outside=join(scratch,'outside'); const bin=join(scratch,'bin'); const appDir=join(scratch,'app');
const out=join(root,'qa/results/large-file-preview');
const report={passed:false,startedAt:new Date().toISOString(),runtime,scratch,checks:[],screenshots:[],measurements:{},errors:[],limitations:[]};
let app,page,releaseLock,cleanupApp,cdp;
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const request=(method,params={})=>page.evaluate(([name,value])=>window.threadterm.request(name,value),[method,params]);
const visible=selector=>page.locator(`.ws-pane.selected .pane-tab-surface:not([hidden]) ${selector}`);
async function heap(){
 if(cdp){try{await cdp.send('HeapProfiler.collectGarbage');const usage=await cdp.send('Runtime.getHeapUsage');return{source:'cdp',usedBytes:usage.usedSize,totalBytes:usage.totalSize};}catch{/* performance.memory remains useful on older Electron CDP */}}
 return page.evaluate(()=>performance.memory?{source:'performance.memory',usedBytes:performance.memory.usedJSHeapSize,totalBytes:performance.memory.totalJSHeapSize}:null);
}
const rendererMemory=()=>app.evaluate(({BrowserWindow,app:electronApp})=>{const pid=BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();const metric=electronApp.getAppMetrics().find(value=>value.pid===pid);return metric?{pid,units:'KiB (Electron ProcessMetric API)',memory:metric.memory}:null;});
const shot=async name=>{await page.screenshot({path:join(out,name)});report.screenshots.push(join('qa/results/large-file-preview',name));};
async function until(test,label,timeout=45_000){const deadline=Date.now()+timeout;for(;;){try{const value=await test();if(value)return value;}catch{}if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await delay(100);}}
function testId(name){return visible(`[data-testid="${name}"]`);}
function largeContent(){return visible('textarea.large-file-content');}
const lastWindow=()=>visible('.large-file-view').evaluate(node=>({start:Number(node.getAttribute('data-window-start')),end:Number(node.getAttribute('data-window-end')),size:Number(node.getAttribute('data-file-size')),source:node.getAttribute('data-window-source')}));
async function waitForActiveFile(name,expected){
 await page.waitForFunction(({name,expected})=>{
  const pane=document.querySelector('.ws-pane.selected');
  const active=[...(pane?.querySelectorAll('[role="tab"][aria-selected="true"]')??[])].some(tab=>(tab.textContent??'').includes(name));
  if(!active)return false;
  if(expected!=='large')return true;
  const view=pane?.querySelector('.pane-tab-surface:not([hidden]) .large-file-view');
  const filePath=view?.getAttribute('data-file-path')?.replaceAll('\\','/')??'';
  return (filePath===name||filePath.split('/').at(-1)===name)&&view.getAttribute('aria-busy')==='false'&&Boolean(view.querySelector('textarea.large-file-content'));
 },{name,expected},{timeout:45_000});
}

async function writeSizedText(path,bytes,{escaped=false,longLine=false}={}){
 // The normal source is ASCII so its exact-size tail cannot make invalid UTF-8.  U+0001
 // is valid UTF-8 and is JSON-escaped as \u0001 (six response bytes per source byte).
 const unit=longLine?'L'.repeat(384*1024):escaped?String.fromCharCode(1).repeat(1024):'line: large file preview fixture\r\n';
 const source=Buffer.from(unit,'utf8'),output=Buffer.alloc(bytes);for(let offset=0;offset<bytes;offset+=source.length)source.copy(output,offset,0,Math.min(source.length,bytes-offset));
 await writeFile(path,output);
}
async function prepare(){
 await Promise.all([mkdir(project,{recursive:true}),mkdir(outside,{recursive:true}),mkdir(bin,{recursive:true}),mkdir(out,{recursive:true})]);
 await writeSizedText(join(project,'project-20m.txt'),20*1024*1024);
 await writeSizedText(join(project,'project-100m.txt'),100*1024*1024);
 await writeSizedText(join(project,'project-long-line.txt'),2*1024*1024,{longLine:true});
 await writeSizedText(join(project,'project-escaped.txt'),2*1024*1024,{escaped:true});
 await writeFile(join(project,'small.txt'),'small full editor fixture\n');
 await writeSizedText(join(outside,'external-20m.txt'),20*1024*1024);
 await writeFile(join(project,'project-binary.txt'),Buffer.from([65,0,66]));
 const fakeGrok=`import {createInterface} from 'node:readline';let next=0;const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id===undefined)return;const reply=result=>send({jsonrpc:'2.0',id:request.id,result});if(request.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},load:{}}}});else if(request.method==='session/new')reply({sessionId:'large-preview-'+(++next)});else if(request.method==='session/list')reply({sessions:[]});else reply({});});`;
 await writeFile(join(bin,'fake-grok.mjs'),fakeGrok);await writeFile(join(bin,'shim.rs'),'fn main(){let status=std::process::Command::new(std::env::var_os("TT_QA_NODE").unwrap()).arg(std::env::var_os("TT_QA_SCRIPT").unwrap()).args(std::env::args_os().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
 const compiled=spawnSync('rustc',['-O',join(bin,'shim.rs'),'-o',join(bin,'grok.exe')],{encoding:'utf8',windowsHide:true});assert.equal(compiled.status,0,compiled.stderr);
 ({cleanup:cleanupApp}=await buildQaApp({root,outDir:appDir}));
}
function environment(){
 const dropped=/^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!dropped.test(key)));
 Object.assign(env,{Path:[bin,dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),TEMP:scratchBase,TMP:scratchBase,HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-issue-22-large-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,THREADTERM_QA_PROVIDER_BIN:bin,THREADTERM_V3_OPEN_EXTERNAL_QA:JSON.stringify([join(outside,'external-20m.txt')])});
 env.TT_QA_NODE=process.execPath;env.TT_QA_SCRIPT=join(bin,'fake-grok.mjs');
 assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path'],'isolated environment has one PATH');return env;
}
async function openProject(path,expected='large'){
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));
 const row=page.locator(`.wb-tree [data-path="${path}"]`).first();await row.waitFor({timeout:45_000});
 const started=performance.now();await row.click();
 await waitForActiveFile(path,expected);
 if(expected==='editor')await visible('.cm-editor').waitFor({timeout:45_000});
 return performance.now()-started;
}
async function activate(name){const tab=page.getByRole('tab',{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).first();await tab.click();await waitForActiveFile(name,'large');}
async function assertViewer(label,source){
 const viewer=visible('.large-file-view');const content=largeContent();await viewer.waitFor();await content.waitFor();
 assert.equal(await content.evaluate(node=>node instanceof HTMLTextAreaElement&&node.readOnly),true,`${label}: viewer textarea is readonly`);
 const state=await content.evaluate(node=>({value:node.value.length,elements:node.children.length,tag:node.tagName,readonly:node.readOnly}));
 assert.equal(state.tag,'TEXTAREA',`${label}: plain-text textarea`);assert.ok(Buffer.byteLength(await content.inputValue(),'utf8')<=256*1024,`${label}: resident UTF-8 window stays within 256 KiB`);assert.equal(state.elements,0,`${label}: content has no rendered HTML elements`);
 assert.ok(await visible('.large-file-position').count(),`${label}: position label visible`);if(source)assert.equal((await lastWindow()).source,source,`${label}: loaded through its ${source} window endpoint`);return state;
}
async function navigate(label,{nextTransitions=1,endScreenshot}={}){
 const content=largeContent();const before=await content.inputValue();const beforePosition=await visible('.large-file-position').innerText();
 const initial=await lastWindow();assert.ok(initial?.start===0,`${label}: initial window begins at zero`);
 const timing={beforeHeap:await heap(),beforeRendererMemory:await rendererMemory(),firstWindowTextBytes:Buffer.byteLength(before,'utf8'),initial};
 const next=testId('large-file-next');const started=performance.now();await next.click();await until(async()=>await visible('.large-file-position').innerText()!==beforePosition,`${label} next window`);timing.nextWindowMs=performance.now()-started;
 const afterNext=await content.inputValue();const afterNextMeta=await lastWindow();assert.ok(afterNextMeta.start<=initial.end&&afterNextMeta.end>initial.end,`${label}: next advances from the previous window`);await testId('large-file-previous').click();await until(async()=>await visible('.large-file-position').innerText()===beforePosition,`${label} previous window`);const afterPreviousMeta=await lastWindow();assert.ok(afterPreviousMeta.start<afterNextMeta.start,`${label}: previous moves backward`);
 const position=testId('large-file-position');await position.fill('50');await position.press('Enter');await until(async()=>await visible('.large-file-position').innerText()!==beforePosition,`${label} jump`);
 await testId('large-file-end').click();await until(async()=>await visible('.large-file-view').getAttribute('aria-busy')==='false',`${label} end read`);const end=await content.inputValue();const endMeta=await lastWindow();assert.ok(end.length>0&&endMeta.end===endMeta.size,`${label}: end reaches file EOF`);if(endScreenshot)await shot(endScreenshot);
 await testId('large-file-start').click();await until(async()=>await visible('.large-file-position').innerText()===beforePosition,`${label} start`);const startMeta=await lastWindow();assert.equal(startMeta.start,0,`${label}: start returns to byte zero`);
 let prior=startMeta;for(let index=0;index<nextTransitions;index++){await testId('large-file-next').click();await until(async()=>{const current=await lastWindow();return current!==prior&&current.end>prior.end;},`${label} bounded next ${index+1}`);const current=await lastWindow();assert.ok(current.start<=prior.end&&current.end>prior.end,`${label}: bounded next ${index+1} advances`);prior=current;}
 await testId('large-file-start').click();await until(async()=>await visible('.large-file-position').innerText()===beforePosition,`${label} final start`);
 timing.afterHeap=await heap();timing.afterRendererMemory=await rendererMemory();timing.afterNextTextBytes=Buffer.byteLength(afterNext,'utf8');timing.nextWindow=afterNextMeta;timing.endWindow=endMeta;timing.afterTenNextWindow=prior;return timing;
}

try{
 await prepare();releaseLock=await acquireElectronQaLock({directory:scratchBase});
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:environment(),timeout:60_000});page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(25_000);
 cdp=await app.context().newCDPSession(page).catch(()=>undefined);
 page.on('pageerror',error=>report.errors.push(`pageerror: ${error.message}`));
 page.on('console',message=>{if(message.type()==='error')report.errors.push(`console: ${message.text()}`);});
 await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60_000});
 const added=await request('project.add',{path:project,name:'Issue 22 large preview QA',operationId:randomUUID()});
 // Outside-workspace files are intentionally routed only through a Chat session.
 const session=await request('session.create',{projectId:added.id,cwd:project,provider:'grok',mode:'chat',title:'Large preview QA',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor();
 await request('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.ws-pane.selected').waitFor({state:'visible',timeout:45_000});
 await openProject('small.txt','editor');assert.equal(await visible('.large-file-view').count(),0,'files at or under 1 MiB retain the normal editor');check('small text files retain the existing full editor');
 report.measurements.project20={firstWindowMs:await openProject('project-20m.txt')};await assertViewer('project 20 MiB','project');Object.assign(report.measurements.project20,await navigate('project 20 MiB',{nextTransitions:10}));await shot('project-20m-start.png');check('20 MiB project file opens as a bounded, read-only plain-text viewer and navigates start/previous/next/jump/end');
 assert.equal(await visible('.cm-editor').count(),0,'large viewer has no editable CodeMirror surface');assert.equal(await visible('[data-testid="file-preview-rendered"]').count(),0,'large viewer has no rendered Markdown surface');assert.equal(await visible('button').filter({hasText:/^Save$/}).count(),0,'large viewer has no save action');assert.deepEqual(await request('draft.list',{projectId:added.id}),[],'large viewer creates no drafts');check('large viewer omits CodeMirror, rendered preview, Save, and drafts');
 report.measurements.project100={firstWindowMs:await openProject('project-100m.txt')};await assertViewer('project 100 MiB','project');Object.assign(report.measurements.project100,await navigate('project 100 MiB',{endScreenshot:'project-100m-end.png'}));check('100 MiB project file stays bounded while navigating');
 report.measurements.longLine={firstWindowMs:await openProject('project-long-line.txt')};await assertViewer('long line','project');Object.assign(report.measurements.longLine,await navigate('long line'));await until(async()=>await visible('.large-file-view').getAttribute('aria-busy')==='false','long line settled');await visible('.large-file-clipped').waitFor();await shot('project-long-line.png');check('an overlong line remains viewable, clipped, and navigable start/previous/next/jump/end');
 await openProject('project-escaped.txt');await assertViewer('escaped','project');const escaped=await request('filesystem.readWindow',{projectId:added.id,path:'project-escaped.txt',offset:0,maxBytes:256*1024});const worst=new TextEncoder().encode(JSON.stringify(escaped)).byteLength;report.measurements.worstEscapedResponseBytes=worst;assert.ok(worst>0&&worst<6*1024*1024,'escaped response stays below the 6 MiB transport cap');check('worst escaped window response remains below the transport response cap');
 // Use the Files-header entry point for the real native-picker bridge; it remains available
 // even when a large textarea currently owns keyboard focus.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));const openExternal=page.getByRole('button',{name:/Open file outside workspace|打开工作区外的文件/}).first();await openExternal.waitFor();await openExternal.click();await until(()=>page.getByRole('tab').filter({hasText:'external-20m.txt'}).count(),'external large file tab');await activate('external-20m.txt');await assertViewer('external 20 MiB','external');report.measurements.external20=await navigate('external 20 MiB');await shot('external-20m.png');check('external 20 MiB file uses the same bounded readonly viewer');
 await appendFile(join(project,'project-20m.txt'),'\nmutation after initial token\n');await activate('project-20m.txt');await testId('large-file-next').click();await until(async()=>await visible('[role="alert"]').count(),'changed-file notice');await testId('large-file-reload').click();await largeContent().waitFor();check('disk mutation is surfaced with one-click reload');
 await openProject('project-binary.txt','error');await until(async()=>/binary|UTF-8/i.test(await visible('.file-workspace').innerText()),'binary treatment');check('NUL-containing input remains on the binary-file path');
 await rm(join(project,'project-20m.txt'),{force:true});await activate('project-20m.txt');await testId('large-file-next').click();await until(async()=>await visible('[role="alert"]').count(),'missing-file notice');check('deleted large files use the existing missing-file error path');
 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error instanceof Error?(error.stack??error.message):String(error));if(page)await shot('failure.png').catch(()=>{});}
finally{
 if(page)await request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});if(app){await app.evaluate(({app:electronApp})=>electronApp.exit(0)).catch(()=>{});await app.close().catch(()=>{});}report.completedAt=new Date().toISOString();await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await Promise.all(['project-20m.txt','project-100m.txt','project-long-line.txt','project-escaped.txt','project-binary.txt','small.txt'].map(name=>rm(join(project,name),{force:true}).catch(()=>{})));await rm(join(outside,'external-20m.txt'),{force:true}).catch(()=>{});await releaseLock?.();console.log(report.passed?'LARGE FILE PREVIEW QA PASSED':`LARGE FILE PREVIEW QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;
}
