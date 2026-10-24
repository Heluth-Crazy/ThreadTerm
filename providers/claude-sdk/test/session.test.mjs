import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { ClaudeSession } from '../src/session.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeSdk({ initDelay = 0, initError = null, hangInit = false } = {}) {
  const state = { queries: 0 };
  return {
    state,
    query({ options }) {
      state.queries += 1;
      let releaseIterator;
      const query = {
        options,
        closed: false,
        async *[Symbol.asyncIterator]() { await new Promise(resolve => { releaseIterator = resolve; }); },
        async initializationResult() {
          if (hangInit) return new Promise(() => {});
          if (initDelay) await delay(initDelay);
          if (initError) throw initError;
          return { commands: [], agents: [], models: [], account: {}, output_style: 'default' };
        },
        async interrupt() {},
        close() { this.closed = true; releaseIterator?.(); },
        async return() { releaseIterator?.(); return { done: true }; },
      };
      return query;
    },
  };
}

function harness(options = {}) {
  const events = [];
  const sdk = fakeSdk(options);
  const session = new ClaudeSession({
    cardId: 'card-1',
    sdk,
    write: value => events.push(value),
    hostOptions: options.hostOptions ?? {},
  });
  return { session, events, sdk };
}

const within = async (ms, promise, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label}`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
};

test('unproven managed eval is denied before native approval publication without changing model arguments',async()=>{
 for(const browserTools of [false,true]){
  const {session,events}=harness();session.threadTermBrowserTools=browserTools;
  const input={tabId:'public-tab',code:'PRIVATE CODE',result:'PRIVATE'},before=structuredClone(input);
  const result=await session.requestPermission('mcp__threadterm__browser_eval',input,{suggestions:[{type:'addRules',rules:['PRIVATE']}]});
  assert.deepEqual(result,{behavior:'deny',message:'browser_eval_unavailable'});assert.deepEqual(input,before);
  assert.equal(session.pending.size,0);assert.equal(events.some(value=>value.ev==='session.request'),false);assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
  for(const name of ['mcp__foreign__browser_eval','mcp__threadterm__browser_eval_extra','mcp__threadterm__browser_eval ']){
   const pending=session.requestPermission(name,{code:'ordinary foreign code'}),request=events.findLast(value=>value.ev==='session.request');
   assert.equal(request.toolName,name);assert.deepEqual(request.input,{code:'ordinary foreign code'});
   session.decide(request.requestId,'deny');assert.equal((await pending).behavior,'deny');
  }
  await session.stop();
 }
});

test('a pre-cancelled permission request resolves deny immediately without publishing a card', async () => {
  const { session, events } = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await within(200, session.requestPermission('Bash', {}, { signal: controller.signal }), 'pre-cancelled requestPermission must settle');
  assert.equal(result.behavior, 'deny');
  assert.equal(session.pending.size, 0, 'settled request must leave no pending entry');
  assert.equal(events.filter(e => e.ev === 'session.request').length, 0, 'a cancelled request must not publish a clickable card');
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 0, 'an unpublished request must not fabricate a completion notice');
});

test('a subagent permission request preserves the SDK agent and tool identities', async () => {
  const { session, events } = harness();
  const pending = session.requestPermission('Bash', { command: 'pwd' }, {
    agentID: 'agent-7',
    toolUseID: 'tool-9',
  });
  const request = events.find(event => event.ev === 'session.request');
  assert.equal(request.agentId, 'agent-7');
  assert.equal(request.toolUseId, 'tool-9');
  session.decide(request.requestId, 'allow');
  assert.deepEqual(await within(200, pending, 'subagent permission request must settle'), { behavior: 'allow' });
});

test('AskUserQuestion publishes a question and answers by question text', async () => {
  const { session, events } = harness();
  const input = { questions: [
    { header: 'Colour', question: 'Which colour?', options: [{ label: 'Blue' }] },
    { header: 'Tools', question: 'Which tools?', options: [{ label: 'Read' }, { label: 'Write' }], multiSelect: true },
  ] };
  const pending = session.requestPermission('AskUserQuestion', input, { agentID: 'agent-7', toolUseID: 'tool-9' });
  const request = events.find(event => event.ev === 'session.request');
  assert.deepEqual(request.question, { questions: input.questions });
  assert.equal(request.input, undefined);
  assert.equal(request.agentId, 'agent-7');
  session.answer(request.requestId, { q0: ['Blue'], q1: ['Read', 'Write'] });
  assert.deepEqual(await within(200, pending, 'question answer must settle'), {
    behavior: 'allow', updatedInput: { ...input, answers: { 'Which colour?': 'Blue', 'Which tools?': 'Read, Write' } },
  });
});

test('AskUserQuestion dismissal denies the SDK request', async () => {
  const { session, events } = harness();
  const pending = session.requestPermission('AskUserQuestion', { questions: [{ header: 'Colour', question: 'Which colour?', options: [] }] });
  const request = events.find(event => event.ev === 'session.request');
  session.answer(request.requestId, null);
  assert.deepEqual(await within(200, pending, 'dismissed question must settle'), {
    behavior: 'deny', message: 'The user dismissed the question.',
  });
  assert.throws(() => session.answer(request.requestId, { q0: ['Blue'] }), /unknown or expired question request/);
});

test('cancelling a published request resolves deny once and reports the original request and turn', async () => {
  const { session, events } = harness();
  session.send('hello', 'op-7');
  const controller = new AbortController();
  const pending = session.requestPermission('Bash', {}, { signal: controller.signal });
  await delay(10);
  const published = events.find(e => e.ev === 'session.request');
  assert.ok(published, 'request must be published before cancellation');
  controller.abort();
  const result = await within(200, pending, 'cancelled requestPermission must settle');
  assert.equal(result.behavior, 'deny');
  const cancelled = events.filter(e => e.ev === 'session.request_cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].requestId, published.requestId);
  assert.equal(cancelled[0].operationId, 'op-7', 'cancellation must carry the owning turn');
  assert.equal(session.pending.size, 0);
  await assert.rejects(() => Promise.resolve().then(() => session.decide(published.requestId, 'allow')), /unknown or expired/);
});

test('a user decision settles once; a late cancel emits nothing', async () => {
  const { session, events } = harness();
  const controller = new AbortController();
  const pending = session.requestPermission('Read', {}, { signal: controller.signal });
  await delay(10);
  const requestId = events.find(e => e.ev === 'session.request').requestId;
  session.decide(requestId, 'allow');
  assert.deepEqual(await within(200, pending, 'decided request must settle'), { behavior: 'allow' });
  controller.abort();
  await delay(20);
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 0);
  assert.equal(session.pending.size, 0);
});

test('session close denies every pending permission with a cancellation notice', async () => {
  const { session, events } = harness();
  const first = session.requestPermission('Bash', {}, {});
  const second = session.requestPermission('Read', {}, {});
  await delay(10);
  await session.stop();
  assert.equal((await within(200, first, 'first pending settles on close')).behavior, 'deny');
  assert.equal((await within(200, second, 'second pending settles on close')).behavior, 'deny');
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 2);
  assert.equal(session.pending.size, 0);
});

test('session.start resolves only after the SDK initialization handshake', async () => {
  const { session, events } = harness({ initDelay: 400 });
  let resolved = false;
  const started = session.start({ cwd: 'C:/', sessionId: null }).then(value => { resolved = true; return value; });
  await delay(120);
  assert.equal(resolved, false, 'start must wait for the real handshake, not the query constructor');
  await within(3000, started, 'start resolves after the handshake');
  await session.stop();
  assert.ok(events.some(e => e.ev === 'session.status'), 'status events still flow');
});

test('session.start rejects with the real handshake error and closes the query', async () => {
  const { session } = harness({ initError: new Error('not authenticated') });
  await assert.rejects(session.start({ cwd: 'C:/', sessionId: null }), /not authenticated/);
  assert.equal(session.query.closed, true, 'a failed handshake must not leave a running CLI');
  assert.equal(session.ended, true, 'a failed handshake marks the session ended');
});

test('session.start times out instead of waiting forever', async () => {
  const { session } = harness({ hangInit: true, hostOptions: { handshakeTimeoutMs: 300 } });
  await assert.rejects(session.start({ cwd: 'C:/', sessionId: null }), /timed out/);
  assert.equal(session.query.closed, true);
  assert.equal(session.ended, true);
});

test('stopping during the handshake aborts start without reviving the session', async () => {
  const { session } = harness({ hangInit: true });
  const started = session.start({ cwd: 'C:/', sessionId: null });
  await delay(50);
  const stopped = session.stop();
  await assert.rejects(started, /stopped|closed/i);
  await stopped;
  await delay(20);
  assert.equal(session.ended, true);
  assert.equal(session.closed, true);
});

test('a query that dies before its delayed initialization reply cannot make start ready', async () => {
  const events = [];
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {},
        async initializationResult() { await delay(30); return { commands: [] }; },
        close() {},
      };
    },
  };
  const session = new ClaudeSession({ cardId: 'card-early-death', sdk, write: value => events.push(value) });
  await assert.rejects(within(200, session.start({ cwd: 'C:/', sessionId: null }), 'early query death must fail start'), /ended|closed/i);
  assert.equal(session.ended, true);
  assert.ok(events.some(value => value.ev === 'session.status' && value.phase === 'closed'));
});

test('a query error during initialization surfaces the SDK error', async () => {
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() { throw new Error('authentication setup failed'); },
        async initializationResult() { await delay(30); return { commands: [] }; },
        close() {},
      };
    },
  };
  const session = new ClaudeSession({ cardId: 'card-early-error', sdk, write() {} });
  await assert.rejects(within(200, session.start({ cwd: 'C:/', sessionId: null }), 'early query error'), /authentication setup failed/);
});

test('a request cancelled while its card is being published resolves after the card event', async () => {
  const events = [];
  const controller = new AbortController();
  const session = new ClaudeSession({
    cardId: 'card-reentrant', sdk: fakeSdk(),
    write(value) {
      events.push(value);
      if (value.ev === 'session.request') controller.abort();
    },
  });
  const decision = await within(200, session.requestPermission('Bash', {}, { signal: controller.signal }), 'reentrant cancellation');
  assert.equal(decision.behavior, 'deny');
  assert.deepEqual(events.map(value => value.ev), ['session.request', 'session.request_cancelled']);
});

test('cancellation retains the native identity captured when the approval was published', async () => {
  const { session, events } = harness();
  session.sessionId = 'native-original';
  const controller = new AbortController();
  const pending = session.requestPermission('Bash', {}, { signal: controller.signal });
  session.sessionId = 'native-later';
  controller.abort();
  assert.equal((await within(200, pending, 'identity-bound cancellation')).behavior, 'deny');
  assert.equal(events.find(value => value.ev === 'session.request_cancelled').sessionId, 'native-original');
});

test('a permission callback arriving after stop is denied without publishing a card', async () => {
  const { session, events } = harness();
  await session.stop();
  const outcome = await within(200, session.requestPermission('Bash', {}, {}), 'late permission after stop');
  assert.equal(outcome.behavior, 'deny');
  assert.equal(events.filter(value => value.ev === 'session.request').length, 0);
  assert.equal(session.pending.size, 0);
});

test('a completed turn reads context usage once and writes one session.context event', async () => {
  const { session, events } = harness();
  let reads = 0;
  session.query = {
    async getContextUsage(options) {
      reads += 1;
      assert.equal(options.detail, 'summary');
      return { totalTokens: 94700, maxTokens: 258000, percentage: 36.7 };
    },
  };
  session.readContextUsage({ usage: { input_tokens: 90000, output_tokens: 4700, cache_read_input_tokens: 60000, cache_creation_input_tokens: 1000 } }, 'turn-1');
  await delay(10);
  const contexts = events.filter(value => value.ev === 'session.context');
  assert.equal(reads, 1, 'exactly one context read per turn');
  assert.equal(contexts.length, 1, 'exactly one context event per turn');
  assert.equal(contexts[0].usage.usedTokens, 94700);
  assert.equal(contexts[0].usage.windowTokens, 258000);
  assert.equal(contexts[0].usage.percent, 36.7);
  assert.equal(contexts[0].usage.inputTokens, 90000);
  assert.equal(contexts[0].usage.outputTokens, 4700);
  assert.equal(contexts[0].usage.cacheReadTokens, 60000);
  assert.equal(contexts[0].usage.cacheWriteTokens, 1000);
  assert.equal(contexts[0].usage.totalTokens, 155700);
  assert.equal(contexts[0].operationId, 'turn-1');
});

test('an older context read settling last cannot replace the newer turn snapshot', async () => {
  const { session, events } = harness();
  const pending = [];
  session.query = {
    getContextUsage() { return new Promise(resolve => pending.push(resolve)); },
  };

  session.readContextUsage({ usage: { input_tokens: 10 } }, 'turn-1');
  session.readContextUsage({ usage: { input_tokens: 20 } }, 'turn-2');
  assert.equal(pending.length, 2);
  pending[1]({ totalTokens: 20, maxTokens: 100, percentage: 20 });
  await delay(0);
  pending[0]({ totalTokens: 10, maxTokens: 100, percentage: 10 });
  await delay(0);

  const contexts = events.filter(value => value.ev === 'session.context');
  assert.equal(contexts.length, 1, 'superseded context reads must not emit');
  assert.equal(contexts[0].operationId, 'turn-2');
  assert.equal(contexts[0].usage.usedTokens, 20);
});

test('a prior turn context read is ignored as soon as the next turn starts', async () => {
  const { session, events } = harness();
  let resolveContext;
  session.query = { getContextUsage: () => new Promise(resolve => { resolveContext = resolve; }) };
  session.send('first turn', 'turn-1');
  session.readContextUsage({ usage: { input_tokens: 10 } }, 'turn-1');
  session.activeOperationId = null;
  session.send('next turn', 'turn-2');
  resolveContext({ totalTokens: 10, maxTokens: 100, percentage: 10 });
  await delay(0);
  assert.equal(events.filter(value => value.ev === 'session.context').length, 0);
});

test('a missing context read and a failed one write no context event', async () => {
  const { session, events } = harness();
  session.readContextUsage({ usage: {} }, 'turn-1');
  session.query = { async getContextUsage() { throw new Error('no context'); } };
  session.readContextUsage({ usage: { input_tokens: 5 } }, 'turn-2');
  await delay(10);
  assert.equal(events.filter(value => value.ev === 'session.context').length, 0);
});

test('background tasks require explicit native background membership and retain terminal rows until the next turn', async () => {
  const { session, events } = harness();
  const stopped = [];
  session.query = { async stopTask(taskId) { stopped.push(taskId); } };
  assert.equal(session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'ambient-task', description: 'Ambient' }), false);
  assert.equal(session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'skip-task', is_backgrounded: true, ambient: true }), false);
  session.observeBackgroundMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash-tool', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } });
  assert.deepEqual(session.uiState().backgroundTasks.map(task => [task.id, task.canStop, task.toolId]), [['bash-tool', false, 'bash-tool']]);
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'native-task', tool_use_id: 'bash-tool', is_backgrounded: true, description: 'Run tests' });
  assert.deepEqual(session.uiState().backgroundTasks.map(task => [task.id, task.canStop, task.toolId]), [['native-task', true, 'bash-tool']]);
  assert.equal(await session.stopTask('native-task'), true);
  assert.deepEqual(stopped, ['native-task']);
  assert.equal(session.uiState().backgroundTasks[0].status, 'running', 'stop acknowledgement does not invent a terminal event');
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_notification', task_id: 'native-task', status: 'stopped' });
  const terminal = session.uiState().backgroundTasks[0];
  assert.equal(terminal.status, 'stopped');
  assert.equal(terminal.canStop, false);
  assert.match(terminal.endedAt, /^\d{4}-/);
  session.send('next', 'turn-next');
  assert.deepEqual(session.uiState().backgroundTasks, []);
  assert.ok(events.some(value => value.ev === 'session.ui'), 'task changes can publish complete UI snapshots');
});

test('a background command stays one row whatever order its tool and native task arrive in', () => {
  const toolMessage = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash-tool', name: 'Bash', input: { command: 'node serve.js', run_in_background: true } }] } };
  const rows = session => session.uiState().backgroundTasks.map(task => [task.id, task.canStop, task.toolId]);
  // The final assistant snapshot repeats the tool after the native task adopted it.
  let { session } = harness();
  session.query = { async stopTask() {} };
  session.observeBackgroundMessage(toolMessage);
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'native-task', tool_use_id: 'bash-tool', is_backgrounded: true });
  session.observeBackgroundMessage(toolMessage);
  assert.deepEqual(rows(session), [['native-task', true, 'bash-tool']]);
  // The membership snapshot names the task before the event that links its tool.
  ({ session } = harness());
  session.query = { async stopTask() {} };
  session.observeBackgroundMessage(toolMessage);
  session.observeBackgroundMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'native-task' }] });
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_updated', task_id: 'native-task', tool_use_id: 'bash-tool', patch: {} });
  assert.deepEqual(rows(session), [['native-task', true, 'bash-tool']]);
});

test('running background tasks survive parent completion and the next turn', () => {
  const { session } = harness();
  session.query = { async stopTask() {} };
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'agent-task', is_backgrounded: true, description: 'Inspect code' });
  session.activeOperationId = null;
  session.send('next', 'turn-next');
  assert.deepEqual(session.uiState().backgroundTasks.map(task => [task.id, task.status]), [['agent-task', 'running']]);
});

test('terminal background tasks cannot resurrect from late progress or membership snapshots', () => {
  const { session } = harness();
  session.query = { async stopTask() {} };
  session.observeBackgroundMessage({ type:'system', subtype:'task_started', task_id:'old', tool_use_id:'old-tool', is_backgrounded:true });
  session.observeBackgroundMessage({ type:'system', subtype:'task_notification', task_id:'old', status:'failed' });
  session.observeBackgroundMessage({ type:'system', subtype:'task_progress', task_id:'old' });
  assert.equal(session.uiState().backgroundTasks[0].status,'failed');
  session.send('next','next');
  session.observeBackgroundMessage({ type:'system', subtype:'task_progress', task_id:'old', tool_use_id:'old-tool' });
  session.observeBackgroundMessage({ type:'system', subtype:'background_tasks_changed', tasks:[{task_id:'old',is_backgrounded:true}] });
  assert.deepEqual(session.uiState().backgroundTasks,[]);
});

test('background Stop shares accepted and uncertain native requests until terminal confirmation', async () => {
  const { session } = harness();
  let calls=0, release;
  session.query={stopTask:()=>{calls++; return new Promise(resolve=>{release=resolve;});}};
  session.observeBackgroundMessage({type:'system',subtype:'task_started',task_id:'one',is_backgrounded:true});
  const first=session.stopTask('one'), second=session.stopTask('one');
  await Promise.resolve();
  assert.equal(calls,1); release(); await Promise.all([first,second]);
  await session.stopTask('one'); assert.equal(calls,1);
  session.query={stopTask:async()=>{calls++; throw Error('lost response');}};
  session.observeBackgroundMessage({type:'system',subtype:'task_started',task_id:'two',is_backgrounded:true});
  await assert.rejects(session.stopTask('two'),/lost response/);
  await assert.rejects(session.stopTask('two'),/lost response/);
  assert.equal(calls,2);
});

test('background task stop rejects foreign, finished, unsupported and closed tasks', async () => {
  const { session } = harness();
  session.query = {};
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: 'unsupported', is_backgrounded: true });
  await assert.rejects(session.stopTask('foreign'), /does not belong/);
  await assert.rejects(session.stopTask('unsupported'), /not supported/);
  session.query = { async stopTask() {} };
  session.observeBackgroundMessage({ type: 'system', subtype: 'task_updated', task_id: 'unsupported', patch: { status: 'failed' } });
  await assert.rejects(session.stopTask('unsupported'), /no longer running/);
  session.closed = true;
  await assert.rejects(session.stopTask('unsupported'), /ended/);
});

test('a preview-only ThreadTerm server auto-approves only the two preview tools', async () => {
  const { session, events } = harness();
  await session.start({
    cwd: 'C:/',
    sessionId: null,
    mcpServers: { threadterm: { type: 'stdio', command: 'threadterm-v3-mcp', args: [], env: { THREADTERM_PREVIEW_TOKEN: 'scoped-preview' } } },
  });
  assert.deepEqual(session.query.options.allowedTools, ['mcp__threadterm__preview_present', 'mcp__threadterm__preview_status']);
  assert.equal((await session.requestPermission('mcp__threadterm__preview_present', { url: 'http://127.0.0.1:3000' })).behavior, 'allow');
  const delegation = session.requestPermission('mcp__threadterm__delegate_start', {});
  const request = events.find(value => value.ev === 'session.request');
  assert.ok(request, 'a delegation tool in a browser-only profile still asks the user');
  session.decide(request.requestId, 'deny');
  assert.equal((await delegation).behavior, 'deny');
  await session.stop();
});

test('browser reads and actions auto-approve only their exact managed tools without publishing private arguments', async () => {
  const { session, events } = harness();
  await session.start({
    cwd: 'C:/', sessionId: null,
    mcpServers: { threadterm: { type: 'stdio', command: 'threadterm-v3-mcp', args: [], env: { THREADTERM_MCP_PROFILE: 'chat-tools', THREADTERM_BROWSER_TOKEN: 'browser-only' } } },
  });
  assert.deepEqual(session.query.options.allowedTools, ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option'].map(name => `mcp__threadterm__${name}`), 'pre-approved rules never include browser_eval');
  try {
    for (const name of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
      'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) {
      const input = name === 'browser_list_tabs' ? {} : { tabId: 'opaque-tab', ref: 'ref-a', text: 'PRIVATE', values: ['PRIVATE'] };
      const before = structuredClone(input);
      assert.deepEqual(await session.requestPermission(`mcp__threadterm__${name}`, input), { behavior: 'allow', updatedInput: input });
      assert.deepEqual(input, before, 'permission policy must not alter the SDK/model arguments');
    }
    assert.equal(events.filter(value => value.ev === 'session.request').length, 0);
    assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
    for (const name of ['mcp__threadterm__browser_click_extra', 'mcp__threadterm__browser_type ',
      'mcp__threadterm__browser_snapshot_extra', 'mcp__foreign__browser_snapshot',
      ...['browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option'].map(tool => `mcp__foreign__${tool}`),
      'mcp__threadterm__preview_present', 'mcp__threadterm__delegate_start', 'mcp__threadterm__ask_user', 'Bash', 'exec_command']) {
      const pending = session.requestPermission(name, {});
      const request = events.findLast(value => value.ev === 'session.request');
      assert.equal(request?.toolName, name, `${name} keeps its native permission request`);
      session.decide(request.requestId, 'deny');
      assert.equal((await within(200, pending, `${name} settles`)).behavior, 'deny');
    }
  } finally { await session.stop(); }
  assert.equal((await session.requestPermission('mcp__threadterm__browser_type', { text: 'PRIVATE' })).behavior, 'deny');
});

test('browser read and action policy needs its own token and managed host profile', async () => {
  const managed = { type: 'stdio', command: 'threadterm-v3-mcp', args: [], env: { THREADTERM_MCP_PROFILE: 'chat-tools', THREADTERM_BROWSER_TOKEN: 'browser-only' } };
  const disabled = [
    undefined,
    { foreign: managed },
    { threadterm: { ...managed, name: 'foreign' } },
    { threadterm: { ...managed, env: { THREADTERM_BROWSER_TOKEN: 'browser-only' } } },
    { threadterm: { ...managed, env: { ...managed.env, THREADTERM_MCP_PROFILE: 'preview' } } },
    { threadterm: { ...managed, env: { ...managed.env, THREADTERM_MCP_PROFILE: 'read-only' } } },
    { threadterm: { ...managed, env: { ...managed.env, THREADTERM_MCP_PROFILE: 'reviewer' } } },
    { threadterm: { ...managed, env: { ...managed.env, THREADTERM_BROWSER_TOKEN: '' } } },
    { threadterm: { ...managed, env: { ...managed.env, THREADTERM_BROWSER_TOKEN: 1 } } },
    { threadterm: { ...managed, env: { THREADTERM_MCP_PROFILE: 'chat-tools', THREADTERM_PREVIEW_TOKEN: 'preview-only', THREADTERM_SESSION_TOKEN: 'delegation-only', THREADTERM_CHAT_TOKEN: 'chat-only', THREADTERM_CHAT_TOOL_ASK: '1' } } },
  ];
  for (const mcpServers of disabled) {
    const { session, events } = harness();
    await session.start({ cwd: 'C:/', sessionId: null, mcpServers });
    assert.equal((session.query.options.allowedTools ?? []).some(name => name.includes('browser_')), false);
    try {
      for (const tool of ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) {
        const pending = session.requestPermission(`mcp__threadterm__${tool}`, { tabId: 'opaque-tab' });
        const request = events.findLast(value => value.ev === 'session.request');
        assert.equal(request?.toolName, `mcp__threadterm__${tool}`, 'missing browser authority preserves a native permission request');
        session.decide(request.requestId, 'deny');
        assert.equal((await within(200, pending, 'unavailable browser tool settles')).behavior, 'deny');
      }
    } finally { await session.stop(); }
  }
});


test('ExitPlanMode approval allows the tool before returning Claude to default mode', async () => {
  const events = [], calls = [];
  const session = new ClaudeSession({ cardId: 'plan-card', sdk: fakeSdk(), write: value => events.push(value) });
  let settled = false;
  session.query = { setPermissionMode: async mode => { assert.equal(settled, true, 'ExitPlanMode must settle before changing permission mode'); calls.push(mode); } };
  session.settings.mode = 'plan';
  const pending = session.requestPermission('ExitPlanMode', { plan: '# Build it' });
  const request = events.find(value => value.ev === 'session.request');
  assert.equal(request.toolName, 'ExitPlanMode');
  pending.then(() => { settled = true; });
  const response = session.planResponse(request.requestId, 'approve');
  assert.deepEqual(await within(200, pending, 'plan approval settles'), { behavior: 'allow' });
  assert.deepEqual(await response, { outcome: 'submitted', nativeDecision: 'allowed', modeChanged: true });
  assert.deepEqual(calls, ['default']);
  assert.equal(session.settings.mode, 'default');
});

test('permission request ids remain unique when a Chat worker restarts', async () => {
  const requestId = async session => {
    const pending = session.requestPermission('ExitPlanMode', { plan: '# Build it' });
    const request = session.events.find(value => value.ev === 'session.request');
    await session.planResponse(request.requestId, 'abandon');
    await pending;
    return request.requestId;
  };
  const create = () => {
    const events = [];
    const session = new ClaudeSession({ cardId: 'stable-card', sdk: fakeSdk(), write: value => events.push(value) });
    session.events = events;
    return session;
  };
  const first = await requestId(create());
  const second = await requestId(create());
  assert.notEqual(first, second, 'a replacement worker must use a fresh request namespace');
  assert.match(first, /^stable-card-permission-[0-9a-f-]{36}-1$/);
  assert.match(second, /^stable-card-permission-[0-9a-f-]{36}-1$/);
});

test('ExitPlanMode mode-switch failure returns a terminal partial receipt', async () => {
  const events = [];
  const session = new ClaudeSession({ cardId: 'plan-card', sdk: fakeSdk(), write: value => events.push(value) });
  session.query = { setPermissionMode: async () => { throw new Error('mode control disconnected'); } };
  session.settings.mode = 'plan';
  const pending = session.requestPermission('ExitPlanMode', { plan: '# Build it' });
  const request = events.find(value => value.ev === 'session.request');
  const response = session.planResponse(request.requestId, 'approve');
  assert.deepEqual(await within(200, pending, 'native plan approval settles'), { behavior: 'allow' });
  assert.deepEqual(await response, {
    outcome: 'partial',
    nativeDecision: 'allowed',
    modeChanged: false,
    recovery: 'reconnect',
    message: 'mode control disconnected',
  });
  assert.equal(session.pending.has(request.requestId), false, 'a partial success cannot remain retryable');
  assert.equal(session.settings.mode, 'plan');
});

test('ExitPlanMode feedback and abandonment deny with messages and retain plan mode', async () => {
  for (const [action, feedback, message] of [
    ['request_changes', 'Use the existing API.', 'Use the existing API.'],
    ['abandon', undefined, 'Please abandon the plan and remain in plan mode.'],
  ]) {
    const events = [], calls = [];
    const session = new ClaudeSession({ cardId: 'plan-card', sdk: fakeSdk(), write: value => events.push(value) });
    session.query = { setPermissionMode: async mode => calls.push(mode) };
    session.settings.mode = 'plan';
    const pending = session.requestPermission('ExitPlanMode', { plan: 'x' });
    const request = events.find(value => value.ev === 'session.request');
    await session.planResponse(request.requestId, action, feedback);
    assert.deepEqual(await within(200, pending, 'plan denial settles'), { behavior: 'deny', message });
    assert.deepEqual(calls, []);
    assert.equal(session.settings.mode, 'plan');
  }
});

test('only one ExitPlanMode approval can remain pending', async () => {
  const { session, events } = harness();
  const first = session.requestPermission('ExitPlanMode', { plan: 'first' });
  const second = await session.requestPermission('ExitPlanMode', { plan: 'second' });
  assert.deepEqual(second, { behavior: 'deny', message: 'A plan approval is already pending.' });
  assert.equal(events.filter(value => value.ev === 'session.request').length, 1);
  const request = events.find(value => value.ev === 'session.request');
  await session.planResponse(request.requestId, 'abandon');
  assert.equal((await first).behavior, 'deny');
});
function controllableSdk(init = { commands: [], models: [], account: {} }) {
  let waiter;
  const pending = [];
  let ended = false;
  const query = {
    push(message) {
      if (ended) return;
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ value: message, done: false });
      } else pending.push(message);
    },
    finish() {
      ended = true;
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(resolve => { waiter = resolve; });
        },
      };
    },
    async initializationResult() { return init; },
    async interrupt() {},
    close() { this.finish(); },
  };
  return { sdk: { query: () => query }, query };
}

test('a late Roundtable system init downgrade publishes the raw tool report', async () => {
  for (const late of [
    { tools: ['Read', 'Write'] },
    { tools: 'malformed' },
    { mcp_tools: [] },
    { tools: ['Read', 'Glob', 'Grep'], mcp_tools: [{ unexpected: 'mcp__foreign__tool' }] },
  ]) {
    const { sdk, query } = controllableSdk({ commands: [], models: [], account: {}, tools: ['Read', 'Glob', 'Grep'], mcp_tools: [] });
    const events = [];
    const session = new ClaudeSession({ cardId: 'roundtable-late-tools', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
    try {
      await session.start({ cwd: tmpdir(), readOnlyTools: ['Read', 'Glob', 'Grep'] });
      assert.equal(session.roundtableToolsReport.enforced, true);
      query.push({ type: 'system', subtype: 'init', ...late });
      const ui = await waitFor(
        () => events.findLast(value => value.ev === 'session.ui' && value.ui?.roundtableToolsReport?.enforced === false),
        'late native tool report publishes the Roundtable downgrade',
      );
      assert.equal(ui.ui.roundtableToolsReport.enforced, false);
    } finally {
      query.finish();
      await session.pump;
    }
  }
});

test('steer while a turn is active delivers once and does not replace the turn', () => {
  const { session } = harness();
  const seen = [];
  const push = session.input.push.bind(session.input);
  session.input.push = value => { seen.push(structuredClone(value)); return push(value); };
  assert.throws(() => session.steer('too early', 'steer-0'), /The turn ended before the message was inserted/);
  assert.equal(session.pendingSteers.size, 0);
  session.send('hello', 'op-1');
  seen.length = 0;
  assert.deepEqual(session.steer('while you work', 'steer-1', 'op-1'), { disposition: 'delivered' });
  assert.equal(session.activeOperationId, 'op-1');
  assert.equal(seen.length, 1);
  assert.match(seen[0].uuid, UUID_RE, 'a non-uuid operation id is never sent as the client uuid');
  assert.notEqual(seen[0].uuid, 'steer-1');
  assert.equal(session.steerUuids.get(seen[0].uuid), 'steer-1', 'the generated uuid maps back to the operation id');
  assert.equal(seen[0].message.content[0].text, 'while you work');
  assert.equal(seen[0].uuid !== undefined, true);
  session.input.end();
  assert.throws(() => session.steer('after close', 'steer-2', 'op-1'), /The turn ended before the message was inserted/);
  assert.equal(session.pendingSteers.has('steer-2'), false);
  assert.equal(session.activeOperationId, 'op-1');
});

test('a steer aimed at a replaced turn is refused before anything reaches the SDK input', () => {
  const { session } = harness();
  const seen = [];
  const push = session.input.push.bind(session.input);
  session.input.push = value => { seen.push(structuredClone(value)); return push(value); };
  session.send('hello', 'op-1');
  seen.length = 0;
  assert.throws(() => session.steer('wrong turn', 'steer-1', 'op-2'), /The turn ended before the message was inserted/);
  assert.equal(seen.length, 0, 'a refused steer never reaches the SDK input');
  assert.equal(session.pendingSteers.size, 0);
  assert.equal(session.steerUuids.size, 0);
  assert.equal(session.activeOperationId, 'op-1');
  assert.deepEqual(session.steer('right turn', 'steer-1', 'op-1'), { disposition: 'delivered' });
  // The adopted carry form is the same id space: carry:<operationId>.
  session.activeOperationId = 'carry:steer-9';
  assert.throws(() => session.steer('stale target', 'steer-2', 'op-1'), /The turn ended before the message was inserted/);
  assert.deepEqual(session.steer('into the carry', 'steer-3', 'carry:steer-9'), { disposition: 'delivered' });
  assert.equal(session.pendingSteers.has('steer-3'), true);
});

// A fake SDK whose query consumes the session's real input queue FIFO and
// answers every consumed message with a user echo, an assistant reply and a
// result, so tests assert which operation each frame is attributed to. With
// `batch`, every message already queued is drained into one turn.
// control.hold() parks consumption before the next turn until release();
// control.results queues per-turn result overrides ({fieldless:true} omits
// the uuid fields).
function fifoSdk({ batch = false } = {}) {
  const controls = [];
  const sdk = {
    query({ prompt }) {
      const control = { results: [], turns: [], release: null };
      let gate = null;
      control.hold = () => { gate = new Promise(resolve => { control.release = resolve; }); };
      controls.push(control);
      const input = prompt[Symbol.asyncIterator]();
      const query = {
        async initializationResult() { return { commands: [], models: [], account: {} }; },
        async interrupt() {},
        close() {},
        async return() { return { done: true }; },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (gate) { await gate; gate = null; }
            const step = await input.next();
            if (step.done) return;
            const consumed = [step.value];
            while (batch && prompt.size > 0) consumed.push((await input.next()).value);
            control.turns.push(consumed);
            for (const message of consumed) {
              yield { type: 'user', uuid: message.uuid, message: { role: 'user', content: message.message.content }, parent_tool_use_id: null };
            }
            const index = control.turns.length;
            yield { type: 'assistant', message: { id: `m-${index}`, content: [{ type: 'text', text: `reply ${index}` }] } };
            const { fieldless = false, ...overrides } = control.results.shift() ?? {};
            const result = { type: 'result', is_error: false, ...overrides };
            if (!fieldless && result.user_message_uuids === undefined && result.user_message_uuid === undefined) {
              result.user_message_uuids = consumed.map(message => message.uuid);
            }
            yield result;
          }
        },
      };
      return query;
    },
  };
  return { sdk, controls };
}

const waitFor = async (probe, label) => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`);
    await delay(5);
  }
};

