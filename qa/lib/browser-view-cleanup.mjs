import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stopChild,waitForChildExit} from './qa-cleanup.mjs';

const execFileAsync=promisify(execFile);

export async function within(action, timeoutMs) {
 let timer;
 return new Promise(resolve=>{
  timer=setTimeout(()=>resolve({timedOut:true}),timeoutMs);
  Promise.resolve().then(action).then(value=>{clearTimeout(timer);resolve({timedOut:false,value});},error=>{clearTimeout(timer);resolve({error});});
 });
}

function isRunning(child) { return child?.pid&&child.exitCode===null&&child.signalCode===null; }

export async function closeBrowserViewFixture({app,page,server,runtime,shutdownRuntime=true,timeoutMs=5_000,taskkill=(pid)=>execFileAsync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:timeoutMs})}={}) {
 const errors=[],child=app?.process?.(),pid=isRunning(child)?child.pid:undefined;
 const step=async(label,action,acceptError=()=>false)=>{const result=await within(action,timeoutMs);if(result.timedOut)errors.push(`${label} timed out after ${timeoutMs} ms`);else if(result.error&&!(await acceptError(result.error)))errors.push(`${label}: ${result.error.message??result.error}`);return result;};
 if(app)await step('browser profile flush',()=>app.evaluate(async({session})=>{const profile=session.fromPartition('persist:threadterm-browser');await profile.cookies.flushStore();profile.flushStorageData();}),()=>!isRunning(child));
 if(page&&shutdownRuntime)await step('runtime shutdown',()=>page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})));
 const electronGone=async()=>{if(!isRunning(child))return true;try{await waitForChildExit(child,{label:'fixture Electron process',timeoutMs});return true}catch{return false;}};
 if(app)await step('Electron exit',()=>app.evaluate(({app})=>app.exit(0)),electronGone);
 if(app)await step('Electron close',()=>app.close(),electronGone);
 if(isRunning(child))await step(`fixture Electron process tree ${pid}`,()=>taskkill(pid));
 if(runtime)try{await stopChild(runtime,{label:'fixture runtime',gracefulTimeoutMs:timeoutMs,forcedTimeoutMs:timeoutMs});}catch(error){errors.push(`fixture runtime: ${error.message??error}`);}
 if(server){server.closeAllConnections?.();await step('local HTTP server close',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));}
 return errors;
}
