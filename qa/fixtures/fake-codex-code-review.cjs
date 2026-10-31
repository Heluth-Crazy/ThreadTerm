// QA-only Codex app-server for Chat Code Review. Never launches a real model.
// Finder turns return one finding; verifier turns confirm candidates by id.
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

const log = process.env.THREADTERM_QA_CODE_REVIEW_LOG;
const hold = process.env.THREADTERM_QA_CODE_REVIEW_HOLD;
if (!log) process.exit(2);
if (process.argv.includes('--version')) {
  process.stdout.write('codex_cli_rs/qa-code-review-fixture\n');
  process.exit(0);
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  process.stdout.write('authenticated QA code-review fixture\n');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('QA-only Codex app-server for code review\n');
  process.exit(0);
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (method, params) => appendFileSync(log, `${JSON.stringify({ method, params })}\n`);
const result = (id, value) => send({ id, result: value });
const event = (method, params) => { record(`event.${method}`, params); send({ method, params }); };
const settings = () => ({
  model: 'qa-code-review-model',
  reasoningEffort: 'medium',
  approvalPolicy: 'on-request',
  sandboxPolicy: { type: 'readOnly', networkAccess: false, writableRoots: [] },
  collaborationMode: { mode: 'default', settings: { model: 'qa-code-review-model', reasoning_effort: 'medium' } },
});
const threads = new Map();
const pending = new Map();

function answerFor(text) {
  if (text.includes('Candidate findings to verify')) {
    const match = text.match(/## Candidate findings to verify\s+([\s\S]*?)\s+## Required final response/);
    let candidates = [];
    try { candidates = JSON.parse(match?.[1] ?? '[]'); } catch { candidates = []; }
    const verified = (Array.isArray(candidates) ? candidates : []).map((row) => ({
      id: row.id,
      severity: row.severity || 'high',
      path: row.path,
      line: row.line,
      title: row.title || 'finding',
      body: row.body || '',
      verdict: 'confirmed',
      reason: 'still reproduces',
    }));
    return `\`\`\`threadterm-review\n${JSON.stringify(verified)}\n\`\`\``;
  }
  return '```threadterm-review\n[{"severity":"high","path":"src/bug.ts","line":3,"title":"Null dereference","body":"Reads .x without a guard.","category":"correctness","failureScenario":"Call with null input."}]\n```';
}

function completeTurn(threadId, turnId, text) {
  const answer = answerFor(text);
  event('item/completed', {
    threadId,
    turnId,
    item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: answer },
  });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  record(method, params);
  if (method === 'initialize') return result(id, { capabilities: {} });
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return result(id, {});
  if (method === 'skills/list') return result(id, { data: [] });
  if (method === 'model/list') {
    return result(id, {
      data: [{ id: 'qa-code-review-model', displayName: 'QA code review model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
    });
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    const threadId = method === 'thread/resume' && params.threadId ? params.threadId : randomUUID();
    const thread = { id: threadId, cwd: params.cwd, status: { type: 'idle' }, turns: [], settings: settings() };
    threads.set(threadId, thread);
    return result(id, { thread, threadSettings: thread.settings, model: thread.settings.model, reasoningEffort: thread.settings.reasoningEffort });
  }
  if (method === 'thread/read') {
    const thread = threads.get(params.threadId) || { id: params.threadId, cwd: '', status: { type: 'idle' }, turns: [], settings: settings() };
    return result(id, { thread, threadSettings: thread.settings });
  }
  if (method === 'thread/inject_items') return result(id, {});
  if (method === 'thread/settings/update') {
    const thread = threads.get(params.threadId);
    if (thread) {
      thread.settings = { ...thread.settings, ...params };
      event('thread/settings/updated', { threadId: params.threadId, threadSettings: thread.settings });
      return result(id, { threadSettings: thread.settings });
    }
    return result(id, { threadSettings: settings() });
  }
  if (method === 'turn/start') {
    const threadId = params.threadId;
    const text = (params.input || []).map((item) => item.text || '').join('\n');
    const turnId = randomUUID();
    event('turn/started', { threadId, turn: { id: turnId } });
    result(id, { turn: { id: turnId } });
    const shouldHold = text.includes('QA_HOLD_REVIEW') || (hold && existsSync(hold) && readFileSync(hold, 'utf8').trim() === '1');
    if (shouldHold) {
      pending.set(turnId, { threadId, text });
      return;
    }
    completeTurn(threadId, turnId, text);
    return;
  }
  if (method === 'turn/interrupt') {
    for (const [turnId, value] of pending) {
      event('turn/completed', { threadId: value.threadId, turn: { id: turnId, status: 'interrupted' } });
      pending.delete(turnId);
    }
    return result(id, {});
  }
  return send({ id, error: { code: -32601, message: `Unexpected QA request: ${method}` } });
});

// Allow the harness to release a held turn by clearing the hold file and writing release ids.
if (hold) {
  setInterval(() => {
    if (!existsSync(hold) || readFileSync(hold, 'utf8').trim() === '1') return;
    for (const [turnId, value] of [...pending]) {
      pending.delete(turnId);
      completeTurn(value.threadId, turnId, value.text);
    }
  }, 50).unref?.();
}
