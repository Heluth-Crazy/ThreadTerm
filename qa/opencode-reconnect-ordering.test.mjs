// Executes the production ChatView connect effects, Retry and event action in
// memory. No Electron, native provider, timer, or wall-clock sleep is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const view = readFileSync(new URL('../renderer/src/components/ChatView.tsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const reducer = stripTypeScriptTypes(readFileSync(new URL('../renderer/src/chatConnection.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const start = view.indexOf('  useEffect(() => {\n    connectInFlight.current = undefined;');
const end = view.indexOf('\n  useEffect(() => {\n    if (!connected)', start);
assert.ok(start >= 0 && end > start, 'find the production attempt-lifetime and connect effects');
const effects = stripTypeScriptTypes(view.slice(start, end));
const retryStart = view.indexOf('  function retryConnection() {');
const retry = view.slice(retryStart, view.indexOf('  function continueWithoutReload()', retryStart));
assert.ok(retry.includes('reclaimRef.current()'), 'find production Retry');
const eventAction = view.split('\n').find(line => line.includes("setLink(current => reduceChatLink(current, { type: 'event', snapshot:"));
assert.ok(eventAction, 'find the production connection-event action');
const leaseStart = view.indexOf('  useEffect(() => {\n    let disposed = false;\n    let control: ControlToken');
const leaseEnd = view.indexOf('\n  const connected =', leaseStart);
assert.ok(leaseStart >= 0 && leaseEnd > leaseStart, 'find the production lease effect');
const leaseEffect = stripTypeScriptTypes(view.slice(leaseStart, leaseEnd));
const controlEligibility = view.split('\n').find(line => line.includes('const canTakeControl ='));
const repairWritable = view.split('\n').find(line => line.includes('const repairWritable ='));
const repairGateStart = view.indexOf('  const repairOffered =');
const repairGate = view.slice(repairGateStart, view.indexOf('  const repairDisabledReason =', repairGateStart));
const repairStart = view.indexOf('  const beginRepair =');
const repairActions = view.slice(repairStart, view.indexOf('  const queueMode =', repairStart));
assert.ok(controlEligibility && repairWritable && repairGate && repairActions.includes("request('chat.repair'"), 'find production lease eligibility and repair gates/actions');
const reclaimCondition = view.match(/\{([^{}]+) && <button type="button" className="chip chip-btn chat-compose-reclaim"/)[1];
const providers = ['opencode', 'codex', 'kimi', 'gemini', 'acp-fixture', 'grok', 'claude'];
const failure = 'Event stream headers were not received: timed out waiting on channel';

function fixture(provider = 'opencode', withLease = false, sessionPatch = {}) {
  let scheduled = [], previous = [];
  const calls = [], claims = [], releases = [];
  let claimFailures = 0, holdClaim = false, failCheck = false;

  const context = createContext({
    session: { id: 's', provider, status: 'idle', mode: 'chat', ...sessionPatch }, leaseSessionId: { current: 's' }, lease: { current: 1 },
    lifecycle: { current: { sessionId: 's' } },
    repair: { offered: true }, liveTurn: undefined, repairBusy: false, repairDialog: false, ingressFailed: false,
    setRepairDialog: value => { context.repairDialog = value; }, setRepairBusy: value => { context.repairBusy = value; },
    setRepairNotice: value => { context.repairNotice = value; }, setRepairFollowup: () => {}, discoverHistoryRef: { current: () => {} },
    setControllable: value => { context.controllable = value; }, setControlIssue: value => { context.controlIssue = value; },
    acquireControl: (id, onLost) => {
      const row = { id, onLost }; claims.push(row);
      if (claimFailures > 0) { claimFailures--; return Promise.reject(new Error('lease_unavailable')); }
      const claim = { epoch: claims.length, check: async () => { if (failCheck) { failCheck = false; onLost(); throw new Error('stale_lease'); } }, release: () => releases.push(claim.epoch) };
      return holdClaim ? new Promise(resolve => { row.resolve = () => resolve(claim); }) : Promise.resolve(claim);
    },
    connectInFlight: { current: undefined }, transportGeneration: { current: 0 },
    discoveryClear: true, canControl: true, ended: false, controllable: !withLease, zh: false,
    operationId: () => String(calls.length), asUserError: error => error.message, copy: en => en,
    reclaimRef: { current: () => {} },
    request: (method, params) => {
      let resolve, reject;
      const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
      calls.push({ method, params, resolve, reject }); return promise;
    },
    useEffect: (callback, deps) => scheduled.push({ callback, deps }),
  });
  runInContext(`${reducer}\nlet link = emptyLink('s', 'connecting');\nfunction setLink(update) { link = update(link); }\n${retry}`, context);
  function render() {
    scheduled = [];
    runInContext('var connection = link.connection; var connected = connection.phase === "ready" && link.transport === "up";', context);
    context.canControl = !context.session.readOnly && context.session.status !== 'exited';
    context.ended = Boolean(context.session.readOnly) || context.session.status === 'exited';
    runInContext(controlEligibility.replace('const ', 'var '), context);
    if (withLease) runInContext(leaseEffect, context);
    runInContext(effects, context);
    const changed = scheduled.map((effect, i) => !previous[i] || effect.deps.some((dep, j) => dep !== previous[i].deps[j]));
    previous.forEach((effect, i) => { if (changed[i]) effect.cleanup?.(); });
    previous = scheduled.map((effect, i) => changed[i] ? { ...effect, cleanup: effect.callback() } : previous[i]);
  }
  function renderRepair() {
    runInContext(`${repairWritable}\n${repairGate}${repairActions}`.replaceAll('const ', 'var '), context);
  }
  function action(value) {
    context.action = value; runInContext('setLink(current => reduceChatLink(current, action))', context); render();
  }
  function snapshot(phase, generation, revision, epoch = 'runtime', sessionId = 's') {
    return { sessionId, runtimeEpoch: epoch, phase, connectionGeneration: generation, revision, optionsLoadState: phase === 'failed' ? 'error' : 'ready',
      ...(phase === 'failed' ? { error: { code: 'native_resume_failed', message: failure, retryable: true } } : {}) };
  }
  function event(phase, generation, revision, epoch = 'runtime', sessionId = 's') {
    context.event = { epoch, data: snapshot(phase, generation, revision, epoch, sessionId) };
    runInContext(stripTypeScriptTypes(eventAction), context); render();
  }
  async function settle(index, result, failed = true) {
    if (failed) calls[index].reject(new Error(failure)); else calls[index].resolve(result);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    render();
  }
  function transport(epoch = 'runtime', phase = 'disconnected', generation = 0) {
    context.transportGeneration.current++;
    action({ type: 'transport-down' });
    context.transportGeneration.current++;
    action({ type: 'transport-up', epoch });
    if (withLease) context.reclaimRef.current();
    action({ type: 'snapshot', snapshot: snapshot(phase, generation, 0, epoch), transportGeneration: context.transportGeneration.current, resync: true });
  }
  async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  render();
  return { claims, releases, flush,
    status: status => { context.session = { ...context.session, status }; render(); },
    updateSession: patch => { context.session = { ...context.session, ...patch }; render(); },
    beginRepair: () => { renderRepair(); runInContext('beginRepair()', context); return context.repairDialog; },
    confirmRepair: () => { renderRepair(); return runInContext('confirmRepair()', context); },
    reclaim: () => { context.reclaimRef.current(); render(); },
    failCheck: () => { failCheck = true; }, failClaims: count => { claimFailures = count; }, holdClaim: value => { holdClaim = value; },
    loseControl: () => { claims.at(-1).onLost(); render(); },
    reclaimVisible: () => runInContext(reclaimCondition, context),
    writable: () => context.canControl && context.controllable && runInContext('connected', context),
    calls, event, action, snapshot, transport, reject: index => settle(index), resolve: (index, value) => settle(index, value, false),
    retry: () => { runInContext('retryConnection()', context); render(); },
    unmount: () => previous.forEach(effect => effect.cleanup?.()),
    state: () => runInContext('link', context),
    session: id => { context.session = { id, provider }; context.leaseSessionId.current = id; action({ type: 'reset', sessionId: id, phase: 'connecting' }); },
  };
}

for (const provider of providers) {
  test(`${provider}: rejected connect stays failed through queued events and snapshots until Retry`, async () => {
    const f = fixture(provider);
    assert.equal(f.calls.length, 1);
    await f.reject(0);
    for (const phase of ['connecting', 'disconnected', 'ready']) {
      f.event(phase, 1, 10);
      f.action({ type: 'snapshot', snapshot: f.snapshot(phase, 1, 11) });
      assert.equal(f.state().connection.phase, 'failed');
      assert.match(f.state().connection.error.message, /headers were not received/);
      assert.equal(f.calls.length, 1, 'no unsolicited attach');
    }
    // Authoritative failure can still replace the local generic error.
    f.event('failed', 1, 12);
    assert.equal(f.state().connection.revision, 12);
    f.event('connecting', 1, 13);
    assert.equal(f.state().connection.phase, 'failed');
    f.retry();
    assert.equal(f.calls.length, 2);
    assert.equal(f.state().connection.error, undefined);
    f.event('connecting', 1, 14); // retired attempt, even after Retry
    f.event('failed', 1, 15);
    assert.equal(f.state().connection.phase, 'disconnected');
    await f.resolve(1, f.snapshot('ready', 2, 16));
    assert.equal(f.state().connection.phase, 'ready');
    assert.equal(f.state().connection.error, undefined);
  });
}

test('Retry before any failure event still retires the previous generation', async () => {
  const f = fixture();
  await f.reject(0);
  f.retry();
  await f.reject(1);
  f.event('connecting', 2, 3);
  assert.equal(f.state().connection.phase, 'failed');
  assert.equal(f.calls.length, 2);
});

test('connecting event before rejection does not dispose the request failure handler', async () => {
  const f = fixture();
  f.event('connecting', 1, 1);
  assert.equal(f.calls.length, 1);
  await f.reject(0);
  assert.equal(f.state().connection.phase, 'failed');
  assert.equal(f.state().connection.revision, 1, 'local failure does not invent a runtime revision');
  f.event('connecting', 1, 2);
  assert.equal(f.calls.length, 1);
});

test('runtime failure before request rejection stays failed; same-generation updates cannot re-arm it', async () => {
  const f = fixture();
  f.event('failed', 1, 2);
  f.event('connecting', 1, 3);
  await f.reject(0);
  f.event('disconnected', 1, 4);
  assert.equal(f.state().connection.phase, 'failed');
  assert.equal(f.calls.length, 1);
});

test('a genuinely newer provider generation can connect and clear the previous error', async () => {
  const f = fixture();
  await f.reject(0);
  f.event('failed', 1, 2);
  f.event('connecting', 2, 3);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().connection.error, undefined);
  await f.resolve(1, f.snapshot('ready', 2, 4));
  assert.equal(f.state().connection.phase, 'ready');
  f.event('connecting', 1, 99);
  assert.equal(f.state().connection.phase, 'ready');
});

