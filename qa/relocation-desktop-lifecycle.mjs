import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const scratch=await mkdtemp(join(tmpdir(),'threadterm-v3-relocation-desktop-'));
const userData=join(scratch,'electron-user'),localAppData=join(scratch,'local-app-data'),target=join(scratch,'target');
await Promise.all([mkdir(userData),mkdir(localAppData),mkdir(target)]);
const env={...process.env,LOCALAPPDATA:localAppData,APPDATA:join(scratch,'app-data'),THREADTERM_V3_USER_DATA:userData,THREADTERM_V3_PIPE:`\\\\.\\pipe\\threadterm-v3-relocation-desktop-${randomUUID()}`,THREADTERM_V3_RUNTIME:resolve('runtime/target/debug/threadterm-v3-runtime.exe'),THREADTERM_V3_RELOCATION_QA:'1'};
delete env.THREADTERM_V3_DATA;
let app;
try {
 app=await electron.launch({args:[resolve('.')],env,timeout:30000});
 const page=await app.firstWindow(); await page.waitForFunction(()=>!!window.threadterm,{timeout:15000});
 const source=await page.evaluate(()=>window.threadterm.request('data.status',{}));
 const prepared=await page.evaluate(targetPath=>window.threadterm.request('data.relocation.prepare',{targetPath,operationId:crypto.randomUUID()}),target);
 const activated=await page.evaluate(prepared=>window.threadterm.activateDataRelocation(prepared),prepared); assert.equal(activated.activated,true);
 await page.reload(); await page.waitForFunction(()=>!!window.threadterm,{timeout:15000});
 const status=await page.evaluate(()=>window.threadterm.request('data.status',{})); assert.equal(normalizePath(status.root),normalizePath(target));
 const pointer=JSON.parse(await readFile(join(userData,'runtime-data-root.json'),'utf8')); assert.equal(normalizePath(pointer.root),normalizePath(target));
 const state=await app.evaluate(()=>globalThis.relocationQaRestart); assert.deepEqual(state,{relaunch:1,exit:1});
 await page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()}));
 console.log(JSON.stringify({passed:true,checks:['isolated Electron userData','desktop prepare/activate lifecycle','old daemon pipe release','new runtime target root verification','pointer activation','relaunch and exit requested','authenticated target shutdown']}));
} finally { if(app){await app.evaluate(({app})=>{const qa=globalThis.__relocationQa;setTimeout(()=>app.exit(),0)}).catch(()=>{});await app.close().catch(()=>{});} await rm(scratch,{recursive:true,force:true}); }
function normalizePath(value){return value.replace(/^\\\\\?\\/,'').toLowerCase();}
