// Isolated Grok slash-command routing regression. It records real ACP JSON-RPC
// frames from a supervised child; no account, network, or live daemon is used.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {connectPeer} from './pipe-client.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const id = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-grok-commands-'));
const bin = join(root, 'bin'), data = join(root, 'data'), cwd = join(root, 'workspace');
const frames = join(root, 'native-frames.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-grok-commands-${id()}`;
await Promise.all([mkdir(bin), mkdir(cwd)]);

const fake = String.raw`
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const nativeId = 'grok-command-fixture';
const calls = new Map();
const log = row => appendFileSync(process.env.TT_QA_FRAMES, JSON.stringify(row)+'\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const fail = (id, message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message}})+'\n');
if (process.argv.includes('--version')) { console.log('grok command-fixture'); process.exit(0); }
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line); log({method:request.method, params:request.params ?? null});
 const number = (calls.set(request.method, (calls.get(request.method) ?? 0) + 1), calls.get(request.method));
 const p = request.params ?? {};
 if (request.method === 'initialize') return reply(request.id, {protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},load:{}}},configOptions:[
   {configId:'model',name:'Model',currentValue:'grok-4.6',options:[{value:'grok-4.6',name:'Grok 4.6'},{value:'bad-model',name:'Broken model'}]},
   {configId:'reasoning_effort',name:'Thinking',currentValue:'high',options:[{value:'high',name:'High'},{value:'broken',name:'Broken thinking'}]}
 ]});
 if (request.method === 'session/new') return reply(request.id, {sessionId:nativeId});
 if (request.method === 'session/list') return reply(request.id, {sessions:[]});
 if (request.method === '_x.ai/session/usage') {
  if (number === 6) return fail(request.id, 'usage unavailable');
  if (number === 3) return reply(request.id, {usage:{inputTokens:0,outputTokens:0,totalTokens:0,modelCalls:0,apiDurationMs:0,numTurns:0}});
  if (number === 5) return setTimeout(() => reply(request.id, {usage:{inputTokens:123,outputTokens:45,totalTokens:168,modelCalls:2,numTurns:1}}), 250);
  return reply(request.id, {usage:{inputTokens:123,outputTokens:45,totalTokens:168,cachedReadTokens:20,cacheCreationTokens:5,reasoningTokens:8,modelCalls:2,apiDurationMs:1250,costUsdTicks:12500000000,numTurns:1,modelUsage:{'grok-4.6':{inputTokens:123,outputTokens:45,totalTokens:168}}}});
 }
 if (request.method === '_x.ai/billing') {
  if (number === 4) return setTimeout(() => fail(request.id, 'billing unavailable'), 120);
  if (number === 5) return setTimeout(() => reply(request.id, {subscription_tier:'SuperGrok',config:{creditUsagePercent:60,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',end:'2026-09-22T10:08:00Z'}}}), 250);
  return setTimeout(() => reply(request.id, {subscription_tier:'SuperGrok',config:{creditUsagePercent:60,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',end:'2026-09-22T10:08:00Z'}}}), 120);
 }
 if (request.method === '_x.ai/session/info') return number > 2 ? fail(request.id, 'info unavailable') : reply(request.id, {result:{cwd:'C:/fixture',agentName:'Grok',model:'grok-4.6',modelDisplayName:'Grok 4.6',resolvedModelId:'grok-4.6',apiBackend:'fixture',turns:1,turnIndex:1,context:{used:12,total:128,usagePct:9,compactionCount:0,usageCategories:[]}}});
 if (request.method === '_x.ai/compact_conversation') {
  setTimeout(() => number > 1 ? fail(request.id, 'compact unavailable') : reply(request.id, {}), 150);
  return;
 }
 if (request.method === 'session/set_mode') return p.modeId === 'bypassPermissions' ? fail(request.id, 'mode unavailable') : reply(request.id, {});
 if (request.method === 'session/set_config_option') return p.value === 'bad-model' || p.value === 'broken' ? fail(request.id, 'option unavailable') : reply(request.id, {});
 if (request.method === 'session/set_model') return fail(request.id, 'fallback unavailable');
 if (request.method === 'session/prompt') {
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ordinary prompt reply'}}}})+'\n');
   return reply(request.id, {stopReason:'end_turn'});
 }
 if (request.id !== undefined) fail(request.id, 'unexpected method '+request.method);
});
`;
await writeFile(join(bin, 'fake-grok.mjs'), fake);
await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'grok.exe')], {encoding:'utf8', windowsHide:true});
assert.equal(compiled.status, 0, compiled.stderr);
const runtimeBin = process.env.THREADTERM_QA_RUNTIME_EXE || process.env.THREADTERM_V3_RUNTIME_BIN || (existsSync(resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe')) ? resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe') : resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
const environment = {...process.env, Path:[bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA:data, THREADTERM_V3_PIPE:pipe, TT_QA_NODE:process.execPath, TT_QA_SCRIPT:join(bin, 'fake-grok.mjs'), TT_QA_FRAMES:frames};
const daemon = spawn(runtimeBin, [], {env:environment, windowsHide:true, stdio:['ignore', 'ignore', 'pipe']});
let diagnostic = '', peer, clientId, sessionId;
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
const recorded = async () => {
 try { return (await readFile(frames, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; }
};
const waitFor = async (read, predicate, label) => {
 for (let attempt = 0; attempt < 120; attempt += 1) { const value = await read(); if (predicate(value)) return value; await delay(50); }
 throw new Error(`Timed out: ${label}`);
};
const messages = async sessionId => peer.request('chat.read', {sessionId});
const textSince = async (sessionId, count) => (await messages(sessionId)).slice(count).flatMap(item => item.parts).map(part => `${part.text || ''}\n${JSON.stringify(part.data || {})}`).join('\n');

try {
 for (let attempt = 0; attempt < 120; attempt += 1) {
  try { peer = await connectPeer(`${pipe}-control`); clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); break; }
  catch { peer?.close(); peer = undefined; if (daemon.exitCode !== null) throw new Error(diagnostic); await delay(50); }
 }
 assert.ok(peer, 'isolated runtime authenticated');
 const session = await peer.request('session.create', {cwd, title:'Grok command QA', provider:'grok', mode:'chat', operationId:id()});
 sessionId = session.id;
 const leaseEpoch = (await peer.request('session.claim', {sessionId:session.id, clientId})).leaseEpoch;
 assert.equal((await peer.request('chat.connect', {sessionId:session.id, leaseEpoch, operationId:id()})).phase, 'ready');
 const ui = await peer.request('chat.options', {sessionId:session.id});
 const advertised = new Set(ui.commands.map(command => command.name));
 const expected = new Set(['compact','model','thinking','mode','plan','always-approve','help','status','usage']);
 assert.deepEqual(advertised, expected, `advertised commands must all be routed: ${[...advertised]}`);

 const send = async text => peer.request('chat.send', {sessionId:session.id, text, leaseEpoch, operationId:id()});
 const assertRoute = async (text, method, expectedText) => {
  const beforeFrames = (await recorded()).length, beforeItems = (await messages(session.id)).length;
  await send(text);
  await waitFor(recorded, rows => rows.slice(beforeFrames).some(row => row.method === method), `${text} -> ${method}`);
  const rows = (await recorded()).slice(beforeFrames);
  assert.equal(rows.some(row => row.method === 'session/prompt'), false, `${text} must not become a prompt`);
  if (expectedText) await waitFor(() => textSince(session.id, beforeItems), value => value.includes(expectedText), `${text} feedback`);
 };
 const assertUsage = async (command, expectedText, expectedPlan = true) => {
  const beforeFrames = (await recorded()).length, beforeItems = (await messages(session.id)).length;
  const turn = await send(command);
  await waitFor(recorded, rows => {
   const current = rows.slice(beforeFrames);
   return current.some(row => row.method === '_x.ai/session/usage') && current.some(row => row.method === '_x.ai/billing');
  }, `${command} starts both native usage queries`);
  const rows = (await recorded()).slice(beforeFrames);
  assert.equal(rows.some(row => row.method === 'session/prompt'), false, `${command} must not become a model prompt`);
  await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'running', `${command} running`);
  await waitFor(() => textSince(session.id, beforeItems), value => value.includes(expectedText), `${command} reply`);
  const reply = await textSince(session.id, beforeItems);
  if (expectedPlan) {
   assert.match(reply, /SuperGrok/);
   assert.match(reply, /60%/);
   assert.match(reply, /Weekly limit/);
  }
  await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'idle', `${command} completion`);
  return {beforeFrames, beforeItems, turn, reply};
 };
 await assertUsage('/usage', '123');
 await assertUsage('/cost', '1.25');
 const assertFailureRoute = async (text, method) => {
  const beforeFrames = (await recorded()).length, beforeItems = (await messages(session.id)).length;
  await send(text);
  await waitFor(recorded, rows => rows.slice(beforeFrames).some(row => row.method === method), `${text} failed ${method}`);
  const rows = (await recorded()).slice(beforeFrames);
  assert.equal(rows.some(row => row.method === 'session/prompt'), false, `${text} failure must not become a prompt`);
  await waitFor(() => textSince(session.id, beforeItems), value => /failed|unavailable|error/i.test(value), `${text} failed feedback`);
 };
 const emptyUsage = await assertUsage('/usage', 'No model calls yet in this session.');
 assert.doesNotMatch(emptyUsage.reply, /(?:input|output|total|cached|reasoning) tokens?:\s*0\b/i, 'empty native counters must be explained, never rendered as fake token rows');
 const billingFailure = await assertUsage('/usage', 'Account usage limits are currently unavailable', false);
 assert.match(billingFailure.reply, /123/);
 assert.doesNotMatch(billingFailure.reply, /60%/, 'billing failure must not appear as 0% or a stale plan percentage');
 await assertRoute('/status', '_x.ai/session/info', 'Grok');
 await assertRoute('/info', '_x.ai/session/info', 'Grok');
 await assertFailureRoute('/session-info', '_x.ai/session/info');
 const assertCompact = async shouldFail => {
  const beforeFrames = (await recorded()).length, beforeItems = (await messages(session.id)).length;
  await send('/compact');
  await waitFor(recorded, rows => rows.slice(beforeFrames).some(row => row.method === '_x.ai/compact_conversation'), 'compact route');
  assert.equal((await recorded()).slice(beforeFrames).some(row => row.method === 'session/prompt'), false, 'compact must never become a model prompt');
  await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'running', 'compact running before delayed native response');
  if (shouldFail) await waitFor(() => textSince(session.id, beforeItems), value => /compact unavailable|error/i.test(value), 'compact failure feedback');
  else await waitFor(() => textSince(session.id, beforeItems), value => /completed conversation compaction/i.test(value), 'compact success feedback');
  await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === (shouldFail ? 'error' : 'idle'), shouldFail ? 'compact terminal error state' : 'compact terminal idle state');
 };
 await assertCompact(false);
 await assertCompact(true);

 for (const command of ['/help', '/dashboard', '/learn', '/does-not-exist']) {
  const beforeFrames = (await recorded()).length, beforeItems = (await messages(session.id)).length;
  await send(command);
  await delay(150);
  const rows = (await recorded()).slice(beforeFrames);
  assert.equal(rows.some(row => row.method === 'session/prompt'), false, `${command} must be safe local feedback, never a prompt`);
  assert.ok((await textSince(session.id, beforeItems)).length > 0, `${command} must explain its local outcome`);
 }
 const beforeInvalidPlanFrames = (await recorded()).length, beforeInvalidPlanItems = (await messages(session.id)).length;
 await send('/plan later');
 await waitFor(() => textSince(session.id, beforeInvalidPlanItems), value => /usage/i.test(value), 'invalid /plan feedback');
 assert.equal((await recorded()).slice(beforeInvalidPlanFrames).some(row => ['session/prompt', 'session/set_mode'].includes(row.method)), false, 'invalid /plan must stay local and never change mode');
 for (const [command, method] of [['/model grok-4.6', 'session/set_config_option'], ['/thinking high', 'session/set_config_option'], ['/mode default', 'session/set_mode'], ['/plan', 'session/set_mode']]) {
  const beforeFrames = (await recorded()).length;
  await send(command);
  await waitFor(recorded, rows => rows.slice(beforeFrames).some(row => row.method === method), `${command} route`);
 assert.equal((await recorded()).slice(beforeFrames).some(row => row.method === 'session/prompt'), false, `${command} must not become a prompt`);
 }
 const beforeError = (await recorded()).length, beforeErrorItems = (await messages(session.id)).length;
 await send('/model bad-model');
 await waitFor(recorded, rows => rows.slice(beforeError).some(row => row.method === 'session/set_config_option'), 'failed option route');
 await waitFor(() => textSince(session.id, beforeErrorItems), value => /failed|unavailable/i.test(value), 'failed option feedback');
 assert.equal((await recorded()).slice(beforeError).some(row => row.method === 'session/prompt'), false, 'failed option must not fall through to prompt');
 await assertFailureRoute('/always-approve on', 'session/set_mode');
 const beforeCancelledUsageFrames = (await recorded()).length, beforeCancelledUsageItems = (await messages(session.id)).length;
 const cancelledUsage = await send('/usage');
 await waitFor(recorded, rows => {
  const current = rows.slice(beforeCancelledUsageFrames);
  return current.some(row => row.method === '_x.ai/session/usage') && current.some(row => row.method === '_x.ai/billing');
 }, 'cancelled usage starts both native queries');
 await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'running', 'cancelled usage running');
 await peer.request('chat.cancel', {sessionId:session.id, turnId:cancelledUsage.turnId, leaseEpoch});
 await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'idle', 'cancelled usage terminal idle');
 await delay(400);
 const lateUsage = await textSince(session.id, beforeCancelledUsageItems);
 assert.doesNotMatch(lateUsage, /SuperGrok|Grok usage|Weekly limit/, 'late cancelled callbacks must not append a usage card');
 assert.equal((await recorded()).slice(beforeCancelledUsageFrames).some(row => row.method === 'session/cancel'), false, 'local usage cancellation must not invoke native session/cancel');
 const beforePrompt = (await recorded()).length, beforePromptItems = (await messages(session.id)).length;
 await send('hello');
 await waitFor(recorded, rows => rows.slice(beforePrompt).some(row => row.method === 'session/prompt'), 'ordinary prompt');
 await waitFor(() => textSince(session.id, beforePromptItems), value => value.includes('ordinary prompt reply'), 'ordinary prompt assistant text');
 await waitFor(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'idle', 'ordinary prompt completion');
 console.log(JSON.stringify({passed:true, checks:['advertised slash routes','usage/status/compact ACP routes','safe local help/unsupported commands','option/mode routes and failed feedback','ordinary prompt regression'], root}));
} catch (error) {
 let failureSnapshot, failureItems;
 try { failureSnapshot = await peer?.request('runtime.snapshot'); failureItems = sessionId ? await messages(sessionId) : undefined; } catch {}
 console.error(JSON.stringify({passed:false, root, diagnostic, events:peer?.events.slice(-20), failureSnapshot, failureItems, error:error instanceof Error ? error.stack : String(error)}));
 throw error;
} finally {
 if (peer) { try { await peer.request('runtime.shutdown', {operationId:id()}); } catch {} peer.close(); }
 if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), delay(3000)]);
 if (daemon.exitCode === null) daemon.kill();
}