test('a connected provider process loss automatically reconnects once', async () => {
  const f = fixture();
  await f.resolve(0, f.snapshot('ready', 1, 2));
  f.event('disconnected', 2, 3);
  assert.equal(f.calls.length, 2);
  f.event('connecting', 3, 4);
  assert.equal(f.calls.length, 2);
  await f.resolve(1, f.snapshot('ready', 3, 5));
  assert.equal(f.state().connection.phase, 'ready');
});

for (const epoch of ['runtime', 'new-runtime']) {
  test(`transport resync permits automatic reconnect (${epoch}) and fences old in-flight replies`, async () => {
    const f = fixture();
    f.event('connecting', 1, 1);
    f.transport(epoch);
    assert.equal(f.calls.length, 2);
    await f.reject(0);
    assert.equal(f.state().connection.phase, 'disconnected');
    f.event('connecting', 1, 1, epoch);
    assert.equal(f.calls.length, 2, 'old rejection cannot clear the new single-flight ticket');
    await f.resolve(1, f.snapshot('ready', 1, 2, epoch));
    assert.equal(f.state().connection.phase, 'ready');
    if (epoch !== 'runtime') {
      f.event('connecting', 99, 99, 'runtime');
      assert.equal(f.state().connection.phase, 'ready');
    }
  });
  test(`transport resync recovers a failed attempt (${epoch})`, async () => {
    const f = fixture();
    f.event('connecting', 1, 1);
    await f.reject(0);
    f.transport(epoch);
    assert.equal(f.calls.length, 2);
    await f.resolve(1, f.snapshot('ready', 1, 2, epoch));
    assert.equal(f.state().connection.phase, 'ready');
  });
}

