import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {connectPeer} from './pipe-client.mjs';
import {removeScratch, stopChild, waitForChildExit} from './lib/qa-cleanup.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-mcp-smoke-'));
const data = join(scratch, 'data');
const project = join(scratch, 'project');
await Promise.all([mkdir(data), mkdir(project)]);
const pipe = `\\\\.\\pipe\\threadterm-v3-mcp-smoke-${randomUUID()}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
env.THREADTERM_V3_DATA = data; env.THREADTERM_V3_PIPE = pipe;
const qaRuntime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const qaMcp = join(root, 'runtime/target-qa/debug/threadterm-v3-mcp.exe');
const runtimeExe = process.env.THREADTERM_QA_RUNTIME_EXE || process.env.THREADTERM_QA_E1_RUNTIME_EXE || process.env.THREADTERM_V3_RUNTIME_BIN || (existsSync(qaRuntime) ? qaRuntime : join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const mcpExe = process.env.THREADTERM_QA_E1_HOST_EXE || process.env.THREADTERM_QA_MCP_EXE || (existsSync(qaMcp) ? qaMcp : join(root, 'runtime/target-qa/debug/threadterm-v3-mcp.exe'));
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
const children = new Set();
let daemon;
let peer;
let diagnostics = '';
let runtimeLaunchFailure;

function launch(file, args, options = {}) {
  const child = spawn(file, args, {windowsHide: true, ...options});
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', error => {
    if (child === daemon) runtimeLaunchFailure = error;
    if (child.pid === undefined) children.delete(child);
  });
  return child;
}
async function shutdownRuntime() {
  if (!daemon || daemon.pid === undefined || daemon.exitCode !== null || daemon.signalCode !== null) return;
  if (!peer) return stopChild(daemon, {label: 'runtime'});
  // Register the listener before the RPC: runtime.shutdown can acknowledge
  // after the process has already exited on a fast local machine.
  const exitWait = waitForChildExit(daemon, {label: 'runtime shutdown'});
  const [shutdown, exit] = await Promise.allSettled([
    peer.request('runtime.shutdown', {operationId: randomUUID()}),
    exitWait,
  ]);
  if (exit.status === 'rejected') {
    const exitError = exit.reason;
    try { await stopChild(daemon, {label: 'runtime'}); }
    catch (stopError) { stopError.cause = exitError; throw stopError; }
    if (shutdown.status === 'rejected') exitError.cause = shutdown.reason;
    throw exitError;
  }
  if (shutdown.status === 'rejected') throw shutdown.reason;
}
function mcpRequest(lines, extraEnv = {}) {
  return new Promise((resolveRequest, reject) => {
    const child = launch(mcpExe, [], {env: {...env, ...extraEnv}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', dataChunk => { stdout += dataChunk; });
    child.stderr.on('data', dataChunk => { stderr += dataChunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) return reject(new Error(`MCP exited ${code}: ${stderr}`));
      try { resolveRequest(stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); }
      catch (error) { reject(error); }
    });
    child.stdin.end(`${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  });
}
function baseRequests() {
  return [
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'mcp-smoke', version: '1'}}},
    {jsonrpc: '2.0', method: 'notifications/initialized'},
  ];
}
function response(rows, id) { return rows.find(row => row.id === id)?.result; }
async function chatCatalog(flags) {
  const rows = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 91, method: 'tools/list', params: {}}], {
    THREADTERM_MCP_PROFILE: 'chat-tools', THREADTERM_CHAT_SESSION_ID: 'qa-session', THREADTERM_CHAT_TOKEN: 'qa-token',
    THREADTERM_CHAT_TOOL_ASK: flags.ask ? '1' : '0', THREADTERM_CHAT_TOOL_SESSION_INFO: flags.sessionInfo ? '1' : '0', THREADTERM_CHAT_TOOL_FEEDBACK: flags.feedback ? '1' : '0',
  });
  return response(rows, 91).tools.map(tool => tool.name).sort();
}
async function waitForRuntime() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtimeLaunchFailure) throw runtimeLaunchFailure;
    try {
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      const candidate = await connectPeer(`${pipe}-control`);
      await candidate.auth(credential);
      return candidate;
    } catch (error) {
      if (daemon.exitCode !== null) throw new Error(`runtime exited ${daemon.exitCode}: ${diagnostics}`);
      await delay(100);
    }
  }
  throw new Error('runtime did not become available');
}

