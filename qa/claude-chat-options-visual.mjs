// Isolated Electron fixture for task 09-29-agent-compat-claude: the real ChatView renders
// Claude's SDK-provided chips, menus, command list and "Always allow" approval card in
// zh-CN and English. Option/command/card shapes are the ones the live runtime produced
// (qa/claude-chat-live.mjs). No runtime, provider or user data is touched.
//   node qa/claude-chat-options-visual.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-options-'));
const out = resolve('qa/results/claude-chat-options');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const session = { id: 'qa-claude-options', provider: 'claude', mode: 'chat', status: 'waiting', title: 'QA', createdAt: 'now', updatedAt: 'now' };
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const names = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
let ui = {
  options: [
    { id: 'model', name: 'Model', value: 'default', choices: [{ value: 'default', name: 'Default (recommended)' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }] },
    { id: 'thinking', name: 'Thinking', value: 'high', choices: efforts.map(value => ({ value, name: names[value] })) },
    { id: 'mode', name: 'Permission mode', value: 'default', choices: [{ value: 'default', name: 'Default' }, { value: 'acceptEdits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }, { value: 'dontAsk', name: "Don't ask" }, { value: 'auto', name: 'Auto' }] },
  ],
  commands: [{ name: 'compact', description: 'Free up context by summarizing the conversation so far' }, { name: 'context', description: 'Show current context usage' }, { name: 'tt-probe-skill', description: 'ThreadTerm probe skill.' }],
};
const items = [
  { id: 'u1', role: 'user', turnId: 't1', createdAt: 'now', parts: [{ type: 'text', text: '/context' }] },
  { id: 'a1', role: 'assistant', turnId: 't1', createdAt: 'now', parts: [{ type: 'text', text: '## Context Usage\\n\\n**Model:** claude-sonnet-5  \\n**Tokens:** 15.8k / 1m (2%)', status: 'complete' }] },
  { id: 'card', role: 'assistant', turnId: 't2', createdAt: 'now', parts: [{ type: 'approval', approvalId: 'card-1-permission-1', status: 'pending', data: {
    approvalId: 'card-1-permission-1', title: 'Permission request', requestType: 'session.request', submittable: true, provider: 'claude',
    details: { toolName: 'PowerShell', input: { command: 'node tt.js' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'node tt.js' }], behavior: 'allow', destination: 'localSettings' }] },
    choices: [
      { choiceId: 'allow', label: 'Allow once', kind: 'allow', scope: 'once' },
      { choiceId: 'allow_always', label: 'Always allow in this project', kind: 'allow', scope: 'persistent' },
      { choiceId: 'deny', label: 'Deny', kind: 'deny', scope: 'once' },
    ],
  } }] },
];
// Send phase: an idle session whose chat.send stays pending until the test releases it.
const sendSession = { ...session, id: 'qa-claude-send', status: 'idle' };
const sendItems = items.slice(0, 2);
const listeners = new Set();
let sequence = 10, releaseSend;
window.qaReleaseSend = () => releaseSend?.();
window.qaRequests = [];
window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    window.qaRequests.push({ method, params });
    if (method === 'chat.snapshot') return { items: params.sessionId === sendSession.id ? sendItems : items, revision: 1 };
    if (method === 'chat.send') return new Promise(resolve => { releaseSend = () => {
      const item = { id: 'u-sent', role: 'user', turnId: params.operationId, createdAt: 'now', parts: [{ type: 'text', text: params.text }] };
      sendItems.push(item);
      listeners.forEach(listener => listener({ event: 'chat.item', seq: ++sequence, epoch: 'e', data: { sessionId: params.sessionId, item } }));
      resolve({ turnId: params.operationId });
    }; });
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.draft.save') return { text: params.text, revision: (params.expectedRevision || 0) + 1 };
    if (method === 'chat.options') return { ...ui, loadState: 'ready' };
    if (method === 'chat.option.set') { ui = { ...ui, options: ui.options.map(option => option.id === params.optionId ? { ...option, value: params.value } : option) }; return ui; }
    if (method === 'chat.connection' || method === 'chat.connect') return { sessionId: params.sessionId, runtimeEpoch: 'e', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' };
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release' || method === 'chat.approve') return null;
    throw new Error('Unexpected QA request ' + method);
  },
};
const root = createRoot(document.getElementById('root'));
window.qaRender = (locale, theme, which) => { const target = which === 'send' ? sendSession : session; document.documentElement.dataset.theme = theme; root.render(React.createElement(I18nProvider, { locale, key: locale + target.id }, React.createElement(ChatView, { session: target, key: locale + target.id }))); };
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root>*{height:100%}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:820,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const expected = {
  'zh-CN': { mode: '默认', think: '高', buttons: ['允许一次', '在此项目中始终允许', '拒绝'], scopes: ['仅本次', '始终', '仅本次'], modes: ['默认', '接受编辑', '规划', '不问', '自动'], thinks: ['低', '中', '高', '超高', 'Max'], plan: '规划' },
  en: { mode: 'Default', think: 'High', buttons: ['Allow once', 'Always allow in this project', 'Deny'], scopes: ['This time', 'Always', 'This time'], modes: ['Default', 'Accept edits', 'Plan', "Don't ask", 'Auto'], thinks: ['Low', 'Medium', 'High', 'Extra high', 'Max'], plan: 'Plan' },
};
const checks = [];
// DOM events instead of OS input: a background Electron window may never
// acknowledge synthetic mouse input. React handles both the same way.
const press = locator => locator.evaluate(element => element.click());
const escape = page => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
const type = (locator, value) => locator.evaluate((element, text) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaRender);
  for (const [locale, want] of Object.entries(expected)) {
    const theme = locale === 'en' ? 'dark' : 'light';
    await page.evaluate(([value, colors]) => window.qaRender(value, colors), [locale, theme]);
    await page.locator('.chat-mode-chip').waitFor();
    await page.locator('.chat-approval-card').waitFor();
    assert.equal((await page.locator('.chat-mode-chip span').innerText()).trim(), want.mode);
    assert.equal((await page.locator('.chat-model-name').innerText()).trim(), 'Default (recommended)');
    assert.equal((await page.locator('.chat-model-think').innerText()).trim(), want.think);
    const buttons = page.locator('.chat-approval-choice');
    assert.deepEqual((await buttons.locator('span').allInnerTexts()).map(text => text.trim()), want.buttons);
    assert.deepEqual((await buttons.locator('small').allInnerTexts()).map(text => text.trim()), want.scopes);
    assert.ok(await buttons.nth(1).isEnabled(), 'Always allow is actionable');
    await page.screenshot({ path: join(out, `claude-options-${locale}.png`) });

    await press(page.locator('.chat-mode-chip'));
    await page.locator('.chat-menu-mode').waitFor();
    assert.deepEqual((await page.locator('.chat-menu-mode .chat-menu-item span').allInnerTexts()).map(text => text.trim()), want.modes);
    await page.screenshot({ path: join(out, `claude-mode-menu-${locale}.png`) });
    await escape(page);

    await press(page.locator('.chat-model-chip'));
    await page.locator('.chat-menu-model').waitFor();
    const rows = (await page.locator('.chat-menu-model .chat-menu-item span').allInnerTexts()).map(text => text.trim());
    assert.deepEqual(rows.slice(0, 4), ['Default (recommended)', 'Sonnet', 'Opus', 'Haiku']);
    assert.deepEqual(rows.slice(4), want.thinks);
    await page.screenshot({ path: join(out, `claude-model-menu-${locale}.png`) });
    await escape(page);

    await type(page.locator('textarea'), '/');
    await page.locator('.chat-slash').waitFor();
    // ChatView adds its own /stop while a turn is live (this fixture is waiting on approval).
    assert.deepEqual((await page.locator('.chat-slash b').allInnerTexts()).map(text => text.trim()), ['/stop', '/compact', '/context', '/tt-probe-skill']);
    await page.screenshot({ path: join(out, `claude-slash-${locale}.png`) });
    await type(page.locator('textarea'), '');

    await press(page.locator('.chat-mode-chip'));
    await press(page.locator('.chat-menu-mode .chat-menu-item', { hasText: want.plan }));
    await page.waitForFunction(text => document.querySelector('.chat-mode-chip span')?.textContent?.trim() === text, want.plan);
    const set = await page.evaluate(() => window.qaRequests.filter(request => request.method === 'chat.option.set').at(-1).params);
    assert.equal(set.optionId, 'mode');
    assert.equal(set.value, 'plan');
    await page.evaluate(() => window.threadterm.request('chat.option.set', { optionId: 'mode', value: 'default' }));
    checks.push(`${locale}: chips, approval labels/scopes, mode/model menus, slash menu, mode switch -> chat.option.set`);
  }
  // The message being sent must look exactly like the saved message that replaces it.
  await page.evaluate(() => window.qaRender('en', 'light', 'send'));
  await page.waitForFunction(() => {
    const input = document.querySelector('.chat-compose-shell textarea');
    return input instanceof HTMLTextAreaElement && !input.disabled && !input.closest('[inert]');
  });
  await page.waitForTimeout(300);
  await type(page.locator('.chat-compose-shell textarea'), 'say again');
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  const look = locator => locator.evaluate(element => { const style = getComputedStyle(element); return { fontSize: style.fontSize, padding: style.padding, background: style.backgroundColor, radius: style.borderRadius }; });
  const pending = page.locator('.chat-pending-submission');
  await pending.waitFor();
  const before = await look(pending);
  await page.screenshot({ path: join(out, 'claude-send-pending.png') });
  await page.evaluate(() => window.qaReleaseSend());
  await pending.waitFor({ state: 'detached' });
  const after = await look(page.locator('.v3-chat-message.user', { hasText: 'say again' }));
  await page.screenshot({ path: join(out, 'claude-send-saved.png') });
  assert.deepEqual(before, after, 'the pending bubble must not change its look when the message is saved');
  checks.push(`send: pending and saved bubbles share ${JSON.stringify(after)}`);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, checks, shots: out }, null, 2));
} finally {
  await app?.close();
}
