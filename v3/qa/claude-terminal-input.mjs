// Electron/xterm fixture for Claude's native painted caret and keyboard bytes.
// Uses production TerminalSurface with a synthetic PTY stream shaped like the
// observed Claude 2.1.282 output; no provider, account, or model is contacted.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-terminal-input-'));
const out = resolve('qa/results/claude-terminal-input');
await mkdir(out, { recursive: true });
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const encoder = new TextEncoder();
const stream = '\\x1b[?25l\\x1b[>5u\\x1b[7;1H❯\\u00a0h\\x1b[30m\\x1b[47m \\x1b[m\\x1b[999;999H';
const initial = encoder.encode(stream);
const split = initial.indexOf(0x1b) + 4; // split native ESC[?25l across output chunks
window.qaInputs = [];
window.qaCursorWrites = [];
window.qaResizes = [];
const open = Terminal.prototype.open;
Terminal.prototype.open = function(element) { window.qaTerminal = this; return open.call(this, element); };
const write = Terminal.prototype.write;
Terminal.prototype.write = function(data, callback) {
  if (typeof data === 'string' && data.includes('?25')) window.qaCursorWrites.push(data);
  return write.call(this, data, callback);
};
window.threadterm = {
  platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 19045 },
  onEvent: () => () => {},
  subscribeOutput: async (sessionId, cursor, listener) => {
    if (cursor !== 0) throw Error('fixture requires complete initial replay');
    await listener({ sessionId, cursor: 0, data: initial.subarray(0, split), gap: false });
    await listener({ sessionId, cursor: split, data: initial.subarray(split), gap: false });
    let nextCursor = initial.length;
    window.qaEmit = async (text, splitAt) => {
      const data = encoder.encode(text);
      if (splitAt) {
        await listener({ sessionId, cursor: nextCursor, data: data.subarray(0, splitAt), gap: false });
        await listener({ sessionId, cursor: nextCursor + splitAt, data: data.subarray(splitAt), gap: false });
      } else await listener({ sessionId, cursor: nextCursor, data, gap: false });
      nextCursor += data.length;
    };
    return () => {};
  },
  request: async (method, params) => {
    if (method === 'terminal.read') return { nextCursor: initial.length };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 7 };
    if (method === 'terminal.input') window.qaInputs.push(params.data);
    if (method === 'terminal.resize') window.qaResizes.push(params);
    return null;
  },
  openExternal: async () => {},
};
function Harness() {
  const [status, setStatus] = useState('running');
  window.qaStatus = setStatus;
  const session = { id: 'qa-claude-input', provider: 'claude', mode: 'terminal', status, title: 'Claude input fixture', createdAt: 'then', updatedAt: 'then', cols: 80, rows: 24 };
  return <I18nProvider locale="en"><div className="qa-terminal"><TerminalSurface sessionId={session.id} provider="claude" theme="light" terminalCompatibility={{}} session={session} /></div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}.qa-terminal{display:flex;width:100%;height:100%;padding:12px;box-sizing:border-box}</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:720,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaTerminal?.buffer.active.getLine(6)?.translateToString(true).includes('❯'), null, { timeout: 15_000 });
  await page.waitForFunction(() => window.qaTerminal?.options.disableStdin === false, null, { timeout: 10_000 });
  await page.screenshot({ path: join(out, 'claude-caret-before.png') });
  const before = await page.evaluate(() => ({
    cursorWrites: window.qaCursorWrites,
    resizes: window.qaResizes,
    measured: { cols: window.qaTerminal.cols, rows: window.qaTerminal.rows },
    hostCursor: Boolean(document.querySelector('.terminal-host .xterm-cursor')),
    hostCursorHidden: window.qaTerminal._core?._coreService?.isCursorHidden,
    caretCell: (() => {
      const cell = window.qaTerminal.buffer.active.getLine(6)?.getCell(3);
      return cell && { chars: cell.getChars(), bgMode: cell.getBgColorMode() };
    })(),
  }));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('h');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.qaInputs.length >= 2, null, { timeout: 10_000 });
  const inputs = await page.evaluate(() => window.qaInputs);
  await page.screenshot({ path: join(out, 'claude-caret-after-backspace.png') });
  console.log(JSON.stringify({ before, inputHex: inputs.map(data => Buffer.from(data).toString('hex')) }));
  assert.deepEqual(errors, [], 'production TerminalSurface must not throw');
  assert.ok(before.resizes.some(size => size.cols === before.measured.cols && size.rows === before.measured.rows), 'first live fit must resize PTY to the measured xterm geometry');
  assert.ok(before.caretCell?.bgMode, 'Claude-painted caret cell must remain in the native buffer');
  assert.equal(before.hostCursor, false, 'Claude hid the host cursor; renderer must not reveal a second one');
  assert.deepEqual(inputs.slice(0, 2), ['h', '\x7f'], 'xterm must forward the typed character and DEL Backspace byte unchanged');
  await page.evaluate(async () => window.qaEmit('\x1b[?25h'));
  await page.waitForFunction(() => Boolean(document.querySelector('.terminal-host .xterm-cursor')), null, { timeout: 3000 });
  await page.evaluate(async () => window.qaEmit('\x1b[?25l'));
  await page.waitForFunction(() => !document.querySelector('.terminal-host .xterm-cursor'), null, { timeout: 3000 });
  const expectNativeModeAfterPresentation = async (sequence, expected, splitAt) => {
    await page.evaluate(async () => window.qaEmit('\x1b[?25l'));
    await page.evaluate(async ({ sequence, splitAt }) => window.qaEmit(sequence, splitAt), { sequence, splitAt });
    const xtermVisible = await page.evaluate(() => !window.qaTerminal._core.coreService.isCursorHidden);
    assert.equal(xtermVisible, expected, 'fixture expectation must match xterm native parsing before the presentation transition');
    let count = await page.evaluate(() => window.qaCursorWrites.length);
    await page.evaluate(() => window.qaStatus('exited'));
    await page.waitForFunction(previous => window.qaCursorWrites.length > previous, count);
    count = await page.evaluate(() => window.qaCursorWrites.length);
    await page.evaluate(() => window.qaStatus('running'));
    await page.waitForFunction(previous => window.qaCursorWrites.length > previous, count);
    const restored = await page.evaluate(() => window.qaCursorWrites.at(-1));
    assert.equal(restored, expected ? '\x1b[?25h' : '\x1b[?25l', 'live transition must restore the native cursor mode');
  };
  await expectNativeModeAfterPresentation('\x1bc', false, 1); // xterm RIS preserves hidden cursor mode.
  await expectNativeModeAfterPresentation('\x1b[?25$h', false, 5); // CSI intermediate is not DECSET.
  await expectNativeModeAfterPresentation('\x1b[?25\x18h', false, 5); // CAN cancels CSI.
  await expectNativeModeAfterPresentation('\x1b[?25\x1ah', false, 5); // SUB cancels CSI.
  await expectNativeModeAfterPresentation('\x1b[?25\x07h', true, 5); // BEL executes without cancelling CSI.
  await expectNativeModeAfterPresentation('\x1b[?25\x7fh', true, 5); // DEL is ignored without cancelling CSI.
  await expectNativeModeAfterPresentation('\x1b]0;fake\x18\x1b[?25h', true, 10); // CAN ends OSC.
  await expectNativeModeAfterPresentation('\x1bPfake\x1a\x1b[?25h', true, 8); // SUB ends DCS.
  await expectNativeModeAfterPresentation('\x1b]0;fake\x1b[?25h', true, 10); // ESC ends OSC and starts CSI.
  await expectNativeModeAfterPresentation('\x1bPfake\x1b[?25h', true, 8); // ESC ends DCS and starts CSI.
  await expectNativeModeAfterPresentation('\x1b]0;fake?25h\x07', false, 10); // Plain OSC text is ignored.
  await expectNativeModeAfterPresentation('\x1bPfake?25h\x1b\\', false, 8); // Plain DCS text is ignored.
  await expectNativeModeAfterPresentation(`\x1b[?${'999;'.repeat(31)}25h`, true, 70); // xterm accepts 32 parameters.
  await expectNativeModeAfterPresentation(`\x1b[?${'999;'.repeat(32)}25h`, false, 70); // xterm drops parameter 33.
  await expectNativeModeAfterPresentation(`\x1b[?25;${'999;'.repeat(80)}h`, true, 130); // Early 25 survives later overflow.
  await expectNativeModeAfterPresentation('\x1b[?00025h', true, 5);
  let count = await page.evaluate(() => window.qaCursorWrites.length);
  await page.evaluate(() => window.qaStatus('exited'));
  await page.waitForFunction(previous => window.qaCursorWrites.length > previous, count);
  count = await page.evaluate(() => window.qaCursorWrites.length);
  await page.evaluate(() => {
    const pending = window.qaEmit('\x1b[?25l');
    window.qaStatus('running');
    return pending;
  });
  await page.waitForFunction(previous => window.qaCursorWrites.length > previous, count);
  assert.equal(await page.evaluate(() => window.qaCursorWrites.at(-1)), '\x1b[?25l', 'a pending native hide must win the live-transition cursor restore');
  console.log(JSON.stringify({ passed: true, scratch, out, before, inputHex: inputs.map(data => Buffer.from(data).toString('hex')) }));
} finally {
  await app?.close();
}