const statuses = events => events.filter(e => e.ev === 'session.status').map(e => `${e.phase}:${e.operationId ?? '-'}`);
const frames = events => events.filter(e => e.ev === 'session.event').map(e => `${e.message.type}:${e.operationId ?? '-'}`);

test('a leftover steer after a clean result owns the next turn immediately', async () => {
  const { sdk, controls } = fifoSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-carry', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    const control = controls[0];
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    control.hold();
    await waitFor(() => events.some(e => e.ev === 'session.status' && e.phase === 'idle' && e.operationId === 'op-a'), 'turn A completes');
    // The cleanly accounted turn left the steer in the SDK input and the SDK
    // runs it next: the carry is claimed before any frame arrives, so a send
    // during it queues in ThreadTerm instead of racing.
    assert.equal(session.activeOperationId, 'carry:steer-a');
    assert.deepEqual(statuses(events), ['running:op-a', 'idle:op-a', 'running:carry:steer-a']);
    assert.throws(() => session.send('two', 'op-b'), /turn already active: carry:steer-a/);
    control.release();
    await waitFor(() => events.some(e => e.ev === 'session.status' && e.phase === 'idle' && e.operationId === 'carry:steer-a'), 'carry completes');
    assert.deepEqual(statuses(events), ['running:op-a', 'idle:op-a', 'running:carry:steer-a', 'idle:carry:steer-a']);
    assert.deepEqual(frames(events), [
      'user:op-a', 'assistant:op-a', 'result:op-a',
      'user:carry:steer-a', 'assistant:carry:steer-a', 'result:carry:steer-a',
    ]);
    assert.equal(session.activeOperationId, null);
    assert.equal(session.pendingSteers.size, 0);
    // The steered message itself ran as the second SDK turn.
    assert.deepEqual(control.turns.map(turn => turn.map(message => message.message.content[0].text)), [['one'], ['s1']]);
  } finally {
    await session.stop();
    await session.pump;
  }
});

