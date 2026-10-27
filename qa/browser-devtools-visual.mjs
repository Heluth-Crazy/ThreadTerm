// Desktop-1 QA for embedded DevTools in the browser pane (task 10-22-browser-devtools). It uses only a
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
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),fixture=join(root,'qa/fixtures/browser-plugins'),out=join(root,'qa/results/browser-devtools',/^[A-Za-z0-9._-]+$/.test(process.argv[2]??'')?process.argv[2]:'current'),scratch=await mkdtemp(join(scratchBase,'tt-browser-devtools-')),appDir=join(scratch,'app'),plugins=join(scratch,'plugins'),bin=join(scratch,'bin'),work=join(scratch,'work'),downloads=join(scratch,'downloads'),events=join(out,'provider-events.jsonl'),pipe=`\\\\.\\pipe\\tt-browser-devtools-${randomUUID()}`;
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
// --- Embedded DevTools checks (task 10-22-browser-devtools) ---
// Usage: node qa/browser-devtools-visual.mjs [label]. Never clicks "Open in browser" (it opens the user's real browser).
import { PNG } from 'pngjs';
const toolbarSelector='.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-toolbar';
const consolePage=html('console',`<p id="comment-target">DevTools QA page</p><a id="popup-link" target="_blank" href="/popup">popup</a><p>Find needle.</p><script>console.error('qa error one');console.warn('qa warning');fetch('/api/data?probe=1').then(r=>r.json()).then(()=>{})</script>`);
await new Promise(done=>{server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/api/data'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return}
 res.writeHead(200,{'content-type':'text/html'});res.end(url.pathname==='/console'?consolePage:html(url.pathname.slice(1)||'home',`<p>${url.pathname}</p>`))});server.listen(0,'127.0.0.1',done)});baseUrl=`http://127.0.0.1:${server.address().port}`;
const pane=()=>preview().locator('xpath=ancestor::section[contains(concat(" ",normalize-space(@class)," ")," workspace-pane ")][1]');
const devtoolsButton=()=>preview().locator('.wb-browser-toolbar').getByRole('button',{name:'Developer tools',exact:true});
async function consistent(selector,label){const result=await checkControlConsistency(page,selector,{checkStates:true,checkDisabledRows:true});report.consistency.push({label,selector,violations:result.violations?.length??0});assertNoControlViolations(result,label)}
async function loaded(path){const id=await tabId();await command({type:'navigate',tabId:id,url:`${baseUrl}${path}`});await until(async()=>{const value=await state();return value.url===`${baseUrl}${path}`&&!value.loading&&value.navigation==='load_observed'},`${path} loaded`)}
// Native views of the renderer's window: the visible page and its DevTools front end.
async function nativeViews(){const owner=await app.browserWindow(page);let windowId;try{windowId=await owner.evaluate(window=>window.id)}finally{await owner.dispose()}
 return app.evaluate(({BrowserWindow,session},windowId)=>{const window=BrowserWindow.fromId(windowId),profile=session.fromPartition('persist:threadterm-browser');
  return window.contentView.children.map(view=>{const contents=view.webContents;return{id:contents.id,url:contents.getURL(),kind:contents.getURL().startsWith('devtools://')?'devtools':contents.session===profile?'page':'other',bounds:view.getBounds(),devtoolsId:contents.session===profile&&contents.devToolsWebContents?contents.devToolsWebContents.id:undefined}})},windowId)}
