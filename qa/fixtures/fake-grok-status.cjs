// QA-only Grok ACP peer. It has no account, network, or model access.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const log = process.env.THREADTERM_QA_GROK_STATUS_LOG;
if (!log) process.exit(2);
if (process.argv.includes('--version')) {
  console.log('grok qa-status-fixture');
  process.exit(0);
}

const nativeId = 'qa-grok-status-session';
let heldPrompt;
let infoRequests = 0;
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
const error = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: {}, load: {} } },
    configOptions: [],
  });
  if (method === 'session/new') return result(id, { sessionId: nativeId });
  if (method === 'session/list') return result(id, { sessions: [] });
  if (method === '_x.ai/session/info') {
    infoRequests += 1;
    if (infoRequests >= 3) return error(id, 'QA status unavailable');
    return result(id, {
      result: { cwd: process.env.THREADTERM_QA_GROK_STATUS_CWD, agentName: 'Grok QA', model: 'grok-qa', context: { used: 12, total: 128, usagePct: 9 } },
    });
  }
  if (method === 'session/prompt') {
    heldPrompt = id;
    event('session/update', { sessionId: nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QA held turn' } } });
    return;
  }
  if (method === 'session/cancel') {
    if (heldPrompt !== undefined) {
      result(heldPrompt, { stopReason: 'cancelled' });
      heldPrompt = undefined;
    }
    return;
  }
  if (id !== undefined) result(id, {});
});
