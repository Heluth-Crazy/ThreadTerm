// Isolated Electron QA for TerminalSurface history and lifecycle semantics.
// The fixture uses the production component and styles with an in-memory bridge;
// it never starts a provider or reads a user's runtime database.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-history-'));
const out = resolve('qa/results/terminal-history');
await mkdir(out, { recursive: true });

const initialHistory = Array.from(
  { length: 2_600 },
  (_, index) => `HISTORY-${String(index).padStart(4, '0')} preserved terminal row`,
).join('\r\n') + '\r\n';

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const nativeResizeObserver = window.ResizeObserver;
const resizeCallbacks = [];
window.qaWheelEvents = [];
window.qaScrollPositions = [];
document.addEventListener('wheel', event => {
  if (window.qaWheelEvents.length < 12) {
    window.qaWheelEvents.push({
      deltaY: event.deltaY, deltaMode: event.deltaMode, altKey: event.altKey,
      target: event.target?.className ?? event.target?.nodeName,
    });
  }
}, true);
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
    for (const callback of resizeCallbacks) callback();
  }
};

const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function(element) {
  window.qaTerminal = this;
  const result = originalOpen.call(this, element);
  this.onScroll(position => window.qaScrollPositions.push(position));
  return result;
};

const encoder = new TextEncoder();
const initialBytes = encoder.encode(${JSON.stringify(initialHistory)});
let outputListener;
let cursor = initialBytes.byteLength;
window.qaBridgeMetrics = { subscribeCalls: 0, unsubscribeCalls: 0, requests: [] };
window.threadterm = {
  platform: 'win32',
  windowsPty: { backend: 'conpty', buildNumber: 19045 },
  onEvent: () => () => {},
  subscribeOutput: async (sessionId, requestedCursor, listener) => {
    window.qaBridgeMetrics.subscribeCalls += 1;
    window.qaBridgeMetrics.requestedCursor = requestedCursor;
    outputListener = listener;
    await listener({ sessionId, cursor: 0, data: initialBytes, gap: false });
    return () => { window.qaBridgeMetrics.unsubscribeCalls += 1; };
  },
  request: async (method, params) => {
    window.qaBridgeMetrics.requests.push({ method, params });
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 73 };
    return null;
  },
  openExternal: async () => {},
};
window.qaEmit = async text => {
  if (!outputListener) throw new Error('output subscription is not ready');
  const data = encoder.encode(text);
  const chunkCursor = cursor;
  cursor += data.byteLength;
  await outputListener({ sessionId: 'qa-terminal-history', cursor: chunkCursor, data, gap: false });
};

