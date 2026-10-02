import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession, createInputQueue, NOT_SIGNED_IN, signedOut } from '../src/session.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
];
const COMMANDS = [
  { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
  { name: 'clear', description: 'Start a new session' },
  { name: 'extra-usage', description: 'Renamed' },
  { name: 'usage-credits', description: 'Opens the browser' },
  { name: 'doctor', description: 'Terminal only' },
  { name: '__remote-workflow', description: 'Internal' },
  { name: 'tt-probe-skill', description: 'Project skill' },
  { name: 'color', description: 'Terminal UI' },
];

// A fake SDK whose message stream and control requests the test drives.
function controllableSdk({ init = {}, applied = { model: 'claude-sonnet-5', effort: 'high' }, getSettings = true } = {}) {
  const calls = [];
  const feed = createInputQueue();
  const state = { applied: { ...applied }, calls, feed, closed: false };
  const sdk = {
    state,
    query({ options }) {
      state.options = options;
      const query = {
        [Symbol.asyncIterator]: () => feed[Symbol.asyncIterator](),
        async initializationResult() {
          return { commands: COMMANDS, models: MODELS, account: { email: 'x', subscriptionType: 'pro', apiProvider: 'firstParty' }, current_permission_mode: 'acceptEdits', ...init };
        },
        async setModel(model) {
          calls.push(['setModel', model]);
          const row = MODELS.find(candidate => candidate.value === model);
          state.applied.model = row?.resolvedModel ?? model;
          state.applied.effort = row?.supportedEffortLevels ? state.applied.effort ?? 'high' : null;
        },
        async setPermissionMode(mode) { calls.push(['setPermissionMode', mode]); },
        async applyFlagSettings(settings) { calls.push(['applyFlagSettings', settings]); state.applied.effort = settings.effortLevel; },
        async getContextUsage(options) {
          calls.push(['getContextUsage', options?.detail]);
          if (options?.detail === 'full') return state.warmUp ?? { model: state.applied.model };
          return { model: state.applied.model };
        },
        async interrupt() {},
        close() { state.closed = true; feed.end(); },
        async return() { feed.end(); return { done: true }; },
      };
      if (getSettings) query.getSettings = async () => { calls.push(['getSettings']); return { applied: { ...state.applied } }; };
      return query;
    },
  };
  return sdk;
}

async function started(options = {}) {
  const events = [];
  const sdk = controllableSdk(options);
  const session = new ClaudeSession({ cardId: 'card-1', sdk, write: value => events.push(value) });
  await session.start({ cwd: 'C:/', sessionId: null });
  return { session, events, sdk, feed: sdk.state.feed };
}

const option = (ui, id) => ui.options.find(candidate => candidate.id === id);

test('signedOut only trusts an explicit first-party "none" account', () => {
  assert.equal(signedOut({ tokenSource: 'none', apiProvider: 'firstParty' }), true);
  assert.equal(signedOut({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }), false);
  assert.equal(signedOut({ email: 'x', subscriptionType: 'pro', apiProvider: 'firstParty' }), false);
  assert.equal(signedOut({ tokenSource: 'none', apiProvider: 'bedrock' }), false);
  assert.equal(signedOut({}), false, 'an unknown account shape is left to the CLI');
  assert.equal(signedOut(undefined), false);
});

test('a signed-out handshake fails start with the exact reason and closes the CLI', async () => {
  const sdk = controllableSdk({ init: { account: { tokenSource: 'none', apiProvider: 'firstParty' } } });
  const session = new ClaudeSession({ cardId: 'card-1', sdk, write() {} });
  await assert.rejects(session.start({ cwd: 'C:/', sessionId: null }), error => error.message === NOT_SIGNED_IN);
  assert.equal(sdk.state.closed, true);
  assert.equal(session.ended, true);
});

test('start publishes model, thinking and permission-mode options without a model turn', async () => {
  const { session, sdk } = await started();
  const ui = session.uiState();
  assert.deepEqual(ui.options.map(candidate => candidate.id), ['model', 'thinking', 'mode']);
  assert.equal(option(ui, 'model').value, 'default', 'the applied model maps to the Default row, not Sonnet');
  assert.deepEqual(option(ui, 'model').choices.map(choice => choice.value), ['default', 'sonnet', 'haiku']);
  assert.equal(option(ui, 'thinking').value, 'high');
  assert.equal(option(ui, 'mode').value, 'acceptEdits', 'the starting mode comes from the handshake');
  const modes = option(ui, 'mode').choices.map(choice => choice.value);
  assert.deepEqual(modes, ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);
  assert.ok(!modes.includes('bypassPermissions'), 'Bypass is never offered in Chat');
  assert.equal(sdk.state.options.allowDangerouslySkipPermissions, undefined);
  assert.ok(!sdk.state.calls.some(([name, detail]) => name === 'getContextUsage' && detail === 'summary'), 'getSettings answers when present');
});

test('the command menu hides commands that cannot work from Chat', async () => {
  const { session } = await started();
  assert.deepEqual(session.uiState().commands, [
    { name: 'compact', description: 'Free up context' },
    { name: 'tt-probe-skill', description: 'Project skill' },
  ]);
});

test('without getSettings the model falls back to context usage and thinking stays hidden', async () => {
  const { session, sdk } = await started({ getSettings: false, applied: { model: 'claude-haiku-4-5-20251001' } });
  const ui = session.uiState();
  assert.equal(option(ui, 'model').value, 'haiku');
  assert.equal(option(ui, 'thinking'), undefined);
  assert.deepEqual(option(ui, 'mode').choices.map(choice => choice.value), ['default', 'acceptEdits', 'plan', 'dontAsk'], 'Auto needs a model that supports it');
  assert.ok(sdk.state.calls.some(([name, detail]) => name === 'getContextUsage' && detail === 'summary'));
});

test('an unlisted applied model stays visible as its own choice', async () => {
  const { session } = await started({ applied: { model: 'claude-opus-5[1m]', effort: 'high' } });
  const model = option(session.uiState(), 'model');
  assert.equal(model.value, 'claude-opus-5[1m]');
  assert.ok(model.choices.some(choice => choice.value === 'claude-opus-5[1m]'));
});

test('setOption switches model, effort and mode through SDK control requests and publishes the state', async () => {
  const { session, sdk, events } = await started();
  let ui = await session.setOption('model', 'haiku');
  assert.deepEqual(sdk.state.calls.filter(([name]) => name === 'setModel'), [['setModel', 'haiku']]);
  assert.equal(option(ui, 'model').value, 'haiku');
  assert.equal(option(ui, 'thinking'), undefined, 'Haiku has no effort levels');
  ui = await session.setOption('model', 'sonnet');
  assert.equal(option(ui, 'thinking').value, 'high', 'effort returns with a model that supports it');
  ui = await session.setOption('thinking', 'low');
  assert.deepEqual(sdk.state.calls.find(([name]) => name === 'applyFlagSettings'), ['applyFlagSettings', { effortLevel: 'low' }]);
  assert.equal(option(ui, 'thinking').value, 'low');
  ui = await session.setOption('mode', 'plan');
  assert.deepEqual(sdk.state.calls.find(([name]) => name === 'setPermissionMode'), ['setPermissionMode', 'plan']);
  assert.equal(option(ui, 'mode').value, 'plan');
  assert.equal(events.filter(value => value.ev === 'session.ui').length, 4);
  assert.deepEqual(events.at(-1).ui, ui);
});

test('setOption rejects unknown options, unavailable values and Bypass without calling the SDK', async () => {
  const { session, sdk } = await started();
  const before = sdk.state.calls.length;
  await assert.rejects(session.setOption('mode', 'bypassPermissions'), /not an available/);
  await assert.rejects(session.setOption('model', 'gpt-5'), /not an available/);
  await assert.rejects(session.setOption('sandbox', 'x'), /unknown Claude option/);
  assert.equal(sdk.state.calls.length, before);
  await session.stop();
  await assert.rejects(session.setOption('mode', 'plan'), /ended/);
});

test('allow_always returns the SDK suggestions and follows a setMode suggestion', async () => {
  const { session, events } = await started();
  const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  await session.setOption('mode', 'default');
  const pending = session.requestPermission('Write', { file_path: 'a' }, { suggestions });
  const request = events.find(value => value.ev === 'session.request');
  assert.deepEqual(request.suggestions, suggestions);
  session.decide(request.requestId, 'allow_always');
  assert.deepEqual(await pending, { behavior: 'allow', updatedPermissions: suggestions });
  assert.equal(option(session.uiState(), 'mode').value, 'acceptEdits');
  assert.equal(events.at(-1).ev, 'session.ui');
});

test('allow_always without suggestions is refused and leaves the card answerable', async () => {
  const { session, events } = await started();
  const pending = session.requestPermission('PowerShell', { command: 'node -e 1' }, { suggestions: [] });
  const { requestId } = events.find(value => value.ev === 'session.request');
  assert.throws(() => session.decide(requestId, 'allow_always'), /no rule to remember/);
  assert.throws(() => session.decide(requestId, 'maybe'), /unsupported permission decision/);
  session.decide(requestId, 'allow');
  assert.deepEqual(await pending, { behavior: 'allow' });
});

test('native init, status and command updates refresh the published state', async () => {
  const { session, events, feed } = await started();
  await session.setOption('model', 'sonnet');
  session.send('hi', 'op-1');
  feed.push({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-sonnet-5', permissionMode: 'acceptEdits', terminal_slash_commands: ['tt-probe-skill'] });
  await delay(10);
  let ui = session.uiState();
  assert.equal(option(ui, 'model').value, 'sonnet', 'an alias resolving to the init model is kept');
  assert.deepEqual(ui.commands.map(command => command.name), ['compact'], 'terminal-only commands from init are hidden');
  feed.push({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-haiku-4-5-20251001', permissionMode: 'plan' });
  await delay(10);
  ui = session.uiState();
  assert.equal(option(ui, 'model').value, 'haiku', 'a typed /model is followed');
  assert.equal(option(ui, 'mode').value, 'plan');
  feed.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
  feed.push({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'compact', description: 'x' }, { name: 'new-skill', description: 'y' }] });
  await delay(10);
  ui = session.uiState();
  assert.equal(option(ui, 'mode').value, 'default');
  assert.deepEqual(ui.commands.map(command => command.name), ['compact', 'new-skill']);
  assert.ok(events.filter(value => value.ev === 'session.ui').length >= 4);
  await session.stop();
});

test('assistant messages report whether their text was streamed', async () => {
  const { session, events, feed } = await started();
  session.send('/context', 'op-1');
  feed.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_streamed' } } });
  feed.push({ type: 'assistant', message: { id: 'msg_streamed', content: [{ type: 'text', text: 'streamed' }] }, parent_tool_use_id: null });
  feed.push({ type: 'assistant', message: { id: 'local-1', content: [{ type: 'text', text: '## Context Usage' }] }, parent_tool_use_id: null });
  feed.push({ type: 'result', subtype: 'success', result: '## Context Usage' });
  await delay(20);
  const assistants = events.filter(value => value.ev === 'session.event' && value.message.type === 'assistant');
  assert.deepEqual(assistants.map(value => value.streamed), [true, false]);
  assert.equal(events.filter(value => value.ev === 'session.event' && value.message.type !== 'assistant').some(value => 'streamed' in value), false);
  assert.equal(session.streamedIds.size, 0, 'streamed ids are per turn');
  await session.stop();
});

test('an effort change typed as /effort is picked up after the turn', async () => {
  const { session, events, feed, sdk } = await started();
  session.send('/effort low', 'op-1');
  sdk.state.applied.effort = 'low';
  feed.push({ type: 'result', subtype: 'success', result: 'Set effort level to low' });
  await delay(20);
  assert.equal(option(session.uiState(), 'thinking').value, 'low');
  assert.equal(events.at(-1).ev, 'session.ui');
  await session.stop();
});

test('each turn reports how it ended: completed, interrupted by the user, or failed', async () => {
  const { session, events, feed } = await started();
  const idle = () => events.filter(value => value.ev === 'session.status' && value.phase === 'idle').map(value => [value.operationId, value.status]);
  session.send('one', 'op-1');
  feed.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  await delay(10);
  session.send('two', 'op-2');
  await session.interrupt();
  feed.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
  await delay(10);
  session.send('three', 'op-3');
  feed.push({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529' });
  await delay(10);
  session.send('four', 'op-4');
  feed.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  await delay(10);
  assert.deepEqual(idle(), [['op-1', 'completed'], ['op-2', 'interrupted'], ['op-3', 'failed'], ['op-4', 'completed']]);
  await session.stop();
});

test('start warms the API connection in the background with a token count, never waiting for it', async () => {
  const sdk = controllableSdk();
  sdk.state.warmUp = new Promise(() => {}); // a warm-up that never finishes must not delay start
  const session = new ClaudeSession({ cardId: 'card-1', sdk, write() {} });
  const sessionId = await Promise.race([session.start({ cwd: 'C:/', sessionId: null }), delay(500).then(() => 'blocked')]);
  assert.notEqual(sessionId, 'blocked');
  assert.deepEqual(sdk.state.calls.filter(([name]) => name === 'getContextUsage'), [['getContextUsage', 'full']]);
  await session.stop();

  const failing = controllableSdk();
  failing.state.warmUp = Promise.reject(new Error('count_tokens unavailable'));
  failing.state.warmUp.catch(() => {});
  const second = new ClaudeSession({ cardId: 'card-2', sdk: failing, write() {} });
  await second.start({ cwd: 'C:/', sessionId: null });
  assert.equal(await second.warmUpDone, false, 'a failed warm-up is ignored');
  await second.stop();

  const disabled = controllableSdk();
  const third = new ClaudeSession({ cardId: 'card-3', sdk: disabled, write() {}, hostOptions: { warmUp: false } });
  await third.start({ cwd: 'C:/', sessionId: null });
  assert.ok(!disabled.state.calls.some(([name]) => name === 'getContextUsage'));
  await third.stop();

  const signedOutSdk = controllableSdk({ init: { account: { tokenSource: 'none', apiProvider: 'firstParty' } } });
  await assert.rejects(new ClaudeSession({ cardId: 'card-4', sdk: signedOutSdk, write() {} }).start({ cwd: 'C:/', sessionId: null }));
  assert.ok(!signedOutSdk.state.calls.some(([name]) => name === 'getContextUsage'), 'no warm-up after a failed start');
});

const settledWithin = (promise, ms) => Promise.race([promise.then(() => 'settled'), delay(ms).then(() => 'pending')]);

test('ThreadTerm delegation tools reach the SDK and only their exact names are approved, only when injected', async () => {
  const servers = { threadterm: { type: 'stdio', command: 'C:/rt/threadterm-v3-mcp.exe', args: [], env: { THREADTERM_SESSION_ID: 's-1' } } };
  const sdk = controllableSdk();
  const session = new ClaudeSession({ cardId: 'card-tools', sdk, write() {} });
  await session.start({ cwd: 'C:/', sessionId: null, mcpServers: servers });
  assert.deepEqual(sdk.state.options.mcpServers, servers);
  assert.deepEqual(
    await session.requestPermission('mcp__threadterm__delegate_start', { agent: 'codex' }),
    { behavior: 'allow', updatedInput: { agent: 'codex' } },
  );
  assert.equal(await settledWithin(session.requestPermission('mcp__threadterm__terminal_create', {}, {}), 50), 'pending', 'other tools still ask the user');
  assert.equal(await settledWithin(session.requestPermission('Bash', { command: 'mcp__threadterm__delegate_start' }, {}), 50), 'pending');
  await session.stop();

  const plainSdk = controllableSdk();
  const plain = new ClaudeSession({ cardId: 'card-plain', sdk: plainSdk, write() {} });
  await plain.start({ cwd: 'C:/', sessionId: null });
  assert.equal('mcpServers' in plainSdk.state.options, false);
  assert.equal(await settledWithin(plain.requestPermission('mcp__threadterm__delegate_start', {}, {}), 50), 'pending', 'without injection the user decides');
  await plain.stop();
});
