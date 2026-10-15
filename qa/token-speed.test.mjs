import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { collectFooterPresentationInPage, ensureTranscriptLatest, estimateOutputTokens, excludesToolTime, footerSeparatorViolations, isolatedProviderEnvironment, observeTurnInPage, tokensPerSecond, transcriptAtBottom, transcriptFollowsLatest, transcriptFollowFailure, transcriptFollowSummary, waitForProviderChat, withinRelative } from './lib/token-speed.mjs';
import scenario from './fixtures/token-speed-echo-acp/scenario.json' with { type: 'json' };
import codexFixture from './fixtures/fake-codex-token-speed.cjs';

test('token estimator: ASCII runs, whitespace and per-run rounding', () => {
  for (const [text, expected] of [['', 0], [' \n\t', 0], ['abcd', 1], ['abcde', 2], ['a b c d', 4], ['hello world', 4]]) {
    assert.equal(estimateOutputTokens(text), expected, JSON.stringify(text));
  }
});

test('token estimator: CJK, kana, hangul, full-width and mixed runs', () => {
  for (const [text, expected] of [['中文测试', 4], ['かなカナ한글ＡＢ', 8], ['abc中文abcde', 5], ['𠀀', 1], ['abc中def', 3]]) {
    assert.equal(estimateOutputTokens(text), expected, text);
  }
});

test('token estimator: emoji count as code points in non-CJK runs', () => {
  assert.equal(estimateOutputTokens('😀😀😀😀'), 1);
  assert.equal(estimateOutputTokens('😀😀😀😀😀'), 2);
  assert.equal(estimateOutputTokens('😀 中 😀'), 3);
});

test('display rules hide insufficient data and round tokens per second', () => {
  assert.equal(tokensPerSecond(0, 1000), null);
  assert.equal(tokensPerSecond(10, 249), null);
  assert.equal(tokensPerSecond(10, 250), 40);
  assert.equal(tokensPerSecond(53, 1100), 48);
  assert.equal(tokensPerSecond(NaN, 1000), null);
  assert.equal(tokensPerSecond(10, Infinity), null);
});

test('tool exclusion check rejects a whole-turn denominator inside ±35%', () => {
  const tokens = 410, generationMs = 4100, toolMs = 1500;
  assert.equal(withinRelative(73, 100), true, 'ordinary tolerance alone misses this regression');
  assert.equal(excludesToolTime(100, tokens, generationMs, toolMs), true);
  assert.equal(excludesToolTime(73, tokens, generationMs, toolMs), false);
  assert.equal(withinRelative(140, 100), false);
});

test('provider PATH drops every case variant and includes fixture/Node/System32 only', () => {
  const env = isolatedProviderEnvironment({ Path: 'real-provider', PATH: 'other-provider', path: 'third-provider', PaTh: 'fourth', HOME: 'real-home', UserProfile: 'real-profile', APPDATA: 'real-appdata', LOCALAPPDATA: 'real-local', CODEX_HOME: 'real-codex', THREADTERM_V3_DEV_SERVER_URL: 'real-dev', TT_QA_TOKEN_SPEED_CODEX_LOG: 'old-log', KEEP: 'yes' }, { bin: 'fake-bin', nodeDir: 'node-only', system32: 'system-only' });
  assert.deepEqual(env, { KEEP: 'yes', PATH: 'fake-bin;node-only;system-only' });
});

test('ACP fixture has stable known token count and discriminating expected rates', () => {
  const tokens = estimateOutputTokens(scenario.firstChunks.join('') + scenario.secondChunks.join(''));
  const generationMs = scenario.firstTokenMs + scenario.firstStreamMs + scenario.secondStreamMs;
  assert.equal(tokens, 88);
  assert.equal(generationMs, 4100);
  assert.equal(tokensPerSecond(tokens, generationMs), 21);
  assert.equal(tokensPerSecond(tokens, generationMs + scenario.toolMs), 16);
  assert.equal(excludesToolTime(21, tokens, generationMs, scenario.toolMs), true);
  assert.equal(excludesToolTime(16, tokens, generationMs, scenario.toolMs), false);
});