test('a uuid operation id is sent verbatim as the client uuid for send and steer', async () => {
  const { session } = harness();
  const seen = [];
  const push = session.input.push.bind(session.input);
  session.input.push = value => { seen.push(structuredClone(value)); return push(value); };
  const uuid = '11111111-2222-4333-8444-555555555555';
  session.send('hello', uuid);
  assert.equal(seen[0].uuid, uuid, 'send stamps the operation id when it is a uuid');
  seen.length = 0;
  assert.deepEqual(session.steer('while you work', uuid, uuid), { disposition: 'delivered' });
  assert.equal(seen[0].uuid, uuid, 'steer stamps the operation id when it is a uuid');
  assert.equal(session.steerUuids.get(uuid), uuid);
  session.input.end();
});

test('a singular result uuid consumes its steer and leaves no carry', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-consume', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    const steerUuid = [...session.steerUuids.keys()][0];
    query.push({ type: 'result', user_message_uuid: steerUuid, is_error: false });
    await delay(30);
    assert.equal(session.pendingSteers.size, 0, 'the singular fallback consumes the steer');
    assert.equal(session.steerUuids.size, 0);
    assert.equal(session.activeOperationId, null);
    assert.equal(events.filter(event => event.ev === 'session.status' && event.phase === 'running' && String(event.operationId).startsWith('carry:')).length, 0);
  } finally {
    query.finish();
    await session.pump;
  }
});

