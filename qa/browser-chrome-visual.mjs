// Desktop-1 visual QA for the Chrome-style browser pane (task 10-22-browser-chrome-ui). It uses only a
// loopback server and a Node fake provider; no real agent or user profile.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { attachedNativeBrowserPages, dismissBrowserNotifications } from './lib/native-browser.mjs';
import { writeBrowserViewDiagnostics } from './lib/browser-view-diagnostics.mjs';
import { closeBrowserViewFixture, within } from './lib/browser-view-cleanup.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const scratchBase=resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());await mkdir(scratchBase,{recursive:true});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),fixture=join(root,'qa/fixtures/browser-plugins'),out=join(root,'qa/results/browser-chrome-ui',/^[A-Za-z0-9._-]+$/.test(process.argv[2]??'')?process.argv[2]:'current'),scratch=await mkdtemp(join(scratchBase,'tt-browser-chrome-')),appDir=join(scratch,'app'),plugins=join(scratch,'plugins'),bin=join(scratch,'bin'),work=join(scratch,'work'),downloads=join(scratch,'downloads'),events=join(out,'provider-events.jsonl'),pipe=`\\\\.\\pipe\\tt-browser-chrome-${randomUUID()}`;
assert.equal(dirname(resolve(scratch )).toLowerCase(),scratchBase.toLowerCase(),'scratch remains inside the approved QA root');
const report={passed:false,fixtureEventLog:join(out,'provider-events.jsonl'),checks:[],screenshots:[],themes:[],errors:[],limitations:[]}; let app,page,server,baseUrl,runtimeProcess;
const sleep=ms=>new Promise(done=>setTimeout(done,ms)); const check=value=>{report.checks.push(value);console.log('PASS '+value)};
const request=(method,params={})=>page.evaluate(([a,b])=>window.threadterm.request(a,b),[method,params]); const command=value=>page.evaluate(v=>window.threadterm.browserCommand(v),value);
async function until(probe,label,ms=30000){const end=Date.now()+ms;let last;for(;;){const result=await within(probe,Math.max(1,end-Date.now()));if(result.error)last=result.error;else if(!result.timedOut&&result.value)return result.value;if(result.timedOut||Date.now()>=end)throw Error(`Timed out: ${label}${last?`: ${last.message}`:''}`);await sleep(100)}}
async function shot(name){await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
async function buildApp(){await mkdir(appDir,{recursive:true});for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});await writeFile(join(appDir,'package.json'),JSON.stringify({name:'browser-view-visual-qa',version:'1',main:'main.cjs'}))}
function env(){const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe'].includes(key.toLowerCase())));Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_BROWSER_QA_DOWNLOADS:downloads,THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_EVENTS:events,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_QA_BROWSER_URL:baseUrl});assert.equal(Object.keys(value).filter(key=>key.toLowerCase()==='path').length,1,'PATH isolation keeps exactly one spelling');return value}
const preview=()=>page.locator('.wb-web-preview:visible').first();
async function tabId(){const id=await preview().getAttribute('data-web-tab-id');assert.ok(id,'visible native browser tab id');return id}
async function state(){return command({type:'state',tabId:await tabId()})}
async function startRuntime(){if(runtimeProcess)return;runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});await until(async()=>{if(runtimeProcess.exitCode!==null||runtimeProcess.signalCode!==null)throw Error('fixture runtime exited during startup');let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim());return true}finally{peer?.close();}},'fixture runtime control pipe')}
async function start(restoredWorkspaceId){await startRuntime();app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));await page.waitForFunction(()=>Boolean(window.threadterm?.browserCommand));await page.locator('#boot-splash').waitFor({state:'detached'});await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'isolated fake Codex provider');const snap=await request('runtime.snapshot');await request('settings.update',{patch:{language:'en',theme:'light',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});if(restoredWorkspaceId){await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{workspaceId:id}),restoredWorkspaceId);await until(()=>preview().locator('.wb-browser-toolbar').count(),'restored native browser toolbar');return;}const project=(await request('runtime.snapshot')).projects?.[0]??await request('project.add',{path:work,name:'Browser QA',operationId:randomUUID()});const chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Browser QA',operationId:randomUUID()});await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),chat.id);const composer=page.locator('.chat-compose-shell textarea');await composer.waitFor();await composer.fill('open preview');await page.locator('.chat-compose-send[type=submit]').click();await until(()=>preview().locator('.wb-browser-toolbar').count(),'browser toolbar mounted');await preview().locator('.tt-browser-view').waitFor()}
async function close(final=false){const errors=await closeBrowserViewFixture({app,page,server:final?server:undefined,runtime:final?runtimeProcess:undefined,shutdownRuntime:false});report.errors.push(...errors);app=undefined;page=undefined;if(final)runtimeProcess=undefined}
async function nativePage(){return until(async()=>{await dismissBrowserNotifications(page);const attached=await attachedNativeBrowserPages(app,page);return attached.length===1?attached[0]:undefined;},'attached native WebContentsView automation target')}
async function nativePoint(selector){const content=await nativePage(),rect=await content.boundingBox(selector),box=await preview().locator('.tt-browser-view').boundingBox();assert.ok(rect&&box,'native target and placeholder bounds');return{x:box.x+rect.x+rect.width/2,y:box.y+rect.y+rect.height/2,localX:rect.x+rect.width/2,localY:rect.y+rect.height/2}}
async function clickNativeSelector(selector){await until(async()=>{const content=await nativePage();if(!await content.boundingBox(selector))return false;await content.click(selector);return true;},`native click ${selector}`)}
async function setTheme(theme){const snap=await request('runtime.snapshot'),custom={background:'#0b1016',surface:'#182430',text:'#f2f6fb',muted:'#93a3b5',accent:'#ff7a45',border:'#26323f'};await request('settings.update',{patch:theme==='custom'?{theme:'dark',themeSelection:'custom:browser-qa',customThemes:{'browser-qa':custom}}:{theme,themeSelection:theme},expectedRevision:snap.settings.revision,operationId:randomUUID()});await page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme==='custom'?'dark':theme);if(theme==='custom')await page.waitForFunction(()=>document.documentElement.dataset.customTheme==='true')}
function html(title,body){return `<!doctype html><title>${title}</title><style>body{font:16px sans-serif;padding:16px;margin:0}a{display:block;margin:12px 0}</style>${body}`}
// --- Chrome-style browser pane checks (design.md of task 10-22-browser-chrome-ui) ---
// Usage: node qa/browser-chrome-visual.mjs [label]. Never clicks "Open in browser" (it opens the user's real browser).
const toolbarSelector='.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-toolbar';
const consolePage=html('console',`<p id="comment-target">Chrome-style browser QA page</p><a id="download-link" href="/download">download</a><p>Find needle. Find needle.</p><script>console.error('qa error one');console.error('qa error two');console.warn('qa warning');</script>`);
await new Promise(done=>{server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/slow'){res.writeHead(200,{'content-type':'text/html'});res.write('<!doctype html><title>slow</title><p>Loading response');const timer=setTimeout(()=>res.end('</p>'),15000);res.on('close',()=>clearTimeout(timer));return}
 if(url.pathname==='/download'){res.writeHead(200,{'content-type':'text/plain','content-disposition':'attachment; filename="browser-qa.txt"'});res.end('browser QA');return}
 if(url.pathname==='/warn'){res.writeHead(200,{'content-type':'text/html'});res.end(html('warn','<p>Only a warning</p><script>console.warn("qa warning only")</script>'));return}
 res.writeHead(200,{'content-type':'text/html'});res.end(url.pathname==='/console'?consolePage:html(url.pathname.slice(1)||'home',`<p>${url.pathname}</p>`))});server.listen(0,'127.0.0.1',done)});baseUrl=`http://127.0.0.1:${server.address().port}`;