test('explicit retry supersedes an outstanding request; late rejection cannot erase the new result', async () => {
  const f = fixture();
  f.retry();
  assert.equal(f.calls.length, 2);
  await f.reject(0);
  f.event('connecting', 1, 1);
  assert.equal(f.calls.length, 2);
  await f.resolve(1, f.snapshot('ready', 1, 2));
  assert.equal(f.state().connection.phase, 'ready');
});

test('session change and unmount fence old request continuations', async () => {
  const f = fixture();
  f.session('other');
  assert.equal(f.calls.length, 2);
  await f.reject(0);
  assert.equal(f.state().connection.sessionId, 'other');
  assert.equal(f.state().connection.phase, 'connecting');
  f.unmount();
  await f.reject(1);
  assert.equal(f.state().connection.phase, 'connecting');
});

test('Retry can confirm ready in the first generation after a pre-open admission failure', async () => {
  const f = fixture();
  await f.reject(0); // no runtime generation was allocated
  f.retry();
  f.event('connecting', 1, 1);
  await f.resolve(1, f.snapshot('ready', 1, 2));
  assert.equal(f.state().connection.phase, 'ready');
  assert.equal(f.state().failedAttempt, undefined);
});

test('transport-up with an inline snapshot accepts a new epoch after failure', async () => {
  const f = fixture();
  await f.reject(0);
  f.action({ type: 'transport-down' });
  f.action({ type: 'transport-up', epoch: 'new-runtime', snapshot: f.snapshot('ready', 0, 0, 'new-runtime') });
  assert.equal(f.state().transport, 'up');
  assert.equal(f.state().connection.phase, 'ready');
});

