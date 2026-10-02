// Opt-in, isolated live Kimi/Grok file-navigation verification. It sends at
// most one tiny prompt per provider and never approves tools, trust, or update
// requests. Set THREADTERM_QA_LIVE_FILE_NAVIGATION=1 only after coordination.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectPeer} from './pipe-client.mjs';
import {extractFileReferences} from '../renderer/src/fileReferences.ts';

process.chdir(resolve(fileURLToPath(new URL('..',import.meta.url))));
const enabled=process.env.THREADTERM_QA_LIVE_FILE_NAVIGATION==='1';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const id=()=>randomUUID();
const scratch=await mkdtemp(join(tmpdir(),'threadterm-agent-file-nav-live-'));
const data=join(scratch,'data'),profile=join(scratch,'profile'),workspace=join(scratch,'workspace');
const pipe=`\\\\.\\pipe\\threadterm-agent-file-nav-${id()}`;
const fallback=resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
const runtime=process.env.THREADTERM_QA_RUNTIME_EXE||process.env.THREADTERM_V3_RUNTIME_BIN||(existsSync(fallback)?fallback:resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
const report={startedAt:new Date().toISOString(),live:enabled,providers:[],ui:'deferred: Electron is scheduled separately'};
let daemon,peer;
const prompt='只输出 [sample.md](sample.md) 和 `sample.md`，不执行工具。';

async function connect(){
 for(let attempt=0;attempt<150;attempt++){
  let candidate;
  try{candidate=await connectPeer(`${pipe}-control`);const credential=(await readFile(join(data,'runtime.credential'),'utf8')).trim();const clientId=await candidate.auth(credential);return{peer:candidate,clientId};}
  catch(error){candidate?.close();if(daemon.exitCode!==null)throw new Error('isolated runtime exited before authentication');await delay(100);}
 }
 throw new Error('isolated runtime startup timeout');
}
function assistantText(items,turnId){return items.filter(item=>item.role==='assistant'&&item.turnId===turnId).flatMap(item=>item.parts).filter(part=>part.type==='text').map(part=>part.text??'').join('');}
function approvals(items,turnId){return items.filter(item=>item.turnId===turnId).flatMap(item=>item.parts).filter(part=>part.type==='approval'&&part.status!=='resolved');}
function redactedSample(text){return text.replace(/\b(?:sk|api[_-]?key|token|secret)[A-Za-z0-9_-]{8,}\b/gi,'[redacted]').slice(0,512);}
async function verifyProvider(provider,clientId,project){
 const row={provider,attempted:false};let session;
 try{
  const capability=(await peer.request('provider.list')).find(item=>item.id===provider);
  row.capability={installed:capability?.installed,auth:capability?.auth,chat:capability?.chat,reason:capability?.reason};
  if(!capability?.installed||!capability.chat||capability.auth==='unauthenticated'){row.limited='provider unavailable or unauthenticated';return row;}
  session=await peer.request('session.create',{projectId:project.id,cwd:workspace,title:`${provider} file navigation live QA`,provider,mode:'chat',operationId:id()},60_000);
  let lease=(await peer.request('session.claim',{sessionId:session.id,clientId})).leaseEpoch;
  const connection=await peer.request('chat.connect',{sessionId:session.id,leaseEpoch:lease,operationId:id()},60_000);
  row.connection=connection.phase;
  if(connection.phase!=='ready'){row.limited='provider did not become ready';return row;}
  row.attempted=true;
  const sent=await peer.request('chat.send',{sessionId:session.id,text:prompt,operationId:id(),leaseEpoch:lease},60_000);
  const deadline=Date.now()+120_000;let items=[],status='running',nextRenewal=Date.now()+10_000;
  while(Date.now()<deadline){items=await peer.request('chat.read',{sessionId:session.id});const approval=approvals(items,sent.turnId);if(approval.length){row.limited='provider requested approval; not approved';return row;}const snapshot=await peer.request('runtime.snapshot');status=snapshot.sessions.find(item=>item.id===session.id)?.status??status;if(Date.now()>=nextRenewal){lease=(await peer.request('session.renew',{sessionId:session.id,leaseEpoch:lease})).leaseEpoch;nextRenewal=Date.now()+10_000;}if(status==='idle'||status==='error')break;await delay(400);}
  const text=assistantText(items,sent.turnId);row.status=status;row.chatBodyLength=text.length;row.assistantSample=redactedSample(text);row.chatCandidates=extractFileReferences(text).map(({path,line,column})=>({path,line,column}));
  if(status==='error'){row.limited='provider returned an error';return row;}
  if(status!=='idle'){row.limited='turn did not complete before the bounded wait';return row;}
  assert.ok(text.includes('sample.md'),'assistant body omitted the requested file link/text');assert.ok(row.chatCandidates.some(reference=>reference.path==='sample.md'),'renderer parser did not extract sample.md from actual chat body');
  const resolved=await peer.request('filesystem.resolve',{sessionId:session.id,path:'sample.md'});
  assert.equal(resolved.path,'sample.md');row.resolver={path:resolved.path,kind:resolved.kind,projectId:resolved.projectId};row.passed=true;
 }catch(error){row.error=error instanceof Error?error.message:String(error);}
 finally{if(session)await peer.request('session.stop',{sessionId:session.id,operationId:id()}).catch(()=>{});}
 return row;
}

try{
 await Promise.all([mkdir(data,{recursive:true}),mkdir(profile,{recursive:true}),mkdir(workspace,{recursive:true})]);await writeFile(join(workspace,'sample.md'),'# Sample\n');
 if(!enabled){report.limited='dry run only; set THREADTERM_QA_LIVE_FILE_NAVIGATION=1 after root green signal';}
 else{
  daemon=spawn(runtime,[],{windowsHide:true,env:{...process.env,THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:profile,THREADTERM_V3_PIPE:pipe},stdio:['ignore','ignore','pipe']});daemon.stderr.on('data',()=>{});
  const connected=await connect();peer=connected.peer;const project=await peer.request('project.add',{path:workspace,name:'Agent file navigation live QA',operationId:id()});
  for(const provider of ['kimi','grok'])report.providers.push(await verifyProvider(provider,connected.clientId,project));
 }
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
 report.completedAt=new Date().toISOString();await mkdir('qa/results',{recursive:true});await writeFile('qa/results/agent-file-navigation-live.json',`${JSON.stringify(report,null,2)}\n`);await peer?.request('runtime.shutdown',{operationId:id()}).catch(()=>{});peer?.close();
 if(daemon?.exitCode===null){await Promise.race([new Promise(done=>daemon.once('exit',done)),delay(5_000)]);if(daemon.exitCode===null)daemon.kill();}
 const tempRelative=relative(resolve(tmpdir()),resolve(scratch));if(tempRelative&&!tempRelative.startsWith('..')&&!tempRelative.includes(':')&&basename(scratch).startsWith('threadterm-agent-file-nav-live-'))await rm(scratch,{recursive:true,force:true,maxRetries:4,retryDelay:100}).catch(()=>{});console.log(JSON.stringify(report));
}

if(enabled&&report.providers.some(row=>row.attempted&&!row.passed))process.exitCode=1;
