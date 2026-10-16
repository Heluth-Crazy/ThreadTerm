import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeFrame, fixtureConnectStarted, selectWorkerOwner, summarizeFrames, waitForNonReadyConnection } from './lib/chat-connect-transition.mjs';

const chip = { selector: '.chat-status-anchor', classes: ['chat-status-anchor'], rect: { left: 12, top: 14, width: 90, height: 24 }, text: 'Connecting to Codex' };

test('crash health retries a pre-exit ready race until authoritative disconnect', async () => {
  const replies = [{ phase: 'ready' }, { phase: 'ready' }, { phase: 'disconnected', connectionGeneration: 2 }];
  const waits = [];
  let reads = 0;
  const result = await waitForNonReadyConnection(async () => replies[reads++], async ms => { waits.push(ms); });
  assert.equal(result, replies[2]);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [50, 50]);
});

test('crash health stops after its bound and never waits after a terminal response', async () => {
  let reads = 0, waits = 0;
  await assert.rejects(waitForNonReadyConnection(async () => { reads++; return { phase: 'ready' }; }, async () => { waits++; }, 3), /remained ready after 3 health checks/);
  assert.equal(reads, 3); assert.equal(waits, 2);
  for (const phase of ['disconnected', 'connecting', 'failed']) {
    const state = { phase };
    assert.equal(await waitForNonReadyConnection(async () => state, async () => { assert.fail('non-ready response must finish immediately'); }), state);
  }
});

test('full mask reports only non-structural topmost elements', () => {
  const result = analyzeFrame({
    fullOverlay: true,
    overlayEffectiveOpacity: 1,
    gridTop: [{ selector: '.chat-view', structural: true }, chip],
  });
  assert.deepEqual(result, { leaks: [{ kind: 'topmost', element: chip }], readinessGap: false });
});

test('painted status controls fail under an opaque inert full mask', () => {
  const dot = { selector: '.chat-connection-dot', effectiveOpacity: 1, rect: { left: 20, top: 20, width: 8, height: 8 } };
  const ring = { selector: '.chat-context-ring', effectiveOpacity: 1, rect: { left: 36, top: 20, width: 20, height: 20 } };
  const popover = { selector: '.chat-connection-popover', effectiveOpacity: 1, rect: { left: 5, top: 48, width: 160, height: 80 } };
  const result = analyzeFrame({ fullOverlay: true, overlayEffectiveOpacity: 1, renderedOutside: [dot, ring, popover] });
  assert.deepEqual(result.leaks.map(leak => [leak.kind, leak.element.selector]), [
    ['painted-outside', '.chat-connection-dot'],
    ['painted-outside', '.chat-context-ring'],
    ['painted-outside', '.chat-connection-popover'],
  ]);
});

test('entrance frames retain painted and fade-through classifications', () => {
  const faded = analyzeFrame({ fullOverlay: true, overlayEffectiveOpacity: 0.89, renderedOutside: [chip, { selector: '.chat-pane', structural: true }] });
  assert.deepEqual(faded.leaks, [{ kind: 'painted-outside', element: chip }, { kind: 'fade-through', element: chip }]);
  assert.deepEqual(analyzeFrame({ fullOverlay: true, overlayEffectiveOpacity: 0.9, renderedOutside: [chip] }).leaks, [{ kind: 'painted-outside', element: chip }]);
});

test('non-painted descriptors are ignored defensively and banners remain allowed', () => {
  const hidden = { selector: '.hidden', visibility: 'hidden', effectiveOpacity: 1, rect: { width: 20, height: 20 } };
  const transparent = { selector: '.transparent', effectiveOpacity: 0, rect: { width: 20, height: 20 } };
  const collapsed = { selector: '.collapsed', effectiveOpacity: 1, rect: { width: 0, height: 20 } };
  assert.deepEqual(analyzeFrame({ fullOverlay: true, renderedOutside: [hidden, transparent, collapsed] }).leaks, []);
  assert.deepEqual(analyzeFrame({ overlayPresent: true, fullOverlay: false, renderedOutside: [chip] }).leaks, []);
});