test('a newer disconnected generation supersedes a still-pending request and reconnects immediately', async () => {
  const f = fixture();
  f.event('connecting', 1, 1);
  f.event('disconnected', 2, 2);
  assert.equal(f.calls.length, 2);
  await f.reject(0);
  assert.equal(f.state().connection.phase, 'disconnected');
  f.event('connecting', 3, 3);
  assert.equal(f.calls.length, 2);
  await f.resolve(1, f.snapshot('ready', 3, 4));
  assert.equal(f.state().connection.phase, 'ready');
});


test('failed reconnect retains the lease and does not offer Reclaim for provider unavailability', async () => {
  const f = fixture('codex', true);
  await f.flush();
  await f.resolve(0, f.snapshot('ready', 1, 1));
  assert.equal(f.writable(), true);
  f.event('disconnected', 2, 2);
  f.status('starting');
  f.event('failed', 3, 3);
  await f.reject(1);
  f.status('error');
  await f.flush();
  assert.equal(f.state().connection.phase, 'failed');
  assert.equal(f.writable(), false);
  assert.equal(f.reclaimVisible(), false, 'a failed connection is not a lost lease');
  assert.equal(f.claims.length, 1, 'status transitions retain this window control');
  assert.equal(f.releases.length, 0);
  f.retry();
  await f.flush();
  f.status('starting');
  await f.resolve(2, f.snapshot('ready', 4, 4));
  f.status('idle');
  await f.flush();
  assert.equal(f.writable(), true);
  assert.equal(f.claims.length, 1, 'Retry reuses the valid lease');
  f.unmount();
  assert.deepEqual(f.releases, [1], 'unmount releases exactly the owned reference');
});

