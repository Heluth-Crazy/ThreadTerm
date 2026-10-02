// Isolated Electron QA for TerminalSurface replay honesty and the ended-surface cursor.
// Scenario 1 reproduces the legacy Kimi replay (wide + narrow CSI H/K redraw frames,
// provider-painted inverse-space carets, trailing CSI ?25l) inside the real component and
// records where every visible block comes from. Run with THREADTERM_QA_EVIDENCE=1 to only
// collect evidence (always exit 0); without it the acceptance assertions run.
// The fixture uses the production component and styles with an in-memory bridge;
// it never starts a provider or reads a user's runtime database.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const evidenceOnly = process.env.THREADTERM_QA_EVIDENCE === '1';
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-replay-cursor-'));
const out = resolve('qa/results/terminal-replay-cursor');
await mkdir(out, { recursive: true });

const CSI = '\x1b[';
// Kimi-style caret the provider paints itself: black foreground, white background space.
const caret = (row, col) => `${CSI}${row};${col}H\x1b[30m\x1b[47m \x1b[m`;

// Frame 1 was drawn for a 231-column terminal; replaying it at pane width wraps lines so
// per-line erase regions no longer line up. Frame 2 was drawn for 80 columns and only
// repaints rows 1..10, so frame-1 content below row 10 (including its caret) survives.
const kimiParts = [];
for (let row = 1; row <= 24; row += 1) {
  const label = `WIDE-FRAME row ${String(row).padStart(2, '0')} `;
  kimiParts.push(`${CSI}${row};1H${label}${'·'.repeat(231 - label.length)}${CSI}K`);
}
kimiParts.push(caret(20, 150)); // stale caret from the wide frame
for (let row = 1; row <= 10; row += 1) {
  const label = `NARROW-FRAME row ${String(row).padStart(2, '0')} `;
  kimiParts.push(`${CSI}${row};1H${label}${'─'.repeat(80 - label.length)}${CSI}K`);
}
kimiParts.push(`${CSI}10;1Hkimi> prompt restored${CSI}K`);
kimiParts.push(caret(10, 30)); // final caret, painted at the cursor position
kimiParts.push(`${CSI}?25l`); // Kimi hides the host cursor at the end of the stream
const kimiStream = kimiParts.join('');
const kimiChunks = [kimiStream.slice(0, Math.floor(kimiStream.length / 2)), kimiStream.slice(Math.floor(kimiStream.length / 2))];

// An ended plain-shell session leaves the host cursor visible at the final prompt.
const shellStream = '$ echo hello\r\nhello\r\n$ exit\r\nexited\r\n';

const fixedStream = 'FIXED-GEOMETRY marker line 1\r\nFIXED-GEOMETRY marker line 2\r\nFIXED done\r\n';

const liveStream = '$ tail -f log\r\nline one\r\nline two\r\n$ ';

const streams = {
  'qa-kimi-legacy': kimiChunks,
  'qa-shell-ended': [shellStream],
  'qa-fixed-geometry': [fixedStream],
  'qa-live-transition': [liveStream],
};

const zhBanner = '该历史会话未记录终端尺寸，部分全屏界面可能错位。重新运行可生成可稳定回放的新记录。';
const enBanner = 'This historical session has no recorded terminal size; full-screen interfaces may be misaligned. Rerun it to create a new record that replays reliably.';

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function(element) {
  window.qaTerminal = this;
  window.qaTerminalCount = (window.qaTerminalCount ?? 0) + 1;
  return originalOpen.call(this, element);
};
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function(data, cb) {
  if (typeof data === 'string' && data.includes('?25')) (window.qaCursorWrites = window.qaCursorWrites ?? []).push(data);
  return originalWrite.call(this, data, cb);
};

