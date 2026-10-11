// Actual Desktop-1 Source Control -> production preload/main -> Rust -> Git QA.
// All repositories, profiles and pipes are temporary. No provider turn is started.
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {electron} from './lib/desktop1.mjs';
import {connectPeer} from './pipe-client.mjs';
import {PROTOCOL_CONTRACT} from '../protocol/index.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(join(tmpdir(),'tt-selected-runtime-'));
const out=join(root,'qa/results/selected-commit-runtime');
const gitExe=process.env.THREADTERM_TEST_GIT;
assert.ok(gitExe && resolve(gitExe)===gitExe,'Set THREADTERM_TEST_GIT to the absolute QA Git executable');
const runtime=process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const work=join(scratch,'work'),appDir=join(scratch,'app'),renderer=join(appDir,'renderer');
const run=promisify(execFile);
const git=async(...args)=>(await run(gitExe,args,{cwd:work,windowsHide:true,timeout:20000,encoding:'utf8'})).stdout;
const report={passed:false,checks:[],screenshots:[],errors:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`)};
let app,page;
await mkdir(work,{recursive:true}); await mkdir(renderer,{recursive:true}); await mkdir(out,{recursive:true});
report.gitVersion=(await git('--version')).trim();
report.gitArchiveSha256=createHash('sha256').update(await readFile(join(root,'qa/results/selected-commit-tools/mingit-2.54.0/MinGit-2.54.0-64-bit.zip'))).digest('hex');
assert.equal(report.gitArchiveSha256,'04f937e1f0918b17b9be6f2294cb2bb66e96e1d9832d1c298e2de088a1d0e668');
assert.match(report.gitVersion,/2\.54\.0/);
await git('init'); await git('config','user.name','ThreadTerm QA'); await git('config','user.email','qa@threadterm.invalid');
await writeFile(join(work,'partial.txt'),'base\n'); await writeFile(join(work,'excluded.txt'),'base\n');
await git('add','.'); await git('commit','-m','base'); const parent=(await git('rev-parse','HEAD')).trim();
await writeFile(join(work,'partial.txt'),'selected staged\n'); await writeFile(join(work,'excluded.txt'),'excluded staged\n');
await git('add','.'); await writeFile(join(work,'partial.txt'),'unstaged remainder\n');
const indexBefore=await readFile(join(work,'.git/index'));
for(const name of ['main','preload'])await build({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
const source=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
const path=${JSON.stringify(work)};function Probe(){const [scope,setScope]=useState(),[status,setStatus]=useState(),[error,setError]=useState();const refresh=async()=>{if(scope)setStatus(await window.threadterm.request('git.status',{projectId:scope.projectId}))};window.__refresh=refresh;window.__scope=scope;useEffect(()=>{(async()=>{const snapshot=await window.threadterm.request('runtime.snapshot',{});await window.threadterm.request('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:crypto.randomUUID()});const project=await window.threadterm.request('project.add',{path,name:'Selected QA',operationId:crypto.randomUUID()});setScope({projectId:project.id,rootPath:path});setStatus(await window.threadterm.request('git.status',{projectId:project.id}));})().catch(e=>setError(String(e)))},[]);return error?<p role="alert">{error}</p>:scope?<main style={{width:480,margin:16}}><SourceControlView scope={scope} actions={{openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}}} git={{status,loading:!status,refresh}} zh={false}/></main>:<p>Starting isolated runtime…</p>}createRoot(document.getElementById('root')).render(<Probe/>);`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'selected-runtime-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(renderer,'probe.js'),logLevel:'error'});
await writeFile(join(renderer,'index.html'),'<!doctype html><html lang="en" data-theme="light"><link rel="stylesheet" href="probe.css"><style>html,body,#root{background:var(--bg);min-height:100%;color:var(--text)}main{background:var(--surface);border:1px solid var(--border);min-height:600px}</style><div id="root"></div><script src="probe.js"></script></html>');
await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-selected-runtime-qa',version:'0.1.0',main:'main.cjs'}));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git)$/i.test(key)));
Object.assign(env,{Path:[dirname(gitExe),dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';'),HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),CODEX_HOME:join(scratch,'home/.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-selected-runtime-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime});
try{
 app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',appDir],cwd:root,env,timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);
 await page.getByRole('checkbox',{name:'Select partial.txt in staged'}).waitFor();
 await page.getByRole('checkbox',{name:'Select partial.txt in staged'}).check();
 await page.getByRole('textbox',{name:'Commit message'}).fill('selected from the real desktop');
 await page.screenshot({path:join(out,'before.png')});report.screenshots.push('before.png');
 await page.getByRole('textbox',{name:'Commit message'}).press('Control+Enter');
 await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent==='Commit all staged' && document.querySelector('textarea')?.value==='');
 const commit=(await git('rev-parse','HEAD')).trim();assert.notEqual(commit,parent);assert.equal((await git('rev-parse','HEAD^')).trim(),parent);
 assert.equal(await git('show','HEAD:partial.txt'),'selected staged\n');assert.equal(await git('show','HEAD:excluded.txt'),'base\n');
 assert.deepEqual(await readFile(join(work,'.git/index')),indexBefore);assert.equal(await readFile(join(work,'partial.txt'),'utf8'),'unstaged remainder\n');
 check('Actual checkbox and Ctrl+Enter publish only selected staged blobs while preserving the exact real index and unstaged remainder');
 await page.locator('section[aria-label="Staged changes"] .wb-change-row[data-change-path="excluded.txt"]').waitFor();
 assert.equal(await page.locator('section[aria-label="Changes"] .wb-change-row[data-change-path="partial.txt"]').count(),1);check('The coherent real Git refresh retains excluded staging and the selected file worktree remainder');
 await page.screenshot({path:join(out,'after.png')});report.screenshots.push('after.png');
 // Explicit full-staged action remains available and uses the existing route.
 await page.getByRole('textbox',{name:'Commit message'}).fill('remaining staged');await page.getByRole('button',{name:'Commit all staged',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');assert.equal(await git('show','HEAD:excluded.txt'),'excluded staged\n');assert.equal(await git('show','HEAD:partial.txt'),'selected staged\n');check('Explicit all-staged commit still works without consuming unstaged worktree content');
 report.passed=true;
}catch(error){report.errors.push(error.stack??String(error));if(page){report.errors.push(await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});}throw error}
finally{
 // Stop reconnecting clients first, then gracefully close only the authenticated
 // runtime owned by this fixture. No session was created and no provider ran.
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 let peer;
 try{
  peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);
  const credential=(await readFile(join(scratch,'data/runtime.credential'),'utf8')).trim();
  const challenge=JSON.parse(await peer.next()),clientId=randomUUID();assert.equal(challenge.contract,PROTOCOL_CONTRACT);
  peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});
  const proof=JSON.parse(await peer.next());assert.equal(proof.kind,'authenticated');assert.equal(proof.hmac,createHmac('sha256',credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
  assert.equal((await peer.request('runtime.snapshot',{})).sessions.length,0);
  await peer.request('runtime.shutdown',{operationId:randomUUID()});
 }catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code)){report.errors.push(`shutdown: ${error.message}`);report.passed=false;}}
 finally{peer?.close();}
 await app?.close().catch(()=>{});
 await writeFile(join(out,'report.json'),JSON.stringify({...report,scratch,pipe:env.THREADTERM_V3_PIPE},null,2));
 if(!report.passed)process.exitCode=1;
}
