// Real Electron + isolated runtime visual check for the surfaces that reuse the workbench views
// outside a session: the project Files/Changes page and Settings → Tools → "Open files & changes".
// Isolated data/profile/pipe and a temporary Git repository; read-only (no file or Git mutations).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const out=join('qa','results','workbench-standalone-visual',new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-standalone-'));
const project=join(scratch,'standalone repo');
const pipe='\\\\.\\pipe\\threadterm-v3-standalone-'+randomUUID();
const runtimeBin=process.env.THREADTERM_V3_RUNTIME_BIN||resolve('runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtimeBin),`runtime binary missing: ${runtimeBin}`);
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtimeBin};
const report={startedAt:new Date().toISOString(),scratch,checks:[],screenshots:[]};
let app,page,settingsRevision=0;
const rpc=(method,params={})=>page.evaluate(([m,p])=>window.threadterm.request(m,p),[method,params]);
const git=args=>new Promise((res,rej)=>{const p=spawn('git',args,{cwd:project,windowsHide:true});let e='';p.stderr.on('data',b=>e+=b);p.once('exit',code=>code===0?res():rej(Error('git '+args.join(' ')+': '+e)));});
const shot=async name=>{await page.waitForTimeout(250);await page.screenshot({path:join(out,name)});report.screenshots.push(name);};
const setSettings=async patch=>{const value=await rpc('settings.update',{patch,expectedRevision:settingsRevision,operationId:randomUUID()});settingsRevision=value.revision;};
const size=width=>app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,900),width);

try {
 await mkdir(out,{recursive:true});await mkdir(join(project,'src'),{recursive:true});
 await mkdir(join(scratch,'data'),{recursive:true});await mkdir(join(scratch,'profile'),{recursive:true});
 await git(['init','-q','-b','main']);await git(['config','user.email','qa@example.test']);await git(['config','user.name','QA']);await git(['config','core.autocrlf','false']);
 await writeFile(join(project,'src','main.ts'),'export const answer = 41;\nexport const name = "qa";\n');
 await writeFile(join(project,'README.md'),'# Standalone QA\n');
 await git(['add','.']);await git(['commit','-qm','initial']);
 await writeFile(join(project,'src','main.ts'),'export const answer = 42;\nexport const name = "qa";\n');
 await writeFile(join(project,'notes.txt'),'untracked\n');

 app=await electron.launch({args:[resolve('.')],env,timeout:60000});
 page=await app.firstWindow({timeout:30000});page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>!!window.threadterm);await page.locator('.app-shell').waitFor();
 await setSettings({language:'en',theme:'light'});
 await size(1280);
 await rpc('project.add',{path:project,name:'Standalone QA',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>!!window.threadterm);await page.locator('.app-shell').waitFor();

 // ---- Project page → Files / Changes (FileWorkspace standalone with shared Explorer + Source Control) ----
 await page.locator('.proj-row',{hasText:'Standalone QA'}).click();
 await page.getByRole('button',{name:'Project actions',exact:true}).click();await page.getByRole('button',{name:'Files',exact:true}).click();
 // The page opens with Files & Git visible when no file is selected.
 await page.locator('.project-file-page .wb-tools-head',{hasText:'Source Control'}).waitFor();
 await page.locator('.project-file-page .wb-tree [data-path="src"]').waitFor();
 await page.locator('.project-file-page .wb-tree [data-path="src"]').click();
 await page.locator('.project-file-page .wb-tree [data-path="src/main.ts"]').click();
 await page.locator('.project-file-page .tt-editor-shell .cm-content').waitFor();
 await shot('light-1280-project-files.png');
 await page.locator('.project-file-page .ws-top').getByRole('button',{name:'Changes',exact:true}).click();
 await page.locator('.project-file-page .wb-change-open',{hasText:'main.ts'}).first().click();
 await page.locator('.project-file-page .tt-diff-shell .wb-hunk-nav').waitFor();
 await shot('light-1280-project-changes.png');
 report.checks.push('project Files page shows the shared Explorer tree and opens a file; Changes shows Source Control and a hunk diff');
 await setSettings({theme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await size(1920);await shot('dark-1920-project-changes.png');
 await setSettings({theme:'light'});await size(1280);

 // ---- Settings → Tools → Open files & changes (dialog) ----
 await page.getByRole('button',{name:/Local user/}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('tab',{name:'Tools',exact:true}).click();
 await page.getByRole('button',{name:'Open files & changes',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:/Files and changes/});
 await dialog.locator('.wb-change-open',{hasText:'main.ts'}).first().waitFor();
 await shot('light-1280-settings-git.png');
 await setSettings({theme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await shot('dark-1280-settings-git.png');
 report.checks.push('Settings → Tools dialog shows the shared Source Control view for the selected project');

 assert.deepEqual(errors,[],'renderer page errors');
 report.passed=true;
} catch(error) {
 report.passed=false;report.error=error instanceof Error?error.stack??error.message:String(error);
 if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});
} finally {
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
 // The runtime outlives the window by design; stop the isolated one so it does not hold the pipes open.
 if(page)await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 console.log(JSON.stringify({passed:report.passed,out,checks:report.checks.length,error:report.error?.split('\n').slice(0,3).join(' | ')},null,1));
 if(!report.passed)process.exitCode=1;
}
