// Isolated production-ChatView QA for the context ring and connection chip
// (C3). It bundles the renderer with a deterministic in-memory bridge and never
// starts a runtime, provider, account or user profile. Scenarios cover the ring
// at 0 %, 45 %, 75 % and 95 %, a tokens-only snapshot, every connection phase,
// and the generic details slot lane 2 will use. Screenshots cover 420/700/1100
// px, light and dark, en and zh-CN, plus a custom theme; every cell asserts a
// single-line composer and zero visual-consistency violations.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-composer-status-'));
const out = resolve('qa/results/chat-parity/C3/composer-status');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { ChatConnectionChip } from './renderer/src/components/ChatConnectionChip';
import { AgentIconsProvider } from './renderer/src/components/PrototypeIcon';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const providers = [{ id: 'codex', name: 'Codex', version: '0.161.0', installed: true, terminal: true, chat: true, history: true, resume: true }];
const USAGE = {
  zero: { usedTokens: 0, windowTokens: 200000, percent: 0 },
  low: { usedTokens: 90000, windowTokens: 200000, percent: 45, inputTokens: 80000, outputTokens: 10000, cacheReadTokens: 60000, cacheWriteTokens: 5000, totalTokens: 90000 },
  warn: { usedTokens: 150000, windowTokens: 200000, percent: 75, inputTokens: 140000, outputTokens: 10000, cacheReadTokens: 90000, totalTokens: 150000 },
  danger: { usedTokens: 190000, windowTokens: 200000, percent: 95, inputTokens: 180000, outputTokens: 10000, totalTokens: 190000 },
  tokens: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
  usedOnly: { usedTokens: 1200 },
  empty: undefined,
};
const CHAT_OPTIONS = { loadState: 'ready', commands: [], options: [
  { id: 'model', name: 'Model', category: 'model', value: 'openai/qa-model', choices: [{ value: 'openai/qa-model', name: 'GPT QA Model' }] },
  { id: 'thinking', name: 'Thinking', category: 'thinking', value: 'medium', choices: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  { id: 'mode', name: 'Approval policy', category: 'mode', value: 'on-request', choices: [{ value: 'on-request', name: 'Ask as needed' }, { value: 'never', name: 'Never ask' }] },
  { id: 'fast', name: 'Fast mode', category: 'other', kind: 'boolean', value: 'false', choices: [{ value: 'true', name: 'On' }, { value: 'false', name: 'Off' }] },
] };
const listeners = new Set();
let sequence = 1, sessionId = 'status-1', locale = 'en', state = { usage: USAGE.low, phase: 'ready', transportDown: false, busy: false };
window.threadterm = {
  onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  request: async (method, params) => {
    if (method === 'session.claim') return { leaseEpoch: 1 };
    if (method === 'session.renew' || method === 'session.release') return {};
    if (method === 'chat.connection') return { sessionId, runtimeEpoch: 'epoch', connectionGeneration: 1, revision: 1, phase: state.phase, nativeId: 'native-' + sessionId, optionsLoadState: 'ready' };
    if (method === 'chat.connect') return { sessionId, runtimeEpoch: 'epoch', connectionGeneration: 1, revision: 5, phase: state.phase, nativeId: 'native-' + sessionId, optionsLoadState: 'ready' };
    if (method === 'chat.context.read') return state.usage ?? null;
    if (method === 'chat.snapshot') return { items: [{ id: sessionId + ':assistant:base', role: 'assistant', parts: [{ type: 'text', text: 'Ready', status: 'done' }], createdAt: 'now', turnId: 'turn-0' }, ...(state.busy ? [{ id: sessionId + ':assistant:turn', role: 'assistant', parts: [{ type: 'text', text: 'Working on it', status: 'streaming' }], createdAt: 'now', turnId: 'turn-1' }] : [])], revision: 1 };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.queue.read') return { sessionId, paused: false, items: [] };
    if (method === 'chat.options') return CHAT_OPTIONS;
    throw Error('Unexpected QA request ' + method);
  },
};
window.qaEmit = (event, data) => { for (const listener of listeners) listener({ v: 1, event, epoch: 'epoch', seq: 1, data }); };
const root = createRoot(document.getElementById('root'));
window.qaRender = (nextLocale, nextUsage, nextPhase, nextBusy) => {
  locale = nextLocale;
  state = { usage: USAGE[nextUsage], phase: nextPhase === 'offline' ? 'ready' : nextPhase, transportDown: nextPhase === 'offline', busy: Boolean(nextBusy) };
  const phase = state.phase;
  sessionId = 'status-' + nextLocale + '-' + nextUsage + '-' + nextPhase + '-' + (sequence++);
  window.qaSessionId = sessionId;
  return root.render(<I18nProvider locale={locale}><AgentIconsProvider providers={providers}><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView key={sessionId} session={{ id: sessionId, provider: 'codex', mode: 'chat', status: state.busy ? 'running' : 'idle', readOnly: false, title: 'Status QA', createdAt: 'now', updatedAt: 'now', worktreePath: 'D:/workspace/ThreadTerm' }} /></SessionSurfaceContext.Provider></AgentIconsProvider></I18nProvider>);
};
window.qaEmitContext = usage => { state.usage = usage; window.qaEmit('chat.context', { sessionId, usage }); };
window.qaSlot = () => {
  const slot = createRoot(document.getElementById('slot'));
  slot.render(<I18nProvider locale="en"><ChatConnectionChip phase="ready" providerName="Pi" providerVersion="1.1.0" cwd="D:/repo" nativeId="pi-native" copy={(en) => en}><div data-slot-marker="pi-trust">Project trust: trusted</div></ChatConnectionChip></I18nProvider>);
};
window.qaTheme = theme => {
  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(custom)) style.setProperty('--custom-' + key, value);
  document.documentElement.dataset.theme = theme === 'custom' ? 'dark' : theme;
  document.documentElement.dataset.customTheme = theme === 'custom' ? 'true' : 'false';
};
document.documentElement.dataset.theme = 'light';
window.qaSlot();
window.qaRender('en', 'low', 'ready');
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}#slot{display:none;position:fixed;left:0;top:0;z-index:50;background:var(--surface)}</style><div id="root"></div><div id="slot"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';');

