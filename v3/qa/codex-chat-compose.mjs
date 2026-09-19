// QA-only: visual check of Codex chat compose (slash commands, model, thinking).
// Isolated temp data/profile/pipe; test model gpt-5.5-luna.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const TEST_MODEL=/gpt-5\.5-luna|5\.5-luna|5\.5.*luna/i;
const out=join('qa','results','codex-chat-compose-'+new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-codex-compose-'));
const project=join(scratch,'project');
const pipe='\\\\.\\pipe\\threadterm-v3-codex-compose-'+randomUUID();
const runtimeBin=process.env.THREADTERM_V3_RUNTIME_BIN
  || (existsSync(resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'))
    ? resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe')
    : resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtimeBin};
const report={startedAt:new Date().toISOString(),retainedScratch:scratch,checks:[],observations:{}}; let app,page;
const rpc=(method,params={})=>page.evaluate(([m,p])=>Promise.race([window.threadterm.request(m,p),new Promise((_,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+m)),45000))]),[method,params]);
const run=(cmd,args,cwd)=>new Promise((res,rej)=>{const p=spawn(cmd,args,{cwd,windowsHide:true});let e='';p.stderr.on('data',b=>e+=b);p.once('exit',code=>code===0?res():rej(Error(cmd+' '+e)));});
const shot=name=>page.screenshot({path:join(out,name)});
try {
  await mkdir(out,{recursive:true}); await mkdir(project,{recursive:true});
  await mkdir(join(scratch,'data'),{recursive:true}); await mkdir(join(scratch,'profile'),{recursive:true});
  await run('git',['init'],project); await run('git',['config','user.email','qa@example.test'],project); await run('git',['config','user.name','QA'],project);
  await writeFile(join(project,'README.md'),'codex chat compose visual\n'); await run('git',['add','.'],project); await run('git',['commit','-m','init'],project);
  app=await electron.launch({args:[resolve('.')],env,timeout:60000});
  page=await app.firstWindow({timeout:30000}); page.setDefaultTimeout(30000);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.threadterm); await page.locator('.app-shell').waitFor();
  await rpc('project.add',{path:project,name:'Codex compose QA',operationId:randomUUID()});
  const session=await rpc('session.create',{cwd:project,provider:'codex',mode:'chat',title:'Codex compose QA',operationId:randomUUID()});
  report.checks.push('codex chat session created: '+session.id);
  await page.reload(); await page.waitForFunction(()=>!!window.threadterm);
  await page.locator('.app-shell').waitFor();
  await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
  await page.locator('[data-testid^="session-chat-"]').waitFor();
  await page.locator('.chat-compose-shell textarea').waitFor();
  await page.waitForFunction(()=>{
    const chip=document.querySelector('.chat-model-chip');
    return chip && chip.innerText.trim().length>1 && !chip.innerText.includes('Model');
  },undefined,{timeout:45000});
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
  const luna=page.locator('.chat-menu-model .chat-menu-item').filter({hasText:TEST_MODEL});
  if(await luna.count()){
    await luna.first().click();
    await page.waitForFunction(()=>{
      const chip=document.querySelector('.chat-model-chip');
      return chip && /5\.5/i.test(chip.innerText) && /luna/i.test(chip.innerText);
    },undefined,{timeout:20000});
    report.checks.push('clicked gpt-5.5-luna in the model menu');
  } else {
    const before=await page.evaluate(()=>document.querySelector('.chat-model-chip')?.innerText);
    await page.locator('.chat-menu-model .chat-menu-item').nth(1).click();
    await page.waitForFunction(prev=>{
      const chip=document.querySelector('.chat-model-chip');
      return chip && chip.innerText!==prev;
    },before,{timeout:20000});
    report.checks.push('gpt-5.5-luna not in picker; switched another catalog model');
  }
  report.observations.modelAfterSwitch=await page.evaluate(()=>document.querySelector('.chat-model-chip')?.innerText);
  await page.locator('.chat-model-chip').click();
  await page.locator('.chat-compose-menu.chat-menu-model').waitFor();
  const thinking=page.locator('.chat-menu-model .chat-menu-item').filter({hasNot:page.locator('[aria-checked="true"]')});
  if(await thinking.count()){
    const before=await page.evaluate(()=>document.querySelector('.chat-model-think')?.innerText);
    await thinking.first().click();
    await page.waitForFunction(prev=>{
      const label=document.querySelector('.chat-model-think')?.innerText;
      return !prev || label!==prev;
    },before,{timeout:20000}).catch(()=>{});
    report.observations.thinkingAfterSwitch=await page.evaluate(()=>document.querySelector('.chat-model-think')?.innerText);
    report.checks.push('thinking after switch: '+JSON.stringify(report.observations.thinkingAfterSwitch));
  }
  if(await page.locator('.chat-mode-chip').count()){
    await page.locator('.chat-mode-chip').click();
    await page.locator('.chat-compose-menu.chat-menu-mode').waitFor();
    report.observations.modeMenu=await page.evaluate(()=>document.querySelector('.chat-menu-mode')?.innerText??null);
    await shot('compose-light-mode-menu.png');
    await page.keyboard.press('Escape');
  }
  await page.fill('.chat-compose-shell textarea','/');
  await page.locator('.chat-slash').waitFor();
  report.observations.slashMenu=await page.evaluate(()=>getComputedStyle(document.querySelector('.chat-slash')).display+' | '+(document.querySelector('.chat-slash')?.innerText??'').slice(0,240));
  assert.match(report.observations.slashMenu,/compact/i,'slash menu is missing /compact');
  await shot('compose-light-slash.png');
  await page.fill('.chat-compose-shell textarea','');
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
