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
const CONTROL_TIMEOUT_MS = 10000;

// Permission modes Chat offers. bypassPermissions is deliberately absent: it needs
// allowDangerouslySkipPermissions at query start, which the user declined for Chat.
const MODE_CHOICES = [
  { value: 'default', name: 'Default' },
  { value: 'acceptEdits', name: 'Accept edits' },
  { value: 'plan', name: 'Plan' },
  { value: 'dontAsk', name: "Don't ask" },
];
const AUTO_MODE = { value: 'auto', name: 'Auto' };
// ThreadTerm's delegation tools as the SDK names them (runtime `delegation::TOOL_NAMES`).
export const THREADTERM_TOOLS = new Set(['delegate_start', 'delegate_status', 'delegate_wait', 'delegate_respond', 'delegate_result', 'delegate_cancel'].map(name => `mcp__threadterm__${name}`));
const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

// Commands the CLI advertises that cannot work from Chat: /clear replaces the native
// session id, the usage-credit and login commands open the user's browser, the rest
// are terminal-bound or internal handoffs. Each turn's terminal_slash_commands adds more.
export const HIDDEN_COMMANDS = new Set([
  'clear', 'extra-usage', 'usage-credits', 'login', 'logout',
  'doctor', 'color', 'reload-plugins', 'workflow-launch-exec',
]);

export const NOT_SIGNED_IN = 'Claude Code is not signed in. Run `claude auth login` (or /login in Claude Terminal), or configure an API key, apiKeyHelper or cloud provider for Claude Code. / Claude Code 未登录。请运行 `claude auth login`（或在 Claude 终端中使用 /login），或为 Claude Code 配置 API 密钥、apiKeyHelper 或云服务商。';

