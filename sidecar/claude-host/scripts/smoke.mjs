// Headless smoke for the real sidecar over NDJSON stdio (implement.md step 7)
// plus the session-id-rotation spike (step 8).
// Usage: node scripts/smoke.mjs <cwd> [sidecar-entry]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.argv[2];
const entry = process.argv[3] || join(here, '..', 'dist', 'claude-host.mjs');
if (!cwd) {
  console.error('usage: node scripts/smoke.mjs <cwd> [sidecar-entry]');
  process.exit(2);
}
mkdirSync(cwd, { recursive: true });

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    THREADTERM_CLAUDE_PATH:
      process.env.THREADTERM_CLAUDE_PATH ?? process.env.CLAUDE_PATH ?? '',
    // Hermetic: no user/project settings, so no allow-rules can swallow the
    // permission prompt this smoke asserts on.
    THREADTERM_CLAUDE_SETTING_SOURCES: '',
  },
});
child.stderr.on('data', (chunk) => process.stderr.write(`[sidecar] ${chunk}`));

let nextId = 0;
const pendingResponses = new Map();
const eventLog = [];
const eventWaiters = [];

function send(op, params = {}) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingResponses.delete(id)) reject(new Error(`timeout waiting for ${op} (#${id})`));
    }, 120_000).unref();
  });
}

// Waits for an event arriving AFTER this call (never satisfied by history).
function waitNextEvent(predicate, label, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for event: ${label}`)), timeoutMs);
    timer.unref();
    eventWaiters.push({ predicate, resolve, timer });
  });
}

// A single turn can raise several permission requests (models often Read
// before they Write), so every request is auto-approved as it arrives.
const approvedTools = [];
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    console.error(`[smoke] non-JSON stdout line: ${line}`);
    return;
  }
  if (Number.isInteger(value.id)) {
    const pending = pendingResponses.get(value.id);
    if (!pending) return;
    pendingResponses.delete(value.id);
    if (value.error) pending.reject(new Error(value.error.message));
    else pending.resolve(value.ok);
    return;
  }
  if (value.ev === 'session.request' && value.kind === 'can_use_tool') {
    approvedTools.push(value.toolName);
    send('session.decision', {
      cardId: value.cardId,
      requestId: value.requestId,
      behavior: 'allow',
    }).catch((err) => console.error(`[smoke] auto-approve failed: ${err.message}`));
  }
  eventLog.push(value);
  for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
    if (eventWaiters[i].predicate(value)) {
      const [waiter] = eventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }
});

const readyOf = (cardId) => (e) =>
  e.ev === 'session.status' && e.cardId === cardId && e.phase === 'ready' && e.sessionId;

const summary = {};
try {
  // 1. ping
  const pong = await send('host.ping');
  if (!pong.pong) throw new Error('ping failed');
  summary.ping = 'ok';

  // 2. fresh session: start returns no id yet (streaming-input semantics).
  // haiku keeps the smoke fast and cheap; the wire path is model-agnostic.
  const started = await send('session.start', { cardId: 'smoke', cwd, model: 'haiku' });
  summary.startReturnedId = started.sessionId;

  // 3. first turn needs a Bash approval; allow it
  const readyPromise = waitNextEvent(readyOf('smoke'), 'ready(smoke)');
  // A write is what reliably reaches canUseTool: the CLI auto-allows commands
  // it classifies as trivially safe (a bare `echo` never prompts).
  await send('session.send', {
    cardId: 'smoke',
    text: 'Create a file named smoke.txt in the current directory containing the single word THREADTERM_SMOKE. Then reply DONE.',
  });
  const ready = await readyPromise;
  summary.firstSessionId = ready.sessionId;
  const firstResult = await waitNextEvent(
    (e) => e.ev === 'session.event' && e.cardId === 'smoke' && e.message?.type === 'result',
    'first turn result',
  );
  summary.firstTurn = firstResult.message.subtype;
  summary.approvedTools = approvedTools.join(',');
  summary.sawStream = eventLog.some(
    (e) => e.ev === 'session.event' && e.message?.type === 'stream_event',
  );
  summary.sawToolUse = eventLog.some(
    (e) =>
      e.ev === 'session.event' &&
      e.message?.type === 'assistant' &&
      (e.message.message?.content ?? []).some((b) => b.type === 'tool_use'),
  );

  // 4. history through the SDK
  const history = await send('session.history', { sessionId: summary.firstSessionId, dir: cwd });
  summary.historyMessages = Array.isArray(history.messages) ? history.messages.length : -1;

  // 5. second turn, interrupted mid-stream
  const secondResultPromise = waitNextEvent(
    (e) => e.ev === 'session.event' && e.cardId === 'smoke' && e.message?.type === 'result',
    'second turn result after interrupt',
  );
  const secondStreamPromise = waitNextEvent(
    (e) => e.ev === 'session.event' && e.cardId === 'smoke' && e.message?.type === 'stream_event',
    'second turn streaming',
  );
  await send('session.send', {
    cardId: 'smoke',
    text: 'Count from 1 to 50 slowly, one number per line, thinking carefully about each.',
  });
  await secondStreamPromise;
  await send('session.interrupt', { cardId: 'smoke' });
  const secondResult = await secondResultPromise;
  summary.interruptedTurn = secondResult.message.subtype;

  // 6. stop, then the rotation spike: resume the same session id and send once
  await send('session.stop', { cardId: 'smoke' });
  const resumed = await send('session.start', {
    cardId: 'smoke2',
    cwd,
    sessionId: summary.firstSessionId,
    model: 'haiku',
  });
  summary.resumeStartReturnedId = resumed.sessionId;
  const resumedReadyPromise = waitNextEvent(readyOf('smoke2'), 'ready(smoke2)');
  await send('session.send', { cardId: 'smoke2', text: 'Reply with exactly: RESUMED' });
  const resumedReady = await resumedReadyPromise;
  summary.resumedSessionId = resumedReady.sessionId;
  summary.sessionIdRotated = resumedReady.sessionId !== summary.firstSessionId;
  await waitNextEvent(
    (e) => e.ev === 'session.event' && e.cardId === 'smoke2' && e.message?.type === 'result',
    'resumed turn result',
  );
  const resumedHistory = await send('session.history', {
    sessionId: resumedReady.sessionId,
    dir: cwd,
  });
  summary.resumedHistoryMessages = Array.isArray(resumedHistory.messages)
    ? resumedHistory.messages.length
    : -1;
  await send('session.stop', { cardId: 'smoke2' });

  console.log(`[summary] ${JSON.stringify(summary, null, 2)}`);
  const pass =
    summary.ping === 'ok' &&
    summary.firstTurn === 'success' &&
    summary.sawStream &&
    summary.sawToolUse &&
    approvedTools.length > 0 &&
    summary.historyMessages > 0 &&
    summary.resumedHistoryMessages > summary.historyMessages;
  console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
  child.stdin.end();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`[smoke] ${err.stack ?? err}`);
  console.error(`[summary-partial] ${JSON.stringify(summary)}`);
  console.error(`[events] ${JSON.stringify(eventLog.slice(-10))}`);
  child.kill();
  process.exit(1);
}
