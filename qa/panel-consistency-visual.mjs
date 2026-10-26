// Real production surfaces on Desktop 1; isolated runtime and fake Codex only.
// Docked panel headers (38 px) and pane tab strips (43 px Chrome-style tabs, T1) are two
// families with their own rules: qa/lib/visual-consistency.mjs holds both rule sets.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {cpSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {closeBrowserViewFixture} from './lib/browser-view-cleanup.mjs';
import {PANE_STRIP_CONTROL_SELECTOR,PANE_STRIP_HEIGHT,checkControlConsistency,isPaneStrip,paneStripViolations} from './lib/visual-consistency.mjs';

const root=resolve(import.meta.dirname,'..'),scratchBase=resolve(process.env.TEMP??(()=>{throw Error('TEMP must point to the QA scratch directory');})());
await mkdir(scratchBase,{recursive:true});
const scratch=await mkdtemp(join(scratchBase,'tt-panel-consistency-'));
assert.equal(dirname(scratch).toLowerCase(),scratchBase.toLowerCase());
const label=process.argv[2]??'before';assert.match(label,/^[\w.-]+$/);
// Every pane kind the strip must survive: the strip is identical whatever the pane shows.
const PANE_KINDS=['chat','file','terminal','browser','map','empty'];
const verify=process.argv.includes('--verify'),out=join(root,'qa/results/panel-consistency',label);
const baseline=process.argv.includes('--baseline'),baselineSources=new Map();
if(baseline){
 for(const file of ['BlockInspector.tsx','block-inspector.css','PaneWorkspace.tsx','SessionWorkspace.tsx','SessionConfigDialog.tsx','WorkbenchSideBar.tsx','WorktreeManager.tsx','task-map.css','browser-chrome.css']){
  const relative=`renderer/src/components/${file}`;
  baselineSources.set(join(root,relative).replaceAll('\\','/').toLowerCase(),execFileSync('git',['show',`HEAD:${relative}`],{cwd:root,encoding:'utf8',windowsHide:true}));
 }
 baselineSources.set(join(root,'renderer/src/components/panel-headers.css').replaceAll('\\','/').toLowerCase(),'');
}
const appDir=join(scratch,'app'),bin=join(scratch,'bin'),work=join(scratch,'work'),plugins=join(scratch,'plugins');
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),pipe=`\\\\.\\pipe\\tt-panel-${randomUUID()}`,lock=join(scratchBase,'qa-electron.lock');
const report={passed:false,checks:[],measurements:[],screenshots:[],errors:[],violations:[],limitations:[]};
let app,page,runtimeProcess,locked=false,chat,terminal,server,baseUrl;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const check=value=>{report.checks.push(value);console.log(`PASS ${value}`)};
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
async function until(probe,label,ms=30000){const end=Date.now()+ms;for(;;){if(await probe())return;if(Date.now()>end)throw Error(`Timed out: ${label}`);await sleep(100)}}
function env(){
 const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
 Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_CWD:work,THREADTERM_QA_BROWSER_URL:baseUrl});
 assert.equal(Object.keys(value).filter(key=>key.toLowerCase()==='path').length,1);return value;
}
async function settings(language,theme){const snap=await request('runtime.snapshot');await request('settings.update',{patch:{language,theme,themeSelection:theme,notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});await page.waitForFunction(({language,theme})=>document.documentElement.lang===(language==='zh-CN'?'zh-CN':'en')&&document.documentElement.dataset.theme===theme,{language,theme})}
async function settled(){await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})}
// Session switches go through the desktop navigation channel the window already uses.
const navigate=id=>app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),id);
const focusedPane=()=>page.locator('.workspace-pane.selected').first();
async function workspaceAction(name,actionsLabel='Workspace actions'){await focusedPane().getByRole('button',{name:actionsLabel,exact:true}).click();await page.getByRole('button',{name,exact:true}).click()}
async function capture(name){
 await page.mouse.move(0,0);await settled();
 const definitions=[
  ['Workbench','docked','.wb-panel-head','strong'],['Session details','docked','.inspector > .ins-head','span'],
  ['Pane tabs','pane','.workspace-pane > .workspace-tabbar.ws-strip','.workspace-tab.active .workspace-tab-label'],['File editor/preview','file','.tt-editor-tabs.file-view-tabs','.embedded-file-breadcrumb, .tt-editor-tab.active'],
  ['File/diff/review toolbar','file','.file-bar:not(.wb-browser-toolbar)','.path, .embedded-file-breadcrumb'],['Browser toolbar','browser-toolbar','.wb-browser-toolbar',null],['Files & Git','docked','.wb-tools-head','strong'],
  ['Git history','docked','.wb-history-title','strong'],['Task map','toolbar','.task-map-toolbar','.task-map-title strong'],
  ['Task map details','docked','.task-graph-details > header','strong'],['Block inspector','floating','.block-inspector-heading','h2'],
  ['Worktree list','docked','.wtm-list > header','strong'],['Worktree details','docked','.wtm-detail > header','h3'],
  ['Dialog','sheet-dialog','.dlg-head','h2'],['Configure session','sheet-dialog','.dialog-title','h2'],
  ['Local history intro','content-heading','.history-rail-heading','h3'],
  ['Settings','settings','.settings-panel > header','h2'],['Account','popover','.account-menu > .account-row','strong, b'],
  ['Browser tabs','browser-tabs','.workspace-pane > .workspace-tabbar.ws-strip:has(.browser-page-tab)','.browser-page-tab.active .browser-page-tab-title'],
  ['DevTools splitter','splitter','.wb-browser-devtools-splitter',null],['Delegated agents','strip','.delegation-header','.delegation-toggle'],
 ];
 const rows=await page.evaluate(definitions=>{
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
  // Text inside a clipped scroller (a tab label in a scrolling strip) keeps its unclipped geometry;
  // intersect it with the clipping ancestors so overlap and bounds use what the user can see.
  const visibleRect=node=>{let rect=box(node);for(let parent=node.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(!/(auto|scroll|hidden|clip)/.test(style.overflowX)&&!/(auto|scroll|hidden|clip)/.test(style.overflowY))continue;const bounds=box(parent);rect={x:Math.max(rect.x,bounds.x),y:Math.max(rect.y,bounds.y),right:Math.min(rect.right,bounds.right),bottom:Math.min(rect.bottom,bounds.bottom)};rect.width=Math.max(0,rect.right-rect.x);rect.height=Math.max(0,rect.bottom-rect.y);}return rect;};
  const context=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  const rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const [r,g,b,a]=context.getImageData(0,0,1,1).data;return {r,g,b,a:a/255}};
  const over=(a,b)=>({r:a.r*a.a+b.r*(1-a.a),g:a.g*a.a+b.g*(1-a.a),b:a.b*a.a+b.b*(1-a.a),a:1});
  const background=node=>{let bg={r:255,g:255,b:255,a:1};const layers=[];for(let n=node;n;n=n.parentElement)layers.push(rgba(getComputedStyle(n).backgroundColor));for(const layer of layers.reverse())bg=over(layer,bg);return bg};
  const luminance=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)};
  const rows=[];
  for(const [surface,family,selector,titleSelector] of definitions)for(const [index,node] of [...document.querySelectorAll(selector)].entries()){
   const r=box(node),s=getComputedStyle(node);if(!r.width||!r.height||s.visibility==='hidden'||!node.checkVisibility())continue;
   const candidate=titleSelector?node.querySelector(titleSelector):node,title=candidate?.checkVisibility()?candidate:null,ts=title&&getComputedStyle(title),bg=background(title??node),fg=ts&&over(rgba(ts.color),bg),lights=fg&&[luminance(bg),luminance(fg)].sort((a,b)=>b-a);
   const range=document.createRange();if(title)range.selectNodeContents(title);const tr=title&&range.getBoundingClientRect(),tb=title&&box(title);
   const controls=[...node.querySelectorAll('button, [role=button]')].filter(n=>n.checkVisibility()&&!(title&&(n===title||n.contains(title)||title.contains(n)))).map(n=>({label:n.getAttribute('aria-label')??n.textContent,...box(n),fontSize:getComputedStyle(n).fontSize,radius:getComputedStyle(n).borderRadius,inTab:Boolean(n.closest('.workspace-tab')),icons:[...n.querySelectorAll('.ico,.agent-icon,svg')].map(box)}));
   // A pane strip carries its tab geometry and the kind of content the pane shows, so the
   // strip family rules can compare panes with each other.
   const strip=node.matches('.workspace-tabbar.ws-strip')?node:null,card=strip&&node.closest('.workspace-pane')?.querySelector('.pane-card');
   const tabs=strip?[...strip.querySelectorAll('.workspace-tab')].map(tab=>{const rect=box(tab),style=getComputedStyle(tab),select=tab.querySelector('.workspace-tab-select'),close=tab.querySelector('.workspace-tab-close');return {active:tab.classList.contains('active'),height:rect.height,width:rect.width,bottom:rect.bottom,radius:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].map(value=>parseFloat(value)||0),selectHeight:select?box(select).height:null,closeHeight:close?box(close).height:null};}):undefined;
   const paneKind=card?(()=>{const kindOf=surface=>surface.querySelector('.xterm')?'terminal':surface.querySelector('.wb-web-preview')?'browser':surface.querySelector('.task-map')?'map':surface.querySelector('.file-workspace, .tt-editor-tabs')?'file':surface.querySelector('.chat-view, .chat-compose-shell')?'chat':'unknown';const visible=[...card.querySelectorAll('.pane-tab-surface')].find(surface=>!surface.hidden);return visible?kindOf(visible):card.querySelector('.pane-empty')?'empty':'unknown';})():undefined;
   rows.push({surface,tabs,paneKind,family:node.matches('.create-head')?'create-dialog':family,selector,index,rect:r,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],gap:s.gap,background:s.backgroundColor,effectiveBackground:bg,border:s.borderBottom,radius:[s.borderTopLeftRadius,s.borderTopRightRadius],cardRadius:[getComputedStyle(node.parentElement).borderTopLeftRadius,getComputedStyle(node.parentElement).borderTopRightRadius],title:title?{text:title.textContent,fontSize:ts.fontSize,fontWeight:ts.fontWeight,color:ts.color,lineHeight:ts.lineHeight,contrast:(lights[0]+.05)/(lights[1]+.05),rect:tb,visibleRect:visibleRect(title),clipped:title.scrollWidth>title.clientWidth+1,ellipsis:ts.textOverflow==='ellipsis',inside:tr.left>=r.x-1&&tr.right<=r.right+1&&tr.top>=r.y-1&&tr.bottom<=r.bottom+1}:null,controls});
  }
  return rows;
 },definitions);
 for(const row of rows){
  const controls=await checkControlConsistency(page,row.selector,{index:row.index,...(isPaneStrip(row)?{controlSelector:PANE_STRIP_CONTROL_SELECTOR}:{})});
  row.controlConsistency=controls;
  // A selector the helper cannot resolve must fail loudly: a silent error would disable
  // the shared-control rule for every row of that surface.
  if(controls.error)throw Error(`${row.surface} (${row.selector} [${row.index}]): ${controls.error}`);
  const errors=[];
  if(row.title&&!['strip','splitter','browser-toolbar'].includes(row.family)){
   if(row.title.contrast<4.5)errors.push(`title contrast ${row.title.contrast.toFixed(2)}`);
   if(!row.title.inside&&!row.title.ellipsis)errors.push('title outside header');
  }
  // A tab is part of the strip shape: its own controls sit inside the tab, and tabs scrolled out of the
  // strip are clipped by it (T1 overflow), so bounds are judged by the tab geometry rule instead.
  for(const control of row.controls.filter(control=>!control.inTab))if(control.x<row.rect.x-1||control.right>row.rect.right+1||control.y<row.rect.y-1||control.bottom>row.rect.bottom+1)errors.push(`action outside header: ${control.label}`);
  if(row.title&&['docked','pane','sheet-dialog','create-dialog','floating','settings','popover'].includes(row.family))for(const control of row.controls){const title=row.title.visibleRect;if(title.x<control.right-.5&&title.right>control.x+.5&&title.y<control.bottom-.5&&title.bottom>control.y+.5)errors.push(`title overlaps action: ${control.label}`)}
  if(controls.violations?.length)errors.push(...controls.violations.map(v=>v.message??JSON.stringify(v)));
  if(verify&&row.family==='docked'&&Math.abs(row.rect.height-38)>.5)errors.push(`docked header height ${row.rect.height} != 38`);
  if(errors.length)report.violations.push({name,surface:row.surface,errors});
 }
 const peers=rows.filter(row=>['Workbench','Session details','Worktree list','Worktree details'].includes(row.surface));
 const adjacent=peers.filter(row=>Math.abs(row.rect.y-peers[0].rect.y)<=1);
 if(adjacent.length>1){const delta=Math.max(...adjacent.map(row=>row.rect.bottom))-Math.min(...adjacent.map(row=>row.rect.bottom));if(delta>1)report.violations.push({name,surface:'adjacent headers',errors:[`bottom delta ${delta}`]})}
 report.measurements.push({name,rows});
 const filename=`${name}.png`;await page.screenshot({path:join(out,filename),animations:'disabled'});report.screenshots.push(filename);
}
async function closeDialog(){const close=page.locator('.session-config .dialog-title button, .settings-panel > header .icon-btn, .dialog .dlg-head > .icon-btn').last();if(await close.isVisible().catch(()=>false))await close.click();else await page.keyboard.press('Escape');await settled()}
async function optional(name,run){try{await run()}catch(error){report.limitations.push(`${name}: ${error.message}`);console.log(`LIMIT ${name}: ${error.message.split('\n')[0]}`);await closeDialog().catch(()=>{})}}
try{
 await Promise.all([out,appDir,bin,work,plugins].map(path=>mkdir(path,{recursive:true})));
 cpSync(join(root,'qa/fixtures/browser-plugins'),join(plugins,'browser-preview-acp-qa'),{recursive:true});
 server=createServer((_,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Panel browser fixture</title><h1>Loopback browser panel</h1>')});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));baseUrl=`http://127.0.0.1:${server.address().port}`;
 await writeFile(join(bin,'fake-terminal.cjs'),"process.stdout.write('Terminal ready\\r\\nPane strip fixture output\\r\\n');process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));\n");
 await writeFile(join(bin,'codex.cmd'),`@echo off\r\nif "%~1"=="--help" (echo codex-browser-qa 1.0.0 --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root,'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 await writeFile(join(work,'plan.md'),'# Panel consistency QA\n\nA saved file preview.\n');
 for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 await viteBuild({configFile:join(root,'vite.config.ts'),plugins:baseline?[{name:'panel-before-source',enforce:'pre',load(id){return baselineSources.get(id.split('?')[0].replaceAll('\\','/').toLowerCase())??null}}]:[],logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'panel-consistency-qa',version:'1',main:'main.cjs'}));
 const deadline=Date.now()+40*60*1000;for(;;){try{await mkdir(lock);locked=true;break}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;console.log('Waiting for shared Electron QA lock');await sleep(15000)}}
 runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});
 await until(async()=>{let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim());return true}catch{return false}finally{peer?.close()}},'runtime control');
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});
 page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(6000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.threadterm?.request));await page.locator('#boot-splash').waitFor({state:'detached'});
 await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'fake Codex discovery');
 await settings('en','light');
 const project=await request('project.add',{path:work,name:'Panel QA',operationId:randomUUID()});
 chat=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Panel QA',operationId:randomUUID()});
 // A terminal pane is another pane kind whose strip must match every other pane's strip.
 terminal=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'terminal',title:'Panel QA Terminal',operationId:randomUUID()});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1920,1080));
 await navigate(chat.id);
 await page.locator('.chat-compose-shell textarea').waitFor();
 await page.getByRole('button',{name:'Session details',exact:true}).click();
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark']){
  await settings(language,theme);const zh=language==='zh-CN',cell=`${language}-${theme}`;
  for(const view of [['Files','文件'],['Search','搜索'],['Source Control','源代码管理'],['Agent changes','Agent 改动']]){
   const button=page.locator('.wb-switcher').getByRole('button',{name:view[zh?1:0],exact:true});if(await button.getAttribute('aria-pressed')!=='true')await button.click();
   await capture(`${cell}-${view[0].replaceAll(' ','-')}`);
  }
  await optional('Configure session',async()=>{await page.locator('.inspector').getByRole('button',{name:zh?'配置':'Configure',exact:true}).click();await page.locator('.session-config').waitFor();await capture(`${cell}-configure`);if(verify){const subtitle=page.locator('.session-config .dialog-title p');const original=await subtitle.evaluate(node=>{const text=node.textContent;node.textContent=text.repeat(40);return text});assert.ok(await subtitle.evaluate(node=>node.scrollWidth>node.clientWidth&&getComputedStyle(node).textOverflow==='ellipsis'),'long session title ellipsizes');await capture(`${cell}-configure-long-title`);await subtitle.evaluate((node,text)=>node.textContent=text,original)}await closeDialog()});
  await optional('Task map',async()=>{await page.locator('.inspector').getByRole('button',{name:zh?'任务图':'Task map',exact:true}).click();await page.locator('.task-map').waitFor();await capture(`${cell}-task-map`);await page.locator('.workspace-pane').filter({has:page.getByRole('tab',{name:'Panel QA',exact:true})}).getByRole('tab',{name:'Panel QA',exact:true}).click()});
  await optional('File editor/preview',async()=>{await page.locator('.wb-switcher').getByRole('button',{name:zh?'文件':'Files',exact:true}).click();await page.locator('.wb-tree').getByText('plan.md',{exact:true}).dblclick();await page.locator('.file-workspace').waitFor();await capture(`${cell}-file`);const preview=page.locator('.file-workspace').getByRole('button',{name:zh?'预览':'Preview',exact:true});if(await preview.count()){await preview.click();await capture(`${cell}-preview`)}await page.locator('.workspace-pane').filter({has:page.getByRole('tab',{name:'Panel QA',exact:true})}).getByRole('tab',{name:'Panel QA',exact:true}).click()});
  await optional('Browser and DevTools',async()=>{
   const browser=page.locator('.wb-web-preview:visible');
   if(!await browser.count()){
    await page.locator('.workspace-pane').filter({has:page.getByRole('tab',{name:'Panel QA',exact:true})}).getByRole('tab',{name:'Panel QA',exact:true}).click();
    await page.locator('.chat-compose-shell textarea:visible').fill('open preview');await page.locator('.chat-compose-send[type=submit]:visible').click();
    await page.locator('.wb-web-preview:visible').waitFor({timeout:30000});
   }
   await capture(`${cell}-browser`);
   const tools=page.locator('.wb-web-preview:visible').getByRole('button',{name:zh?'开发者工具':'Developer tools',exact:true});
   await tools.click();await page.locator('.wb-browser-devtools-splitter:visible').waitFor();await capture(`${cell}-devtools`);await tools.click();
   await page.locator('.workspace-pane').filter({has:page.getByRole('tab',{name:'Panel QA',exact:true})}).getByRole('tab',{name:'Panel QA',exact:true}).click();
  });
  await optional('Terminal pane',async()=>{
   try{
    await navigate(terminal.id);await page.locator('.xterm:visible').waitFor({timeout:30000});
    const printed=await page.getByText('Terminal ready',{exact:true}).waitFor({timeout:15000}).then(()=>true,()=>false);
    if(!printed)report.limitations.push('Terminal pane: the fake terminal banner did not reach the xterm buffer; the strip was measured anyway');
    await capture(`${cell}-terminal`);
   }finally{await navigate(chat.id);await page.locator('.chat-compose-shell textarea:visible').waitFor({timeout:30000})}
  });
  await optional('Empty pane',async()=>{
   const panes=await page.locator('[data-pane-id]').count();
   await workspaceAction(zh?'左右拆分':'Split right',zh?'工作区操作':'Workspace actions');
   await until(async()=>(await page.locator('[data-pane-id]').count())===panes+1,'split pane');
   await page.locator('.workspace-pane .pane-empty').waitFor({state:'visible'});
   await capture(`${cell}-empty-pane`);
   await workspaceAction(zh?'关闭窗格':'Close pane',zh?'工作区操作':'Workspace actions');
   await until(async()=>(await page.locator('[data-pane-id]').count())===panes,'pane closed');
  });
  await optional('Account menu',async()=>{await page.getByRole('button',{name:zh?'本地用户':'Local user',exact:true}).click();await page.locator('.account-menu').waitFor();await capture(`${cell}-account`);await page.keyboard.press('Escape')});
  await optional('Settings',async()=>{await page.getByRole('button',{name:zh?'本地用户':'Local user',exact:true}).click();await page.getByRole('button',{name:zh?'设置':'Settings',exact:true}).click();await page.locator('.settings-panel').waitFor();await capture(`${cell}-settings`);await closeDialog()});
  await optional('Add project',async()=>{await page.locator('.side-scope').click();await page.getByRole('menuitem',{name:zh?'添加项目':'Add project',exact:true}).click();await page.getByRole('dialog').waitFor();await capture(`${cell}-add-project`);await closeDialog()});
  check(`${cell}: production panel/header inventory and screenshots captured`);
 }
 await esbuild({entryPoints:[join(root,'qa/fixtures/panel-surfaces.tsx')],bundle:true,platform:'browser',format:'iife',outfile:join(scratch,'surfaces.js'),alias:{'@threadterm/protocol':join(root,'protocol/index.ts')},loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},plugins:baseline?[{name:'panel-before-source',setup(build){build.onLoad({filter:/renderer[\\/]src[\\/]components[\\/]/},args=>{const contents=baselineSources.get(args.path.replaceAll('\\','/').toLowerCase());return contents===undefined?null:{contents,loader:args.path.endsWith('.css')?'css':'tsx'}})}}]:[],logLevel:'error'});
 await writeFile(join(scratch,'surfaces.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="surfaces.css"><style>html,body,#root{height:100%;margin:0}.qa-panel-surface{position:relative;height:100%;min-width:0;overflow:hidden}</style></head><body><div id="root"></div><script src="surfaces.js"></script></body></html>');
 const productionPage=page;
 const fixtureId=await app.evaluate(async({BrowserWindow},file)=>{const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,sandbox:true}});await window.loadFile(file);return window.webContents.id},join(scratch,'surfaces.html'));
 page=app.windows().find(candidate=>candidate.url().endsWith('/surfaces.html'));assert.ok(page,'mounted production fixture window');page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.qaPanelSurfaces));
 for(const language of ['en','zh-CN'])for(const theme of ['light','dark'])for(const surface of ['block-inspector','worktree-manager','task-map','git-history','review-diff','delegation','terminal','local-history']){
  await page.evaluate(({surface,language,theme})=>window.qaPanelSurfaces.render(surface,language,theme),{surface,language,theme});await settled();
  if(surface==='worktree-manager')await page.locator('.wtm-detail h3').waitFor();
  if(surface==='git-history'){await page.locator('.wb-commit-head').waitFor();await page.locator('.wb-history-diff .cm-editor').first().waitFor()}
  if(surface==='review-diff')await page.locator('.wb-review-diff .cm-editor').first().waitFor();
  if(surface==='local-history')await page.getByText('Native panel header audit',{exact:true}).waitFor();
  if(surface==='task-map'){await page.locator('.task-graph-box').first().waitFor();await page.locator('.task-graph-box').first().dblclick();}
  await capture(`${language}-${theme}-fixture-${surface}`);
  if(surface==='local-history'){await page.getByRole('button',{name:language==='zh-CN'?'ThreadTerm 记录':'ThreadTerm records',exact:true}).click();await page.locator('.session-history-rail').waitFor();await capture(`${language}-${theme}-fixture-local-history-saved`)}
 }
 await app.evaluate(({webContents},id)=>webContents.fromId(id)?.close(),fixtureId);page=productionPage;
 check('mounted production Block Inspector, worktree manager, task-map details, Git history/review and delegation inventory captured');
 if(verify){
  for(const language of ['en','zh-CN'])for(const theme of ['light','dark']){
   const rows=report.measurements.filter(cell=>cell.name.startsWith(`${language}-${theme}-`)).flatMap(cell=>cell.rows);
   // Docked panels keep the shared header scale (unchanged rules).
   const docked=rows.filter(row=>row.family==='docked');assert.ok(docked.length>0);
   const signature=row=>JSON.stringify({padding:row.padding,gap:row.gap,background:row.background,border:row.border,radius:row.radius,font:row.title&&[row.title.fontSize,row.title.fontWeight,row.title.color,row.title.lineHeight]});
   assert.equal(new Set(docked.map(signature)).size,1,`${language}-${theme}: docked heading typography, insets, gap, surface and rule match`);
   assert.ok(docked.every(row=>Math.abs(row.rect.height-38)<=.5),`${language}-${theme}: 38px docked family height`);
   assert.ok(docked.every(row=>row.controls.every(control=>Math.abs(control.height-26)<=.5&&(!control.icons.length||Math.abs(control.width-26)<=.5))),`${language}-${theme}: 26px docked icon actions and text control height`);
   // Pane tab strips are a family of their own (T1): one 43 px strip per pane, one selected
   // tab per strip, identical strip geometry in every pane kind.
   const strips=rows.filter(isPaneStrip);assert.ok(strips.length>0,`${language}-${theme}: pane tab strips measured`);
   const stripFailures=paneStripViolations(rows);
   if(stripFailures.length)report.violations.push({name:`${language}-${theme}`,surface:'pane strips',errors:stripFailures.map(failure=>`${failure.surface}: ${failure.errors.join('; ')}`)});
   assert.deepEqual(stripFailures,[],`${language}-${theme}: ${PANE_STRIP_HEIGHT}px pane tab strips with the T1 tab geometry\n${JSON.stringify(stripFailures,null,2)}`);
   const kinds=[...new Set(strips.map(row=>row.paneKind))],missing=PANE_KINDS.filter(kind=>!kinds.includes(kind));
   assert.deepEqual(missing,[],`${language}-${theme}: pane strip measured in every pane kind; missing ${missing.join(', ')}`);
   const sheets=rows.filter(row=>row.family==='sheet-dialog');assert.ok(sheets.length>=2);
   assert.ok(Math.max(...sheets.map(row=>row.rect.height))-Math.min(...sheets.map(row=>row.rect.height))<=.5,`${language}-${theme}: sheet/configure header height matches`);
   assert.equal(new Set(sheets.map(row=>JSON.stringify({padding:row.padding,gap:row.gap,font:row.title&&[row.title.fontSize,row.title.fontWeight,row.title.lineHeight]}))).size,1,`${language}-${theme}: sheet typography, insets and gap match`);
   check(`${language}-${theme}: docked family styles equal within 0.5px; pane strips ${PANE_STRIP_HEIGHT}px in ${kinds.length} pane kinds (${kinds.join('/')}); adjacent dividers within 1px; shared controls and title contrast pass`);
  }
 }
 if(verify)assert.deepEqual(report.violations,[],JSON.stringify(report.violations,null,2));
 check(verify?'header geometry, title contrast, bounds and shared controls pass':'before measurements recorded without asserting the known inconsistencies');
 report.passed=report.errors.length===0;
}catch(error){report.errors.push(error.stack??String(error));if(page)await capture('failure').catch(()=>{});process.exitCode=1}
finally{
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess,server}));
 if(locked)await rm(lock,{recursive:true});
 if(report.errors.length)report.passed=false;
 await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 await writeFile(join(out,'measurements.md'),'| Capture | Surface | Family | Height | Inset L/R | Title px / weight / line | Background | Border | Contrast |\n|---|---|---|---:|---|---|---|---|---:|\n'+report.measurements.flatMap(cell=>cell.rows.map(row=>`| ${cell.name} | ${row.surface} | ${row.family} | ${row.rect.height} | ${row.padding[3]} / ${row.padding[1]} | ${row.title?`${row.title.fontSize} / ${row.title.fontWeight} / ${row.title.lineHeight}`:'—'} | ${row.background} | ${row.border} | ${row.title?.contrast.toFixed(2)??'—'} |`)).join('\n')+'\n');
 assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase());await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
 console.log(report.passed?'PANEL CONSISTENCY VISUAL QA PASSED':`PANEL CONSISTENCY VISUAL QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;
}
