// Desktop-1 visual QA for native browser-view and DOM card corners. It uses only the loopback
// fixture provider; it never opens the system browser or focuses the QA window.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQaApp } from './lib/qa-app.mjs';
import { PNG } from 'pngjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { attachedNativeBrowserPages, dismissBrowserNotifications } from './lib/native-browser.mjs';
import { closeBrowserViewFixture, within } from './lib/browser-view-cleanup.mjs';
import { writeBrowserViewDiagnostics } from './lib/browser-view-diagnostics.mjs';

const scratchBase=resolve(process.env.TEMP??(()=>{throw Error('TEMP must point to tt-qa-temp');})());assert.match(scratchBase.replaceAll('\\','/').toLowerCase(),/\/tt-qa-temp$/);await mkdir(scratchBase,{recursive:true});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),fixture=join(root,'qa/fixtures/browser-plugins'),out=join(root,'qa/results/pane-corners',/^[A-Za-z0-9._-]+$/.test(process.argv[2]??'')?process.argv[2]:'current'),scratch=await mkdtemp(join(scratchBase,'tt-pane-corners-')),appDir=join(scratch,'app'),plugins=join(scratch,'plugins'),bin=join(scratch,'bin'),work=join(scratch,'work'),downloads=join(scratch,'downloads'),events=join(out,'provider-events.jsonl'),pipe=`\\\\.\\pipe\\tt-pane-corners-${randomUUID()}`;
assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase(),'scratch remains inside the approved QA root');
const report={passed:false,checks:[],screenshots:[],themes:[],radiusEvents:[],domCorners:[],errors:[],limitations:[]};let app,page,server,baseUrl,runtimeProcess,context;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));const check=value=>{report.checks.push(value);console.log(`PASS ${value}`)};
const request=(method,params={})=>page.evaluate(([a,b])=>window.threadterm.request(a,b),[method,params]);const command=value=>page.evaluate(v=>window.threadterm.browserCommand(v),value);
async function until(probe,label,ms=30000){const end=Date.now()+ms;let last;for(;;){const result=await within(probe,Math.max(1,end-Date.now()));if(result.error)last=result.error;else if(!result.timedOut&&result.value)return result.value;if(result.timedOut||Date.now()>=end)throw Error(`Timed out: ${label}${last?`: ${last.message}`:''}`);await sleep(100)}}
async function buildApp(){await buildQaApp({root,outDir:appDir})}
function env(){const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe'].includes(key.toLowerCase())));Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_BROWSER_QA_DOWNLOADS:downloads,THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_EVENTS:events,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_QA_BROWSER_URL:baseUrl});return value}
const preview=()=>page.locator('.wb-web-preview:visible').first();const pane=()=>preview().locator('xpath=ancestor::section[contains(concat(" ",normalize-space(@class)," ")," workspace-pane ")][1]');
async function tabId(){const id=await preview().getAttribute('data-web-tab-id');assert.ok(id,'visible native browser tab id');return id}async function state(){return command({type:'state',tabId:await tabId()})}
async function startRuntime(){runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});await until(async()=>{if(runtimeProcess.exitCode!==null)throw Error('fixture runtime exited during startup');let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data','runtime.credential'),'utf8')).trim());return true}finally{peer?.close()}},'fixture runtime control pipe')}
// WebContentsView.prototype defines its own setBorderRadius (probed on Electron 44), so wrap both prototypes.
// The workspace actions menu stays open once Split is disabled (pane limit); it must not cover sampled edges.
async function closeWorkspaceMenu(){const item=page.getByRole('button',{name:'Close pane',exact:true});for(let attempt=0;attempt<3&&await item.isVisible().catch(()=>false);attempt++){await page.keyboard.press('Escape');await sleep(150)}assert.equal(await item.isVisible().catch(()=>false),false,'workspace actions menu closed before sampling')}
async function instrumentRadius(){await app.evaluate(({View,WebContentsView})=>{const records=new Map();for(const type of [View,WebContentsView]){const original=type?.prototype?.setBorderRadius;if(typeof original!=='function')throw Error('Electron setBorderRadius is unavailable');if(!Object.prototype.hasOwnProperty.call(type.prototype,'setBorderRadius'))continue;type.prototype.setBorderRadius=function(radius){records.set(this.webContents?.id,radius);return original.call(this,radius)}}globalThis.__paneCornerRadiusRecords=records},{});}
async function start(){await startRuntime();app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));await page.waitForFunction(()=>Boolean(window.threadterm?.browserCommand));await page.locator('#boot-splash').waitFor({state:'detached'});await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'isolated fake Codex provider');await instrumentRadius();const snap=await request('runtime.snapshot');await request('settings.update',{patch:{language:'en',theme:'light',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});const project=(await request('runtime.snapshot')).projects?.[0]??await request('project.add',{path:work,name:'Pane corner QA',operationId:randomUUID()});const chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Pane corner QA',operationId:randomUUID()});context={project,chat};await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),chat.id);const composer=page.locator('.chat-compose-shell textarea');await composer.waitFor();await composer.fill('open preview');await page.locator('.chat-compose-send[type=submit]').click();await until(()=>preview().locator('.tt-browser-view').count(),'browser view mounted')}
async function close(final=false){const errors=await closeBrowserViewFixture({app,page,server:final?server:undefined,runtime:final?runtimeProcess:undefined,shutdownRuntime:false});report.errors.push(...errors);app=undefined;page=undefined;if(final)runtimeProcess=undefined}
async function nativeViews(){const owner=await app.browserWindow(page);let windowId;try{windowId=await owner.evaluate(window=>window.id)}finally{await owner.dispose()}return app.evaluate(({BrowserWindow,session},windowId)=>{const window=BrowserWindow.fromId(windowId),profile=session.fromPartition('persist:threadterm-browser');return window.contentView.children.map(view=>{const contents=view.webContents;return{id:contents.id,kind:contents.getURL().startsWith('devtools://')?'devtools':contents.session===profile?'page':'other',bounds:view.getBounds(),zoom:window.webContents.getZoomFactor()}})},windowId)}
async function attachedDevtools(){return (await nativeViews()).find(view=>view.kind==='devtools')}
async function nativePage(){return until(async()=>{const pages=await attachedNativeBrowserPages(app,page);return pages.length===1?pages[0]:undefined},'attached native browser page')}
async function openNativePopup(){await (await nativePage()).click('#popup')}
async function radiusSnapshot(label){
 let last;
 const result=await until(async()=>{
  await dismissBrowserNotifications(page);
  const views=(await nativeViews()).filter(view=>view.kind!=='other');
  const inner=await pane().locator('.pane-card').evaluate(node=>{const style=getComputedStyle(node);return Math.max(0,parseFloat(style.borderBottomLeftRadius)-parseFloat(style.borderBottomWidth))});
  const current=await state(),records=await app.evaluate(()=>Object.fromEntries(globalThis.__paneCornerRadiusRecords??[]));
  const expected=views.map(view=>({id:view.id,kind:view.kind,expected:Math.round(inner*view.zoom),actual:records[view.id]}));
  last={label,inner,expected,devtoolsOpen:Boolean(current.devtools?.open)};
  return views.filter(view=>view.kind==='page').length===1&&views.some(view=>view.kind==='devtools')===Boolean(current.devtools?.open)&&expected.every(value=>value.actual===value.expected)?{views,...last}:false;
 },`${label}: attached native radii match the measured pane and owner zoom`).catch(error=>{throw Error(`${error.message}: ${JSON.stringify(last)}`)});
 report.radiusEvents.push(result);return result.views;
}

function roundedMask(x,y,width,height,radius){
 const px=x+.5,py=y+.5,dx=Math.max(radius-px,0,px-(width-radius)),dy=Math.max(radius-py,0,py-(height-radius));
 return radius<=0||dx*dx+dy*dy<=radius*radius;
}
async function paneShot(name){await page.mouse.move(0,0);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));const box=await pane().boundingBox(),scale=await page.evaluate(()=>devicePixelRatio),views=(await nativeViews()).filter(value=>value.kind!=='other');assert.ok(box,'browser pane bounds');assert.equal(views.filter(view=>view.kind==='page').length,1,'composite includes one attached native page');assert.ok(views.every(view=>view.zoom===1),`composite ${name} runs after zoom reset so native DIP and renderer CSS coordinates share the default scale`);const base=PNG.sync.read(await page.screenshot({clip:box,animations:'disabled'}));for(const view of views){const data=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'),view.id);const image=PNG.sync.read(Buffer.from(data,'base64')),radius=(await app.evaluate((_,id)=>globalThis.__paneCornerRadiusRecords?.get(id),view.id))*scale,left=Math.round((view.bounds.x-box.x)*scale),top=Math.round((view.bounds.y-box.y)*scale);for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){if(!roundedMask(x,y,image.width,image.height,radius))continue;const tx=left+x,ty=top+y;if(tx<0||ty<0||tx>=base.width||ty>=base.height)continue;const from=(y*image.width+x)*4,to=(ty*base.width+tx)*4;base.data[to]=image.data[from];base.data[to+1]=image.data[from+1];base.data[to+2]=image.data[from+2];base.data[to+3]=255}}await writeFile(join(out,name),PNG.sync.write(base));report.screenshots.push(name)}
async function setTheme(theme){const snap=await request('runtime.snapshot'),custom={background:'#0b1016',surface:'#182430',text:'#f2f6fb',muted:'#93a3b5',accent:'#ff7a45',border:'#26323f'};await request('settings.update',{patch:theme==='custom'?{theme:'dark',themeSelection:'custom:pane-corners',customThemes:{'pane-corners':custom}}:{theme,themeSelection:theme},expectedRevision:snap.settings.revision,operationId:randomUUID()});await page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme==='custom'?'dark':theme);await page.waitForFunction(custom=>(document.documentElement.dataset.customTheme==='true')===custom,theme==='custom');report.themes.push(theme)}
async function resizePane(target){
 const divider=page.locator('[data-split-id] > .pane-divider').first();await until(()=>divider.count(),'workspace divider');
 const before=(await pane().boundingBox()).width;if(Math.abs(before-target)<24)target=Math.max(200,before*.8);
 for(let attempt=0;attempt<4;attempt++){
  const box=await pane().boundingBox();if(Math.abs(box.width-target)<24)break;
  const point=await divider.evaluate(node=>{const rect=node.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+(box.width-target),point.y,{steps:8});await page.mouse.up();await sleep(200);
 }
 assert.ok(Math.abs((await pane().boundingBox()).width-before)>8,'divider drag changed the native browser pane width');
}
// Panes, the inspector and side bars re-lay out over a few frames after a toggle; sample only a settled layout.
async function layoutSettled(label){let previous='',stable=0;for(let frame=0;frame<120&&stable<3;frame++){const current=await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>done(JSON.stringify([...document.querySelectorAll('section.workspace-pane,aside,.wb-panel')].map(node=>{const rect=node.getBoundingClientRect();return [Math.round(rect.x),Math.round(rect.y),Math.round(rect.width),Math.round(rect.height)]}))))));stable=current===previous?stable+1:0;previous=current}assert.ok(stable>=3,`${label}: layout settles before corner sampling`)}
async function domCorners(label,required='.pane-card'){await layoutSettled(label);
 const selectors='.pane-card,.app-shell,.sidebar,.delegation-strip,.delegate-card,.settings-panel,.inspector,.wb-panel,.history-rail,.dialog.sheet';
 const records=await page.evaluate(({selectors,required})=>[...document.querySelectorAll(selectors)].map((node,index)=>{
  const rect=node.getBoundingClientRect(),style=getComputedStyle(node),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  const workspaceSurface=node.matches('.pane-card,.inspector,.wb-panel');
  const rounded=workspaceSurface||node.matches('.settings-panel,.delegate-card,.dialog.sheet')||node.matches('.history-rail:not(.history-rail-native)');
  return{index,selector:node.className,required:node.matches(required),visible:style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0&&rect.right<=innerWidth+.5&&rect.bottom<=innerHeight+.5&&Boolean(hit&&node.contains(hit)),rounded,workspaceSurface,outerRight:rect.right>=innerWidth-.5,
   rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom},radii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].map(value=>parseFloat(value)||0),overflow:[style.overflowX,style.overflowY],border:parseFloat(style.borderBottomWidth)||0,borderColors:[style.borderTopColor,style.borderBottomColor],boxShadow:style.boxShadow};
 }),{selectors,required});
 assert.ok(records.some(record=>record.visible&&record.required),`${label}: required ${required} is unobscured`);
 let tested=0;
 for(const record of records){
  if(!record.visible)continue;
  const result={label,...record};report.domCorners.push(result);
  if(!record.rounded)continue;
   if(record.workspaceSurface){
    // At the app's fractional Electron zoom a declared 1 CSS-px hairline paints as
    // 0.8 CSS px.  Require a positive, single-device-pixel-equivalent edge rather
    // than mistaking the renderer's quantization for a missing border.
    const physicalHairline=record.border*await page.evaluate(()=>devicePixelRatio);
    assert.ok(record.border>0&&physicalHairline>=.5&&physicalHairline<=1.5,`${label}: ${record.selector} keeps one quantized theme hairline edge`);
   assert.equal(record.boxShadow,'none',`${label}: ${record.selector} has no outer shadow`);
   assert.ok(record.radii.every(radius=>radius>0),`${label}: ${record.selector} keeps four rounded floating-panel corners`);
  }else assert.ok(record.radii.every(radius=>radius>0),`${label}: ${record.selector} retains four rounded corners`);
  assert.ok(record.selector.includes('delegate-card')||record.overflow.every(value=>['hidden','clip'].includes(value)),`${label}: ${record.selector} clips its content`);
  // Isolate clipping from a card's decorative shadow without changing its geometry or radius.
  const saved=await page.evaluate(({selectors,index})=>{const node=document.querySelectorAll(selectors)[index],saved={};for(const key of ['visibility','box-shadow'])saved[key]=[node.style.getPropertyValue(key),node.style.getPropertyPriority(key)];node.style.setProperty('box-shadow','none','important');return saved},{selectors,index:record.index});
  let original,underlay;
  try{
   original=PNG.sync.read(await page.screenshot({animations:'disabled'}));
   await page.evaluate(({selectors,index})=>document.querySelectorAll(selectors)[index].style.setProperty('visibility','hidden','important'),{selectors,index:record.index});
   underlay=PNG.sync.read(await page.screenshot({animations:'disabled'}));
  }finally{
   await page.evaluate(({selectors,index,saved})=>{const node=document.querySelectorAll(selectors)[index];for(const [key,[value,priority]] of Object.entries(saved))value?node.style.setProperty(key,value,priority):node.style.removeProperty(key)},{selectors,index:record.index,saved});
  }
  const scale=await page.evaluate(()=>devicePixelRatio),x=Math.round(record.rect.x*scale),y=Math.round(record.rect.y*scale),w=Math.round(record.rect.width*scale),h=Math.round(record.rect.height*scale);
  const bounded=(image,[px,py])=>[Math.min(image.width-1,Math.max(0,px)),Math.min(image.height-1,Math.max(0,py))];
  const pixel=(image,point)=>{const [px,py]=bounded(image,point),at=(py*image.width+px)*4;return [...image.data.slice(at,at+4)]};
  const same=(a,b)=>a.every((value,index)=>Math.abs(value-b[index])<=12);
  const r=record.radii.map(radius=>Math.ceil(radius*scale)+2);
  // A pane's selected tab merges into the middle of its top edge (no border under it), so top corners compare
  // against the bottom edge's straight border instead.
  const corners=[['top-left',[x,y],[x+r[0],y],[x+Math.floor(w/2),y+h-1],record.radii[0]],['top-right',[x+w-1,y],[x+w-r[1]-1,y],[x+Math.floor(w/2),y+h-1],record.radii[1]],['bottom-left',[x,y+h-1],[x+r[2],y+h-1],[x+Math.floor(w/2),y+h-1],record.radii[2]],['bottom-right',[x+w-1,y+h-1],[x+w-r[3]-1,y+h-1],[x+Math.floor(w/2),y+h-1],record.radii[3]]];
  for(const [corner,outerPoint,innerPoint,edgePoint,radius] of corners){
   const outer=pixel(original,outerPoint),behind=pixel(underlay,outerPoint),inside=pixel(original,innerPoint),borderOrSurface=pixel(original,edgePoint);
   if(radius>0)assert.ok(same(outer,behind),`${label}: ${record.selector} ${corner} rounded outside pixel equals the background behind the surface`);
   else assert.ok(same(outer,inside),`${label}: ${record.selector} ${corner} square corner reaches its surface fill`);
   assert.ok(same(inside,borderOrSurface),`${label}: ${record.selector} ${corner} inside pixel equals the straight card border/surface`);
   (result.corners??=[]).push({corner,radius,outer,behind,inside,borderOrSurface});
  }
  tested++;
 }
 assert.ok(tested>0,`${label}: at least one clipped surface has directional corner pixel coverage`);
 const shot=`renderer-${report.domCorners.length}-${label.replace(/[^a-z0-9]+/gi,'-')}.png`;await page.screenshot({path:join(out,shot),animations:'disabled'});report.screenshots.push(shot);
}

