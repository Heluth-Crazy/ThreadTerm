// Real Electron QA for a terminal's input-control lease.  It uses the production
// TerminalSurface and bridge shape but has no runtime, provider, or user profile.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-control-'));
const out = resolve('qa/results/terminal-control-recovery');
await mkdir(out, { recursive: true });

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const encoder = new TextEncoder();
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function(element) { window.qaTerminal = this; return originalOpen.call(this, element); };
const events = [];
const calls = window.qaCalls = [];
let listener;
window.qaLease = { epoch: 1, block: false, staleRenew: false };
window.threadterm = {
  platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 },
  onEvent(callback) { events.push(callback); return () => events.splice(events.indexOf(callback), 1); },
  subscribeOutput: async (sessionId, cursor, next) => {
    listener = next;
    await next({ sessionId, cursor: 0, data: encoder.encode('PS C:\\\\qa> '), gap: false });
    return () => { window.qaUnsubscribed = (window.qaUnsubscribed ?? 0) + 1; };
  },
  request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'terminal.read') return { nextCursor: 8 };
    if (method === 'session.claim') {
      if (window.qaLease.block) { const error = new Error('lease_held'); error.code = 'lease_held'; throw error; }
      return { leaseEpoch: window.qaLease.epoch };
    }
    if (method === 'session.renew') {
      if (window.qaLease.staleRenew) { window.qaLease.staleRenew = false; const error = new Error('stale_lease'); error.code = 'stale_lease'; throw error; }
      return { leaseEpoch: params.leaseEpoch };
    }
    if (method === 'terminal.input') return null;
    if (method === 'terminal.resize' || method === 'session.release' || method === 'session.launch.read') return null;
    throw new Error('Unexpected bridge call: ' + method);
  },
  openExternal: async () => {},
};
window.qaTransport = state => { for (const event of [...events]) event({ event: 'runtime.transport', data: { state } }); };
function Fixture() {
  const [status, setStatus] = useState('running');
  const [readOnly, setReadOnly] = useState(false);
  const [theme, setTheme] = useState('light');
  window.qaSetStatus = setStatus; window.qaSetReadOnly = setReadOnly;
  window.qaSetTheme = next => { document.documentElement.dataset.theme = next; setTheme(next); };
  const session = { id:'terminal-control-qa', provider:'codex', mode:'terminal', title:'Control recovery QA', status, readOnly,
    createdAt:'now', updatedAt:'now', cols:120, rows:32 };
  return <I18nProvider locale="en-US"><main className="qa-shell"><TerminalSurface sessionId={session.id} session={session}
    provider="codex" theme={theme} terminalCompatibility={{}} /></main></I18nProvider>;
}
document.documentElement.dataset.theme = 'light';
createRoot(document.getElementById('root')).render(<Fixture />);
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true,
  outfile: join(scratch, 'qa.js'), jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css">
