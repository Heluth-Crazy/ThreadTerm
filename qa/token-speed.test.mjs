import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { collectFooterPresentationInPage, ensureTranscriptLatest, estimateOutputTokens, excludesToolTime, footerSeparatorViolations, followStressPrompt, hasAppliedStressEvent, isolatedProviderEnvironment, observeTurnInPage, tokensPerSecond, transcriptAtBottom, transcriptFollowsLatest, transcriptFollowFailure, transcriptFollowSummary, waitForProviderChat, withinRelative } from './lib/token-speed.mjs';
import scenario from './fixtures/token-speed-echo-acp/scenario.json' with { type: 'json' };
import codexFixture from './fixtures/fake-codex-token-speed.cjs';

// Keep the compiler external when the standard QA runner bundles this test as ESM.
const require = createRequire(import.meta.url);
const ts = require('typescript');

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
function turnProbeHarness({ stress = null, onScroll, clampScrollTo, installProduct } = {}) {
  const log = { scrollHeight: 1000, clientHeight: 400, clientWidth: 400, style: { overflowAnchor: 'none' } };
  let scrollTop = 600;
  Object.defineProperty(log, 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = Math.min(Math.max(0, Number(value) || 0), Math.max(0, log.scrollHeight - log.clientHeight)); } });
  log.scrollTo = ({ top }) => { log.scrollTop = clampScrollTo === undefined ? top : Math.max(top, clampScrollTo); };
  const state = { log, live: null, footerCount: 0, jump: false, scrollEvents: 0, diagnostics: [] };
  const frames = new Map(), timers = new Map(), listeners = new Map(), window = {};
  const resizeObservers = new Set();
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.pending = false; }
    observe() { this.pending = true; resizeObservers.add(this); }
    disconnect() { resizeObservers.delete(this); }
  }
  const content = { append: marker => {
    const height = Number.parseFloat(marker.style.height);
    log.scrollHeight += height;
    marker.remove = () => { log.scrollHeight -= height; log.scrollTop = log.scrollTop; marker.remove = () => {}; };
  } };
  log.lastElementChild = content;
  const product = installProduct?.({ log, content, ResizeObserver, window });
  let serial = 0, observer, observing = false, clock = 0;
  state.log.dispatchEvent = event => { if (event.type === 'scroll') { state.scrollEvents += 1; onScroll?.(state); } };
  const node = {
    querySelector: selector => selector === '.v3-chat-log' ? state.log : selector === '.chat-back-to-bottom' ? state.jump ? { getBoundingClientRect: () => ({ x: 380, y: 700, width: 32, height: 32 }) } : null : state.live,
    querySelectorAll: () => Array.from({ length: state.footerCount }, () => ({})),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  runInNewContext(`(${observeTurnInPage.toString()})(node, { id: 'probe', label: 'dark-en-420', footerCount: 0, stress })`, {
    window, node, Date: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { createElement: () => ({ style: {}, setAttribute() {}, remove() {} }) }, ResizeObserver,
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
    requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setInterval: (callback, ms) => { assert.equal(ms, 250); const id = ++serial; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id), Event: class { constructor(type) { this.type = type; } }, stress, console: { log: value => state.diagnostics.push(value) },
  });
  const frame = (beforeCallbacks, beforeResize) => {
    if (!frames.size) return;
    clock += 16;
    beforeCallbacks?.();
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    beforeResize?.();
    // Rendering update: rAF first, then existing product RO, then the fresh QA
    // observer's initial delivery. No extra frame/task or product scroll event.
    for (const observer of [...resizeObservers]) {
      const size = `${log.scrollHeight}:${log.clientHeight}:${log.clientWidth}`;
      if (observer.pending || observer.size !== size) { observer.pending = false; observer.size = size; observer.callback(); }
    }
  };
  const flush = () => {
    let count = 0;
    while (frames.size) {
      assert.ok(++count < 20, 'bounded frame settling'); frame();
    }
  };
  return { state, window, frames, timers, listeners, flush, frame, resizeObservers, product,
    get observing() { return observing; },
    submit: () => listeners.get('submit')?.(),
    mutate: () => { if (observing) observer(); },
    tick: () => { clock += 250; for (const callback of timers.values()) callback(); },
  };
}