// The control handshake succeeds without credentials. Only an account that explicitly
// reports no token source on the first-party API, with no key, email or plan, is
// signed out; any other shape is left for the CLI to judge.
export function signedOut(account) {
  if (!account || typeof account !== 'object') return false;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return false;
  const present = value => typeof value === 'string' && value !== '' && value !== 'none';
  if (present(account.tokenSource) || present(account.apiKeySource) || account.email || account.subscriptionType) return false;
  return account.tokenSource === 'none' || account.apiKeySource === 'none';
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    // unref: a pending control request must never keep the host process alive.
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

export class ClaudeSession {
  constructor({ cardId, sdk, write, hostOptions = {} }) {
    this.cardId = cardId; this.sdk = sdk; this.write = write; this.hostOptions = hostOptions;
    this.input = createInputQueue(); this.query = null; this.sessionId = null;
    this.activeOperationId = null; this.pending = new Map(); this.nextRequest = 1; this.closed = false; this.ended = false; this.endError = null;
    this.abortStart = null;
    // Chat options and command menu, from the handshake and later native updates.
    this.catalog = { commands: [], models: [] }; this.terminalCommands = new Set();
    this.settings = { model: '', mode: 'default', effort: null };
    // API message ids that arrived as stream events; complete assistant messages
    // outside this set (local command output, synthetic errors) were never streamed.
    this.streamedIds = new Set();
    // The turn the user asked to stop; its result reports `interrupted`.
    this.interruptedOperation = null;
  }

  async start({ cwd, sessionId, mcpServers }) {
    if (this.closed) throw new Error('session is closed');
    // ThreadTerm attaches its delegation server to parent Chats; the parent's
    // calls to exactly those tools are approved without asking the user.
    const injected = mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) ? mcpServers : null;
    this.threadTermTools = Boolean(injected?.threadterm);
    const options = {
      cwd,
      settingSources: this.hostOptions.settingSources ?? ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      ...(this.hostOptions.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.hostOptions.pathToClaudeCodeExecutable } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...(injected ? { mcpServers: injected } : {}),
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
      const init = await Promise.race([
        this.query.initializationResult(), timeout, aborted,
        this.pump.then(() => { throw this.endError ?? new Error('Claude SDK query ended during initialization'); }),
      ]);
      if (signedOut(init?.account)) throw new Error(NOT_SIGNED_IN);
      this.catalog = {
        commands: Array.isArray(init?.commands) ? init.commands : [],
        models: Array.isArray(init?.models) ? init.models.filter(model => typeof model?.value === 'string') : [],
      };
      if (typeof init?.current_permission_mode === 'string') this.settings.mode = init.current_permission_mode;
      await this.refreshApplied({ model: true });
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
    this.warmUp();
    return this.sessionId;
  }

  // Opens the CLI's API connection while the user types, so a slow first connection
  // (e.g. through a proxy) does not delay the first reply (user decision 2026-10-01).
  // A full context count uses the token-count API, which is not billed. Never awaited;
  // a message sent meanwhile still runs.
  warmUp() {
    if (this.hostOptions.warmUp === false || typeof this.query?.getContextUsage !== 'function') return;
    this.warmUpDone = withTimeout(this.query.getContextUsage({ detail: 'full' }), 120000, 'Claude connection warm-up')
      .then(() => true, () => false);
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
          this.adoptTurnInit(message);
        }
        if (message.type === 'stream_event' && message.event?.type === 'message_start' && message.event.message?.id) this.streamedIds.add(message.event.message.id);
        const streamed = message.type === 'assistant' ? { streamed: this.streamedIds.has(message.message?.id) } : {};
        this.write(event(this.cardId, 'session.event', { message, sessionId: this.sessionId, operationId: this.activeOperationId, ...streamed }));
        if (message.type === 'system' && message.subtype === 'status' && typeof message.permissionMode === 'string') this.noteMode(message.permissionMode);
        if (message.type === 'system' && message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
          this.catalog.commands = message.commands;
          this.publishUi();
        }
        if (message.type === 'result') {
          // How the turn ended: a stopped or failed turn must not read as a
          // completed answer waiting for the user.
          const status = this.interruptedOperation !== null && this.interruptedOperation === this.activeOperationId ? 'interrupted'
            : message.is_error ? 'failed' : 'completed';
          this.write(event(this.cardId, 'session.status', { phase: 'idle', status, sessionId: this.sessionId, operationId: this.activeOperationId }));
          this.activeOperationId = null;
          this.interruptedOperation = null;
          this.streamedIds.clear();
          // A typed /effort (or a model downgrade) changes the applied effort without
          // any other signal; re-read it after each turn.
          this.refreshApplied({ model: false }).then(changed => { if (changed) this.publishUi(); });
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
    if (this.threadTermTools && THREADTERM_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const requestId = `${this.cardId}-permission-${this.nextRequest++}`;
    const operationId = this.activeOperationId;
    const sessionId = this.sessionId;
    return new Promise(resolve => {
      // Registration precedes any cancellation check, and every exit path
      // settles exactly once through settle().
      // The SDK's own suggestions are kept here; "always" answers never trust a
      // rule echoed back from the renderer.
      const entry = { signal: signal ?? null, abort: null, published: false, settle: null, suggestions: Array.isArray(suggestions) ? suggestions : [] };
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
    if (behavior === 'allow_always') {
      if (!entry.suggestions.length) throw new Error(`permission request offered no rule to remember: ${requestId}`);
      const suggestions = entry.suggestions;
      entry.settle({ behavior: 'allow', updatedPermissions: suggestions });
      // e.g. Write suggests setMode acceptEdits; the CLI applies it, so follow it.
      const mode = suggestions.findLast(update => update?.type === 'setMode' && typeof update.mode === 'string')?.mode;
      if (mode) this.noteMode(mode);
      return;
    }
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error(`unsupported permission decision: ${behavior}`);
    entry.settle(behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by user' });
  }

  adoptTurnInit(message) {
    let changed = false;
    for (const name of Array.isArray(message.terminal_slash_commands) ? message.terminal_slash_commands : []) {
      if (typeof name === 'string' && !this.terminalCommands.has(name)) { this.terminalCommands.add(name); changed = true; }
    }
    if (typeof message.permissionMode === 'string' && message.permissionMode !== this.settings.mode) {
      this.settings.mode = message.permissionMode; changed = true;
    }
    // init reports the resolved id (claude-sonnet-5); keep the chosen alias while it
    // still resolves to that id, so Default and Sonnet do not swap.
    if (typeof message.model === 'string' && message.model && message.model !== this.settings.model
      && this.resolvedModel(this.settings.model) !== message.model) {
      this.settings.model = this.modelValueFor(message.model); changed = true;
    }
    if (changed) this.publishUi();
  }

  noteMode(mode) {
    if (mode === this.settings.mode) return;
    this.settings.mode = mode;
    this.publishUi();
  }

  modelValueFor(id) {
    const models = this.catalog.models;
    if (models.some(model => model.value === id)) return id;
    if (models.some(model => model.value === 'default' && model.resolvedModel === id)) return 'default';
    return models.find(model => model.resolvedModel === id)?.value ?? id;
  }

  resolvedModel(value) {
    return this.catalog.models.find(model => model.value === value)?.resolvedModel ?? value;
  }

  // Reads the applied model/effort with control requests only; never a model turn.
  // After start, the model comes from each turn's init instead: with Haiku selected,
  // plan mode runs on Sonnet and applied settings would misreport the selection.
  async refreshApplied({ model }) {
    const query = this.query;
    let applied = null;
    try {
      if (typeof query?.getSettings === 'function') applied = (await withTimeout(query.getSettings(), CONTROL_TIMEOUT_MS, 'Claude settings read'))?.applied ?? null;
      else if (model && typeof query?.getContextUsage === 'function') applied = { model: (await withTimeout(query.getContextUsage({ detail: 'summary' }), CONTROL_TIMEOUT_MS, 'Claude context read'))?.model };
    } catch { return false; }
    if (!applied || this.closed) return false;
    let changed = false;
    if (model && typeof applied.model === 'string' && applied.model && this.resolvedModel(this.settings.model) !== applied.model) {
      this.settings.model = this.modelValueFor(applied.model); changed = true;
    }
    if ('effort' in applied) {
      const effort = typeof applied.effort === 'string' && applied.effort ? applied.effort : null;
      if (effort !== this.settings.effort) { this.settings.effort = effort; changed = true; }
    }
    return changed;
  }

  uiState() {
    const current = this.catalog.models.find(model => model.value === this.settings.model);
    const modelChoices = this.catalog.models.map(model => ({ value: model.value, name: model.displayName || model.value }));
    if (this.settings.model && !current) modelChoices.push({ value: this.settings.model, name: this.settings.model });
    const efforts = Array.isArray(current?.supportedEffortLevels) ? current.supportedEffortLevels.filter(level => typeof level === 'string') : [];
    const options = [];
    if (modelChoices.length) options.push({ id: 'model', name: 'Model', value: this.settings.model, choices: modelChoices });
    if (efforts.length && this.settings.effort) {
      options.push({ id: 'thinking', name: 'Thinking', value: this.settings.effort, choices: efforts.map(level => ({ value: level, name: EFFORT_NAMES[level] ?? level })) });
    }
    options.push({ id: 'mode', name: 'Permission mode', value: this.settings.mode, choices: [...MODE_CHOICES, ...(current?.supportsAutoMode ? [AUTO_MODE] : [])] });
    const commands = this.catalog.commands
      .filter(command => typeof command?.name === 'string' && command.name && !command.name.startsWith('__')
        && !HIDDEN_COMMANDS.has(command.name) && !this.terminalCommands.has(command.name))
      .map(command => ({ name: command.name, ...(typeof command.description === 'string' && command.description ? { description: command.description } : {}) }));
    return { options, commands };
  }

  publishUi() {
    const ui = this.uiState();
    if (!this.closed) this.write(event(this.cardId, 'session.ui', { ui, sessionId: this.sessionId }));
    return ui;
  }

  async setOption(optionId, value) {
    if (this.ended || this.closed || !this.query) throw new Error('session worker has ended');
    const option = this.uiState().options.find(candidate => candidate.id === optionId);
    if (!option) throw new Error(`unknown Claude option: ${optionId}`);
    if (!option.choices.some(choice => choice.value === value)) throw new Error(`${value} is not an available ${option.name} choice`);
    if (optionId === 'model') {
      await withTimeout(this.query.setModel(value), CONTROL_TIMEOUT_MS, 'Claude model change');
      this.settings.model = value;
      // The new model may cap or drop the effort level.
      await this.refreshApplied({ model: false });
    } else if (optionId === 'thinking') {
      await withTimeout(this.query.applyFlagSettings({ effortLevel: value }), CONTROL_TIMEOUT_MS, 'Claude effort change');
      this.settings.effort = value;
    } else {
      await withTimeout(this.query.setPermissionMode(value), CONTROL_TIMEOUT_MS, 'Claude permission mode change');
      this.settings.mode = value;
    }
    return this.publishUi();
  }

  cancelPermissions(message) {
    for (const [requestId] of [...this.pending]) {
      this.pending.get(requestId)?.settle({ behavior: 'deny', message }, { cancelled: true });
    }
  }

  async interrupt() {
    if (!this.query) throw new Error('session not started');
    this.interruptedOperation = this.activeOperationId;
    await this.query.interrupt();
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.abortStart?.();
    this.input.end(); this.cancelPermissions('Session stopped');
    try { this.query?.return?.(undefined)?.catch?.(() => {}); } catch {}
    this.write(event(this.cardId, 'session.status', { phase: 'closed', sessionId: this.sessionId }));
  }
}
