import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-visual-'));
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\threadterm-v3-visual-${process.pid}-${Date.now()}`,THREADTERM_V3_RUNTIME:resolve('runtime/target/debug/threadterm-v3-runtime.exe')};
let app; let page;
const report={passed:false,version:'Electron 44.3.0',startedAt:new Date().toISOString(),screenshots:[]};
async function capture(name,width){await page.setViewportSize({width,height:900});await page.screenshot({path:`qa/results/${name}-${width}.png`,fullPage:true});report.screenshots.push(`${name}-${width}.png`);}
async function setTheme(theme){await page.evaluate(async theme=>{const snapshot=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{theme},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});},theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);}
try {
  await mkdir(join(scratch,'project')); await mkdir('qa/results',{recursive:true});
  app=await electron.launch({args:[resolve('.')],env,timeout:30_000}); page=await app.firstWindow();
  await page.waitForFunction(()=>!!window.threadterm,{timeout:15_000});
  const project=await page.evaluate(path=>window.threadterm.request('project.add',{path,name:'Visual QA Project',operationId:crypto.randomUUID()}),join(scratch,'project'));
  await page.evaluate(async ({projectId,cwd})=>window.threadterm.request('session.create',{projectId,cwd,provider:'shell',mode:'terminal',title:'Visual terminal',executable:'cmd.exe',args:['/Q','/K'],operationId:crypto.randomUUID()}),{projectId:project.id,cwd:join(scratch,'project')});
  await page.reload(); await page.waitForFunction(()=>!!window.threadterm); await setTheme('dark');
  for(const width of [1280,1440]) await capture('all-dark',width);
  await page.getByRole('button',{name:/Visual terminal/}).click();await page.locator('.terminal-host').waitFor();
  for(const width of [1280,1440,1920]) await capture('terminal-dark',width);
  await page.getByLabel(/Settings|设置/).click();
  for(const width of [1280,1440]) for(const tab of ['general','shortcuts','presets','data','usage','devices']){await page.locator(`#settings-tab-${tab}`).click();await capture(`settings-${tab}-dark`,width);}
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click(); await setTheme('light');
  await page.locator('nav').getByRole('button',{name:/All sessions|所有会话/}).click();
  for(const width of [1280,1440]) await capture('all-light',width);
  await page.locator('.session-card').getByRole('button',{name:/Visual terminal/}).click(); await page.locator('.terminal-host').waitFor();
  for(const width of [1280,1440,1920]) await capture('terminal-light',width);
  report.passed=true;report.completedAt=new Date().toISOString();await writeFile('qa/results/visual-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error){report.error=error instanceof Error?error.stack:String(error);report.completedAt=new Date().toISOString();await writeFile('qa/results/visual-smoke.json',JSON.stringify(report,null,2)).catch(()=>{});throw error;
} finally {if(page)await page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})).catch(()=>{});if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await rm(scratch,{recursive:true,force:true});}