test('Codex fixture exact counts cannot be confused with text estimates or whole-turn timing', () => {
  const scenario = codexFixture.TOKEN_SPEED_CODEX_SCENARIO;
  const tokens = scenario.firstOutputTokens + scenario.secondOutputTokens;
  const generationMs = scenario.firstTokenMs + scenario.firstStreamMs + scenario.secondStreamMs;
  assert.equal(tokens, 800);
  assert.equal(estimateOutputTokens(scenario.firstChunks.join('') + scenario.secondChunks.join('')), 46);
  assert.equal(tokensPerSecond(tokens, generationMs), 250);
  assert.equal(tokensPerSecond(tokens, generationMs + scenario.toolMs), 190);
  assert.equal(excludesToolTime(250, tokens, generationMs, scenario.toolMs), true);
  assert.equal(excludesToolTime(190, tokens, generationMs, scenario.toolMs), false);
});

// Execute the actual CJS entry point with in-memory stdio/fs, without spawning
// a provider or child process. The ../qa path also works in the QA runner's
// .tmp bundle directory.
function bootCodexFixture(args, configured = true) {
  const module = { exports: {} }, logs = [], messages = [], stdout = [];
  const stopped = Symbol('fixture exit');
  let receive, exitCode = null;
  const require = name => {
    if (name === 'node:fs') return { appendFileSync: (_path, line) => logs.push(JSON.parse(line)) };
    if (name === 'node:readline') return { createInterface: () => ({ on: (_event, callback) => { receive = callback; } }) };
    throw new Error(`Unexpected fixture dependency ${name}`);
  };
  require.main = module;
  const process = { argv: ['node', 'fake-codex-token-speed.cjs', ...args], env: configured ? { TT_QA_TOKEN_SPEED_CODEX_LOG: 'memory', TT_QA_TOKEN_SPEED_CODEX_CWD: 'fixture-work' } : {},
    stdin: {}, stdout: { write: line => messages.push(JSON.parse(line)) }, exit: code => { exitCode = code; throw stopped; } };
  try {
    runInNewContext(readFileSync(new URL('../qa/fixtures/fake-codex-token-speed.cjs', import.meta.url), 'utf8'), { module, require, process, console: { log: value => stdout.push(value) }, setTimeout });
  } catch (error) { if (error !== stopped) throw error; }
  return { logs, messages, stdout, exitCode, request: value => { assert.ok(receive, 'app-server stdin is open'); receive(JSON.stringify(value)); } };
}

test('Codex CLI discovery: version and login status succeed before app-server', () => {
  const version = bootCodexFixture(['--version']);
  assert.equal(version.exitCode, 0); assert.match(version.stdout.join(''), /qa-token-speed-codex/);
  const login = bootCodexFixture(['login', 'status']);
  assert.equal(login.exitCode, 0); assert.match(login.stdout.join(''), /offline QA fixture/);
  assert.equal(login.messages.length, 0, 'login status is a CLI probe, not JSON-RPC');
  assert.equal(login.logs[0].method, 'login/status'); assert.equal(login.logs[0].params.exitCode, 0);
  assert.equal(bootCodexFixture(['login', 'status'], false).exitCode, 0, 'offline auth probe needs no app-server configuration');
  assert.equal(bootCodexFixture(['unsupported']).exitCode, 64);
});

test('Codex app-server accepts leading overrides and persistent empty-thread verification', () => {
  const fixture = bootCodexFixture(['-c', 'mcp_servers.fixture.command="node"', 'app-server']);
  assert.equal(fixture.exitCode, null);
  fixture.request({ id: 1, method: 'initialize' });
  fixture.request({ id: 2, method: 'thread/start' });
  const threadId = fixture.messages.find(row => row.id === 2).result.thread.id;
  fixture.request({ id: 3, method: 'thread/inject_items', params: { threadId, items: [{ type: 'message', role: 'developer', content: [] }] } });
  assert.ok(fixture.messages.find(row => row.id === 3).result);
  const verifier = bootCodexFixture(['app-server']);
  verifier.request({ id: 4, method: 'thread/read', params: { threadId, includeTurns: true } });
  const thread = verifier.messages.find(row => row.id === 4).result.thread;
  assert.equal(thread.id, threadId); assert.equal(thread.source, 'user'); assert.equal(thread.ephemeral, false);
  assert.ok(Array.isArray(thread.turns)); assert.equal(thread.turns.length, 0);
});

