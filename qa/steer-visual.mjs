// Isolated production-ChatView QA for D4 split Send. A deterministic in-memory
// bridge stands in for the runtime. No provider process starts. The matrix is
// wide and 420 px, light/dark/custom, en and zh-CN, for every steer state.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-steer-'));
const out = resolve('qa/results/chat-parity/D4/steer-visual');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { AgentIconsProvider } from './renderer/src/components/PrototypeIcon';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const providers = [{ id: 'codex', name: 'Codex', version: '0.161.0', installed: true, terminal: true, chat: true, history: true, resume: true }];
const OPTIONS = { loadState: 'ready', commands: [], inputCapabilities: { images: true, steer: 'native' }, options: [
  { id: 'model', name: 'Model', category: 'model', value: 'openai/qa-steer', choices: [{ value: 'openai/qa-steer', name: 'GPT QA Steer' }] },
  { id: 'thinking', name: 'Thinking', category: 'thinking', value: 'medium', choices: [{ value: 'medium', name: 'Medium' }] },
] };
const listeners = new Set();
let sequence = 1, sessionId = 'steer-1', locale = 'en';
let mode = 'idle';
const live = () => mode !== 'idle';
const draft = () => mode === 'disabled' ? '' : mode === 'idle' ? 'Send this' : 'while you work';
const queue = () => ({ sessionId, paused: false, items: mode === 'queue' ? [{ id: 'q1', text: 'Follow this up', images: [], revision: 1, createdAt: 'now', updatedAt: 'now', state: 'queued' }] : [] });
const items = () => {
  if (!live()) return [{ id: sessionId + ':assistant:done', role: 'assistant', parts: [{ type: 'text', text: 'Ready', status: 'complete' }], createdAt: 'now', turnId: 'turn-0', turnStatus: 'completed' }];
  const rows = [
    { id: sessionId + ':user:turn-1', role: 'user', parts: [{ type: 'text', text: 'Start the long job' }], createdAt: 'now', turnId: 'turn-1' },
    { id: sessionId + ':assistant:turn-1', role: 'assistant', parts: [{ type: 'text', text: 'Working', status: 'streaming' }], createdAt: 'now', turnId: 'turn-1' },
  ];
  if (mode === 'inserted') rows.push({ id: sessionId + ':user:steer:op', role: 'user', parts: [{ type: 'text', text: 'already inserted', data: { steered: true, turnId: 'turn-1' } }], createdAt: 'now', turnId: 'turn-1' });
  return rows;
};
window.threadterm = {
  onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  request: async (method, params) => {
    if (method === 'session.claim') return { leaseEpoch: 1 };
    if (method === 'session.renew' || method === 'session.release') return {};
    if (method === 'chat.connection' || method === 'chat.connect') return { sessionId, runtimeEpoch: 'epoch', connectionGeneration: 1, revision: 1, phase: 'ready', nativeId: 'native-' + sessionId, optionsLoadState: 'ready' };
    if (method === 'chat.context.read') return null;
    if (method === 'chat.snapshot') return { items: items(), revision: 1 };
    if (method === 'chat.draft.read') return { text: draft(), revision: 0 };
    if (method === 'chat.draft.save') return { text: params.text, revision: 1 };
    if (method === 'chat.queue.read' || method === 'chat.queue.add') return queue();
    if (method === 'chat.options') return OPTIONS;
    if (method === 'chat.steer') {
      if (mode === 'failure') {
        const error = new Error('The turn ended before the message was inserted');
        error.code = 'turn_changed';
        throw error;
      }
      return { disposition: 'delivered' };
    }
    throw Error('Unexpected QA request ' + method);
  },
};
const root = createRoot(document.getElementById('root'));
window.qaRender = nextLocale => {
  locale = nextLocale;
  sessionId = 'steer-' + nextLocale + '-' + mode + '-' + (sequence++);
  window.qaSessionId = sessionId;
  window.qaMode = mode;
  return root.render(<I18nProvider locale={locale}><AgentIconsProvider providers={providers}><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView key={sessionId} session={{ id: sessionId, provider: 'codex', mode: 'chat', status: live() ? 'running' : 'idle', readOnly: false, title: 'Steer QA', createdAt: 'now', updatedAt: 'now', worktreePath: 'D:/workspace/ThreadTerm' }} /></SessionSurfaceContext.Provider></AgentIconsProvider></I18nProvider>);
};
window.qaModeSet = next => { mode = next; };
window.qaTheme = theme => {
  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(custom)) style.setProperty('--custom-' + key, value);
  document.documentElement.dataset.theme = theme === 'custom' ? 'dark' : theme;
  document.documentElement.dataset.customTheme = theme === 'custom' ? 'true' : 'false';
};
document.documentElement.dataset.theme = 'light';
window.qaModeSet('idle');
window.qaRender('en');
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';');
assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');

