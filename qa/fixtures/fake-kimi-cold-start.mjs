// Isolated builtin-Kimi executable for cold provider capability QA.
// `--version` succeeds immediately; the ACP initialize response stays behind a
// QA-owned gate so the real runtime can be observed while discovery is pending.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const logFile = process.env.TT_QA_KIMI_LOG;
const gateFile = process.env.TT_QA_KIMI_GATE;
function record(kind, extra = {}) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ kind, pid: process.pid, at: Date.now(), ...extra })}\n`);
}
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
async function waitForRelease() {
  while (true) {
    let value = '';
    try { value = readFileSync(gateFile, 'utf8').trim(); } catch {}
    if (value === 'release') return;
    await delay(25);
  }
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  record('version');
  process.stdout.write('kimi cold-start QA 1.0.0\n');
} else if (args.includes('acp')) {
  record('acp-start');
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.method === 'initialize') {
      record('initialize', { requestId: request.id });
      void waitForRelease().then(() => reply(request.id, {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {}, load: {}, resume: {} } },
      }));
    } else if (request.method === 'session/new' && request.id !== undefined) {
      reply(request.id, { sessionId: 'cold-start-qa-session' });
    } else if (request.method === 'session/list' && request.id !== undefined) {
      reply(request.id, { sessions: [] });
    } else if (request.id !== undefined) {
      reply(request.id, {});
    }
  });
} else {
  record('unexpected-command', { args });
  process.stdout.write('Kimi cold-start QA fixture\n');
}
