// Memory baseline for the desktop shell: launches an isolated instance (dev or packaged),
// samples every process in its tree while idle and after terminal load.
// Usage: node qa/memory-baseline.mjs [--exe=release/win-unpacked/ThreadTerm.exe] [--dev-server=http://127.0.0.1:5173]
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {_electron as electron} from '@playwright/test';

const arg=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const exe=arg('exe'), devServer=arg('dev-server');
const terminals=Number(arg('terminals')??4), lines=Number(arg('lines')??3000), settleMs=Number(arg('settle')??15000);
const label=exe?'packaged':devServer?'dev-vite':'dev-built';
const out=join('qa','results',`memory-baseline-${label}-`+new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-memory-'));
const project=join(scratch,'project');
const inheritedEnv={...process.env}; delete inheritedEnv.THREADTERM_V3_RUNTIME; delete inheritedEnv.THREADTERM_V3_DEV_SERVER_URL;
const env={...inheritedEnv,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:'\\\\.\\pipe\\threadterm-v3-memory-'+randomUUID(),
  ...(exe?{}:{THREADTERM_V3_RUNTIME:resolve('runtime/target/release/threadterm-v3-runtime.exe')}),...(devServer?{THREADTERM_V3_DEV_SERVER_URL:devServer}:{})};
const report={label,startedAt:new Date().toISOString(),exe:exe??'electron .',devServer:devServer??null,terminals,lines,settleMs,phases:{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=(cmd,args,cwd)=>new Promise((ok,fail)=>{const p=spawn(cmd,args,{cwd,windowsHide:true});p.once('exit',code=>code===0?ok():fail(Error(cmd+' '+args.join(' '))))});
let app,page;
const rpc=(method,params={})=>page.evaluate(([m,p])=>window.threadterm.request(m,p),[method,params]);

async function processTable() {
  const script='Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress;"@@";'+
    'Get-CimInstance Win32_PerfRawData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate,WorkingSet,PrivateBytes | ConvertTo-Json -Compress';
  const {stdout}=await promisify(execFile)('powershell',['-NoProfile','-Command',script],{maxBuffer:64<<20,windowsHide:true});
  const [procs,perf]=stdout.split('@@').map(s=>JSON.parse(s));
  const mem=new Map(perf.map(p=>[p.IDProcess,p]));
  return procs.map(p=>({pid:p.ProcessId,ppid:p.ParentProcessId,name:p.Name,...(mem.get(p.ProcessId)??{})}));
}

async function sample(rootPid) {
  const types=new Map((await app.evaluate(({app})=>app.getAppMetrics())).map(m=>[m.pid,m.type+(m.serviceName?`:${m.serviceName}`:'')]));
  const table=await processTable();
  const tree=new Set([rootPid]);
  for (let grew=true;grew;) { grew=false; for (const p of table) if (!tree.has(p.pid)&&tree.has(p.ppid)) { tree.add(p.pid); grew=true; } }
  return table.filter(p=>tree.has(p.pid)).map(p=>({pid:p.pid,name:p.name,
    role:types.get(p.pid)??(/threadterm-v3-runtime/i.test(p.name)?'rust-runtime':/claude-sdk|threadterm-v3-mcp/i.test(p.name)?'helper':'pty-child'),
    privateWsMB:+(Number(p.WorkingSetPrivate??0)/2**20).toFixed(1),workingSetMB:+(Number(p.WorkingSet??0)/2**20).toFixed(1),privateBytesMB:+(Number(p.PrivateBytes??0)/2**20).toFixed(1)}));
}

async function measure(phase,rootPid) {
  await sleep(settleMs);
  const samples=[]; for (let i=0;i<5;i++) { samples.push(await sample(rootPid)); await sleep(2000); }
  const median=values=>values.sort((a,b)=>a-b)[values.length>>1];
  const byRole={};
  for (const role of new Set(samples.flat().map(p=>p.role))) {
    const sum=(s,key)=>s.filter(p=>p.role===role).reduce((a,p)=>a+p[key],0);
    byRole[role]={count:samples.at(-1).filter(p=>p.role===role).length,
      ...Object.fromEntries(['privateWsMB','privateBytesMB','workingSetMB'].map(k=>[k,+median(samples.map(s=>sum(s,k))).toFixed(1)]))};
  }
  const shell=Object.entries(byRole).filter(([r])=>!['rust-runtime','helper','pty-child'].includes(r));
  const total=key=>+shell.reduce((a,[,v])=>a+v[key],0).toFixed(1);
  const renderer=await page.evaluate(()=>performance.memory?{jsHeapUsedMB:+(performance.memory.usedJSHeapSize/2**20).toFixed(1),jsHeapTotalMB:+(performance.memory.totalJSHeapSize/2**20).toFixed(1)}:null);
  report.phases[phase]={electronTotal:{privateWsMB:total('privateWsMB'),privateBytesMB:total('privateBytesMB'),workingSetMB:total('workingSetMB')},byRole,renderer,domNodes:await page.evaluate(()=>document.getElementsByTagName('*').length)};
  console.log(JSON.stringify({phase,...report.phases[phase]}));
}

try {
  await mkdir(out,{recursive:true}); await mkdir(project,{recursive:true}); await mkdir(env.THREADTERM_V3_DATA,{recursive:true});
  await run('git',['init'],project); await writeFile(join(project,'README.md'),'memory baseline\n');
  await run('git',['-c','user.email=qa@example.test','-c','user.name=QA','commit','--allow-empty','-m','init'],project);
  app=await electron.launch(exe?{executablePath:resolve(exe),args:[],env,timeout:30000}:{args:[resolve('.')],env,timeout:30000});
  const rootPid=app.process().pid;
  page=await app.firstWindow({timeout:30000}); page.setDefaultTimeout(30000);
  await page.waitForFunction(()=>!!window.threadterm); await page.locator('.app-shell').waitFor();
  report.window=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
  await measure('idle',rootPid);

  const added=await rpc('project.add',{path:project,name:'Memory baseline',operationId:randomUUID()});
  for (let i=1;i<=terminals;i++) await rpc('session.create',{projectId:added.id,cwd:project,provider:'shell',mode:'terminal',title:`Mem shell ${i}`,executable:'cmd.exe',args:['/Q','/K'],operationId:randomUUID()});
  await page.reload(); await page.waitForFunction(()=>!!window.threadterm); await page.locator('.app-shell').waitFor();
  await page.locator('.proj-row').filter({hasText:'Memory baseline'}).first().click();
  for (let i=1;i<=terminals;i++) {
    const marker=`MEM_DONE_${i}_${randomUUID().slice(0,8)}`;
    await page.locator('.sess-row').filter({hasText:`Mem shell ${i}`}).first().click(); await page.locator('.terminal-host:visible').waitFor();
    await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
    await page.keyboard.type(`for /L %i in (1,1,${lines}) do @echo %i abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789`); await page.keyboard.press('Enter');
    await page.keyboard.type(`echo ${marker}`); await page.keyboard.press('Enter');
    await page.waitForFunction(m=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent?.trim()===m),marker,{timeout:120000});
  }
  report.mountedTerminals=await page.locator('.xterm').count();
  await measure('load',rootPid);
  await page.screenshot({path:join(out,'load.png')});
  report.passed=true;
} catch (error) { report.passed=false; report.error=error instanceof Error?error.stack:String(error); if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{}); process.exitCode=1; }
finally {
  if(page)await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
  report.completedAt=new Date().toISOString(); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({out,passed:report.passed,error:report.error}));
}
