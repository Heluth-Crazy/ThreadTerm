// Isolated ChatView fixture for Codex pending-submission presentation. It never starts a runtime or Codex process.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-send-presentation-'));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

let current = { id: 'codex-qa-a', locale: 'en', theme: 'light', status: 'idle', updatedAt: 'initial' };
const drafts = new Map();
const items = new Map();
const listeners = new Set();
const controls = { deferDraft: false, rejectDraft: false, rejectCleanup: false, deferSend: false, rejectSend: false };
const deferred = { draft: [], send: [] };
let sequence = 0;
window.qaSendCount = 0;
window.qaLastSend = undefined;
const connection = sessionId => ({ sessionId, runtimeEpoch: 'qa', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' });
const emit = (sessionId, item) => listeners.forEach(listener => listener({ event: 'chat.item', seq: ++sequence, epoch: 'qa', data: { sessionId, item } }));
const later = (kind, params, accept) => new Promise((resolve, reject) => deferred[kind].push({ params, resolve, reject, accept }));
window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    if (method === 'chat.snapshot') return { items: items.get(params.sessionId) || [], revision: 0 };
    if (method === 'chat.draft.read') return { text: drafts.get(params.sessionId) || '', revision: 0 };
    if (method === 'chat.draft.save') {
      const accept = () => { drafts.set(params.sessionId, params.text); return { revision: 1 }; };
      if (controls.rejectDraft) { controls.rejectDraft = false; throw new Error('QA draft save rejection'); }
      if (controls.rejectCleanup && params.text === '') { controls.rejectCleanup = false; throw new Error('QA accepted-send draft cleanup rejection'); }
      if (controls.deferDraft) { controls.deferDraft = false; return later('draft', params, accept); }
      return accept();
    }
    if (method === 'chat.connection' || method === 'chat.connect') return connection(params.sessionId);
    if (method === 'chat.options') return { options: [], commands: [], inputCapabilities: { images: true }, loadState: 'ready' };
    if (method === 'chat.send') {
      window.qaSendCount++;
      window.qaLastSend = params;
      const accept = () => ({ turnId: params.operationId });
      if (controls.rejectSend) { controls.rejectSend = false; throw new Error('QA send rejection'); }
      if (controls.deferSend) { controls.deferSend = false; return later('send', params, accept); }
      return accept();
    }
    if (method === 'session.claim' || method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release' || method === 'chat.cancel') return null;
    throw new Error('Unexpected fixture request: ' + method);
  },
};
const root = createRoot(document.getElementById('root'));
const render = () => {
  document.documentElement.lang = current.locale;
  document.documentElement.dataset.theme = current.theme;
  root.render(React.createElement(I18nProvider, { locale: current.locale }, React.createElement(ChatView, { session: { id: current.id, provider: 'codex', mode: 'chat', status: current.status, title: 'Codex send presentation QA', createdAt: 'now', updatedAt: current.updatedAt } })));
};
window.qaRender = next => { current = { ...current, ...next, updatedAt: next.updatedAt || ('render-' + (++sequence)) }; render(); };
window.qaControl = next => Object.assign(controls, next);
window.qaResolve = kind => { const next = deferred[kind].shift(); if (!next) throw new Error('No deferred ' + kind); next.resolve(next.accept()); };
window.qaReject = kind => { const next = deferred[kind].shift(); if (!next) throw new Error('No deferred ' + kind); next.reject(new Error('QA deferred ' + kind + ' rejection')); };
window.qaEmitCanonical = () => {
  const sent = window.qaLastSend;
  if (!sent) throw new Error('No send to canonicalize');
  const item = { id: 'user-' + (++sequence), role: 'user', turnId: sent.operationId, createdAt: 'now', parts: [{ type: 'text', text: sent.text, data: sent.images?.length ? { images: sent.images } : undefined }] };
  items.set(sent.sessionId, [...(items.get(sent.sessionId) || []), item]); emit(sent.sessionId, item);
};
window.qaEmitAssistant = () => {
  const sent = window.qaLastSend;
  if (!sent) throw new Error('No send to answer');
  const item = { id: 'assistant-' + (++sequence), role: 'assistant', turnId: sent.operationId, createdAt: 'now', parts: [{ type: 'text', text: 'Assistant arrived before acknowledgement.' }] };
  items.set(sent.sessionId, [...(items.get(sent.sessionId) || []), item]); emit(sent.sessionId, item);
};
window.qaRender({});
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  const textarea = page.locator('.chat-compose-shell textarea');
  const pending = page.locator('.chat-pending-submission');
  const pendingStatus = page.locator('.chat-first-response-wait');
  const ready = async () => {
    await textarea.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const input = document.querySelector('.chat-compose-shell textarea');
      return input instanceof HTMLTextAreaElement && !input.disabled && !input.closest('[inert]');
    });
    // ChatView applies its initial draft/connection snapshots in independent effects;
    // wait through one paint so an older mount cannot briefly satisfy the predicate.
    await page.waitForTimeout(250);
    await page.waitForFunction(() => {
      const input = document.querySelector('.chat-compose-shell textarea');
      return input instanceof HTMLTextAreaElement && !input.disabled && !input.closest('[inert]') && input.getClientRects().length > 0;
    });
  };
  const pasteImage = async () => {
    await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 10;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#e53935'; context.fillRect(0, 0, 10, 10); context.fillStyle = '#1e88e5'; context.fillRect(10, 0, 10, 10);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG creation failed');
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    const input = document.querySelector('.chat-compose-shell textarea');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer unavailable');
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
    });
    await page.locator('.chat-image-draft img').waitFor({ timeout: 2_000 });
  };
  const writeText = async value => {
    await page.evaluate(text => {
      const input = document.querySelector('.chat-compose-shell textarea');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer unavailable');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.waitForFunction(expected => {
      const input = document.querySelector('.chat-compose-shell textarea');
      return input instanceof HTMLTextAreaElement && input.value === expected;
    }, value, { timeout: 2_000 });
  };
  const submitEnter = async () => {
    // Electron's fixture driver can block on a trusted key delivery even though the
    // input is visibly enabled. Dispatch the browser key event through ChatView's
    // real onKeyDown path; this intentionally does not call form.requestSubmit.
    const handled = await page.evaluate(() => {
      const input = document.querySelector('.chat-compose-shell textarea');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer unavailable');
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event.defaultPrevented;
    });
    assert.equal(handled, true, 'Enter key event was not handled by the composer');
  };
  const assertPending = async ({ text, images }) => {
    await pending.waitFor({ state: 'visible' });
    if (text) assert.match(await pending.innerText(), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await pending.locator('img').count(), images, 'pending image count');
    assert.equal(await textarea.inputValue(), '', 'pending submit visually empties the composer');
    assert.equal(await textarea.isDisabled(), true, 'pending submit disables the composer');
  };
  const dismissPending = async () => pending.waitFor({ state: 'detached' });
  const fresh = async id => { await page.evaluate(next => window.qaRender(next), { id, locale: 'en', theme: 'light' }); await ready(); };
  const mark = step => console.log(`Codex send presentation fixture: ${step}`);

  // Text-only: Enter creates a local item before the deferred draft write reaches the fixture transport.
  mark('text-only');
  await fresh('codex-text-only');
  await page.evaluate(() => window.qaControl({ deferDraft: true }));
  await writeText('text-only pending');
  await submitEnter();
  await assertPending({ text: 'text-only pending', images: 0 });
  assert.equal(await page.evaluate(() => window.qaSendCount), 0, 'Enter did not dispatch before the deferred draft write');
  await page.evaluate(() => window.qaResolve('draft'));
  await page.waitForFunction(() => window.qaSendCount === 1);
  await pendingStatus.waitFor();
  assert.match(await pendingStatus.innerText(), /Thinking/iu, 'accepted text-only submission changes Sending to Thinking');
  await page.evaluate(() => window.qaEmitCanonical());
  await dismissPending();
  assert.equal(await page.locator('.v3-chat-message.user').count(), 1, 'canonical text user item rendered once');

  // Image-only: native keyboard submission must be enabled without text and preserve the structured image locally.
  mark('image-only');
  await fresh('codex-image-only');
  await page.evaluate(() => window.qaControl({ deferSend: true }));
  await pasteImage();
  await page.locator('.chat-image-draft img').waitFor();
  await submitEnter();
  await assertPending({ images: 1 });
  assert.equal(await page.evaluate(() => window.qaSendCount), 2, 'image-only Enter dispatched exactly one native send');
  await pendingStatus.waitFor();
  assert.match(await pendingStatus.innerText(), /Sending/iu, 'deferred image-only send reports Sending');
  await page.evaluate(() => window.qaEmitCanonical());
  await dismissPending();
  assert.equal(await page.locator('.v3-chat-message.user').count(), 1, 'canonical image user item suppressed the duplicate local preview');
  await page.evaluate(() => window.qaResolve('send'));

  // Text plus image must display both parts before a delayed acknowledgement and retain canonical reconciliation.
  mark('text-plus-image');
  await fresh('codex-text-image');
  await page.evaluate(() => window.qaControl({ deferSend: true }));
  await writeText('text and image pending'); await pasteImage(); await submitEnter();
  await assertPending({ text: 'text and image pending', images: 1 });
  await page.evaluate(() => window.qaEmitCanonical());
  await dismissPending();
  await page.evaluate(() => window.qaResolve('send'));

  // Failures remove ephemeral UI and restore the unchanged text/image draft.
  mark('draft-rejection');
  await fresh('codex-draft-rejection');
  await page.evaluate(() => window.qaControl({ rejectDraft: true }));
  await writeText('draft failure recovery'); await pasteImage(); await submitEnter();
  await page.locator('.surface-error').waitFor(); await dismissPending();
  assert.equal(await textarea.inputValue(), 'draft failure recovery');
  assert.equal(await page.locator('.chat-image-draft img').count(), 1, 'draft failure restored image');

  mark('send-rejection'); await fresh('codex-send-rejection');
  await page.evaluate(() => window.qaControl({ rejectSend: true }));
  await writeText('send failure recovery'); await pasteImage(); await submitEnter();
  await page.locator('.surface-error').waitFor(); await dismissPending();
  assert.equal(await textarea.inputValue(), 'send failure recovery');
  assert.equal(await page.locator('.chat-image-draft img').count(), 1, 'send failure restored image');

  // An assistant event can arrive before the send acknowledgement without duplicating the local user preview.
  mark('assistant-before-ack');
  await fresh('codex-assistant-before-ack');
  await page.evaluate(() => window.qaControl({ deferSend: true }));
  await writeText('assistant before acknowledgement'); await submitEnter(); await assertPending({ text: 'assistant before acknowledgement', images: 0 });
  await page.evaluate(() => window.qaEmitAssistant());
  await page.locator('.v3-chat-message.assistant').waitFor();
  assert.equal(await pending.count(), 1, 'assistant-before-ack must not erase the pending user preview');
  await page.evaluate(() => window.qaEmitCanonical()); await dismissPending(); await page.evaluate(() => window.qaResolve('send'));

  // A late acknowledgement from another session cannot mutate the new session's composer or pending state.
  mark('session-switch');
  await fresh('codex-old-delayed');
  await page.evaluate(() => window.qaControl({ deferSend: true }));
  await writeText('old session delayed'); await submitEnter(); await assertPending({ text: 'old session delayed', images: 0 });
  await page.evaluate(() => window.qaRender({ id: 'codex-qa-b', locale: 'en', theme: 'light' })); await ready();
  await writeText('new session draft');
  await page.evaluate(() => window.qaResolve('send'));
  assert.equal(await textarea.inputValue(), 'new session draft', 'late old acknowledgement changed the new draft');
  assert.equal(await pending.count(), 0, 'late old acknowledgement created a new-session pending item');

  // A post-acceptance draft-cleanup failure is visible but cannot resurrect an
  // already-sent text/image payload in the cleared composer.
  mark('cleanup-rejection');
  await fresh('codex-cleanup-rejection');
  await writeText('accepted send cleanup failure'); await pasteImage();
  await page.evaluate(() => window.qaControl({ deferSend: true, rejectCleanup: true })); await submitEnter();
  await assertPending({ text: 'accepted send cleanup failure', images: 1 });
  await page.evaluate(() => window.qaEmitCanonical()); await dismissPending();
  await page.evaluate(() => window.qaResolve('send'));
  await page.locator('.surface-error').waitFor();
  assert.equal(await textarea.inputValue(), '', 'accepted send cleanup failure restored already-sent text');
  assert.equal(await page.locator('.chat-image-draft').count(), 0, 'accepted send cleanup failure restored already-sent image');

  // Keep a text+image local preview on screen while recording all requested locale/theme/width visual states.
  mark('visual-captures');
  await fresh('codex-visual-pending');
  await writeText('visual pending'); await pasteImage(); await page.evaluate(() => window.qaControl({ deferSend: true })); await submitEnter(); await assertPending({ text: 'visual pending', images: 1 });
  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 1440, 1920]) {
    await page.evaluate(next => window.qaRender(next), { id: 'codex-visual-pending', locale, theme });
    await pending.waitFor({ state: 'visible' });
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(scratch, `pending-${locale}-${theme}-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => window.qaResolve('send'));
  console.log('Codex send presentation fixture passed', JSON.stringify({ scratch }));
} finally {
  await app?.close();
}
