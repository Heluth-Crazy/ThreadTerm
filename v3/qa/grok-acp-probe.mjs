// One-shot ACP probe: log grok agent stdio traffic for a tiny prompt.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = await mkdtemp(join(tmpdir(), 'grok-acp-probe-'));
const child = spawn('grok', ['agent', '--no-leader', 'stdio'], {
  cwd,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 0;
const pending = new Map();
const events = [];
const send = (method, params, withId = true) => {
  const id = withId ? ++nextId : undefined;
  const frame = withId
    ? { jsonrpc: '2.0', id, method, params }
    : { jsonrpc: '2.0', method, params };
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  if (withId) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 20_000);
    });
  }
};
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = { raw: line }; }
    const summary = {
      id: parsed.id,
      method: parsed.method,
      hasResult: parsed.result !== undefined,
      error: parsed.error,
      sessionUpdate: parsed.params?.update?.sessionUpdate ?? parsed.params?.sessionUpdate,
      paramKeys: parsed.params && typeof parsed.params === 'object' ? Object.keys(parsed.params) : [],
      updateKeys: parsed.params?.update && typeof parsed.params.update === 'object' ? Object.keys(parsed.params.update) : [],
      text: String(parsed.params?.update?.content?.text ?? parsed.params?.update?.text ?? parsed.result?.sessionId ?? '').slice(0, 120),
    };
    events.push(summary);
    console.log(JSON.stringify(summary));
    if (parsed.id != null && pending.has(parsed.id)) {
      const waiter = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(JSON.stringify(parsed.error)));
      else waiter.resolve(parsed.result);
      continue;
    }
    if (parsed.id != null && parsed.method && parsed.result === undefined && parsed.error === undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} })}\n`);
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
try {
  const initialized = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'threadterm-probe', title: 'ThreadTerm probe', version: '0' },
  });
  console.log('initialized', JSON.stringify(initialized)?.slice(0, 800));
  send('initialized', {}, false);
  const session = await send('session/new', { cwd, mcpServers: [] });
  console.log('session', JSON.stringify(session)?.slice(0, 800));
  const sessionId = session?.sessionId;
  if (!sessionId) throw new Error('no sessionId');
  const promptId = ++nextId;
  const promptPromise = new Promise((resolve, reject) => {
    pending.set(promptId, { resolve, reject, method: 'session/prompt' });
    setTimeout(() => {
      if (pending.delete(promptId)) reject(new Error('timeout session/prompt'));
    }, 20_000);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: promptId,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'Reply with the single word OK.' }] },
  })}\n`);
  const promptResult = await promptPromise;
  console.log('promptResult', JSON.stringify(promptResult)?.slice(0, 800));
} catch (error) {
  console.error('PROBE_ERROR', error instanceof Error ? error.message : error);
} finally {
  child.kill();
  console.error(JSON.stringify({
    cwd,
    eventCount: events.length,
    methods: events.map((row) => row.method || (row.hasResult ? 'result' : 'other')),
  }, null, 2));
}