const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
let app, page;
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.snapshots.push(name); }
async function setState({ theme = 'light', locale = 'en', width = 1280, usage = 'low', phase = 'ready', busy = false } = {}) {
  await page.evaluate(([nextLocale, nextUsage, nextPhase, nextBusy]) => window.qaRender(nextLocale, nextUsage, nextPhase, nextBusy), [locale, usage, phase, busy]);
  await page.evaluate(value => window.qaTheme(value), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="session-chat-' + window.qaSessionId + '"] .chat-compose-shell textarea')));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (phase === 'offline') await page.evaluate(() => window.qaEmit('runtime.transport', { state: 'disconnected' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function composerLayout() {
  return page.locator('.chat-compose-bar').evaluate(bar => {
    const left = bar.querySelector('.chat-compose-left');
    const right = bar.querySelector('.chat-compose-right');
    const children = [...bar.querySelectorAll('.chat-compose-left > *, .chat-compose-right > *')].map(node => node.getBoundingClientRect());
    return {
      leftTop: left.getBoundingClientRect().top, rightTop: right.getBoundingClientRect().top,
      minTop: Math.min(...children.map(rect => rect.top)), maxTop: Math.max(...children.map(rect => rect.top)),
      scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, height: bar.getBoundingClientRect().height,
    };
  });
}
async function assertSingleLine(label) {
  const layout = await composerLayout();
  assert.ok(Math.abs(layout.leftTop - layout.rightTop) < 2, `${label}: groups sit on one line`);
  assert.ok(layout.maxTop - layout.minTop < 2, `${label}: controls do not wrap within a group`);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${label}: the bar does not overflow`);
  assert.ok(layout.height < 40, `${label}: the bar is a single row`);
}
// VC-COMPOSER-420: the model chip never collapses below eight readable characters.
async function assertModelReadable(label) {
  if (await page.locator('#root .chat-model-name').count() === 0) return;
  const info = await page.locator('#root .chat-model-name').evaluate(node => ({
    clientWidth: node.clientWidth, text: (node.textContent ?? '').trim(),
  }));
  assert.ok(info.clientWidth >= 48, `${label}: the model name keeps 8 characters (${info.clientWidth}px of "${info.text}")`);
  assert.ok(info.text.length > 0, `${label}: the model chip is never hidden`);
}
// VC-COMPOSER-420: an empty composer never shows a vertical scrollbar from a wrapped placeholder.
async function assertEmptyTextareaNoScrollbar(label) {
  const info = await page.locator('#root .chat-compose-shell textarea').evaluate(node => ({
    scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, value: node.value,
  }));
  assert.equal(info.value, '', `${label}: the composer is empty`);
  assert.ok(info.scrollHeight <= info.clientHeight + 1, `${label}: the empty textarea has no vertical scrollbar (${info.scrollHeight} vs ${info.clientHeight})`);
}
async function openStatus(trigger) {
  const chip = page.locator(`#root [data-status-trigger="${trigger}"]`);
  await chip.click();
  await page.locator('#root .chat-status-menu').waitFor();
  await page.waitForFunction(() => document.querySelector('#root .chat-status-menu') === document.activeElement, null, { timeout: 3000 });
  const consistency = await checkControlConsistency(page, '#root .chat-status-menu');
  assertNoControlViolations(consistency, `${trigger} popover`);
  return page.locator('#root .chat-status-menu');
}
async function closeStatus(trigger) {
  const chip = page.locator(trigger ? `#root [data-status-trigger="${trigger}"]` : '#root [data-status-trigger][aria-expanded="true"]');
  const chipHandle = await chip.elementHandle();
  await page.keyboard.press('Escape');
  await page.locator('#root .chat-status-menu').waitFor({ state: 'detached' });
  await page.waitForFunction(element => element === document.activeElement, chipHandle);
}
async function assertDismissalPaths(trigger) {
  const chip = page.locator(`#root [data-status-trigger="${trigger}"]`);
  await openStatus(trigger);
  await closeStatus(trigger);

  await openStatus(trigger);
  await chip.click();
  await page.locator('#root .chat-status-menu').waitFor({ state: 'detached' });
  await page.waitForFunction(element => element === document.activeElement, await chip.elementHandle());

  await openStatus(trigger);
  await page.locator('#root .v3-chat-log').click({ position: { x: 10, y: 10 } });
  await page.locator('#root .chat-status-menu').waitFor({ state: 'detached' });
  await page.waitForFunction(element => element === document.activeElement, await chip.elementHandle());
}
async function assertMenuFits(label) {
  const box = await page.locator('#root .chat-status-menu').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
  });
  const viewport = page.viewportSize();
  assert.ok(box.left >= 0 && box.right <= viewport.width + 1, `${label}: the popover fits horizontally (${box.left}..${box.right} of ${viewport.width})`);
  assert.ok(box.top >= -1 && box.bottom <= viewport.height + 1, `${label}: the popover fits vertically`);
  return box;
}

