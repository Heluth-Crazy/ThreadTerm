import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const eventsDirectory = process.env.THREADTERM_QA_FAKE_CODEX_EVENTS;
const controlPath = process.env.THREADTERM_QA_FAKE_CODEX_CONTROL;
const directArguments = process.argv.slice(2);
const cliArguments = basename(process.argv[1]).toLowerCase() === 'app-server'
  ? ['app-server', ...directArguments]
  : directArguments;

if (!eventsDirectory || !controlPath) {
  process.stderr.write('isolated fake Codex paths are required\n');
  process.exit(2);
}

await mkdir(eventsDirectory, { recursive: true });
const eventPath = join(eventsDirectory, `${process.pid}.jsonl`);
let eventSequence = 0;
const record = (event, detail = {}) => appendFileSync(
  eventPath,
  `${JSON.stringify({
    event,
    pid: process.pid,
    sequence: ++eventSequence,
    recordedAt: Date.now(),
    argv: cliArguments,
    ...detail,
  })}\n`,
);

if (cliArguments.includes('--version')) {
  process.stdout.write('codex-qa-fixture 1.0.0\n');
  process.exit(0);
}
if (cliArguments[0] === 'login' && cliArguments[1] === 'status') {
  process.stdout.write('authenticated QA fixture\n');
  process.exit(0);
}
if (cliArguments[0] !== 'app-server' || cliArguments[1] !== '--stdio') {
  record('unexpectedInvocation');
  process.stderr.write('fake Codex only supports app-server --stdio\n');
  process.exit(3);
}

record('spawn');

async function control() {
  try {
    return JSON.parse(await readFile(controlPath, 'utf8'));
  } catch {
    return {};
  }
}

function fixtureThread(nativeId, cwd, includeTurns) {
  return {
    id: nativeId,
    name: `QA history ${nativeId}`,
    preview: 'Saved answer from the isolated provider fixture',
    cwd,
    source: 'cli',
    ephemeral: false,
    createdAt: 1_788_710_400,
    updatedAt: 1_788_710_460,
    sessionId: `session-${nativeId}`,
    cliVersion: 'codex-qa-fixture 1.0.0',
    model: 'gpt-5.5-luna',
    reasoningEffort: 'high',
    status: { type: 'idle' },
    ...(includeTurns ? {
      turns: [{
        id: `turn-${nativeId}`,
        items: [
          { id: `user-${nativeId}`, type: 'userMessage', text: 'Saved question' },
          { id: `assistant-${nativeId}`, type: 'agentMessage', text: 'Saved answer' },
        ],
      }],
    } : {}),
  };
}

const sendResult = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const sendError = (id, message) => process.stdout.write(`${JSON.stringify({
  id,
  error: { code: -32_000, message },
})}\n`);
const sendNotification = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) {
      record('notification', { method: request.method });
      continue;
    }
    record('request', { method: request.method, params: request.params });
    if (request.method === 'initialize') {
      sendResult(request.id, { capabilities: {} });
      continue;
    }
    if (request.method === 'account/read') {
      sendResult(request.id, {
        account: { type: 'chatgpt', email: 'qa@example.com', planType: 'prolite' },
        requiresOpenaiAuth: false,
      });
      continue;
    }
    if (request.method === 'account/rateLimits/read') {
      sendResult(request.id, {
        rateLimits: {
          limitId: 'codex', limitName: 'Codex', planType: 'prolite',
          primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_788_710_760 },
          secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_789_315_200 },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex', limitName: 'Codex', planType: 'prolite',
            primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_788_710_760 },
            secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_789_315_200 },
          },
          models: {
            limitId: 'models', limitName: 'Models', planType: 'prolite',
            primary: { usedPercent: 8, windowDurationMins: 1440, resetsAt: 1_788_796_800 },
          },
        },
      });
      continue;
    }
    if (request.method === 'thread/read') {
      const configuration = await control();
      const nativeId = request.params?.threadId;
      const includeTurns = request.params?.includeTurns === true;
      if (!configuration.nativeIds?.includes(nativeId)) {
        sendError(request.id, `unknown QA native id: ${nativeId}`);
        continue;
      }
      record(includeTurns ? 'historyRead' : 'resumePreflight', { nativeId });
      if (includeTurns && Number.isInteger(configuration.historyDelayMs)) {
        await new Promise((resolve) => setTimeout(resolve, configuration.historyDelayMs));
      }
      sendResult(request.id, {
        model: 'gpt-5.5-luna',
        reasoningEffort: 'high',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite', writableRoots: [configuration.cwd], networkAccess: false },
        instructionSources: [`${configuration.cwd}/AGENTS.md`],
        threadSettings: { summary: 'auto', collaborationMode: { mode: 'default', settings: {} } },
        thread: fixtureThread(nativeId, configuration.cwd, includeTurns),
      });
      sendNotification('thread/tokenUsage/updated', {
        threadId: nativeId,
        turnId: `turn-${nativeId}`,
        tokenUsage: {
          last: { totalTokens: 94_700, inputTokens: 60_000, outputTokens: 34_700 },
          total: { totalTokens: 94_700, inputTokens: 60_000, outputTokens: 34_700 },
          modelContextWindow: 258_000,
        },
      });
      continue;
    }
    if (request.method === 'thread/resume') {
      const configuration = await control();
      const nativeId = request.params?.threadId;
      if (configuration.failResumeNativeIds?.includes(nativeId)) {
        record('resumeRejected', { nativeId });
        sendError(request.id, `intentional QA resume failure for ${nativeId}`);
        continue;
      }
      record('interactiveResume', { nativeId });
      sendResult(request.id, {
        model: 'gpt-5.5-luna',
        reasoningEffort: 'high',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite', writableRoots: [request.params?.cwd ?? configuration.cwd], networkAccess: false },
        instructionSources: [`${request.params?.cwd ?? configuration.cwd}/AGENTS.md`],
        threadSettings: { summary: 'auto', collaborationMode: { mode: 'default', settings: {} } },
        thread: fixtureThread(nativeId, request.params?.cwd ?? configuration.cwd, false),
      });
      sendNotification('thread/tokenUsage/updated', {
        threadId: nativeId,
        turnId: `turn-${nativeId}`,
        tokenUsage: {
          last: { totalTokens: 94_700, inputTokens: 60_000, outputTokens: 34_700 },
          total: { totalTokens: 94_700, inputTokens: 60_000, outputTokens: 34_700 },
          modelContextWindow: 258_000,
        },
      });
      continue;
    }
    if (request.method === 'thread/start') {
      record('unexpectedThreadStart');
      sendError(request.id, 'thread/start is forbidden in the history import QA fixture');
      continue;
    }
    sendError(request.id, `unexpected fake Codex request: ${request.method}`);
  }
} catch (error) {
  record('fixtureError', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 4;
}
