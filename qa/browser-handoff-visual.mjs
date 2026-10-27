// Desktop-1 acceptance QA for browser-to-Chat handoffs. It uses a loopback page
// and the browser fixture's fake Codex executable; never a user profile or CLI.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { attachedNativeBrowserPages, dismissBrowserNotifications } from './lib/native-browser.mjs';
import { closeBrowserViewFixture, within } from './lib/browser-view-cleanup.mjs';
import { writeBrowserViewDiagnostics } from './lib/browser-view-diagnostics.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';
import { assertBrowserButtonClick, beginBrowserInputTrace, endBrowserInputTrace, readBrowserInputGeometry, chromeDividerPoints } from './lib/browser-handoff-input.mjs';

const midpointDrag=process.env.THREADTERM_QA_HANDOFF_MIDPOINT_DRAG==='1';
const root=resolve('.'),scratchBase=resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());await mkdir(scratchBase,{recursive:true});
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),fixture=join(root,'qa/fixtures/browser-plugins'),terminalFixture=join(root,'qa/fixtures/browser-handoff-terminal.mjs'),out=join(root,midpointDrag?'qa/results/browser-handoff-visual-midpoint':'qa/results/browser-handoff-visual'),scratch=await mkdtemp(join(scratchBase,'tt-browser-handoff-')),appDir=join(scratch,'app'),plugins=join(scratch,'plugins'),bin=join(scratch,'bin'),work=join(scratch,'work'),pipe=`\\\\.\\pipe\\tt-browser-handoff-${randomUUID()}`;
assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase(),'scratch remains inside the approved QA root');
const report={passed:false,checks:[],screenshots:[],themes:[],errors:[],limitations:[],midpointDrag,handoffActions:[],toolbarLayouts:[],dividerActions:[],toolbarPresses:[],inactiveIconPresses:[]};let app,page,server,runtimeProcess,baseUrl;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));const check=label=>{report.checks.push(label);console.log(`PASS ${label}`)};
const request=(method,params={})=>page.evaluate(([a,b])=>window.threadterm.request(a,b),[method,params]);const browser=value=>page.evaluate(v=>window.threadterm.browserCommand(v),value);async function userTurnCount(sessionId){const snapshot=await request('chat.snapshot',{sessionId});return snapshot.items.filter(item=>item.role==='user').length}
async function until(probe,label,ms=30_000){const deadline=Date.now()+ms;let last;while(Date.now()<deadline){const result=await within(probe,Math.max(1,deadline-Date.now()));if(!result.timedOut&&!result.error&&result.value)return result.value;last=result.error;await sleep(100)}throw Error(`Timed out: ${label}${last?`: ${last.message}`:''}`)}
async function shot(name){await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
function env(){const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe'].includes(key.toLowerCase())));Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_QA_BROWSER_URL:baseUrl});assert.equal(Object.keys(value).filter(key=>key.toLowerCase()==='path').length,1,'strict fake-only environment has one PATH spelling');return value}
async function buildApp(){await mkdir(appDir,{recursive:true});for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});await writeFile(join(appDir,'package.json'),JSON.stringify({name:'browser-handoff-visual-qa',version:'1',main:'main.cjs'}))}
const preview=()=>page.locator('.wb-web-preview:visible').first();
async function tabId(){const id=await preview().getAttribute('data-web-tab-id');assert.ok(id,'visible browser tab id');return id}
async function native(){return until(async()=>{await dismissBrowserNotifications(page);const pages=await attachedNativeBrowserPages(app,page);return pages.length===1?pages[0]:undefined;},'attached native page')}
async function startRuntime(){runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});await until(async()=>{if(runtimeProcess.exitCode!==null)throw Error('fixture runtime exited');let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim());return true}finally{peer?.close()}},'fixture runtime control pipe')}
async function navigate(sessionId){await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),sessionId)}
// Hit a painted SVG child, rather than empty button padding: only a real child
// hit can catch innerHTML replacement between pointerdown and mousedown.
async function iconPosition(button){
 return button.evaluate(element=>{
  const button=element.getBoundingClientRect(),svg=element.querySelector('svg'),rect=svg?.getBoundingClientRect();
  if(!rect)throw Error('Expected an icon-only button with an SVG');
  for(let y=Math.max(rect.top,button.top)+.5;y<Math.min(rect.bottom,button.bottom);y+=.5)for(let x=Math.max(rect.left,button.left)+.5;x<Math.min(rect.right,button.right);x+=.5){const hit=document.elementFromPoint(x,y);if(hit&&hit!==svg&&svg.contains(hit))return {x:x-button.x,y:y-button.y};}
  throw Error('No painted SVG child is available for the first-click probe');
 });
}
async function pressInactiveIcon(button,label,otherFocus,{blockClick=false}={}){
 await otherFocus.click();await until(()=>button.isEnabled(),`${label}: enabled`);
 const before=await button.evaluate(element=>{const pane=element.closest('[data-pane-id]');return {id:pane.dataset.paneId,selected:pane.classList.contains('selected')};});
 assert.equal(before.selected,false,`${label}: target pane starts inactive`);
 const action={label,before,blockClick};report.inactiveIconPresses.push(action);
 const position=await iconPosition(button),handle=await button.elementHandle();await beginBrowserInputTrace(page);
 try{
  if(blockClick)await handle.evaluate(element=>{element.__qaBlockClick=event=>{event.preventDefault();event.stopImmediatePropagation();};element.addEventListener('click',element.__qaBlockClick,true);});
  await button.click({position});
 }finally{
  action.events=await endBrowserInputTrace(page);
  if(blockClick)await handle.evaluate(element=>{element.removeEventListener('click',element.__qaBlockClick,true);delete element.__qaBlockClick;});
  await handle.dispose();
 }
 assertBrowserButtonClick(action.events,label);
 assert.notEqual(action.events[0].target.tag,'SVG',`${label}: painted child was pressed`);
 action.after=await page.locator('[data-pane-id]').evaluateAll((elements,id)=>{const pane=elements.find(element=>element.dataset.paneId===id);return pane?{id:pane.dataset.paneId,selected:pane.classList.contains('selected')}:null;},before.id);
 assert.ok(action.after,`${label}: target pane remains mounted`);
 assert.equal(action.after.id,before.id,`${label}: same pane survives activation`);assert.equal(action.after.selected,true,`${label}: pointerdown activates the pane`);
}
async function inspectComposerFirstClicks(chat,composer){
 const scope=page.locator(`[data-testid="session-chat-${chat.id}"]`),address=preview().locator('.wb-browser-address input');
 const add=scope.getByTestId('composer-plus');await pressInactiveIcon(add,'Chat Add/attach',address);
 await scope.getByRole('menu',{name:'Add',exact:true}).waitFor();await scope.getByRole('menuitem',{name:'Attach files…',exact:true}).waitFor();await page.keyboard.press('Escape');
 await composer.fill('First-click Send probe');const turns=await userTurnCount(chat.id);
 // Input stability is the assertion here; suppress only the final Send action,
 // matching the toolbar preflight and avoiding another preview/model request.
 await pressInactiveIcon(scope.getByRole('button',{name:'Send',exact:true}),'Chat Send',address,{blockClick:true});
 assert.equal(await userTurnCount(chat.id),turns,'Send input probe does not submit a model turn');assert.equal(await composer.inputValue(),'First-click Send probe');await composer.fill('');
 check('Inactive Chat Add/attach opens its real menu; Send receives a trusted click on the same SVG child through pane activation');
}
async function inspectTerminalFirstClick(){
 const surface=page.locator('.terminal-host:visible .xterm-screen').first();await surface.waitFor();await surface.click({position:{x:12,y:12}});await until(()=>page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),'fixture terminal input focus');await page.keyboard.type('emit-link');await page.keyboard.press('Enter');
 const point=await until(()=>page.evaluate(target=>{
  for(const row of document.querySelectorAll('.pane-tab-surface:not([hidden]) .xterm-rows > div')){
   const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),nodes=[];let text='';
   for(let node=walker.nextNode();node;node=walker.nextNode()){nodes.push([node,text.length]);text+=node.textContent;}
   const at=text.indexOf(target);if(at<0||text.slice(0,at).trim())continue;
   const [node,offset]=nodes.findLast(([,start])=>start<=at+4),range=document.createRange();range.setStart(node,at+4-offset);range.setEnd(node,at+5-offset);const rect=range.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  }
 },`${baseUrl}/toolbar-link`),'fixture URL in the real terminal');
 // xterm's link hover is asynchronous. Establish the link bar before the
 // first-click probe; no retries or synthetic clicks are used on its button.
 await page.mouse.move(point.x-2,point.y);await page.mouse.move(point.x,point.y);await sleep(350);await page.mouse.click(point.x,point.y);
 const close=page.getByRole('button',{name:'Close link actions',exact:true});await close.waitFor();
 await pressInactiveIcon(close,'Terminal link toolbar Close',preview().locator('.wb-browser-address input'));
 await close.waitFor({state:'detached'});check('An inactive terminal link toolbar receives its first trusted icon click and closes the real link actions');
}
async function emitViteBanner(){const surface=page.locator('.terminal-host:visible .xterm-screen').first();await surface.waitFor();await surface.click({position:{x:12,y:12}});await until(()=>page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),'fixture terminal input focus');await page.keyboard.type('emit-vite');await page.keyboard.press('Enter')}
async function start(){await startRuntime();app=await electron.launch({args:[appDir],cwd:root,env:env(),timeout:60_000});page=await app.firstWindow({timeout:45_000});page.setDefaultTimeout(20_000);page.on('pageerror',error=>report.errors.push(`page: ${error.message}`));await page.waitForFunction(()=>Boolean(window.threadterm?.browserCommand));await page.locator('#boot-splash').waitFor({state:'detached'});await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'fake Codex provider');const snap=await request('runtime.snapshot');await request('settings.update',{patch:{language:'en',theme:'light',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});const project=(await request('runtime.snapshot')).projects?.[0]??await request('project.add',{path:work,name:'Browser handoff QA',operationId:randomUUID()});await until(async()=>(await request('plugin.list')).plugins.some(plugin=>plugin.id==='browser-preview-acp-qa'),'image-incapable ACP fixture discovery');await request('plugin.setEnabled',{pluginId:'browser-preview-acp-qa',enabled:true,operationId:randomUUID()});await until(async()=>(await request('plugin.list')).plugins.some(plugin=>plugin.id==='browser-handoff-terminal-qa'),'terminal fixture discovery');await request('plugin.setEnabled',{pluginId:'browser-handoff-terminal-qa',enabled:true,operationId:randomUUID()});await until(async()=>(await request('provider.list')).find(provider=>provider.id==='browser-handoff-terminal'&&provider.terminal),'enabled terminal fixture provider');const acpProvider=await until(async()=>(await request('provider.list')).find(provider=>provider.id==='browser-preview-echo'&&provider.chat),'image-incapable ACP fixture');const acp=await request('session.create',{projectId:project.id,cwd:work,provider:acpProvider.id,mode:'chat',title:'Image-incapable ACP receiver',operationId:randomUUID()});const chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Browser handoff QA',operationId:randomUUID()});await navigate(chat.id);const composer=page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-shell textarea`);await composer.waitFor();await composer.fill('open preview');await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-send[type=submit]`).click();await until(()=>preview().locator('.wb-browser-toolbar').count(),'browser preview');return {chat,acp,project,composer}}
// Bind capture to the completed native document and the matching renderer generation.
async function openMarkup(){
 const action={};report.handoffActions.push(action);
 const toolbar=preview().locator('.wb-browser-toolbar'),button=toolbar.getByRole('button',{name:'Screenshot to Chat',exact:true}),markup=page.getByRole('dialog',{name:'Screenshot markup',exact:true});
 try{
  action.before=await until(async()=>{const state=await browser({type:'state',tabId:await tabId()}),generation=await preview().getAttribute('data-document-generation');return state.navigation==='load_observed'&&!state.loading&&!state.unloaded&&state.documentGeneration>0&&String(state.documentGeneration)===generation?state:undefined;},'matching completed browser document');
  await page.locator('.chat-compose-shell textarea:visible').first().click();
  action.beforePane=await button.evaluate(element=>({id:element.closest('[data-pane-id]').dataset.paneId,selected:element.closest('[data-pane-id]').classList.contains('selected')}));
  assert.equal(action.beforePane.selected,false,'screenshot target pane starts inactive');
  const position=await iconPosition(button),box=await button.boundingBox();
  await beginBrowserInputTrace(page);
  action.inputBefore=await readBrowserInputGeometry(app,page,button,{x:box.x+position.x,y:box.y+position.y});
  assert.equal(action.inputBefore.hitIsButton,true,'Screenshot to Chat is the DOM hit target');
  assert.ok(action.inputBefore.native.views.every(view=>!view.overlapsButton),'native views do not overlap Screenshot to Chat');
  assert.deepEqual(action.inputBefore.captured,[],'no divider retains pointer capture before the screenshot click');
  await button.evaluate(element=>{element.dataset.qaClickReceived='false';element.addEventListener('click',()=>{element.dataset.qaClickReceived='true';},{once:true});});
  await button.click({position});
  action.clickReceived=await button.getAttribute('data-qa-click-received');
  assert.equal(action.clickReceived,'true','Screenshot to Chat must receive the pointer click');
  action.afterPane=await button.evaluate(element=>({id:element.closest('[data-pane-id]').dataset.paneId,selected:element.closest('[data-pane-id]').classList.contains('selected')}));
  assert.equal(action.afterPane.selected,true,'screenshot pointerdown activates its pane');
  const outcome=await until(async()=>{if(await markup.isVisible())return {status:'markup'};const errors=await preview().locator('[data-browser-handoff-error]').allTextContents();return errors.length?{status:'error',errors}:undefined;},'screenshot capture opens markup or reports its error');
  action.outcome=outcome;assert.equal(outcome.status,'markup',JSON.stringify(outcome));
 }finally{
  const input=await within(async()=>{const events=await endBrowserInputTrace(page),click=[...events].reverse().find(event=>event.type==='pointerdown'||event.type==='mousedown');return {events,geometry:await readBrowserInputGeometry(app,page,button,click?{x:click.x,y:click.y}:action.inputBefore?.point)};},5_000);
  action.inputAfter=input.timedOut?{error:'input diagnostics timed out'}:input.error?{error:String(input.error)}:input.value;
  const result=await within(async()=>({clickReceived:await button.getAttribute('data-qa-click-received'),disabled:await button.isDisabled(),renderer:await preview().getAttribute('data-handoff-state'),alerts:await preview().locator('[role=alert]').allTextContents(),native:await browser({type:'state',tabId:await tabId()}).then(({snapshot,...state})=>({...state,snapshot:Boolean(snapshot)})),markup:await markup.evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {hidden:element.hidden,x:r.x,y:r.y,width:r.width,height:r.height};}))}),5_000);
  action.after=result.timedOut?{error:'handoff diagnostics timed out'}:result.error?{error:String(result.error)}:result.value;
 }
 assertBrowserButtonClick(action.inputAfter.events,'Screenshot to Chat');
}
// Press every real toolbar control after selecting Chat, reproducing the pane
// activation render. Suppress only click side effects (including OS browser
// launch); pointerdown, focus and React reconciliation remain production paths.
async function inspectToolbarPresses(composer){
 const id=await tabId(),initial=await browser({type:'state',tabId:id}),toolbar=preview().locator('.wb-browser-toolbar');
 const waitUrl=url=>until(async()=>{const state=await browser({type:'state',tabId:id});return state.url===url&&!state.loading&&state.navigation==='load_observed';},`toolbar test navigation ${url}`);
 for(const path of ['/toolbar-history-a','/toolbar-history-b']){const url=`${baseUrl}${path}`;await browser({type:'navigate',tabId:id,url});await waitUrl(url);}
 await browser({type:'back',tabId:id});await waitUrl(`${baseUrl}/toolbar-history-a`);await browser({type:'zoom',tabId:id,factor:.9});
 await until(()=>toolbar.getByRole('button',{name:'Back',exact:true}).isEnabled(),'Back enabled');await until(()=>toolbar.getByRole('button',{name:'Forward',exact:true}).isEnabled(),'Forward enabled');await until(()=>toolbar.getByRole('button',{name:'90%',exact:true}).count(),'reset zoom visible');
 await until(()=>toolbar.getByRole('button',{name:'Screenshot to Chat',exact:true}).isEnabled(),'capture enabled after toolbar navigation');
 // B3 sharing has intentionally disabled selected controls and its own native UI fixture.
 const buttons=await toolbar.locator('button:not(.wb-browser-share button)').all();
 for(const button of buttons){
  const label=await button.evaluate(element=>element.getAttribute('aria-label')??element.textContent.trim());const action={label};report.toolbarPresses.push(action);
  assert.equal(await button.isEnabled(),true,`${label}: toolbar probe must not skip disabled controls`);
  await composer.click();await beginBrowserInputTrace(page);
  action.beforePane=await button.evaluate(element=>({id:element.closest('[data-pane-id]').dataset.paneId,selected:element.closest('[data-pane-id]').classList.contains('selected')}));
  assert.equal(action.beforePane.selected,false,`${label}: browser pane starts inactive`);
  const position=await button.locator('svg').count()?await iconPosition(button):undefined;
  const handle=await button.elementHandle();
  try{
   await handle.evaluate(element=>{element.__qaBlockClick=event=>{event.preventDefault();event.stopImmediatePropagation();};element.addEventListener('click',element.__qaBlockClick,true);});
   await button.click(position?{position}:{});
  }finally{
   action.events=await endBrowserInputTrace(page);
   await handle.evaluate(element=>{element.removeEventListener('click',element.__qaBlockClick,true);delete element.__qaBlockClick;});await handle.dispose();
  }
  assertBrowserButtonClick(action.events,label);
 }
 await browser({type:'zoom',tabId:id,factor:initial.zoom});await browser({type:'navigate',tabId:id,url:initial.url});await waitUrl(initial.url);
 check('Every B2 navigation/page toolbar button, including reset zoom and console, preserves its pressed subtree through pane activation and receives trusted pointerdown/mousedown/pointerup/mouseup/click');
}
async function dragBrowserDivider(endX,label){
 const divider=page.locator('[data-split-id] > .pane-divider').first();await divider.waitFor();
 const toolbar=preview().locator('.wb-browser-toolbar'),screenshot=toolbar.getByRole('button',{name:'Screenshot to Chat',exact:true});
 const boxes=await divider.evaluate(node=>{const box=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {parent:box(node.parentElement),divider:box(node)};});
 const point=chromeDividerPoints(boxes.parent,boxes.divider,await toolbar.boundingBox(),endX(boxes.parent));
 if(midpointDrag)point.y=boxes.divider.y+boxes.divider.height/2;
 const action={label,point,previousMidpoint:{x:point.x,y:boxes.divider.y+boxes.divider.height/2}};report.dividerActions.push(action);await beginBrowserInputTrace(page);
 try{
  action.before=await readBrowserInputGeometry(app,page,screenshot,point);
  action.previousMidpoint=await readBrowserInputGeometry(app,page,screenshot,action.previousMidpoint);
  action.endBefore=await readBrowserInputGeometry(app,page,screenshot,{x:point.endX,y:point.y});
  assert.ok(action.before.native.views.every(view=>!view.containsClick),'divider starts outside attached native views');
  // Old and final native bounds must both be below the entire drag, not just its start.
  if(!midpointDrag)assert.ok(action.before.native.views.every(view=>point.y*action.before.native.zoom<view.bounds.y),'divider drag stays above the native page');
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.y,{steps:8});await page.mouse.up();
  action.after=await readBrowserInputGeometry(app,page,screenshot,{x:point.endX,y:point.y});
  assert.deepEqual(action.after.captured,[],'divider releases pointer capture');
  if(!midpointDrag)assert.ok(action.after.native.views.every(view=>point.y*action.after.native.zoom<view.bounds.y),'divider ends above the native page');
 }finally{
  const trace=await within(()=>endBrowserInputTrace(page),5_000);action.events=trace.timedOut?{error:'divider trace timed out'}:trace.error?{error:String(trace.error)}:trace.value;
 }
 assert.ok(Array.isArray(action.events),JSON.stringify(action.events));
 assert.ok(action.events.some(event=>event.type==='pointerdown'&&event.target?.className==='pane-divider'),'divider received pointer down');
 assert.ok(action.events.some(event=>event.type==='pointerup'&&event.target?.className==='pane-divider'),'divider received pointer up');
}
async function resizeBrowserPane(width){
 await dragBrowserDivider(parent=>parent.x+parent.width-width,`${width}px browser pane`);
 await until(async()=>{const box=await preview().boundingBox();return box&&Math.abs(box.width-width)<=20;},`${width}px browser pane`);
}
async function inspectToolbarLayout(label){
 const layout=await preview().locator('.wb-browser-toolbar').evaluate(element=>{const rect=element.getBoundingClientRect(),navigation=element.querySelector('.wb-browser-navigation').getBoundingClientRect(),actions=element.querySelector('.wb-browser-actions').getBoundingClientRect(),buttons=[...element.querySelector('.wb-browser-actions').querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>{const r=button.getBoundingClientRect();return {name:button.getAttribute('aria-label')??button.textContent,x:r.x,y:r.y,right:r.right};});return {width:rect.width,left:rect.left,right:rect.right,navigationY:navigation.y,actionsY:actions.y,buttons};});
 report.toolbarLayouts.push({label,...layout});assert.ok(layout.buttons.length>=4,`${label}: action group exists`);
 assert.ok(layout.buttons.every(button=>Math.abs(button.y-layout.buttons[0].y)<1),`${label}: page actions stay together`);
 assert.ok(layout.buttons.every(button=>button.x>=layout.left&&button.right<=layout.right),`${label}: no clipped actions`);
 if(layout.width>=550)assert.ok(Math.abs(layout.navigationY-layout.actionsY)<1,`${label}: toolbar fits one row`);
}
async function setTheme(theme){const snap=await request('runtime.snapshot'),custom={background:'#0b1016',surface:'#182430',text:'#f2f6fb',muted:'#93a3b5',accent:'#ff7a45',border:'#26323f'};await request('settings.update',{patch:theme==='custom'?{theme:'dark',themeSelection:'custom:handoff-qa',customThemes:{'handoff-qa':custom}}:{theme,themeSelection:theme},expectedRevision:snap.settings.revision,operationId:randomUUID()});await page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme==='custom'?'dark':theme);if(theme==='custom')await page.waitForFunction(()=>document.documentElement.dataset.customTheme==='true')}
async function close(){const errors=await closeBrowserViewFixture({app,page,server,runtime:runtimeProcess,shutdownRuntime:true});report.errors.push(...errors);app=page=server=runtimeProcess=undefined}

