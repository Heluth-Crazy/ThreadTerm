import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectPeer } from './pipe-client.mjs';

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const id = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-v3-chat-smoke-'));
const cwd = join(root, 'workspace');
const pipe = `\\\\.\\pipe\\threadterm-v3-chat-smoke-${id()}`;
await mkdir(cwd);
const daemon = spawn(resolve('runtime/target/debug/threadterm-v3-runtime.exe'), [], {
  env: {
    ...process.env,
    THREADTERM_V3_DATA: join(root, 'data'),
    THREADTERM_V3_PIPE: pipe,
  },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostic = '';
daemon.stderr.on('data', (bytes) => { diagnostic += bytes; });
let peer;
const results = [];

async function connect() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const candidate = await connectPeer(`${pipe}-control`);
      const secret = (await readFile(join(root, 'data/runtime.credential'), 'utf8')).trim();
      const clientId = await candidate.auth(secret);
      return { peer: candidate, clientId };
    } catch (error) {
      if (daemon.exitCode !== null) throw new Error(`runtime failed before connect: ${diagnostic}`);
      await delay(100);
    }
  }
  throw new Error('runtime startup timeout');
}

function assistantTextLength(items) {
  return items
    .filter((item) => item.role === 'assistant')
    .flatMap((item) => item.parts)
    .filter((part) => part.type === 'text')
    .reduce((total, part) => total + (part.text?.length ?? 0), 0);
}

async function waitForCompletedTurn(sessionId, leaseEpoch, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let nextRenewal = Date.now() + 10_000;
  let streamEvents = 0;
  while (Date.now() < deadline) {
    try {
      const event = await peer.nextEvent(
        (candidate) => candidate.data?.sessionId === sessionId,
        Math.min(750, Math.max(1, deadline - Date.now())),
      );
      if (event.event === 'chat.item') streamEvents += 1;
    } catch (error) {
      if (error.message !== 'event timeout') throw error;
    }
    if (Date.now() >= nextRenewal) {
      leaseEpoch = (await peer.request('session.renew', { sessionId, leaseEpoch })).leaseEpoch;
      nextRenewal = Date.now() + 10_000;
    }
    const snapshot = await peer.request('runtime.snapshot');
    const items = await peer.request('chat.read', { sessionId });
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const textLength = assistantTextLength(items);
    if (session?.status === 'error') {
      const errorPart = items
        .flatMap((item) => item.parts)
        .find((part) => part.type === 'error');
      const raw = errorPart?.data?.raw;
      const providerError = raw?.payload?.properties?.error
        ?? raw?.properties?.error
        ?? raw?.error
        ?? errorPart?.text;
      const failure = new Error('provider turn entered error state');
      const providerMessage = providerError?.data?.message ?? providerError?.message ?? String(providerError ?? '');
      failure.providerError = {
        category: /insufficient balance/i.test(providerMessage)
          ? 'insufficient_balance'
          : /auth|credential|unauthorized/i.test(providerMessage)
            ? 'authentication'
            : 'provider_error',
        name: providerError?.name,
        statusCode: providerError?.data?.statusCode,
      };
      throw failure;
    }
    if (session?.status === 'idle' && textLength > 0) {
      return { leaseEpoch, streamEvents, projectedItems: items.length, assistantTextLength: textLength };
    }
  }
  throw new Error('provider turn completion timeout');
}

async function waitForNativeId(sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await peer.request('runtime.snapshot');
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session?.nativeId) return session.nativeId;
    await delay(100);
  }
  throw new Error('provider native session id was not persisted');
}

async function waitForHistory(provider, nativeId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await peer.request('history.list', { provider, cwd, limit: 20 }, 45_000);
    const item = history.items.find((candidate) => candidate.nativeId === nativeId);
    if (item) return item;
    await delay(250);
  }
  throw new Error('new native session did not appear in provider history');
}

async function waitForResumedStatus(sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await peer.request('runtime.snapshot');
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session?.status === 'idle' || session?.status === 'running') return session;
    if (session?.status === 'error') throw new Error('resumed provider session entered error state');
    await delay(100);
  }
  throw new Error('resumed provider session did not become idle or running');
}

async function expectDuplicateNativeOwner(params, stage) {
  try {
    await peer.request('session.create', params);
  } catch (error) {
    return { rejected: true, message: error.message };
  }
  throw new Error(`${stage}: duplicate native owner was accepted`);
}

