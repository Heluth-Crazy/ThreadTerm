import { describe, expect, it, vi } from 'vitest';
import { CardSession } from '../src/session.mjs';

function asyncQueue() {
  const values = [];
  const waiters = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    },
    next() {
      if (values.length > 0) return Promise.resolve(values.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

// Scripted SDK stand-in: the test drives which SDKMessages the query yields
// and can invoke the canUseTool callback exactly like the real SDK would.
function fakeSdk() {
  const state = { options: null, prompt: null, messages: asyncQueue() };
  const sdk = {
    query({ prompt, options }) {
      state.prompt = prompt;
      state.options = options;
      const gen = (async function* () {
        while (true) {
          const next = await state.messages.next();
          if (next === null) return;
          yield next;
        }
      })();
      gen.interrupt = vi.fn(async () => {});
      gen.setPermissionMode = vi.fn(async () => {});
      gen.setModel = vi.fn(async () => {});
      state.query = gen;
      return gen;
    },
  };
  return { sdk, state };
}

function makeSession() {
  const { sdk, state } = fakeSdk();
  const events = [];
  const session = new CardSession({
    cardId: 'c1',
    emit: (event) => events.push(event),
    sdk,
    hostOptions: { pathToClaudeCodeExecutable: 'X:/claude.exe' },
  });
  return { session, state, events };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CardSession', () => {
  it('start returns immediately and the init message emits ready with the session id', async () => {
    const { session, state, events } = makeSession();
    expect(session.start({ cwd: 'D:/proj' })).toBeNull();
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'starting')).toBe(true);
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'ready' && e.sessionId === 'sess-1')).toBe(true);
    expect(events.some((e) => e.ev === 'session.event' && e.message.type === 'system')).toBe(true);
    expect(state.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(state.options.includePartialMessages).toBe(true);
    expect(state.options.pathToClaudeCodeExecutable).toBe('X:/claude.exe');
  });

  it('passes resume, fork, model, and permission mode through to the SDK', async () => {
    const { session, state, events } = makeSession();
    expect(
      session.start({
        cwd: 'D:/proj',
        sessionId: 'old-sess',
        forkSession: true,
        model: 'opus',
        permissionMode: 'plan',
      }),
    ).toBe('old-sess');
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'new-sess' });
    await flush();
    expect(
      events.some((e) => e.ev === 'session.status' && e.phase === 'ready' && e.sessionId === 'new-sess'),
    ).toBe(true);
    expect(state.options.resume).toBe('old-sess');
    expect(state.options.forkSession).toBe(true);
    expect(state.options.model).toBe('opus');
    expect(state.options.permissionMode).toBe('plan');
  });

  it('send queues a user message for the streaming prompt and emits running', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    session.send('hello', [{ mediaType: 'image/png', base64: 'AAA=' }]);
    const iterator = state.prompt[Symbol.asyncIterator]();
    const { value } = await iterator.next();
    expect(value.type).toBe('user');
    expect(value.parent_tool_use_id).toBeNull();
    expect(value.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
      { type: 'text', text: 'hello' },
    ]);
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'running')).toBe(true);
  });

  it('routes canUseTool through session.request and resolves an allow decision', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    const resultPromise = state.options.canUseTool('Bash', { command: 'echo hi' }, { signal: new AbortController().signal, suggestions: [] });
    await flush();
    const request = events.find((e) => e.ev === 'session.request');
    expect(request.kind).toBe('can_use_tool');
    expect(request.toolName).toBe('Bash');
    session.decide(request.requestId, { behavior: 'allow', updatedInput: { command: 'echo hi' } });
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'echo hi' } });
  });

  it('resolves deny decisions and rejects unknown request ids', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    const resultPromise = state.options.canUseTool('Write', { file_path: 'a.txt' }, { signal: new AbortController().signal });
    await flush();
    const request = events.find((e) => e.ev === 'session.request');
    session.decide(request.requestId, { behavior: 'deny', message: 'no' });
    await expect(resultPromise).resolves.toEqual({ behavior: 'deny', message: 'no' });
    expect(() => session.decide('missing', { behavior: 'deny', message: 'x' })).toThrow(/unknown or expired/);
  });

  it('cancels a pending request when its abort signal fires', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    const controller = new AbortController();
    const resultPromise = state.options.canUseTool('Bash', { command: 'sleep 99' }, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(resultPromise).resolves.toEqual({ behavior: 'deny', message: 'Request aborted' });
    expect(events.some((e) => e.ev === 'session.request_cancelled')).toBe(true);
  });

  it('emits idle after a result message and closed after stop, cancelling pendings', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    state.messages.push({ type: 'result', subtype: 'success' });
    await flush();
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'idle')).toBe(true);
    const pending = state.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal });
    await flush();
    await session.stop();
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: 'Session closed' });
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'closed')).toBe(true);
    const iterator = state.prompt[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('delegates interrupt, setModel, and setPermissionMode to the query', async () => {
    const { session, state } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    await session.interrupt();
    await session.setModel('sonnet');
    await session.setPermissionMode('acceptEdits');
    expect(state.query.interrupt).toHaveBeenCalledTimes(1);
    expect(state.query.setModel).toHaveBeenCalledWith('sonnet');
    expect(state.query.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('emits an error status when the query stream fails', async () => {
    const { session, state, events } = makeSession();
    session.start({ cwd: 'D:/proj' });
    state.messages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();
    state.messages.push(Promise.reject(new Error('stream broke')));
    await flush();
    await flush();
    expect(events.some((e) => e.ev === 'session.status' && e.phase === 'error' && /stream broke/.test(e.detail))).toBe(true);
  });
});
