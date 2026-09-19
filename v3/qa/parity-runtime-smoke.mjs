import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const electronArg=process.argv.find(value=>value.startsWith('--exe='));
const runtimeArg=process.argv.find(value=>value.startsWith('--runtime='));
const exe=electronArg?.slice(6);
const runtime=runtimeArg?.slice(10)||resolve('runtime/target/debug/threadterm-v3-runtime.exe');
const out=join('qa','results','parity-runtime-smoke-'+new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-runtime-smoke-'));
const project=join(scratch,'project'),tree=join(scratch,'tree');
const pipe='\\\\.\\pipe\\threadterm-v3-runtime-smoke-'+randomUUID();
const inheritedEnv={...process.env}; delete inheritedEnv.THREADTERM_V3_RUNTIME;
const env={...inheritedEnv,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,...(exe?{}:{THREADTERM_V3_RUNTIME:runtime})};
const marker='RUNTIME_SMOKE_'+randomUUID().replaceAll('-','');
const report={startedAt:new Date().toISOString(),electron:exe??'development Electron',runtime:exe?'bundled':runtime,retainedScratch:scratch,checks:[]}; let app,page;
const run=(cmd,args,cwd)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd,windowsHide:true});let e='';p.stderr.on('data',b=>e+=b);p.once('exit',code=>code===0?resolve():reject(Error(cmd+' '+args.join(' ')+' '+e)))});
const rpc=(method,params={})=>page.evaluate(([m,p])=>Promise.race([window.threadterm.request(m,p),new Promise((_,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+m)),20000))]),[method,params]);
const stage=name=>console.log(JSON.stringify({name,at:new Date().toISOString()}));
try {
 await mkdir(out,{recursive:true}); await mkdir(project,{recursive:true}); if(exe)await access(exe);else await access(runtime);
 await run('git',['init'],project); await run('git',['config','user.email','qa@example.test'],project); await run('git',['config','user.name','QA'],project);
 await writeFile(join(project,'README.md'),'runtime smoke\n'); await run('git',['add','.'],project); await run('git',['commit','-m','init'],project);
 stage('launching Electron');
 app=await electron.launch(exe?{executablePath:exe,args:[],env,timeout:30000}:{args:[resolve('.')],env,timeout:30000}); stage('Electron launched');
 if(exe){assert.equal(await app.evaluate(({app})=>app.isPackaged),true);report.checks.push('Electron packaged runtime');stage('packaged state confirmed');}
 page=await app.firstWindow({timeout:30000}); stage('first window available'); page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message)); await page.waitForFunction(()=>!!window.threadterm);
 await page.locator('.app-shell').waitFor();
 report.styles=await page.evaluate(()=>({stylesheets:[...document.styleSheets].map(s=>({href:s.href,rules:s.cssRules.length})),shellDisplay:getComputedStyle(document.querySelector('.app-shell')).display,sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width}));
 assert.ok(report.styles.stylesheets.some(s=>s.href?.includes('/assets/index-')&&s.rules>0),'packaged production stylesheet is loaded');
 assert.equal(report.styles.shellDisplay,'grid');assert.equal(report.styles.sidebarWidth,240);report.checks.push('packaged CSS loaded: production asset rules, grid shell and 240px sidebar');
 stage('adding project'); const added=await rpc('project.add',{path:project,name:'Runtime smoke',operationId:randomUUID()}); stage('project added');
 report.checks.push('project.add real Git root');
 await page.locator('.proj-row').filter({hasText:'Runtime smoke'}).first().click();
 await page.getByRole('button',{name:/new worktree|新建工作树/i}).click();
 await page.locator('#new-tree-branch').fill('qa/runtime-smoke');
 await page.locator('#new-tree-path').fill(tree);
 await page.getByRole('button',{name:/create worktree|创建工作树/i}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 await page.waitForFunction(async ([projectId,path])=>{
   const trees=await window.threadterm.request('worktree.list',{projectId});
   return trees.some(tree=>tree.path===path&&!tree.missing);
 },[added.id,tree]);
 await access(join(tree,'.git')); report.checks.push('UI New worktree created real Git worktree');
 const session=await rpc('session.create',{projectId:added.id,cwd:tree,provider:'shell',mode:'terminal',title:'Runtime smoke shell',executable:'cmd.exe',args:['/Q','/K'],operationId:randomUUID()});
 await page.reload(); await page.waitForFunction(()=>!!window.threadterm);
 await page.locator('.sess-row').filter({hasText:'Runtime smoke shell'}).first().click(); await page.locator('.terminal-host').waitFor();
 await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea')); await page.locator('.terminal-host').click(); await page.keyboard.type('echo '+marker); await page.keyboard.press('Enter');
 await page.waitForFunction(marker=>[...document.querySelectorAll('.xterm-rows > div')].some(row=>row.textContent?.trim()===marker),marker); report.checks.push('TerminalSurface real PTY echo');
 await rpc('session.stop',{sessionId:session.id,operationId:randomUUID()});
 await page.waitForFunction(async sessionId=>{
   const snapshot=await window.threadterm.request('runtime.snapshot',{});
   return snapshot.sessions.some(session=>session.id===sessionId&&['exited','interrupted','error'].includes(session.status));
 },session.id);
 let snap=await rpc('runtime.snapshot'); const stopped=snap.sessions.find(s=>s.id===session.id); assert.ok(stopped); assert.ok(['exited','interrupted','error'].includes(stopped.status));
 const archived=await rpc('catalog.visibility.update',{kind:'session',id:session.id,visibility:'archived',expectedRevision:0,operationId:randomUUID()});
 snap=await rpc('runtime.snapshot'); const visibility=await rpc('catalog.visibility.list',{}); assert.equal(snap.sessions.find(s=>s.id===session.id)?.archived,true); assert.equal(visibility.find(row=>row.kind==='session'&&row.id===session.id)?.visibility,'archived'); report.checks.push('archive reflected in snapshot and catalog');
 await rpc('catalog.visibility.update',{kind:'session',id:session.id,visibility:'active',expectedRevision:archived.revision,operationId:randomUUID()});
 snap=await rpc('runtime.snapshot'); assert.equal(snap.sessions.find(s=>s.id===session.id)?.archived,false); report.checks.push('restore reflected in snapshot');
 await rpc('data.status',{}); report.checks.push('local data RPC'); await page.screenshot({path:join(out,'success.png')});
 assert.deepEqual(errors,[]); report.passed=true;
} catch(error) { report.passed=false;report.error=error instanceof Error?error.stack:String(error);if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});process.exitCode=1; }
finally { if(page)await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,report})); }