test('a result without uuid fields keeps leftover steers and a send never drops them', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-fieldless', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    query.push({ type: 'result', is_error: false, duration_ms: 0 });
    await delay(30);
    assert.equal(session.pendingSteers.size, 1, 'a fieldless result proves nothing and keeps the leftover');
    assert.equal(session.steerUuids.size, 1);
    assert.equal(session.activeOperationId, null, 'a fieldless result never adopts a carry eagerly');
    // A send while leftovers are pending queues behind them instead of
    // clearing them or racing their turn.
    session.send('two', 'op-b');
    assert.equal(session.queuedSends.length, 1);
    assert.equal(session.pendingSteers.size, 1, 'send must never drop pending steer uuids');
    assert.equal(session.activeOperationId, null);
    assert.equal(events.filter(event => event.ev === 'session.status' && event.phase === 'running' && String(event.operationId).startsWith('carry:')).length, 0);
  } finally {
    query.finish();
    await session.pump;
  }
});

test('a carry is adopted on the echoed steer, never on a system frame', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-adopt', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    query.push({ type: 'result', is_error: false, duration_ms: 0 });
    await delay(30);
    query.push({ type: 'system', subtype: 'status', permissionMode: 'default' });
    await delay(30);
    assert.equal(session.activeOperationId, null, 'a system status frame never starts the carry');
    const steerUuid = [...session.steerUuids.keys()][0];
    query.push({ type: 'user', uuid: steerUuid, message: { role: 'user', content: [] } });
    await delay(30);
    assert.equal(session.activeOperationId, 'carry:steer-a');
    assert.equal(session.pendingSteers.size, 0);
    assert.equal(events.filter(event => event.ev === 'session.status' && event.phase === 'running' && event.operationId === 'carry:steer-a').length, 1);
  } finally {
    query.finish();
    await session.pump;
  }
});

