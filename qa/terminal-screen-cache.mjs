// Exercise the production surface, including React's double effect mount, with a
// detached xterm, a paged transcript and bytes appended while the view is closed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { removeScratch } from './lib/qa-cleanup.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'tt-terminal-reopen-'));
const fixture = String.raw`
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { I18nProvider } from './renderer/src/i18n';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import './renderer/src/styles.css';
const text = new TextEncoder();
const line = 'Long build output with colour: \x1b[32mcomplete\x1b[0m\r\n';
let bytes = text.encode(line.repeat(30000) + 'PARKED-MARK');
let start = 0, epoch = 'runtime-1', cols = 100;
const root = createRoot(document.getElementById('root'));
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function(element) { window.terminal = this; return originalOpen.call(this, element); };
window.bytesRead = 0;
window.threadterm = {
  onEvent: () => () => {}, subscribeOutput: async () => () => {},
  request: async (method, p) => {
    if (method !== 'terminal.read') return null;
    if (p.tail) return { nextCursor: bytes.length };
    const fromCursor = Math.max(start, p.cursor);
    const page = bytes.subarray(fromCursor, fromCursor + p.limit);
    if (p.limit > 1) window.bytesRead += page.length;
    return { fromCursor, nextCursor: fromCursor + page.length, data: page.toBase64() };
  }
};
window.show = (visible) => {
  const session = {id:'qa-shell', mode:'terminal', provider:'shell', title:'Shell', createdAt:'2026-01-01',
    updatedAt:'2026-01-01', status:'exited', readOnly:true, cols, rows:30};
  root.render(<StrictMode><I18nProvider locale="en">{visible ? <TerminalSurface runtimeEpoch={epoch} session={session} sessionId={session.id}
    provider="shell" theme="light" terminalCompatibility={{}}/> : <div id="closed"/>}</I18nProvider></StrictMode>);
};
window.append = (value) => { const suffix=typeof value === 'string' ? text.encode(value) : Uint8Array.from(value); const next=new Uint8Array(bytes.length+suffix.length);
  next.set(bytes); next.set(suffix,bytes.length); bytes=next; };
window.trim = () => { start = line.length; };
window.changeEpoch = () => { epoch='runtime-2'; };
window.changeGeometry = () => { cols += 1; };
window.show(false);
`;
await build({stdin:{contents:fixture,loader:'tsx',resolveDir:resolve('.')},jsx:'automatic',bundle:true,
  outfile:join(scratch,'fixture.js'),loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root,.terminal-wrap{height:100%;margin:0}</style><div id="root"></div><script>window.fixtureErrors=[]; window.addEventListener("error",e=>window.fixtureErrors.push(e.message));</script><script src="fixture.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800,show:false,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))})});`);
const app = await electron.launch({args:[join(scratch,'main.cjs')]});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.waitForLoadState('load');
  assert.deepEqual(await page.evaluate(() => window.fixtureErrors), []);
  await page.locator('#closed').waitFor({state:'attached'});
  async function open() {
    return page.evaluate(() => new Promise((done, fail) => {
      const started = performance.now();
      window.bytesRead = 0;
      const timeout = setTimeout(() => { observer.disconnect(); fail(new Error('Terminal did not become ready')); }, 15000);
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.xterm') || document.querySelector('.term-loading-overlay')) return;
        observer.disconnect();
        clearTimeout(timeout);
        done({elapsedMs:Math.round(performance.now()-started), bytes:window.bytesRead});
      });
      observer.observe(document.getElementById('root'), {subtree:true,childList:true});
      window.show(true);
    }));
  }
  async function close() {
    await page.evaluate(() => window.show(false));
    await page.locator('#closed').waitFor({state:'attached'});
  }
  const cold = await open();
  assert.ok(cold.bytes > 1024*1024);
  await close();
  await page.evaluate(() => window.append('-APPENDED'));
  const warm = await open();
  assert.equal(warm.bytes, '-APPENDED'.length);
  const tail = await page.evaluate(() => {
    const buf=window.terminal.buffer.active;
    return Array.from({length:35},(_,i)=>buf.getLine(buf.length-35+i)?.translateToString(true)).join('\n');
  });
  assert.match(tail,/PARKED-MARK-APPENDED/);
  assert.equal(await page.evaluate(() => window.terminal.options.disableStdin),true);
  // Stop at a partial VT command, then at half a UTF-8 character. Neither
  // parking the parser nor temporarily hiding its cursor may consume them.
  for (const [suffix, expected] of [['\x1b[3', 3], [[49, 109, 0xe4, 0xb8], 4], [[0xad, 0x1b, 91, 48, 109], 5]]) {
    await close();
    await page.evaluate(value => window.append(value), suffix);
    assert.equal((await open()).bytes, expected);
  }
  const cell = await page.evaluate(() => {
    const buffer = window.terminal.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX - 2)?.getChars();
  });
  assert.equal(cell, '\u4e2d', 'split sequences must produce one Chinese character');
  for (const method of ['trim','changeEpoch','changeGeometry']) {
    await close();
    await page.evaluate(method => window[method](),method);
    assert.ok((await open()).bytes > 1024*1024,method+' must rebuild from retained bytes');
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({cold,warm,verified:['suffix','retention','epoch','geometry','split VT and UTF-8','read-only control']}));
} finally { await app.close(); await removeScratch(scratch); }
