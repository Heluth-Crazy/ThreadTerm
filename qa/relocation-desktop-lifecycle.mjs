import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
const root=resolve(import.meta.dirname,'..');
const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-relocation-desktop-'));
const appDir=join(scratch,'app');
const userData=join(scratch,'electron-user'),localAppData=join(scratch,'local-app-data'),target=join(scratch,'target');
await Promise.all([mkdir(userData),mkdir(localAppData),mkdir(target)]);
const env={...process.env,LOCALAPPDATA:localAppData,APPDATA:join(scratch,'app-data'),THREADTERM_V3_USER_DATA:userData,THREADTERM_V3_PIPE:`\\\\.\\pipe\\threadterm-v3-relocation-desktop-${randomUUID()}`,THREADTERM_V3_RUNTIME:process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'),THREADTERM_V3_RELOCATION_QA:'1'};
delete env.THREADTERM_V3_DATA;
for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
env.PATH=[dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';');
let app;
let releaseLock;
let forcedExit=false;
try {
 console.log('PHASE acquire Electron lock'); releaseLock=await acquireElectronQaLock();
 await phase('build isolated app',buildApp,120000);
 console.log('PHASE launch Electron'); app=await electron.launch({args:[appDir,'--disable-features=CalculateNativeWinOcclusion'],env,timeout:30000});
 const page=await phase('first window',()=>app.firstWindow({timeout:30000})); await page.waitForFunction(()=>!!window.threadterm,{timeout:15000});
 const source=await phase('data status',()=>page.evaluate(()=>window.threadterm.request('data.status',{})));
 const prepared=await phase('prepare relocation',()=>page.evaluate(targetPath=>window.threadterm.request('data.relocation.prepare',{targetPath,operationId:crypto.randomUUID()}),target));
 for(const value of [source.root,prepared.sourceRoot,prepared.targetRoot])assert.ok(!value.startsWith('\\\\?\\'),'wire data paths have no verbatim prefix');
 const activated=await phase('activate relocation',()=>page.evaluate(prepared=>window.threadterm.activateDataRelocation(prepared),prepared)); assert.equal(activated.activated,true);
 await phase('reload after relocation',()=>page.reload({timeout:30000})); await page.waitForFunction(()=>!!window.threadterm,{timeout:15000});
 const status=await phase('data status',()=>page.evaluate(()=>window.threadterm.request('data.status',{}))); assert.equal(normalizePath(status.root),normalizePath(target));
 assert.ok(!status.root.startsWith('\\\\?\\'),'relocated data status has no verbatim prefix');
 const pointer=JSON.parse(await readFile(join(userData,'runtime-data-root.json'),'utf8')); assert.equal(normalizePath(pointer.root),normalizePath(target));
 const state=await phase('restart counters',()=>app.evaluate(()=>globalThis.relocationQaRestart)); assert.deepEqual(state,{relaunch:1,exit:1});
 await phase('shutdown runtime',()=>page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})));
 console.log('PASS relocation desktop lifecycle: prepare, activation, reload, pointer, restart, shutdown');
 console.log(JSON.stringify({passed:true,checks:['isolated Electron userData','desktop prepare/activate lifecycle','old daemon pipe release','new runtime target root verification','pointer activation','relaunch and exit requested','authenticated target shutdown']}));
} catch(error){console.error('FAIL relocation: '+(error.stack||error));process.exitCode=1;} finally {
 if(app)await phase('close Electron',()=>app.close(),15000).catch(error=>{console.error(error.message);forcedExit=true;process.exitCode=1;
  try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(app.process().pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
  else app.process().kill('SIGKILL');}catch(cleanupError){console.error('Owned Electron cleanup: '+cleanupError.message);}});
 await releaseLock?.();console.log('Retained scratch: '+scratch);
 if(forcedExit)process.exit(process.exitCode||1);
}

function normalizePath(value){return value.replace(/^\\\\\?\\/,'').toLowerCase();}

async function phase(name,run,timeoutMs=45000){
 console.log('PHASE '+name);let timer;
 try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+name)),timeoutMs);})]);}
 finally{clearTimeout(timer);}
}

async function buildApp(){
 await mkdir(appDir);
 for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
 await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
 await writeFile(join(appDir,'package.json'),JSON.stringify({name:'relocation-desktop-qa',version:'0.1.0',main:'main.cjs'}));
}
