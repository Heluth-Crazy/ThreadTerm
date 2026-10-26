// Real Electron sidebar footer regression on Desktop 1, with an isolated fake provider.
import assert from 'node:assert/strict';
import net from 'node:net';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';
import {createHmac,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
import {PNG} from 'pngjs';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {closeBrowserViewFixture} from './lib/browser-view-cleanup.mjs';
import {checkControlConsistency,assertNoControlViolations} from './lib/visual-consistency.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratchBase=resolve(process.env.TEMP??process.env.TMP??tmpdir());
await mkdir(scratchBase,{recursive:true});
const scratch=await mkdtemp(join(scratchBase,'tt-sidebar-footer-'));
assert.equal(dirname(scratch).toLowerCase(),scratchBase.toLowerCase());
const appDir=join(scratch,'app'),bin=join(scratch,'bin'),work=join(scratch,'work'),plugins=join(scratch,'plugins');
const out=join(root,'qa/results/sidebar-footer',process.argv[2]&&/^[\w.-]+$/.test(process.argv[2])?process.argv[2]:'current');
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),pipe=`\\\\.\\pipe\\tt-sidebar-footer-${randomUUID()}`;
const lock=join(scratchBase,'qa-electron.lock');
const report={passed:false,checks:[],screenshots:[],geometry:[],bottomGapPixels:[],runtimeStates:[],errors:[],contrast:[],limitations:['Reconnect states use the existing QA-only control-drop/resume IPC with the isolated runtime. Unavailable is represented by a protocol-valid runtime.transport/incompatible event delivered through the same Electron event channel used by RuntimeClient. The app applies its required 1000 ms problem-state delay before this harness samples reconnecting or unavailable. Fullscreen geometry is checked with the existing fullscreen class; no terminal provider is started. The app has no shell-sidebar collapse control.']};
let app,page,runtimeProcess,locked=false;
let fixtureSnapshot,fixtureFailure=false,holdSnapshot=false,held=[],servers=[],peers=[],sequence=0,fakeRequests=[];
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const check=value=>{report.checks.push(value);console.log(`PASS ${value}`)};
async function until(probe,label,ms=30000){const end=Date.now()+ms;for(;;){if(await probe())return;if(Date.now()>end)throw Error(`Timed out: ${label}`);await sleep(100)}}
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
function env(){
 const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
 Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_V3_RELOCATION_QA:'1'});
 assert.equal(Object.keys(value).filter(key=>key.toLowerCase()==='path').length,1);
 return value;
}
async function settings(language,theme){
 const snap=await request('runtime.snapshot');
 const custom={background:'#0b1016',surface:'#182430',text:'#f2f6fb',muted:'#93a3b5',accent:'#ff7a45',border:'#26323f'};
 await request('settings.update',{patch:{language,notifications:{native:false,attention:false,completed:false,sound:false},...(theme==='custom'?{theme:'dark',themeSelection:'custom:inspector-qa',customThemes:{'inspector-qa':custom}}:{theme,themeSelection:theme})},expectedRevision:snap.settings.revision,operationId:randomUUID()});
 await page.waitForFunction(({language,theme})=>document.documentElement.lang===(language==='zh-CN'?'zh-CN':'en')&&document.documentElement.dataset.theme===(theme==='custom'?'dark':theme)&&(document.documentElement.dataset.customTheme==='true')===(theme==='custom'),{language,theme});
}
async function settled(){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))}
async function shot(name){await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
async function captures(name){
 await page.mouse.move(600,200);await settled();await shot(`${name}-full.png`);
 const {height}=page.viewportSize()??await page.evaluate(()=>({height:innerHeight}));
 const file=`${name}-corner.png`;await page.screenshot({path:join(out,file),clip:{x:0,y:height-240,width:480,height:240},animations:'disabled'});report.screenshots.push(file);
}
async function bottomGapPixels(label){
 const value=await page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
  const content=document.querySelector('.content.main'),background=node=>{for(let current=node;current;current=current.parentElement){const color=getComputedStyle(current).backgroundColor,channels=color.match(/[\d.]+/g)?.map(Number);if(channels&&channels.length>=3&&(channels[3]??1)>0)return channels.slice(0,3)}return[0,0,0]};
  const cards=[...document.querySelectorAll('.pane-card,.wb-panel,.inspector')].filter(node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&r.width>20&&r.height>20}).map(box);
  return {content:content&&box(content),frame:content&&background(content),cards};
 });
 if(!value.cards.length){report.bottomGapPixels.push({label,skipped:'route has no floating panel'});return}
 assert.ok(value.content,`${label}: app content frame is available for panel-gap measurement`);
 // Electron's transparent outer padding and navigation rail are outside this frame.  Only
 // rightmost cards and the lowest card in each column can own the outer 12px gap.
 const rightmost=value.cards.filter(card=>!value.cards.some(peer=>peer!==card&&peer.x>=card.right-1&&peer.y<card.bottom-1&&peer.bottom>card.y+1));
 const lowest=value.cards.filter(card=>!value.cards.some(peer=>peer!==card&&peer.y>=card.bottom-1&&peer.x<card.right-1&&peer.right>card.x+1));
 const sideGaps=rightmost.map(card=>value.content.right-card.right),bottomGaps=lowest.map(card=>value.content.bottom-card.bottom);
 assert.ok(sideGaps.every(gap=>gap>=11&&gap<=13),`${label}: rightmost floating panels keep the 12px content-frame side gap`);
 assert.ok(bottomGaps.every(gap=>gap>=11&&gap<=13),`${label}: lowest floating panels keep the 12px content-frame bottom gap`);
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 const image=PNG.sync.read(await page.screenshot({animations:'disabled'})),scaleX=image.width/viewport.width,scaleY=image.height/viewport.height;
 const sample=(x,y)=>{const offset=(y*image.width+x)*4;return[image.data[offset],image.data[offset+1],image.data[offset+2]]};
 const samples=lowest.map(card=>{const x=Math.round((card.x+card.width/2)*scaleX),y=Math.round((card.bottom+Math.max(1,(value.content.bottom-card.bottom)/2))*scaleY);return{x,y,pixel:sample(x,y)}});
 assert.ok(samples.every(sample=>sample.x>=0&&sample.x<image.width&&sample.y>=0&&sample.y<image.height),`${label}: bottom-gap pixels remain inside the screenshot`);
 assert.ok(samples.every(item=>item.pixel.every((channel,index)=>Math.abs(channel-value.frame[index])<=3)),`${label}: bottom-gap pixels are the frame background`);
 report.bottomGapPixels.push({label,content:value.content,frame:value.frame,sideGaps,bottomGaps,scale:{x:scaleX,y:scaleY},samples});
}
async function footerGeometry(label){
 const value=await page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},get=selector=>document.querySelector(selector);
  const sidebar=get('.sidebar'),nav=get('.side-nav .nav-item'),avatar=get('.user-row .avatar'),content=get('.content.main'),shell=get('.app-shell');
  const text=[...document.querySelectorAll('.user-copy > *')].map(node=>{const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect(),b=box(node);return{text:node.textContent,inside:r.left>=b.x-1&&r.right<=b.right+1&&r.top>=b.y-1&&r.bottom<=b.bottom+1,clipped:node.scrollWidth>node.clientWidth+1,...b}});
  return{sidebar:box(sidebar),shell:box(shell),navInset:nav.getBoundingClientRect().left+parseFloat(getComputedStyle(nav).paddingLeft),avatar:box(avatar),content:box(content),workspace:!!content.querySelector('.runtime-workspace'),footerCount:document.querySelectorAll('.statusbar.workspace-status-footer,.sb-note').length,statusbarCount:document.querySelectorAll('.statusbar').length,text};
 });
 assert.ok(Math.abs(value.navInset-value.avatar.x)<=1,`${label}: account and nav content align`);
 assert.ok(Math.abs(value.sidebar.bottom-value.shell.bottom)<=1,`${label}: sidebar reaches shell bottom`);
 assert.equal(value.footerCount,0,`${label}: app-wide status footer and status note are absent`);
 assert.equal(value.statusbarCount,0,`${label}: no statusbar element remains on the page`);
 assert.ok(value.text.every(row=>row.inside&&!row.clipped),`${label}: account text fits`);
 assert.ok(value.text.every((row,i,rows)=>rows.every((peer,j)=>i===j||row.right<=peer.x||row.x>=peer.right||row.bottom<=peer.y||row.y>=peer.bottom)),`${label}: no text overlaps`);
 const consistency=await checkControlConsistency(page,'.side-foot',{checkStates:true,checkDisabledRows:true});assertNoControlViolations(consistency,label);assert.equal(consistency.checked,1);
 report.geometry.push({label,...value,consistency});
}
async function contrast(selector,label,minimum){
 const ratio=await page.locator(selector).first().evaluate(element=>{
  const probe=document.createElement('i');document.body.append(probe);
  const rgba=value=>{probe.style.color=value;const color=getComputedStyle(probe).color,n=color.match(/[\d.]+/g).map(Number);return color.startsWith('color(srgb')?{r:n[0]*255,g:n[1]*255,b:n[2]*255,a:n[3]??1}:{r:n[0],g:n[1],b:n[2],a:n[3]??1}};
  const over=(a,b)=>({r:a.r*a.a+b.r*(1-a.a),g:a.g*a.a+b.g*(1-a.a),b:a.b*a.a+b.b*(1-a.a),a:1});
  let bg={r:255,g:255,b:255,a:1};const layers=[];for(let node=element;node;node=node.parentElement)layers.push(rgba(getComputedStyle(node).backgroundColor));for(const layer of layers.reverse())bg=over(layer,bg);
  const fg=over(rgba(getComputedStyle(element).color),bg);probe.remove();const luminance=c=>{const channel=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4};return .2126*channel(c.r)+.7152*channel(c.g)+.0722*channel(c.b)};const [hi,lo]=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);return(hi+.05)/(lo+.05);
 });
 report.contrast.push({label,selector,ratio});assert.ok(ratio>=minimum,`${label}: ${selector} contrast ${ratio.toFixed(2)} >= ${minimum}`);
}
const runtimeCopy=(language,state)=>({
 connected:language==='zh-CN'?'运行时已连接':'Runtime connected',
 reconnecting:language==='zh-CN'?'正在重新连接…':'Reconnecting…',
 unavailable:language==='zh-CN'?'运行时不可用':'Runtime unavailable',
 chip:language==='zh-CN'?{reconnecting:'正在重新连接运行时…',unavailable:'运行时不可用'}:{reconnecting:'Reconnecting to runtime…',unavailable:'Runtime unavailable'}
}[state]);
async function account(label,language,state='connected'){
 const button=page.getByRole('button',{name:language==='zh-CN'?'本地用户':'Local user',exact:true});
 await button.focus();await page.keyboard.press('Enter');await page.locator('.account-row').waitFor();assert.equal(await button.getAttribute('aria-expanded'),'true');
 const menu=await page.locator('.account-menu').boundingBox(),anchor=await button.boundingBox();assert.ok(menu&&menu.y+menu.height<=anchor.y+1,`${label}: menu anchors above button`);
 assert.equal(await page.locator('.account-avatar svg').count(),1);assert.equal(await page.locator('.user-row .avatar').innerText(),'');
 const runtime=page.locator('[data-runtime-status]');await runtime.waitFor();await page.waitForFunction(expected=>document.querySelector('[data-runtime-status]')?.getAttribute('data-state')===expected,state);assert.equal(await runtime.getAttribute('data-state'),state,`${label}: account runtime row names its current state`);await runtime.getByText(runtimeCopy(language,state),{exact:true}).waitFor();await runtime.getByText(language==='zh-CN'?'本地运行 · 本机':'Local runtime · this computer',{exact:true}).waitFor();
 await captures(`${label}-menu`);await page.keyboard.press('Escape');assert.equal(await button.getAttribute('aria-expanded'),'false');await button.waitFor();assert.equal(await button.evaluate(node=>document.activeElement===node),true,'Escape restores account focus');
 await button.click();await page.locator('.account-row').waitFor();await page.mouse.click(600,200);await page.locator('.account-row').waitFor({state:'detached'});
}
async function runtimeProblem(label,language,state){
 const badge=page.locator('[data-runtime-badge]'),chip=page.locator('[data-runtime-chip]');
 await badge.waitFor();await chip.waitFor();assert.equal(await badge.getAttribute('data-state'),state,`${label}: account avatar problem dot has the ${state} state`);assert.equal(await chip.getAttribute('data-state'),state,`${label}: header problem chip has the ${state} state`);assert.equal(await chip.getAttribute('role'),'status',`${label}: header problem chip is a live status region`);assert.equal(await chip.getAttribute('aria-live'),'polite',`${label}: header problem chip is polite`);await chip.getByText(runtimeCopy(language,'chip')[state],{exact:true}).waitFor();const placement=await chip.evaluate(node=>({content:Boolean(node.closest('.content.main')),titlebar:Boolean(node.closest('.titlebar'))}));assert.equal(placement.content,true,`${label}: status chip is inside the active page content header`);assert.equal(placement.titlebar,false,`${label}: status chip is not painted in the OS titlebar`);
 const retry=chip.getByRole('button',{name:language==='zh-CN'?'重试':'Retry',exact:true});assert.equal(await retry.count()>0,state==='unavailable',`${label}: Retry is available only while unavailable`);if(state==='unavailable')assert.equal(await retry.isEnabled(),true,`${label}: Retry uses the existing reconnect path`);
 const dots=await page.locator('[data-runtime-badge],[data-runtime-chip] .runtime-status-dot').evaluateAll(nodes=>nodes.map(node=>{const rect=node.getBoundingClientRect(),value=getComputedStyle(node).backgroundColor.match(/[\d.]+/g)?.map(Number);return{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},color:value?.slice(0,3)}}));const image=PNG.sync.read(await page.screenshot({animations:'disabled'})),scaleX=image.width/(page.viewportSize()?.width??await page.evaluate(()=>innerWidth)),scaleY=image.height/(page.viewportSize()?.height??await page.evaluate(()=>innerHeight));const pixel=dot=>{const x=Math.round((dot.rect.x+dot.rect.width/2)*scaleX),y=Math.round((dot.rect.y+dot.rect.height/2)*scaleY),offset=(y*image.width+x)*4;return{x,y,rgb:[image.data[offset],image.data[offset+1],image.data[offset+2]]}};const dotPixels=dots.map(dot=>({...dot,...pixel(dot)}));assert.ok(dotPixels.length===2&&dotPixels.every(dot=>dot.color?.every((channel,index)=>Math.abs(channel-dot.rgb[index])<=3)),`${label}: avatar and header status-dot pixels match their theme token colours`);
 await account(label,language,state);await captures(`${label}-${state}`);const viewport=page.viewportSize()??await page.evaluate(()=>({width:innerWidth,height:innerHeight})),crop=`${label}-${state}-header-chip.png`;await page.screenshot({path:join(out,crop),clip:{x:Math.max(0,viewport.width-480),y:0,width:Math.min(480,viewport.width),height:Math.min(180,viewport.height)},animations:'disabled'});report.screenshots.push(crop);report.runtimeStates.push({label,state,chip:await chip.boundingBox(),badge:await badge.boundingBox(),dotPixels});if(state==='unavailable'){await retry.click();await page.locator('[data-runtime-chip]').waitFor({state:'detached'});}
}
async function runtimeConnected(label,language){
 assert.equal(await page.locator('[data-runtime-badge],[data-runtime-chip]').count(),0,`${label}: connected runtime remains silent outside the account menu`);await account(label,language,'connected');
}
async function openWorkspace(){
 const snapshot=await request('runtime.snapshot'),project=snapshot.projects[0]??await request('project.add',{path:work,name:'Sidebar footer QA',operationId:randomUUID()});
 const session=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Sidebar footer workspace QA',operationId:randomUUID()});
 await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),session.id);
 await page.locator('.runtime-workspace').waitFor();
 return session;
}
async function standaloneRoutes(){
 const visit=async(label,open)=>{await open();await settled();assert.equal(await page.locator('.runtime-workspace').count(),0,`${label}: remains a standalone shell`);await footerGeometry(label);await bottomGapPixels(label)};
 await visit('standalone inbox',()=>page.locator('.side-nav .nav-item').filter({hasText:'Inbox'}).click());
 await visit('standalone all terminals',()=>page.locator('.side-nav .nav-item').filter({hasText:'All terminals'}).click());
 await page.getByRole('button',{name:'Local user',exact:true}).click();await page.getByRole('button',{name:'Usage',exact:true}).click();await settled();await footerGeometry('standalone usage');await bottomGapPixels('standalone usage');
 await page.getByRole('button',{name:'Local user',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();await footerGeometry('standalone settings');await page.keyboard.press('Escape');
 check('standalone Inbox, All terminals, Usage and Settings have no app-wide status footer');
}
// The same authenticated delayed-pipe pattern as runtime-startup-recovery, with a controllable snapshot response.
async function fakePipe(name){
 const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim();
 return new Promise((done,reject)=>{
  const server=net.createServer(socket=>{let incoming=Buffer.alloc(0),authenticated=false;const nonce=randomUUID();
   const send=value=>{if(socket.destroyed)return;const body=Buffer.from(JSON.stringify(value)),frame=Buffer.alloc(4+body.length);frame.writeUInt32LE(body.length);body.copy(frame,4);socket.write(frame)};
   send({kind:'challenge',nonce,protocol:1,contract:PROTOCOL_CONTRACT});
   socket.on('error',()=>{});socket.on('data',chunk=>{incoming=Buffer.concat([incoming,chunk]);while(incoming.length>=4){const length=incoming.readUInt32LE(0);if(incoming.length<length+4)return;const value=JSON.parse(incoming.subarray(4,4+length));incoming=incoming.subarray(4+length);
    if(!authenticated){assert.equal(value.hmac,createHmac('sha256',credential).update(`1:${value.clientId}:${nonce}`).digest('hex'));authenticated=true;send({kind:'authenticated',principal:value.clientId,epoch:fixtureSnapshot.epoch,contract:PROTOCOL_CONTRACT,hmac:createHmac('sha256',credential).update(`server:1:${value.clientId}:${nonce}`).digest('hex')});peers.push({send,socket});continue}
    if(!value.method)continue;fakeRequests.push(value.method);
    const respond=()=>{if(value.method==='runtime.snapshot'&&fixtureFailure){send({v:1,id:value.id,error:{code:'runtime_unavailable',message:'QA snapshot unavailable'}});return}
     let result=[];if(value.method==='runtime.snapshot')result=fixtureSnapshot;
     if(value.method==='settings.update'){fixtureSnapshot={...fixtureSnapshot,revision:fixtureSnapshot.revision+1,settings:{...fixtureSnapshot.settings,...value.params.patch,revision:fixtureSnapshot.settings.revision+1}};result=fixtureSnapshot.settings}
     send({v:1,id:value.id,result});if(value.method==='settings.update')for(const peer of peers)peer.send({v:1,event:'state.changed',epoch:fixtureSnapshot.epoch,seq:++sequence,data:{}});
    };
    if(value.method==='runtime.snapshot'&&holdSnapshot)held.push(respond);else respond();
   }});
  });server.once('error',reject);server.listen(name,()=>done(server));
 });
}
async function matrix(scope='standalone'){
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark','custom']){
  fixtureFailure=false;await settings(language,theme);
  for(const width of [1280,1920]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width);await settled();
   const label=`${scope}-${language}-${theme}-${width}-connected`;
   assert.equal(await page.locator('.runtime-workspace').count()>0,scope==='workspace',`${label}: expected ${scope} shell`);
   await footerGeometry(label);await bottomGapPixels(label);await contrast('.user-copy > span',label,4.5);await contrast('.user-copy small',label,3);
   await captures(label);await runtimeConnected(label,language);check(`${label}: floating bottom gaps, no status footer, contrast and connected account mouse/keyboard contracts pass`);
  }
 }
}
try{
 await Promise.all([out,appDir,bin,work,plugins].map(path=>mkdir(path,{recursive:true})));
 await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(root,'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 await writeFile(join(work,'plan.md'),'# Inspector header QA\n');
 for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'sidebar-footer-qa',version:'1',main:'main.cjs'}));
 const deadline=Date.now()+40*60*1000;
 for(;;){try{await mkdir(lock);locked=true;break}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;console.log('Waiting for shared Electron QA lock');await sleep(15000)}}
 runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});
 await until(async()=>{let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim());return true}catch{return false}finally{peer?.close()}},'runtime control');
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});
 page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.threadterm?.request));await page.locator('#boot-splash').waitFor({state:'detached'});
 await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'fake Codex discovery');
 await settings('en','light');

 await matrix();
 await settings('en','light');await standaloneRoutes();
 await openWorkspace();await matrix('workspace');
 await settings('en','light');
 // Layout-only guards exercise the production CSS selectors without starting a terminal.
 await page.locator('.app-shell').evaluate(node=>node.classList.add('floating-shell'));assert.equal(await page.locator('.side-foot').isVisible(),false);assert.equal(await page.locator('.statusbar').count(),0);await shot('floating-layout.png');await page.locator('.app-shell').evaluate(node=>node.classList.remove('floating-shell'));
 await page.locator('.content.main').evaluate(node=>{const probe=document.createElement('div');probe.className='terminal-fullscreen';probe.dataset.qaFullscreen='true';node.append(probe)});assert.equal(await page.locator('.sidebar').isVisible(),false);assert.equal(await page.locator('.statusbar').count(),0);await shot('fullscreen-layout.png');await page.locator('[data-qa-fullscreen]').evaluate(node=>node.remove());check('floating and terminal-fullscreen retain a single content column without a status footer');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,700));await footerGeometry('900px narrow');await bottomGapPixels('900px narrow');await captures('en-light-900-narrow');check('900px narrow: panels retain the standard bottom gap without a status row');
 // Produce visible reconnect and unavailable states through the running app's
 // own transport/event flow, then verify Retry recovers the real snapshot.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark']){
  await settings(language,theme);const label=`${language}-${theme}-1280`;
  await runtimeConnected(`${label}-connected`,language);
  await page.evaluate(()=>window.threadtermQa.dropControl());
  await page.locator('[data-runtime-chip][data-state="reconnecting"]').waitFor({timeout:5000});await runtimeProblem(label,language,'reconnecting');
  await page.evaluate(()=>window.threadtermQa.resumeControl());await page.locator('[data-runtime-chip]').waitFor({state:'detached'});await runtimeConnected(`${label}-restored`,language);
  const current=await request('runtime.snapshot');
  await app.evaluate(({BrowserWindow},epoch)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:event',{v:1,event:'runtime.transport',epoch,seq:1000000000,data:{state:'incompatible',message:'QA protocol mismatch'}}),current.epoch);
  await page.locator('[data-runtime-chip][data-state="unavailable"]').waitFor({timeout:5000});await runtimeProblem(label,language,'unavailable');
 }
 check('reconnecting/unavailable: real control-drop and snapshot failure show avatar dot, polite header chip, localized menu row, and Retry recovery in light/dark and English/Chinese');
 fixtureSnapshot=await request('runtime.snapshot');
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess}));app=undefined;page=undefined;runtimeProcess=undefined;
 // Hold the first snapshot behind the actual boot splash for longer than the
 // problem-state gate. A startup delay must not paint a runtime warning.
 holdSnapshot=true;servers=await Promise.all([fakePipe(`${pipe}-control`),fakePipe(`${pipe}-output`)]);
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:{...env(),THREADTERM_V3_RUNTIME:process.execPath},timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.threadterm?.request));await page.locator('#boot-splash').waitFor({state:'visible'});await sleep(1200);assert.equal(await page.locator('[data-runtime-badge],[data-runtime-chip]').count(),0,'boot splash: delayed initial snapshot does not show a runtime badge or header chip');await shot('boot-delayed-no-runtime-chip.png');check('boot splash: a delayed initial snapshot remains free of runtime badge and header-chip flash after the problem-state threshold');
 holdSnapshot=false;const delayed=held;held=[];for(const respond of delayed)respond();await page.locator('#boot-splash').waitFor({state:'detached'});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
 await page.locator('#boot-splash').waitFor({state:'detached'});await shot('boot-delayed-no-runtime-chip.png');
 check('boot splash: delayed initial snapshot stays free of a runtime badge or header chip');
 report.passed=report.errors.length===0;
}catch(error){report.errors.push(error.stack??String(error));if(page)await shot('failure.png').catch(()=>{});process.exitCode=1}
finally{
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess,shutdownRuntime:servers.length===0}));
 for(const peer of peers)peer.socket.destroy();await Promise.all(servers.map(server=>new Promise(done=>server.close(done))));
 if(locked)await rm(lock,{recursive:true});
 if(report.errors.length)report.passed=false;
 await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase());await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
 const passed=report.passed&&report.errors.length===0;
 console.log(passed?'SIDEBAR FOOTER VISUAL QA PASSED':`SIDEBAR FOOTER VISUAL QA FAILED\n${report.errors.join('\n')}`);process.exitCode=passed?0:1;
}
