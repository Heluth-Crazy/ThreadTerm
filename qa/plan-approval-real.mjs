// Desktop-1 D2 acceptance QA. Run outside the sandbox only: it launches the
// production app with the deterministic fake Codex app-server, never a model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=resolve(process.env.THREADTERM_QA_RUNTIME_EXE??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const fixture=join(root,'qa/fixtures/fake-codex-plan-approval.cjs');
const out=join(root,'qa/results/chat-parity/D2/plan-approval-real');
assert.ok(existsSync(runtime),`Build QA runtime first: ${runtime}`); assert.ok(existsSync(fixture),`Missing ${fixture}`);
const scratch=await mkdtemp(join(tmpdir(),'threadterm-plan-approval-real-')); const bin=join(scratch,'bin'),workspace=join(scratch,'workspace'),log=join(scratch,'requests.jsonl');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','codex_home','openai_api_key','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_runtime'].includes(key.toLowerCase())));
Object.assign(env,{Path:[bin,dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),CODEX_HOME:join(scratch,'codex-home'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile-lane2'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\threadterm-plan-approval-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_QA_CODEX_PLAN_APPROVAL_LOG:log,THREADTERM_QA_CODEX_PLAN_APPROVAL_CWD:workspace});
assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path'],'every inherited PATH spelling is removed');
const pause=ms=>new Promise(done=>setTimeout(done,ms)); let app,page,session,lease;
const report={passed:false,checks:[],screenshots:[],runtime,scratch};
const rpc=(method,params={})=>page.evaluate(([name,value])=>window.threadterm.request(name,value),[method,params]);
const chat=()=>page.locator(`[data-testid="session-chat-${session.id}"]`); const card=()=>chat().locator('.chat-plan-approval');
async function until(probe,label){const end=Date.now()+30_000;while(Date.now()<end){if(await probe())return;await pause(100)}throw new Error(`Timed out: ${label}`)}
async function capture(name){await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)}
async function send(text){await chat().locator('.chat-compose-shell textarea').fill(text);await chat().locator('.chat-compose-shell').evaluate(form=>form.requestSubmit())}
try {
 await Promise.all([bin,workspace,env.CODEX_HOME,env.THREADTERM_V3_DATA,env.THREADTERM_V3_USER_DATA,out].map(path=>mkdir(path,{recursive:true}))); await writeFile(log,'');
 await writeFile(join(bin,'codex.cmd'),`@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
 process.env.TT_QA_DESKTOP='1'; app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',root],cwd:bin,env,timeout:60_000}); page=await app.firstWindow({timeout:30_000}); page.setDefaultTimeout(30_000);
 await page.waitForFunction(()=>Boolean(window.threadterm)); await page.locator('#boot-splash').waitFor({state:'detached'});
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));
  await page.evaluate(()=>{document.title='ThreadTerm lane2 D2 plan QA';});
 const initial=await rpc('runtime.snapshot'); await rpc('settings.update',{patch:{language:'en',theme:'light',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:initial.settings.revision,operationId:randomUUID()});
 const project=await rpc('project.add',{path:workspace,name:'Lane 2 plan approval QA',operationId:randomUUID()}); session=await rpc('session.create',{projectId:project.id,cwd:workspace,provider:'codex',mode:'chat',title:'Lane 2 plan approval QA',operationId:randomUUID()}); lease=(await rpc('session.claim',{sessionId:session.id,clientId:'lane2-plan-approval-qa'})).leaseEpoch; await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()}); await chat().locator('.chat-compose-shell textarea').waitFor();
 await send('make a plan'); await card().waitFor(); assert.match(await card().innerText(),/Review the plan/); assert.equal(await card().locator('.codex-markdown').count(),1); assert.equal(await chat().locator('.codex-markdown').count(),1,'the plan text is rendered once, by the approval card'); assertNoControlViolations(await checkControlConsistency(page,'.chat-plan-approval'),'plan approval card');
 const custom={background:'#07111f',surface:'#10233c',text:'#ffffff',muted:'#91a4bf',accent:'#3b82f6',border:'#274768'};
 for(const [theme,locale,width] of [['light','en',1280],['dark','zh-CN',420],['custom','en',420]]) {const state=await rpc('runtime.snapshot');const patch=theme==='custom'?{theme:'dark',themeSelection:'custom:qa',customThemes:{qa:custom},language:locale}:{theme,themeSelection:theme,language:locale};await rpc('settings.update',{patch,expectedRevision:state.settings.revision,operationId:randomUUID()});await page.setViewportSize({width,height:900});await capture(`pending-${theme}-${locale}-${width}.png`);assert.equal(await card().evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'no narrow horizontal overflow')}
 await card().getByRole('button',{name:/Approve/}).click(); await until(async()=>/Plan approved|计划已批准/.test(await card().innerText()),'approved receipt');
 const requests=(await readFile(log,'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse); const updates=requests.filter(entry=>entry.method==='thread/settings/update'); const turns=requests.filter(entry=>entry.method==='turn/start'); assert.ok(updates.some(entry=>entry.params.collaborationMode?.mode==='default'),'approve restores default collaboration'); assert.equal(turns.filter(entry=>entry.params.input?.some(item=>item.text==='Implement the plan.')).length,1,'approve sends exactly one Codex implementation prompt'); report.checks.push('fake plan card approved: one default-mode update and exactly one Implement the plan prompt');
 assert.deepEqual(await checkControlConsistency(page,'.chat-plan-approval').then(value=>value.violations),[]); report.passed=true;
} catch(error) { report.error=error instanceof Error?error.stack:String(error); process.exitCode=1; if(page) await capture('failure.png').catch(()=>{}); } finally { if(page) await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{}); if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})} await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2)); }
