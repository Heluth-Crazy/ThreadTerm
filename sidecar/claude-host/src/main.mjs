// ThreadTerm Claude chat sidecar entry point.
// stdin:  NDJSON requests from the Rust backend (one per line).
// stdout: NDJSON responses/events only — nothing else may write here.
// stderr: logs and diagnostics.

import { createInterface } from 'node:readline';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { parseRequestLine, responseOk, responseError, eventHostFatal } from './protocol.mjs';
import { CardSession } from './session.mjs';

// Anything that would normally print to stdout must go to stderr instead so a
// stray dependency log cannot corrupt the NDJSON stream.
for (const level of ['log', 'info', 'warn', 'debug']) {
  console[level] = (...args) => process.stderr.write(`[console.${level}] ${args.join(' ')}\n`);
}

// Swallow stdout failures: once the Rust host is gone (EPIPE) there is nobody
// left to report to, and throwing from here would double-fault the fatal path.
process.stdout.on('error', () => {});
const write = (value) => {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    // Host side already tore the pipe down.
  }
};
// THREADTERM_CLAUDE_SETTING_SOURCES: unset -> full TUI parity; empty string ->
// no settings (hermetic smoke/tests); otherwise a comma-separated subset.
const settingSourcesEnv = process.env.THREADTERM_CLAUDE_SETTING_SOURCES;
const hostOptions = {
  pathToClaudeCodeExecutable: process.env.THREADTERM_CLAUDE_PATH || undefined,
  ...(settingSourcesEnv !== undefined
    ? { settingSources: settingSourcesEnv === '' ? [] : settingSourcesEnv.split(',') }
    : {}),
};
const sessions = new Map();

function getSession(cardId) {
  const session = sessions.get(cardId);
  if (!session) throw new Error(`no session for card: ${cardId}`);
  return session;
}

async function handle(request) {
  const { op } = request;
  switch (op) {
    case 'host.ping':
      return { pong: true, pid: process.pid };
    case 'session.start': {
      const { cardId, cwd, sessionId, forkSession, model, permissionMode } = request;
      if (typeof cardId !== 'string' || !cardId) throw new Error('cardId is required');
      if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is required');
      if (sessions.has(cardId)) throw new Error(`session already exists for card: ${cardId}`);
      const session = new CardSession({ cardId, emit: write, sdk, hostOptions });
      sessions.set(cardId, session);
      try {
        // Returns the pre-resume id (or null for a new session); the bound —
        // possibly rotated — id arrives via the `ready` status event after
        // the first message (streaming-input init semantics).
        const knownSessionId = session.start({
          cwd,
          sessionId: sessionId || undefined,
          forkSession: Boolean(forkSession),
          model: model || undefined,
          permissionMode: permissionMode || undefined,
        });
        return { sessionId: knownSessionId };
      } catch (err) {
        sessions.delete(cardId);
        throw err;
      }
    }
    case 'session.send': {
      const session = getSession(request.cardId);
      if (typeof request.text !== 'string') throw new Error('text is required');
      session.send(request.text, Array.isArray(request.images) ? request.images : undefined);
      return {};
    }
    case 'session.interrupt':
      await getSession(request.cardId).interrupt();
      return {};
    case 'session.set_model':
      await getSession(request.cardId).setModel(request.model);
      return {};
    case 'session.set_permission_mode': {
      if (typeof request.mode !== 'string' || !request.mode) throw new Error('mode is required');
      await getSession(request.cardId).setPermissionMode(request.mode);
      return {};
    }
    case 'session.decision': {
      const session = getSession(request.cardId);
      const behavior = request.behavior;
      if (behavior === 'allow') {
        session.decide(request.requestId, {
          behavior: 'allow',
          ...(request.updatedInput ? { updatedInput: request.updatedInput } : {}),
          ...(request.updatedPermissions ? { updatedPermissions: request.updatedPermissions } : {}),
        });
      } else if (behavior === 'deny') {
        session.decide(request.requestId, {
          behavior: 'deny',
          message: typeof request.message === 'string' && request.message ? request.message : 'Denied by user',
        });
      } else {
        throw new Error(`invalid behavior: ${String(behavior)}`);
      }
      return {};
    }
    case 'session.stop': {
      const session = sessions.get(request.cardId);
      if (session) {
        sessions.delete(request.cardId);
        await session.stop();
      }
      return {};
    }
    case 'session.history': {
      if (typeof request.sessionId !== 'string' || !request.sessionId) throw new Error('sessionId is required');
      const options = typeof request.dir === 'string' && request.dir ? { dir: request.dir } : undefined;
      const messages = await sdk.getSessionMessages(request.sessionId, options);
      // Tail-limit so a giant transcript cannot produce an unbounded response
      // frame; callers page by raising the limit.
      const limit = Number.isInteger(request.limit) && request.limit > 0 ? request.limit : undefined;
      return {
        totalMessages: messages.length,
        messages: limit && messages.length > limit ? messages.slice(-limit) : messages,
      };
    }
    default:
      throw new Error(`unhandled op: ${op}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const parsed = parseRequestLine(line);
  if (!parsed) return;
  if (parsed.error) {
    write(responseError(parsed.id ?? -1, parsed.error));
    return;
  }
  const { request } = parsed;
  handle(request)
    .then((payload) => write(responseOk(request.id, payload)))
    .catch((err) => write(responseError(request.id, err?.message ?? err)));
});
rl.on('close', () => {
  // Rust closed stdin: shut down every session and exit cleanly.
  const closing = [...sessions.values()].map((session) => session.stop().catch(() => {}));
  sessions.clear();
  Promise.allSettled(closing).finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  write(eventHostFatal(err?.stack ?? err));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  write(eventHostFatal(err instanceof Error ? err.stack : String(err)));
  process.exit(1);
});

process.stderr.write(`[claude-host] ready pid=${process.pid} node=${process.version}\n`);