let primaryFailure;
let passed;
try {
  daemon = launch(runtimeExe, [], {env, stdio: ['ignore', 'ignore', 'pipe']});
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', chunk => { diagnostics += chunk; });
  peer = await waitForRuntime();

  // E1 host profile: availability is fixed for a newly connected chat by the
  // three explicit env switches.  This is intentionally a host-only check:
  // it does not create a provider process or a live agent.
  const fullCatalog = await chatCatalog({ask:true, sessionInfo:true, feedback:true});
  assert.deepEqual(fullCatalog, ['ask_user', 'feedback_check', 'session_info']);
  assert.deepEqual(await chatCatalog({ask:false, sessionInfo:true, feedback:true}), ['feedback_check', 'session_info']);
  assert.deepEqual(await chatCatalog({ask:true, sessionInfo:false, feedback:false}), ['ask_user']);
  const forged = await mcpRequest([...baseRequests(), {jsonrpc:'2.0',id:92,method:'tools/call',params:{name:'ask_user',arguments:{callerSessionId:'foreign',callerToken:'foreign',questions:[{question:'x',options:[{label:'a'},{label:'b'}]}]}}}], {
    THREADTERM_MCP_PROFILE:'chat-tools', THREADTERM_CHAT_SESSION_ID:'qa-session', THREADTERM_CHAT_TOKEN:'qa-token', THREADTERM_CHAT_TOOL_ASK:'1', THREADTERM_CHAT_TOOL_SESSION_INFO:'0', THREADTERM_CHAT_TOOL_FEEDBACK:'0',
  });
  assert.equal(response(forged, 92).isError, true, 'caller identity passed in tool arguments is rejected');

  const requestId = `mcp-smoke-${randomUUID()}`;
  const create = {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'terminal_create', arguments: {
    request_id: requestId,
    launch: {executable: 'cmd.exe', args: ['/Q', '/K', 'echo MCP_SMOKE_OUTPUT'], cwd: project},
    placement: 'workspace', presentation: 'background',
  }}};
  const first = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}, create]);
  assert.equal(response(first, 1).protocolVersion, '2025-06-18');
  assert.equal(response(first, 2).tools.length, 6);
  const created = response(first, 3).structuredContent.terminal;
  assert.ok(created.id, 'terminal_create returned an id');

  const repeated = await mcpRequest([...baseRequests(), {...create, id: 4}]);
  assert.equal(response(repeated, 4).structuredContent.terminal.id, created.id, 'stable request_id is idempotent');

  let read;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'terminal_get', arguments: {request_id: requestId, cursor: 0, limit: 65536}}}]);
    read = response(rows, 5).structuredContent;
    if (Buffer.from(read.output.data, 'base64').toString('utf8').includes('MCP_SMOKE_OUTPUT')) break;
    await delay(100);
  }
  assert.ok(Buffer.from(read.output.data, 'base64').toString('utf8').includes('MCP_SMOKE_OUTPUT'), 'terminal_get returned actual PTY output');

  const listed = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'terminal_list', arguments: {state: 'running'}}}]);
  assert.ok(response(listed, 6).structuredContent.terminals.some(terminal => terminal.id === created.id), 'terminal_list includes created terminal');
  const presented = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'terminal_present', arguments: {handle: created.id, placement: 'workspace', presentation: 'background', workspace_path: project}}}]);
  assert.equal(response(presented, 7).structuredContent.queued, true, 'terminal_present queues desktop coordination');
  const closed = await mcpRequest([...baseRequests(), {jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'terminal_close', arguments: {handle: created.id}}}]);
  assert.equal(response(closed, 8).structuredContent.closed, true);

  passed = {passed: true, checks: ['MCP chat-tools catalog follows ask/session-info/feedback switches', 'MCP chat-tools rejects forged caller identity', 'MCP initialize/tools list', 'create idempotency', 'list', 'durable lookup/read actual PTY output', 'queued present', 'close', 'graceful runtime shutdown']};
} catch (error) {
  primaryFailure = error;
  console.error(`MCP smoke original failure: ${error.stack || error}`);
}

let cleanupFailure;
async function cleanup(step) {
  try { await step(); }
  catch (error) { cleanupFailure ??= error; }
}
await cleanup(shutdownRuntime);
await cleanup(() => peer?.close());
for (const child of [...children]) await cleanup(() => stopChild(child, {label: 'MCP helper'}));
await cleanup(() => removeScratch(scratch));
if (primaryFailure) {
  if (cleanupFailure) console.error(`MCP smoke cleanup failure (original test failure preserved): ${cleanupFailure.stack || cleanupFailure}`);
  throw primaryFailure;
}
if (cleanupFailure) throw cleanupFailure;
if (passed) {
  console.log(JSON.stringify(passed));
}
