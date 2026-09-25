// Isolated Electron integration QA for pane divider drags driving the real
// TerminalSurface resize chain: PaneWorkspace drag -> flex layout -> ResizeObserver ->
// FitAddon -> terminal.resize RPC (with lease epoch) -> mock Codex repainting its status
// bar at the new column count. The fixture mounts the production PaneWorkspace and
// TerminalSurface with an in-memory bridge; no provider, runtime, or user profile.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-pane-terminal-resize-'));
const out = resolve('qa/results/pane-terminal-resize');
await mkdir(out, { recursive: true });

const entry = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { PaneWorkspace } from './renderer/src/components/PaneWorkspace';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const nativeResizeObserver = window.ResizeObserver;
const resizeCallbacks = [];
window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.native = new nativeResizeObserver(entries => callback(entries, this));
    resizeCallbacks.push(() => callback([], this));
  }
  observe(target) { this.native.observe(target); }
  unobserve(target) { this.native.unobserve(target); }
  disconnect() { this.native.disconnect(); }
};
window.qaTriggerResize = (count = 1) => {
  for (let iteration = 0; iteration < count; iteration += 1) {
    for (const callback of [...resizeCallbacks]) callback();
  }
};

window.qaTerminals = [];
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function(element) {
  window.qaTerminals.push(this);
  return originalOpen.call(this, element);
};

const encoder = new TextEncoder();
const boot = id => Array.from({ length: 60 }, (_, index) => 'BOOT-' + id + '-' + String(index).padStart(3, '0') + ' initial scrollback line').join('\\r\\n') + '\\r\\n' + 'PROMPT-' + id + ' > ';
const listeners = {};
const cursors = {};
window.qaFailResizes = 0;
window.qaMetrics = { subscribe: {}, claims: {}, requests: [] };
const emitFrame = (sessionId, cols) => {
  const listener = listeners[sessionId];
  if (!listener) return;
  const label = 'STATUS width=' + cols + ' ';
  const bar = label + ''.padEnd(cols - label.length - 1, '~') + '#';
  const text = '\\x1b[2J\\x1b[HFRAME-COLS-' + cols + '\\r\\n' + bar;
  const data = encoder.encode(text);
  const at = cursors[sessionId] ?? 0;
  cursors[sessionId] = at + data.byteLength;
  void listener({ sessionId, cursor: at, data, gap: false });
};
window.threadterm = {
  platform: 'win32',
  windowsPty: { backend: 'conpty', buildNumber: 22631 },
  onEvent: () => () => {},
  subscribeOutput: async (sessionId, requestedCursor, listener) => {
    window.qaMetrics.subscribe[sessionId] = (window.qaMetrics.subscribe[sessionId] ?? 0) + 1;
    window.qaMetrics.subscribe[sessionId + ':cursor'] = requestedCursor;
    listeners[sessionId] = listener;
    const data = encoder.encode(boot(sessionId));
    cursors[sessionId] = data.byteLength;
    await listener({ sessionId, cursor: 0, data, gap: false });
    return () => { window.qaMetrics.subscribe[sessionId + ':unsubscribed'] = (window.qaMetrics.subscribe[sessionId + ':unsubscribed'] ?? 0) + 1; };
  },
  request: async (method, params) => {
    if (method === 'terminal.read') return { nextCursor: encoder.encode(boot(params.sessionId)).byteLength };
    if (method === 'terminal.resize') {
      const fail = window.qaFailResizes > 0;
      window.qaMetrics.requests.push({ method, sessionId: params.sessionId, cols: params.cols, rows: params.rows, leaseEpoch: params.leaseEpoch, failed: fail });
      if (fail) { window.qaFailResizes -= 1; throw new Error('qa injected resize failure'); }
      emitFrame(params.sessionId, params.cols);
      return null;
    }
    if (method === 'session.claim') {
      window.qaMetrics.claims[params.sessionId] = (window.qaMetrics.claims[params.sessionId] ?? 0) + 1;
      return { leaseEpoch: 91 };
    }
    if (method === 'session.renew' || method === 'session.release') return {};
    return null;
  },
  openExternal: async () => {},
  openWindow: async () => {},
};

