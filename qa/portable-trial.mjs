// Direct packaged portable-trial acceptance QA. Run only with a fresh package:
//   $env:THREADTERM_QA_TRIAL_DIR = (Resolve-Path release/win-unpacked).Path
//   node qa/portable-trial.mjs
// It uses Desktop 1, an isolated profile/data/pipe, no provider turns, and never
// alters the supplied package directory or a user profile.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const requested=process.env.THREADTERM_QA_TRIAL_DIR;
assert.ok(requested&&isAbsolute(requested),'Set THREADTERM_QA_TRIAL_DIR to the absolute path of a fresh win-unpacked directory');
const packageDir=await realpath(requested);
assert.equal(basename(packageDir).toLowerCase(),'win-unpacked','THREADTERM_QA_TRIAL_DIR must name the fresh win-unpacked directory');
const executable=join(packageDir,'ThreadTerm.exe');
const runtimeDir=join(packageDir,'resources','runtime');
const requiredResources=[
 executable,
 join(packageDir,'resources','app.asar'),
 join(runtimeDir,'threadterm-v3-runtime.exe'),
 join(runtimeDir,'threadterm-v3-mcp.exe'),
 join(runtimeDir,'claude-sdk-host.mjs'),
 join(runtimeDir,'claude-sdk-cli.exe'),
 join(runtimeDir,'conpty','OpenConsole.exe'),
 join(runtimeDir,'conpty','conpty.dll'),
 join(runtimeDir,'conpty','VERSION.txt'),
];
for(const path of requiredResources) await access(path);

const scratch=await mkdtemp(join(tmpdir(),'tt-portable-trial-'));
const runId=`${new Date().toISOString().replaceAll(/[:.]/g,'-')}-${randomUUID()}`;
const out=join(root,'qa','results','portable-trial',runId);
const projectPath=join(scratch,'project');
const sourceFile='portable-trial.txt';
const sourceContents='portable Rust filesystem proof\n';
const data=join(scratch,'data'),profile=join(scratch,'profile'),home=join(scratch,'home'),pipe=`\\\\.\\pipe\\tt-portable-trial-${randomUUID()}`;
const report={startedAt:new Date().toISOString(),runId,packageDir,executable,passed:false,checks:[],screenshots:[],errors:[]};
let app; let page; let cleanupFailure;

function isolatedEnv() {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(path|home|userprofile|codex_home|appdata|localappdata|data|user_data|profile|pipe|threadterm_v3_.*)$/i.test(key)));
 const isolated=Object.assign(env,{
  Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),
  HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),
  THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:profile,THREADTERM_V3_PIPE:pipe,
 });
 assert.deepEqual(Object.keys(isolated).filter(key=>key.toLowerCase()==='path'),['Path'],'isolated child environment must contain exactly one PATH spelling');
 return isolated;
}
const env=isolatedEnv();