async function attachedDevtools(){return (await nativeViews()).find(view=>view.kind==='devtools')}
async function allDevtoolsContents(){return app.evaluate(({webContents})=>webContents.getAllWebContents().filter(contents=>!contents.isDestroyed()&&contents.getURL().startsWith('devtools://')).map(contents=>contents.id))}
// Runs code in the DevTools front end (main process executeJavaScript); `deep` pierces DevTools' shadow roots.
const deep=`const deep=(selector)=>{const out=new Set();const walk=root=>{for(const element of root.querySelectorAll(selector))out.add(element);for(const element of root.querySelectorAll('*'))if(element.shadowRoot)walk(element.shadowRoot)};walk(document);return [...out]};`;
async function inDevtools(id,code){return app.evaluate(({webContents},{id,code})=>{const contents=webContents.fromId(id);if(!contents||contents.isDestroyed())throw Error('DevTools contents closed');return contents.executeJavaScript(code)},{id,code:`(()=>{${deep}${code}})()`})}
async function devtoolsInput(id,events){return app.evaluate(({webContents},{id,events})=>{const contents=webContents.fromId(id);for(const event of events)contents.sendInputEvent(event)},{id,events})}
async function clickInDevtools(id,selector){const box=await until(()=>inDevtools(id,`const element=deep(${JSON.stringify(selector)}).find(element=>{const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0});if(!element)return null;const rect=element.getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}`),`DevTools ${selector}`);
 await devtoolsInput(id,[{type:'mouseDown',x:box.x,y:box.y,button:'left',clickCount:1},{type:'mouseUp',x:box.x,y:box.y,button:'left',clickCount:1}])}
async function typeInDevtools(id,text){await devtoolsInput(id,[...text].flatMap(char=>[{type:'keyDown',keyCode:char},{type:'char',keyCode:char},{type:'keyUp',keyCode:char}]))}
// Selected panel: the selected header tab (id tab-<name>) or a visible `.panel.<name>` root.
const selectedPanels=id=>inDevtools(id,`return [...deep('.tabbed-pane-header-tab.selected, [role=tab][aria-selected="true"]').map(tab=>tab.id),...deep('.panel').filter(panel=>panel.offsetWidth>0&&panel.offsetHeight>0).map(panel=>{const names=[...panel.classList];return 'tab-'+names[names.indexOf('panel')+1]})]`);
async function showPanel(id,name){await inDevtools(id,`if(typeof DevToolsAPI!=='undefined')DevToolsAPI.showPanel(${JSON.stringify(name)});return true`)}
async function pageInput(events){const views=await nativeViews(),pageView=views.find(view=>view.kind==='page');assert.ok(pageView,'attached page view');await app.evaluate(({webContents},{id,events})=>{const contents=webContents.fromId(id);for(const event of events)contents.sendInputEvent(event)},{id:pageView.id,events})}
// Pane screenshot with the native page and DevTools pasted in at their native bounds (renderer screenshots omit them).
async function paneShot(name){
 await page.mouse.move(0,0);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const box=await pane().boundingBox();assert.ok(box,'pane bounds');const scale=await page.evaluate(()=>devicePixelRatio);
 const base=PNG.sync.read(await page.screenshot({clip:box,animations:'disabled'}));
 const views=(await nativeViews()).filter(view=>view.kind!=='other');
 for(const view of views){const data=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage()).toPNG().toString('base64'),view.id);const image=PNG.sync.read(Buffer.from(data,'base64'));
  const left=Math.round((view.bounds.x-box.x)*scale),top=Math.round((view.bounds.y-box.y)*scale);
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){const tx=left+x,ty=top+y;if(tx<0||ty<0||tx>=base.width||ty>=base.height)continue;const from=(y*image.width+x)*4,to=(ty*base.width+tx)*4;base.data[to]=image.data[from];base.data[to+1]=image.data[from+1];base.data[to+2]=image.data[from+2];base.data[to+3]=255}}
 await writeFile(join(out,name),PNG.sync.write(base));report.screenshots.push(name)}
async function resizePane(target){
 const divider=page.locator('[data-split-id] > .pane-divider').first();await until(()=>divider.count(),'workspace divider');
 for(let attempt=0;attempt<4;attempt++){const width=(await pane().boundingBox()).width;if(Math.abs(width-target)<=24)return width;const point=await divider.evaluate(node=>{const rect=node.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}});await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+(width-target),point.y,{steps:8});await page.mouse.up();await sleep(200)}
 return (await pane().boundingBox()).width}
