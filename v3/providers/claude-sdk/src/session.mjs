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

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 25000;

export class ClaudeSession {
  constructor({ cardId, sdk, write, hostOptions = {} }) {
    this.cardId = cardId; this.sdk = sdk; this.write = write; this.hostOptions = hostOptions;
    this.input = createInputQueue(); this.query = null; this.sessionId = null;
    this.activeOperationId = null; this.pending = new Map(); this.nextRequest = 1; this.closed = false; this.ended = false; this.endError = null;
    this.abortStart = null;
  }

  async start({ cwd, sessionId }) {
    if (this.closed) throw new Error('session is closed');
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
    // Readiness comes from the SDK control handshake, which completes without
    // any prompt or model message. The `system/init` event still supplies the
    // native session id later; it is not the readiness signal.
    const timeoutMs = this.hostOptions.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Claude SDK initialization timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const aborted = new Promise((_, reject) => {
      this.abortStart = () => reject(new Error('session stopped during initialization'));
    });
    try {
      await Promise.race([
        this.query.initializationResult(), timeout, aborted,
        this.pump.then(() => { throw this.endError ?? new Error('Claude SDK query ended during initialization'); }),
      ]);
    } catch (error) {
      // Never leave a live CLI behind a failed handshake.
      try { this.query.close?.(); } catch {}
      this.ended = true;
      throw error;
    } finally {
      clearTimeout(timer);
      this.abortStart = null;
    }
    if (this.closed || this.ended) throw new Error('Claude SDK query ended during initialization');
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
      this.endError = error;
      if (!this.closed) this.write(event(this.cardId, 'session.status', { phase: 'error', error: String(error?.message ?? error), operationId: this.activeOperationId }));
    } finally { this.ended = true; this.activeOperationId = null; this.cancelPermissions('Session closed'); }
  }

  requestPermission(toolName, input, { signal, suggestions } = {}) {
    if (this.closed || this.ended) return Promise.resolve({ behavior: 'deny', message: 'Session closed' });
    const requestId = `${this.cardId}-permission-${this.nextRequest++}`;
    const operationId = this.activeOperationId;
    const sessionId = this.sessionId;
    return new Promise(resolve => {
      // Registration precedes any cancellation check, and every exit path
      // settles exactly once through settle().
      const entry = { signal: signal ?? null, abort: null, published: false, settle: null };
      const settle = (result, { cancelled = false } = {}) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
        if (cancelled && entry.published) {
          this.write(event(this.cardId, 'session.request_cancelled', { requestId, operationId, sessionId, message: result.message }));
        }
        resolve(result);
      };
      entry.settle = settle;
      entry.abort = () => settle({ behavior: 'deny', message: 'Request cancelled' }, { cancelled: true });
      this.pending.set(requestId, entry);
      // A signal that was already cancelled settles immediately as a deny
      // without ever publishing a clickable approval card.
      if (entry.signal?.aborted) { entry.abort(); return; }
      entry.signal?.addEventListener('abort', entry.abort, { once: true });
      entry.published = true;
      this.write(event(this.cardId, 'session.request', { requestId, toolName, input, suggestions, operationId, sessionId }));
    });
  }

  decide(requestId, behavior) {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`unknown or expired permission request: ${requestId}`);
    entry.settle(behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by user' });
  }

  cancelPermissions(message) {
    for (const [requestId] of [...this.pending]) {
      this.pending.get(requestId)?.settle({ behavior: 'deny', message }, { cancelled: true });
    }
  }

  async interrupt() { if (!this.query) throw new Error('session not started'); await this.query.interrupt(); }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.abortStart?.();
    this.input.end(); this.cancelPermissions('Session stopped');
    try { this.query?.return?.(undefined)?.catch?.(() => {}); } catch {}
    this.write(event(this.cardId, 'session.status', { phase: 'closed', sessionId: this.sessionId }));
  }
}