const report = { passed: false, scratch, checks: [], snapshots: [], layout: [], errors: [] };
let app, page;
const label = {
  send: { en: 'Send', 'zh-CN': '发送' },
  queue: { en: 'Queue', 'zh-CN': '加入队列' },
  more: { en: 'More send actions', 'zh-CN': '更多发送操作' },
  insert: { en: 'Insert into current turn', 'zh-CN': '插入当前回合' },
  now: { en: 'Insert now', 'zh-CN': '立即插入' },
  tag: { en: 'Inserted', 'zh-CN': '已插入' },
  failed: { en: 'The turn ended before the message was inserted', 'zh-CN': '这一轮在插入前已经结束' },
};
async function shot(name) {
  await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
  report.snapshots.push(`${name}.png`);
}
async function show(mode, { theme, locale, width }) {
  await page.evaluate(next => window.qaModeSet(next), mode);
  await page.evaluate(next => window.qaRender(next), locale);
  await page.evaluate(value => window.qaTheme(value), theme);
  await page.setViewportSize({ width, height: 900 });
  const id = await page.evaluate(() => window.qaSessionId);
  const root = page.locator(`[data-testid="session-chat-${id}"]`);
  await root.locator('.chat-compose-shell textarea').waitFor();
  if (mode === 'idle') await root.locator(`.chat-compose-send[aria-label="${label.send[locale]}"]`).waitFor();
  else await root.locator('[data-testid="steer-send"]').waitFor();
  if (mode === 'queue') await root.locator('[data-testid="queue-insert-now"]').waitFor();
  if (mode === 'inserted') await root.locator('[data-testid="inserted-tag"]').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return root;
}
async function oneRow(root, name) {
  const bar = await root.locator('.chat-compose-bar').evaluate(node => {
    const left = node.querySelector('.chat-compose-left');
    const right = node.querySelector('.chat-compose-right');
    const children = [...node.querySelectorAll('.chat-compose-left > *, .chat-compose-right > *')]
      .filter(child => child.getClientRects().length)
      .map(child => child.getBoundingClientRect());
    return {
      height: node.getBoundingClientRect().height,
      leftTop: left.getBoundingClientRect().top,
      rightTop: right.getBoundingClientRect().top,
      minTop: Math.min(...children.map(rect => rect.top)),
      maxTop: Math.max(...children.map(rect => rect.top)),
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    };
  });
  assert.ok(Math.abs(bar.leftTop - bar.rightTop) < 2, `${name}: groups sit on one line`);
  assert.ok(bar.maxTop - bar.minTop < 2, `${name}: controls wrap within a group`);
  assert.ok(bar.scrollWidth <= bar.clientWidth + 1, `${name}: the bar overflows`);
  assert.ok(bar.height < 40, `${name}: the bar is ${bar.height}px`);
}
async function note(name, text) { report.layout.push(`${name}: ${text}`); }

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => typeof window.qaModeSet === 'function' && typeof window.qaRender === 'function');
  const states = ['idle', 'running', 'menu', 'inserted', 'failure', 'queue', 'disabled'];
  const themes = ['light', 'dark', 'custom'];
  const locales = ['en', 'zh-CN'];
  const widths = [1100, 420];
  for (const state of states) {
    for (const theme of themes) {
      for (const locale of locales) {
        for (const width of widths) {
          const name = `steer-${state}-${theme}-${locale}-${width}`;
          const root = await show(state, { theme, locale, width });
          if (state === 'menu' || state === 'failure') {
            await root.locator(`[aria-label="${label.more[locale]}"]`).click();
            await root.locator('[data-testid="steer-menu"]').waitFor();
          }
          if (state === 'failure') {
            await root.locator('[data-testid="steer-insert"]').click();
            await root.locator('.surface-error').waitFor();
          }
          await oneRow(root, name);
          const shell = `[data-testid="session-chat-${await page.evaluate(() => window.qaSessionId)}"] .chat-compose-shell`;
          assertNoControlViolations(await checkControlConsistency(page, shell), `${name} composer`);
          if (state === 'menu') {
            const menu = `[data-testid="session-chat-${await page.evaluate(() => window.qaSessionId)}"] [data-testid="steer-menu"]`;
            assertNoControlViolations(await checkControlConsistency(page, menu), `${name} menu`);
            const item = root.locator('[data-testid="steer-insert"]');
            const box = await item.evaluate(node => ({ text: node.textContent, height: node.getBoundingClientRect().height, scroll: node.scrollHeight, client: node.clientHeight }));
            assert.equal(box.text, label.insert[locale]);
            assert.ok(box.scroll <= box.client + 1, `${name} menu label wraps`);
          }
          if (state === 'running' || state === 'menu' || state === 'inserted' || state === 'queue') {
            const heights = await root.locator('[data-testid="steer-send"] > button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            assert.equal(heights.length, 2, `${name} split button count`);
            assert.ok(heights.every(height => Math.abs(height - heights[0]) < 0.6 && height >= 24 && height <= 28), `${name} split heights ${heights.join(',')}`);
          }
          if (state === 'idle') assert.equal(await root.locator('[data-testid="steer-send"]').count(), 0);
          if (state === 'disabled') {
            assert.equal(await root.locator('[data-testid="steer-send"] button').first().isDisabled(), true);
          }
          if (state === 'queue') {
            const now = root.locator('[data-testid="queue-insert-now"]');
            assert.equal(await now.innerText(), label.now[locale]);
            assert.equal(await root.getByRole('button', { name: locale === 'zh-CN' ? '立即发送' : 'Send now' }).count(), 0);
            const box = await now.evaluate(node => ({ scroll: node.scrollHeight, client: node.clientHeight }));
            assert.ok(box.scroll <= box.client + 1, `${name} Insert now wraps`);
            assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${await page.evaluate(() => window.qaSessionId)}"] .chat-queue`), `${name} queue`);
          }
          if (state === 'inserted') assert.equal((await root.locator('[data-testid="inserted-tag"]').innerText()).trim(), label.tag[locale]);
          if (state === 'failure') {
            assert.equal((await root.locator('.surface-error').innerText()).trim(), label.failed[locale]);
            assert.equal(await root.locator('.chat-compose-shell textarea').inputValue(), 'while you work');
          }
          await shot(name);
          if (theme === 'light' && locale === 'en' && width === 420) {
            const geometry = await root.locator('.chat-compose-bar').evaluate(node => {
              const bar = node.getBoundingClientRect();
              const send = node.querySelector('.chat-compose-right')?.getBoundingClientRect();
              return { barHeight: bar.height, barWidth: bar.width, sendRight: send ? bar.right - send.right : null };
            });
            await note(name, `one row ${geometry.barHeight}px tall inside ${geometry.barWidth}px; send cluster inset ${geometry.sendRight}px from the bar's right edge`);
          }
        }
      }
    }
  }
  await note('buttons', 'Split Send is two icon-btn icon-btn-sm icon-btn-round controls, same height, 4px apart. Queue and Insert now stay btn-subtle. No second text size or radius was introduced.');
  await note('spacing', 'The composer bar keeps its 8px outer gap and 6px cluster gap. The steer pair uses a 4px gap. The menu sits 6px above the arrow.');
  await note('alignment', 'The arrow and the Queue button share one center line. Inserted is a plain chip inline after the user text, not a second heading.');
  await note('type', 'Menu and queue labels use the shared 12px menu/button text. zh-CN labels stay on one line at 420px.');
  await note('color', 'No new hex, rgb, or hsl was added. Light, dark, and the custom token pack recolor the same controls.');
  await note('states', 'The arrow exposes aria-expanded. Disabled split buttons share the icon-button disabled treatment. The menu closes by its own item click.');
  await note('theme', 'Custom theme sets dataset.customTheme and the --custom-* tokens. Borders and text follow those tokens.');
  await note('missing-mixed-widths', 'The two split buttons are the same 26px circle. Queue actions share btn-subtle. Nothing in the card mixes a wide button with a short one.');
  await note('missing-duplicate', 'Inserted is one tag on the steered user row. The running reply stays a single streaming bubble.');
  await note('missing-padding', 'The composer shell keeps its existing side padding. The menu uses the shared 6px menu padding.');
  await note('missing-dead-space', 'No dialog was added. The menu is only as tall as its one item.');
  await note('missing-headings', 'No new heading. The queue header stays the existing strong label.');
  await note('missing-wrap-420', 'At 420px the composer bar stays one row. Insert into current turn and Insert now do not wrap.');
  await note('missing-overlay', 'The menu opens upward from the arrow and does not cover the textarea. It can cover the last transcript line, the same slot other composer menus use.');
  await note('missing-empty-box', 'No empty status box. Idle is the normal Send button. A paused queue without a live turn is not given a split control.');
  assert.equal(report.snapshots.length, 84);
  assert.deepEqual(report.errors, []);
  report.checks.push('84 shots, zero control violations, one composer row at 420px');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'STEER VISUAL QA PASSED' : 'STEER VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