async function smokeProvider(provider, clientId) {
  const row = { provider, stage: 'create' };
  let session;
  let resumed;
  try {
    session = await peer.request('session.create', {
      cwd,
      title: `${provider} provider smoke`,
      provider,
      mode: 'chat',
      operationId: id(),
    });
    row.created = true;
    row.stage = 'claim';
    let leaseEpoch = (await peer.request('session.claim', {
      sessionId: session.id,
      clientId,
    })).leaseEpoch;

    row.stage = 'connect';
    const connection = await peer.request('chat.connect', {
      sessionId: session.id,
      leaseEpoch,
      operationId: id(),
    }, 60_000);
    row.connected = connection.phase === 'ready';

    row.stage = 'send-completion';
    const completed = await peer.request('chat.send', {
      sessionId: session.id,
      text: 'Reply OK only.',
      operationId: id(),
      leaseEpoch,
    });
    row.stage = 'wait-completion';
    row.completedTurn = await waitForCompletedTurn(session.id, leaseEpoch);
    leaseEpoch = row.completedTurn.leaseEpoch;
    row.completedTurn.turnId = typeof completed.turnId === 'string';

    row.stage = 'send-cancellation';
    leaseEpoch = (await peer.request('session.renew', { sessionId: session.id, leaseEpoch })).leaseEpoch;
    const cancelled = await peer.request('chat.send', {
      sessionId: session.id,
      text: 'Run a command that sleeps for 20 seconds, then reply OK only.',
      operationId: id(),
      leaseEpoch,
    });
    row.stage = 'cancel';
    await peer.request('chat.cancel', {
      sessionId: session.id,
      turnId: cancelled.turnId,
      leaseEpoch,
    });
    row.cancelAccepted = true;

    row.stage = 'native-id';
    const nativeId = await waitForNativeId(session.id);
    row.nativeIdPersisted = true;
    const originalSessionId = session.id;
    row.stage = 'duplicate-active-owner';
    row.duplicateNativeOwnerActive = await expectDuplicateNativeOwner({
      cwd,
      title: `${provider} duplicate active native owner`,
      provider,
      mode: 'chat',
      nativeId,
      operationId: id(),
    }, 'active native owner');
    await peer.request('session.stop', { sessionId: session.id, operationId: id() });

    row.stage = 'history';
    const historyItem = await waitForHistory(provider, nativeId);
    const transcript = await peer.request('history.read', { provider, nativeId }, 45_000);
    row.history = {
      listed: true,
      resumable: historyItem.resumable,
      transcriptItems: transcript.length,
    };

    row.stage = 'duplicate-inactive-owner';
    row.duplicateNativeOwnerInactive = await expectDuplicateNativeOwner({
      cwd,
      title: `${provider} duplicate inactive native owner`,
      provider,
      mode: 'chat',
      nativeId,
      operationId: id(),
    }, 'inactive native owner');

    row.stage = 'resume';
    const resumeOperationId = id();
    resumed = await peer.request('session.resume', { sessionId: originalSessionId, cwd, operationId: resumeOperationId });
    const idempotentResume = await peer.request('session.resume', { sessionId: originalSessionId, cwd, operationId: resumeOperationId });
    const resumedStatus = await waitForResumedStatus(originalSessionId);
    row.resume = {
      sameSessionId: resumed.id === originalSessionId,
      nativeIdMatched: resumed.nativeId === nativeId,
      idempotent: idempotentResume.id === originalSessionId && idempotentResume.nativeId === nativeId,
      status: resumedStatus.status,
    };
    if (!row.resume.sameSessionId || !row.resume.nativeIdMatched || !row.resume.idempotent) {
      throw new Error('session.resume did not preserve the original native owner identity');
    }
    await peer.request('session.stop', { sessionId: resumed.id, operationId: id() });
    resumed = undefined;
    session = undefined;
    row.stage = 'complete';
  } catch (error) {
    row.error = error.message;
    row.errorCode = error.code;
    if (error.schemaErrors) row.schemaErrors = error.schemaErrors;
    if (error.providerError) row.providerError = error.providerError;
  } finally {
    if (resumed) {
      try { await peer.request('session.stop', { sessionId: resumed.id, operationId: id() }); } catch {}
    }
    if (session) {
      try { await peer.request('session.stop', { sessionId: session.id, operationId: id() }); } catch {}
    }
  }
  results.push(row);
  console.log(JSON.stringify(row));
}

try {
  const connected = await connect();
  peer = connected.peer;
  const capabilities = await peer.request('provider.list');
  const filter = process.env.PROVIDER_SMOKE_FILTER?.split(',').filter(Boolean);
  const argvFilter = process.argv.slice(2).filter(Boolean);
  const providers = capabilities.filter(
    (provider) => provider.chat && provider.auth !== 'unauthenticated',
  ).filter((provider) => !filter || filter.includes(provider.id))
    .filter((provider) => !argvFilter.length || argvFilter.includes(provider.id));
  for (const provider of providers) await smokeProvider(provider.id, connected.clientId);
  await mkdir('qa/results', { recursive: true });
  let prior = [];
  try {
    prior = JSON.parse(await readFile('qa/results/provider-chat-smoke.json', 'utf8')).results ?? [];
  } catch {}
  const merged = new Map(prior.map((row) => [row.provider, row]));
  for (const row of results) merged.set(row.provider, row);
  await writeFile(
    'qa/results/provider-chat-smoke.json',
    `${JSON.stringify({ results: [...merged.values()] }, null, 2)}\n`,
  );
  await peer.request('runtime.shutdown', { operationId: id() });
} finally {
  peer?.close();
  if (daemon.exitCode === null) {
    daemon.kill();
    await Promise.race([
      new Promise((resolveExit) => daemon.once('exit', resolveExit)),
      delay(5_000),
    ]);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (results.some((result) => result.error)) process.exitCode = 1;