const mkSession = (id, title) => ({ id, provider: 'codex', mode: 'terminal', status: 'running', title, createdAt: 'now', updatedAt: 'now' });
const sessions = [mkSession('qa-resize-left', 'Resize Left'), mkSession('qa-resize-right', 'Resize Right')];
const pane = (id, sessionId) => ({ kind: 'pane', id, tabs: [{ id: 'tab-' + id, kind: 'session', sessionId }], activeTabId: 'tab-' + id });
const initialLayout = { kind: 'split', id: 'root', direction: 'horizontal', ratio: 0.5, first: pane('left', 'qa-resize-left'), second: pane('right', 'qa-resize-right') };

function Fixture() {
  const [layout, setLayout] = useState(initialLayout);
  useEffect(() => { window.qaLayout = layout; }, [layout]);
  return <I18nProvider locale="en"><PaneWorkspace layout={layout} sessions={sessions} theme="dark" terminalCompatibility={{}} onChange={setLayout} /></I18nProvider>;
}
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')).render(<Fixture />);
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="qa.css">
<style>
html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root{display:flex;min-width:0;min-height:0}
.pane-workspace{width:100%;height:100%;display:flex;min-width:0;min-height:0}.workspace-pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.ws-tile-bar{display:flex;flex:0 0 32px;min-width:0}.pane-body{display:flex;flex:1;min-width:0;min-height:0}.pane-divider{background:color-mix(in srgb,#579 18%,transparent)}
html[data-theme="dark"]{background:#12161d;color:#ecf2f8}
</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1600, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});
`);

let app;
let page;
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], screenshots: [], geometry: {} };

const terminalState = which => page.evaluate(side => {
  const terminal = window.qaTerminals.find(candidate => candidate.element?.closest('[data-pane-id]')?.dataset.paneId === side);
  if (!terminal) throw new Error('terminal for ' + side + ' is unavailable');
  const paneEl = document.querySelector('[data-pane-id="' + side + '"]');
  const host = paneEl?.querySelector('.terminal-host');
  const paneBox = paneEl?.getBoundingClientRect();
  const text = [];
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) text.push(buffer.getLine(y)?.translateToString(true) ?? '');
  let statusLine;
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (line && line.translateToString(true).startsWith('STATUS width=')) {
      statusLine = { trimmed: line.translateToString(true).length, wrapped: line.isWrapped, viewport: y >= buffer.baseY && y < buffer.baseY + terminal.rows };
    }
  }
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    stdinDisabled: terminal.options.disableStdin,
    paneWidth: paneBox?.width,
    hostWidth: host?.clientWidth,
    bufferText: text.join('\n'),
    statusLine,
  };
}, which);

const resizeCalls = (sessionId, extra = '') => page.evaluate(({ id }) =>
  window.qaMetrics.requests.filter(call => call.method === 'terminal.resize' && call.sessionId === id),
  { id: sessionId }).then(calls => extra ? calls.filter(call => (extra === 'failed') === call.failed) : calls);

const lastResize = async sessionId => (await resizeCalls(sessionId)).at(-1);

const waitForFrame = side => page.waitForFunction(paneId => {
  const terminal = window.qaTerminals.find(candidate => candidate.element?.closest('[data-pane-id]')?.dataset.paneId === paneId);
  if (!terminal) return false;
  const marker = 'FRAME-COLS-' + terminal.cols;
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) {
    if ((buffer.getLine(y)?.translateToString(true) ?? '').includes(marker)) return true;
  }
  return false;
}, side, { timeout: 10_000, polling: 100 });

const dragDivider = async (page_, fraction) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const divider = page_.locator('[data-split-id="root"] > .pane-divider');
    await divider.waitFor();
    const box = await divider.boundingBox();
    const parent = await page_.locator('[data-split-id="root"]').boundingBox();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const ratioBefore = await page_.evaluate(() => window.qaLayout.ratio);
    await page_.mouse.move(start.x, start.y);
    await page_.mouse.down();
    await page_.waitForTimeout(10);
    await page_.mouse.move(parent.x + parent.width * fraction, start.y, { steps: 8 });
    await page_.mouse.up();
    await page_.waitForTimeout(120);
    const ratioAfter = await page_.evaluate(() => window.qaLayout.ratio);
    (report.geometry.drags = report.geometry.drags ?? []).push({ fraction, start, ratioBefore, ratioAfter });
    const missed = Math.abs(ratioAfter - ratioBefore) < 0.01 && Math.abs(ratioAfter - fraction) > 0.05;
    if (!missed) return;
  }
  throw new Error(`divider drag towards ${fraction} never moved the ratio (pointer missed the 4px divider)`);
};

const assertFinalConsistency = async (label, sides) => {
  for (const side of sides) {
    const state = await terminalState(side);
    const sessionId = side === 'left' ? 'qa-resize-left' : 'qa-resize-right';
    const last = await lastResize(sessionId);
    assert.ok(last, `${label}: ${side} never sent a resize`);
    assert.equal(last.failed, false, `${label}: ${side} last resize must have succeeded`);
    assert.equal(last.cols, state.cols, `${label}: ${side} last resize cols must equal final xterm cols`);
    assert.equal(last.rows, state.rows, `${label}: ${side} last resize rows must equal final xterm rows`);
    assert.equal(last.leaseEpoch, 91, `${label}: ${side} resize must carry the acquired lease epoch`);
  }
};

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaTerminals?.length === 2, null, { timeout: 20_000 });
  await page.waitForFunction(() =>
    window.qaMetrics.requests.filter(call => call.method === 'terminal.resize' && !call.failed).length >= 2
    && window.qaMetrics.claims['qa-resize-left'] === 1
    && window.qaMetrics.claims['qa-resize-right'] === 1, null, { timeout: 20_000 });
  await page.evaluate(() => { window.qaBaselineTerminals = window.qaTerminals.slice(); });

  const before = { left: await terminalState('left'), right: await terminalState('right') };
  assert.ok(before.left.cols > 40 && before.right.cols > 40, `baseline panes unexpectedly narrow: ${before.left.cols}/${before.right.cols}`);
  assert.ok(before.left.bufferText.includes('BOOT-qa-resize-left-000'), 'left boot scrollback missing before drag; buffer head: ' + JSON.stringify(before.left.bufferText.slice(0, 400)));
  report.checks.push('both running terminals mounted with one subscription, one claim, one initial resize each');
  assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-resize-left']), 1);
  assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-resize-right']), 1);

  // Phase 1: drag the divider so the left pane lands near 78 columns (the user scenario).
  const workspaceBox = await page.locator('.pane-workspace').boundingBox();
  let fraction = Math.min(0.9, Math.max(0.1, (before.left.paneWidth * (78 / before.left.cols)) / workspaceBox.width));
  let narrowed;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dragDivider(page, fraction);
    narrowed = { left: await terminalState('left'), right: await terminalState('right') };
    if (Math.abs(narrowed.left.cols - 78) <= 6) break;
    const workspace = await page.locator('.pane-workspace').boundingBox();
    fraction = Math.min(0.9, Math.max(0.1, (78 * (narrowed.left.paneWidth / narrowed.left.cols)) / workspace.width));
  }
  narrowed = { left: await terminalState('left'), right: await terminalState('right') };
  await waitForFrame('left');
  assert.ok(Math.abs(narrowed.left.cols - 78) <= 6, `left pane should land near 78 columns, got ${narrowed.left.cols}`);
  assert.ok(narrowed.left.paneWidth < before.left.paneWidth - 40, 'left pane DOM width did not shrink');
  assert.ok(narrowed.left.hostWidth < before.left.hostWidth - 40, 'left terminal host width did not shrink');
  assert.ok(narrowed.right.paneWidth > before.right.paneWidth + 40, 'right pane DOM width did not grow');
  assert.ok(narrowed.left.cols < before.left.cols, 'left xterm cols did not shrink');
  assert.ok(narrowed.right.cols > before.right.cols, 'right xterm cols did not grow');
  await assertFinalConsistency('wide to narrow drag', ['left', 'right']);
  assert.ok(narrowed.left.bufferText.includes(`FRAME-COLS-${narrowed.left.cols}`), 'mock Codex did not repaint at the new column count');
  assert.ok(narrowed.left.statusLine, 'mock Codex status line missing after resize');
  assert.equal(narrowed.left.statusLine.trimmed, narrowed.left.cols, 'status line must be drawn exactly to the live column count');
  assert.equal(narrowed.left.statusLine.wrapped, false, 'status line must fit the live width without wrapping');
  assert.ok(narrowed.left.bufferText.includes('BOOT-qa-resize-left-000'), 'old scrollback was lost during resize');
  report.checks.push(`wide->narrow drag: left ${before.left.cols} -> ${narrowed.left.cols} cols, final resize matches xterm, provider repaints inside the live width, scrollback retained`);
  await page.screenshot({ path: join(out, 'after-narrow-drag.png') });
  report.screenshots.push('after-narrow-drag.png');

  // Phase 2: identical geometry notifications must not resend the RPC.
  const settledCount = (await resizeCalls('qa-resize-left')).length + (await resizeCalls('qa-resize-right')).length;
  await page.waitForTimeout(400);
  const afterWaitCount = (await resizeCalls('qa-resize-left')).length + (await resizeCalls('qa-resize-right')).length;
  assert.equal(afterWaitCount, settledCount, 'resize RPCs continued after the drag settled');
  await page.evaluate(() => window.qaTriggerResize(5));
  await page.waitForTimeout(150);
  const afterTriggerCount = (await resizeCalls('qa-resize-left')).length + (await resizeCalls('qa-resize-right')).length;
  assert.equal(afterTriggerCount, settledCount, 'identical ResizeObserver notifications resent the resize RPC');
  report.checks.push('settled layout sends no further resize RPCs; identical observer notifications are deduplicated');

  // Phase 3: drag back wider; the active prompt frame must repaint at the larger width.
  await dragDivider(page, 0.62);
  await waitForFrame('left');
  const widened = { left: await terminalState('left'), right: await terminalState('right') };
  assert.ok(widened.left.cols > narrowed.left.cols, 'narrow->wide drag did not increase left cols');
  await assertFinalConsistency('narrow to wide drag', ['left', 'right']);
  assert.ok(widened.left.bufferText.includes(`FRAME-COLS-${widened.left.cols}`), 'provider did not repaint the prompt frame at the wider width');
  assert.equal(widened.left.statusLine.trimmed, widened.left.cols);
  assert.ok(widened.left.bufferText.includes('BOOT-qa-resize-left-000'), 'old scrollback lost after widening');
  report.checks.push(`narrow->wide drag: left ${narrowed.left.cols} -> ${widened.left.cols} cols, final resize delivered, prompt repainted, scrollback kept`);

  // Phase 4: rapid consecutive drags keep the final size and never duplicate RPCs.
  for (const fraction of [0.3, 0.75, 0.5]) await dragDivider(page, fraction);
  await waitForFrame('left');
  await assertFinalConsistency('rapid drags', ['left', 'right']);
  const rapidCalls = await resizeCalls('qa-resize-left');
  for (let index = 1; index < rapidCalls.length; index += 1) {
    const previous = rapidCalls[index - 1];
    const current = rapidCalls[index];
    assert.ok(previous.cols !== current.cols || previous.rows !== current.rows || previous.leaseEpoch !== current.leaseEpoch,
      `consecutive identical resize RPCs ${previous.cols}x${previous.rows}@${previous.leaseEpoch}`);
  }
  assert.ok(rapidCalls.length < 60, `resize RPC storm suspected: ${rapidCalls.length} requests`);
  report.checks.push('rapid consecutive drags end with the final size delivered and no duplicate RPCs');

  // Phase 5: injected resize failures. The failed final resize must be retried once
  // automatically (bounded), leave a diagnosable state, and recover on the next observer pass.
  const preFail = { left: await terminalState('left') };
  const leftCallsBeforeFailure = (await resizeCalls('qa-resize-left')).length;
  await page.evaluate(() => { window.qaFailResizes = 100; });
  await dragDivider(page, 0.68);
  await page.waitForTimeout(700);
  const failState = await terminalState('left');
  assert.notEqual(failState.cols, preFail.left.cols, 'local xterm must still track the pane size while resize RPCs fail');
  const failedAtFinal = (await resizeCalls('qa-resize-left', 'failed')).filter(call => call.cols === failState.cols && call.rows === failState.rows);
  assert.ok(failedAtFinal.length >= 2, `the failed final resize must be retried once automatically; got ${failedAtFinal.length} attempts at ${failState.cols}x${failState.rows}`);
  const totalDuringFailure = (await resizeCalls('qa-resize-left')).length;
  assert.ok(totalDuringFailure < leftCallsBeforeFailure + 50, `failure retries must stay bounded, got ${totalDuringFailure} (was ${leftCallsBeforeFailure})`);
  const issue = page.locator('[data-pane-id="left"] .surface-error');
  await issue.waitFor({ timeout: 5_000 });
  assert.match(await issue.textContent() ?? '', /resize/i, 'a diagnosable resize failure state must surface');
  assert.equal(failState.stdinDisabled, false, 'input must stay enabled while resize RPCs fail');
  assert.ok(failState.bufferText.includes('BOOT-qa-resize-left-000'), 'existing output must survive failed resizes');
  report.checks.push('injected resize failure: bounded automatic retry, diagnosable state, input/output unaffected');

  await page.evaluate(() => { window.qaFailResizes = 0; });
  await page.evaluate(() => window.qaTriggerResize(1));
  await page.waitForFunction(() => document.querySelectorAll('.surface-error').length === 0, null, { timeout: 5_000, polling: 100 });
  await page.waitForTimeout(400);
  await assertFinalConsistency('post-failure recovery', ['left', 'right']);
  assert.equal(await page.locator('[data-pane-id="left"] .surface-error').count(), 0, 'recovery must clear the resize failure state');
  report.checks.push('next observer pass retries the failed resize and clears the diagnostic state');

  // Cross-cutting: no remounts, no resubscriptions across the whole run.
  assert.equal(await page.evaluate(() => window.qaTerminals.every((terminal, index) => terminal === window.qaBaselineTerminals[index]) && window.qaTerminals.length === 2), true, 'a drag rebuilt a TerminalSurface xterm instance');
  assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-resize-left']), 1, 'left subscription was re-established');
  assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-resize-right']), 1, 'right subscription was re-established');
  assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-resize-left:unsubscribed'] ?? 0), 0, 'left subscription was torn down');
  report.checks.push('TerminalSurface instances and output subscriptions survive every drag phase');

  await page.screenshot({ path: join(out, 'final.png') });
  report.screenshots.push('final.png');
  assert.deepEqual(errors, []);
  report.geometry = { before: { left: before.left.cols, right: before.right.cols }, narrowed: { left: narrowed.left.cols, right: narrowed.right.cols }, widened: { left: widened.left.cols, right: widened.right.cols }, failedAtFinalAttempts: failedAtFinal.length };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {});
  console.log(JSON.stringify({ passed: report.passed, out, checks: report.checks, geometry: report.geometry, error: report.error }, null, 2));
}