async function stopOwnedRuntime() {
 let peer;
 try {
  peer=await connectPeer(`${pipe}-control`);
  const credential=(await readFile(join(data,'runtime.credential'),'utf8')).trim();
  assert.ok(credential,'portable trial runtime credential is empty');
  const challenge=JSON.parse(await peer.next()),clientId=randomUUID();
  assert.equal(challenge.contract,PROTOCOL_CONTRACT,'cleanup peer contract must match this package');
  peer.json({kind:'auth',clientId,protocol:1,contract:PROTOCOL_CONTRACT,nonce:challenge.nonce,hmac:createHmac('sha256',credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex')});
  const proof=JSON.parse(await peer.next());
  assert.equal(proof.kind,'authenticated');
  assert.equal(proof.contract,PROTOCOL_CONTRACT);
  assert.equal(proof.hmac,createHmac('sha256',credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
  const snapshot=await peer.request('runtime.snapshot',{});
  assert.equal(snapshot.sessions.length,0,'only an empty runtime owned by this fixture may be stopped');
  await peer.request('runtime.shutdown',{operationId:randomUUID()});
  report.checks.push('after Electron closed, the known-credential authenticated peer stopped only this empty isolated runtime');
 } catch(error) {
  // Electron may already have shut down its isolated runtime. A missing pipe is
  // not a cleanup failure; any reachable/untrusted runtime failure is.
  if(!['ENOENT','ECONNREFUSED'].includes(error?.code)) throw error;
  report.checks.push('the isolated runtime had already released its private pipe after Electron closed');
 } finally { peer?.close(); }
}

async function verifyPipeClosed() {
 const deadline=Date.now()+10_000;
 while(Date.now()<deadline) {
  try { const peer=await connectPeer(`${pipe}-control`); peer.close(); await delay(100); }
  catch(error) { if(['ENOENT','ECONNREFUSED'].includes(error?.code)) { report.checks.push('the fixture-private runtime control pipe was released after authenticated shutdown'); return; } throw error; }
 }
 throw Error('fixture-private runtime control pipe remained available after cleanup');
}

try {
 await Promise.all([mkdir(out,{recursive:true}),mkdir(projectPath,{recursive:true}),mkdir(data,{recursive:true}),mkdir(profile,{recursive:true}),mkdir(home,{recursive:true})]);
 await writeFile(join(projectPath,sourceFile),sourceContents);
 report.executableSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
 report.checks.push('fresh packaged directory contains the Electron app archive/icon executable plus bundled runtime, MCP, ConPTY, and Claude host resources');
 app=await electron.launch({executablePath:executable,args:['--disable-gpu','--in-process-gpu','--no-sandbox'],cwd:packageDir,env,timeout:60_000});
 page=await app.firstWindow({timeout:45_000}); page.setDefaultTimeout(25_000);
 await page.waitForFunction(()=>Boolean(window.threadterm));
 await page.locator('#boot-splash').waitFor({state:'detached'});
 await page.locator('.project-catalog').waitFor();
 assert.equal(await page.getByRole('button',{name:/^Retry/}).count(),0,'initial catalog must be ready without Retry');
 const identity=await app.evaluate(({app})=>({packaged:app.isPackaged,userData:app.getPath('userData'),version:app.getVersion()}));
 assert.equal(identity.packaged,true); assert.equal(identity.userData.toLowerCase(),profile.toLowerCase());
 const health=await page.evaluate(()=>window.threadterm.request('runtime.health',{}));
 assert.equal(health.contract,PROTOCOL_CONTRACT); assert.equal(typeof health.epoch,'string'); assert.ok(health.epoch.length>0);
 report.version=identity.version; report.health=health;
 const snapshot=await page.evaluate(()=>window.threadterm.request('runtime.snapshot',{}));
 await page.evaluate(revision=>window.threadterm.request('settings.update',{patch:{notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:revision,operationId:crypto.randomUUID()}),snapshot.settings.revision);
 report.checks.push('direct packaged Electron launch reached its initial project catalog and current runtime.health contract without a Retry path');
 const project=await page.evaluate(({path,name})=>window.threadterm.request('project.add',{path,name,operationId:crypto.randomUUID()}),{path:projectPath,name:'Portable trial project'});
 const document=await page.evaluate(({projectId,path})=>window.threadterm.request('filesystem.read',{projectId,path}),{projectId:project.id,path:sourceFile});
 assert.equal(document.content,sourceContents); assert.equal(document.path,sourceFile);
 await page.locator('.proj-row').filter({hasText:'Portable trial project'}).waitFor();
 const sourceIcon=page.locator('.brand-mark img');
 await sourceIcon.waitFor({state:'visible'});
 assert.equal(await sourceIcon.evaluate(image=>image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0),true,'packaged source icon must render');
 if(process.platform==='win32') {
  const readProperties=async handle=>{
   const {stdout}=await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'qa','lib','windows-taskbar-properties.ps1'),'-Hwnd',handle],{windowsHide:true,timeout:20_000});
   const properties=JSON.parse(stdout.trim());
   assert.equal(properties.appId,'com.threadterm.v3','packaged taskbar identity must match the existing installer identity');
   assert.equal(properties.icon,`${executable},0`,'taskbar group icon must reference this exact running executable');
   assert.equal(properties.command,'','icon metadata must not introduce a relaunch command');
   return properties;
  };
  const mainHandle=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
  report.mainTaskbarProperties=await readProperties(mainHandle);
  const floatingPromise=app.waitForEvent('window');
  await page.evaluate(()=>window.threadterm.openWindow({}));
  const floatingPage=await floatingPromise;
  await floatingPage.waitForFunction(()=>Boolean(window.threadterm));
  const floatHandle=await app.evaluate(({BrowserWindow},excludedHandle)=>BrowserWindow.getAllWindows().find(window=>window.getNativeWindowHandle().readBigUInt64LE().toString()!==excludedHandle)?.getNativeWindowHandle().readBigUInt64LE().toString(),mainHandle);
  assert.ok(floatHandle,'the existing floating-window route must create another window');
  report.floatingTaskbarProperties=await readProperties(floatHandle);
  const floatingClosed=floatingPage.waitForEvent('close');
  await floatingPage.evaluate(()=>window.threadterm.windowAction('close')).catch(error=>{
   if(!/Target page, context or browser has been closed/.test(String(error))) throw error;
  });
  await floatingClosed;
  await page.waitForFunction(()=>Boolean(window.threadterm));
  report.checks.push('main and floating windows expose the exact packaged AppUserModelID and current EXE taskbar icon; closing the float preserves main');
 }
 await page.screenshot({path:join(out,'catalog-source-icon.png'),fullPage:true}); report.screenshots.push('catalog-source-icon.png');
 report.checks.push('production preload/main routed project.add and filesystem.read to the actual packaged Rust runtime; the source file contents and visible source icon were verified');
 report.passed=true;
} catch(error) {
 report.errors.push(error instanceof Error?(error.stack??error.message):String(error));
 await page?.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});
} finally {
 // Close Electron clients before any control-pipe client is opened. This makes
 // it impossible for a renderer client to reconnect while cleanup authenticates.
 if(app) await app.evaluate(({app:electronApp})=>electronApp.exit(0)).catch(()=>undefined);
 try { await stopOwnedRuntime(); } catch(error) { cleanupFailure=error; report.errors.push(`cleanup: ${error instanceof Error?(error.stack??error.message):String(error)}`); }
 if(app) try { await app.close(); } catch(error) {
  const child=app.process?.();
  if(child?.exitCode===null) await Promise.race([once(child,'exit'),delay(10_000)]);
  if(child?.exitCode===null) { cleanupFailure??=error; report.errors.push(`Electron cleanup: ${error instanceof Error?(error.stack??error.message):String(error)}`); }
 }
 try { await verifyPipeClosed(); } catch(error) { cleanupFailure??=error; report.errors.push(`pipe cleanup: ${error instanceof Error?(error.stack??error.message):String(error)}`); }
 if(cleanupFailure) { report.passed=false; report.errors.push(`Electron cleanup: ${cleanupFailure instanceof Error?(cleanupFailure.stack??cleanupFailure.message):String(cleanupFailure)}`); }
 report.completedAt=new Date().toISOString();
 await mkdir(out,{recursive:true});
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(report.passed?'PORTABLE TRIAL QA PASSED':`PORTABLE TRIAL QA FAILED\n${report.errors.join('\n')}`);
 process.exitCode=report.passed?0:1;
}