test('model activity with nothing active adopts the oldest pending steer', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-activity', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    query.push({ type: 'result', is_error: false, duration_ms: 0 });
    await delay(30);
    query.push({ type: 'assistant', message: { id: 'm-carry', content: [] } });
    await delay(30);
    assert.equal(session.activeOperationId, 'carry:steer-a');
    assert.equal(session.pendingSteers.size, 0);
    assert.equal(events.filter(event => event.ev === 'session.status' && event.phase === 'running' && event.operationId === 'carry:steer-a').length, 1);
  } finally {
    query.finish();
    await session.pump;
  }
});

test('an interrupted or failed result leaves a steer for the carry it starts', async () => {
  for (const [label, isError, expected] of [['interrupted', false, 'interrupted'], ['failed', true, 'failed']]) {
    const { sdk, query } = controllableSdk();
    const events = [];
    const session = new ClaudeSession({ cardId: `card-${label}`, sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
    try {
      await session.start({ cwd: 'C:/' });
      session.send('one', 'op-a');
      session.steer('s1', 'steer-a', 'op-a');
      if (label === 'interrupted') await session.interrupt('op-a');
      query.push({ type: 'result', user_message_uuids: [], is_error: isError });
      await delay(30);
      assert.equal(session.activeOperationId, null, `${label}: no eager carry`);
      assert.equal(session.pendingSteers.size, 1, `${label}: the leftover survives`);
      const idle = events.filter(event => event.ev === 'session.status' && event.phase === 'idle' && event.operationId === 'op-a');
      assert.equal(idle.at(-1)?.status, expected, `${label}: the completion status is reported`);
      const steerUuid = [...session.steerUuids.keys()][0];
      query.push({ type: 'user', uuid: steerUuid, message: { role: 'user', content: [] } });
      await delay(30);
      assert.equal(session.activeOperationId, 'carry:steer-a', `${label}: the echo adopts the carry`);
    } finally {
      query.finish();
      await session.pump;
    }
  }
});

test('a Stop for an ended turn never interrupts the turn that replaced it', async () => {
  const { sdk, query } = controllableSdk();
  const interrupts = [];
  query.interrupt = async () => { interrupts.push(session.activeOperationId); };
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-stale-stop', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: tmpdir() });
    session.send('one', 'op-a');
    query.push({ type: 'result', user_message_uuids: [], is_error: false });
    await delay(20);
    assert.equal(session.activeOperationId, null);
    session.send('two', 'op-b');
    // Stop(A) arrives after B started.
    assert.deepEqual(await session.interrupt('op-a'), { status: 'stale_turn', activeOperationId: 'op-b' });
    assert.equal(interrupts.length, 0, 'a stale Stop never reaches the SDK');
    assert.equal(session.activeOperationId, 'op-b', 'B keeps running');
    assert.equal(session.interruptedOperation, null, 'B is not marked for interruption');
    assert.equal(events.some(value => value.ev === 'session.status' && value.phase === 'idle' && value.operationId === 'op-b'), false, 'B is not reported ended');
    query.push({ type: 'result', user_message_uuids: [], is_error: false });
    await delay(20);
    assert.equal(events.findLast(value => value.ev === 'session.status').status, 'completed', 'B completes as a normal answer');
    // A Stop naming the live turn still stops it, and a repeat is a no-op.
    session.send('three', 'op-c');
    assert.deepEqual(await session.interrupt('op-c'), { status: 'interrupted', operationId: 'op-c' });
    assert.equal(interrupts.length, 1);
    query.push({ type: 'result', user_message_uuids: [], is_error: false });
    await delay(20);
    assert.deepEqual(await session.interrupt('op-c'), { status: 'idle' });
    assert.equal(interrupts.length, 1, 'an already ended turn is not interrupted twice');
  } finally {
    query.finish();
    await session.pump;
  }
});

test('a batched steer and send fold into the carry turn', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-batch', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    query.push({ type: 'result', is_error: false, duration_ms: 0 });
    await delay(30);
    session.send('two', 'op-b');
    const steerUuid = [...session.steerUuids.keys()][0];
    const sendUuid = session.queuedSends[0].uuid;
    // The SDK begins the carry turn and echoes both messages inside it.
    query.push({ type: 'user', uuid: steerUuid, message: { role: 'user', content: [] } });
    await delay(30);
    assert.equal(session.activeOperationId, 'carry:steer-a');
    query.push({ type: 'user', uuid: sendUuid, message: { role: 'user', content: [] } });
    await delay(30);
    assert.equal(session.activeOperationId, 'carry:steer-a', 'the batched send does not steal the carry turn');
    assert.equal(session.queuedSends.length, 0);
    assert.equal(session.foldedSends.length, 1);
    query.push({ type: 'assistant', message: { id: 'm-batch', content: [] } });
    query.push({ type: 'result', user_message_uuids: [steerUuid, sendUuid], is_error: false });
    await delay(30);
    assert.equal(session.activeOperationId, null);
    assert.equal(session.foldedSends.length, 0);
    const statuses = events.filter(event => event.ev === 'session.status').map(event => `${event.phase}:${event.operationId}`);
    assert.deepEqual(statuses, ['running:op-a', 'idle:op-a', 'running:carry:steer-a', 'running:op-b', 'idle:carry:steer-a', 'idle:op-b']);
  } finally {
    query.finish();
    await session.pump;
  }
});

