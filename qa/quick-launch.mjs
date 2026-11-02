// Real-app QA for Quick Launch v1.  It only executes the fixture Node programs
// below: PATH deliberately contains just Node and System32, so no installed
// agent CLI can be found or launched.  Run after the runtime Quick Launch work
// is built: node qa/quick-launch.mjs [--rebuild] [--keep]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { electron } from './lib/desktop1.mjs'; // virtual Desktop 1; never focuses the user's desktop
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
// The runtime lists worktrees with git: Git's cmd folder joins Node and System32 on the app's PATH (no agent CLI there).
const gitExe=process.env.THREADTERM_TEST_GIT??'git';
const gitDir=process.env.THREADTERM_TEST_GIT?dirname(gitExe):(()=>{const found=execFileSync('where',['git'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).filter(Boolean);const git=found.find(path=>/\\cmd\\git\.exe$/i.test(path))??found[0];assert.ok(git,'git was not found');return dirname(git);})();
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN??join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const keep=process.argv.includes('--keep'),delay=ms=>new Promise(done=>setTimeout(done,ms));
const scratch=await mkdtemp(join(tmpdir(),'tt-quick-launch-'));
const work=join(scratch,'work'),other=join(scratch,'other-worktree'),appDir=join(scratch,'app'),out=join(scratch,'out');
const report={passed:false,scratch,checks:[],notes:[],shots:[],errors:[]};
let app,page,releaseLock,finalizing=false;
const text=error=>error instanceof Error?(error.stack??error.message):String(error);
const check=value=>{report.checks.push(value);console.log(`PASS ${value}`);};
const canonical=value=>String(value??'').replace(/^\\\\\?\\UNC\\/i,'//').replace(/^\\\\\?\\/i,'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
const samePath=(left,right)=>canonical(left)===canonical(right);
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
async function until(test,label,timeout=45000){const end=Date.now()+timeout;for(;;){try{const value=await test();if(value)return value;}catch{}if(Date.now()>end)throw Error(`Timed out: ${label}`);await delay(200);}}
async function shot(name){await delay(150);await page.screenshot({path:join(out,name)});report.shots.push(name);}
async function finalize(fatal){
 if(finalizing)return;finalizing=true;
 if(fatal){report.passed=false;report.errors.push(text(fatal));console.error(`FAIL ${text(fatal)}`);}
 await mkdir(out,{recursive:true}).catch(()=>{});
 if(page&&report.errors.length)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});
 if(page)await Promise.race([request('runtime.shutdown',{operationId:randomUUID()}),delay(3000)]).catch(error=>report.notes.push(`runtime shutdown: ${text(error)}`));
 if(app){await Promise.race([app.evaluate(({app:electronApp})=>electronApp.exit(0)),delay(2000)]).catch(()=>{});await Promise.race([app.close(),delay(5000)]).catch(()=>{});try{app.process()?.kill();}catch{}}
 await releaseLock?.();console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors}));
 await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:250}).catch(()=>{});
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
 process.exitCode=report.passed&&!report.errors.length?0:1;
}
process.on('uncaughtException',error=>{void finalize(error);});process.on('unhandledRejection',error=>{void finalize(error);});

