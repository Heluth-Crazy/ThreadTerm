// QA-only Pi RPC for D4. prompt starts a turn and does not settle it. steer
// returns handled, or "no active turn" when the message is reject-me.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

if (process.argv.includes('--version') && !process.argv.includes('--mode')) {
  console.log('1.1.0');
  process.exit(0);
}
const log = process.env.THREADTERM_QA_STEER_PI_LOG;
if (!log) process.exit(2);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = value => appendFileSync(log, `${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  record({ type: request.type, message: request.message, images: request.images });
  const id = request.id;
  switch (request.type) {
    case 'get_state':
      return out({ id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-pi-steer', model: { id: 'fake-model', name: 'Fake', provider: 'fake' }, thinkingLevel: 'off', isStreaming: false } });
    case 'get_available_models':
      return out({ id, type: 'response', command: 'get_available_models', success: true, data: { models: [{ id: 'fake-model', name: 'Fake', provider: 'fake' }] } });
    case 'get_available_thinking_levels':
      return out({ id, type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: ['off', 'high'] } });
    case 'get_commands':
      return out({ id, type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'demo', description: 'Demo' }] } });
    case 'prompt':
      out({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working' } });
      return;
    case 'steer':
      if (request.message === 'reject-me') return out({ id, type: 'response', command: 'steer', success: false, error: 'no active turn' });
      return out({ id, type: 'response', command: 'steer', success: true, data: { disposition: request.message === 'queue-me' ? 'queued' : 'handled' } });
    case 'abort':
      return out({ id, type: 'response', command: 'abort', success: true });
    default:
      return out({ id, type: 'response', command: request.type, success: false, error: 'unknown command' });
  }
});
