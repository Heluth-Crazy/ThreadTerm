// Isolated Electron fixture QA for issue 10 (package B): a cancelled Claude
// approval card expires in place and never disables a sibling pending card.
// The renderer receives exactly the chat.item replacement the fixed projection
// emits. No runtime, provider, or user data is touched.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-approval-cancel-'));
const out = resolve('qa/results/approval-cancel');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const listeners = new Set();
const session = { id: 'qa-claude-approval', provider: 'claude', mode: 'chat', status: 'waiting', title: 'QA', createdAt: 'now', updatedAt: 'now' };
const card = (approvalId, title, status = 'pending', extra = {}) => ({
  id: 'card-' + approvalId, role: 'assistant', turnId: 'turn-1', createdAt: 'now',
  parts: [{ type: 'approval', approvalId, status, data: {
    approvalId, title, requestType: 'session/request_permission', submittable: true, ...extra,
    choices: [
      { choiceId: 'allow-' + approvalId, label: 'Allow once', kind: 'allow', scope: 'once' },
      { choiceId: 'deny-' + approvalId, label: 'Deny', kind: 'deny', scope: 'once' },
    ],
  } }],
});
let items = [card('a1', 'Run command'), card('a2', 'Write file')];
window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    if (method === 'chat.snapshot') return { items, revision: 1 };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.draft.save') return { text: params.text, revision: (params.expectedRevision || 0) + 1 };
    if (method === 'chat.options') return { options: [], commands: [], loadState: 'ready' };
    if (method === 'chat.connection' || method === 'chat.connect') return { sessionId: params.sessionId, runtimeEpoch: 'e', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release' || method === 'chat.approve') return null;
    throw new Error('Unexpected QA request ' + method);
  },
};
let sequence = 10;
window.qaExpireCard = (approvalId, outcome, message) => {
  const target = card(approvalId, approvalId === 'a1' ? 'Run command' : 'Write file', 'expired', { outcome, message, submittable: false });
  items = items.map(item => item.id === 'card-' + approvalId ? target : item);
  listeners.forEach(listener => listener({ event: 'chat.item', seq: ++sequence, epoch: 'e', data: { sessionId: session.id, item: target } }));
};
const root = createRoot(document.getElementById('root'));
window.qaRender = theme => { document.documentElement.dataset.theme = theme; root.render(React.createElement(I18nProvider, { locale: 'zh-CN' }, React.createElement(ChatView, { session }))); };
window.qaRender('light');
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root>*{height:100%}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaRender);

  // Both cards start pending and actionable.
  const cards = page.locator('.chat-approval-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  const cardA1 = page.locator('.chat-approval-card', { hasText: 'Run command' });
  const cardA2 = page.locator('.chat-approval-card', { hasText: 'Write file' });
  assert.ok(await cardA1.locator('button').first().isEnabled(), 'a1 must start actionable');
  assert.ok(await cardA2.locator('button').first().isEnabled(), 'a2 must start actionable');

  // The runtime cancels a1 (e.g. the Claude turn was interrupted): the card
  // expires in place and its actions disable, while a2 stays actionable.
  await page.evaluate(() => window.qaExpireCard('a1', 'cancelled', 'Request cancelled'));
  await page.locator('.chat-approval-card.expired', { hasText: 'Run command' }).waitFor();
  assert.equal(await cardA1.locator('button:enabled').count(), 0, 'expired card must not keep enabled buttons');
  assert.ok(await cardA1.getByText('该请求已失效').count(), 'expired card must show the invalid notice');
  assert.ok(await cardA2.locator('button').first().isEnabled(), 'a2 must stay actionable');
  await page.screenshot({ path: join(out, 'claude-approval-cancel-light.png') });

  // A duplicate cancellation is idempotent; the sibling card is unaffected.
  await page.evaluate(() => window.qaExpireCard('a1', 'cancelled', 'Request cancelled'));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.chat-approval-card.expired').count(), 1);
  assert.ok(await cardA2.locator('button').first().isEnabled(), 'a2 survives duplicate expiry of a1');

  await page.evaluate(() => window.qaRender('dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'claude-approval-cancel-dark.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, checks: ['single card expired+disabled', 'sibling stays actionable', 'duplicate expiry idempotent', 'light+dark shots'], shots: out }));
} finally {
  await app?.close();
}
