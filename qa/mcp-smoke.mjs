import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {connectPeer} from './pipe-client.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-mcp-smoke-'));
const data = join(scratch, 'data');
const project = join(scratch, 'project');
await Promise.all([mkdir(data), mkdir(project)]);
const pipe = `\\\\.\\pipe\\threadterm-v3-mcp-smoke-${randomUUID()}`;
const env = {...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe};
const runtimeExe = join(root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const mcpExe = join(root, 'runtime/target/debug/threadterm-v3-mcp.exe');
const children = new Set();
let daemon;
let peer;
let diagnostics = '';

function launch(file, args, options = {}) {
  const child = spawn(file, args, {windowsHide: true, ...options});
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function mcpRequest(lines) {
  return new Promise((resolveRequest, reject) => {
    const child = launch(mcpExe, [], {env, stdio: ['pipe', 'pipe', 'pipe']});
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
async function waitForRuntime() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

try {
  daemon = launch(runtimeExe, [], {env, stdio: ['ignore', 'ignore', 'pipe']});
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', chunk => { diagnostics += chunk; });
  peer = await waitForRuntime();

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

  await peer.request('runtime.shutdown', {operationId: randomUUID()});
  await new Promise((resolveExit, reject) => { const timer = setTimeout(() => reject(new Error('runtime shutdown timed out')), 10_000); daemon.once('exit', () => { clearTimeout(timer); resolveExit(); }); });
  console.log(JSON.stringify({passed: true, checks: ['MCP initialize/tools list', 'create idempotency', 'list', 'durable lookup/read actual PTY output', 'queued present', 'close', 'graceful runtime shutdown']}));
} finally {
  peer?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
  await rm(scratch, {recursive: true, force: true});
}