test('turn follow probe arms on submit, samples on live changes and 250 ms ticks, and stops at turn end', () => {
  const fixture = turnProbeHarness(), probe = fixture.window.__tokenSpeedProbe;
  assert.equal(fixture.timers.size, 0); assert.equal(probe.followSamples.length, 0); assert.equal(probe.stress, null);
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

test('turn follow stress skips a short initial transcript, then injects after settled overflow', () => {
  const fixture = turnProbeHarness({ stress: { repeats: 1, offsetPx: 173, loadMs: 0 } }), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.flush();
  assert.equal(probe.stress.attempts.at(-1).reason, 'no-live-indicator');
  fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.state.log.scrollHeight = 560; fixture.state.log.scrollTop = 160;
  fixture.mutate();
  fixture.flush();
  assert.equal(probe.stress.attempts.at(-1).reason, 'insufficient-scroll-range');
  fixture.state.log.scrollHeight = 1000; fixture.state.log.scrollTop = 600;
  fixture.tick(); fixture.flush();
  assert.equal(fixture.state.log.scrollTop, 427); assert.equal(fixture.state.scrollEvents, 2);
  const event = JSON.parse(JSON.stringify(probe.stress.events[0]));
  assert.equal(event.status, 'injected'); assert.equal(event.before.scrollTop, 600); assert.equal(event.primed.scrollTop, 600);
  assert.equal(event.requestedScrollTop, 427); assert.equal(event.appliedScrollTop, 427); assert.equal(event.appliedDisplacement, 173);
  assert.equal(event.afterSettle.scrollTop, 427); assert.equal(event.afterSettle.remainingPx, 173);
  assert.equal(hasAppliedStressEvent(probe.stress), true);
  assert.ok(fixture.state.diagnostics.some(value => value.startsWith('TOKEN SPEED FOLLOW STRESS ')));
  assert.equal(probe.followSamples.at(-1).source, 'stress-settle');
  assert.equal(probe.followSamples.at(-1).remainingPx, 173, 'the unchanged oracle samples after injection');
});

test('turn follow stress records clamped diagnostics without counting them', () => {
  const fixture = turnProbeHarness({ stress: { repeats: 1, offsetPx: 173, loadMs: 0 }, clampScrollTo: 500 }), probe = fixture.window.__tokenSpeedProbe;
  fixture.state.log.scrollHeight = 1000; fixture.state.log.scrollTop = 600; fixture.submit(); fixture.flush();
  fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.mutate(); fixture.flush();
  assert.equal(fixture.state.scrollEvents, 1); assert.equal(probe.stress.attempts.at(-1).reason, 'clamped-scroll'); assert.equal(probe.stress.attempts.at(-1).appliedDisplacement, 100); assert.deepEqual(JSON.parse(JSON.stringify(probe.stress.events)), []);
  assert.equal(hasAppliedStressEvent(probe.stress), false);
  assert.equal(hasAppliedStressEvent({ events: [{ appliedDisplacement: 0 }, { appliedDisplacement: -1 }] }), false);
  assert.equal(hasAppliedStressEvent({ events: [{ appliedDisplacement: 0.5 }] }), true);
});

test('turn follow stress settles pending diagnostics and cancels queued frames on cleanup', () => {
  const fixture = turnProbeHarness({ stress: { repeats: 1, offsetPx: 173, loadMs: 0 } }), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.flush(); fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.mutate(); fixture.frame(); fixture.frame();
  assert.equal(probe.stress.events.length, 1); assert.ok(fixture.frames.size > 0, 'stress settle is queued');
  probe.stop('failure-cleanup');
  assert.ok(probe.stress.events[0].afterSettle); assert.equal(fixture.frames.size, 0); assert.equal(fixture.timers.size, 0); assert.equal(fixture.observing, false);
});

test('stress prompt leaves normal fixture text unchanged and adds deterministic overflow only when enabled', () => {
  const prompt = 'Token speed estimate';
  assert.equal(followStressPrompt(prompt, false), prompt);
  const stressed = followStressPrompt(prompt, true);
  assert.ok(stressed.startsWith(`${prompt}\n\nQA follow stress context`));
  assert.equal((stressed.match(/Follow stress context line/g) ?? []).length, 48);
});

function loadViewport(path, react = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(output, { module, exports: module.exports, require: name => name === 'react' ? react : (() => { throw new Error(`Unexpected module ${name}`); })(), ...globals });
  return module.exports;
}

function installViewportProduct({ log, content, ResizeObserver, window }) {
  const cleanups = [];
  const react = { useCallback: callback => callback, useRef: current => ({ current }), useState: value => [value, () => {}],
    useLayoutEffect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); } };
  const { useChatViewport } = loadViewport(new URL('../renderer/src/useChatViewport.ts', import.meta.url), react, { ResizeObserver, window });
  const viewport = useChatViewport('frame-order-regression', true, { current: log }, { current: content });
  return { viewport, stop: () => cleanups.forEach(cleanup => cleanup()) };
}