try{
 server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>handoff page</title><body><h1 id="target">Browser handoff</h1><script>console.warn('handoff warning');console.error('handoff error');</script><p>${url.pathname}</p></body>`)});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});baseUrl=`http://127.0.0.1:${server.address().port}`;assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);await mkdir(out,{recursive:true});await mkdir(bin,{recursive:true});await mkdir(work,{recursive:true});await mkdir(plugins,{recursive:true});cpSync(fixture,join(plugins,'browser-preview-acp-qa'),{recursive:true});await mkdir(join(plugins,'browser-handoff-terminal-qa'),{recursive:true});await writeFile(join(plugins,'browser-handoff-terminal-qa','threadterm-plugin.json'),JSON.stringify({schemaVersion:1,id:'browser-handoff-terminal-qa',name:'Browser handoff terminal QA',version:'1.0.0',publisher:'ThreadTerm QA',contributes:{agents:[{id:'browser-handoff-terminal',name:'Browser handoff terminal',command:'node',args:[terminalFixture],versionArgs:['--version']}]}}));await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(fixture,'fake-codex-browser.cjs')}" %*\r\n`);await buildApp();const {chat,acp,project,composer}=await start();const id=await tabId();await until(async()=>{const state=await browser({type:'state',tabId:id});if(state.url!==`${baseUrl}/codex`||state.navigation!=='load_observed'||state.loading)return false;const nativePage=await native();return nativePage.url===state.url&&await nativePage.boundingBox('#target');},'completed fixture document with console errors');await resizeBrowserPane(565);await inspectToolbarLayout('565px browser pane');
 const ownerUserTurns=await userTurnCount(chat.id),acpUserTurns=await userTurnCount(acp.id);
 const toolbar=preview().locator('.wb-browser-toolbar'),markup=page.getByRole('dialog',{name:'Screenshot markup',exact:true}),screenshotDestination=page.getByRole('dialog',{name:'Screenshot to Chat',exact:true});
 await inspectToolbarPresses(composer);await inspectComposerFirstClicks(chat,composer);
 const draw=async(tool,keys)=>{await markup.getByRole('button',{name:tool,exact:true}).click();const canvas=markup.getByLabel('Screenshot canvas',{exact:true});await canvas.focus();await page.keyboard.press('Space');for(const key of keys)await page.keyboard.press(key);await page.keyboard.press('Space')};
 await openMarkup();await draw('Rectangle',['ArrowRight','ArrowRight','ArrowDown']);await markup.getByRole('button',{name:'Undo',exact:true}).click();await draw('Rectangle',['ArrowRight','ArrowDown']);await draw('Arrow',['ArrowRight','ArrowRight','ArrowDown']);await draw('Pen',['ArrowRight','ArrowDown','ArrowRight','ArrowDown']);await markup.getByRole('button',{name:'Text',exact:true}).click();await markup.getByLabel('Text label',{exact:true}).fill('QA');await markup.getByLabel('Screenshot canvas',{exact:true}).focus();await page.keyboard.press('Space');await markup.getByRole('button',{name:'Done',exact:true}).click();await screenshotDestination.waitFor();await screenshotDestination.getByRole('button',{name:'Add to draft',exact:true}).click();await until(()=>page.getByLabel('Page screenshot',{exact:true}).count(),'screenshot composer badge');assert.equal(await userTurnCount(chat.id),ownerUserTurns,'adding screenshot does not submit a user turn');await shot('screenshot-badge-wide.png');check('Screenshot to Chat serializes rectangle, arrow, pen and text markup before adding an image badge to the owner draft without submitting it');
 await composer.fill('draft survives reload');await navigate(acp.id);await page.locator(`[data-testid="session-chat-${acp.id}"] .chat-compose-shell textarea`).waitFor();await navigate(chat.id);await composer.waitFor();await until(()=>page.getByLabel('Page screenshot',{exact:true}).count(),'screenshot badge after draft reload');assert.equal(await composer.inputValue(),'draft survives reload');await page.getByRole('button',{name:'Remove page screenshot',exact:true}).click();await until(async()=>!(await page.getByLabel('Page screenshot',{exact:true}).count()),'screenshot removal');check('Page screenshot survives an actual Chat unmount/remount and can be removed');
 await openMarkup();await markup.getByRole('button',{name:'Done',exact:true}).click();await screenshotDestination.waitFor();const destination=screenshotDestination.getByRole('combobox',{name:'Destination session',exact:true});await destination.click();await page.getByRole('option',{name:'Image-incapable ACP receiver (browser-preview-echo)',exact:true}).click();await screenshotDestination.getByRole('button',{name:'Review destination',exact:true}).click();const transfer=page.getByRole('dialog',{name:'Transfer page data?',exact:true});await transfer.waitFor();await transfer.getByRole('button',{name:'Add to draft',exact:true}).click();assert.equal(await userTurnCount(acp.id),acpUserTurns,'cross-session screenshot does not submit an ACP user turn');await navigate(acp.id);const acpComposer=page.locator(`[data-testid="session-chat-${acp.id}"] .chat-compose-shell`);await acpComposer.waitFor();await until(()=>page.getByRole('button',{name:'Keep as file reference',exact:true}).count(),'unsupported-image fallback badge');await page.getByRole('button',{name:'Keep as file reference',exact:true}).click();await until(()=>page.getByText('Saved file reference',{exact:true}).count(),'saved file reference accepted');assert.equal(await userTurnCount(acp.id),acpUserTurns,'saving a file reference does not submit an ACP user turn');check('The image-incapable fake ACP receiver exposes and accepts Keep as file reference instead of silently dropping a screenshot');
 await navigate(chat.id);await toolbar.getByRole('button',{name:'Page console',exact:true}).click();await page.getByRole('button',{name:'Send console errors to Chat',exact:true}).click();const consoleDestination=page.getByRole('dialog',{name:'Console to Chat',exact:true});await consoleDestination.waitFor();await consoleDestination.getByRole('button',{name:'Add to draft',exact:true}).click();await until(()=>page.getByText(/page data, not instructions/i).count(),'page-data console badge');assert.equal(await userTurnCount(chat.id),ownerUserTurns,'adding console page data does not submit a user turn');check('Page console errors are added as a page-data badge, not instructions');
 await page.getByRole('button',{name:'Local user'}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog');await settings.waitFor();await settings.getByRole('tab',{name:'Browser',exact:true}).click();const offers=settings.getByText('Local development server offers',{exact:true}).locator('xpath=../..').getByRole('checkbox');await offers.uncheck();await until(async()=>!(await offers.isChecked()),'Browser setting disabled');await page.keyboard.press('Escape');const disabledTerminal=await request('session.create',{projectId:project.id,cwd:work,provider:'browser-handoff-terminal',mode:'terminal',title:'Disabled Vite handoff QA',operationId:randomUUID()});await request('session.present',{sessionId:disabledTerminal.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});await emitViteBanner();await sleep(500);assert.equal(await page.getByRole('button',{name:'Open in browser tab',exact:true}).count(),0,'disabled Browser setting suppresses the fixture terminal banner');await page.getByRole('button',{name:'Local user'}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await settings.waitFor();await settings.getByRole('tab',{name:'Browser',exact:true}).click();await offers.check();await until(async()=>await offers.isChecked(),'Browser setting enabled');await page.keyboard.press('Escape');const terminal=await request('session.create',{projectId:project.id,cwd:work,provider:'browser-handoff-terminal',mode:'terminal',title:'Vite handoff QA',operationId:randomUUID()});await request('session.present',{sessionId:terminal.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});await emitViteBanner();await until(()=>page.getByRole('button',{name:'Open in browser tab',exact:true}).count(),'Vite loopback offer');await inspectTerminalFirstClick();await page.getByRole('button',{name:'Open in browser tab',exact:true}).click();await until(()=>page.locator('.browser-page-tab').count(),'browser tab from terminal offer');check('The Browser offer setting responds immediately; a fixture Vite banner opens a loopback tab only after the user clicks');
 const inspect=async(selector,label)=>{const visibleSelector=selector+':visible';const roots=page.locator(visibleSelector);await roots.first().waitFor({state:'visible'});assert.ok(await roots.count()>0,`${label}: visible container exists`);await roots.first().evaluate(element=>element.setAttribute('data-qa-handoff-inspect','active'));let result;try{result=await checkControlConsistency(page,'[data-qa-handoff-inspect="active"]',{checkStates:true,checkDisabledRows:true});}finally{await page.locator('[data-qa-handoff-inspect="active"]').evaluateAll(elements=>elements.forEach(element=>element.removeAttribute('data-qa-handoff-inspect')));}report.themes.push({label,...result});assertNoControlViolations(result,label)};
 const addOwnerScreenshot=async()=>{await navigate(chat.id);await openMarkup();await markup.getByRole('button',{name:'Done',exact:true}).click();await screenshotDestination.waitFor();await screenshotDestination.getByRole('button',{name:'Add to draft',exact:true}).click();await until(()=>page.locator(`[data-testid="session-chat-${chat.id}"] .wb-page-shot-draft`).count(),'owner screenshot draft badge');assert.equal(await userTurnCount(chat.id),ownerUserTurns,'matrix screenshot draft does not submit a user turn')};
 const inspectSurfaces=async(theme,size)=>{await setTheme(theme);await addOwnerScreenshot();await inspectToolbarLayout(`${theme} ${size}`);await inspect('.wb-browser-toolbar',`browser handoff toolbar ${theme} ${size}`);await inspect('.wb-page-shot-draft',`composer screenshot badge ${theme} ${size}`);await shot(`handoff-${theme}-${size}-composer.png`);await openMarkup();await inspect('.wb-markup-toolbar',`markup toolbar ${theme} ${size}`);await shot(`handoff-${theme}-${size}-markup.png`);await markup.getByRole('button',{name:'Cancel',exact:true}).click();await toolbar.getByRole('button',{name:'Page console',exact:true}).click();await until(()=>page.locator('.wb-browser-console-actions').count(),'console action');await inspect('.wb-browser-console-actions',`console action ${theme} ${size}`);await shot(`handoff-${theme}-${size}-console.png`);await toolbar.getByRole('button',{name:'Page console',exact:true}).click();const offered=await request('session.create',{projectId:project.id,cwd:work,provider:'browser-handoff-terminal',mode:'terminal',title:`Vite offer ${theme} ${size}`,operationId:randomUUID()});await request('session.present',{sessionId:offered.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});await emitViteBanner();const offer=page.locator('.terminal-control-note').filter({has:page.getByRole('button',{name:'Open in browser tab',exact:true})});await until(()=>offer.count(),`Vite offer ${theme} ${size}`);await inspect('.terminal-control-note',`development-server offer ${theme} ${size}`);await shot(`handoff-${theme}-${size}-offer.png`);await offer.getByRole('button',{name:'Dismiss',exact:true}).click().catch(()=>undefined);await navigate(chat.id);await page.getByRole('button',{name:'Remove page screenshot',exact:true}).click();await until(async()=>await page.locator(`[data-testid="session-chat-${chat.id}"] .wb-page-shot-draft`).count()===0,'matrix screenshot removal')};
 for(const theme of ['light','dark','custom'])await inspectSurfaces(theme,'wide');
 await navigate(chat.id);const chatScope=page.locator(`[data-testid="session-chat-${chat.id}"]`),divider=page.locator('[data-split-id] > .pane-divider').first();await until(()=>divider.count(),'workspace divider');await dragBrowserDivider(parent=>parent.x+400,'400px Chat pane');await until(async()=>{const box=await chatScope.boundingBox();return box&&box.width>=380&&box.width<=420},'400px Chat pane');for(const theme of ['light','dark','custom'])await inspectSurfaces(theme,'400-chat');await resizeBrowserPane(400);for(const theme of ['light','dark','custom'])await inspectSurfaces(theme,'400-browser');check('Browser handoff controls pass consistency checks in light, dark and custom themes at 565px and 400px browser widths and a 400px Chat width');report.passed=true;
}catch(error){report.errors.push(error?.stack??String(error));if(page)await within(()=>shot('failure.png'),5_000);process.exitCode=1}finally{if(app&&page)await within(()=>writeBrowserViewDiagnostics(app,page,out),5_000).then(result=>{if(result.timedOut)report.errors.push('Diagnostics timed out after 5000 ms');else if(result.error)report.errors.push(`Diagnostics: ${String(result.error)}`)});await close();if(report.errors.length)report.passed=false;await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});console.log(report.passed?'BROWSER HANDOFF VISUAL QA PASSED':`BROWSER HANDOFF VISUAL QA FAILED\n${report.errors.join('\n')}`)}
if(report.errors.length)process.exit(1);