async function prepare(){
 await mkdir(work,{recursive:true});
 execFileSync(gitExe,['init'],{cwd:work,stdio:'pipe'});execFileSync(gitExe,['config','user.email','qa@example.test'],{cwd:work,stdio:'pipe'});execFileSync(gitExe,['config','user.name','Quick Launch QA'],{cwd:work,stdio:'pipe'});
 const packageJson={name:'quick-launch-fixture',private:true,scripts:{dev:'node server.mjs',test:'node -e "process.exit(0)"',fail:'node -e "process.exit(3)"'}};
 const server=`import http from 'node:http';const name=process.cwd().replace(/^\\\\\\?\\\\UNC\\\\/i,'//').replace(/^\\\\\\?\\\\/i,'').replace(/\\\\/g,'/').replace(/\\/+$/,'').toLowerCase();const server=http.createServer((_q,res)=>res.end('<!doctype html><title>Quick Launch</title><h1>'+name+'</h1>'));server.listen(0,'127.0.0.1',()=>{const port=server.address().port,line='\\x1b[36m➜  Local:   http://localhost:'+port+'/\\x1b[0m\\n';process.stdout.write(line.slice(0,25));setTimeout(()=>process.stdout.write(line.slice(25)),20);});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
 await writeFile(join(work,'package.json'),JSON.stringify(packageJson,null,2));await writeFile(join(work,'server.mjs'),server);await mkdir(join(work,'测试目录'));await writeFile(join(work,'测试目录','marker.txt'),'CJK working directory');
 execFileSync(gitExe,['add','.'],{cwd:work,stdio:'pipe'});execFileSync(gitExe,['commit','-m','fixture'],{cwd:work,stdio:'pipe'});execFileSync(gitExe,['worktree','add','-b','qa-second',other],{cwd:work,stdio:'pipe'});
 if(process.argv.includes('--rebuild')||!existsSync(join(appDir,'renderer','index.html'))){
  await mkdir(appDir,{recursive:true});for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
  await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-v3-quick-launch-qa',version:'0.1.0',main:'main.cjs'}));
 }
}
const menu=()=>page.locator('[data-testid="quick-launch-menu"]');
const command=id=>menu().getByTestId(`quick-launch-command-${id}`);
async function openRun(){if(await menu().isVisible().catch(()=>false))return;await page.getByTestId('quick-launch-dropdown').click();await menu().waitFor();await page.getByTestId('quick-launch-search').waitFor();}
async function select(dialog,label,value){const box=dialog.getByRole('combobox',{name:label});await box.click();await page.locator(`[role="option"][data-value="${value}"]`).click();}
async function terminalText(sessionId){const value=await request('terminal.read',{sessionId,cursor:0,limit:1048576});return Buffer.from(value.data,'base64').toString();}
const cleanTerminalText=value=>value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b[()][0-2AB]/g,'');
async function snapshot(){return request('runtime.snapshot');}
async function session(id){return (await snapshot()).sessions.find(item=>item.id===id);}
async function waitState(id,status){return until(async()=>{const item=await session(id);return item?.status===status&&item;},`session ${id} ${status}`);}
async function addCommand({name,command:shellCommand,cwd='',shell='cmd',kind='task',env=[],previewUrl}){
 await openRun();await menu().getByTestId('quick-launch-new-command').click();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByLabel(/Name|名称/).fill(name);await dialog.getByText('Advanced',{exact:true}).click();await select(dialog,/Shell|外壳/,shell);await dialog.getByLabel(/Command|命令/).fill(shellCommand);if(cwd)await dialog.getByLabel(/Working directory|工作目录/).fill(cwd);await select(dialog,/Type|类型/,kind);if(env.length||previewUrl){if(env.length)for(const [index,item] of env.entries()){await dialog.getByRole('button',{name:/Add variable|添加变量/}).click();await dialog.getByLabel(new RegExp(`Environment name ${index+1}|环境变量名 ${index+1}`)).fill(item.name);await dialog.getByLabel(new RegExp(`Environment value ${index+1}|环境变量值 ${index+1}`)).fill(item.value);}if(previewUrl)await dialog.getByLabel(/Preview address|预览地址/).fill(previewUrl);}
 await dialog.getByRole('button',{name:/^Save$/}).click();await dialog.waitFor({state:'hidden'});const commands=await request('quickLaunch.list',{projectId:project.id});return commands.find(item=>item.name===name);
}
async function showRunView(){if(await menu().isVisible())await page.keyboard.press('Escape');if(!await page.getByTestId('run-view').isVisible()){await page.getByTestId('quick-launch-dropdown').click();await page.getByTestId('open-run-view').click();}await page.getByTestId('run-view').waitFor();}
async function editCommand(id){await showRunView();await page.getByTestId('run-row-menu-'+id).click();await page.getByRole('menuitem',{name:'Edit…',exact:true}).click();}
async function openOutput(id){await showRunView();await page.getByTestId('run-row-menu-'+id).click();await page.getByRole('menuitem',{name:'Open output',exact:true}).click();}
let project;
try{
 assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});await prepare();
 // Drop every spelling of PATH before constructing the only executable search path.
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='path'&&!/^(claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i.test(name)));
 Object.assign(env,{PATH:[dirname(process.execPath),gitDir,join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-quick-launch-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
 releaseLock=await acquireElectronQaLock();app=await electron.launch({args:[appDir],cwd:root,env,timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(`pageerror: ${error.message}`));page.on('console',message=>{if(message.type()==='error')report.errors.push(`console: ${message.text()}`);});
 await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 // Native notifications are explicitly disabled before any fixture completion, because Desktop 1 is intentionally unfocused.
 const settings=await request('settings.update',{patch:{theme:'light',language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:(await snapshot()).settings?.revision??0,operationId:randomUUID()}).catch(error=>{throw Error(`could not disable QA native notifications: ${text(error)}`);});void settings;
 project=await request('project.add',{path:work,name:'Quick Launch QA',operationId:randomUUID()});const trees=await request('worktree.list',{projectId:project.id});assert.ok(trees.some(tree=>samePath(tree.path,work))&&trees.some(tree=>samePath(tree.path,other)),'runtime registered both fixture worktrees');await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.proj-row').filter({hasText:'Quick Launch QA'}).click();await page.getByTestId('project-home').waitFor();
 // Import is UI-driven. Select fail too so all package fixture outcomes remain package scripts.
 const seed=async(name,command,kind)=>request('quickLaunch.save',{projectId:project.id,name,command,shell:'cmd',cwd:'',kind,env:[],operationId:randomUUID()});const [dev,test,fail]=await Promise.all([seed('dev','node server.mjs','service'),seed('test','node -e "process.exit(0)"','task'),seed('fail','node -e "process.exit(3)"','task')]);await openRun();await shot('01-en-menu-light.png');check('Quick pick lists the fixture commands');
 await openRun();await command(dev.id).click();const first=await until(async()=>{const rows=(await snapshot()).sessions.filter(item=>item.run?.commandId===dev.id&&samePath(item.worktreePath,work));return rows[0]?.status==='running'&&rows[0];},'dev run becomes running');await until(async()=>Boolean((await session(first.id))?.run?.url),'dev output URL');await page.getByTestId('project-home').waitFor();await shot('03-en-running-light.png');check('dev Run reaches Running and leaves the project home in place');
 await openRun();await command(dev.id).click();const same=(await snapshot()).sessions.filter(item=>item.run?.commandId===dev.id&&samePath(item.worktreePath,work));assert.equal(same.length,1,'clicking an active quick-pick entry opens its existing output without another process');const replay=await request('quickLaunch.run',{commandId:dev.id,cwd:work,operationId:randomUUID()});assert.equal(replay.existing,true);assert.equal(replay.session.id,first.id);check('a running quick-pick entry keeps one process');
 // Select the second registered worktree from the sidebar's stable title, then use the same UI command.
 await page.locator('.tree-row').filter({hasText:'qa-second'}).click();await page.getByTestId('project-home').waitFor();await openRun();await command(dev.id).click();const second=await until(async()=>{const row=(await snapshot()).sessions.find(item=>item.run?.commandId===dev.id&&samePath(item.worktreePath,other));return row?.run?.url&&row;},'second worktree run');assert.notEqual(second.run.url,(await session(first.id)).run.url,'worktrees receive different server ports');await page.getByTestId('project-home').waitFor();check('second registered worktree has an independent port and stays in place');
 await page.locator(`.sess-row[data-session-id="${first.id}"]`).click();await page.getByTestId('quick-launch-stop').click();await waitState(first.id,'exited');await page.locator(`.sess-row[data-session-id="${second.id}"]`).click();
 // Definitions are mutable, but an existing run must retain its launch snapshot.
 await editCommand(dev.id);const editDialog=page.getByRole('dialog');await editDialog.waitFor();await editDialog.getByLabel(/Name|名称/).fill('dev future definition');await editDialog.getByLabel(/Command|命令/).fill('node -e "console.log(\\\"future definition only\\\")"');await editDialog.getByRole('button',{name:/^(Save|保存)$/}).click();await editDialog.waitFor({state:'hidden'});assert.match(await terminalText(second.id),/Local:.*localhost/,'editing a running definition does not change that run output');assert.match(await page.getByTestId('quick-launch-run-chip').innerText(),/dev.*(?:Running|Ready)/i,'edited name does not change current run chip');check('editing a running command leaves its run snapshot unchanged');
 await editCommand(dev.id);await page.getByRole('dialog').getByRole('button',{name:/Delete|删除/}).click();const confirm=page.getByRole('dialog',{name:/Delete command|删除命令/});await confirm.getByRole('button',{name:/^(Delete command|删除命令)$/}).click();await until(async()=>!(await request('quickLaunch.list',{projectId:project.id})).some(item=>item.id===dev.id),'definition deletion');assert.equal((await session(second.id)).status,'running');check('deleting a running command leaves its run running');
 await page.getByTestId('quick-launch-stop').click();await waitState(second.id,'exited');assert.equal((await session(second.id)).run.stopRequested,true);await until(async()=>/Stopped|已停止/.test(await page.getByTestId('quick-launch-run-chip').innerText()),'second Stop chip');assert.ok(!(await snapshot()).inbox.some(item=>item.sessionId===second.id&&!item.read),'a run the user stopped adds no unread inbox item');check('Stop shows Stopped rather than Failed and adds no "needs you" item');
 await openRun();await command(test.id).click();const testRun=await until(async()=>{const row=(await snapshot()).sessions.find(item=>item.run?.commandId===test.id);return row?.status==='exited'&&row;},'test completion');assert.equal(testRun.exitCode,0);await openOutput(test.id);await until(async()=>/Completed|已完成/.test(await page.getByTestId('quick-launch-run-chip').innerText()),'Completed chip');check('task exit 0 is completed');
 await openRun();await command(fail.id).click();const failed=await until(async()=>{const row=(await snapshot()).sessions.find(item=>item.run?.commandId===fail.id);return row?.status==='exited'&&row;},'failure completion');assert.equal(failed.exitCode,3);await openOutput(fail.id);await until(async()=>/Failed.*3|失败.*3/.test(await page.getByTestId('quick-launch-run-chip').innerText()),'Failed chip');check('task exit 3 is failed with its exit code');
 const quote=await addCommand({name:'quote',command:'echo "a b" & echo 100%PERCENT%|findstr 100',env:[{name:'PERCENT',value:'expected'}]});const envProbe=await addCommand({name:'env',command:'echo %QA_VALUE% & echo %QA_PATH%',env:[{name:'QA_VALUE',value:'expected'},{name:'QA_PATH',value:'%PATH%'}],previewUrl:'http://localhost:65535/'});const cjk=await addCommand({name:'cjk',command:'cd & type marker.txt',cwd:'测试目录'});let envRun;for(const item of [quote,envProbe,cjk]){await openRun();await command(item.id).click();const row=await until(async()=>{const found=(await snapshot()).sessions.find(value=>value.run?.commandId===item.id);return found?.status==='exited'&&found;},`${item.name} completion`);const output=await terminalText(row.id);if(item===quote){const lines=cleanTerminalText(output).replace(/\r/g,'').split('\n').map(line=>line.trim());assert.ok(lines.some((line,index)=>line==='"a b"'&&lines[index+1]==='100expected'),'CMD preserves quotes and expands PERCENT exactly');}else if(item===envProbe){assert.match(output,/expected/);assert.ok(output.includes(dirname(process.execPath))&&output.includes('System32')&&!output.includes('%PATH%'),'env %PATH% expansion uses the isolated PATH');envRun=row;}else {assert.match(output,/CJK working directory/);assert.match(output,/测试目录/);}}
 const rerun=await request('session.rerun',{sessionId:envRun.id,operationId:randomUUID()});const rerunDone=await until(async()=>{const row=await session(rerun.id);return row?.status==='exited'&&row;},'env Run again');assert.equal(rerunDone.run.commandId,envProbe.id);assert.equal(rerunDone.run.url,'http://localhost:65535/');assert.match(await terminalText(rerunDone.id),/expected/);
 check('CMD quoting, environment overrides, and CJK working directory preserve exact fixture output');
 const ps=await addCommand({name:'powershell exit',command:'exit 3',shell:'powershell'});await openRun();await command(ps.id).click();const psRun=await until(async()=>{const row=(await snapshot()).sessions.find(value=>value.run?.commandId===ps.id);return row?.status==='exited'&&row;},'PowerShell exit');assert.equal(psRun.exitCode,3);check('PowerShell exit code propagates');
 await request('settings.update',{patch:{language:'zh-CN',theme:'dark'},expectedRevision:(await snapshot()).settings.revision,operationId:randomUUID()});await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.proj-row').filter({hasText:'Quick Launch QA'}).click();await page.getByTestId('project-home').waitFor();await openRun();await shot('04-zh-menu-dark.png');await menu().getByTestId('quick-launch-new-command').click();await page.getByRole('dialog').waitFor();await shot('05-zh-editor-dark.png');await page.keyboard.press('Escape');check('light English and dark Chinese menu/editor screenshots render without visual errors');
 assert.deepEqual(report.errors,[],'renderer emitted no console or page errors');report.passed=true;
}catch(error){await finalize(error);}finally{await finalize();}