test('49 px late growth is pre-RO; the actual product hook corrects before the QA observation', () => {
  const fixture = turnProbeHarness({ installProduct: installViewportProduct }), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.flush();
  fixture.state.log.scrollHeight = 1509; fixture.state.log.clientHeight = 585; fixture.state.log.scrollTop = 924;
  fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.mutate(); fixture.frame();
  fixture.frame(() => { fixture.state.log.scrollHeight = 1558; });
  const sample = probe.followSamples.at(-1);
  assert.equal(sample.beforeResizeObserver.scrollTop, 924); assert.equal(sample.beforeResizeObserver.remainingPx, 49);
  assert.equal(sample.phase, 'resize-observer'); assert.equal(sample.scrollTop, 973); assert.equal(sample.remainingPx, 0);
  assert.equal(fixture.product.viewport.followRef.current, true);
  assert.equal(transcriptFollowFailure(probe.label, probe.followSamples), null);
  probe.stop('test-cleanup'); fixture.product.stop(); assert.equal(fixture.resizeObservers.size, 0);
});

test('a missing product resize correction still fails at 49 px with follow enabled and no jump button', () => {
  const fixture = turnProbeHarness(), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.flush();
  fixture.state.log.scrollHeight = 1509; fixture.state.log.clientHeight = 585; fixture.state.log.scrollTop = 924;
  fixture.tick(); fixture.frame(); fixture.frame(() => { fixture.state.log.scrollHeight = 1558; });
  assert.equal(probe.followSamples.at(-1).remainingPx, 49);
  assert.equal(probe.followSamples.at(-1).jump.visible, false);
  fixture.state.log.scrollTop = 973; fixture.tick(); fixture.flush();
  assert.equal(transcriptFollowSummary(probe.followSamples).failureCount, 1, 'later recovery cannot erase a post-layout failure');
  assert.match(transcriptFollowFailure(probe.label, probe.followSamples), /"remainingPx":49/);
  probe.stop('test-cleanup'); assert.equal(fixture.resizeObservers.size, 0);
});

test('stress injects 49 px in rAF and records the actual hook correction in that rendering update', () => {
  const fixture = turnProbeHarness({ stress: { repeats: 1, offsetPx: 173, loadMs: 0, layoutGrowthPx: 49 }, installProduct: installViewportProduct }), probe = fixture.window.__tokenSpeedProbe;
  fixture.state.log.dispatchEvent = () => fixture.product.viewport.onScroll();
  fixture.submit(); fixture.flush();
  fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
  fixture.mutate(); fixture.flush();
  assert.equal(probe.stress.layoutEvents.length, 1);
  const event = probe.stress.layoutEvents[0];
  assert.equal(event.appliedGrowthPx, 49); assert.equal(event.afterGrowth.remainingPx, 49);
  assert.equal(event.afterResizeObserver.remainingPx, 0); assert.equal(event.afterResizeObserver.following, true);
  assert.ok(probe.followSamples.some(sample => sample.beforeResizeObserver?.remainingPx === 49 && sample.remainingPx === 0));
  assert.equal(transcriptFollowFailure(probe.label, probe.followSamples), null);
  assert.equal(fixture.state.log.scrollHeight, 1000, 'QA marker removed');
  probe.stop('test-cleanup'); fixture.product.stop(); assert.equal(fixture.resizeObservers.size, 0);
});

