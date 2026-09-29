// Isolated named-pipe/child-process regression. No account, network or live daemon is used.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {connectPeer} from './pipe-client.mjs';

const root = await mkdtemp(join(tmpdir(), 'threadterm-grok-network-'));
const bin = join(root, 'bin'), data = join(root, 'data'), cwd = join(root, 'workspace');
await Promise.all([mkdir(bin), mkdir(cwd)]);
const events = join(root, 'child-events.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-grok-network-${randomUUID()}`;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const fake = `
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const log = value => appendFileSync(process.env.TT_QA_EVENTS, JSON.stringify({pid:process.pid,...value})+'\\n');
const env = Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','GROK_WEB_FETCH_PROXY'].map(key => [key,process.env[key]??null]));
log({type:'spawn',args:process.argv.slice(2),env});
if(process.argv.includes('--version')) { console.log('grok 0.0-qa'); process.exit(0); }
if(!process.argv.includes('stdio')) { setInterval(()=>{},1000); }
else {
 const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
 const response = (id,result) => send({jsonrpc:'2.0',id,result});
 const nativeId='qa-'+process.pid;
 const update = update => send({jsonrpc:'2.0',method:'_x.ai/session/update',params:{sessionId:nativeId,update}});
 createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line); log({type:'request',method:request.method});
  if(request.method==='initialize') response(request.id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},load:{}}}});
  else if(request.method==='session/new') response(request.id,{sessionId:nativeId});
  else if(request.method==='session/list') response(request.id,{sessions:[]});
  else if(request.method==='session/prompt') {
   if(request.params.prompt[0].text==='instant') {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Instant reply'}}}});
    response(request.id,{stopReason:'end_turn'});return;
   }
   update({sessionUpdate:'retry_state',type:'retrying',attempt:1,max_retries:15,error_type:'http',reason:'not exposed raw secret=fixture'});
   setTimeout(()=>update({sessionUpdate:'retry_state',type:'retrying',attempt:2,max_retries:15,error_type:'http'}),40);
   setTimeout(()=>{
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture reply'}}}});
    response(request.id,{stopReason:'end_turn'});
   },500);
  }
  else if(request.id!==undefined) response(request.id,{});
 });
}
`;
await writeFile(join(bin, 'fake-grok.mjs'), fake);
// Native shim avoids shell quoting and forwards the real supervised stdio.
await writeFile(join(bin,'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compile = spawnSync('rustc',[join(bin,'shim.rs'),'-o',join(bin,'grok.exe')],{encoding:'utf8',windowsHide:true});
assert.equal(compile.status,0,compile.stderr);
const remove = /^(path|http_proxy|https_proxy|all_proxy|no_proxy|grok_forward_proxy|grok_web_fetch_proxy|threadterm_grok_proxy|threadterm_v3_data|threadterm_v3_pipe)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !remove.test(key)));
Object.assign(env, {
  Path:[bin,dirname(process.execPath),join(process.env.SystemRoot || 'C:\\Windows','System32')].join(';'),
  THREADTERM_V3_DATA:data, THREADTERM_V3_PIPE:pipe, TT_QA_EVENTS:events,
  TT_QA_NODE:process.execPath, TT_QA_SCRIPT:join(bin,'fake-grok.mjs'),
  HTTPS_PROXY:'http://inherited.invalid:8081', HTTP_PROXY:'http://inherited.invalid:8081',
  NO_PROXY:'localhost,.internal.test',
});
const daemon = spawn(process.env.THREADTERM_V3_RUNTIME_BIN || resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'), [], {env,windowsHide:true,stdio:['ignore','ignore','pipe']});
let diagnostic='', peer, clientId;
daemon.stderr.on('data', bytes => {diagnostic += bytes.toString();});
const records = async () => (await readFile(events,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const waitFor = async (read, predicate, label) => {
  for(let attempt=0;attempt<120;attempt++) {const value=await read();if(predicate(value))return value;await delay(50);}
  throw new Error('Timed out: '+label);
};
async function create(mode='chat') {
  const session=await peer.request('session.create',{cwd,title:'Isolated proxy QA',provider:'grok',mode,operationId:randomUUID()});
  if(mode==='terminal') return session;
  assert.equal(session.status,'starting');
  const leaseEpoch=(await peer.request('session.claim',{sessionId:session.id,clientId})).leaseEpoch;
  const connection=await peer.request('chat.connect',{sessionId:session.id,leaseEpoch,operationId:randomUUID()});
  assert.equal(connection.phase,'ready');
  return {...session,leaseEpoch};
}
async function save(grok) {
  const current=await peer.request('runtime.snapshot');
  return peer.request('settings.update',{patch:{providerNetwork:{grok}},expectedRevision:current.settings.revision,operationId:randomUUID()});
}
try {
  for(let attempt=0;attempt<120;attempt++) {
    try {peer=await connectPeer(pipe+'-control');clientId=await peer.auth((await readFile(join(data,'runtime.credential'),'utf8')).trim());break;}
    catch {peer?.close();peer=undefined;if(daemon.exitCode!==null)throw new Error(diagnostic);await delay(50);}
  }
  assert.ok(peer,'isolated daemon authenticated');
  const first=await create();
  const inherited=(await records()).filter(row=>row.type==='spawn'&&row.args.includes('stdio')).at(-1);
  assert.equal(inherited.env.HTTPS_PROXY,'http://inherited.invalid:8081');
  const settingsBefore=await peer.request('runtime.snapshot');
  await assert.rejects(()=>save({mode:'custom',proxyUrl:'file:///bad'}),/HTTP|proxy/i);
  assert.equal((await peer.request('runtime.snapshot')).settings.revision,settingsBefore.settings.revision,'invalid settings do not commit');
  await save({mode:'custom',proxyUrl:'http://portable.invalid:8123',noProxy:'localhost,.qa.test'});
  const second=await create();
  const custom=(await records()).filter(row=>row.type==='spawn'&&row.args.includes('stdio')).at(-1);
  assert.equal(custom.env.HTTPS_PROXY,'http://portable.invalid:8123');
  assert.equal(custom.env.HTTP_PROXY,custom.env.HTTPS_PROXY);
  assert.equal(custom.env.ALL_PROXY,custom.env.HTTPS_PROXY);
  assert.equal(custom.env.GROK_WEB_FETCH_PROXY,custom.env.HTTPS_PROXY);
  assert.equal(custom.env.NO_PROXY,'localhost,.qa.test');
  await peer.request('history.list',{provider:'grok',limit:10});
  const history=(await records()).filter(row=>row.type==='spawn'&&row.args.includes('stdio')).at(-1);
  assert.equal(history.env.HTTPS_PROXY,'http://portable.invalid:8123','history helper receives settings');
  const terminal=await create('terminal');
  // Terminal creation preassigns the native ID; it no longer launches Grok
  // with an empty argument list. Keep distinguishing it from ACP helpers.
  const isTerminalSpawn=row=>row.type==='spawn'&&row.args.length===2&&row.args[0]==='--session-id';
  const terminalRows=await waitFor(records,rows=>rows.some(isTerminalSpawn),'terminal child');
  assert.equal(terminalRows.find(isTerminalSpawn).env.HTTPS_PROXY,'http://portable.invalid:8123');
  await peer.request('session.stop',{sessionId:terminal.id,operationId:randomUUID()});
  await save({mode:'inherit',proxyUrl:'',noProxy:''});
  const third=await create();
  const restored=(await records()).filter(row=>row.type==='spawn'&&row.args.includes('stdio')).at(-1);
  assert.equal(restored.env.HTTPS_PROXY,'http://inherited.invalid:8081','custom settings never mutate daemon inherited environment');
  const turnId=randomUUID();
  await peer.request('chat.send',{sessionId:second.id,text:'hello',leaseEpoch:second.leaseEpoch,operationId:turnId});
  const retryItems=await waitFor(()=>peer.request('chat.read',{sessionId:second.id}),items=>items.some(item=>item.parts.some(part=>part.data?.kind==='providerRetry'&&part.data.attempt===2)),'native retry state projected');
  const notice=retryItems.find(item=>item.parts.some(part=>part.data?.kind==='providerRetry'));
  assert.equal(notice.parts[0].data.state,'retrying');
  assert.equal(JSON.stringify(notice).includes('secret='),false);
  const completed=await waitFor(()=>peer.request('chat.read',{sessionId:second.id}),items=>items.some(item=>item.parts.some(part=>part.data?.state==='complete')),'retry notice finalized');
  assert.equal(completed.filter(item=>item.parts.some(part=>part.data?.kind==='providerRetry')).length,1,'retry notifications replace one stable item');
  assert.ok(completed.some(item=>item.parts.some(part=>part.text==='Fixture reply')),'retry notices preserve actual reply');
  const instantTurn=randomUUID();
  await peer.request('chat.send',{sessionId:third.id,text:'instant',leaseEpoch:third.leaseEpoch,operationId:instantTurn});
  await waitFor(()=>peer.request('runtime.snapshot'),snapshot=>snapshot.sessions.find(session=>session.id===third.id)?.status==='idle','instant reply remains idle');
  const started=await peer.nextEvent(event=>event.event==='state.changed'&&event.data?.sessionId===third.id&&event.data?.kind==='chat.turn.started');
  const finished=await peer.nextEvent(event=>event.event==='state.changed'&&event.data?.sessionId===third.id&&event.data?.kind==='chat.turn.completed');
  assert.ok(started&&finished&&started.seq<finished.seq,'native immediate reply must follow its started event');
  for(const session of [first,second,third]) await peer.request('session.stop',{sessionId:session.id,operationId:randomUUID()});
  console.log(JSON.stringify({passed:true,checks:['inherited proxy','validated revisioned custom settings','Chat/history/Terminal child environment','return to inherited environment without daemon mutation','native retry projection and completion','immediate native reply preserves started/completed event order and idle status'],root}));
} catch(error) {
  console.error(JSON.stringify({root,diagnostic}));
  throw error;
} finally {
  if(peer) {try {await peer.request('runtime.shutdown',{operationId:randomUUID()});} catch {} peer.close();}
  if(daemon.exitCode===null) await Promise.race([new Promise(done=>daemon.once('exit',done)),delay(3000)]);
  if(daemon.exitCode===null) daemon.kill();
}