const encoder = new TextEncoder();
const streams = ${JSON.stringify(streams)};
const cursors = {};
const outputListeners = {};
window.qaMetrics = { subscribe: {}, unsubscribe: {}, requests: [] };
window.threadterm = {
  platform: 'win32',
  windowsPty: { backend: 'conpty', buildNumber: 19045 },
  onEvent: () => () => {},
  subscribeOutput: async (sessionId, requestedCursor, listener) => {
    window.qaMetrics.subscribe[sessionId] = (window.qaMetrics.subscribe[sessionId] ?? 0) + 1;
    window.qaMetrics.subscribe[sessionId + ':cursor'] = requestedCursor;
    outputListeners[sessionId] = listener;
    cursors[sessionId] = 0;
    for (const chunk of streams[sessionId] ?? []) {
      const data = encoder.encode(chunk);
      const at = cursors[sessionId];
      cursors[sessionId] += data.byteLength;
      await listener({ sessionId, cursor: at, data, gap: false });
    }
    return () => { window.qaMetrics.unsubscribe[sessionId] = (window.qaMetrics.unsubscribe[sessionId] ?? 0) + 1; };
  },
  request: async (method, params) => {
    window.qaMetrics.requests.push({ method, params });
    if (method === 'terminal.read') return { nextCursor: (streams[params.sessionId] ?? []).reduce((n, text) => n + encoder.encode(text).byteLength, 0) };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 55 };
    return null;
  },
  openExternal: async () => {},
};
window.qaEmit = async (sessionId, text) => {
  const listener = outputListeners[sessionId];
  if (!listener) throw new Error('output subscription is not ready for ' + sessionId);
  const data = encoder.encode(text);
  const at = cursors[sessionId];
  cursors[sessionId] += data.byteLength;
  await listener({ sessionId, cursor: at, data, gap: false });
};

const scenarios = {
  'kimi-legacy': { id: 'qa-kimi-legacy', provider: 'kimi', status: 'interrupted', title: 'Kimi legacy replay' },
  'shell-ended': { id: 'qa-shell-ended', provider: 'codex', status: 'exited', title: 'Shell ended replay' },
  'fixed-geometry': { id: 'qa-fixed-geometry', provider: 'codex', status: 'exited', title: 'Fixed geometry replay', cols: 100, rows: 30 },
  'live-transition': { id: 'qa-live-transition', provider: 'kimi', status: 'running', title: 'Live to ended' },
};