test('provider discovery records an unauthenticated row before a successful probe', async () => {
  let clock = 0, calls = 0;
  const diagnostics = [], rejected = { id: 'codex', installed: true, auth: 'unauthenticated', chat: false, reason: 'Codex CLI is not authenticated' };
  const ready = { id: 'codex', installed: true, auth: 'authenticated', chat: true };
  assert.equal(await waitForProviderChat({ provider: 'codex', readProviders: async () => [calls++ === 0 ? rejected : ready], onDiagnostic: value => diagnostics.push(value), now: () => clock, pause: async ms => { clock += ms; } }), ready);
  assert.deepEqual(diagnostics[0].row, rejected); assert.equal(diagnostics[0].probeError, rejected.reason);
  assert.equal(diagnostics.at(-1).row, ready); assert.equal(diagnostics.at(-1).timedOut, false);
});

test('provider discovery timeout preserves Codex row and its native probe reason', async () => {
  let clock = 0, diagnostic;
  const row = { id: 'codex', installed: true, auth: 'unauthenticated', chat: false, reason: 'Codex CLI is not authenticated' };
  await assert.rejects(waitForProviderChat({ provider: 'codex', label: 'native fake Codex discovered', readProviders: async () => [row], onDiagnostic: value => { diagnostic = value; }, timeoutMs: 10, pollMs: 5, now: () => clock, pause: async ms => { clock += ms; } }), /Timed out: native fake Codex discovered; Codex CLI is not authenticated/);
  assert.equal(diagnostic.timedOut, true); assert.deepEqual(diagnostic.row, row);
  assert.equal(diagnostic.probeError, row.reason); assert.equal(diagnostic.requestError, null);
});

test('provider discovery timeout retains provider.list RPC errors and missing-row state', async () => {
  let diagnostic;
  const error = Object.assign(new Error('Provider detection failed'), { code: 'provider_detection_failed' });
  await assert.rejects(waitForProviderChat({ provider: 'codex', readProviders: async () => { throw error; }, onDiagnostic: value => { diagnostic = value; }, timeoutMs: 0 }), /Provider detection failed/);
  assert.equal(diagnostic.row, null); assert.equal(diagnostic.timedOut, true);
  assert.equal(diagnostic.requestError.code, error.code); assert.equal(diagnostic.requestError.message, error.message);
  await assert.rejects(waitForProviderChat({ provider: 'codex', readProviders: async () => [], onDiagnostic: value => { diagnostic = value; }, timeoutMs: 0 }), /contains no matching row/);
  assert.equal(diagnostic.row, null); assert.equal(diagnostic.requestError, null);
});