const port=server.address().port;
const pane=()=>preview().locator('xpath=ancestor::section[contains(concat(" ",normalize-space(@class)," ")," workspace-pane ")][1]');
async function paneShot(name){const box=await pane().boundingBox();assert.ok(box,'browser pane bounds');await page.mouse.move(0,0);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.screenshot({path:join(out,name),clip:box,animations:'disabled'});report.screenshots.push(name)}
async function consistent(selector,label){const result=await checkControlConsistency(page,selector,{checkStates:true,checkDisabledRows:true});report.consistency.push({label,selector,violations:result.violations?.length??0});assertNoControlViolations(result,label)}
async function loaded(path){const id=await tabId();await command({type:'navigate',tabId:id,url:`${baseUrl}${path}`});await until(async()=>{const value=await state();return value.url===`${baseUrl}${path}`&&!value.loading&&value.navigation==='load_observed'},`${path} loaded`);await preview().locator('.wb-browser-address input').evaluate(input=>input.blur())}
// Geometry of the toolbar: rows, control sizes, clipping, overflow and the omnibox pill.
async function toolbarGeometry(){return preview().locator('.wb-browser-toolbar').evaluate(toolbar=>{
 const rect=toolbar.getBoundingClientRect(),box=element=>{const value=element.getBoundingClientRect();return{x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom}};
 const visible=element=>{const value=element.getBoundingClientRect();return value.width>0&&value.height>0&&getComputedStyle(element).visibility!=='hidden'};
 const controls=[...toolbar.querySelectorAll('button')].filter(visible).map(button=>({label:button.getAttribute('aria-label')||button.textContent.trim(),...box(button),radius:getComputedStyle(button).borderTopLeftRadius}));
 const address=toolbar.querySelector('.wb-browser-address'),style=getComputedStyle(address);
 return{rect:box(toolbar),scrollWidth:toolbar.scrollWidth,clientWidth:toolbar.clientWidth,controls,navigation:box(toolbar.querySelector('.wb-browser-navigation')),actions:box(toolbar.querySelector('.wb-browser-actions')),address:{...box(address),radius:style.borderTopLeftRadius,background:style.backgroundColor}};
})}
function assertToolbar(geometry,label){
 const {rect,controls,navigation,actions,address}=geometry;
 for(const control of controls){
  assert.ok(Math.abs(control.height-28)<=0.5,`${label}: ${control.label} is 28 px tall (${control.height})`);
  assert.ok(control.x>=rect.x-0.5&&control.right<=rect.right+0.5&&control.y>=rect.y-0.5&&control.bottom<=rect.bottom+0.5,`${label}: ${control.label} is not clipped`);
 }
 assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,`${label}: no horizontal overflow (${geometry.scrollWidth} > ${geometry.clientWidth})`);
 assert.ok(Math.abs(address.height-32)<=0.5&&address.radius==='16px',`${label}: omnibox is a 32 px pill (${address.height}, ${address.radius})`);
 assert.ok(address.width>=119.5,`${label}: omnibox keeps at least 120 px (${address.width})`);
 if(rect.width>=550){assert.ok(Math.abs(navigation.y+navigation.height/2-(actions.y+actions.height/2))<1,`${label}: toolbar fits one row at ${Math.round(rect.width)} px`);assert.ok(Math.abs(rect.height-41)<=1.5,`${label}: toolbar is 40 px plus its separator (${rect.height})`)}
 else assert.ok(actions.right>=rect.right-12.5,`${label}: wrapped actions stay right-aligned`);
}
// WCAG contrast of an element's text/glyph colour against the background it sits on (alpha composited).
async function contrast(selector,label,minimum,property='color'){
 const ratio=await page.locator(selector).first().evaluate((element,property)=>{
  const probe=document.createElement('i');document.body.append(probe);
  const rgba=value=>{probe.style.color='';probe.style.color=value;const computed=getComputedStyle(probe).color;const numbers=computed.match(/[\d.]+/g).map(Number);
   if(computed.startsWith('color(srgb'))return{r:numbers[0]*255,g:numbers[1]*255,b:numbers[2]*255,a:numbers[3]??1};return{r:numbers[0],g:numbers[1],b:numbers[2],a:numbers[3]??1}};
  const over=(top,bottom)=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a),a:1});
  let background={r:255,g:255,b:255,a:1};const layers=[];for(let node=element;node;node=node.parentElement)layers.push(rgba(getComputedStyle(node).backgroundColor));
  for(const layer of layers.reverse())background=over(layer,background);
  const foreground=over(rgba(getComputedStyle(element)[property]),background);probe.remove();
  const luminance=({r,g,b})=>{const channel=value=>{value/=255;return value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4};return 0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b)};
  const [high,low]=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return (high+0.05)/(low+0.05);
 },property);
 report.contrast.push({label,selector,ratio:Number(ratio.toFixed(2))});assert.ok(ratio>=minimum,`${label}: contrast ${ratio.toFixed(2)} < ${minimum}`);
}
async function resizePane(target){
 const divider=page.locator('[data-split-id] > .pane-divider').first();await until(()=>divider.count(),'workspace divider');
 for(let attempt=0;attempt<4;attempt++){
  const width=(await pane().boundingBox()).width;if(Math.abs(width-target)<=24)return width;
  const point=await divider.evaluate(node=>{const rect=node.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+(width-target),point.y,{steps:8});await page.mouse.up();await sleep(200);
 }
 const width=(await pane().boundingBox()).width;assert.ok(Math.abs(width-target)<=40,`pane resized to ${Math.round(width)} px (wanted ${target})`);return width;
}
report.consistency=[];report.contrast=[];report.geometry=[];
try{assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);await mkdir(out,{recursive:true});await mkdir(bin,{recursive:true});await mkdir(work,{recursive:true});await mkdir(plugins,{recursive:true});cpSync(fixture,join(plugins,'browser-preview-acp-qa'),{recursive:true});await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(fixture,'fake-codex-browser.cjs')}" %*\r\n`);await buildApp();await start();
 await setTheme('light');await loaded('/console');
 const toolbar=preview().locator('.wb-browser-toolbar'),address=preview().getByLabel('Address',{exact:true});
 // 1. Idle toolbar: geometry, consistency, the Chrome URL display and the console badge.
 let geometry=await toolbarGeometry();report.geometry.push({label:'idle light default',...geometry});assertToolbar(geometry,'idle light default');
 await consistent(toolbarSelector,'idle toolbar light');
 const overlay=preview().locator('.wb-browser-address .wb-browser-url');await overlay.waitFor();
 assert.equal((await overlay.innerText()).trim(),`127.0.0.1:${port}/console`,'blurred omnibox hides the scheme and shows host + path');
 assert.equal(await overlay.getAttribute('aria-hidden'),'true','the URL display is aria-hidden');
 assert.equal(await address.inputValue(),`${baseUrl}/console`,'the input keeps the full URL as its value');
 assert.equal(await address.evaluate(input=>getComputedStyle(input).color),'rgba(0, 0, 0, 0)','the input text is hidden under the URL display');
 const hostColor=await overlay.locator(':scope > *').first().evaluate(node=>getComputedStyle(node).color),restColor=await overlay.locator(':scope > *').last().evaluate(node=>getComputedStyle(node).color);
 assert.notEqual(hostColor,restColor,'host and path use different emphasis');
 assert.ok(await preview().locator('.wb-browser-address [aria-hidden="true"] .ico, .wb-browser-address .ico[aria-hidden="true"], .wb-browser-address svg').count()>=1,'the omnibox shows a leading page glyph');
 await address.click();
 assert.equal(await overlay.isVisible(),false,'focus hides the URL display');
 assert.deepEqual(await address.evaluate(input=>[input.selectionStart,input.selectionEnd,input.value.length]),[0,`${baseUrl}/console`.length,`${baseUrl}/console`.length],'focus selects the whole URL');
 await paneShot('omnibox-focused-light.png');
 await address.evaluate(input=>input.blur());await overlay.waitFor();
 const consoleButton=toolbar.getByRole('button',{name:'Page console',exact:true});
 await until(async()=>(await consoleButton.getAttribute('data-count'))==='2','console badge counts the two errors');
 assert.equal(await consoleButton.getAttribute('data-severity'),'error');
 assert.equal((await consoleButton.textContent()).trim(),'','the console button has no text content (icon-only)');
 assert.equal(await consoleButton.evaluate(node=>getComputedStyle(node,'::after').content),'"2"','the badge is drawn from data-count');
 await paneShot('idle-light-default.png');
 check('idle toolbar: 40 px row, 28 px round controls, 32 px pill omnibox, Chrome URL display, select-all on focus, CSS console badge');
 // 2. Loading: the spinner sits in the omnibox's leading slot; Reload becomes Stop.
 const id=await tabId();await command({type:'navigate',tabId:id,url:`${baseUrl}/slow`});
 await until(async()=>(await preview().locator('.wb-browser-address .wb-browser-loading').count())===1,'loading spinner inside the omnibox');
 await toolbar.getByRole('button',{name:'Stop',exact:true}).waitFor();await consistent(toolbarSelector,'loading toolbar light');await paneShot('loading-light.png');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await preview().locator('.wb-browser-loading').evaluate(node=>getComputedStyle(node).animationName),'none','reduced motion stops the spinner');await page.emulateMedia({reducedMotion:'no-preference'});
 await toolbar.getByRole('button',{name:'Stop',exact:true}).click();await until(async()=>!(await state()).loading,'stop');
 check('loading: spinner in the omnibox, Stop glyph, reduced motion stops it');
 // 3. Zoom chip inside the omnibox.
 await loaded('/console');await command({type:'zoom',tabId:id,factor:1.1});
 const zoom=preview().locator('.wb-browser-address .wb-browser-zoom');await zoom.waitFor();assert.equal(await zoom.getAttribute('aria-label'),'110%','the zoom level stays the accessible name');assert.equal(await zoom.getAttribute('title'),'Reset zoom (110%)');assert.equal((await zoom.textContent()).trim(),'','the zoom indicator is icon-only like Chrome');
 geometry=await toolbarGeometry();assertToolbar(geometry,'zoomed light');await consistent(toolbarSelector,'zoomed toolbar light');await paneShot('zoom-light.png');
 await zoom.click();await until(async()=>(await state()).zoom===1,'zoom chip resets');await zoom.waitFor({state:'detached'});
 check('zoom: an icon-only magnifier inside the omnibox (level in its label) resets the zoom');
 // 4. Find card.
 await toolbar.getByRole('button',{name:'Find in page',exact:true}).click();const find=preview().locator('.wb-browser-find-row > .wb-browser-find');await find.waitFor();
 await preview().getByRole('textbox',{name:'Find in page'}).fill('Find needle');await until(async()=>(await state()).find?.matches===2,'find matches');
 const card=await find.boundingBox(),row=await preview().locator('.wb-browser-find-row').boundingBox();assert.ok(card.width<=380.5&&card.x+card.width>=row.x+row.width-12.5,'the find card is at most 380 px and right-aligned');
 await consistent('.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-find','find card light');await paneShot('find-light.png');
 await preview().getByRole('button',{name:'Close find'}).click();await find.waitFor({state:'detached'});
 check('find: a right-aligned card with count and round buttons');
 // 5. Console infobar.
 await consoleButton.click();const consoleBar=preview().locator('.wb-browser-console-actions.wb-browser-infobar');await consoleBar.waitFor();
 await consistent('.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-console-actions','console infobar light');await paneShot('console-light.png');await consoleButton.click();await consoleBar.waitFor({state:'detached'});
 await loaded('/warn');await until(async()=>(await consoleButton.getAttribute('data-severity'))==='warning'&&Number(await consoleButton.getAttribute('data-count'))>=1,'warning-only badge');
 await loaded('/console');check('console: infobar with the send action; badge shows errors, else warnings');
 // 6. Comment picking: pressed icon + hint infobar.
 const comment=toolbar.getByRole('button',{name:'Comment',exact:true});await comment.click();
 const hint=preview().locator('.wb-browser-infobar.wb-page-comment-hint');await hint.waitFor();
 const cancel=toolbar.getByRole('button',{name:'Cancel',exact:true});assert.equal(await cancel.getAttribute('aria-pressed'),'true');
 await consistent(toolbarSelector,'picking toolbar light');await paneShot('comment-picking-light.png');await cancel.click();await hint.waitFor({state:'detached'});
 check('comment: icon toggle with a hint infobar');
 // 7. Agent access Read and Control.
 const share=name=>toolbar.getByRole('button',{name:`Agent access ${name}`,exact:true});
 await until(()=>share('Read').isEnabled(),'Read becomes available');await share('Read').click();
 await until(async()=>(await state()).sharing?.level==='read','sharing read');const status=preview().locator('.wb-browser-sharing-status.wb-browser-infobar');await status.waitFor();
 await consistent(toolbarSelector,'sharing read toolbar light');await paneShot('sharing-read-light.png');
 if(await share('Control').isEnabled()){await share('Control').click();const dialog=page.getByRole('dialog',{name:'Allow agents to control this page?'});await dialog.waitFor();await paneShot('control-confirm-light.png');await dialog.getByRole('button',{name:'Allow Control',exact:true}).click();
  await until(async()=>(await state()).sharing?.level==='control','sharing control');await until(async()=>(await status.getAttribute('data-level'))==='control','control infobar');await paneShot('sharing-control-light.png');check('agent access: segmented Read/Control with Chrome-style sharing infobars');}
 else{report.limitations.push('Control is unavailable on this native view; only Read was captured');check('agent access: segmented Read with a Chrome-style sharing infobar');}
 await share('Off').click();await until(async()=>(await state()).sharing?.level!=='read'&&(await state()).sharing?.level!=='control','sharing off');await paneShot('sharing-off-reason-light.png');// An existing stop reason ("Browser sharing turned off.") stays visible after Off.
 // 8. Issue infobar and download notice.
 await command({type:'navigate',tabId:id,url:'javascript:alert(1)'});const issue=preview().locator(':scope > .wb-issue').first();await issue.waitFor();
 assert.notEqual(await issue.evaluate(node=>getComputedStyle(node,'::before').maskImage||getComputedStyle(node,'::before').webkitMaskImage),'none','the issue bar has a CSS alert glyph');await paneShot('issue-light.png');
 await loaded('/console');await clickNativeSelector('#download-link');const note=preview().locator('.wb-web-preview-note');await note.waitFor();await consistent('.pane-tab-surface:not([hidden]) .wb-web-preview .wb-web-preview-note','download notice light');await paneShot('download-light.png');
 check('issue and download bars use the infobar look');
 // 9. Themes: idle and a busy toolbar (zoom + find + console) with contrast checks.
 for(const theme of ['light','dark','custom']){
  await setTheme(theme);await loaded('/console');await paneShot(`idle-${theme}.png`);await consistent(toolbarSelector,`idle toolbar ${theme}`);
  await contrast('.pane-tab-surface:not([hidden]) .wb-browser-url > *',`${theme} URL host`,4.5);
  await contrast('.pane-tab-surface:not([hidden]) .wb-browser-url > *:last-child',`${theme} URL path`,4.5);
  await contrast('.pane-tab-surface:not([hidden]) .wb-browser-navigation button:not(:disabled)',`${theme} toolbar glyph`,3);
  await contrast('.pane-tab-surface:not([hidden]) .wb-browser-share button[aria-pressed="true"]',`${theme} selected agent access`,4.5);
  await command({type:'zoom',tabId:id,factor:1.25});await toolbar.getByRole('button',{name:'Find in page',exact:true}).click();await preview().getByRole('textbox',{name:'Find in page'}).fill('needle');await consoleButton.click();
  await preview().locator('.wb-browser-console-actions').waitFor();await paneShot(`busy-${theme}.png`);await consistent(toolbarSelector,`busy toolbar ${theme}`);
  await contrast('.pane-tab-surface:not([hidden]) .wb-browser-console-actions',`${theme} infobar text`,4.5);
  await preview().getByRole('button',{name:'Close find'}).click();await consoleButton.click();await command({type:'zoom',tabId:id,factor:1});
 }
 check('light, dark and custom: consistent controls and readable contrast');
 // 10. Widths: wide, sidebar, narrow and very narrow panes.
 await setTheme('light');
 for(const target of [1000,700,480,380]){
  const width=Math.round(await resizePane(target));await loaded('/console');await command({type:'zoom',tabId:id,factor:1.1});
  geometry=await toolbarGeometry();report.geometry.push({label:`pane ${width}`,...geometry});assertToolbar(geometry,`pane ${width}`);await consistent(toolbarSelector,`toolbar at ${width} px`);
  await paneShot(`width-${target}-light.png`);if(target<=480){await setTheme('dark');await paneShot(`width-${target}-dark.png`);await setTheme('light')}
  await command({type:'zoom',tabId:id,factor:1});
 }
 check('1000, 700, 480 and 380 px panes: one row from 550 px, wrapped actions right-aligned below, nothing clipped or overflowing');
 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error?.stack??String(error));if(page)await within(()=>shot('failure.png'),5_000);process.exitCode=1}finally{if(app&&page)await within(()=>writeBrowserViewDiagnostics(app,page,out),5_000).then(result=>{if(result.timedOut)report.errors.push('Diagnostics timed out after 5000 ms');else if(result.error)report.errors.push(`Diagnostics: ${String(result.error)}`)});await close(true);if(report.errors.length)report.passed=false;await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});process.exitCode=report.passed?0:1;console.log(report.passed?'BROWSER CHROME VISUAL QA PASSED':`BROWSER CHROME VISUAL QA FAILED\n${report.errors.join('\n')}`)}
if(report.errors.length)process.exit(1);