const html=(title,body)=>`<!doctype html><title>${title}</title><style>body{font:16px sans-serif;padding:16px;margin:0;background:#e7eef7}a{display:block;margin:12px 0}</style>${body}`;
await new Promise(done=>{server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');res.writeHead(200,{'content-type':'text/html'});res.end(url.pathname==='/popup'?html('popup','<p>second browser tab</p>'):html('corner QA','<a id="popup" target="_blank" href="/popup">open a tab</a><p>native page</p>'))});server.listen(0,'127.0.0.1',done)});baseUrl=`http://127.0.0.1:${server.address().port}/`;
try{assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);await Promise.all([mkdir(out,{recursive:true}),mkdir(bin,{recursive:true}),mkdir(work,{recursive:true}),mkdir(plugins,{recursive:true})]);cpSync(fixture,join(plugins,'browser-preview-acp-qa'),{recursive:true});await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(fixture,'fake-codex-browser.cjs')}" %*\r\n`);await Promise.all([writeFile(join(work,'corners.ts'),Array.from({length:100},(_,index)=>`export const corner${index} = ${index};`).join('\n')),writeFile(join(work,'corners.html'),html('Saved corner QA','<h1>Saved HTML preview</h1><p>Iframe corner clipping.</p>'))]);await buildApp();await start();const id=await tabId();await command({type:'navigate',tabId:id,url:baseUrl});await until(async()=>{const current=await state();return current.url===baseUrl&&!current.loading},'loopback page loaded');await radiusSnapshot('first show');await domCorners('light');await paneShot('page-light.png');check('page view gets the measured inner-card radius on first show, and the workspace card has computed/corner-pixel coverage');
 const devtools=preview().getByRole('button',{name:'Developer tools',exact:true});await devtools.click();await until(async()=>(await state()).devtools?.open,'DevTools open');await until(attachedDevtools,'DevTools attached');await radiusSnapshot('DevTools open');await paneShot('devtools-light.png');await devtools.click();await until(async()=>!(await attachedDevtools()),'DevTools closed');await radiusSnapshot('DevTools closed');check('page and attached DevTools views retain the device radius through open/close');
 await devtools.click();await until(attachedDevtools,'DevTools reopened');await radiusSnapshot('DevTools reopened');await openNativePopup();await until(async()=>await pane().locator('.workspace-tab[data-tab-kind="web"]').count()>=2,'second browser tab');await until(async()=>!(await attachedDevtools()),'first tab hidden');await radiusSnapshot('tab switched');await pane().locator(`.workspace-tab[data-tab-kind="web"] [role=tab][id$="-${id}"]`).click();await until(attachedDevtools,'first tab restored');await radiusSnapshot('tab switch back');check('tab switching restores both native views with their recorded radius');
 await page.keyboard.press('Control+P');await until(async()=>(await nativeViews()).filter(view=>view.kind!=='other').length===0,'Quick Open occludes page and DevTools');await preview().locator('.tt-browser-view > img').waitFor();await preview().locator('.tt-browser-devtools > img').waitFor();const snapshotCorners=await preview().locator('.tt-browser-view > img,.tt-browser-devtools > img').evaluateAll(images=>images.map(image=>({radius:parseFloat(getComputedStyle(image).borderBottomLeftRadius)})));const inner=await pane().locator('.pane-card').evaluate(node=>parseFloat(getComputedStyle(node).borderBottomLeftRadius)-parseFloat(getComputedStyle(node).borderBottomWidth));assert.ok(snapshotCorners.length===2&&snapshotCorners.every(image=>Math.abs(image.radius-inner)<=0.5),'page and DevTools snapshots retain the measured inner radius');await page.keyboard.press('Escape');await until(attachedDevtools,'Quick Open restored native view');await radiusSnapshot('Quick Open restore');check('Quick Open occlusion/restoration reapplies the radius');
 await pane().getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('button',{name:'Split right',exact:true}).click();await closeWorkspaceMenu();await resizePane(560);await radiusSnapshot('pane resize');await domCorners('three-pane split');await pane().locator('.workspace-tab[data-tab-kind="web"] [role=tab][aria-selected=true]').click();await pane().getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('button',{name:'Fullscreen pane',exact:true}).click();await until(()=>pane().evaluate(node=>node.classList.contains('fullscreen')),'pane fullscreen');await radiusSnapshot('pane fullscreen');await page.keyboard.press('Escape');check('split resize and pane fullscreen retain the device-scaled radius');
 await pane().locator('.workspace-tab[data-tab-kind="web"] [role=tab][aria-selected=true]').click();await pane().getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('button',{name:'Split down',exact:true}).click();await until(()=>page.locator('section.workspace-pane:visible').count().then(count=>count===4),'four visible workspace panes');await closeWorkspaceMenu();await radiusSnapshot('four-pane split');await domCorners('four-pane split');
 // The app has no zoom shortcut of its own (Ctrl+= in the browser pane zooms the page), so set the owner zoom directly.
 const ownerZoom=factor=>app.evaluate(({BrowserWindow},factor)=>{for(const window of BrowserWindow.getAllWindows())window.webContents.setZoomFactor(factor)},factor);
 await ownerZoom(1.25);await until(async()=>(await nativeViews()).some(view=>view.zoom>1),'owner zoom 125% reaches the native views');await radiusSnapshot('app zoom in');await ownerZoom(1);await until(async()=>(await nativeViews()).every(view=>view.zoom===1),'app zoom reset');await radiusSnapshot('app zoom reset');check('app zoom changes update the expected rounded device radius');
 for(const theme of ['dark','custom']){await setTheme(theme);await radiusSnapshot(`${theme} theme`);await domCorners(theme);await devtools.click();await until(async()=>!(await attachedDevtools()),`${theme} DevTools closed`);await paneShot(`page-${theme}.png`);await devtools.click();await until(attachedDevtools,`${theme} DevTools reopened`);await radiusSnapshot(`${theme} DevTools reopened`);await paneShot(`devtools-${theme}.png`)}check('light, dark and custom-theme composites use a radius mask for closed and open native captures');
 // Seeded files and real runtime sessions exercise the same production pane hosts as ordinary use.
 const terminal=await request('session.create',{projectId:context.project.id,cwd:work,provider:'shell',mode:'terminal',title:'Corner terminal',operationId:randomUUID()});report.fixtureSessions={chatId:context.chat.id,terminalId:terminal.id};
 await page.locator('.pane-empty').first().getByRole('button',{name:'Choose session',exact:true}).click();await page.locator('.switcher-row').filter({hasText:'Corner terminal'}).click();await page.locator('.pane-tab-surface:not([hidden]) .xterm').first().waitFor();await domCorners('terminal pane');await page.locator('.workspace-tab-select').filter({hasText:'Pane corner QA'}).first().click();
 const files=page.locator('.wb-switcher').getByRole('button',{name:'Files',exact:true});if(await files.getAttribute('aria-pressed')!=='true')await page.keyboard.press('Control+Shift+E');await page.locator('.wb-panel').waitFor();await domCorners('workbench Files','.wb-panel');
 const openBeside=async file=>{await page.locator(`.wb-tree [data-path="${file}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'Open beside session',exact:true}).click()};
 await openBeside('corners.ts');await page.getByTestId('file-editor-surface').locator('.cm-editor').waitFor();await domCorners('file editor');
 await openBeside('corners.html');const htmlEditor=page.locator('.file-workspace:visible').filter({has:page.getByTestId('file-editor-surface')});await htmlEditor.getByRole('button',{name:'Preview',exact:true}).click();await page.locator('iframe[title="Saved HTML preview"]').waitFor();await domCorners('HTML iframe preview');
 const details=page.getByRole('button',{name:'Session details',exact:true});if(await details.getAttribute('aria-pressed')!=='true')await details.click();await page.locator('aside.inspector[aria-label="Session details"]').waitFor();await domCorners('Session inspector','.inspector');await page.locator('aside.inspector').getByRole('button',{name:'Task map',exact:true}).click();await page.locator('.task-map[data-view-ready=true]').waitFor();await domCorners('Task map');await details.click();
 await page.getByRole('button',{name:'Local user'}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').waitFor();await domCorners('Settings dialog','.settings-panel');await page.keyboard.press('Escape');report.limitations.push('Content-backed Git diff/review/history and delegated-agent cards require their dedicated git/delegation fixtures; this harness does not run git-writing setup. Floating windows are source-audited here because opening them uses app activation paths incompatible with the no-focus QA rule. Inline sidebar/delegation containers are recorded without inventing an independent rounded card boundary.');assert.deepEqual(report.errors,[],report.errors.join('\n'));report.passed=true;
}catch(error){report.errors.push(error?.stack??String(error));if(page)await within(()=>page.screenshot({path:join(out,'failure.png')}),5000);process.exitCode=1}finally{if(app&&page)await within(()=>writeBrowserViewDiagnostics(app,page,out),5000).then(result=>{if(result.error)report.errors.push(`Diagnostics: ${result.error}`)});await close(true);if(report.errors.length)report.passed=false;await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});process.exitCode=report.passed?0:1;console.log(report.passed?'PANE CORNERS VISUAL QA PASSED':`PANE CORNERS VISUAL QA FAILED\n${report.errors.join('\n')}`)}