test('transcript bottom check handles fractional scroll offsets and rejects off-screen history', () => {
  assert.equal(transcriptAtBottom({ scrollTop: 599.5, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(transcriptAtBottom({ scrollTop: 450, scrollHeight: 1000, clientHeight: 400 }), false);
  assert.equal(transcriptAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), true);
  assert.equal(transcriptAtBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 0 }), false);
  assert.equal(transcriptAtBottom({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 400 }), false);
  assert.equal(transcriptAtBottom({ scrollTop: 598, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(transcriptAtBottom({ scrollTop: 597.9, scrollHeight: 1000, clientHeight: 400 }), false);
});

function latestHarness({ scrollTop = 450, present = true, visible = true, onClick, onScroll } = {}) {
  let clock = 0, clicks = 0, scrolls = 0;
  const diagnostics = [];
  const state = { scrollTop, scrollHeight: 1000, clientHeight: 400,
    jump: { present, visible, rect: present ? { x: 380, y: 700, width: 32, height: 32 } : null } };
  const reachLatest = () => { state.scrollTop = 600; state.jump.present = false; state.jump.visible = false; state.jump.rect = null; };
  const run = () => ensureTranscriptLatest({ label: 'light-zh-CN-420', timeoutMs: 10, pollMs: 5,
    measure: async () => structuredClone({ ...state, remainingPx: state.scrollHeight - state.clientHeight - state.scrollTop }),
    clickJump: async () => { clicks += 1; await onClick?.({ state, clicks, reachLatest }); },
    scrollToBottom: async () => { scrolls += 1; await onScroll?.({ state, reachLatest }); },
    settle: async () => {}, now: () => clock, pause: async ms => { clock += ms; },
    onDiagnostic: value => diagnostics.push(structuredClone(value)),
  });
  return { run, diagnostics, state, get clicks() { return clicks; }, get scrolls() { return scrolls; } };
}

test('follow latest prefers the product control and records the initial scroll state', async () => {
  const fixture = latestHarness({ onClick: ({ reachLatest }) => reachLatest() });
  await fixture.run();
  assert.equal(fixture.clicks, 1); assert.equal(fixture.scrolls, 0);
  assert.equal(fixture.diagnostics[0].status, 'pending');
  const done = fixture.diagnostics.at(-1);
  assert.equal(done.method, 'jump-to-latest'); assert.equal(done.before.scrollTop, 450);
  assert.equal(done.before.jump.present, true); assert.equal(done.before.jump.rect.width, 32);
  assert.equal(done.status, 'ready'); assert.equal(done.last.remainingPx, 0);
});

test('follow latest scrolls only when the product control is initially absent', async () => {
  const fixture = latestHarness({ present: false, visible: false, onScroll: ({ reachLatest }) => reachLatest() });
  await fixture.run();
  assert.equal(fixture.clicks, 0); assert.equal(fixture.scrolls, 1);
  assert.equal(fixture.diagnostics.at(-1).status, 'ready');
});

test('follow latest fails explicitly when the jump control stays visible at the geometric bottom', async () => {
  const fixture = latestHarness({ scrollTop: 600 });
  await assert.rejects(fixture.run(), /product: transcript cannot reach latest at light-zh-CN-420:.*"scrollTop":600.*"scrollHeight":1000.*"clientHeight":400/);
  assert.equal(fixture.clicks, 2, 'one initial click plus exactly one diagnostic retry');
  assert.equal(fixture.scrolls, 0, 'do not scroll around the product failure');
  const failed = fixture.diagnostics.at(-1);
  assert.equal(failed.status, 'product-failure'); assert.equal(failed.timeout.remainingPx, 0);
  assert.equal(failed.timeout.jump.present, true); assert.equal(failed.timeout.jump.visible, true);
  assert.equal(failed.retry.attempted, true); assert.equal(failed.retry.succeeded, true);
  assert.equal(failed.retry.after.jump.rect.height, 32); assert.equal(failed.retry.settled.jump.visible, true);
  assert.ok(fixture.diagnostics.some(value => value.status === 'timed-out'));
});

test('follow latest records an unreachable bottom and click errors without a scrolling workaround', async () => {
  const fixture = latestHarness({ onClick: () => { throw new Error('control click failed'); } });
  await assert.rejects(fixture.run(), /product: transcript cannot reach latest at light-zh-CN-420:.*"remainingPx":150/);
  const failed = fixture.diagnostics.at(-1);
  assert.equal(failed.initialActionError, 'control click failed');
  assert.equal(failed.retry.clickError, 'control click failed'); assert.equal(failed.retry.succeeded, false);
  assert.equal(failed.timeout.scrollTop, 450); assert.equal(failed.retry.after.scrollTop, 450);
  assert.equal(fixture.clicks, 2); assert.equal(fixture.scrolls, 0);
});

test('follow latest records a successful timeout click if the product control appears after reflow', async () => {
  const fixture = latestHarness({ present: false, visible: false,
    onScroll: ({ state }) => { state.jump = { present: true, visible: true, rect: { x: 380, y: 700, width: 32, height: 32 } }; },
    onClick: ({ reachLatest }) => reachLatest(),
  });
  await fixture.run();
  const done = fixture.diagnostics.at(-1);
  assert.equal(fixture.scrolls, 1); assert.equal(fixture.clicks, 1);
  assert.equal(done.status, 'ready-after-timeout-click'); assert.equal(done.timeout.remainingPx, 150);
  assert.equal(done.retry.before.jump.present, true); assert.equal(done.retry.succeeded, true);
  assert.equal(done.retry.after.remainingPx, 0); assert.equal(done.retry.settled.jump.visible, false);
});

test('resize follow detection requires both the 2 px bottom and no visible jump control', () => {
  const before = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400, jump: { visible: false } };
  assert.equal(transcriptFollowsLatest(before), true);
  assert.equal(transcriptFollowsLatest({ ...before, scrollTop: 352.4 }), false, '247.6 px resize loss is a product failure');
  assert.equal(transcriptFollowsLatest({ ...before, jump: { visible: true } }), false, 'arrow at geometric bottom is still a follow failure');
  assert.equal(transcriptFollowsLatest({ ...before, scrollTop: 598 }), true);
  assert.equal(transcriptFollowsLatest({ ...before, scrollTop: 597.9 }), false);
});

test('turn follow summary preserves transient failures and reports the worst sample', () => {
  const base = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600, jump: { visible: false } };
  const arrowOnly = { ...base, at: 1, jump: { visible: true } };
  const worst = { ...base, at: 2, scrollTop: 352.4, remainingPx: 247.6, jump: { visible: true } };
  const samples = [base, arrowOnly, worst, base];
  const summary = transcriptFollowSummary(samples);
  assert.equal(summary.sampleCount, 4); assert.equal(summary.failureCount, 2); assert.equal(summary.worstSample, worst);
  assert.match(transcriptFollowFailure('dark-en-420', samples), /^product: transcript stopped following during the turn at dark-en-420:.*"remainingPx":247.6/);
  assert.equal(transcriptFollowFailure('wide', [base]), null);
});

// Fake DOM, frames and timer clock exercise the exact serialized page probe;
// no Electron, provider, real timer or child process is started.
function turnProbeHarness() {
  const state = { log: { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, live: null, footerCount: 0, jump: false };
  const frames = new Map(), timers = new Map(), listeners = new Map(), window = {};
  let serial = 0, observer, observing = false, clock = 0;
  const node = {
    querySelector: selector => selector === '.v3-chat-log' ? state.log : selector === '.chat-back-to-bottom' ? state.jump ? { getBoundingClientRect: () => ({ x: 380, y: 700, width: 32, height: 32 }) } : null : state.live,
    querySelectorAll: () => Array.from({ length: state.footerCount }, () => ({})),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  runInNewContext(`(${observeTurnInPage.toString()})(node, { id: 'probe', label: 'dark-en-420', footerCount: 0 })`, {
    window, node, Date: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
    requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setInterval: (callback, ms) => { assert.equal(ms, 250); const id = ++serial; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id),
  });
  const flush = () => {
    let count = 0;
    while (frames.size) {
      assert.ok(++count < 10, 'bounded frame settling'); clock += 16;
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    }
  };
  return { state, window, frames, timers, listeners, flush,
    get observing() { return observing; },
    submit: () => listeners.get('submit')?.(),
    mutate: () => { if (observing) observer(); },
    tick: () => { clock += 250; for (const callback of timers.values()) callback(); },
  };
}

test('turn follow probe arms on submit, samples on live changes and 250 ms ticks, and stops at turn end', () => {
  const fixture = turnProbeHarness(), probe = fixture.window.__tokenSpeedProbe;
  assert.equal(fixture.timers.size, 0); assert.equal(probe.followSamples.length, 0);
  fixture.submit(); fixture.flush();
  assert.equal(fixture.timers.size, 1); assert.equal(probe.followSamples[0].source, 'send');
  fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.mutate(); fixture.flush();
  assert.equal(probe.followSamples.at(-1).source, 'live-change'); assert.equal(probe.samples.length, 1);
  fixture.tick(); fixture.flush(); assert.equal(probe.followSamples.at(-1).source, 'interval-250ms');
  fixture.state.live = null; fixture.mutate(); fixture.tick(); fixture.flush();
  assert.equal(probe.finished, false); assert.equal(fixture.timers.size, 1, 'tool/first-response gaps do not stop active-turn follow sampling');
  fixture.state.live = null; fixture.state.footerCount = 1; fixture.mutate(); fixture.flush();
  assert.equal(probe.finished, true); assert.equal(probe.stopReason, 'turn-end'); assert.equal(probe.followSamples.at(-1).source, 'turn-end');
  assert.equal(fixture.timers.size, 0); assert.equal(fixture.frames.size, 0); assert.equal(fixture.observing, false); assert.equal(fixture.listeners.size, 0);
  const count = probe.followSamples.length;
  fixture.tick(); fixture.mutate(); fixture.flush(); assert.equal(probe.followSamples.length, count, 'zero idle sampling');
});

test('turn follow probe retains a streaming follow loss after recovery and abort cleanup cancels pending work', () => {
  const fixture = turnProbeHarness(), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.flush();
  fixture.state.log.scrollTop = 450; fixture.state.jump = true;
  fixture.tick(); fixture.flush();
  fixture.state.log.scrollTop = 600; fixture.state.jump = false;
  fixture.tick(); fixture.flush();
  assert.equal(transcriptFollowSummary(probe.followSamples).failureCount, 1);
  assert.match(transcriptFollowFailure(probe.label, probe.followSamples), /^product: transcript stopped following during the turn at dark-en-420:/);
  fixture.tick(); assert.ok(fixture.frames.size > 0);
  probe.stop('failure-cleanup');
  assert.equal(probe.finished, true); assert.equal(fixture.timers.size, 0); assert.equal(fixture.frames.size, 0); assert.equal(fixture.observing, false);
});

test('footer separators accept a single visible segment and separators between visible segments', () => {
  const segment = text => ({ kind: 'segment', text, source: text });
  const dot = { kind: 'separator', text: '·', source: '::before' };
  assert.deepEqual(footerSeparatorViolations({ text: '≈ 21 tok/s', tokens: [segment('≈ 21 tok/s')] }), []);
  assert.deepEqual(footerSeparatorViolations({ text: '800 out 250 tok/s', tokens: [segment('800 out'), dot, segment('250 tok/s')] }), []);
});

test('footer separators reject leading/trailing/generated dots, duplicate dots and missing separators', () => {
  const segment = { kind: 'segment', text: '≈ 21 tok/s', source: 'speed' }, dot = { kind: 'separator', text: '·', source: 'speed::before' };
  for (const tokens of [[dot, segment], [segment, dot], [segment, dot, dot, segment], [segment, segment]]) {
    assert.ok(footerSeparatorViolations({ text: '≈ 21 tok/s', tokens }).length > 0, JSON.stringify(tokens));
  }
  assert.ok(footerSeparatorViolations({ text: '· ≈ 21 tok/s', tokens: [segment] }).length > 0);
  assert.ok(footerSeparatorViolations({ text: '≈ 21 tok/s ·', tokens: [segment] }).length > 0);
});

function footerPresentationFixture({ leadingDot = false, twoSegments = false, explicitDot = false } = {}) {
  const element = (className, text, { display = 'inline', before = 'none' } = {}) => ({
    nodeType: 1, tagName: 'SPAN', className, childNodes: [{ nodeType: 3, textContent: text }],
    style: { display, visibility: 'visible', opacity: '1', content: 'normal' },
    before: { display: 'inline', visibility: 'visible', opacity: '1', content: before },
    getBoundingClientRect: () => ({ width: display === 'none' ? 0 : 100, height: 12 }),
    matches: selector => selector === '.chat-turn-segment' && className.split(' ').includes('chat-turn-segment'),
  });
  const hidden = element('chat-turn-segment is-out', '88 out', { display: 'none', before: '"·"' });
  const speed = element('chat-turn-segment is-speed', '≈ 21 tok/s', { before: leadingDot || (twoSegments && !explicitDot) ? '"·"' : 'none' });
  const row = element('chat-turn-meta', '');
  row.tagName = 'P'; row.innerText = twoSegments ? 'Worked for 6 s ≈ 21 tok/s' : '≈ 21 tok/s';
  row.childNodes = [...(twoSegments ? [element('chat-turn-segment is-duration', 'Worked for 6 s')] : []), hidden,
    ...(explicitDot ? [element('chat-turn-separator', '·')] : []), speed];
  const footer = { querySelector: selector => selector === '.chat-turn-meta' ? row : null };
  return JSON.parse(JSON.stringify(runInNewContext(`(${collectFooterPresentationInPage.toString()})(footer)`, {
    footer, getComputedStyle: (node, pseudo) => pseudo === '::before' ? node.before : pseudo === '::after' ? { ...node.before, content: 'none' } : node.style,
  })));
}

test('footer collector detects the pre-F4 leading CSS dot even though innerText has none', () => {
  const broken = footerPresentationFixture({ leadingDot: true });
  assert.equal(broken.text, '≈ 21 tok/s');
  assert.equal(broken.tokens[0].kind, 'separator');
  assert.ok(footerSeparatorViolations(broken).length > 0);
  const fixed = footerPresentationFixture();
  assert.deepEqual(fixed.tokens.map(token => token.kind), ['segment']);
  assert.deepEqual(footerSeparatorViolations(fixed), []);
});

test('footer collector ignores hidden segments and accepts generated or explicit between-segment dots', () => {
  for (const explicitDot of [false, true]) {
    const presentation = footerPresentationFixture({ twoSegments: true, explicitDot });
    assert.deepEqual(presentation.tokens.map(token => token.kind), ['segment', 'separator', 'segment']);
    assert.deepEqual(footerSeparatorViolations(presentation), []);
    assert.doesNotMatch(presentation.renderedText, /88 out/);
  }
});