test('summary deduplicates leaks and records compact overlay-relative bounds', () => {
  const summary = summarizeFrames([
    { time: 80, fullOverlay: false },
    { time: 100, fullOverlay: true, overlayEffectiveOpacity: 0, gridTop: [chip], renderedOutside: [chip] },
    { time: 116, fullOverlay: true, overlayEffectiveOpacity: 0.5, gridTop: [chip], renderedOutside: [chip] },
    { time: 220, fullOverlay: true, overlayEffectiveOpacity: 1, gridTop: [chip] },
    { time: 236, fullOverlay: false, composerReady: true, transcriptReady: true, expectsTranscript: true },
  ]);
  assert.deepEqual(summary.overlay, { firstMs: 0, lastMs: 120 });
  assert.equal(summary.leaks.length, 2);
  assert.deepEqual(summary.leaks[0], {
    kind: 'topmost', firstMs: 0, lastMs: 120,
    element: { selector: '.chat-status-anchor', classes: 'chat-status-anchor', rect: chip.rect, text: 'Connecting to Codex' },
  });
  assert.deepEqual(summary.leaks[1], {
    kind: 'painted-outside', firstMs: 0, lastMs: 16,
    element: { selector: '.chat-status-anchor', classes: 'chat-status-anchor', rect: chip.rect, text: 'Connecting to Codex' },
  });
  assert.deepEqual(summary.fadeCandidates.map(candidate => [candidate.kind, candidate.firstMs, candidate.lastMs]), [['fade-through', 0, 16]]);
});

test('an absent transcript does not prolong the exit check when no transcript is expected', () => {
  const summary = summarizeFrames([
    { time: 10, fullOverlay: false, composerReady: false, transcriptReady: false, expectsTranscript: true },
    { time: 20, fullOverlay: true, overlayEffectiveOpacity: 1 },
    { time: 30, fullOverlay: true, overlayEffectiveOpacity: 1 },
    { time: 40, fullOverlay: false, composerReady: true, transcriptReady: false, expectsTranscript: false },
    { time: 50, fullOverlay: false, composerReady: false, transcriptReady: false, expectsTranscript: true },
    { time: 70, fullOverlay: false, composerReady: true, transcriptReady: true, expectsTranscript: true },
  ]);
  assert.deepEqual(summary.leaks, []);
});

test('a banner-only overlay starts the readiness interval', () => {
  const summary = summarizeFrames([
    { time: 10, overlayPresent: true },
    { time: 30, overlayPresent: false, composerReady: false, transcriptReady: true, expectsTranscript: false },
  ]);
  assert.deepEqual(summary.overlay, { firstMs: 0, lastMs: 0 });
  assert.equal(summary.leaks[0].kind, 'exit-not-ready');
  assert.deepEqual(summary.leaks[0].element, { selector: '.chat-view', text: 'composer not ready' });
});

test('a reconnect banner suppresses readiness while the composer is deliberately disabled', () => {
  const summary = summarizeFrames([
    { time: 10, fullOverlay: true },
    { time: 20, fullOverlay: false, overlayPresent: true, composerReady: false, transcriptReady: false, expectsTranscript: true },
    { time: 30, overlayPresent: false, composerReady: true, transcriptReady: true, expectsTranscript: true },
  ]);
  assert.deepEqual(summary.leaks, []);
});

test('readiness checks every removal interval when an overlay reappears', () => {
  const summary = summarizeFrames([
    { time: 100, fullOverlay: true },
    { time: 110, overlayPresent: false, composerReady: false, transcriptReady: true, expectsTranscript: false },
    { time: 120, overlayPresent: true, composerReady: false, transcriptReady: true, expectsTranscript: false },
    { time: 130, overlayPresent: false, composerReady: false, transcriptReady: true, expectsTranscript: false },
  ]);
  assert.deepEqual(summary.leaks.map(leak => [leak.kind, leak.firstMs, leak.lastMs]), [
    ['exit-not-ready', 10, 10],
    ['exit-not-ready', 30, 30],
  ]);
});

