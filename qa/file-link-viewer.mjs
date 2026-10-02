import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

const qaDir=dirname(fileURLToPath(import.meta.url));
for(const theme of ['light','dark']) {
 const child=spawn(process.execPath,['qa/editor-smoke.mjs'],{cwd:dirname(qaDir),env:{...process.env,THREADTERM_V3_QA_THEME:theme},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';
 child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
 child.stderr.on('data',chunk=>{output+=chunk;process.stderr.write(chunk);});
 const timer=setTimeout(()=>{console.error(`file-link-viewer ${theme} timeout after 45s; terminating only child pid`,child.pid);child.kill();},45_000);
 const code=await new Promise(resolve=>child.once('exit',resolve));
 clearTimeout(timer);
 if(code!==0)throw new Error(`file-link-viewer ${theme} failed (exit ${code ?? 'signal'}): ${output.slice(-2000)}`);
}
