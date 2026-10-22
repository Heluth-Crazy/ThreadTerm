// Real Electron sidebar footer regression on Desktop 1, with an isolated fake provider.
import assert from 'node:assert/strict';
import net from 'node:net';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';
import {createHmac,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {closeBrowserViewFixture} from './lib/browser-view-cleanup.mjs';
import {checkControlConsistency,assertNoControlViolations} from './lib/visual-consistency.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratchBase=resolve('D:/project/ThreadTerm/tt-qa-temp');
await mkdir(scratchBase,{recursive:true});
const scratch=await mkdtemp(join(scratchBase,'tt-sidebar-footer-'));
assert.equal(dirname(scratch).toLowerCase(),scratchBase.toLowerCase());
const appDir=join(scratch,'app'),bin=join(scratch,'bin'),work=join(scratch,'work'),plugins=join(scratch,'plugins');
const out=join(root,'qa/results/sidebar-footer',process.argv[2]&&/^[\w.-]+$/.test(process.argv[2])?process.argv[2]:'current');
const runtime=join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),pipe=`\\\\.\\pipe\\tt-sidebar-footer-${randomUUID()}`;
const lock=join(scratchBase,'qa-electron.lock');
const report={passed:false,checks:[],screenshots:[],geometry:[],errors:[],contrast:[],limitations:['Connecting is captured during the initial authenticated snapshot delay, before settings load (English, system theme). Unavailable is exercised in all 12 theme/language/width combinations through a protocol-valid fake pipe returning snapshot errors. Fullscreen geometry is checked with the existing fullscreen class; no terminal provider is started. The app has no shell-sidebar collapse control.']};
let app,page,runtimeProcess,locked=false;
let fixtureSnapshot,fixtureFailure=false,holdSnapshot=false,held=[],servers=[],peers=[],sequence=0;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const check=value=>{report.checks.push(value);console.log(`PASS ${value}`)};
async function until(probe,label,ms=30000){const end=Date.now()+ms;for(;;){if(await probe())return;if(Date.now()>end)throw Error(`Timed out: ${label}`);await sleep(100)}}
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
function env(){
 const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
 Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_CWD:work});
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
async function footerGeometry(label){
 const value=await page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},get=selector=>document.querySelector(selector);
  const sidebar=get('.sidebar'),nav=get('.side-nav .nav-item'),avatar=get('.user-row .avatar'),status=get('.statusbar'),note=get('.sb-note');
  const text=[...document.querySelectorAll('.user-copy > *, .statusbar > span:not(.top-spacer)')].map(node=>{const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect(),b=box(node);return{text:node.textContent,inside:r.left>=b.x-1&&r.right<=b.right+1&&r.top>=b.y-1&&r.bottom<=b.bottom+1,clipped:node.scrollWidth>node.clientWidth+1,...b}});
  return{sidebar:box(sidebar),shell:box(get('.app-shell')),navInset:nav.getBoundingClientRect().left+parseFloat(getComputedStyle(nav).paddingLeft),avatar:box(avatar),status:box(status),note:box(note),content:box(get('.content.main')),text,dot:getComputedStyle(get('.runtime-dot')).backgroundColor};
 });
 assert.ok(Math.abs(value.navInset-value.avatar.x)<=1,`${label}: footer and nav content align`);
 assert.ok(Math.abs(value.sidebar.bottom-value.shell.bottom)<=1,`${label}: sidebar reaches shell bottom`);
 assert.ok(Math.abs(value.status.x-value.content.x)<=1,`${label}: status belongs to workspace column`);
 assert.ok(Math.abs(value.note.x-value.content.x-16)<=1,`${label}: status follows workspace content inset`);
 assert.ok(value.text.every(row=>row.inside&&!row.clipped),`${label}: all footer/status text fits`);
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
async function account(label,language){
 const button=page.getByRole('button',{name:language==='zh-CN'?'本地用户':'Local user',exact:true});
 await button.focus();await page.keyboard.press('Enter');await page.locator('.account-row').waitFor();assert.equal(await button.getAttribute('aria-expanded'),'true');
 const menu=await page.locator('.account-menu').boundingBox(),anchor=await button.boundingBox();assert.ok(menu&&menu.y+menu.height<=anchor.y+1,`${label}: menu anchors above button`);
 assert.equal(await page.locator('.account-avatar svg').count(),1);assert.equal(await page.locator('.user-row .avatar').innerText(),'');
 await captures(`${label}-menu`);await page.keyboard.press('Escape');assert.equal(await button.getAttribute('aria-expanded'),'false');await button.waitFor();assert.equal(await button.evaluate(node=>document.activeElement===node),true,'Escape restores account focus');
 await button.click();await page.locator('.account-row').waitFor();await page.mouse.click(600,200);await page.locator('.account-row').waitFor({state:'detached'});
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
    if(!value.method)continue;
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
async function matrix(unavailable=false){
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark','custom']){
  fixtureFailure=false;await settings(language,theme);
  for(const width of [1280,1920]){
   fixtureFailure=unavailable;
   if(unavailable){for(const peer of peers)peer.send({v:1,event:'state.changed',epoch:fixtureSnapshot.epoch,seq:++sequence,data:{}});await page.locator('.runtime-dot[data-state="unavailable"]').waitFor()}
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width);await settled();
   const label=`${language}-${theme}-${width}-${unavailable?'unavailable':'connected'}`;
   await footerGeometry(label);await contrast('.user-copy > span',label,4.5);await contrast('.user-copy small',label,3);await contrast('.sb-note',label,3);await contrast('.statusbar > span:last-child',label,3);
   const expected=unavailable?(language==='en'?'Runtime unavailable':'运行时不可用'):(language==='en'?'Runtime connected':'运行时已连接');await page.locator('.sb-note').getByText(expected,{exact:true}).waitFor();
   const dot=await page.locator('.runtime-dot').evaluate((node,token)=>{const probe=document.createElement('i');probe.style.backgroundColor=`var(${token})`;document.body.append(probe);const equal=getComputedStyle(probe).backgroundColor===getComputedStyle(node).backgroundColor;probe.remove();return equal},unavailable?'--st-failed':'--st-running');assert.equal(dot,true,`${label}: correct status color`);
   await captures(label);if(!unavailable)await account(label,language);check(`${label}: aligned, unclipped, contrast and control consistency pass${unavailable?'':'; account mouse/keyboard contracts pass'}`);
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
 await settings('en','light');
 // Layout-only guards exercise the production CSS selectors without starting a terminal.
 await page.locator('.app-shell').evaluate(node=>node.classList.add('floating-shell'));assert.equal(await page.locator('.side-foot').isVisible(),false);assert.equal(await page.locator('.statusbar').isVisible(),false);await shot('floating-layout.png');await page.locator('.app-shell').evaluate(node=>node.classList.remove('floating-shell'));
 await page.locator('.content.main').evaluate(node=>{const probe=document.createElement('div');probe.className='terminal-fullscreen';probe.dataset.qaFullscreen='true';node.append(probe)});assert.equal(await page.locator('.sidebar').isVisible(),false);assert.equal(await page.locator('.statusbar').isVisible(),false);await shot('fullscreen-layout.png');await page.locator('[data-qa-fullscreen]').evaluate(node=>node.remove());check('floating and terminal-fullscreen selectors hide footer/status and retain a single content column');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,700));await footerGeometry('900px narrow');await captures('en-light-900-narrow');check('900px narrow: footer/status remain aligned and readable');
 fixtureSnapshot=await request('runtime.snapshot');
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess}));app=undefined;page=undefined;runtimeProcess=undefined;
 holdSnapshot=true;servers=await Promise.all([fakePipe(`${pipe}-control`),fakePipe(`${pipe}-output`)]);
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:{...env(),THREADTERM_V3_RUNTIME:process.execPath},timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('.runtime-dot[data-state="connecting"]').waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
 // Boot normally covers this initial state; hide only the splash for the screenshot/geometry probe.
 const splash=await page.addStyleTag({content:'#boot-splash { visibility:hidden !important; }'});await footerGeometry('initial connecting');await page.locator('.sb-note').getByText('Connecting…',{exact:true}).waitFor();assert.equal(await page.locator('.runtime-dot').evaluate(node=>{const probe=document.createElement('i');probe.style.backgroundColor='var(--st-needs)';document.body.append(probe);const equal=getComputedStyle(probe).backgroundColor===getComputedStyle(node).backgroundColor;probe.remove();return equal}),true);await captures('en-system-1280-connecting');await splash.evaluate(node=>node.remove());check('connecting: initial delayed snapshot retains label and needs-attention dot');
 holdSnapshot=false;for(const respond of held)respond();held=[];await page.locator('#boot-splash').waitFor({state:'detached'});await matrix(true);
 report.passed=report.errors.length===0;
}catch(error){report.errors.push(error.stack??String(error));if(page)await shot('failure.png').catch(()=>{});process.exitCode=1}
finally{
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess,shutdownRuntime:servers.length===0}));
 for(const peer of peers)peer.socket.destroy();await Promise.all(servers.map(server=>new Promise(done=>server.close(done))));
 if(locked)await rm(lock,{recursive:true});
 if(report.errors.length)report.passed=false;
 await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase());await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
 console.log(report.passed?'SIDEBAR FOOTER VISUAL QA PASSED':`SIDEBAR FOOTER VISUAL QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;
}