function Fixture() {
  const [scenario, setScenario] = useState();
  const [locale, setLocale] = useState('zh-CN');
  const [status, setStatus] = useState('running');
  window.qaShow = (name, nextLocale) => { setStatus(scenarios[name].status); setLocale(nextLocale ?? 'zh-CN'); setScenario(name); };
  window.qaSetStatus = setStatus;
  if (!scenario) return <I18nProvider locale={locale}><div className="qa-terminal" /></I18nProvider>;
  const base = scenarios[scenario];
  const session = {
    id: base.id, provider: base.provider, mode: 'terminal',
    status: scenario === 'live-transition' ? status : base.status,
    title: base.title, createdAt: 'then', updatedAt: 'then',
    ...(base.cols ? { cols: base.cols, rows: base.rows } : {}),
  };
  return <I18nProvider locale={locale}><div className="qa-terminal"><TerminalSurface
    sessionId={session.id} provider={session.provider} theme="light"
    terminalCompatibility={{}} session={session}
  /></div></I18nProvider>;
}
document.documentElement.dataset.theme = 'light';
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
<style>html,body,#root{height:100%;margin:0}.qa-terminal{display:flex;min-height:0;width:700px;height:100%;padding:12px;box-sizing:border-box}.qa-terminal>.terminal-wrap{flex:1;min-width:0;min-height:0}</style>
<div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 1000, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});
`);

let app;
let page;
const report = { passed: false, mode: evidenceOnly ? 'evidence' : 'assertions', checks: [], evidence: {}, screenshots: [] };

// Reads the real rendered state: xterm buffer cursor/modes, the DOM cursor span the
// renderer would paint, provider-painted coloured space cells, and textarea focus.
const collectEvidence = name => page.evaluate(() => {
  const terminal = window.qaTerminal;
  const host = document.querySelector('.terminal-host');
  const cursorSpan = host?.querySelector('.xterm-cursor');
  const buffer = terminal.buffer.active;
  const colouredSpaces = [];
  const cell = undefined;
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      const c = line.getCell(x, cell);
      if (!c) continue;
      const explicitBg = c.getBgColorMode() !== 0;
      if (c.getChars() === ' ' && (c.isInverse() || explicitBg)) {
        colouredSpaces.push({ y, x, fg: c.getFgColor(), fgMode: c.getFgColorMode(), bg: c.getBgColor(), bgMode: c.getBgColorMode(), inverse: c.isInverse() });
      }
    }
  }
  let coreCursorHidden;
  try { coreCursorHidden = terminal._core?._coreService?.isCursorHidden; } catch { coreCursorHidden = undefined; }
  const text = [];
  for (let y = 0; y < buffer.length; y += 1) text.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    coreCursorHidden,
    cursorSpan: cursorSpan ? { classes: cursorSpan.className, text: cursorSpan.textContent } : null,
    textareaFocused: String(document.activeElement?.className ?? '').includes('xterm-helper-textarea'),
    colouredSpaces,
    bufferText: text.join('\n'),
  };
}).then(evidence => { report.evidence[name] = evidence; return evidence; });

const waitForBuffer = marker => page.waitForFunction(
  text => {
    const terminal = window.qaTerminal;
    if (!terminal) return false;
    const buffer = terminal.buffer.active;
    for (let y = 0; y < buffer.length; y += 1) {
      if ((buffer.getLine(y)?.translateToString(true) ?? '').includes(text)) return true;
    }
    return false;
  },
  marker,
  { timeout: 15_000 },
);

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaShow === 'function', null, { timeout: 15_000 });

  // --- Scenario 1: legacy Kimi replay (ended, no recorded size) ---
  await page.evaluate(() => window.qaShow('kimi-legacy', 'zh-CN'));
  await waitForBuffer('kimi> prompt restored');
  await page.waitForTimeout(200);
  const kimi = await collectEvidence('kimi-legacy');
  await page.screenshot({ path: join(out, 'kimi-legacy.png') });
  report.screenshots.push('kimi-legacy.png');
  if (!evidenceOnly) {
    const banner = page.locator('.term-legacy-note');
    await banner.waitFor();
    assert.equal(await banner.textContent(), zhBanner);
    const [bannerBox, hostBox] = await Promise.all([
      banner.boundingBox(),
      page.locator('.terminal-host').boundingBox(),
    ]);
    assert.ok(bannerBox && hostBox && bannerBox.y + bannerBox.height <= hostBox.y + 1, 'banner must not overlap the terminal host');
    assert.ok(kimi.bufferText.includes('WIDE-FRAME row 12'), 'wide-frame bytes must survive replay untouched');
    assert.ok(kimi.bufferText.includes('NARROW-FRAME row 05'), 'narrow-frame bytes must survive replay untouched');
    assert.ok(kimi.bufferText.includes('kimi> prompt restored'), 'provider prompt bytes must survive replay untouched');
    const caretRow = kimi.baseY + kimi.cursorY;
    const finalCaret = kimi.colouredSpaces.find(c => c.y === caretRow && c.x === kimi.cursorX - 1);
    assert.ok(finalCaret, `provider caret must remain at the final cursor position (${caretRow},${kimi.cursorX - 1})`);
    const staleCaret = kimi.colouredSpaces.find(c => c.y === kimi.baseY + 19 && c.x === kimi.cols - 1);
    assert.ok(staleCaret, 'the stale wide-frame caret cell is retained (bytes are never rewritten); its misalignment is the documented unrecoverable legacy case');
    assert.equal(kimi.cursorSpan, null, 'the host cursor must not be rendered on an ended surface');
  }
  report.checks.push('kimi-legacy evidence captured (cursor span, painted caret cells, focus state)');

  // --- Scenario 2: ended shell session whose stream leaves the cursor visible ---
  await page.evaluate(() => window.qaShow('shell-ended', 'en'));
  await waitForBuffer('exited');
  await page.waitForTimeout(200);
  const shell = await collectEvidence('shell-ended');
  await page.screenshot({ path: join(out, 'shell-ended.png') });
  report.screenshots.push('shell-ended.png');
  if (!evidenceOnly) {
    assert.equal(await page.locator('.term-legacy-note').textContent(), enBanner);
    assert.equal(shell.cursorSpan, null, 'host cursor must stay hidden when the historical stream leaves it visible');
    assert.ok(shell.bufferText.includes('$ exit'), 'shell bytes must reach the buffer unchanged');
  }
  report.checks.push('shell-ended evidence captured (host cursor handling for streams without CSI ?25l)');

  // --- Scenario 3: ended session with a recorded size keeps fixed-geometry replay ---
  await page.evaluate(() => window.qaShow('fixed-geometry', 'en'));
  await waitForBuffer('FIXED done');
  await page.waitForTimeout(200);
  const fixed = await collectEvidence('fixed-geometry');
  await page.screenshot({ path: join(out, 'fixed-geometry.png') });
  report.screenshots.push('fixed-geometry.png');
  if (!evidenceOnly) {
    assert.equal(fixed.cols, 100, 'fixed-geometry replay constructs xterm at the recorded columns');
    assert.equal(fixed.rows, 30, 'fixed-geometry replay constructs xterm at the recorded rows');
    assert.equal(await page.locator('.terminal-host.fixed-geometry').count(), 1, 'fixed-geometry host class is kept');
    assert.equal(await page.locator('.term-legacy-note').count(), 0, 'recorded-size replay must not show the unknown-geometry banner');
    const resizes = await page.evaluate(() => window.qaMetrics.requests.filter(call => call.method === 'terminal.resize' && call.params.sessionId === 'qa-fixed-geometry'));
    assert.equal(resizes.length, 0, 'fixed-geometry replay must not fit or send resize RPCs');
    assert.equal(fixed.cursorSpan, null, 'host cursor stays hidden on fixed-geometry replays too');
    assert.ok(fixed.bufferText.includes('FIXED-GEOMETRY marker line 1'));
  }
  report.checks.push('fixed-geometry replay stays at the recorded size without fit, banner, or resize RPC');

  // --- Scenario 4: running -> ended keeps one xterm, one subscription, hides the cursor ---
  await page.evaluate(() => window.qaShow('live-transition', 'en'));
  await waitForBuffer('line two');
  await page.waitForFunction(() => window.qaMetrics.requests.some(call => call.method === 'session.claim'), null, { timeout: 10_000 });
  // A claim resolves before xterm's scheduled DOM paint. Assert the rendered
  // live cursor after that paint instead of racing the output/write callback.
  if (!evidenceOnly) {
    await page.waitForFunction(() => Boolean(document.querySelector('.terminal-host .xterm-cursor')), null, { timeout: 10_000, polling: 50 });
  }
  await page.evaluate(() => { window.qaLiveTerminal = window.qaTerminal; });
  const live = await collectEvidence('live-transition:live');
  if (!evidenceOnly) {
    assert.ok(live.cursorSpan, 'a live terminal keeps its host cursor');
  }
  await page.evaluate(() => window.qaSetStatus('exited'));
  await page.locator('.term-ended-banner').waitFor();
  if(!evidenceOnly){
    // Missing native identity stays honestly non-resumable: the footer says why and offers a fresh
    // conversation instead of a Resume that cannot work.
    assert.equal(await page.getByRole('button',{name:'Resume',exact:true}).count(),0,'missing native identity offers no Resume');
    assert.match(await page.locator('.term-ended-banner').innerText(),/can't be resumed: no native session ID/);
    assert.equal(await page.locator('.term-ended-banner').getByRole('button',{name:'New with same config',exact:true}).isEnabled(),true);
  }
  if (!evidenceOnly) {
    await page.waitForFunction(() => !document.querySelector('.terminal-host .xterm-cursor'), null, { timeout: 10_000, polling: 100 });
  }
  await page.waitForTimeout(250);
  const ended = await collectEvidence('live-transition:ended');
  report.evidence['live-transition:debug'] = await page.evaluate(() => ({
    cursorWrites: window.qaCursorWrites ?? [],
    hiddenFlag: window.qaTerminal?._core?.coreService?.isCursorHidden,
    focused: String(document.activeElement?.className ?? ''),
  }));
  await page.screenshot({ path: join(out, 'live-transition-ended.png') });
  report.screenshots.push('live-transition-ended.png');
  if (!evidenceOnly) {
    assert.equal(await page.evaluate(() => window.qaTerminal === window.qaLiveTerminal), true, 'running-to-ended must not rebuild the xterm instance');
    assert.equal(await page.evaluate(() => window.qaMetrics.subscribe['qa-live-transition']), 1, 'running-to-ended must not resubscribe from cursor zero');
    assert.equal(await page.evaluate(() => window.qaMetrics.unsubscribe['qa-live-transition'] ?? 0), 0, 'running-to-ended must not tear down the subscription');
    assert.equal(ended.cursorSpan, null, 'the host cursor must disappear once the session has ended');
    assert.ok(ended.bufferText.includes('line two'), 'the already-built frame stays intact');
    assert.equal(await page.locator('.term-legacy-note').count(), 0, 'an in-place running-to-ended transition keeps the built frame and does not reflow it for the banner');
  }
  report.checks.push('running-to-ended preserves the terminal and hides the host cursor');

  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, mode: report.mode, out, checks: report.checks }, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) {
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
    report.screenshots.push('failure.png');
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!evidenceOnly) process.exitCode = 1;
  console.error(report.error);
} finally {
  if (app) await app.close().catch(() => {});
}