test('Retry recovers a genuinely lost lease and keeps concurrent Reclaim single flight', async () => {
  const f = fixture('opencode', true);
  await f.flush();
  await f.reject(0);
  f.failClaims(1);
  f.loseControl();
  await f.flush();
  assert.equal(f.reclaimVisible(), true);
  f.holdClaim(true);
  f.retry();
  f.reclaim();
  f.retry();
  assert.equal(f.claims.length, 3, 'one initial claim, one failed recovery, one pending claim');
  f.claims.at(-1).resolve();
  await f.flush();
  assert.equal(f.reclaimVisible(), false);
  assert.equal(f.calls.length, 2, 'provider reconnect waits for recovered control');
  await f.resolve(1, f.snapshot('ready', 1, 1));
  assert.equal(f.writable(), true);
  f.unmount();
  assert.deepEqual(f.releases, [1, 3]);
});

test('an outstanding lease claim is released if the session exits before acquisition', async () => {
  const f = fixture('codex', true);
  await f.flush();
  f.failClaims(1);
  f.loseControl();
  await f.flush();
  f.holdClaim(true);
  f.reclaim();
  f.status('exited');
  f.claims.at(-1).resolve();
  await f.flush();
  assert.equal(f.writable(), false);
  assert.equal(f.reclaimVisible(), false);
  assert.deepEqual(f.releases, [1, 3]);
  f.unmount();
});


test('Retry validates a previously owned lease and recovers a stale epoch before connecting', async () => {
  const f = fixture('codex', true);
  await f.flush();
  await f.reject(0);
  f.failCheck();
  f.retry();
  assert.equal(f.calls.length, 1, 'no connect may use the unvalidated epoch');
  await f.flush();
  assert.equal(f.claims.length, 2);
  assert.equal(f.calls[1].params.leaseEpoch, 2);
  await f.resolve(1, f.snapshot('ready', 1, 1));
  assert.equal(f.writable(), true);
  f.unmount();
  assert.deepEqual(f.releases, [1, 2]);
});


for (const epoch of ['runtime', 'new-runtime']) {
  test(`transport resync revalidates control before connecting (${epoch})`, async () => {
    const f = fixture('opencode', true);
    await f.flush();
    await f.resolve(0, f.snapshot('ready', 1, 1));
    f.failCheck();
    f.transport(epoch);
    assert.equal(f.calls.length, 1);
    await f.flush();
    assert.equal(f.calls[1].params.leaseEpoch, 2);
    await f.resolve(1, f.snapshot('ready', 1, 2, epoch));
    assert.equal(f.writable(), true);
    f.unmount();
    assert.deepEqual(f.releases, [1, 2]);
  });
}


test('read-only non-exited Chat acquires a repair lease and starts a confirmed native-history repair', async () => {
  const f = fixture('codex', true, { readOnly: true });
  await f.flush();
  assert.equal(f.claims.length, 1);
  assert.equal(f.calls.length, 0, 'repair control must not connect the native provider');
  assert.equal(f.writable(), false, 'repair control must not enable chat writes');
  assert.equal(f.reclaimVisible(), false);
  assert.equal(f.beginRepair(), true, 'the production repair action opens confirmation');
  const repairing = f.confirmRepair();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'chat.repair');
  assert.equal(f.calls[0].params.sessionId, 's');
  assert.equal(f.calls[0].params.leaseEpoch, 1);
  assert.ok(f.calls[0].params.operationId);
  await f.resolve(0, { added: 1, updated: 0, removed: 0, total: 1 });
  await repairing;
  f.unmount();
  assert.deepEqual(f.releases, [1]);
});

