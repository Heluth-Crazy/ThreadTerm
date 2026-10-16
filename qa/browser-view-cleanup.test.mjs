import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {closeBrowserViewFixture,within} from './lib/browser-view-cleanup.mjs';

const never=()=>new Promise(()=>{});

test('within bounds a hung cleanup action',async()=>{
 const started=Date.now(),result=await within(never,10);
 assert.equal(result.timedOut,true);assert.ok(Date.now()-started<200);
});

test('browser fixture cleanup bounds hung app, runtime and server then kills only its process tree',async()=>{
 const calls=[],child={pid:4242,exitCode:null,signalCode:null};
 const app={process:()=>child,evaluate:never,close:never};
 const page={evaluate:never};
 const server={closed:false,closeAllConnections(){this.closed=true;},close:never};
 const runtime={pid:6262,exitCode:null,signalCode:null,kills:[],kill(signal){this.kills.push(signal??'default');return true;},once(){},removeListener(){}};
 const errors=await closeBrowserViewFixture({app,page,server,runtime,timeoutMs:10,taskkill:async pid=>{calls.push(pid);child.exitCode=1;}});
 assert.deepEqual(calls,[4242]);assert.equal(server.closed,true);assert.deepEqual(runtime.kills,['default','SIGKILL']);assert.equal(errors.filter(value=>value.includes('timed out')).length,5);assert.ok(errors.some(value=>value.startsWith('fixture runtime:')));
});

test('browser fixture cleanup keeps a graceful fixture shutdown scoped and quiet',async()=>{
 const calls=[],child={pid:5252,exitCode:0,signalCode:null};
 const app={process:()=>child,evaluate:async()=>{calls.push('app');},close:async()=>{calls.push('close');}};
 const page={evaluate:async()=>{calls.push('runtime');}};
 const server={closeAllConnections:()=>calls.push('connections'),close:done=>{calls.push('server');done();}};
 const errors=await closeBrowserViewFixture({app,page,server,runtime:{pid:6262,exitCode:0,signalCode:null},timeoutMs:20,taskkill:async()=>{throw Error('must not kill an exited fixture');}});
 assert.deepEqual(errors,[]);assert.deepEqual(calls,['app','runtime','app','close','connections','server']);
});

test('browser fixture stops its owned runtime after Electron when the page is absent',async()=>{
 const calls=[],runtime=Object.assign(new EventEmitter(),{pid:6262,exitCode:null,signalCode:null,kill(){calls.push('runtime kill');this.exitCode=0;this.emit('exit',0);return true;}});
 const child={pid:5252,exitCode:0,signalCode:null};
 const app={process:()=>child,evaluate:async()=>calls.push('Electron exit'),close:async()=>calls.push('Electron close')};
 const errors=await closeBrowserViewFixture({app,runtime,shutdownRuntime:false,timeoutMs:20,taskkill:async()=>{throw Error('exited Electron must not be killed');}});
 assert.deepEqual(errors,[]);assert.deepEqual(calls,['Electron exit','Electron exit','Electron close','runtime kill']);
});

test('Electron target-closed rejection is healthy after its owned child exits',async()=>{
 const child=Object.assign(new EventEmitter(),{pid:5252,exitCode:null,signalCode:null});
 let evaluates=0;const app={process:()=>child,evaluate:async()=>{if(++evaluates===1)return;setImmediate(()=>{child.exitCode=0;child.emit('exit',0);});throw Error('Target page, context or browser has been closed');},close:async()=>{throw Error('connection closed');}};
 const errors=await closeBrowserViewFixture({app,shutdownRuntime:false,timeoutMs:20,taskkill:async()=>{throw Error('exited Electron must not be killed');}});
 assert.deepEqual(errors,[]);
});


test('within returns probe values and captures rejection without leaving a timer',async()=>{
 const value=await within(()=>42,100);assert.equal(value.value,42);assert.equal(value.timedOut,false);
 const error=Error('probe failed'),failed=await within(()=>{throw error;},100);assert.equal(failed.error,error);assert.equal(failed.timedOut,undefined);
});

test('the visual harness deadline also bounds a stuck Playwright probe',{timeout:1000},async()=>{
 const declaration=readFileSync('qa/browser-view-visual.mjs','utf8').match(/^async function until\(.*$/m)?.[0];assert.ok(declaration);
 const until=vm.runInNewContext(`${declaration}\nuntil`,{within,Date,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
 await assert.rejects(until(never,'stuck probe',10),/Timed out: stuck probe/);
 assert.equal(await until(()=>Promise.resolve(42),'ready probe',100),42);
});