async function geometry(label){
 const views=await nativeViews(),pageView=views.find(view=>view.kind==='page'),tools=views.find(view=>view.kind==='devtools');
 const dom=await preview().evaluate(root=>{const rect=selector=>{const value=root.querySelector(selector)?.getBoundingClientRect();return value&&{x:value.x,y:value.y,width:value.width,height:value.height}};return{page:rect('.tt-browser-view'),tools:rect('.tt-browser-devtools'),splitter:rect('.wb-browser-devtools-splitter'),preview:(({x,y,width,height})=>({x,y,width,height}))(root.getBoundingClientRect())}});
 assert.ok(pageView&&tools&&dom.tools&&dom.page,`${label}: page and DevTools views attached with placeholders`);
 const near=(a,b)=>Math.abs(a-b)<=1.5;
 assert.ok(near(tools.bounds.x,dom.tools.x)&&near(tools.bounds.y,dom.tools.y)&&near(tools.bounds.width,dom.tools.width)&&near(tools.bounds.height,dom.tools.height),`${label}: DevTools view matches its placeholder ${JSON.stringify(tools.bounds)} vs ${JSON.stringify(dom.tools)}`);
 assert.ok(pageView.bounds.y+pageView.bounds.height<=tools.bounds.y+0.5,`${label}: DevTools sit below the page`);
 assert.ok(tools.bounds.y+tools.bounds.height<=dom.preview.y+dom.preview.height+1&&tools.bounds.x>=dom.preview.x-1&&tools.bounds.x+tools.bounds.width<=dom.preview.x+dom.preview.width+1,`${label}: DevTools stay inside the browser pane`);
 report.geometry.push({label,page:pageView.bounds,devtools:tools.bounds,splitter:dom.splitter});return{pageView,tools,dom}}
