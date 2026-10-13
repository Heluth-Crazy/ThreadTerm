// Isolated production-ChatView QA for E2 feedback notes. A deterministic
// in-memory bridge stands in for the runtime; no provider process starts. The
// matrix is wide and 420 px, light/dark/custom, en and zh-CN, for every note
// state. Every surface asserts zero control-consistency violations.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-notes-'));
const out = resolve('qa/results/chat-parity/E2/feedback-notes-visual');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { AgentIconsProvider } from './renderer/src/components/PrototypeIcon';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const providers = [{ id: 'kimi', name: 'Kimi', version: '2.0.2', installed: true, terminal: true, chat: true, history: true, resume: true }];
const OPTIONS = { loadState: 'ready', commands: [], inputCapabilities: { images: true, steer: 'note' }, options: [
  { id: 'model', name: 'Model', category: 'model', value: 'kimi/qa-note', choices: [{ value: 'kimi/qa-note', name: 'Kimi QA Note' }] },
] };
const listeners = new Set();
let sequence = 1, sessionId = 'notes-1', locale = 'en', mode = 'waiting';
const live = () => mode === 'waiting' || mode === 'received' || mode === 'queue' || mode === 'menu';
const note = (id, status) => ({ id, sessionId, turnId: live() ? 'turn-1' : 'turn-0', text: 'Prefer the narrow reading for note ' + id, status, createdAt: 'now' });
const notes = () => {
  if (mode === 'empty') return [];
  if (mode === 'received' || mode === 'card') return [note('n1', 'received')];
  if (mode === 'turnend') return [note('n1', 'waiting'), note('n2', 'waiting')];
  return [note('n1', 'waiting')];
};
const queue = () => ({ sessionId, paused: false, items: mode === 'queue' ? [{ id: 'q1', text: 'Follow this up', images: [], revision: 1, createdAt: 'now', updatedAt: 'now', state: 'queued' }] : [] });
const items = () => {
  if (mode === 'card') return [
    { id: sessionId + ':user:turn-0', role: 'user', parts: [{ type: 'text', text: 'Check for notes' }], createdAt: 'now', turnId: 'turn-0' },
    { id: sessionId + ':assistant:turn-0', role: 'assistant', turnStatus: 'completed', parts: [
      { type: 'tool', toolName: 'mcp__threadterm__feedback_check', status: 'completed', data: { result: { content: [{ type: 'text', text: JSON.stringify({ notes: [{ id: 'n1', sessionId, turnId: 'turn-0', text: 'Prefer the narrow reading for note n1', status: 'received', createdAt: 'now' }] }) }] } } },
      { type: 'text', text: 'Checked', status: 'complete' },
    ], createdAt: 'now', turnId: 'turn-0' },
  ];
  if (!live()) return [{ id: sessionId + ':assistant:done', role: 'assistant', parts: [{ type: 'text', text: 'Ready', status: 'complete' }], createdAt: 'now', turnId: 'turn-0', turnStatus: 'completed' }];
  return [
    { id: sessionId + ':user:turn-1', role: 'user', parts: [{ type: 'text', text: 'Start the long job' }], createdAt: 'now', turnId: 'turn-1' },
    { id: sessionId + ':assistant:turn-1', role: 'assistant', parts: [{ type: 'text', text: 'Working', status: 'streaming' }], createdAt: 'now', turnId: 'turn-1' },
  ];
};
window.threadterm = {
  onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  request: async (method, params) => {
    if (method === 'session.claim') return { leaseEpoch: 1 };
    if (method === 'session.renew' || method === 'session.release') return {};
    if (method === 'chat.connection' || method === 'chat.connect') return { sessionId, runtimeEpoch: 'epoch', connectionGeneration: 1, revision: 1, phase: 'ready', nativeId: 'native-' + sessionId, optionsLoadState: 'ready' };
    if (method === 'chat.context.read') return null;
    if (method === 'chat.snapshot') return { items: items(), revision: 1 };
    if (method === 'chat.draft.read') return { text: live() ? 'narrow the scope' : '', revision: 0 };
    if (method === 'chat.draft.save') return { text: params.text, revision: 1 };
    if (method === 'chat.queue.read' || method === 'chat.queue.add') return queue();
    if (method === 'chat.options') return OPTIONS;
    if (method === 'chat.feedback.read') return { notes: notes() };
    if (method === 'chat.feedback.add') return { note: note('added', 'waiting') };
    if (method === 'chat.feedback.dismiss') return { removed: params.noteIds };
    if (method === 'chat.send') return { turnId: 'turn-sent' };
    throw Error('Unexpected QA request ' + method);
  },
};
const root = createRoot(document.getElementById('root'));
window.qaRender = nextLocale => {
  locale = nextLocale;
  sessionId = 'notes-' + nextLocale + '-' + mode + '-' + (sequence++);
  window.qaSessionId = sessionId;
  return root.render(<I18nProvider locale={locale}><AgentIconsProvider providers={providers}><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView key={sessionId} session={{ id: sessionId, provider: 'kimi', mode: 'chat', status: live() ? 'running' : 'idle', readOnly: false, title: 'Notes QA', createdAt: 'now', updatedAt: 'now', worktreePath: 'D:/workspace/ThreadTerm' }} /></SessionSurfaceContext.Provider></AgentIconsProvider></I18nProvider>);
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
window.qaModeSet('waiting');
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
  waiting: { en: 'Waiting', 'zh-CN': '等待中' },
  received: { en: 'Received', 'zh-CN': '已接收' },
  note: { en: 'Send note for next check', 'zh-CN': '发送备注供下次检查' },
  sendMessage: { en: 'Send as message', 'zh-CN': '作为消息发送' },
  sendAll: { en: 'Send all as message', 'zh-CN': '全部作为消息发送' },
  queueNote: { en: 'Send as note', 'zh-CN': '作为备注发送' },
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
  if (mode === 'empty') await root.locator('[data-testid="chat-notes"]').waitFor({ state: 'detached' }).catch(() => undefined);
  else await root.locator('[data-testid="chat-notes"]').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return root;
}
async function note(name, text) { report.layout.push(`${name}: ${text}`); }

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => typeof window.qaModeSet === 'function' && typeof window.qaRender === 'function');
  const states = ['empty', 'waiting', 'received', 'menu', 'turnend', 'queue', 'card'];
  const themes = ['light', 'dark', 'custom'];
  const locales = ['en', 'zh-CN'];
  const widths = [1100, 420];
  for (const state of states) {
    for (const theme of themes) {
      for (const locale of locales) {
        for (const width of widths) {
          const name = `notes-${state}-${theme}-${locale}-${width}`;
          const root = await show(state, { theme, locale, width });
          const id = await page.evaluate(() => window.qaSessionId);
          const stripSelector = `[data-testid="session-chat-${id}"] [data-testid="chat-notes"]`;
          if (state === 'empty') {
            assert.equal(await root.locator('[data-testid="chat-notes"]').count(), 0, `${name}: no strip while no notes exist`);
            assert.equal(await root.locator('[data-testid="steer-send"]').count(), 0, `${name}: idle keeps the plain Send button`);
          } else {
            if (state === 'received' || state === 'card') assert.equal((await root.locator('[data-testid="chat-note"]').first().getAttribute('data-note-status')), 'received');
            else assert.equal((await root.locator('[data-testid="chat-note"]').first().getAttribute('data-note-status')), 'waiting');
            const statusText = (await root.locator('.chat-note-status').first().innerText()).trim();
            assert.equal(statusText, (state === 'received' || state === 'card') ? label.received[locale] : label.waiting[locale], `${name}: status label`);
            await assertNoControlViolations(await checkControlConsistency(page, stripSelector), `${name} notes strip`);
          }
          if (state === 'waiting' || state === 'received' || state === 'menu' || state === 'queue') {
            const split = root.locator('[data-testid="steer-send"][data-steer-kind="split-note"]');
            await split.waitFor();
            await root.locator('[data-testid="steer-send"] [aria-label="' + (locale === 'zh-CN' ? '更多发送操作' : 'More send actions') + '"]').click();
            const item = root.locator('[data-testid="steer-note"]');
            await item.waitFor();
            assert.equal((await item.innerText()).trim(), label.note[locale], `${name}: note menu label`);
            await assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${id}"] [data-testid="steer-menu"]`), `${name} note menu`);
          }
          if (state === 'queue') {
            const queueNote = root.locator('[data-testid="queue-send-note"]');
            await queueNote.waitFor();
            assert.equal((await queueNote.innerText()).trim(), label.queueNote[locale], `${name}: queue note label`);
            await assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${id}"] .chat-queue`), `${name} queue`);
          }
          if (state === 'turnend') {
            assert.equal(await root.locator('[data-testid="steer-send"]').count(), 0, `${name}: no split control while idle`);
            const send = root.locator('[data-testid="note-send-message"]').first();
            await send.waitFor();
            assert.equal((await send.innerText()).trim(), label.sendMessage[locale], `${name}: send-as-message label`);
            const all = root.locator('[data-testid="notes-send-all"]');
            assert.equal((await all.innerText()).trim(), label.sendAll[locale], `${name}: send-all label`);
          }
          if (state === 'card') {
            await root.locator('.chat-tool-activity summary').first().click();
            const part = root.locator('.chat-tool-entry').first();
            await part.waitFor();
            const showAll = part.locator('[data-testid="feedback-show-all"]');
            await showAll.waitFor();
            assert.match(await part.innerText(), new RegExp(locale === 'zh-CN' ? '1 条反馈备注' : '1 feedback note'), `${name}: the check result reads as a count`);
            await showAll.click();
            assert.match(await part.innerText(), /Prefer the narrow reading/, `${name}: Show all lists the note`);
            await assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${id}"] .chat-tool-activity`), `${name} tool card`);
          }
          const shell = `[data-testid="session-chat-${id}"] .chat-compose-shell`;
          await assertNoControlViolations(await checkControlConsistency(page, shell), `${name} composer`);
          if (width === 420) {
            const geometry = await root.locator('.chat-notes').evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth })).catch(() => undefined);
            if (geometry) assert.ok(geometry.scroll <= geometry.client + 1, `${name}: the strip overflows at 420px`);
          }
          await shot(name);
          if (theme === 'light' && locale === 'en' && width === 420) await note(name, 'notes strip fits the 420px composer column; the status and the action share one head row and the text wraps below it');
        }
      }
    }
  }
  // One interaction: Send as message clears the note locally and never duplicates it.
  await page.setViewportSize({ width: 1100, height: 900 });
  const root = await show('turnend', { theme: 'light', locale: 'en', width: 1100 });
  const before = await root.locator('[data-testid="chat-note"]').count();
  await root.locator('[data-testid="note-send-message"]').first().click();
  await page.waitForFunction(count => document.querySelectorAll('[data-testid="chat-note"]').length < count, before);
  assert.equal(await root.locator('[data-testid="chat-note"]').count(), before - 1, 'Send as message clears exactly that note');
  report.checks.push('send-as-message clears one note and leaves the rest');
  await note('buttons', 'The split note control is two icon-btn icon-btn-sm icon-btn-round controls at one height; note and queue actions stay btn-subtle, so no mixed control size appears in a row.');
  await note('spacing', 'The strip uses the queue panel radius and 8px/6px gaps; the head row keeps 8px between the status and its action.');
  await note('alignment', 'The status label and the action share one center line; the note text sits on its own wrapped line below, never squeezed between controls.');
  await note('type', 'Status text is 11px, the note body 12px, and the action uses the shared small-button text. zh-CN labels stay on one line at 420px.');
  await note('color', 'No new hex, rgb, or hsl was added; Waiting uses var(--amber) and Received uses var(--muted), both remapped by the custom theme.');
  await note('states', 'The arrow exposes aria-expanded and closes on Escape; disabled actions keep the shared disabled treatment; the strip renders nothing when there are no notes.');
  await note('missing-mixed-widths', 'No card mixes a wide button with a short one: the head action and the status share one row, and the note text is not a control.');
  await note('missing-duplicate', 'A note appears once in the strip; the tool card shows the same note only inside its own Show all list.');
  await note('missing-padding', 'The strip keeps the queue panel side padding; the note text never touches the border.');
  await note('missing-dead-space', 'The strip is only as tall as its notes; it has no fixed height.');
  await note('missing-headings', 'The only heading is the 12px strong count line, in scale with the queue header.');
  await note('missing-wrap-420', 'At 420px the Send as message action stays on the note head row and does not wrap alone.');
  await note('missing-overlay', 'The strip sits above the composer and never overlaps transcript content.');
  await note('missing-empty-box', 'No empty status box: the empty state renders no strip at all.');
  assert.deepEqual(report.errors, []);
  report.checks.push(`${report.snapshots.length} shots, zero control violations, notes strip states covered`);
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'FEEDBACK NOTES VISUAL QA PASSED' : 'FEEDBACK NOTES VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
