import { randomUUID } from 'node:crypto';
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
export const THREADTERM_DELEGATION_TOOLS = new Set(['delegate_start', 'delegate_status', 'delegate_wait', 'delegate_respond', 'delegate_result', 'delegate_cancel'].map(name => `mcp__threadterm__${name}`));
export const THREADTERM_PREVIEW_TOOLS = new Set(['preview_present', 'preview_status'].map(name => `mcp__threadterm__${name}`));
export const THREADTERM_CHAT_TOOLS = new Set(['ask_user', 'session_info', 'feedback_check'].map(name => `mcp__threadterm__${name}`));
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
    this.activeOperationId = null; this.pending = new Map(); this.requestGeneration = randomUUID(); this.nextRequest = 1; this.closed = false; this.ended = false; this.endError = null;
    this.abortStart = null;
    // Chat options and command menu, from the handshake and later native updates.
    this.catalog = { commands: [], models: [] }; this.terminalCommands = new Set();
    this.settings = { model: '', mode: 'default', effort: null };
    // API message ids that arrived as stream events; complete assistant messages
    // outside this set (local command output, synthetic errors) were never streamed.
    this.streamedIds = new Set();
    // Context reads can settle out of order within one worker. Keep only the
    // snapshot associated with the latest completed turn.
    this.contextSequence = 0;
    // The turn the user asked to stop; its result reports `interrupted`.
    this.interruptedOperation = null;
    // Native background membership and lifecycle. Finished rows remain through
    // the current parent turn and are cleared only when the next turn starts.
    this.backgroundTasks = new Map();
    this.backgroundToolIds = new Set();
    this.nativeBackgroundTaskIds = new Set();
    this.retiredBackgroundIds = new Set();
    this.backgroundStops = new Map();
  }

  async start({ cwd, sessionId, mcpServers }) {
    if (this.closed) throw new Error('session is closed');
    // Only credentials supplied by ThreadTerm's core-managed MCP server permit
    // automatic approval; a similarly named arbitrary MCP server cannot.
    const injected = mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) ? mcpServers : null;
    const threadterm = injected?.threadterm;
    const environment = threadterm?.env && typeof threadterm.env === 'object' ? threadterm.env : {};
    this.threadTermDelegationTools = threadterm?.name === undefined && typeof environment.THREADTERM_SESSION_TOKEN === 'string' && environment.THREADTERM_SESSION_TOKEN.length > 0;
    this.threadTermPreviewTools = threadterm?.name === undefined && typeof environment.THREADTERM_PREVIEW_TOKEN === 'string' && environment.THREADTERM_PREVIEW_TOKEN.length > 0;
    this.threadTermAskTool = threadterm?.name === undefined && typeof environment.THREADTERM_CHAT_TOKEN === 'string' && environment.THREADTERM_CHAT_TOKEN.length > 0 && environment.THREADTERM_CHAT_TOOL_ASK === '1';
    this.threadTermSessionInfoTool = threadterm?.name === undefined && typeof environment.THREADTERM_CHAT_TOKEN === 'string' && environment.THREADTERM_CHAT_TOKEN.length > 0 && environment.THREADTERM_CHAT_TOOL_SESSION_INFO === '1';
    this.threadTermFeedbackTool = threadterm?.name === undefined && typeof environment.THREADTERM_CHAT_TOKEN === 'string' && environment.THREADTERM_CHAT_TOKEN.length > 0 && environment.THREADTERM_CHAT_TOOL_FEEDBACK === '1';
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
    // A prior turn's outstanding context read must not publish into this turn.
    this.contextSequence += 1;
    const before = this.backgroundTasks.size;
    for (const task of this.backgroundTasks.values()) {
      if (task.status === 'running') continue;
      this.retiredBackgroundIds.add(task.id);
      if (task.toolId) this.retiredBackgroundIds.add(task.toolId);
      this.nativeBackgroundTaskIds.delete(task.id);
      this.backgroundToolIds.delete(task.toolId);
      this.backgroundStops.delete(task.id);
    }
    // Native task/tool IDs are unique within one SDK query. Keep a bounded
    // retirement window, like the runtime's other late-event fences.
    while (this.retiredBackgroundIds.size > 512) this.retiredBackgroundIds.delete(this.retiredBackgroundIds.values().next().value);
    this.backgroundTasks = new Map([...this.backgroundTasks].filter(([, task]) => task.status === 'running'));
    if (this.backgroundTasks.size !== before) this.publishUi();
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
        if (this.observeBackgroundMessage(message)) this.publishUi();
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
          this.readContextUsage(message, this.activeOperationId);
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

  requestPermission(toolName, input, { signal, suggestions, toolUseID, agentID } = {}) {
    if (this.closed || this.ended) return Promise.resolve({ behavior: 'deny', message: 'Session closed' });
    if (toolName === 'ExitPlanMode' && [...this.pending.values()].some(entry => entry.plan)) return Promise.resolve({ behavior: 'deny', message: 'A plan approval is already pending.' });
    if ((this.threadTermDelegationTools && THREADTERM_DELEGATION_TOOLS.has(toolName))
      || (this.threadTermPreviewTools && THREADTERM_PREVIEW_TOOLS.has(toolName))
      || (this.threadTermAskTool && toolName === 'mcp__threadterm__ask_user')
      || (this.threadTermSessionInfoTool && toolName === 'mcp__threadterm__session_info')
      || (this.threadTermFeedbackTool && toolName === 'mcp__threadterm__feedback_check')) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    // Projection keys approvals by Chat session and request id. A fresh worker
    // for the same Chat must therefore never restart the request-id sequence in
    // the same namespace and overwrite an answered receipt from its predecessor.
    const requestId = `${this.cardId}-permission-${this.requestGeneration}-${this.nextRequest++}`;
    const operationId = this.activeOperationId;
    const sessionId = this.sessionId;
    return new Promise(resolve => {
      // Registration precedes any cancellation check, and every exit path
      // settles exactly once through settle().
      // The SDK's own suggestions are kept here; "always" answers never trust a
      // rule echoed back from the renderer.
      const question = toolName === 'AskUserQuestion' && Array.isArray(input?.questions);
      const plan = toolName === 'ExitPlanMode';
      const entry = { signal: signal ?? null, abort: null, published: false, settle: null, suggestions: Array.isArray(suggestions) ? suggestions : [], question, plan, input };
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
      this.write(event(this.cardId, 'session.request', {
        requestId, toolName, ...(question ? { question: { questions: input.questions } } : { input }), suggestions, operationId, sessionId,
        ...(typeof agentID === 'string' ? { agentId: agentID } : {}),
        ...(typeof toolUseID === 'string' ? { toolUseId: toolUseID } : {}),
      }));
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

  /** Resolve the plan-mode ExitPlanMode request. */
  async planResponse(requestId, action, feedback) {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`unknown or expired plan request: ${requestId}`);
    if (!entry.plan) throw new Error(`request is not an ExitPlanMode plan request: ${requestId}`);
    if (action === 'approve') {
      entry.settle({ behavior: 'allow' });
      // Give the SDK callback its allow result before requesting the explicit
      // streaming-mode transition.
      await Promise.resolve();
      // Allow ExitPlanMode first, then return the streaming session to the
      // default mode Claude Code uses for implementation.
      if (this.settings.mode === 'plan') {
        try {
          await withTimeout(this.query.setPermissionMode('default'), CONTROL_TIMEOUT_MS, 'Claude plan approval mode change');
          this.noteMode('default');
        } catch (error) {
          // ExitPlanMode was already allowed, so retrying this card would target
          // a native request that no longer exists. Return a terminal partial
          // receipt and direct recovery through a worker reconnect.
          const message = String(error?.message ?? error).slice(0, 500);
          return { outcome: 'partial', nativeDecision: 'allowed', modeChanged: false, recovery: 'reconnect', message };
        }
      }
      return { outcome: 'submitted', nativeDecision: 'allowed', modeChanged: true };
    }
    if (action !== 'request_changes' && action !== 'abandon') throw new Error(`unsupported plan response: ${action}`);
    const message = action === 'abandon'
      ? 'Please abandon the plan and remain in plan mode.'
      : typeof feedback === 'string' && feedback.trim() ? feedback : 'Please revise the plan.';
    entry.settle({ behavior: 'deny', message });
    return { outcome: 'submitted', nativeDecision: 'denied', modeChanged: false };
  }

  answer(requestId, values) {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`unknown or expired question request: ${requestId}`);
    if (!entry.question) throw new Error(`request is not a question: ${requestId}`);
    if (values === null || values === undefined) {
      entry.settle({ behavior: 'deny', message: 'The user dismissed the question.' });
      return;
    }
    const answers = {};
    for (let index = 0; index < entry.input.questions.length; index += 1) {
      const question = entry.input.questions[index];
      const selected = values[`q${index}`];
      answers[question.question] = Array.isArray(selected) ? selected.join(', ') : '';
    }
    entry.settle({ behavior: 'allow', updatedInput: { ...entry.input, answers } });
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

  // Reads the current context window once per completed turn. This is the one
  // place the CLI's token-count API is consulted outside warm-up, and it is
  // never polled while idle. A failed or slow read simply produces no event.
  readContextUsage(message, operationId) {
    const contextSequence = ++this.contextSequence;
    if (typeof this.query?.getContextUsage !== 'function') return;
    const usage = message?.usage ?? {};
    const read = withTimeout(this.query.getContextUsage({ detail: 'summary' }), CONTROL_TIMEOUT_MS, 'Claude context read');
    Promise.resolve(read).then(info => {
      if (this.closed || contextSequence !== this.contextSequence) return;
      const payload = {};
      const put = (key, value) => { if (typeof value === 'number' && Number.isFinite(value) && value > 0) payload[key] = value; };
      put('usedTokens', info?.totalTokens);
      put('windowTokens', info?.maxTokens);
      put('percent', info?.percentage);
      put('inputTokens', usage.input_tokens);
      put('outputTokens', usage.output_tokens);
      put('cacheReadTokens', usage.cache_read_input_tokens);
      put('cacheWriteTokens', usage.cache_creation_input_tokens);
      const total = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
        + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      put('totalTokens', total);
      if (!Object.keys(payload).length) return;
      this.write(event(this.cardId, 'session.context', { usage: payload, sessionId: this.sessionId, operationId }));
    }, () => {});
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
    return { options, commands, backgroundTasks: [...this.backgroundTasks.values()] };
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

  observeBackgroundMessage(message) {
    if (!message || typeof message !== 'object' || message.ambient === true || message.skip_transcript === true) return false;
    let changed = false;
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (this.retiredBackgroundIds.has(block.id)) continue;
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      if (input.run_in_background !== true) continue;
      const command = typeof input.command === 'string' && input.command ? input.command : undefined;
      const title = (typeof input.description === 'string' && input.description) || command || block.name || 'Background task';
      this.backgroundToolIds.add(block.id);
      if (!this.backgroundTasks.has(block.id)) {
        this.backgroundTasks.set(block.id, { id: block.id, title, ...(command ? { command } : {}), status: 'running', startedAt: new Date().toISOString(), canStop: false, toolId: block.id });
        changed = true;
      }
    }
    if (message.type !== 'system') return changed;
    const subtype = message.subtype;
    if (subtype === 'background_tasks_changed') {
      const rows = [message.tasks, message.background_tasks, message.backgroundTasks].find(Array.isArray) ?? [];
      const next = new Set();
      for (const row of rows) {
        const taskId = typeof row === 'string' ? row : row?.task_id ?? row?.taskId ?? row?.id;
        if (typeof taskId !== 'string' || !taskId) continue;
        if (row?.ambient === true || row?.skip_transcript === true || this.retiredBackgroundIds.has(taskId)) continue;
        next.add(taskId);
        this.nativeBackgroundTaskIds.add(taskId);
        if (row && typeof row === 'object') changed = this.observeBackgroundMessage({ type: 'system', subtype: 'task_started', task_id: taskId, ...row, is_backgrounded: true }) || changed;
      }
      for (const taskId of this.nativeBackgroundTaskIds) {
        if (next.has(taskId)) continue;
        const task = this.backgroundTasks.get(taskId);
        if (task?.status === 'running') {
          // Membership only confirms that work ended; a later task_notification
          // refines completed to failed/stopped. Do not invent a Stop result.
          this.backgroundTasks.set(taskId, { ...task, status: 'completed', canStop: false, endedAt: new Date().toISOString() });
          this.backgroundStops.delete(taskId);
          changed = true;
        }
      }
      this.nativeBackgroundTaskIds = next;
      return changed;
    }
    if (!['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(subtype)) return changed;
    const taskId = message.task_id ?? message.taskId;
    if (typeof taskId !== 'string' || !taskId) return changed;
    const toolId = message.tool_use_id ?? message.toolUseId;
    if (this.retiredBackgroundIds.has(taskId) || this.retiredBackgroundIds.has(toolId)) return changed;
    const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
    const explicitBackground = message.is_backgrounded === true || patch.is_backgrounded === true;
    const member = explicitBackground || this.nativeBackgroundTaskIds.has(taskId)
      || (typeof toolId === 'string' && this.backgroundToolIds.has(toolId)) || this.backgroundTasks.has(taskId);
    if (!member) return changed;
    this.nativeBackgroundTaskIds.add(taskId);
    let prior = this.backgroundTasks.get(taskId);
    if (!prior && typeof toolId === 'string') {
      prior = this.backgroundTasks.get(toolId);
      if (prior) this.backgroundTasks.delete(toolId);
    }
    const command = (typeof message.command === 'string' && message.command) || prior?.command;
    const title = (typeof patch.description === 'string' && patch.description)
      || (typeof message.description === 'string' && message.description)
      || (typeof message.summary === 'string' && message.summary)
      || command || prior?.title || 'Background task';
    const rawStatus = subtype === 'task_notification' ? message.status : patch.status;
    if (prior && prior.status !== 'running' && !['completed', 'failed', 'stopped', 'killed', 'cancelled'].includes(rawStatus)) return changed;
    const status = rawStatus === 'completed' ? 'completed'
      : rawStatus === 'failed' ? 'failed'
      : ['stopped', 'killed', 'cancelled'].includes(rawStatus) ? 'stopped' : 'running';
    const next = {
      id: taskId, title, ...(command ? { command } : {}), status,
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      ...(status === 'running' ? {} : { endedAt: prior?.endedAt ?? new Date().toISOString() }),
      canStop: status === 'running' && typeof this.query?.stopTask === 'function',
      ...(typeof toolId === 'string' ? { toolId } : prior?.toolId ? { toolId: prior.toolId } : {}),
    };
    if (JSON.stringify(prior) !== JSON.stringify(next)) {
      this.backgroundTasks.set(taskId, next);
      changed = true;
    }
    if (status !== 'running') this.backgroundStops.delete(taskId);
    return changed;
  }

  async stopTask(taskId) {
    if (this.ended || this.closed || !this.query) throw new Error('session worker has ended');
    const task = this.backgroundTasks.get(taskId);
    if (!task) throw new Error(`background task does not belong to this session: ${taskId}`);
    if (task.status !== 'running') throw new Error(`background task is no longer running: ${taskId}`);
    if (typeof this.query.stopTask !== 'function' || !task.canStop) throw new Error('background task stop is not supported');
    if (!this.backgroundStops.has(taskId)) {
      // Keep the same promise even after a control timeout/rejection. The
      // native action may have happened; only a terminal event can retire it.
      this.backgroundStops.set(taskId, Promise.resolve().then(() => withTimeout(this.query.stopTask(taskId), CONTROL_TIMEOUT_MS, 'Claude background task stop')));
    }
    await this.backgroundStops.get(taskId);
    // The promise acknowledges the command only. A native task notification or
    // background_tasks_changed event owns the terminal status and timestamp.
    return true;
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
    this.backgroundStops.clear();
    this.abortStart?.();
    this.input.end(); this.cancelPermissions('Session stopped');
    try { this.query?.return?.(undefined)?.catch?.(() => {}); } catch {}
    this.write(event(this.cardId, 'session.status', { phase: 'closed', sessionId: this.sessionId }));
  }
}