try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  await page.evaluate(() => {
    let value = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { value = String(text); }, readText: async () => value } });
    window.__qaClipboard = { get: () => value };
  });

  // The ring reads the persisted snapshot on open, before any turn.
  await setState({ usage: 'low', phase: 'ready' });
  assert.equal(await page.locator('#root .chat-context-ring').count(), 1, 'one ring chip');
  assert.equal((await page.locator('#root .chat-context-percent').textContent()).trim(), '45%');
  assert.match(await page.locator('#root .chat-context-ring').getAttribute('aria-label'), /45%/);
  report.checks.push('the ring reads chat.context.read on open and shows the percent');

  // Live chat.context events update the ring.
  await page.evaluate(() => window.qaEmitContext({ usedTokens: 190000, windowTokens: 200000, percent: 95, inputTokens: 180000, outputTokens: 10000, cacheReadTokens: 120000, cacheWriteTokens: 0, totalTokens: 190000 }));
  await page.waitForFunction(() => document.querySelector('#root .chat-context-percent')?.textContent?.trim() === '95%');
  assert.equal(await page.locator('#root .chat-context-ring-fill').getAttribute('class'), 'chat-context-ring-fill is-danger');
  report.checks.push('a chat.context event updates the ring and its tier');

  // Ring popover: Used/Max, all known counters, the cache hit rate, hidden zeros.
  let menu = await openStatus('context');
  assert.match(await menu.innerText(), /190,000 \/ 200,000/);
  assert.match(await menu.innerText(), /95%/);
  assert.match(await menu.innerText(), /Input/);
  assert.match(await menu.innerText(), /Output/);
  assert.match(await menu.innerText(), /Cache read/);
  assert.match(await menu.innerText(), /Total/);
  assert.doesNotMatch(await menu.innerText(), /Cache write/, 'a zero cache-write row is hidden');
  await closeStatus();
  await setState({ usage: 'low', phase: 'ready' });
  menu = await openStatus('context');
  assert.match(await menu.innerText(), /Cache write/);
  assert.match(await menu.innerText(), /Cache hit rate/);
  assert.match(await menu.innerText(), /43%/, 'cache hit rate is cacheRead / (input + cacheRead)');
  await shot('ring-popover-low-light-en-1280.png');
  await closeStatus();
  report.checks.push('the ring popover lists Used/Max, token counters, a cache hit rate and hides zero rows');
  await assertDismissalPaths('context');
  report.checks.push('context popover closes with Escape, toggle and outside click, returning focus to its chip');

  // Tokens-only: no window, no Used/Max, neutral ring, still a popover.
  await setState({ usage: 'tokens', phase: 'ready' });
  assert.equal((await page.locator('#root .chat-context-tokens').textContent()).trim(), 'Tokens');
  assert.equal(await page.locator('#root .chat-context-percent').count(), 0);
  menu = await openStatus('context');
  assert.doesNotMatch(await menu.innerText(), /Used/);
  assert.match(await menu.innerText(), /Input/);
  await closeStatus();
  await setState({ usage: 'usedOnly', phase: 'ready' });
  assert.equal((await page.locator('#root .chat-context-tokens').textContent()).trim(), 'Tokens');
  menu = await openStatus('context');
  assert.match(await menu.innerText(), /Used tokens\s+1,200/);
  assert.doesNotMatch(await menu.innerText(), /Max/);
  await closeStatus();
  report.checks.push('a used-tokens-only snapshot shows its usage without inventing a window maximum');
  report.checks.push('a tokens-only snapshot shows a neutral ring without Used/Max');

  // 0 % still renders a ring and is not "no usage".
  for (const [usage, percent, tier] of [['zero', '0%', 'is-neutral'], ['low', '45%', 'is-neutral'], ['warn', '75%', 'is-warn'], ['danger', '95%', 'is-danger']]) {
    await setState({ usage, phase: 'ready' });
    assert.equal(await page.locator('#root .chat-context-ring').count(), 1, `${percent} renders a ring`);
    assert.equal((await page.locator('#root .chat-context-percent').textContent()).trim(), percent);
    assert.ok((await page.locator('#root .chat-context-ring-fill').getAttribute('class')).includes(tier), `${percent} has ${tier} tone`);
  }
  report.checks.push('0 % is a real snapshot, not an empty state');

  // No usage at all: no ring. Connection chip stays.
  await setState({ usage: 'empty', phase: 'ready' });
  assert.equal(await page.locator('#root .chat-context-ring').count(), 0);
  assert.equal(await page.locator('#root .chat-connection-chip').count(), 1);
  report.checks.push('no usage renders no ring');

  // Connection chip: every phase has a label, and the dot is never the only signal.
  for (const [phase, label] of [['ready', 'Connected'], ['connecting', 'Connecting'], ['failed', 'Error'], ['disconnected', 'Disconnected'], ['unavailable', 'Unavailable'], ['offline', 'Connected']]) {
    await setState({ usage: 'low', phase });
    const chip = page.locator('#root .chat-connection-chip');
    assert.equal(await chip.isVisible(), true, `phase ${phase}: the chip remains visible over the connection overlay`);
    const text = (await page.locator('#root .chat-connection-label').textContent()).trim();
    assert.equal(text, label, `phase ${phase} reads "${label}"`);
    if (phase === 'offline') assert.match(`${await chip.getAttribute('aria-label')} ${await chip.getAttribute('title')}`, /Offline/, 'transport loss is announced accessibly while preserving the connection phase');
  }
  report.checks.push('every connection phase has a short label; the dot is never the only signal');

  // Connection popover: cwd, native id, provider + version, reconnect; disabled mid-turn.
  await setState({ usage: 'low', phase: 'ready' });
  menu = await openStatus('connection');
  assert.match(await menu.innerText(), /D:\/workspace\/ThreadTerm/);
  assert.match(await menu.innerText(), /native-status-/);
  assert.match(await menu.innerText(), /Codex 0\.161\.0/);
  assert.match(await menu.innerText(), /Reconnect/);
  assert.equal(await menu.locator('.chat-status-reconnect').isDisabled(), false);
  const copyButtons = menu.locator('.chat-status-copy');
  assert.equal(await copyButtons.count(), 2);
  assert.equal(await copyButtons.nth(0).getAttribute('aria-label'), 'Copy Working directory');
  assert.equal(await copyButtons.nth(1).getAttribute('aria-label'), 'Copy Provider session');
  await copyButtons.first().click();
  await page.waitForFunction(() => document.querySelector('.chat-status-copy')?.textContent?.trim() === 'Copied');
  assert.equal(await page.evaluate(() => window.__qaClipboard.get()), 'D:/workspace/ThreadTerm', 'Copy writes only into the in-page QA clipboard');
  await shot('connection-popover-ready-light-en-1280.png');
  await closeStatus();
  report.checks.push('the connection popover shows cwd, session id, provider + version, and a working Copy');
  await assertDismissalPaths('connection');
  report.checks.push('connection popover closes with Escape, toggle and outside click, returning focus to its chip');

  // A running turn disables Reconnect with the warning text.
  await setState({ usage: 'low', phase: 'ready', busy: true });
  menu = await openStatus('connection');
  assert.equal(await menu.locator('.chat-status-reconnect').isDisabled(), true, 'Reconnect is disabled while a turn runs');
  assert.match(await menu.innerText(), /Reconnecting interrupts the current turn/);
  await closeStatus('connection');
  await assertDismissalPaths('connection');
  await assertDismissalPaths('context');
  report.checks.push('a running turn disables Reconnect and both status popovers retain all dismissal and focus-return paths');

  // Representative Codex chips use the real mode, model + thinking, and extra-option groups.
  await setState({ usage: 'low', phase: 'ready', width: 1100 });
  assert.equal(await page.locator('#root .chat-mode-chip').count(), 1);
  assert.equal(await page.locator('#root .chat-model-chip').count(), 1);
  assert.match(await page.locator('#root .chat-model-chip').innerText(), /GPT QA Model/);
  assert.match(await page.locator('#root .chat-model-chip').innerText(), /Medium/);
  assert.equal(await page.locator('#root .chat-compose-left > .chat-compose-anchor > .chat-option-chip[data-option-id="fast"]').count(), 1);
  await assertSingleLine('Codex mode/model/thinking/extra chips at 1100');
  report.checks.push('Codex mode, model + thinking, and a Fast mode option render together on one row');

  // During a live turn, the row must also retain Stop and Queue at the narrow width.
  await setState({ usage: 'low', phase: 'ready', width: 420, busy: true });
  assert.equal(await page.locator('#root .chat-compose-send.is-stop').count(), 1);
  assert.equal(await page.locator('#root .chat-compose-send.is-queue').count(), 1);
  await assertSingleLine('running turn Stop/Queue at 420');
  await assertModelReadable('running turn Stop/Queue at 420');
  await assertEmptyTextareaNoScrollbar('running turn Stop/Queue at 420');
  const runningConsistency = await checkControlConsistency(page, '.chat-compose-shell');
  if (runningConsistency.violations.length) {
    const dbgControls = await page.evaluate(() => [...document.querySelectorAll('.chat-compose-shell button, .chat-compose-shell [role=button], .chat-compose-shell .chip')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map(el => ({
      cls: typeof el.className === 'string' ? el.className : '',
      aria: (el.getAttribute('aria-label') || '').slice(0, 28),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16),
      fs: getComputedStyle(el).fontSize,
      h: el.getBoundingClientRect().height,
      iconOnly: (el.textContent || '').replace(/\s+/g, ' ').trim().length === 0,
    })));
    console.log('DEBUG running-420 controls', JSON.stringify(dbgControls, null, 1));
    console.log('DEBUG running-420 violations', JSON.stringify(runningConsistency.violations, null, 1));
  }
  assertNoControlViolations(runningConsistency, 'running 420 composer');
  await shot('composer-status-running-light-en-420.png');
  report.checks.push('the 420 px composer fits Stop and Queue during a running turn');

  // The generic details slot renders under the session facts (lane 2 integration).
  await page.evaluate(() => { const slot = document.getElementById('slot'); if (slot) slot.style.display = 'block'; });
  await page.locator('#slot [data-status-trigger="connection"]').click();
  await page.locator('#slot .chat-status-menu').waitFor();
  assert.equal(await page.locator('#slot [data-slot-marker="pi-trust"]').count(), 1, 'the details slot renders under the session facts');
  assertNoControlViolations(await checkControlConsistency(page, '#slot .chat-status-menu'), 'generic details slot');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const slot = document.getElementById('slot'); if (slot) slot.style.display = 'none'; });
  report.checks.push('the connection popover renders a generic children/details slot for lane 2');

  // Popovers fit at 420 px for both ends of the usage range.
  for (const usage of ['zero', 'danger', 'tokens', 'usedOnly']) {
    await setState({ usage, phase: 'ready', width: 420 });
    await openStatus('context');
    const box = await assertMenuFits(`ring/${usage}/420`);
    assert.ok(box.width <= 420, `ring/${usage}/420: the popover is at most the viewport width`);
    await shot(`ring-popover-${usage}-light-en-420.png`);
    await closeStatus();
  }
  await setState({ usage: 'low', phase: 'ready', width: 420 });
  await openStatus('connection');
  await assertMenuFits('connection/420');
  await shot('connection-popover-ready-light-en-420.png');
  await closeStatus();
  report.checks.push('both popovers fit at 420 px');

  // Compact matrix (C2 scale): every usage and phase at 420/1100, then the
  // locale/theme/width grid on the representative low/ready state. A full
  // usage×phase×theme×locale×width cross product remounts Electron hundreds
  // of times and closes the page before the assertions finish.
  async function captureComposer({ usage, phase, theme, locale, width, name }) {
    await setState({ usage, phase, theme, locale, width });
    await assertSingleLine(name);
    await assertModelReadable(name);
    await assertEmptyTextareaNoScrollbar(name);
    assertNoControlViolations(await checkControlConsistency(page, '.chat-compose-shell'), `${name} composer`);
    await shot(`${name}.png`);
  }
  for (const usage of ['zero', 'low', 'warn', 'danger', 'tokens', 'usedOnly', 'empty']) {
    for (const width of [420, 1100]) {
      await captureComposer({ usage, phase: 'ready', theme: 'light', locale: 'en', width, name: `composer-status-${usage}-light-en-${width}` });
    }
  }
  for (const phase of ['ready', 'connecting', 'failed', 'disconnected', 'unavailable', 'offline']) {
    for (const width of [420, 1100]) {
      await captureComposer({ usage: 'low', phase, theme: 'light', locale: 'en', width, name: `composer-status-low-${phase}-light-en-${width}` });
    }
  }
  for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'zh-CN']) {
      for (const width of [420, 700, 1100]) {
        await captureComposer({ usage: 'low', phase: 'ready', theme, locale, width, name: `composer-status-low-ready-${theme}-${locale}-${width}` });
      }
    }
  }
  for (const width of [420, 1100]) {
    await captureComposer({ usage: 'low', phase: 'ready', theme: 'custom', locale: 'en', width, name: `composer-status-custom-en-${width}` });
  }
  report.checks.push('420/1100 cover every usage and connection phase; 420/700/1100 × light/dark × en/zh-CN cover the representative low/ready row with zero violations');
  report.checks.push('the custom theme remaps the tokens at 420 and 1100 with zero violations');

  for (const usage of ['zero', 'low', 'warn', 'danger', 'tokens', 'usedOnly']) {
    await setState({ usage, phase: 'ready', theme: 'dark', width: 1100 });
    await assertSingleLine(`dark/${usage}/1100`);
    assertNoControlViolations(await checkControlConsistency(page, '.chat-compose-shell'), `dark/${usage}/1100 composer`);
    await shot(`composer-status-${usage}-dark-en-1100.png`);
  }
  for (const [usage, trigger] of [['danger', 'context'], ['low', 'connection']]) {
    await setState({ usage, phase: 'ready', theme: 'light', locale: 'zh-CN', width: 420 });
    await openStatus(trigger);
    await assertMenuFits(`${trigger}/zh-CN/420`);
    await shot(`composer-status-${trigger}-zh-CN-420.png`);
    await closeStatus();
  }
  for (const locale of ['en', 'zh-CN']) {
    await setState({ usage: 'danger', phase: 'ready', theme: 'custom', locale, width: 420 });
    await openStatus('connection');
    await assertMenuFits(`connection/custom/${locale}/420`);
    await shot(`composer-status-connection-custom-${locale}-420.png`);
    await closeStatus();
  }

  assert.deepEqual(report.errors, [], 'the fixture has no renderer page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'COMPOSER STATUS VISUAL QA PASSED' : 'COMPOSER STATUS VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