test('visible content before the first mask is an entry flash only when the pane is mounted and not ready', () => {
  const summary = summarizeFrames([
    { time: 50, panePresent: false, emptyStateVisible: true, composerReady: false },
    { time: 60, panePresent: true, emptyStateVisible: true, composerReady: true },
    { time: 70, panePresent: true, emptyStateVisible: true, composerReady: false },
    { time: 80, fullOverlay: true },
    { time: 90, composerReady: true },
  ]);
  assert.deepEqual(summary.leaks.map(leak => [leak.kind, leak.firstMs, leak.lastMs]), [['entry-not-ready', -10, -10]]);
});

test('old steady-state status anchor fails while a clean full mask passes', () => {
  const oldFrame = {
    time: 100, fullOverlay: true, overlayEffectiveOpacity: 1,
    renderedOutside: [{ selector: '.chat-status-anchor', classes: ['chat-status-anchor'], effectiveOpacity: 1, rect: { left: 1102, top: 795, width: 26, height: 26 }, text: 'Connecting' }],
  };
  assert.equal(summarizeFrames([oldFrame]).leaks[0].kind, 'painted-outside');
  assert.deepEqual(summarizeFrames([{ ...oldFrame, renderedOutside: [] }]).leaks, []);
});

test('worker-owner selection ignores verification readers and crashed processes', () => {
  const rows = [
    { pid: 10, direction: 'in', method: 'thread/read', params: { threadId: 'native' } },
    { pid: 10, direction: 'out', method: 'response', params: { result: { thread: { id: 'native' } } } },
    { pid: 11, direction: 'in', method: 'thread/resume', params: { threadId: 'native' } },
    { pid: 11, direction: 'out', method: 'response', params: { result: { thread: { id: 'native' } } } },
    { pid: 11, direction: 'fixture', method: 'crashed', params: {} },
    { pid: 12, direction: 'in', method: 'thread/start', params: {} },
    { pid: 12, direction: 'out', method: 'response', params: { result: { thread: { id: 'native' } } } },
  ];
  assert.deepEqual(selectWorkerOwner(rows, 'native'), { pid: 12, opener: rows[5], result: rows[6], openerIndex: 5, resultIndex: 6 });
});

test('fixture connect gate uses provider requests instead of a ready-only connection status', () => {
  const rows = [
    { pid: 21, direction: 'in', method: 'thread/read', params: { threadId: 'native' } },
    { pid: 22, direction: 'in', method: 'thread/resume', params: { threadId: 'other' } },
    { pid: 23, direction: 'in', method: 'thread/resume', params: { threadId: 'native' } },
  ];
  assert.equal(fixtureConnectStarted(rows, 0, 'native'), rows[2]);
  assert.equal(fixtureConnectStarted([{ pid: 24, direction: 'in', method: 'thread/start', params: {} }], -1, 'native')?.pid, 24);
});

test('a composer ready within two frames after the mask leaves passes; a slower one fails', () => {
  const quick = summarizeFrames([
    { time: 100, fullOverlay: true },
    { time: 108, overlayPresent: false, composerReady: false, transcriptReady: true, expectsTranscript: false },
    { time: 116, overlayPresent: false, composerReady: true, transcriptReady: true, expectsTranscript: false },
  ]);
  assert.deepEqual(quick.leaks, []);
  const slow = summarizeFrames([
    { time: 100, fullOverlay: true },
    { time: 108, overlayPresent: false, composerReady: false, transcriptReady: true, expectsTranscript: false },
    { time: 150, overlayPresent: false, composerReady: true, transcriptReady: true, expectsTranscript: false },
  ]);
  assert.deepEqual(slow.leaks.map(leak => leak.kind), ['exit-not-ready']);
});