test('a leftover steer runs before a later send and the send still gets its turn', async () => {
  const { sdk, query } = controllableSdk();
  const events = [];
  const session = new ClaudeSession({ cardId: 'card-separate', sdk, write: value => events.push(value), hostOptions: { warmUp: false } });
  try {
    await session.start({ cwd: 'C:/' });
    session.send('one', 'op-a');
    session.steer('s1', 'steer-a', 'op-a');
    query.push({ type: 'result', is_error: false, duration_ms: 0 });
    await delay(30);
    session.send('two', 'op-b');
    const steerUuid = [...session.steerUuids.keys()][0];
    const sendUuid = session.queuedSends[0].uuid;
    query.push({ type: 'user', uuid: steerUuid, message: { role: 'user', content: [] } });
    await delay(30);
    assert.equal(session.activeOperationId, 'carry:steer-a');
    query.push({ type: 'result', user_message_uuids: [steerUuid], is_error: false });
    await delay(30);
    assert.equal(session.activeOperationId, 'op-b', 'the queued send claims the next turn after the carry');
    assert.equal(session.queuedSends.length, 0);
    query.push({ type: 'assistant', message: { id: 'm-op-b', content: [] } });
    query.push({ type: 'result', user_message_uuids: [sendUuid], is_error: false });
    await delay(30);
    assert.equal(session.activeOperationId, null);
    const running = events.filter(event => event.ev === 'session.status' && event.phase === 'running').map(event => event.operationId);
    assert.deepEqual(running, ['op-a', 'carry:steer-a', 'op-b']);
  } finally {
    query.finish();
    await session.pump;
  }
});
