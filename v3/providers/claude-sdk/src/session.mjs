import { event } from './protocol.mjs';

export function createInputQueue() {
  const values = [], waiters = [];
  let ended = false;
  return {
    push(value) {
      if (ended) throw new Error('session input is closed');
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false }); else values.push(value);
    },
    end() { ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() { return { next: () => values.length ? Promise.resolve({ value: values.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => waiters.push(resolve)) }; },
  };
}

function userMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null };
}

export class ClaudeSession {
  constructor({ cardId, sdk, write, hostOptions = {} }) {
    this.cardId = cardId; this.sdk = sdk; this.write = write; this.hostOptions = hostOptions;
    this.input = createInputQueue(); this.query = null; this.sessionId = null;
    this.activeOperationId = null; this.pending = new Map(); this.nextRequest = 1; this.closed = false; this.ended = false;
  }

  start({ cwd, sessionId }) {
    const options = {
      cwd,
      settingSources: this.hostOptions.settingSources ?? ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      ...(this.hostOptions.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.hostOptions.pathToClaudeCodeExecutable } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      canUseTool: (toolName, input, context) => this.requestPermission(toolName, input, context),
    };
    this.sessionId = sessionId ?? null;
    this.query = this.sdk.query({ prompt: this.input, options });
    this.pump = this.run();
    return this.sessionId;
  }

  send(text, operationId) {
    if (this.ended || this.closed) throw new Error('session worker has ended');
    if (this.activeOperationId) throw new Error(`turn already active: ${this.activeOperationId}`);
    this.activeOperationId = operationId;
    this.input.push(userMessage(text));
    this.write(event(this.cardId, 'session.status', { phase: 'running', sessionId: this.sessionId, operationId }));
  }

  async run() {
    try {
      for await (const message of this.query) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.write(event(this.cardId, 'session.status', { phase: 'ready', sessionId: this.sessionId, operationId: this.activeOperationId }));
        }
        this.write(event(this.cardId, 'session.event', { message, sessionId: this.sessionId, operationId: this.activeOperationId }));
        if (message.type === 'result') {
          this.write(event(this.cardId, 'session.status', { phase: 'idle', sessionId: this.sessionId, operationId: this.activeOperationId }));
          this.activeOperationId = null;
        }
      }
      if (!this.closed) this.write(event(this.cardId, 'session.status', { phase: 'closed', sessionId: this.sessionId }));
    } catch (error) {
      if (!this.closed) this.write(event(this.cardId, 'session.status', { phase: 'error', error: String(error?.message ?? error), operationId: this.activeOperationId }));
    } finally { this.ended = true; this.activeOperationId = null; this.cancelPermissions('Session closed'); }
  }

  requestPermission(toolName, input, { signal, suggestions } = {}) {
    const requestId = `${this.cardId}-permission-${this.nextRequest++}`;
    return new Promise(resolve => {
      const abort = () => {
        if (this.pending.delete(requestId)) {
          this.write(event(this.cardId, 'session.request_cancelled', { requestId }));
          resolve({ behavior: 'deny', message: 'Request cancelled' });
        }
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, { resolve, signal, abort });
      this.write(event(this.cardId, 'session.request', { requestId, toolName, input, suggestions, operationId: this.activeOperationId }));
    });
  }

  decide(requestId, behavior) {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`unknown or expired permission request: ${requestId}`);
    this.pending.delete(requestId); entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by user' });
  }

  cancelPermissions(message) {
    for (const [requestId, entry] of this.pending) {
      entry.signal?.removeEventListener('abort', entry.abort);
      entry.resolve({ behavior: 'deny', message });
      this.write(event(this.cardId, 'session.request_cancelled', { requestId }));
    }
    this.pending.clear();
  }

  async interrupt() { if (!this.query) throw new Error('session not started'); await this.query.interrupt(); }
  async stop() {
    this.closed = true; this.input.end(); this.cancelPermissions('Session stopped');
    try { this.query?.return?.(undefined)?.catch?.(() => {}); } catch {}
    this.write(event(this.cardId, 'session.status', { phase: 'closed', sessionId: this.sessionId }));
  }
}
