import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {connectPeer} from './pipe-client.mjs';
const dir=await mkdtemp(join(tmpdir(),'threadterm-v3-providers-'));
const pipe=`\\\\.\\pipe\\threadterm-v3-provider-qa-${randomUUID()}`;
const env={...process.env,THREADTERM_V3_DATA:join(dir,'data'),THREADTERM_V3_PIPE:pipe};
const daemon=spawn(process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve('runtime/target/debug/threadterm-v3-runtime.exe'),[],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});let diagnostic='';daemon.stderr.on('data',b=>diagnostic+=b);
let peer;const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(let n=0;n<150;n++){try{peer=await connectPeer(`${pipe}-control`);const secret=(await readFile(join(dir,'data/runtime.credential'),'utf8')).trim();await peer.auth(secret);break}catch(e){peer?.close();peer=undefined;if(daemon.exitCode!==null)throw Error(`runtime failed: ${diagnostic}`);await delay(100)}}
 if(!peer)throw Error('runtime startup timeout');
 const capabilities=await peer.request('provider.list');const results=[];
 for(const provider of capabilities.filter(p=>['codex','claude','kimi','gemini','opencode'].includes(p.id))){
  const row={provider:provider.id,installed:provider.installed,version:provider.version,chat:provider.chat,auth:provider.auth};
  try{const history=await peer.request('history.list',{provider:provider.id,limit:2});row.historyCount=history.items.length;const first=history.items[0];if(first){row.firstHistoryResumable=first.resumable;const transcript=await peer.request('history.read',{provider:provider.id,nativeId:first.nativeId},45_000);row.firstTranscriptItems=transcript.length;}}catch(e){row.historyError=e.message;row.schemaErrors=e.schemaErrors}
  results.push(row);console.log(JSON.stringify(row));
 }
 await mkdir('qa/results',{recursive:true});await writeFile('qa/results/provider-probes.json',JSON.stringify({results,diagnostic},null,2));
 await peer.request('runtime.shutdown',{operationId:randomUUID()});
}catch(e){console.error(e);process.exitCode=1}
finally{peer?.close();if(daemon.exitCode===null)daemon.kill();}
