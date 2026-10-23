// Isolated permission-recovery fixture. It never starts Codex or an ACP agent.
// Invoke normally for the Codex app-server protocol, or with --qa-acp for the
// generic ACP reset path. Every JSON-RPC request is recorded for the visual QA.
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

const log = process.env.TT_QA_PERMISSION_LOG;
const cwd = process.env.TT_QA_PERMISSION_CWD;
const control = process.env.TT_QA_PERMISSION_CONTROL;
if (!log || !cwd) process.exit(2);

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log('codex-cli 0.999.0-qa-permission-restore');
  process.exit(0);
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in as QA fixture');
  process.exit(0);
}

const isAcp = process.argv.includes('--qa-acp');
const record = (direction, method, params) => {
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), pid: process.pid, protocol: isAcp ? 'acp' : 'codex', direction, method, params })}\n`);
};
const send = value => {
  record('out', value.method ?? 'response', value.params ?? value);
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const result = (id, value) => send(isAcp ? { jsonrpc: '2.0', id, result: value } : { id, result: value });
const failure = (id, code, message) => send(isAcp ? { jsonrpc: '2.0', id, error: { code, message } } : { id, error: { code, message } });

function controlEnabled(name) {
  return Boolean(control && existsSync(`${control}\\${name}`));
}

if (isAcp) {
  const nativeId = process.env.TT_QA_PERMISSION_ACP_NATIVE_ID || 'qa-permission-acp-reset';
  let mode = 'default';
  const options = () => [
    {
      configId: 'current-permissions',
      name: 'Permission mode',
      category: 'mode',
      currentValue: mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      configId: 'unrelated',
      name: 'Unrelated setting',
      currentValue: 'keep',
      options: [{ value: 'keep', name: 'Keep' }],
    },
  ];
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    const { id, method, params = {} } = request;
    record('in', method, params);
    if (id === undefined) return;
    if (method === 'initialize') {
      return result(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { load: {} } }, configOptions: options() });
    }
    if (method === 'initialized') return result(id, {});
    if (method === 'session/new' || method === 'session/load') {
      return result(id, { sessionId: params.sessionId || nativeId, configOptions: options() });
    }
    if (method === 'session/set_config_option') {
      if (params.configId === 'vanished-permissions') {
        return failure(id, -32602, 'QA fixture: permission option no longer exists');
      }
      if (params.configId !== 'current-permissions' || !['default', 'plan'].includes(params.value)) {
        return failure(id, -32602, 'QA fixture: invalid config option');
      }
      mode = params.value;
      return result(id, { configOptions: options() });
    }
    if (method === 'session/prompt' || method === 'session/cancel') return result(id, {});
    return failure(id, -32601, `Unexpected QA ACP request: ${method}`);
  });
} else {
  if (!process.argv.includes('app-server')) process.exit(2);
  let nativeId = process.env.TT_QA_PERMISSION_NATIVE_ID || `qa-permission-restore-${randomUUID()}`;
  let turn = 0;
  const sandboxType = value => ({
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  })[value] || 'readOnly';
  const mismatch = (id, params) => params.sandbox === 'danger-full-access'
    && (id.includes('mismatch') || controlEnabled('sandbox-mismatch'));
  const thread = (id, approvalPolicy = 'on-request', sandbox = 'read-only') => ({
    id,
    cwd,
    source: 'user',
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    approvalPolicy,
    sandboxPolicy: { type: sandboxType(sandbox), networkAccess: false },
    status: { type: 'idle' },
    // A real transcript seed keeps the runtime's history-freshness guard from
    // replacing the test's explicitly seeded native identity.
    turns: [{ id: `${id}-seed`, items: [] }],
  });
  const response = (id, params = {}) => {
    const approvalPolicy = params.approvalPolicy || 'on-request';
    const requestedSandbox = params.sandbox || 'read-only';
    const sandbox = mismatch(id, params) ? 'read-only' : requestedSandbox;
    const current = thread(id, approvalPolicy, sandbox);
    return {
      thread: current,
      threadSettings: {
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        approvalPolicy,
        sandboxPolicy: current.sandboxPolicy,
      },
      approvalPolicy,
      sandboxPolicy: current.sandboxPolicy,
    };
  };
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    const { id, method, params = {} } = request;
    record('in', method, params);
    if (id === undefined) return;
    if (method === 'initialize') return result(id, { capabilities: {} });
    if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
    if (method === 'account/rateLimits/read') return result(id, {});
    if (method === 'thread/read') {
      const idToRead = params.threadId || nativeId;
      return result(id, { thread: thread(idToRead) });
    }
    if (method === 'thread/start') {
      nativeId = process.env.TT_QA_PERMISSION_NATIVE_ID || `qa-permission-restore-${randomUUID()}`;
      return result(id, response(nativeId, params));
    }
    if (method === 'thread/resume') {
      nativeId = params.threadId || nativeId;
      return result(id, response(nativeId, params));
    }
    if (method === 'thread/inject_items') return result(id, {});
    if (method === 'model/list') {
      return result(id, { data: [{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna (QA)', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
    }
    if (method === 'skills/list') return result(id, { data: [] });
    if (method === 'thread/settings/update') {
      const settings = { ...params };
      delete settings.threadId;
      return result(id, { threadSettings: settings });
    }
    if (method === 'turn/start') {
      const turnId = `qa-permission-turn-${++turn}`;
      const itemId = `${turnId}-answer`;
      send({ method: 'turn/started', params: { threadId: nativeId, turn: { id: turnId } } });
      result(id, { turn: { id: turnId } });
      send({ method: 'item/started', params: { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage' } } });
      send({ method: 'item/completed', params: { threadId: nativeId, turnId, item: { id: itemId, type: 'agentMessage', text: 'QA permission fixture answer' } } });
      return send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: turnId, status: 'completed' } } });
    }
    if (method === 'turn/interrupt') return result(id, {});
    return failure(id, -32601, `Unexpected QA Codex request: ${method}`);
  });
}
