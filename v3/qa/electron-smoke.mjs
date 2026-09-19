import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-electron-'));
const pipe=`\\\\.\\pipe\\threadterm-v3-qa-${process.pid}-${Date.now()}`;
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:resolve('runtime/target/debug/threadterm-v3-runtime.exe')};
let app;
let page;
const report={version:'Electron 44.3.0',startedAt:new Date().toISOString(),checks:[]};
try {
  await mkdir(join(scratch,'project')); await mkdir('qa/results',{recursive:true});
  app=await electron.launch({args:[resolve('.')],env,timeout:30_000});
  page=await app.firstWindow(); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>!!window.threadterm,{timeout:15_000});
  const initial=await page.evaluate(()=>window.threadterm.request('runtime.snapshot',{})); assert.equal(initial.sessions.length,0);
  const project=await page.evaluate(async path=>window.threadterm.request('project.add',{path,name:'V3 QA Project',operationId:crypto.randomUUID()}),join(scratch,'project'));
  const session=await page.evaluate(async ({projectId,cwd})=>window.threadterm.request('session.create',{projectId,cwd,provider:'shell',mode:'terminal',title:'Electron live shell',executable:'cmd.exe',args:['/Q','/K'],operationId:crypto.randomUUID()}),{projectId:project.id,cwd:join(scratch,'project')});
  await page.getByRole('button',{name:/Electron live shell/}).click();
  await page.locator('.terminal-host').waitFor();
  // TerminalSurface owns this lease before the floating window is created.
  await page.locator('.terminal-host').click();
  await page.keyboard.type('echo ELECTRON_REAL_TERMINAL'); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('ELECTRON_REAL_TERMINAL'),{timeout:12_000});
  report.checks.push('TerminalSurface acquired the main-window lease and accepted real PTY input/output');
  await page.getByRole('button',{name:/Open (window|in window)|打开窗口/i}).click();
  const second=await app.waitForEvent('window',{predicate:window=>window!==page,timeout:12_000});
  await second.waitForFunction(()=>!!window.threadterm); await second.locator('.terminal-host').waitFor();
  await second.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('ELECTRON_REAL_TERMINAL'),{timeout:12_000});
  await second.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent?.includes('Read-only view'),{timeout:12_000});
  const rejected=await second.evaluate(async id=>{try { await window.threadterm.request('session.claim',{sessionId:id,clientId:'qa-second-window'}); return false; } catch { return true; }},session.id);
  assert.equal(rejected,true,'second window must not obtain the active terminal lease');
  report.checks.push('floating TerminalSurface showed replayed output and was read-only while the main lease remained active');
  await page.reload(); await page.waitForFunction(()=>!!window.threadterm);
  const preserved=await page.evaluate(()=>window.threadterm.request('runtime.snapshot',{})); assert.equal(preserved.sessions.find(item=>item.id===session.id)?.status,'running');
  report.checks.push('renderer reload preserved running session');
  await page.getByLabel(/Minimize window|最小化窗口/).waitFor();
  await page.getByLabel(/Maximize window|最大化窗口/).waitFor();
  await page.getByLabel(/Close window|关闭窗口/).waitFor();
  await page.evaluate(()=>window.threadterm.windowAction('maximize'));
  await page.evaluate(()=>window.threadterm.windowAction('minimize'));
  await app.evaluate(({BrowserWindow})=>{ for (const window of BrowserWindow.getAllWindows()) { window.restore(); window.unmaximize(); } });
  report.checks.push('custom title controls were present and their real Electron window actions completed');
  await page.evaluate(async()=>{const snapshot=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{theme:'light'},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light'); await page.screenshot({path:'qa/results/electron-project-light.png'});
  report.checks.push('theme update reached the real renderer');
  await page.evaluate(id=>window.threadterm.request('session.stop',{sessionId:id,operationId:crypto.randomUUID()}),session.id);
  await page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()}));
  assert.deepEqual(errors,[]); report.passed=true; report.completedAt=new Date().toISOString();
  await writeFile('qa/results/electron-smoke.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} catch (error) {
  report.passed=false; report.error=error instanceof Error?error.stack:String(error); report.completedAt=new Date().toISOString();
  if(app){const page=app.windows()[0];if(page)await page.screenshot({path:'qa/results/electron-failure.png'}).catch(()=>{});}
  await writeFile('qa/results/electron-smoke.json',JSON.stringify(report,null,2)).catch(()=>{}); throw error;
} finally {
  if(page) await page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})).catch(()=>{});
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
  await rm(scratch,{recursive:true,force:true});
}