for (const readOnly of [false, true]) {
  test(`exited Chat never acquires control or starts repair (readOnly=${readOnly})`, async () => {
    const f = fixture('codex', true, { readOnly, status: 'exited' });
    await f.flush();
    assert.equal(f.claims.length, 0);
    assert.equal(f.beginRepair(), false);
    await f.confirmRepair();
    f.reclaim();
    await f.flush();
    assert.equal(f.claims.length, 0);
    assert.equal(f.calls.length, 0);
    f.unmount();
  });

  test(`exit releases owned control and blocks repair (readOnly=${readOnly})`, async () => {
    const f = fixture('codex', true, { readOnly });
    await f.flush();
    assert.equal(f.claims.length, 1);
    f.status('exited');
    await f.flush();
    assert.deepEqual(f.releases, [1]);
    assert.equal(f.claims.length, 1, 'exit must not reacquire');
    assert.equal(f.beginRepair(), false);
    const before = f.calls.length;
    await f.confirmRepair();
    f.reclaim();
    await f.flush();
    assert.equal(f.calls.length, before);
    assert.equal(f.writable(), false);
    f.unmount();
    assert.deepEqual(f.releases, [1], 'no double release');
  });
}

test('becoming read-only releases writable control and acquires only a repair lease', async () => {
  const f = fixture('codex', true);
  await f.flush();
  await f.resolve(0, f.snapshot('ready', 1, 1));
  assert.equal(f.writable(), true);
  f.updateSession({ readOnly: true });
  assert.deepEqual(f.releases, [1], 'the writable control reference is released');
  assert.equal(f.writable(), false);
  assert.equal(f.beginRepair(), false, 'repair waits for the replacement lease');
  await f.flush();
  assert.equal(f.claims.length, 2);
  assert.equal(f.calls.length, 1, 'no extra provider connect');
  assert.equal(f.writable(), false);
  assert.equal(f.beginRepair(), true);
  const repairing = f.confirmRepair();
  assert.equal(f.calls[1].method, 'chat.repair');
  assert.equal(f.calls[1].params.leaseEpoch, 2);
  await f.resolve(1, { added: 0, updated: 0, removed: 0, total: 0 });
  await repairing;
  f.unmount();
  assert.deepEqual(f.releases, [1, 2]);
});

test('read-only repair lease survives ordinary statuses but releases on exit', async () => {
  const f = fixture('codex', true, { readOnly: true });
  await f.flush();
  for (const status of ['starting', 'running', 'waiting', 'interrupted', 'error', 'idle']) {
    f.status(status);
    await f.flush();
    assert.equal(f.claims.length, 1);
    assert.equal(f.releases.length, 0);
  }
  f.status('exited');
  await f.flush();
  assert.deepEqual(f.releases, [1]);
  assert.equal(f.claims.length, 1);
  assert.equal(f.beginRepair(), false);
  f.unmount();
});

test('pending read-only repair acquisition releases after exit and cannot start repair', async () => {
  const f = fixture('codex', true, { readOnly: true });
  f.status('exited'); // initial claim has not resolved
  await f.flush();
  assert.deepEqual(f.releases, [1]);
  assert.equal(f.beginRepair(), false);
  await f.confirmRepair();
  assert.equal(f.calls.length, 0);
  f.unmount();
});

test('read-only non-Chat session cannot acquire a repair lease', async () => {
  const f = fixture('codex', true, { readOnly: true, mode: 'terminal' });
  await f.flush();
  assert.equal(f.claims.length, 0);
  assert.equal(f.beginRepair(), false);
  await f.confirmRepair();
  assert.equal(f.calls.length, 0);
  f.unmount();
});
