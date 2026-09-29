// QA-only ACP agent for Kimi/Gemini settings. It has no model backend.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

if (process.argv.includes('--version')) {
  if (process.env.THREADTERM_QA_ACP_VERSION_FAIL === '1') process.exit(7);
  console.log('qa-acp-settings 1.0');
  process.exit(0);
}
const log = process.env.THREADTERM_QA_ACP_SETTINGS_LOG;
const scenario = process.env.THREADTERM_QA_ACP_SETTINGS_SCENARIO ?? 'default';
if (!log) process.exit(2);
const sessionId = 'qa-acp-settings-session';
let model = 'old-model';
let thinking = 'low';
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const response = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const failure = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const option = (configId, currentValue) => ({ configId, name: configId, currentValue, options: [] });
const options = () => [option('model', model), option('thinking', thinking)];
const update = (configOptions) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_options_update', configOptions } } })}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return response(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (method === 'session/new' || method === 'session/load') return response(id, { sessionId, configOptions: options() });
  if (method === 'session/set_config_option') {
    const { configId, value } = params;
    if (configId === 'thinking' && (value === 'high' || value === 'reject')) return failure(id, -32602, 'thinking rejected by QA agent');
    if (configId === 'model' && (scenario === 'method-missing' || value === 'legacy-model')) return failure(id, -32601, 'method unavailable');
    if (configId === 'model' && value === 'bad-model') return failure(id, -32602, 'invalid model');
    if (configId === 'model' && value === 'auth-error') return failure(id, -32001, 'authentication failed');
    if (configId === 'model' && value === 'timeout') return;
    if (configId === 'model' && value === 'disconnect') process.exit(0);
    if (configId === 'thinking' && value === 'late-response') {
      thinking = 'ultra';
      update(options());
      return setTimeout(() => response(id, { configOptions: [option('model', model), option('thinking', 'stale')] }), 20);
    }
    if (configId === 'model') model = String(value).toUpperCase();
    if (configId === 'thinking') thinking = value;
    return response(id, { configOptions: options() });
  }
  if (method === 'session/set_model') {
    model = params.modelId;
    return response(id, { configOptions: options() });
  }
  return failure(id, -32601, `unexpected QA method: ${method}`);
});