report.consistency=[];report.geometry=[];
try{assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);await mkdir(out,{recursive:true});await mkdir(bin,{recursive:true});await mkdir(work,{recursive:true});await mkdir(plugins,{recursive:true});cpSync(fixture,join(plugins,'browser-preview-acp-qa'),{recursive:true});await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(fixture,'fake-codex-browser.cjs')}" %*\r\n`);await buildApp();await start();
 await setTheme('light');await loaded('/console');const id=await tabId();
 // 1. Toolbar button opens docked DevTools below the page.
 assert.equal(await devtoolsButton().getAttribute('aria-pressed'),'false');await consistent(toolbarSelector,'toolbar with DevTools button (closed)');
 await devtoolsButton().click();await until(async()=>(await state()).devtools?.open===true,'DevTools open state');
 let tools=await until(attachedDevtools,'DevTools view attached');assert.equal(await devtoolsButton().getAttribute('aria-pressed'),'true');
 await until(()=>inDevtools(tools.id,`return typeof DevToolsAPI!=='undefined'&&deep('.panel').some(panel=>panel.offsetWidth>0)`),'DevTools front end loaded',45000);
 await geometry('opened by button');await consistent(toolbarSelector,'toolbar with DevTools button (open)');
 const panels=[];for(const name of ['console','network','sources','timeline','heap-profiler','resources','security','lighthouse','elements']){await showPanel(tools.id,name);if(await until(async()=>(await selectedPanels(tools.id)).includes(`tab-${name}`),`panel ${name}`,4000).catch(()=>false))panels.push(name)}report.panels=panels;
 for(const panel of ['elements','console','sources','network'])assert.ok(panels.includes(panel),`DevTools offers ${panel} (${panels.join(', ')})`);
 await paneShot('elements-light.png');
 check(`toolbar button docks Chromium DevTools below the page; panels: ${panels.join(', ')}`);
 // 2. Console: Ctrl+Shift+J selects it; earlier page messages are listed; the prompt evaluates.
 await pageInput([{type:'keyDown',keyCode:'J',modifiers:['control','shift']},{type:'keyUp',keyCode:'J',modifiers:['control','shift']}]);
 await until(async()=>(await selectedPanels(tools.id)).includes('tab-console'),'Ctrl+Shift+J shows Console');
 await until(()=>inDevtools(tools.id,`return deep('.console-message-text').some(node=>node.textContent.includes('qa error one'))`),'Console lists the page error logged before DevTools opened');
 await until(()=>inDevtools(tools.id,`return deep('.console-message-text').some(node=>node.textContent.includes('qa warning'))&&deep('.console-prompt-editor-container').length>0`),'Console lists the warning and shows its prompt');
 report.limitations.push('Typing into the Console prompt needs OS focus on the QA window (never focused on Desktop 1); evaluation was not automated');
 await paneShot('console-light.png');check('Console: Ctrl+Shift+J selects it; page errors and warnings logged before DevTools opened are listed; the prompt is present');
 // 3. Network: records the page reload (document + fetch).
 await showPanel(tools.id,'network');await until(async()=>(await selectedPanels(tools.id)).includes('tab-network'),'Network panel');
 await preview().getByRole('button',{name:'Reload',exact:true}).click();await until(async()=>!(await state()).loading,'reload done');
 const networkText=()=>inDevtools(tools.id,`const texts=[];const walk=root=>{for(const element of root.querySelectorAll('*')){if(element.shadowRoot)walk(element.shadowRoot);if(!element.children.length&&element.tagName!=='STYLE'&&/request|Perform a request|Recording/.test(element.textContent||''))texts.push(element.textContent.trim().slice(0,80))}};walk(document);return texts`);
 // The grid paints its rows lazily; on the hidden Desktop-1 window the request counter is the reliable signal.
 const counted=await until(async()=>{const text=await networkText(),count=Math.max(0,...text.map(line=>Number(/^(\d+) requests?/.exec(line)?.[1]??0)));return count>=2?count:undefined},'Network counts the document and the fetch',20000).catch(async error=>{report.networkDiagnostic={text:await networkText(),selected:await selectedPanels(tools.id)};throw error});
 await paneShot('network-light.png');const rows=await inDevtools(tools.id,`return deep('td.name-column').map(cell=>cell.textContent.trim())`);report.networkRows=rows;
 check(`Network records the reload: ${counted} requests${rows.length?` (${rows.slice(0,4).join(', ')})`:''}`);
 // 4. Inspect from the page context menu selects the element in Elements.
 await (await nativePage()).rightClick('#comment-target');const inspect=page.locator('[data-testid=web-preview-inspect]');await inspect.waitFor();await inspect.click();
 await until(async()=>(await selectedPanels(tools.id)).includes('tab-elements'),'Inspect shows Elements');
 await until(()=>inDevtools(tools.id,`return deep('li.selected').some(node=>node.textContent.includes('comment-target'))`),'Inspect selects the element');
 await paneShot('elements-inspect-light.png');check('Inspect (page context menu) opens Elements on the element');
 // 5. Console infobar "Open in DevTools" → Console panel.
 await showPanel(tools.id,'network');await preview().locator('.wb-browser-toolbar').getByRole('button',{name:'Page console',exact:true}).click();
 await preview().locator('.wb-browser-console-actions').getByRole('button',{name:'Open in DevTools',exact:true}).click();
 await until(async()=>(await selectedPanels(tools.id)).includes('tab-console'),'Open in DevTools shows Console');await consistent('.pane-tab-surface:not([hidden]) .wb-web-preview .wb-browser-console-actions','console infobar with Open in DevTools');
 await preview().locator('.wb-browser-toolbar').getByRole('button',{name:'Page console',exact:true}).click();check('console bar "Open in DevTools" selects Console');
 // 6. F12 in the page toggles; Ctrl+Shift+I reopens.
 const generationBeforeClose=(await state()).documentGeneration;
 await pageInput([{type:'keyDown',keyCode:'F12'},{type:'keyUp',keyCode:'F12'}]);await until(async()=>(await state()).devtools?.open===false&&!(await attachedDevtools()),'F12 closes DevTools');
 assert.deepEqual(await allDevtoolsContents(),[tools.id],'closed DevTools stay connected in the background (no reload on reopen)');
 await pageInput([{type:'keyDown',keyCode:'I',modifiers:['control','shift']},{type:'keyUp',keyCode:'I',modifiers:['control','shift']}]);tools=await until(attachedDevtools,'Ctrl+Shift+I opens DevTools');
 await pageInput([{type:'keyDown',keyCode:'F12'},{type:'keyUp',keyCode:'F12'}]);await until(async()=>!(await attachedDevtools()),'F12 closes again');
 await pageInput([{type:'keyDown',keyCode:'F12'},{type:'keyUp',keyCode:'F12'}]);tools=await until(attachedDevtools,'F12 reopens');
 assert.equal((await state()).documentGeneration,generationBeforeClose,'reopening DevTools does not reload the page');
 await showPanel(tools.id,'console');await until(()=>inDevtools(tools.id,`return deep('.console-message-text').some(node=>node.textContent.includes('qa error one'))`),'reopened DevTools keep the console history');
 check('F12 toggles from the page; Ctrl+Shift+I opens; reopening is instant, keeps console history and never reloads the page');
 // 7. Splitter resize and persistence.
 const before=(await geometry('before resize')).tools.bounds.height;const splitter=preview().locator('.wb-browser-devtools-splitter');const sbox=await splitter.boundingBox();
 await page.mouse.move(sbox.x+sbox.width/2,sbox.y+sbox.height/2);await page.mouse.down();await page.mouse.move(sbox.x+sbox.width/2,sbox.y+sbox.height/2-90,{steps:6});await page.mouse.up();
 await until(async()=>Math.abs((await attachedDevtools()).bounds.height-(before+90))<=3,'splitter drag grows DevTools by 90 px');
 await splitter.focus();await page.keyboard.press('ArrowDown');await until(async()=>Math.abs((await attachedDevtools()).bounds.height-(before+74))<=3,'ArrowDown shrinks DevTools by 16 px');
 const stored=Number(await page.evaluate(()=>localStorage.getItem('threadterm.browser.devtoolsHeight')));assert.ok(Math.abs(stored-(before+74))<=3,`height persisted (${stored})`);
 await devtoolsButton().click();await until(async()=>!(await attachedDevtools()),'closed for persistence');await devtoolsButton().click();await until(async()=>Math.abs(((await attachedDevtools())?.bounds.height??0)-stored)<=3,'reopened at the stored height');
 tools=await attachedDevtools();await geometry('after resize');check('splitter drag and arrow keys resize DevTools; the height persists');
 // 8. App overlays never sit under DevTools: Quick Open and Settings snapshot and detach it.
 for(const [label,open,close] of [['Quick Open',()=>page.keyboard.press('Control+P'),()=>page.keyboard.press('Escape')],['Settings dialog',async()=>{await page.getByRole('button',{name:'Local user'}).click();await page.getByRole('button',{name:'Settings',exact:true}).click()},()=>page.keyboard.press('Escape')]]){
  await open();await until(async()=>!(await attachedDevtools()),`${label} detaches DevTools`);await preview().locator('.tt-browser-devtools img').waitFor();
  await page.screenshot({path:join(out,`occluded-${label.replaceAll(' ','-')}.png`),animations:'disabled'});report.screenshots.push(`occluded-${label.replaceAll(' ','-')}.png`);
  await close();await until(attachedDevtools,`${label} closed restores DevTools`);await preview().locator('.tt-browser-devtools img').waitFor({state:'detached'});
 }
 check('Quick Open and Settings: DevTools become a snapshot under the overlay and come back after it');
 // 9. Tab switch hides/restores; a DevTools link opens a page tab; closing a tab destroys its DevTools.
 await clickNativeSelector('#popup-link');await until(async()=>await page.locator('.browser-page-tab').count()>=2,'popup tab');
 await until(async()=>!(await attachedDevtools()),'another tab hides the first tab\'s DevTools');assert.ok((await allDevtoolsContents()).length>=1,'the hidden tab keeps its DevTools alive');
 await page.locator(`.browser-page-tab [role=tab][id$="-${id}"]`).click();tools=await until(attachedDevtools,'switching back restores DevTools');await geometry('after tab switch');
 const tabsBefore=await page.locator('.browser-page-tab').count();
 await inDevtools(tools.id,`InspectorFrontendHost.openInNewTab(${JSON.stringify(`${baseUrl}/linked`)});return true`);
 await until(async()=>await page.locator('.browser-page-tab').count()===tabsBefore+1,'a DevTools link opens a page tab');
 await page.locator(`.browser-page-tab [role=tab][id$="-${id}"]`).click();await until(attachedDevtools,'back to the DevTools tab');
 check('tab switch detaches/restores DevTools; DevTools links open as page tabs');
 // 10. Agent access still works with DevTools open.
 const share=name=>preview().locator('.wb-browser-toolbar').getByRole('button',{name:`Agent access ${name}`,exact:true});
 if(await share('Read').isEnabled()){await share('Read').click();await until(async()=>(await state()).sharing?.level==='read','Read with DevTools open');await share('Off').click();await until(async()=>(await state()).sharing?.level!=='read','Off again');check('agent Read sharing works while DevTools are open')}else report.limitations.push('Read was not available for the coexistence check');
 // 11. Themes and widths (DevTools follow the OS colour scheme, not the app theme).
 for(const theme of ['dark','custom','light']){await setTheme(theme);await attachedDevtools();await consistent(toolbarSelector,`toolbar ${theme} with DevTools open`);await paneShot(`devtools-${theme}.png`)}
 for(const target of [560,480]){const width=Math.round(await resizePane(target));await geometry(`pane ${width}`);await consistent(toolbarSelector,`toolbar at ${width} px with DevTools open`);
  const layout=await preview().locator('.wb-browser-toolbar').evaluate(toolbar=>{const nav=toolbar.querySelector('.wb-browser-navigation').getBoundingClientRect(),actions=toolbar.querySelector('.wb-browser-actions').getBoundingClientRect();return{width:toolbar.getBoundingClientRect().width,oneRow:Math.abs(nav.top+nav.height/2-(actions.top+actions.height/2))<1,overflow:toolbar.scrollWidth>toolbar.clientWidth+1}});
  assert.ok(!layout.overflow,`toolbar does not overflow at ${width} px`);if(layout.width>=550)assert.ok(layout.oneRow,`toolbar fits one row at ${Math.round(layout.width)} px with the DevTools button`);await paneShot(`devtools-width-${target}.png`)}
 check('toolbar stays one row from 550 px with the DevTools button; DevTools stay docked in narrow panes');
 // 12. Closing the tab destroys its DevTools.
 const remaining=await allDevtoolsContents();await page.locator(`.browser-page-tab [role=tab][id$="-${id}"]`).locator('xpath=..').locator('.browser-page-tab-close').click();
 await until(async()=>(await allDevtoolsContents()).filter(item=>remaining.includes(item)).length<remaining.length,'closing the tab destroys its DevTools contents');check('closing a tab destroys its DevTools');
 assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error?.stack??String(error));if(page)await within(()=>shot('failure.png'),5_000);process.exitCode=1}finally{if(app&&page)await within(()=>writeBrowserViewDiagnostics(app,page,out),5_000).then(result=>{if(result.timedOut)report.errors.push('Diagnostics timed out after 5000 ms');else if(result.error)report.errors.push(`Diagnostics: ${String(result.error)}`)});await close(true);if(report.errors.length)report.passed=false;await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});process.exitCode=report.passed?0:1;console.log(report.passed?'BROWSER DEVTOOLS VISUAL QA PASSED':`BROWSER DEVTOOLS VISUAL QA FAILED\n${report.errors.join('\n')}`)}
if(report.errors.length)process.exit(1);
