// One CardSession per ThreadTerm card: wraps a streaming-input SDK query and
// translates between the NDJSON protocol and the Agent SDK surface.
//
// The SDK dependency is injected (`sdk.query`) so unit tests can substitute a
// scripted fake without loading the real package.

import {
  eventSessionEvent,
  eventSessionRequest,
  eventSessionRequestCancelled,
  eventSessionStatus,
} from './protocol.mjs';

function createInputQueue() {
  const pending = [];
  const waiters = [];
  let ended = false;
  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else pending.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          ended = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function userMessage(text, images) {
  const content = [];
  for (const image of images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    });
  }
  content.push({ type: 'text', text });
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

export class CardSession {
  constructor({ cardId, emit, sdk, hostOptions }) {
    this.cardId = cardId;
    this.emit = emit;
    this.sdk = sdk;
    this.hostOptions = hostOptions ?? {};
    this.input = createInputQueue();
    this.query = null;
    this.sessionId = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.closed = false;
    this.pump = null;
  }

  start({ cwd, sessionId, forkSession, model, permissionMode }) {
    if (this.query) throw new Error('session already started');
    const options = {
      cwd,
      // TUI parity by default; tests/smoke may narrow this via host options.
      settingSources: this.hostOptions.settingSources ?? ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      ...(this.hostOptions.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.hostOptions.pathToClaudeCodeExecutable }
        : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...(forkSession ? { forkSession: true } : {}),
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      canUseTool: (toolName, input, { signal, suggestions }) =>
        this.requestPermission('can_use_tool', { toolName, input, suggestions }, signal),
    };
    this.emit(eventSessionStatus(this.cardId, 'starting'));
    this.query = this.sdk.query({ prompt: this.input, options });
    this.pump = this.runPump();
    // Streaming-input mode: the CLI emits system/init (and thus the bound —
    // possibly rotated — session id) only after the first user message, so
    // start() returns immediately and the id arrives via the `ready` status.
    this.sessionId = sessionId ?? null;
    return this.sessionId;
  }

  async runPump() {
    try {
      for await (const message of this.query) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.emit(eventSessionStatus(this.cardId, 'ready', { sessionId: this.sessionId }));
        }
        this.emit(eventSessionEvent(this.cardId, message));
        if (message.type === 'result') {
          this.emit(eventSessionStatus(this.cardId, 'idle', { sessionId: this.sessionId }));
        }
      }
      if (!this.closed) this.emit(eventSessionStatus(this.cardId, 'closed', { sessionId: this.sessionId }));
    } catch (err) {
      if (!this.closed) {
        this.emit(eventSessionStatus(this.cardId, 'error', { detail: String(err?.message ?? err) }));
      }
    } finally {
      this.cancelAllRequests();
    }
  }

  requestPermission(kind, payload, signal) {
    const requestId = `${this.cardId}-r${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const entry = { resolve, signal, onAbort: null };
      entry.onAbort = () => {
        if (this.pendingRequests.delete(requestId)) {
          this.emit(eventSessionRequestCancelled(this.cardId, requestId));
          resolve({ behavior: 'deny', message: 'Request aborted' });
        }
      };
      if (signal) {
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pendingRequests.set(requestId, entry);
      this.emit(eventSessionRequest(this.cardId, requestId, kind, payload));
    });
  }

  decide(requestId, result) {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) throw new Error(`unknown or expired request: ${requestId}`);
    this.pendingRequests.delete(requestId);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(result);
  }

  cancelAllRequests() {
    for (const [requestId, entry] of this.pendingRequests) {
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      this.emit(eventSessionRequestCancelled(this.cardId, requestId));
      entry.resolve({ behavior: 'deny', message: 'Session closed' });
    }
    this.pendingRequests.clear();
  }

  send(text, images) {
    if (!this.query) throw new Error('session not started');
    this.input.push(userMessage(text, images));
    this.emit(eventSessionStatus(this.cardId, 'running', { sessionId: this.sessionId }));
  }

  async interrupt() {
    if (!this.query) throw new Error('session not started');
    await this.query.interrupt();
  }

  async setModel(model) {
    if (!this.query) throw new Error('session not started');
    await this.query.setModel(model || undefined);
  }

  async setPermissionMode(mode) {
    if (!this.query) throw new Error('session not started');
    await this.query.setPermissionMode(mode);
  }

  async stop() {
    this.closed = true;
    // Ending the input iterable is the real close signal: the SDK finishes the
    // current turn and shuts the CLI child down, which completes the pump.
    this.input.end();
    this.cancelAllRequests();
    try {
      // Best-effort only. An async generator suspended on an internal await
      // does not settle return() until that await resolves, so never wait here.
      const settled = this.query?.return?.(undefined);
      settled?.catch?.(() => {});
    } catch {
      // The generator may already be settled; stopping stays best-effort.
    }
    this.emit(eventSessionStatus(this.cardId, 'closed', { sessionId: this.sessionId }));
  }
}
