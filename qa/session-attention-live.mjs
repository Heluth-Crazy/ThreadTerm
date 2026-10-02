// Actual Electron/runtime/Codex Chat. Every data/config/profile/pipe belongs to this QA run.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const scratch=await mkdtemp(join(tmpdir(),'threadterm-session-attention-live-'));
const runtime=resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
const workspace=join(scratch,'workspace'), data=join(scratch,'data'), profile=join(scratch,'profile'), codexHome=join(scratch,'codex-home');
const report={scratch,runtime,passed:false,checks:[],errors:[]};
let app,page;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(method,params={}){return page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);}
async function until(check,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await wait(150);}throw Error('Timed out: '+label);}

try{
 await Promise.all([workspace,data,profile,codexHome].map(path=>mkdir(path)));
 await copyFile(join(process.env.USERPROFILE,'.codex','auth.json'),join(codexHome,'auth.json'));
 const excluded=new Set(['codex_home','threadterm_v3_data','threadterm_v3_user_data','threadterm_v3_pipe','threadterm_v3_runtime']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!excluded.has(key.toLowerCase())));
 Object.assign(env,{CODEX_HOME:codexHome,THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:profile,THREADTERM_V3_PIPE:`\\\\.\\pipe\\threadterm-activity-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
 app=await electron.launch({args:[resolve('.')],cwd:resolve('.'),env,timeout:60000});
 page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>Boolean(window.threadterm));
 const settings=(await request('runtime.snapshot')).settings;
 await request('settings.update',{patch:{language:'en',theme:'light'},expectedRevision:settings.revision,operationId:randomUUID()});
 const project=await request('project.add',{path:workspace,name:'Session attention live QA',operationId:randomUUID()});
 const session=await request('session.create',{projectId:project.id,cwd:workspace,provider:'codex',mode:'chat',title:'Actual Codex attention',operationId:randomUUID()});
 await request('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 const input=page.locator('.chat-compose-shell textarea');
 await input.waitFor({state:'visible',timeout:90000});
 await until(async()=>!(await input.isDisabled()),'writable composer',90000);
 const snapshotSession=async()=>(await request('runtime.snapshot')).sessions.find(candidate=>candidate.id===session.id);
 const initial=await snapshotSession();
 assert.notEqual(initial.activity?.state,'awaiting_input','a new empty session must not need attention');
 const observations=[];
 await page.evaluate(id=>{
  window.qaActivityEvents=[];
  window.qaUnsubscribeActivity=window.threadterm.onEvent(event=>{if(event.event==='session.activity'&&event.data?.sessionId===id)window.qaActivityEvents.push(event.data.activity);});
 },session.id);
 await input.fill('Reply exactly READY FOR NEXT INPUT. Do not use tools.');
 await input.press('Enter');
 const completed=await until(async()=>{const value=await snapshotSession();observations.push(value.activity?.state);return value.activity?.state==='awaiting_input'&&value.status==='idle'?value:undefined;},'native completion activity');
 const row=page.locator(`.sess-row-wrap[data-session-id="${session.id}"]`);
 await row.waitFor();
 await until(async()=>(await row.getAttribute('data-activity'))==='awaiting_input','canonical sidebar state');
 const events=await page.evaluate(()=>window.qaActivityEvents);
 assert.ok(events.some(event=>event.state==='running')||observations.includes('running'),'must observe native turn executing');
 report.checks.push('actual native turn transitions running to persisted awaiting_input');
 await row.locator('.sess-row').click();
 assert.equal((await snapshotSession()).activity.state,'awaiting_input','viewing cannot acknowledge');
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));
 await until(async()=>await row.count()&&await row.getAttribute('data-activity')==='awaiting_input','attention restored after renderer reload');
 await page.screenshot({path:join(scratch,'awaiting-input.png')});
 report.checks.push('viewing preserves attention; renderer reload restores canonical state');
 await row.hover();await row.locator('.row-more').click();
 await page.getByRole('menuitem',{name:'Mark handled',exact:true}).click();
 await until(async()=>(await snapshotSession()).activity.state==='idle','explicit handled acknowledgement');
 await until(async()=>await row.getAttribute('data-activity')==='idle','idle sidebar after ack');
 await assert.rejects(request('session.attention.acknowledge',{sessionId:session.id,expectedRevision:completed.activity.revision,operationId:randomUUID()}));
 report.checks.push('real menu acknowledges with canonical idle; stale revision is rejected');
 await row.locator('.sess-row').click();
 await until(async()=>await input.count()&&!(await input.isDisabled()),'second composer');
 await input.fill('Reply exactly SECOND TURN COMPLETE. Do not use tools.');await input.press('Enter');
 const second=await until(async()=>{const value=await snapshotSession();return value.activity?.state==='awaiting_input'&&value.activity.revision>completed.activity.revision+1?value:undefined;},'second native completion');
 assert.notEqual(second.activity.turnId,completed.activity.turnId);
 await assert.rejects(request('session.attention.acknowledge',{sessionId:session.id,expectedRevision:completed.activity.revision,operationId:randomUUID()}));
 assert.equal((await snapshotSession()).activity.state,'awaiting_input','old acknowledgement cannot clear newer turn');
 report.checks.push('next native turn has its own identity; old acknowledgement cannot clear it');
 report.observedStates=[...new Set(observations)];report.eventStates=events.map(event=>event.state);
 report.passed=true;
}catch(error){report.errors.push(String(error.stack??error));await page?.screenshot({path:join(scratch,'failure.png')}).catch(()=>{});}
finally{
 if(page)await request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 await writeFile(join(scratch,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
