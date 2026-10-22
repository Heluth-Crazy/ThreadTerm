// Real Electron inspector regression on Desktop 1, with an isolated fake provider.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
const scratch=await mkdtemp(join(scratchBase,'tt-inspector-headers-'));
assert.equal(dirname(scratch).toLowerCase(),scratchBase.toLowerCase());
const appDir=join(scratch,'app'),bin=join(scratch,'bin'),work=join(scratch,'work'),plugins=join(scratch,'plugins');
const out=join(root,'qa/results/inspector-headers',process.argv[2]&&/^[\w.-]+$/.test(process.argv[2])?process.argv[2]:'current');
const runtime=join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),pipe=`\\\\.\\pipe\\tt-inspector-headers-${randomUUID()}`;
const lock=join(scratchBase,'qa-electron.lock');
const report={passed:false,checks:[],screenshots:[],geometry:[],errors:[],limitations:['Inspector width is fixed at 320px; narrow-window coverage retains that width. A separate 260px stress probe temporarily constrains the inspector.']};
let app,page,runtimeProcess,locked=false;
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
async function headers(label,controlOptions={}){
 const rows=await page.locator('.inspector').evaluate(panel=>[...panel.querySelectorAll('.ins-head,h3,h4')].map(heading=>{
  const box=heading.getBoundingClientRect(),style=getComputedStyle(heading),parent=heading.parentElement;
  const peers=[...parent.children].filter(node=>node!==heading&&node.matches('button')).map(node=>{const b=node.getBoundingClientRect();return{text:node.textContent,overlap:box.left<b.right&&box.right>b.left&&box.top<b.bottom&&box.bottom>b.top,width:b.width,marginTop:getComputedStyle(node).marginTop}});
  const range=document.createRange();range.selectNodeContents(heading);const textBox=range.getBoundingClientRect();
  return{text:heading.textContent,width:box.width,scrollWidth:heading.scrollWidth,clientWidth:heading.clientWidth,ellipsis:style.textOverflow==='ellipsis'&&style.overflowX==='hidden',textInside:textBox.left>=box.left-1&&textBox.right<=box.right+1,peers};
 }));
 assert.ok(rows.length>=5,`${label}: inspector title and all four sections mounted`);
 for(const row of rows){assert.ok(row.width>0,`${label}: ${row.text} has width`);assert.ok(row.peers.every(peer=>!peer.overlap),`${label}: ${row.text} never overlaps actions`);assert.ok(row.scrollWidth<=row.clientWidth+1||row.ellipsis,`${label}: ${row.text} fits or intentionally ellipsizes`);if(!label.includes('long-heading'))assert.ok(row.textInside,`${label}: ${row.text} reads in full`)}
 const docs=rows.find(row=>/Plans & docs|计划与文档/.test(row.text));assert.ok(docs,`${label}: document heading exists`);
 assert.ok(docs.peers[0].width<130,`${label}: Add file keeps natural width`);assert.equal(docs.peers[0].marginTop,'0px');
 const fullWidth=await page.locator('.inspector .ins-block > .btn').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,width:node.getBoundingClientRect().width,parent:node.parentElement.clientWidth})));
 for(const action of fullWidth)assert.ok(Math.abs(action.width-action.parent)<2,`${label}: ${action.text} remains full width`);
 const consistency=await checkControlConsistency(page,'.inspector',controlOptions);assertNoControlViolations(consistency,label);assert.ok(consistency.checked>0);
 report.geometry.push({label,rows,fullWidth,consistency});
}
async function shot(name){await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
try{
 await Promise.all([out,appDir,bin,work,plugins].map(path=>mkdir(path,{recursive:true})));
 await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(root,'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 await writeFile(join(work,'plan.md'),'# Inspector header QA\n');
 for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'inspector-headers-qa',version:'1',main:'main.cjs'}));
 const deadline=Date.now()+40*60*1000;
 for(;;){try{await mkdir(lock);locked=true;break}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;console.log('Waiting for shared Electron QA lock');await sleep(15000)}}
 runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});
 await until(async()=>{let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim());return true}catch{return false}finally{peer?.close()}},'runtime control');
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});
 page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.threadterm?.request));await page.locator('#boot-splash').waitFor({state:'detached'});
 await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'fake Codex discovery');
 await settings('en','light');
 const project=await request('project.add',{path:work,name:'Inspector QA',operationId:randomUUID()});
 const chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Inspector header QA',operationId:randomUUID()});
 await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),chat.id);
 await page.locator('.chat-compose-shell textarea').waitFor();
 await page.getByRole('button',{name:'Session details',exact:true}).click();await page.locator('.inspector').waitFor();
 await page.waitForFunction(()=>document.querySelector('.session-documents-count')?.textContent==='0');
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark','custom']){
  await settings(language,theme);
  for(const [width,label] of [[1440,'default'],[900,'narrow']]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,1000),width);await settled();
   assert.equal(Math.round((await page.locator('.inspector').boundingBox()).width),320,'fixed minimum/default inspector width');
   const name=`${language}-${theme}-${label}`;await headers(name);await shot(`${name}.png`);check(`${name}: all inspector headings fit, actions do not overlap, control consistency passes`);
  }
  await page.locator('.inspector').evaluate(node=>{node.style.width='260px';node.style.flexBasis='260px'});await settled();
  await headers(`${language}-${theme}-260-stress`);await shot(`${language}-${theme}-260-stress.png`);
  const heading=page.locator('.session-documents-head h3');
  const original=await heading.evaluate(node=>{const value=node.firstChild.textContent;node.firstChild.textContent=value.repeat(12);return value});
  await headers(`${language}-${theme}-long-heading`);
  assert.ok(await heading.evaluate(node=>node.scrollWidth>node.clientWidth),'long-heading probe actually overflows');
  await shot(`${language}-${theme}-long-heading.png`);
  await heading.evaluate((node,text)=>{node.firstChild.textContent=text},original);
  await page.locator('.inspector').evaluate(node=>{node.style.removeProperty('width');node.style.removeProperty('flex-basis')});
  check(`${language}-${theme}: 260px stress and long-heading ellipsis pass`);
 }
 await request('session.documents.pin',{sessionId:chat.id,path:'plan.md',operationId:randomUUID()});
 await page.waitForFunction(()=>document.querySelector('.session-documents-count')?.textContent==='1');
 for(const language of ['en','zh-CN']){
  await settings(language,'light');await settled();
  // The two-line document link is content, not a shared button-sized control.
  await headers(`${language}-populated`,{controlSelector:'button:not(.file-reference-link):not(.session-document-open), [role="button"], .chip'});
  await shot(`${language}-populated.png`);
 }
 report.limitations.push('Populated-row control checks exclude the two-line document content link, whose intentional height differs from its small remove icon. All 24 empty-section matrix checks use the default whole-inspector control selector.');
 check('en/zh populated document heading and count fit; shared inspector controls pass');
 report.passed=report.errors.length===0;
}catch(error){report.errors.push(error.stack??String(error));if(page)await shot('failure.png').catch(()=>{});process.exitCode=1}
finally{
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess}));
 if(locked)await rm(lock,{recursive:true});
 if(report.errors.length)report.passed=false;
 await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase());await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
 console.log(report.passed?'INSPECTOR HEADERS VISUAL QA PASSED':`INSPECTOR HEADERS VISUAL QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;
}
