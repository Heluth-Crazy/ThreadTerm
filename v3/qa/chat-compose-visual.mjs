// QA-only: visual check of the kimi chat compose redesign with the real runtime and real kimi CLI.
// Isolated temp data/profile/pipe; creates one kimi ACP session, sends no prompt, changes no user data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const out=join('qa','results','chat-compose-'+new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-chat-compose-'));
const project=join(scratch,'project');
const pipe='\\\\.\\pipe\\threadterm-v3-chat-compose-'+randomUUID();
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:resolve('runtime/target/debug/threadterm-v3-runtime.exe')};
const report={startedAt:new Date().toISOString(),retainedScratch:scratch,checks:[],observations:{}}; let app,page;
const rpc=(method,params={})=>page.evaluate(([m,p])=>Promise.race([window.threadterm.request(m,p),new Promise((_,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+m)),30000))]),[method,params]);
const run=(cmd,args,cwd)=>new Promise((res,rej)=>{const p=spawn(cmd,args,{cwd,windowsHide:true});let e='';p.stderr.on('data',b=>e+=b);p.once('exit',code=>code===0?res():rej(Error(cmd+' '+e)));});
const shot=name=>page.screenshot({path:join(out,name)});
try {
  await mkdir(out,{recursive:true}); await mkdir(project,{recursive:true});
  await run('git',['init'],project); await run('git',['config','user.email','qa@example.test'],project); await run('git',['config','user.name','QA'],project);
  await writeFile(join(project,'README.md'),'chat compose visual\n'); await run('git',['add','.'],project); await run('git',['commit','-m','init'],project);
  app=await electron.launch({args:[resolve('.')],env,timeout:60000});
  page=await app.firstWindow({timeout:30000}); page.setDefaultTimeout(20000);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.threadterm); await page.locator('.app-shell').waitFor();
  await rpc('project.add',{path:project,name:'Chat compose QA',operationId:randomUUID()});
  const session=await rpc('session.create',{cwd:project,provider:'kimi',mode:'chat',title:'Chat compose QA',operationId:randomUUID()});
  report.checks.push('kimi chat session created: '+session.id);
  await page.reload(); await page.waitForFunction(()=>!!window.threadterm);
  await page.locator('.app-shell').waitFor();
  await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
  await page.locator('[data-testid^="session-chat-"]').waitFor();
  await page.locator('.chat-compose-shell textarea').waitFor();
  // Real kimi ACP config options should surface in the compose chips.
  await page.waitForFunction(()=>{
    const chip=document.querySelector('.chat-model-chip');
    return chip && chip.innerText.trim().length>1 && !chip.innerText.includes('Model');
  },undefined,{timeout:30000});
  const chips=await page.evaluate(()=>({
    model:document.querySelector('.chat-model-chip')?.innerText??null,
    mode:document.querySelector('.chat-mode-chip')?.innerText??null,
    placeholder:document.querySelector('.chat-compose-shell textarea')?.getAttribute('placeholder')??null,
  }));
  report.observations.chips=chips;
  report.checks.push('model chip text: '+JSON.stringify(chips.model));
  await page.waitForFunction(()=>document.fonts.ready.then(()=>true));
  await shot('compose-light.png');
  await page.locator('.chat-model-chip').click();
  await page.locator('.chat-compose-menu.chat-menu-model').waitFor();
  report.observations.modelMenu=await page.evaluate(()=>document.querySelector('.chat-menu-model')?.innerText??null);
  await shot('compose-light-model-menu.png');
  await page.keyboard.press('Escape');
  if(await page.locator('.chat-mode-chip').count()){
    await page.locator('.chat-mode-chip').click();
    await page.locator('.chat-compose-menu.chat-menu-mode').waitFor();
    report.observations.modeMenu=await page.evaluate(()=>document.querySelector('.chat-menu-mode')?.innerText??null);
    await shot('compose-light-mode-menu.png');
    await page.keyboard.press('Escape');
  }
  // Flip a real option through the menu to prove set_config_option round-trip.
  const before=await page.evaluate(()=>document.querySelector('.chat-model-chip')?.innerText);
  await page.locator('.chat-model-chip').click();
  await page.locator('.chat-menu-model .chat-menu-item').nth(1).click();
  await page.waitForFunction(prev=>{
    const chip=document.querySelector('.chat-model-chip');
    return chip && chip.innerText!==prev;
  },before,{timeout:20000});
  report.observations.modelAfterSwitch=await page.evaluate(()=>document.querySelector('.chat-model-chip')?.innerText);
  report.checks.push('model switch round-trip: '+JSON.stringify({before,after:report.observations.modelAfterSwitch}));
  await page.locator('textarea').click();
  await shot('compose-light-after-switch.png');
  // Slash menu regression: it shares the form > div stacking/layout hazard fixed here.
  await page.fill('.chat-compose-shell textarea','/');
  await page.locator('.chat-slash').waitFor();
  report.observations.slashMenu=await page.evaluate(()=>getComputedStyle(document.querySelector('.chat-slash')).display+' | '+(document.querySelector('.chat-slash')?.innerText??'').slice(0,120));
  await shot('compose-light-slash.png');
  await page.fill('.chat-compose-shell textarea','');
  // Dark theme.
  const settings=await rpc('settings.update',{patch:{theme:'dark'},expectedRevision:0,operationId:randomUUID()});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  report.checks.push('dark theme applied (settings revision '+settings.revision+')');
  await page.locator('.chat-model-chip').click();
  await page.locator('.chat-compose-menu.chat-menu-model').waitFor();
  await shot('compose-dark-model-menu.png');
  await page.keyboard.press('Escape');
  await shot('compose-dark.png');
  assert.deepEqual(errors,[]);
  report.passed=true;
} catch(error){
  report.passed=false; report.error=error instanceof Error?error.stack:String(error);
  if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});
  process.exitCode=1;
} finally {
  if(page)await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); await app.close().catch(()=>{});}
  report.completedAt=new Date().toISOString();
  await mkdir(out,{recursive:true});
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({out,passed:report.passed,observations:report.observations,error:report.error},null,2));
}