test('cleanup before initial QA ResizeObserver delivery disconnects it without leaving work', () => {
  const fixture = turnProbeHarness(), probe = fixture.window.__tokenSpeedProbe;
  fixture.submit(); fixture.frame();
  fixture.frame(undefined, () => {
    assert.equal(fixture.resizeObservers.size, 1); probe.stop('abort-before-layout');
  });
  assert.equal(fixture.resizeObservers.size, 0); assert.equal(fixture.frames.size, 0); assert.equal(fixture.timers.size, 0);
  const count = probe.followSamples.length; fixture.tick(); fixture.flush(); assert.equal(probe.followSamples.length, count);
});

function followScrollHandler(nextViewportFollow) {
  let follow = true, inspecting = false, previous;
  return state => {
    const current = { scrollTop: state.log.scrollTop, scrollHeight: state.log.scrollHeight, clientHeight: state.log.clientHeight, clientWidth: state.log.clientWidth };
    const next = nextViewportFollow(follow, inspecting, previous, current);
    if (next) inspecting = false; else if (follow) inspecting = true;
    follow = next; state.log.style.overflowAnchor = follow ? 'none' : 'auto'; state.jump = !follow;
    if (follow) state.log.scrollTop = state.log.scrollHeight;
    previous = { scrollTop: state.log.scrollTop, scrollHeight: state.log.scrollHeight, clientHeight: state.log.clientHeight, clientWidth: state.log.clientWidth };
  };
}