function Fixture() {
  const [status, setStatus] = useState('running');
  const [hints, setHints] = useState(false);
  window.qaSetStatus = setStatus;
  window.qaSetHints = setHints;
  const session = {
    id: 'qa-terminal-history', provider: 'kimi', mode: 'terminal', status,
    title: 'Terminal history QA', createdAt: 'now', updatedAt: 'now',
  };
  return <I18nProvider locale="en-US"><div className="qa-terminal"><TerminalSurface
    sessionId={session.id} provider="kimi" theme="dark"
    terminalCompatibility={{aiCompletionHints:hints}} session={session}
  /></div></I18nProvider>;
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
<style>html,body,#root,.qa-terminal{height:100%;margin:0}.qa-terminal{display:flex;min-height:0;padding:12px;box-sizing:border-box}.qa-terminal>.terminal-wrap{flex:1;min-width:0;min-height:0}</style>
<div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 840, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});
`);

const terminalState = page => page.evaluate(() => {
  const terminal = window.qaTerminal;
  if (!terminal) throw new Error('instrumented xterm instance is unavailable');
  return {
    baseY: terminal.buffer.active.baseY,
    viewportY: terminal.buffer.active.viewportY,
    length: terminal.buffer.active.length,
    cols: terminal.cols,
    rows: terminal.rows,
    scrollback: terminal.options.scrollback,
    scrollOnEraseInDisplay: terminal.options.scrollOnEraseInDisplay,
    windowsPty: terminal.options.windowsPty,
    firstVisible: terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true),
  };
});

let app;
let page;
const report = { passed: false, checks: [], screenshots: [] };
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaTerminal?.buffer.active.baseY > 1_000, null, { timeout: 15_000 });

  const initial = await terminalState(page);
  assert.equal(initial.scrollback, 10_000);
  assert.equal(initial.scrollOnEraseInDisplay, false);
  assert.deepEqual(initial.windowsPty, { backend: 'conpty', buildNumber: 19045 });
  assert.ok(initial.baseY > 1_000, `expected more than 1,000 history rows, got ${initial.baseY}`);
  assert.equal(await page.evaluate(() => window.qaBridgeMetrics.subscribeCalls), 1);
  report.checks.push('10,000-row scrollback and Win10 ConPTY metadata reach the actual xterm instance');

  const scrollable = page.locator('.terminal-host .xterm-scrollable-element');
  await scrollable.hover();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(25);
  }
  const wheelScrolled = await terminalState(page);
  assert.ok(wheelScrolled.viewportY < initial.viewportY, 'real wheel events did not move the xterm viewport upward');
  const observedWheelEvents = await page.evaluate(() => window.qaWheelEvents);
  assert.ok(observedWheelEvents.length > 0, 'the terminal did not receive a wheel event');
  assert.ok(observedWheelEvents.some(event => String(event.target).includes('xterm')), `unexpected wheel targets: ${JSON.stringify(observedWheelEvents)}`);

  const slider = page.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider');
  const [sliderBox, scrollableBox] = await Promise.all([slider.boundingBox(), scrollable.boundingBox()]);
  assert.ok(sliderBox && scrollableBox, 'xterm vertical scrollbar geometry is unavailable');
  await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sliderBox.x + sliderBox.width / 2, scrollableBox.y + 4, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => window.qaTerminal.buffer.active.viewportY < 400);
  const scrolled = await terminalState(page);
  assert.ok(scrolled.viewportY < 400, `wheel stopped at history row ${scrolled.viewportY}`);
  assert.match(scrolled.firstVisible ?? '', /^HISTORY-0[0-3]\d{2}/, `unexpected oldest visible row: ${scrolled.firstVisible}`);
  await page.screenshot({ path: join(out, 'history-wheel-up.png') });
  report.screenshots.push('history-wheel-up.png');
  report.checks.push('real wheel events move upward and the native xterm scrollbar reaches rows older than the former 1,000-row limit');

  await page.evaluate(() => {
    const crlf = String.fromCharCode(13, 10);
    return window.qaEmit(Array.from({ length: 40 }, (_, index) => `LIVE-${String(index).padStart(3, '0')} appended while reading`).join(crlf) + crlf);
  });
  const afterOutput = await terminalState(page);
  assert.equal(afterOutput.viewportY, scrolled.viewportY, 'new output moved the user away from the history being read');
  assert.ok(afterOutput.baseY - scrolled.baseY >= 40, 'the 40 appended rows did not extend the terminal buffer');
  await page.locator('.terminal-new-output').waitFor();
  report.checks.push('new output preserves the scrolled viewport and exposes the return-to-bottom control');

  await page.waitForFunction(() => window.qaBridgeMetrics.requests.some(call => call.method === 'terminal.resize'));
  const resizeCount = await page.evaluate(() => window.qaBridgeMetrics.requests.filter(call => call.method === 'terminal.resize').length);
  await page.evaluate(() => window.qaTriggerResize(4));
  await page.waitForTimeout(100);
  const resizeRequests = await page.evaluate(() => window.qaBridgeMetrics.requests.filter(call => call.method === 'terminal.resize'));
  assert.equal(resizeRequests.length, resizeCount, 'identical ResizeObserver notifications sent duplicate resize RPCs');
  assert.equal(new Set(resizeRequests.map(call => `${call.params.leaseEpoch}:${call.params.cols}:${call.params.rows}`)).size, resizeRequests.length);
  report.checks.push('repeated identical resize notifications are deduplicated per lease and geometry');

  const settingsIdentityPreserved = await page.evaluate(async () => {
    const before = window.qaTerminal;
    window.qaSetHints(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    return before === window.qaTerminal;
  });
  assert.equal(settingsIdentityPreserved, true, 'completion hint setting replaced the terminal');
  assert.equal(await page.evaluate(() => window.qaBridgeMetrics.subscribeCalls), 1, 'completion hint setting replayed output');
  assert.equal((await terminalState(page)).viewportY, afterOutput.viewportY);
  report.checks.push('completion hint settings preserve the terminal and current history position');

  const terminalIdentityPreserved = await page.evaluate(async () => {
    const before = window.qaTerminal;
    window.qaSetStatus('exited');
    await new Promise(resolve => setTimeout(resolve, 150));
    return before === window.qaTerminal;
  });
  await page.getByText('History output · ended').waitFor();
  const exited = await terminalState(page);
  assert.equal(terminalIdentityPreserved, true, 'running-to-exited replaced the xterm instance');
  assert.equal(exited.viewportY, afterOutput.viewportY, 'running-to-exited changed the history viewport');
  assert.equal(exited.baseY, afterOutput.baseY, 'running-to-exited rebuilt or cleared the terminal buffer');
  assert.equal(await page.evaluate(() => window.qaBridgeMetrics.subscribeCalls), 1, 'running-to-exited resubscribed from cursor zero');
  assert.equal(await page.evaluate(() => window.qaBridgeMetrics.unsubscribeCalls), 0, 'running-to-exited unsubscribed the live output stream');
  await page.screenshot({ path: join(out, 'history-preserved-after-exit.png') });
  report.screenshots.push('history-preserved-after-exit.png');
  report.checks.push('running-to-exited preserves the xterm instance, history buffer, viewport, and single subscription');

  assert.deepEqual(errors, []);
  report.passed = true;
  report.initial = initial;
  report.wheelScrolled = wheelScrolled;
  report.scrolled = scrolled;
  report.afterOutput = afterOutput;
  report.exited = exited;
  report.resizeRequests = resizeRequests;
  report.wheelEvents = await page.evaluate(() => window.qaWheelEvents);
  const scrollPositions = await page.evaluate(() => window.qaScrollPositions.filter((position, index, values) => index === 0 || position !== values[index - 1]));
  report.scrollTrace = {
    eventCount: scrollPositions.length,
    first: scrollPositions[0],
    last: scrollPositions.at(-1),
    tail: scrollPositions.slice(-20),
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, out, checks: report.checks }, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) {
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
    report.screenshots.push('failure.png');
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (app) await app.close().catch(() => {});
}
