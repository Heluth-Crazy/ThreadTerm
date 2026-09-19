import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const out=join('qa','results','workbench-agent-'+new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-workbench-agent-'));
const project=join(scratch,'project');
const pipe='\\\\.\\pipe\\threadterm-v3-workbench-agent-'+randomUUID();
const runtimeBin=process.env.THREADTERM_V3_RUNTIME_BIN
  || (existsSync(resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'))
    ? resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe')
    : resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtimeBin};
const report={startedAt:new Date().toISOString(),retainedScratch:scratch,checks:[],observations:{}}; let app,page;
const rpc=(method,params={})=>page.evaluate(([m,p])=>Promise.race([window.threadterm.request(m,p),new Promise((_,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+m)),45000))]),[method,params]);
try {
  await mkdir(out,{recursive:true});
  await mkdir(project,{recursive:true});
  await mkdir(join(scratch,'data'),{recursive:true});
  await mkdir(join(scratch,'profile'),{recursive:true});
  app=await electron.launch({args:[resolve('.')],env,timeout:60000});
  page=await app.firstWindow({timeout:30000}); page.setDefaultTimeout(30000);
  await page.waitForFunction(()=>!!window.threadterm);
  await page.locator('.app-shell').waitFor();
  await rpc('project.add',{path:project,name:'Agent menu QA',operationId:randomUUID()});
  await page.reload();
  await page.waitForFunction(()=>!!window.threadterm);
  await page.locator('.start-q').waitFor();
  await page.locator('.composer-agent-chip').waitFor();
  report.observations.chip=await page.locator('.composer-agent-chip').innerText();
  report.checks.push('agent chip visible: '+JSON.stringify(report.observations.chip));
  await page.locator('.composer-agent-chip').click();
  await page.locator('.composer-agent-menu').waitFor();
  report.observations.menu=await page.locator('.composer-agent-menu').innerText();
  const names=await page.locator('.composer-agent-item-name').allInnerTexts();
  report.observations.names=names;
  assert.equal(names.length,8);
  assert.match(names.join('|'),/Codex/);
  assert.match(names.join('|'),/Gemini/);
  assert.match(names.join('|'),/Grok/);
  assert.match(names.join('|'),/Shell/);
  assert.match(names.join('|'),/Preset|预设/);
  const icons=await page.locator('.composer-agent-menu [data-agent-icon]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-agent-icon')));
  report.observations.icons=icons;
  assert.ok(icons.includes('codex') && icons.includes('claude') && icons.includes('kimi'),'brand icons missing from the menu');
  await page.screenshot({path:join(out,'agent-menu.png')});
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