test('the serialized stress probe reproduces the legacy follow loss and current helper recovery', () => {
  const baseline = (follow, inspecting, previous, current) => {
    if (inspecting) return false;
    if (current.scrollHeight - current.scrollTop - current.clientHeight < 24) return true;
    const layoutChanged = !previous || current.scrollHeight !== previous.scrollHeight || current.clientHeight !== previous.clientHeight || current.clientWidth !== previous.clientWidth;
    return follow && (layoutChanged || current.scrollTop >= previous.scrollTop);
  };
  const patched = loadViewport(new URL('../renderer/src/useChatViewport.ts', import.meta.url)).nextViewportFollow;
  const run = next => {
    const fixture = turnProbeHarness({ stress: { repeats: 3, offsetPx: 173, loadMs: 0 }, onScroll: followScrollHandler(next) }), probe = fixture.window.__tokenSpeedProbe;
    fixture.submit(); fixture.flush();
    fixture.state.live = { dataset: { tokensPerSecond: '50', estimated: 'true' }, textContent: '≈ 50 tok/s' };
    fixture.mutate(); fixture.flush();
    return { fixture, probe };
  };
  const legacy = run(baseline), current = run(patched);
  assert.equal(legacy.probe.stress.events.length, 1); assert.equal(legacy.probe.stress.events[0].appliedDisplacement, 173);
  assert.equal(legacy.probe.stress.events[0].afterSettle.following, false); assert.equal(legacy.probe.stress.events[0].afterSettle.jumpVisible, true);
  assert.match(transcriptFollowFailure(legacy.probe.label, legacy.probe.followSamples), /^product: transcript stopped following/);
  assert.equal(current.probe.stress.events.length, 3); assert.deepEqual(Array.from(current.probe.stress.events, event => event.appliedDisplacement), [173, 173, 173]);
  assert.ok(current.probe.stress.events.every(event => event.afterSettle.following && !event.afterSettle.jumpVisible));
  assert.equal(transcriptFollowFailure(current.probe.label, current.probe.followSamples), null);
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

// Exercise real hook handlers as well as the pure focus geometry rules.
function focusViewportHarness() {
  const fixture = turnProbeHarness({ installProduct: installViewportProduct });
  const { log } = fixture.state, { viewport } = fixture.product;
  const target = { getBoundingClientRect: () => ({ top: 102 + target.contentTop - log.scrollTop }), contentTop: 200 };
  log.clientTop = 2;
  log.getBoundingClientRect = () => ({ top: 100 });
  log.contains = element => element === target;
  log.focus = () => viewport.onFocus({ target: log });
  const resize = () => { for (const observer of fixture.resizeObservers) observer.callback(); };
  return { fixture, log, target, viewport, resize };
}

test('actual focus handler preserves an earlier card across scroll, output and resize in either browser ordering', () => {
  for (const focusAfterScroll of [false, true]) {
    const { fixture, log, target, viewport, resize } = focusViewportHarness();
    if (focusAfterScroll) log.scrollTop = 200;
    viewport.onFocus({ target });
    assert.equal(viewport.followRef.current, false);
    viewport.onScroll(); // May still contain the queued old bottom position.
    assert.equal(viewport.followRef.current, false);
    log.scrollTop = 200;
    viewport.onScroll();
    log.scrollHeight += 173;
    resize();
    assert.equal(log.scrollTop, 200, 'streaming cannot yank focus back to the bottom');
    viewport.followLatest();
    assert.equal(viewport.followRef.current, true, 'focus on transcript root does not undo jump-to-latest');
    assert.equal(log.scrollTop, 773);
    fixture.product.stop();
  }
});

test('actual focus handler ignores the root, outside targets and controls in the latest viewport', () => {
  const { fixture, log, target, viewport, resize } = focusViewportHarness();
  viewport.onFocus({ target: log });
  viewport.onFocus({ target: {} });
  target.contentTop = 700;
  viewport.onFocus({ target });
  assert.equal(viewport.followRef.current, true);
  log.scrollHeight += 49;
  resize();
  assert.equal(log.scrollTop, 649);
  fixture.product.stop();
});

test('explicit navigation API pauses before a product jump and keeps its position through layout changes', () => {
  const { fixture, log, viewport, resize } = focusViewportHarness();
  viewport.pauseForNavigation();
  viewport.onScroll();
  log.scrollTop = 120;
  viewport.onScroll();
  log.scrollHeight += 173;
  resize();
  assert.equal(viewport.followRef.current, false);
  assert.equal(log.scrollTop, 120);
  viewport.onWheel({ deltaY: 1, ctrlKey: false });
  log.scrollTop = log.scrollHeight;
  viewport.onScroll();
  assert.equal(viewport.followRef.current, true, 'scrolling down to bottom resumes');
  fixture.product.stop();
});

test('visual consistency reveal helper focuses the real card control before scrolling and survives the next resize', async () => {
  const path = new URL('../qa/chat-visual-consistency.mjs', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'revealSurface');
  assert.ok(declaration, 'exercise the actual visual consistency scroll helper');
  const revealSurface = runInNewContext(`(${declaration.getText(source)})`);
  const { fixture, log, target, viewport, resize } = focusViewportHarness();
  const actions = [];
  target.getClientRects = () => [{}];
  target.closest = () => null;
  target.getAttribute = () => null;
  target.focus = () => {
    actions.push('focus');
    viewport.onFocus({ target });
    log.scrollTop = target.contentTop;
    viewport.onScroll();
  };
  const node = { closest: () => log, querySelectorAll: () => [target] };
  await revealSurface({ evaluate: callback => callback(node), scrollIntoViewIfNeeded: async () => {
    actions.push('reveal'); log.scrollTop = target.contentTop; viewport.onScroll();
  } });
  assert.deepEqual(actions, ['focus', 'reveal']);
  assert.equal(viewport.followRef.current, false);
  log.scrollHeight += 173;
  resize();
  assert.equal(log.scrollTop, 200, 'card controls stay visible through helper layout checks');
  fixture.product.stop();
});
