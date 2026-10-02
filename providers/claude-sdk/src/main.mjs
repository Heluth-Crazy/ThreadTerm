import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { parseLine, ok, fail, event } from './protocol.mjs';
import { ClaudeSession } from './session.mjs';

for (const level of ['log', 'info', 'warn', 'debug']) console[level] = (...args) => process.stderr.write(`[claude-sdk:${level}] ${args.join(' ')}\n`);
process.stdout.on('error', () => {});
const write = value => { try { process.stdout.write(`${JSON.stringify(value)}\n`); } catch {} };
const settingSources = process.env.THREADTERM_CLAUDE_SETTING_SOURCES;
const handshakeTimeoutMs = Number(process.env.THREADTERM_CLAUDE_HANDSHAKE_MS) || undefined;
const bundledCli = join(dirname(fileURLToPath(import.meta.url)), `claude-sdk-cli${process.platform === 'win32' ? '.exe' : ''}`);
const hostOptions = {
  pathToClaudeCodeExecutable: process.env.THREADTERM_CLAUDE_PATH || (existsSync(bundledCli) ? bundledCli : undefined),
  ...(settingSources === undefined ? {} : { settingSources: settingSources ? settingSources.split(',') : [] }),
  ...(handshakeTimeoutMs ? { handshakeTimeoutMs } : {}),
};
const sessions = new Map();
const get = cardId => { const session = sessions.get(cardId); if (!session) throw new Error(`no session for card: ${cardId}`); return session; };

async function handle(request) {
  switch (request.op) {
    case 'host.ping': return { pid: process.pid, sdk: true };
    case 'history.list': {
      const options = { ...(request.cwd ? { dir: request.cwd } : {}), limit: request.limit, offset: request.offset ?? 0 };
      const rows = await sdk.listSessions(options);
      return { sessions: rows };
    }
    case 'history.read': {
      if (!request.sessionId) throw new Error('sessionId is required');
      const options = request.cwd ? { dir: request.cwd } : undefined;
      return { messages: await sdk.getSessionMessages(request.sessionId, options) };
    }
    case 'session.start': {
      if (!request.cardId || !request.cwd) throw new Error('cardId and cwd are required');
      if (sessions.has(request.cardId)) throw new Error(`session already exists: ${request.cardId}`);
      const session = new ClaudeSession({ cardId: request.cardId, sdk, write, hostOptions });
      sessions.set(request.cardId, session);
      // start() resolves after the SDK control handshake; the reply therefore
      // means the provider is genuinely ready, not merely spawned.
      try { return { sessionId: await session.start({ cwd: request.cwd, sessionId: request.sessionId }) }; }
      catch (error) {
        if (sessions.get(request.cardId) === session) sessions.delete(request.cardId);
        await session.stop().catch(() => {});
        throw error;
      }
    }
    case 'session.send': get(request.cardId).send(request.text, request.operationId); return {};
    case 'session.interrupt': await get(request.cardId).interrupt(); return {};
    case 'session.decision': get(request.cardId).decide(request.requestId, request.behavior); return {};
    case 'session.stop': { const session = sessions.get(request.cardId); sessions.delete(request.cardId); if (session) await session.stop(); return {}; }
    default: throw new Error(`unhandled op: ${request.op}`);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  const parsed = parseLine(line);
  if (!parsed || parsed.error) { if (parsed) write(fail(parsed.id ?? -1, parsed.error)); return; }
  handle(parsed.request).then(payload => write(ok(parsed.request.id, payload))).catch(error => write(fail(parsed.request.id, error)));
});
reader.on('close', () => Promise.allSettled([...sessions.values()].map(session => session.stop())).finally(() => process.exit(0)));
process.on('uncaughtException', error => { write(event('', 'host.fatal', { error: String(error?.stack ?? error) })); process.exit(1); });
process.on('unhandledRejection', error => { write(event('', 'host.fatal', { error: String(error?.stack ?? error) })); process.exit(1); });
