// Actual Electron/runtime acceptance QA for browser bindings. Run only after
// runtime and renderer builds are current: node qa/agent-browser-plugins.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build as esbuild } from 'esbuild'; import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { attachedBrowserPages, writeBrowserViewDiagnostics } from './lib/browser-view-diagnostics.mjs';
const packagedExecutable=process.argv[2]?resolve(process.argv[2]):undefined;
const scratchRoot=resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());await mkdir(scratchRoot,{recursive:true});
const root=resolve(fileURLToPath(new URL('..',import.meta.url))), runtime=packagedExecutable?join(dirname(packagedExecutable),'resources/runtime/threadterm-v3-runtime.exe'):process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'), fixture=join(root,'qa/fixtures/browser-plugins'), out=join(root,packagedExecutable?'qa/results/agent-browser-plugins/package':'qa/results/agent-browser-plugins'), scratch=await mkdtemp(join(scratchRoot,'tt-browser-plugins-'));
assert.equal(dirname(resolve(scratch)).toLowerCase(),resolve(scratchRoot).toLowerCase(),'scratch remains inside the approved QA root');
const http=createServer((_,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<button id="browser-qa-target">Browser QA target</button>')});
await new Promise(done=>http.listen(0,'127.0.0.1',done));
const previewUrl=`http://127.0.0.1:${http.address().port}`;
const report={passed:false,fixtureEventLog:join(out,'provider-events.jsonl'),scratch,checks:[],screenshots:[],errors:[],limitations:['Uses deterministic local provider fixtures and loopback URLs; it never launches a live model or external browser.']}; let app,page; const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const check=x=>{report.checks.push(x);console.log('PASS '+x)}; const request=(m,p={})=>page.evaluate(([a,b])=>window.threadterm.request(a,b),[m,p]);
async function until(f,label,ms=30000){const end=Date.now()+ms;for(;;){try{const v=await f();if(v)return v}catch{}if(Date.now()>end)throw Error('Timed out: '+label);await sleep(120)}}
async function verifyNativePage(path,name){
 const native=await until(async()=>{const attached=await attachedBrowserPages(app,page);return attached.length===1?attached[0]:undefined;},'attached native page beside Chat');
 await native.locator('#browser-qa-target').waitFor();assert.equal(native.url(),new URL(path,previewUrl).href);
 const bounds=await page.locator('.wb-web-preview:visible .tt-browser-view[data-native-ready="true"]').boundingBox();assert.ok(bounds&&bounds.width>0&&bounds.height>0,'native placeholder is visibly sized');
 await native.screenshot({path:join(out,name)});report.screenshots.push(name);
}
async function build(dir){await mkdir(dir,{recursive:true});for(const n of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${n}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(dir,`${n}.cjs`),logLevel:'error'});await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(dir,'renderer'),emptyOutDir:true}});await writeFile(join(dir,'package.json'),JSON.stringify({name:'browser-plugin-qa',version:'1',main:'main.cjs'}));}
const events=async path=>(await readFile(path,'utf8').catch(()=>'' )).split(/\r?\n/).filter(Boolean).map(JSON.parse);
async function sendPreview(eventFile,control) {
 const count=(await events(eventFile)).filter(e=>e.name==='mcp.present').length;
 const composer=page.locator('.chat-compose-shell textarea').filter({visible:true}).first();
 const sessionId=await composer.evaluate(element=>element.closest('[data-testid^="session-chat-"]').getAttribute('data-testid').slice('session-chat-'.length));
 await until(async()=>{const session=(await request('runtime.snapshot')).sessions.find(item=>item.id===sessionId);return session&&session.status!=='running'&&session.status!=='waiting'&&await page.locator('.chat-first-response-wait').count()===0},'previous native turn settled');
 await composer.click();
 await composer.fill(`qa-preview ${JSON.stringify(control)}`);
 await until(()=>page.locator('.chat-compose-send[type=submit]').filter({visible:true}).first().isEnabled(),'filled composer is writable');
 await page.locator('.chat-compose-send[type=submit]').filter({visible:true}).first().click();
 return until(async()=>{const rows=(await events(eventFile)).filter(e=>e.name==='mcp.present');return rows.length>count?rows.at(-1).detail:undefined},`MCP ${control.requestId}`);
}
const paneCount=()=>page.locator('.workspace-pane').count();
try { assert.ok(existsSync(runtime),`missing ${runtime}`); await mkdir(out,{recursive:true}); const appDir=join(scratch,'app'),plugins=join(scratch,'plugins'),bin=join(scratch,'bin'),work=join(scratch,'work'),eventFile=join(out,'provider-events.jsonl'); await writeFile(eventFile,''); if(!packagedExecutable)await build(appDir); await mkdir(bin,{recursive:true});await mkdir(work,{recursive:true});cpSync(fixture,join(plugins,'browser-preview-acp-qa'),{recursive:true});await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(fixture,'fake-codex-browser.cjs')}" %*\r\n`);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!['path','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','temp','tmp'].includes(k.toLowerCase())));Object.assign(env,{Path:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),TEMP:scratch,TMP:scratch,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-browser-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_EVENTS:eventFile,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_QA_BROWSER_URL:previewUrl});
 if(packagedExecutable)delete env.THREADTERM_V3_RUNTIME;
 app=await electron.launch({...(packagedExecutable?{executablePath:packagedExecutable,args:[]}:{args:[appDir]}),cwd:root,env,timeout:60000});if(packagedExecutable){assert.equal(await app.evaluate(({app})=>app.isPackaged),true);check('packaged Electron uses its bundled runtime and MCP executable without development overrides');}page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>m.type()==='error'&&report.errors.push(m.text()));await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('#boot-splash').waitFor({state:'detached',timeout:15000});
 let snap=await request('runtime.snapshot');await request('settings.update',{patch:{language:'en',theme:'light',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});const project=await request('project.add',{path:work,name:'Browser QA',operationId:randomUUID()});
 const codex=await until(async()=>{const p=await request('provider.list');return p.find(x=>x.id==='codex'&&x.chat)?p:undefined},'isolated Codex');const chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Codex preview QA',operationId:randomUUID()});await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),chat.id);const box=page.locator('.chat-compose-shell textarea');await box.waitFor();await box.fill('open preview');await page.locator('.chat-compose-send[type=submit]').click();await until(async()=> (await events(eventFile)).some(e=>e.name==='mcp.present'),'actual Codex MCP preview call');await until(async()=> (await page.locator('.wb-web-preview .tt-browser-view').count())>0,'renderer native-view acknowledgement');const log=await events(eventFile);assert.ok(log.some(e=>e.name==='mcp.tools'&&e.detail.names.includes('preview_present')&&e.detail.names.includes('preview_status')),'session-local MCP exposed preview tools');const presented=log.find(e=>e.name==='mcp.present');assert.equal(presented?.detail.isError,false,'preview tool must not return an MCP error');assert.equal(presented?.detail.state,'presented','preview tool must report renderer acknowledgement');await verifyNativePage('/codex','codex-native-page.png');check('isolated Codex composer received a session-local MCP override and actual preview_present mounted a native browser view');
 assert.equal(await paneCount(),2,'first preview creates exactly one sibling browser pane');
 await page.evaluate(()=>{window.qaPreviewEvents=[];window.threadterm.onEvent(event=>{if(event.event==='preview.present')window.qaPreviewEvents.push(event);});window.qaOriginalNativeView=document.querySelector('.wb-web-preview .tt-browser-view');});
 for(let index=0;index<2;index++){
  const actions=page.getByRole('button',{name:'Workspace actions',exact:true});
  if(await actions.getAttribute('aria-expanded')!=='true')await actions.click();
  await page.getByRole('button',{name:'Split down',exact:true}).click();
 }
 await page.keyboard.press('Escape');
 await until(async()=>await paneCount()===4,'four actual workspace panes');
 const cap=await sendPreview(eventFile,{requestId:'cap-page',path:'cap',title:'Cap page'});
 assert.equal(cap.isError,false);assert.equal(cap.state,'presented');assert.equal(await paneCount(),4);
 assert.equal(await page.locator('.browser-page-tab').count(),2,'new page shares browser pane at cap');
 assert.equal(await page.evaluate(()=>window.qaOriginalNativeView.isConnected),true,'original native page placeholder remains mounted');
 check('a new page at the four-pane limit reuses the browser pane and preserves the original native page placeholder');
 const beforeDuplicate=await page.locator('.browser-page-tab').count();
 const duplicate=await sendPreview(eventFile,{requestId:'cap-page',path:'cap',title:'Cap page'});
 assert.equal(duplicate.state,'presented');assert.equal(await page.locator('.browser-page-tab').count(),beforeDuplicate);
 check('identical request retry creates no additional page tab');
 const captured=await page.evaluate(()=>window.qaPreviewEvents.at(-1));
 await page.locator('.browser-page-tab.active .browser-page-tab-close').click();
 await until(async()=>await page.locator('.browser-page-tab').count()===1,'closed page preserves sibling');
 await app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:event',event),captured);
 await sleep(350);assert.equal(await page.locator('.browser-page-tab').count(),1,'late closed event does not reopen');
 const closed=await sendPreview(eventFile,{requestId:'cap-page',path:'cap',title:'Cap page'});
 assert.equal(closed.state,'closed');assert.equal(await page.locator('.browser-page-tab').count(),1);
 check('closed request retries and late delivered events cannot reopen a page');
 await page.screenshot({path:join(out,'codex-light-en-wide.png'),animations:'disabled'});report.screenshots.push('codex-light-en-wide.png');
 await request('plugin.setEnabled',{pluginId:'browser-preview-acp-qa',enabled:true,operationId:randomUUID()});const acp=await until(async()=>{const p=await request('provider.list');return p.find(x=>x.id==='browser-preview-echo'&&x.chat)},'public ACP binding');const acpChat=await request('session.create',{projectId:project.id,cwd:work,provider:acp.id,mode:'chat',title:'ACP preview QA',operationId:randomUUID()});await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),acpChat.id);await page.locator('.chat-compose-shell textarea').fill('open ACP preview');await page.locator('.chat-compose-send[type=submit]').click();const acpResult=await until(async()=> (await events(eventFile)).find(e=>e.event==='previewResult'),'ACP fixture MCP call');assert.equal(acpResult.detail.call.isError,false,'ACP preview must not return an MCP error');assert.equal(JSON.parse(acpResult.detail.call.content[0].text).state,'presented','ACP preview requires actual UI acknowledgment');assert.ok((await events(eventFile)).some(e=>e.event==='mcpTools'&&e.detail.names.includes('preview_present')&&e.detail.names.includes('preview_status')),'ACP catalog includes actual preview tools');await until(async()=>await page.locator('.wb-web-preview:visible .tt-browser-view').count()>0,'ACP visible native browser beside Chat');await verifyNativePage('/acp','acp-native-page.png');check('user-installed ACP binding receives normal mcpServers transport and calls the same preview tool without a core provider-ID special case');
 for(const [lang,theme,width] of [['en','dark',1280],['zh-CN','light',420],['zh-CN','dark',420]]){await app.evaluate(({BrowserWindow},w)=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(300,300);window.setContentSize(w,900)},width);snap=await request('runtime.snapshot');await request('settings.update',{patch:{language:lang,theme},expectedRevision:snap.settings.revision,operationId:randomUUID()});await sleep(250);assert.equal(await page.evaluate(()=>innerWidth),width,'actual viewport matches narrow QA width');const name=`preview-${lang}-${theme}-${width}.png`;await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name);}check('captured real preview UI in English/Chinese, light/dark, wide and narrow layouts');assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(e){report.errors.push(e.stack||String(e));if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{})}finally{if(app&&page)await writeBrowserViewDiagnostics(app,page,out).catch(error=>report.errors.push(`Diagnostics: ${String(error)}`));if(page)await page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})).catch(()=>{});if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}await new Promise(done=>http.close(done));report.completedAt=new Date().toISOString();await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(report.passed?'AGENT BROWSER PLUGINS QA PASSED':`AGENT BROWSER PLUGINS QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;}