<style>html,body,#root,.qa-shell{width:100%;height:100%;margin:0}.qa-shell{display:flex;min-width:0;min-height:0}.qa-shell>.terminal-wrap{flex:1;min-width:0;min-height:0}</style>
<div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1440,height:860,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const report = { passed: false, checks: [], screenshots: [] };
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout: 20_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaTerminal && !window.qaTerminal.options.disableStdin);
  await page.waitForFunction(() => window.qaCalls.some(call => call.method === 'session.claim' && call.params.sessionId === 'terminal-control-qa'));
  assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.claim').length), 1, 'one live TerminalSurface claims one shared lease');
  assert.equal(await page.evaluate(() => document.activeElement === window.qaTerminal.textarea), true, 'the initial ready lease focuses the terminal once');
  report.checks.push('ordinary shell replay creates one xterm/output subscription and claims input control once');

  // The production pool renews at 10 seconds.  Make that exact renewal stale,
  // then verify its onLost path claims a fresh epoch without replacing xterm.
  await page.evaluate(() => { window.qaLease.staleRenew = true; window.qaLease.epoch = 2; window.qaTerminal.textarea.focus(); });
  await page.waitForFunction(() => window.qaCalls.some(call => call.method === 'session.renew'), null, { timeout: 14_000 });
  await page.waitForFunction(() => window.qaCalls.filter(call => call.method === 'session.claim').length === 2, null, { timeout: 16_000 });
  await page.waitForFunction(() => !window.qaTerminal.options.disableStdin);
  const recovery = await page.evaluate(() => ({
    renews: window.qaCalls.filter(call => call.method === 'session.renew').map(call => call.params.leaseEpoch),
    claims: window.qaCalls.filter(call => call.method === 'session.claim').length,
    subscriptionCount: window.qaUnsubscribed ?? 0,
    active: document.activeElement === window.qaTerminal.textarea,
  }));
  assert.deepEqual(recovery.renews.slice(0, 1), [1], 'the 10-second heartbeat must renew epoch 1');
  assert.equal(recovery.claims, 2, 'stale renewal must automatically claim a new control lease');
  assert.equal(recovery.subscriptionCount, 0, 'input recovery must not replace or unsubscribe the output stream');
  assert.equal(recovery.active, true, 'recovery preserves existing keyboard focus without a second focus target');
  await page.evaluate(() => window.qaTerminal.input('after-auto-recovery'));
  await page.waitForFunction(() => window.qaCalls.filter(call => call.method === 'terminal.input' && call.params.data === 'after-auto-recovery').length === 1);
  report.checks.push('a real 10-second stale renewal automatically reclaims epoch 2; the next shell input is sent exactly once');

  // Wake is intentionally a validation, not a second claim.  The shared pool
  // turns it into a single renew request for every live consumer of the lease.
  const renewBeforeWake = await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.renew').length);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(before => window.qaCalls.filter(call => call.method === 'session.renew').length === before + 1, renewBeforeWake);
  assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.claim').length), 2, 'focus wake must validate the shared epoch rather than steal/claim control');
  report.checks.push('focus wake validates the existing lease and does not issue another claim');

  // A transport break disables input immediately.  Reconnect while another
  // window owns the lease: the production status and Retry affordance must be
  // visible, and manual retry can recover after the conflict disappears.
  await page.evaluate(() => { window.qaTransport('disconnected'); });
  await page.waitForFunction(() => window.qaTerminal.options.disableStdin);
  await page.evaluate(() => { window.qaLease.block = true; window.qaTransport('reconnected'); });
  const blocked = page.locator('.terminal-control-note');
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /Another window controls this terminal\.|Retry input connection/);
  assert.equal(await page.locator('button', { hasText: 'Retry input connection' }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.qaTerminal.options.disableStdin), true, 'lease_held keeps the actual xterm input disabled');
  await page.screenshot({ path: join(out, 'light-1440-lease-held.png'), animations: 'disabled' });
  report.screenshots.push('light-1440-lease-held.png');
  await page.evaluate(() => window.qaSetTheme('dark'));
  await page.setViewportSize({ width: 320, height: 640 });
  const retryButton = page.getByRole('button', { name: 'Retry input connection' });
  await retryButton.focus();
  assert.equal(await retryButton.evaluate(button => document.activeElement === button), true, 'the retry action remains keyboard reachable in a narrow dark pane');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the held-control notice must not create page-level horizontal overflow at 320px');
  await page.screenshot({ path: join(out, 'dark-320-lease-held.png'), animations: 'disabled' });
  report.screenshots.push('dark-320-lease-held.png');
  const claimsBeforeBlockedWake = await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.claim').length);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.claim').length), claimsBeforeBlockedWake, 'focus and visibility wake must not claim while another window holds control');
  await page.evaluate(() => window.qaTransport('incompatible'));
  await page.waitForFunction(() => document.querySelector('.terminal-control-note')?.textContent?.includes('Terminal connection is incompatible. Update the application.'));
  assert.equal(await page.getByRole('button', { name: 'Retry input connection' }).count(), 0, 'an incompatible transport must not expose a retry action that cannot work');
  assert.equal(await page.evaluate(() => window.qaTerminal.options.disableStdin), true);
  await page.screenshot({ path: join(out, 'dark-320-incompatible.png'), animations: 'disabled' });
  report.screenshots.push('dark-320-incompatible.png');
  await page.evaluate(() => window.qaTransport('reconnected'));
  await page.waitForFunction(() => document.querySelector('.terminal-control-note')?.textContent?.includes('Another window controls this terminal.'));
  await retryButton.focus();
  await page.evaluate(() => { window.qaLease.block = false; window.qaLease.epoch = 4; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.qaTerminal.options.disableStdin);
  await page.evaluate(() => window.qaTerminal.input('after-manual-retry'));
  await page.waitForFunction(() => window.qaCalls.filter(call => call.method === 'terminal.input' && call.params.data === 'after-manual-retry').length === 1);
  report.checks.push('blocked focus/visibility never steals control; incompatible transport names the problem without a futile retry; reconnect can then recover through Retry input connection');

  // Neither ended nor read-only history is entitled to reclaim process input.
  const claimsBeforeReadonly = await page.evaluate(() => window.qaCalls.filter(call => call.method === 'session.claim').length);
  await page.evaluate(() => { window.qaSetStatus('exited'); window.qaSetReadOnly(true); });
  await page.waitForFunction(() => window.qaTerminal.options.disableStdin);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.qaTransport('reconnected'); });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(before => window.qaCalls.filter(call => call.method === 'session.claim').length, claimsBeforeReadonly), claimsBeforeReadonly, 'ended/read-only surface must never claim input control');
  report.checks.push('ended and read-only replays remain non-controlling during focus and transport events');

  await page.evaluate(() => window.qaSetTheme('light'));
  for (const [name, width] of [['light-1280', 1280], ['light-1440-ended', 1440], ['light-1920', 1920]]) {
    await page.setViewportSize({ width, height: 860 });
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`);
  }
  await page.evaluate(() => window.qaSetTheme('dark'));
  for (const [name, width] of [['dark-1280-ended', 1280], ['dark-1440-ended', 1440], ['dark-1920-ended', 1920]]) {
    await page.setViewportSize({ width, height: 860 });
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`);
  }
  await page.setViewportSize({ width: 320, height: 640 });
  assert.ok(await page.locator('.terminal-host').boundingBox(), 'narrow pane retains a measurable production terminal host');
  await page.screenshot({ path: join(out, 'dark-320-ended.png'), animations: 'disabled' }); report.screenshots.push('dark-320-ended.png');
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, out, checks: report.checks }, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (app) { const page = (await app.windows())[0]; await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); report.screenshots.push('failure.png'); }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.error(report.error); process.exitCode = 1;
} finally { if (app) await app.close().catch(() => {}); }
