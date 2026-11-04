// Electron regression for issue #23: inspecting history must not widen the
// transcript merely because the back-to-bottom control is visible.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-width-'));
const out = join(root, 'qa/results/chat-width', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { passed: false, checks: [], measurements: [], screenshots: [], errors: [] };

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const text = text => ({ type: 'text', text, status: 'complete' });
const items = [];
for (let index = 0; index < 24; index += 1) {
  const turnId = 'width-turn-' + index;
  items.push({ id: turnId + '-user', role: 'user', turnId, createdAt: String(index * 4), parts: [text('Inspect transcript width ' + index)] });
  items.push({ id: turnId + '-tool', role: 'assistant', turnId, createdAt: String(index * 4 + 1), parts: [{ type: 'tool', toolId: 'tool-' + index, toolName: 'commandExecution', status: 'completed', data: { command: 'npm run check', aggregatedOutput: 'checked transcript geometry ' + index } }] });
  if (index === 8) items.push({ id: turnId + '-subagent', role: 'assistant', turnId, createdAt: String(index * 4 + 2), parts: [{ type: 'subagent', status: 'completed', data: { key: 'width-subagent', provider: 'codex', agentType: 'explore', description: 'Measure the transcript layout while scrolling.', status: 'completed', transcript: 'none', toolCount: 2, summary: 'The transcript card stays aligned with the other rows.', startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:00:01.000Z' } }] });
  items.push({ id: turnId + '-answer', role: 'assistant', turnId, createdAt: String(index * 4 + 3), elapsedMs: 1000, parts: [text('A sufficiently long response keeps this fixed-size Electron transcript scrollable and wraps inside the message width. '.repeat(3))] });
}
const bridge = {
  onEvent: () => () => {},
  request: async (method, params) => {
    if (method === 'chat.snapshot') return { items, revision: 1, hasEarlier: false };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.queue.read') return { sessionId: params.sessionId, paused: false, items: [] };
    if (method === 'chat.connection' || method === 'chat.connect') return { sessionId: params.sessionId, runtimeEpoch: 'fixture', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' };
    if (method === 'chat.options') return { options: [], commands: [], loadState: 'ready' };
    if (method === 'chat.feedback.read') return { notes: [] };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release') return null;
    throw new Error('Unexpected QA request ' + method);
  },
};
window.threadterm = bridge;
const root = createRoot(document.getElementById('root'));
window.qa = {
  mount() {
    root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView session={{ id: 'chat-width-fixture', provider: 'codex', mode: 'chat', status: 'idle', title: 'Chat width fixture', createdAt: 'now', updatedAt: 'now' }} /></SessionSurfaceContext.Provider></I18nProvider>);
  },
  measure() {
    const log = document.querySelector('.v3-chat-log');
    const turn = document.querySelectorAll('.chat-turn')[8];
    const tool = document.querySelector('.chat-tool-activity');
    const subagent = document.querySelector('.chat-subagent-card');
    const rect = node => { const value = node.getBoundingClientRect(); return { left: Math.round(value.left), width: Math.round(value.width), right: Math.round(value.right), height: Math.round(value.height) }; };
    return { log: { clientWidth: log.clientWidth, scrollWidth: log.scrollWidth, paddingLeft: getComputedStyle(log).paddingLeft, paddingRight: getComputedStyle(log).paddingRight }, turn: rect(turn), tool: rect(tool), subagent: rect(subagent), overlay: Boolean(document.querySelector('.chat-back-to-bottom')) };
  },
  scroll(position) {
    const log = document.querySelector('.v3-chat-log');
    log.scrollTop = position === 'top' ? 0 : log.scrollHeight;
    log.dispatchEvent(new Event('scroll'));
  },
};
window.qa.mount();
`;

await mkdir(out, { recursive: true });
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'fixture.js'), jsx: 'automatic', logLevel: 'error', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;min-width:0}</style><div id="root"></div><script src="fixture.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))}); app.whenReady().then(() => new BrowserWindow({ width: 1400, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app;
try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], cwd: root });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => typeof window.qa?.measure === 'function' && document.querySelectorAll('.chat-turn').length >= 20 && document.querySelector('.chat-subagent-card'));
  const frame = async () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  for (const width of [1400, 600]) {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 760), width);
    await page.waitForFunction(value => window.innerWidth === value, width);
    await page.evaluate(() => window.qa.scroll('bottom')); await frame();
    const bottom = await page.evaluate(() => window.qa.measure());
    await page.locator('.v3-chat-log').hover();
    await page.mouse.wheel(0, -2_000);
    await page.waitForFunction(() => document.querySelector('.chat-back-to-bottom'));
    await frame();
    const history = await page.evaluate(() => window.qa.measure());
    assert.equal(await page.locator('.chat-back-to-bottom').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    }), true, `${width}: back-to-bottom control remains a pointer target`);
    await page.locator('.chat-back-to-bottom').click(); await frame();
    const returned = await page.evaluate(() => window.qa.measure());
    report.measurements.push({ width, bottom, history, returned });
    for (const [name, snapshot] of [['bottom', bottom], ['history', history], ['returned', returned]]) {
      assert.ok(snapshot.log.scrollWidth <= snapshot.log.clientWidth + 1, `${width}/${name}: transcript does not overflow horizontally`);
      assert.equal(snapshot.turn.left, bottom.turn.left, `${width}/${name}: turn keeps its alignment`);
      assert.equal(snapshot.turn.width, bottom.turn.width, `${width}/${name}: turn keeps its width`);
      assert.equal(snapshot.tool.width, bottom.tool.width, `${width}/${name}: tool activity keeps its width`);
      assert.equal(snapshot.subagent.width, bottom.subagent.width, `${width}/${name}: subagent card keeps its width`);
      assert.equal(snapshot.turn.height, bottom.turn.height, `${width}/${name}: turn wrapping stays stable`);
    }
    assert.equal(history.overlay, true, `${width}: scrolling into history reveals the back-to-bottom control`);
    assert.equal(returned.overlay, false, `${width}: the control clears after returning to the bottom`);
    await page.screenshot({ path: join(out, `chat-width-${width}.png`), animations: 'disabled' }); report.screenshots.push(`chat-width-${width}.png`);
  }
  report.checks.push('wide and narrow transcript, tool activity, and subagent widths stay fixed through bottom → history → bottom');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  await app?.close();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? 'CHAT WIDTH VISUAL QA PASSED' : `CHAT WIDTH VISUAL QA FAILED\\n${report.errors.join('\\n')}`);
}

assert.equal(report.errors.length, 0, report.errors.join('\\n'));
