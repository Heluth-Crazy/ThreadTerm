// Desktop 1 regression for removing saved work layouts; fake provider and isolated data only.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {closeBrowserViewFixture,within} from './lib/browser-view-cleanup.mjs';

const root=resolve(import.meta.dirname,'..'),scratchBase=resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());
await mkdir(scratchBase,{recursive:true});
const scratch=await mkdtemp(join(scratchBase,'tt-remove-presets-'));
assert.equal(dirname(scratch).toLowerCase(),scratchBase.toLowerCase());
const appDir=join(scratch,'app'),bin=join(scratch,'bin'),work=join(scratch,'work'),plugins=join(scratch,'plugins');
const out=join(root,'qa/results/remove-presets'),lock=join(scratchBase,'qa-electron.lock');
const runtime=join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'),pipe=`\\\\.\\pipe\\tt-remove-presets-${randomUUID()}`;
const report={passed:false,checks:[],screenshots:[],errors:[]};
let app,page,runtimeProcess,locked=false;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const check=value=>{report.checks.push(value);console.log(`PASS ${value}`)};
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
async function until(probe,label,ms=30000){const end=Date.now()+ms;let last;for(;;){const result=await within(probe,Math.max(1,end-Date.now()));if(result.error)last=result.error;else if(!result.timedOut&&result.value)return result.value;if(result.timedOut||Date.now()>=end)throw Error(`Timed out: ${label}${last?`: ${last.message}`:''}`);await sleep(100)}}
function env(){
 const value=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','temp','tmp','home','userprofile','codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_plugin_dirs','threadterm_v3_dev_server_url'].includes(key.toLowerCase())));
 Object.assign(value,{TEMP:scratchBase,TMP:scratchBase,PATH:[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_QA_BROWSER_CWD:work});
 assert.equal(Object.keys(value).filter(key=>key.toLowerCase()==='path').length,1);return value;
}
async function shot(name){await page.mouse.move(0,0);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
async function settings(language,theme){const snap=await request('runtime.snapshot');await request('settings.update',{patch:{language,theme,themeSelection:theme,notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snap.settings.revision,operationId:randomUUID()});await page.waitForFunction(({language,theme})=>document.documentElement.lang===(language==='zh-CN'?'zh-CN':'en')&&document.documentElement.dataset.theme===theme,{language,theme})}
async function noWorkPresets(selector){assert.doesNotMatch(await page.locator(selector).innerText(),/work presets|工作预设|commands to review|待审阅命令/i)}
try{
 await Promise.all([out,appDir,bin,work,plugins].map(path=>mkdir(path,{recursive:true})));
 await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(root,'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'remove-presets-qa',version:'1',main:'main.cjs'}));
 const deadline=Date.now()+40*60*1000;
 for(;;){try{await mkdir(lock);locked=true;break}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;console.log('Waiting for shared Electron QA lock');await sleep(15000)}}
 runtimeProcess=spawn(runtime,[],{env:env(),windowsHide:true,stdio:'ignore'});
 await until(async()=>{let peer;try{peer=await connectPeer(`${pipe}-control`);await peer.auth((await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim());return true}finally{peer?.close()}},'runtime control');
 app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env:env(),timeout:60000});
 page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('#boot-splash').waitFor({state:'detached'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,960));
 await until(async()=>(await request('provider.list')).some(provider=>provider.id==='codex'&&provider.chat),'fake Codex discovery');
 const project=await request('project.add',{path:work,name:'Removal regression',operationId:randomUUID()});
 const session=await request('session.create',{projectId:project.id,cwd:work,provider:'codex',mode:'chat',title:'Isolated workspace',operationId:randomUUID()});
 assert.equal(Object.hasOwn(await request('runtime.snapshot'),'presets'),false);
 assert.equal(Object.hasOwn((await request('data.status')).counts,'presets'),false);
 await assert.rejects(()=>request('preset.list'),/unknown|unsupported|invalid|not allowed/i);
 check('snapshot and data inventory omit presets; removed RPC is rejected');
 for(const [language,theme] of [['en','light'],['zh-CN','dark']]){
  const label=`${language}-${theme}`,zh=language==='zh-CN';await settings(language,theme);
  await page.locator('.brand-home').click();await page.locator('.workbench-page').waitFor();
  const labels=await page.locator('.side-nav .nav-item').allTextContents();
  assert.ok(labels.some(value=>value.includes(zh?'待处理':'Inbox')));assert.ok(labels.some(value=>value.includes(zh?'所有终端':'All terminals')));
  await noWorkPresets('.app-shell');await shot(`${label}-workbench.png`);
  await page.locator('.side-nav .nav-item').filter({hasText:zh?'待处理':'Inbox'}).click();await shot(`${label}-inbox.png`);
  await page.locator('.side-nav .nav-item').filter({hasText:zh?'所有终端':'All terminals'}).click();await shot(`${label}-all-terminals.png`);
  await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate',{sessionId:id}),session.id);
  await page.locator('.runtime-workspace').waitFor();
  await noWorkPresets('.app-shell');
  await page.getByRole('button',{name:zh?'会话详情面板':'Session details',exact:true}).click();await page.locator('.inspector').waitFor();
  await noWorkPresets('.inspector');await shot(`${label}-workspace-details.png`);
  await page.keyboard.press('Control+k');await page.locator('.palette').waitFor();await noWorkPresets('.palette');await shot(`${label}-command-palette.png`);
  await page.locator('.palette-input').fill(zh?'设置':'Settings');await page.locator('.palette .cmd-row').filter({hasText:zh?'设置':'Settings'}).first().click();
  await page.locator('.settings-panel').waitFor();await page.getByRole('tab',{name:zh?'数据':'Data',exact:true}).click();
  await page.locator('.settings-group.active .settings-table').waitFor();await noWorkPresets('.settings-panel');await shot(`${label}-settings-data.png`);
  await page.getByRole('button',{name:zh?'关闭设置':'Close settings',exact:true}).click();
  check(`${label}: sidebar, Workbench, palette, workspace details and Settings Data render without work presets`);
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.errors.push(error.stack??String(error));if(page)await shot('failure.png').catch(()=>{});process.exitCode=1}
finally{
 report.errors.push(...await closeBrowserViewFixture({app,page,runtime:runtimeProcess}));
 if(locked)await rm(lock,{recursive:true});
 if(report.errors.length)report.passed=false;
 await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 assert.equal(dirname(resolve(scratch)).toLowerCase(),scratchBase.toLowerCase());await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
 console.log(report.passed?'REMOVE PRESETS VISUAL QA PASSED':`REMOVE PRESETS VISUAL QA FAILED\n${report.errors.join('\n')}`);process.exitCode=report.passed?0:1;
}
