// Isolated production-ChatView QA for the composer option chips (C2). It
// bundles the renderer with a deterministic in-memory bridge and never starts
// a runtime, provider, account or user profile. Scenarios cover fake Codex,
// Claude, Pi, an ACP agent with extra config options, the loading state and a
// 120-model catalog (virtualized). Screenshots cover 420/700/1100 px, light and
// dark, en and zh-CN, plus a custom theme; every cell asserts a single-line row.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-composer-options-'));
const out = resolve('qa/results/chat-parity/C2/composer-options');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const choice = (value, name, extra) => ({ value, name, ...(extra || {}) });
const booleanChoices = () => [choice('true', 'On'), choice('false', 'Off')];
const modelChoices = (count, grouped) => {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const group = grouped ? (index % 2 === 0 ? 'openai' : 'anthropic') : undefined;
    list.push(choice((group ? group + '/' : '') + 'model-' + index, (group === 'anthropic' ? 'Claude' : 'GPT') + ' Model ' + index, { ...(group ? { group } : {}), ...(index === 0 ? { recommended: true, description: 'The agent suggests this model.' } : {}) }));
  }
  return list;
};
const thinking = () => ({ id: 'thinking', name: 'Thinking', category: 'thinking', value: 'medium', choices: [choice('low', 'Low'), choice('medium', 'Medium', { recommended: true }), choice('high', 'High')] });
const SCENARIOS = {
  codex: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'openai/model-0', choices: modelChoices(12, true) },
    thinking(),
    { id: 'collaboration', name: 'Collaboration', category: 'other', value: 'default', choices: [choice('default', 'Default'), choice('plan', 'Plan')] },
    { id: 'mode', name: 'Approval policy', category: 'mode', value: 'on-request', choices: [choice('on-request', 'Ask as needed'), choice('never', 'Never ask')] },
    { id: 'sandbox', name: 'Sandbox', category: 'other', value: 'workspace-write', description: 'What the agent may touch.', choices: [choice('read-only', 'Read only'), choice('workspace-write', 'Workspace write'), choice('danger-full-access', 'Full access')] },
    { id: 'fast', name: 'Fast mode', category: 'other', kind: 'boolean', value: 'false', choices: booleanChoices() },
    { id: 'reviewer', name: 'Approval reviewer', category: 'other', value: 'user', choices: [choice('user', 'User'), choice('auto_review', 'Auto review', { recommended: true }), choice('guardian_subagent', 'Guardian subagent')] },
  ] }),
  claude: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'claude-sonnet', choices: [choice('claude-sonnet', 'Sonnet', { recommended: true }), choice('claude-opus', 'Opus')] },
    thinking(),
    { id: 'mode', name: 'Permission mode', category: 'mode', value: 'acceptEdits', choices: [choice('default', 'Default'), choice('acceptEdits', 'Accept edits'), choice('bypassPermissions', 'Bypass')] },
  ] }),
  pi: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'pi-model', choices: [choice('pi-model', 'Pi Model'), choice('pi-mini', 'Pi Mini')] },
    thinking(),
    { id: 'auto-compaction', name: 'Auto-compaction', category: 'other', kind: 'boolean', value: 'true', choices: booleanChoices() },
    { id: 'auto-retry', name: 'Auto-retry', category: 'other', kind: 'boolean', value: 'false', choices: booleanChoices() },
    { id: 'steering', name: 'Steering mode', category: 'other', value: 'all', choices: [choice('all', 'All'), choice('one-at-a-time', 'One at a time')] },
    { id: 'follow-up', name: 'Follow-up mode', category: 'other', value: 'one-at-a-time', choices: [choice('all', 'All'), choice('one-at-a-time', 'One at a time')] },
  ] }),
  acp: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'kimi/k2', choices: [choice('kimi/k2', 'Kimi K2', { group: 'kimi', recommended: true, description: 'Fast default.' }), choice('moonshot/k2', 'Moonshot K2', { group: 'moonshot' })] },
    thinking(),
    { id: 'mode', name: 'Mode', category: 'mode', value: 'agent', choices: [choice('agent', 'Agent'), choice('plan', 'Plan')] },
    { id: 'context', name: 'Context window', category: 'other', value: 'standard', description: 'How much history the agent keeps.', choices: [choice('standard', 'Standard'), choice('large', 'Large'), choice('max', 'Maximum')] },
    { id: 'web', name: 'Web search', category: 'other', kind: 'boolean', value: 'true', choices: booleanChoices() },
    { id: 'temperature', name: 'Temperature', category: 'other', value: 'balanced', choices: [choice('precise', 'Precise', { description: 'Lower variance.' }), choice('balanced', 'Balanced'), choice('creative', 'Creative')] },
  ] }),
  loading: () => ({ loadState: 'loading', commands: [], options: [] }),
  many: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'openai/model-0', choices: modelChoices(120, true) },
    thinking(),
  ] }),
  customMode: () => ({ loadState: 'ready', commands: [], options: [
    { id: 'model', name: 'Model', category: 'model', value: 'one', choices: [choice('one', 'One'), choice('two', 'Two')] },
    { id: 'permission_mode', name: 'Permission mode', category: 'mode', value: 'default', choices: [choice('default', 'Default'), choice('plan', 'Plan')] },
  ] }),
};
const listeners = new Set();
let sequence = 1, state = SCENARIOS.codex(), sessionId = 'composer-en-codex-1', locale = 'en';
window.threadterm = {
  onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  request: async (method, params) => {
    if (method === 'session.claim') return { leaseEpoch: 1 };
    if (method === 'session.renew' || method === 'session.release') return {};
    if (method === 'chat.connection') return { sessionId, runtimeEpoch: 'epoch', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' };
    if (method === 'chat.snapshot') return { items: [], revision: 1 };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.queue.read') return { sessionId, paused: false, items: [] };
    if (method === 'chat.options') return state;
    if (method === 'chat.option.set') {
      window.__setCalls.push({ optionId: params.optionId, value: params.value });
      state = { ...state, options: state.options.map(option => option.id === params.optionId ? { ...option, value: params.value } : option) };
      return state;
    }
    throw Error('Unexpected QA request ' + method);
  },
};
const root = createRoot(document.getElementById('root'));
window.qaRender = (nextLocale, nextScenario) => {
  locale = nextLocale;
  state = SCENARIOS[nextScenario]();
  sessionId = 'composer-' + nextLocale + '-' + nextScenario + '-' + (sequence++);
  window.__setCalls = [];
  return root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{ primaryHost: null, menuHost: null, focused: true, openFile: () => {}, openDiff: () => {} }}><ChatView key={sessionId} session={{ id: sessionId, provider: 'codex', mode: 'chat', status: 'idle', readOnly: false, title: 'Composer QA', createdAt: 'now', updatedAt: 'now' }} /></SessionSurfaceContext.Provider></I18nProvider>);
};
window.qaTheme = theme => {
  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(custom)) style.setProperty('--custom-' + key, value);
  document.documentElement.dataset.theme = theme === 'custom' ? 'dark' : theme;
  document.documentElement.dataset.customTheme = theme === 'custom' ? 'true' : 'false';
};
document.documentElement.dataset.theme = 'light';
window.qaRender('en', 'codex');
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';');

const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
let app, page;
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.snapshots.push(name); }
async function setState({ theme = 'light', locale = 'en', width = 1280, scenario = 'codex' } = {}) {
  await page.evaluate(([nextLocale, nextScenario]) => window.qaRender(nextLocale, nextScenario), [locale, scenario]);
  await page.evaluate(value => window.qaTheme(value), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.locator('.chat-compose-shell textarea').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function rowLayout() {
  return page.locator('.chat-compose-bar').evaluate(bar => {
    const left = bar.querySelector('.chat-compose-left');
    const right = bar.querySelector('.chat-compose-right');
    const children = [...bar.querySelectorAll('.chat-compose-left > *, .chat-compose-right > *')].map(node => node.getBoundingClientRect());
    const tops = children.map(rect => rect.top);
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return {
      leftTop: leftRect.top, rightTop: rightRect.top,
      minTop: Math.min(...tops), maxTop: Math.max(...tops),
      height: bar.getBoundingClientRect().height,
      scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
      leftWidth: leftRect.width, rightWidth: rightRect.width,
    };
  });
}
async function activeDesc() {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!node || node === document.body) return { tag: 'body', text: '' };
    return {
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role'),
      trigger: node.getAttribute('data-menu-trigger'),
      optionId: node.getAttribute('data-option-id'),
      text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
      inMenu: Boolean(node.closest('.chat-compose-menu')),
      menu: node.closest('.chat-compose-menu')?.className || '',
      search: node.classList.contains('chat-menu-search'),
    };
  });
}
async function virtualGeometry() {
  return page.locator('.chat-menu-virtual').evaluate(scroller => {
    const rowHeight = parseFloat(getComputedStyle(scroller).getPropertyValue('--chat-menu-row-height'));
    const inner = scroller.querySelector('.chat-menu-virtual-inner');
    const win = scroller.querySelector('.chat-menu-virtual-window');
    const rows = [...win.children];
    const innerRect = inner.getBoundingClientRect();
    const heights = rows.map(node => node.getBoundingClientRect().height);
    const gaps = rows.slice(1).map((node, index) => node.getBoundingClientRect().top - rows[index].getBoundingClientRect().bottom);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(win).transform);
    const translateY = matrix.m42;
    const firstOffset = rows.length ? rows[0].getBoundingClientRect().top - innerRect.top : null;
    const lastOffset = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom - innerRect.top : null;
    return {
      rowHeight, heights, gaps, translateY, firstOffset, lastOffset,
      innerHeight: innerRect.height,
      itemCount: win.querySelectorAll('.chat-menu-item').length,
      headerCount: win.querySelectorAll('.chat-menu-group').length,
    };
  });
}
function assertVirtualAligned(geometry, label) {
  assert.equal(geometry.rowHeight, 28, `${label}: row slot is 28 px`);
  assert.ok(geometry.itemCount > 0, `${label}: the window renders at least one choice`);
  assert.ok(geometry.heights.length > 0, `${label}: the window is not empty`);
  for (const height of geometry.heights) assert.ok(Math.abs(height - 28) < 1, `${label}: a row rendered at ${height}px`);
  for (const gap of geometry.gaps) assert.ok(Math.abs(gap) < 1, `${label}: adjacent rows have a ${gap}px gap`);
  const remainder = Math.abs(geometry.translateY % 28);
  assert.ok(remainder < 1 || remainder > 27, `${label}: translateY ${geometry.translateY} is off the row grid`);
  assert.ok(Math.abs(geometry.firstOffset - geometry.translateY) < 1.5, `${label}: first row sits at ${geometry.firstOffset}, window at ${geometry.translateY}`);
}
async function assertSingleLine(label) {
  const layout = await rowLayout();
  assert.ok(Math.abs(layout.leftTop - layout.rightTop) < 2, `${label}: groups sit on one line (${layout.leftTop} vs ${layout.rightTop})`);
  assert.ok(layout.maxTop - layout.minTop < 2, `${label}: controls do not wrap within a group`);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${label}: the bar does not overflow (${layout.scrollWidth} > ${layout.clientWidth})`);
  assert.ok(layout.height < 40, `${label}: the bar is a single row (${layout.height})`);
  return layout;
}

try {
  // Pin the device scale factor so the focus-ring assertion below measures the
  // authored `outline: 2px` in CSS pixels. On a display at 125 % Chromium snaps
  // the outline to whole device pixels, so getComputedStyle() reports 1.6 px and
  // the check depends on which monitor the window lands on. This is the only
  // isolated harness that reads an outline width numerically, so it is the only
  // one that needs the ring measured at 1:1.
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', '--force-device-scale-factor=1', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  // Fake Codex: one chip per option, mode + model + the extra chips, a boolean toggle.
  await setState({ scenario: 'codex' });
  assert.equal(await page.locator('.chat-mode-chip').count(), 1, 'one mode chip');
  assert.equal(await page.locator('.chat-model-chip').count(), 1, 'one model chip');
  assert.equal(await page.locator('.chat-option-chip').count(), 4, 'one chip per remaining Codex option');
  assert.equal((await page.locator('.chat-option-chip[data-option-id="fast"]').innerText()).trim(), 'Fast mode: Off');
  assert.equal(await page.locator('.chat-option-chip[data-option-id="fast"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.chat-compose-more').count(), 0, 'nothing folds at 1280 px');
  report.checks.push('fake Codex shows mode + model + one chip per remaining option');

  await page.locator('.chat-option-chip[data-option-id="fast"]').click();
  assert.equal(await page.evaluate(() => window.__setCalls.length), 1, 'the boolean toggle calls chat.option.set exactly once');
  assert.deepEqual(await page.evaluate(() => window.__setCalls[0]), { optionId: 'fast', value: 'true' });
  assert.equal(await page.locator('.chat-option-chip[data-option-id="fast"]').getAttribute('aria-pressed'), 'true');
  assert.equal((await page.locator('.chat-option-chip[data-option-id="fast"]').innerText()).trim(), 'Fast mode: On');
  assert.equal(await page.locator('.chat-option-chip[data-option-id="fast"]').evaluate(node => node.classList.contains('is-on')), true, 'the On state uses the shared accent style');
  report.checks.push('the boolean chip toggles, reflects aria-pressed and calls chat.option.set once');

  // A select chip opens its menu, shows descriptions + the Recommended badge and sets once.
  await page.locator('.chat-option-chip[data-option-id="collaboration"]').click();
  await page.locator('.chat-option-chip[data-option-id="collaboration"] + .chat-compose-menu').waitFor();
  assert.equal(await page.locator('.chat-option-chip[data-option-id="collaboration"] + .chat-compose-menu .chat-menu-item').count(), 2);
  assert.equal(await page.locator('.chat-option-chip[data-option-id="collaboration"] + .chat-compose-menu .menu-item.chat-menu-item').count(), 2, 'choice buttons use the shared menu item');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitemradio', 'ArrowDown moves focus into the menu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.chat-compose-menu').count(), 0, 'Escape closes the menu');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-option-id')), 'collaboration', 'Escape returns focus to the chip');
  await page.locator('.chat-option-chip[data-option-id="collaboration"]').click();
  await page.locator('.chat-option-chip[data-option-id="collaboration"] + .chat-compose-menu .chat-menu-item', { hasText: 'Plan' }).click();
  assert.equal(await page.evaluate(() => window.__setCalls.length), 2);
  assert.deepEqual(await page.evaluate(() => window.__setCalls[1]), { optionId: 'collaboration', value: 'plan' });
  assert.equal((await page.locator('.chat-option-chip[data-option-id="collaboration"]').innerText()).trim(), 'Plan');
  report.checks.push('a select chip menu opens with keyboard support, sets once and updates its label');

  // The model menu: search above 8, grouping, Recommended, descriptions, empty state.
  await page.locator('.chat-model-chip').click();
  const modelMenu = page.locator('.chat-menu-model');
  await modelMenu.waitFor();
  assert.equal((await activeDesc()).search, true, 'a model menu with more than eight choices focuses search');
  assert.equal(await modelMenu.locator('.chat-menu-search').count(), 1, 'more than 8 models shows the search field');
  assert.equal(await modelMenu.locator('.chat-menu-group').count(), 2, 'choices group by their provider prefix');
  assert.ok(await modelMenu.locator('.chat-menu-badge').count() >= 1, 'the recommended value carries a badge');
  await modelMenu.locator('.chat-menu-search').fill('zzzz');
  assert.equal((await modelMenu.locator('.chat-menu-empty').innerText()).trim(), 'No models found');
  await modelMenu.locator('.chat-menu-search').fill('');
  await page.keyboard.press('Escape');
  report.checks.push('the model menu searches, groups, badges the recommended value and shows an empty state');

  // pi: booleans + selects, no mode chip.
  await setState({ scenario: 'pi' });
  assert.equal(await page.locator('.chat-mode-chip').count(), 0, 'Pi exposes no mode chip');
  assert.equal(await page.locator('.chat-option-chip[aria-pressed]').count(), 2, 'Pi shows two boolean chips');
  assert.equal(await page.locator('.chat-option-chip[data-option-id="steering"]').count(), 1);
  assert.equal(await page.locator('.chat-option-chip[data-option-id="follow-up"]').count(), 1);
  assert.equal((await page.locator('.chat-option-chip[data-option-id="auto-compaction"]').innerText()).trim(), 'Auto-compaction: On');
  await page.locator('.chat-option-chip[data-option-id="auto-retry"]').click();
  assert.deepEqual(await page.evaluate(() => window.__setCalls[0]), { optionId: 'auto-retry', value: 'true' });
  report.checks.push('fake Pi shows its booleans and selects and toggles without a menu');

  // ACP: extra config options and their descriptions render.
  await setState({ scenario: 'acp' });
  assert.equal(await page.locator('.chat-option-chip').count(), 3, 'every extra ACP config option gets a chip');
  await page.locator('.chat-option-chip[data-option-id="context"]').click();
  assert.match(await page.locator('.chat-option-chip[data-option-id="context"] + .chat-compose-menu').innerText(), /How much history/);
  await page.keyboard.press('Escape');
  report.checks.push('extra ACP config options become chips with descriptions');

  // Loading: one placeholder chip and no option chips.
  await setState({ scenario: 'loading' });
  assert.equal((await page.locator('.chat-compose-left .chat-compose-chip').innerText()).trim(), 'Loading settings…');
  assert.equal(await page.locator('.chat-mode-chip, .chat-model-chip, .chat-option-chip').count(), 0, 'the loading state shows no per-option chips');
  report.checks.push('the loading state shows one placeholder chip');

  // Virtualization above 100 models. Headers and described choices share one 28 px slot.
  await setState({ scenario: 'many', width: 1280 });
  await page.locator('.chat-model-chip').click();
  await page.locator('.chat-menu-model .chat-menu-virtual').waitFor();
  const beforeScroll = await page.locator('.chat-menu-model .chat-menu-item').first().evaluate(node => node.textContent);
  assert.equal(await page.locator('.chat-menu-model .chat-menu-virtual').evaluate(node => node.scrollHeight > node.clientHeight + 1), true, 'the virtual list is scrollable');
  const topGeometry = await virtualGeometry();
  assert.ok(topGeometry.headerCount > 0, 'grouped catalogs virtualize their headers');
  assertVirtualAligned(topGeometry, 'virtual top');
  assert.equal(topGeometry.translateY, 0, 'the top window starts at the first row');
  await page.locator('.chat-menu-model .chat-menu-virtual').evaluate(node => node.scrollTo(0, 600));
  await page.waitForFunction(previous => { const node = document.querySelector('.chat-menu-model .chat-menu-item'); return Boolean(node) && node.textContent !== previous; }, beforeScroll, { timeout: 5_000 });
  const midGeometry = await virtualGeometry();
  assertVirtualAligned(midGeometry, 'virtual mid');
  assert.ok(midGeometry.translateY > 0, 'scrolling moves the window');
  await page.locator('.chat-menu-model .chat-menu-virtual').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.chat-menu-virtual');
    const inner = scroller?.querySelector('.chat-menu-virtual-inner');
    const win = scroller?.querySelector('.chat-menu-virtual-window');
    const rows = win ? [...win.children] : [];
    if (!rows.length || !inner) return false;
    const last = rows[rows.length - 1].getBoundingClientRect().bottom - inner.getBoundingClientRect().top;
    return Math.abs(last - inner.getBoundingClientRect().height) < 1.5;
  });
  const endGeometry = await virtualGeometry();
  assertVirtualAligned(endGeometry, 'virtual end');
  assert.ok(Math.abs(endGeometry.lastOffset - endGeometry.innerHeight) < 1.5, 'the terminal window includes the last row');
  await shot('menu-virtual-end-light-en-1100.png');
  await page.keyboard.press('Escape');
  report.checks.push('more than 100 models virtualizes on a fixed row grid, including the terminal window');

  // Small model menus and More settings focus an item on open. Selection and a
  // custom mode id return focus to the trigger that opened the menu.
  await setState({ scenario: 'claude', width: 420 });
  await page.locator('.chat-model-chip').focus();
  await page.keyboard.press('Enter');
  await page.locator('.chat-menu-model').waitFor();
  assert.equal(await page.locator('.chat-menu-model .chat-menu-search').count(), 0, 'eight or fewer models have no search field');
  let active = await activeDesc();
  assert.equal(active.role, 'menuitemradio', 'a small model menu focuses an item when opened from the keyboard');
  assert.equal(active.inMenu, true);
  const smallBefore = active.text;
  await page.keyboard.press('ArrowDown');
  active = await activeDesc();
  assert.equal(active.role, 'menuitemradio');
  assert.notEqual(active.text, smallBefore, 'arrows move between the focused model choices');
  const focusRing = await page.evaluate(() => {
    const node = document.activeElement;
    if (!node?.matches(':focus-visible')) return 0;
    return parseFloat(getComputedStyle(node).outlineWidth) || 0;
  });
  assert.ok(focusRing >= 2, 'the focused menu item uses the shared focus ring');
  await page.keyboard.press('Escape');
  assert.equal((await activeDesc()).trigger, 'model', 'Escape returns to the model chip');

  await setState({ scenario: 'codex', width: 420 });
  await page.locator('.chat-compose-more').waitFor();
  await page.locator('.chat-compose-more').focus();
  await page.keyboard.press('Enter');
  await page.locator('.chat-menu-more').waitFor();
  active = await activeDesc();
  assert.equal(active.role, 'menuitemradio', 'More settings focuses a choice when opened from the keyboard');
  assert.match(active.menu, /chat-menu-more/);
  await page.keyboard.press('ArrowDown');
  assert.equal((await activeDesc()).role, 'menuitemradio', 'arrows move inside More settings');
  await page.keyboard.press('Escape');
  assert.equal((await activeDesc()).trigger, 'more', 'Escape returns to the More settings cog');

  await setState({ scenario: 'codex', width: 1100 });
  await page.locator('.chat-option-chip[data-option-id="collaboration"]').click();
  await page.locator('.chat-compose-menu .chat-menu-item', { hasText: 'Plan' }).click();
  assert.equal((await activeDesc()).optionId, 'collaboration', 'selecting a choice returns focus to its chip');
  assert.equal((await page.locator('.chat-option-chip[data-option-id="collaboration"]').innerText()).trim(), 'Plan');

  await setState({ scenario: 'customMode', width: 1100 });
  await page.locator('.chat-mode-chip').click();
  await page.locator('.chat-compose-menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.chat-compose-menu').count(), 0, 'Escape closes a custom mode menu');
  assert.equal((await activeDesc()).trigger, 'mode', 'Escape restores a mode chip whose option id is not "mode"');
  report.checks.push('menus focus on open and restore the originating trigger on close');

  // 420 px folds the extra chips into the cog; 1100 px keeps them visible.
  await setState({ scenario: 'codex', width: 420 });
  await page.locator('.chat-compose-more').waitFor();
  assert.ok(await page.locator('.chat-option-chip').count() < 4, 'at 420 px the extra chips fold');
  await page.locator('.chat-compose-more').click();
  await page.locator('.chat-menu-more').waitFor();
  assert.ok(await page.locator('.chat-menu-more .chat-more-row').count() >= 1, 'the cog lists the folded settings');
  assert.match(await page.locator('.chat-menu-more').innerText(), /Fast mode/);
  await page.keyboard.press('Escape');
  await setState({ scenario: 'codex', width: 1100 });
  assert.equal(await page.locator('.chat-compose-more').count(), 0, 'at 1100 px nothing folds');
  assert.equal(await page.locator('.chat-option-chip').count(), 4);
  report.checks.push('the overflow fold moves extra chips into the cog at 420 px and keeps them at 1100 px');

  // Consistency while each menu is open. The closed-row matrix cannot see these controls.
  async function checkOpenMenu(name, prepare, open) {
    await prepare();
    await open();
    await page.locator('.chat-compose-menu').waitFor();
    await page.keyboard.press('ArrowDown');
    await shot(name);
    const consistency = await checkControlConsistency(page, '.chat-compose-shell');
    assertNoControlViolations(consistency, name);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.chat-compose-menu').count(), 0, `${name} closes`);
  }
  const openModel = () => page.locator('.chat-model-chip').click();
  const openMode = () => page.locator('.chat-mode-chip').click();
  const openMore = async () => { await page.locator('.chat-compose-more').waitFor(); await page.locator('.chat-compose-more').click(); };
  const openSandbox = () => page.locator('.chat-option-chip[data-option-id="sandbox"]').click();
  for (const theme of ['light', 'dark', 'custom']) {
    await checkOpenMenu(`menu-model-${theme}-en-420.png`, () => setState({ scenario: 'codex', theme, locale: 'en', width: 420 }), openModel);
    await checkOpenMenu(`menu-mode-${theme}-en-420.png`, () => setState({ scenario: 'codex', theme, locale: 'en', width: 420 }), openMode);
    await checkOpenMenu(`menu-more-${theme}-en-420.png`, () => setState({ scenario: 'codex', theme, locale: 'en', width: 420 }), openMore);
  }
  await checkOpenMenu('menu-model-light-zh-420.png', () => setState({ scenario: 'codex', theme: 'light', locale: 'zh-CN', width: 420 }), openModel);
  await checkOpenMenu('menu-more-light-zh-420.png', () => setState({ scenario: 'codex', theme: 'light', locale: 'zh-CN', width: 420 }), openMore);
  await checkOpenMenu('menu-model-light-en-1100.png', () => setState({ scenario: 'codex', theme: 'light', locale: 'en', width: 1100 }), openModel);
  await checkOpenMenu('menu-sandbox-light-en-1100.png', () => setState({ scenario: 'codex', theme: 'light', locale: 'en', width: 1100 }), openSandbox);
  await checkOpenMenu('menu-small-light-en-420.png', () => setState({ scenario: 'claude', theme: 'light', locale: 'en', width: 420 }), openModel);
  report.checks.push('open model, mode, sandbox and More menus pass consistency at 420 px, including dark, custom and zh-CN');

  // Full matrix: one single-line row and zero consistency violations per cell.
  for (const scenario of ['codex', 'claude', 'pi', 'acp', 'loading']) {
    for (const theme of ['light', 'dark']) {
      for (const locale of ['en', 'zh-CN']) {
        for (const width of [420, 700, 1100]) {
          await setState({ scenario, theme, locale, width });
          await assertSingleLine(`${scenario}/${theme}/${locale}/${width}`);
          const consistency = await checkControlConsistency(page, '.chat-compose-shell');
          assertNoControlViolations(consistency, `${scenario}/${theme}/${locale}/${width} composer`);
          await shot(`composer-${scenario}-${theme}-${locale}-${width}.png`);
        }
      }
    }
  }
  report.checks.push('420/700/1100, light/dark, en/zh-CN: one single-line row and zero consistency violations for every scenario');

  // The custom theme remaps the tokens and still passes.
  for (const width of [420, 1100]) {
    await setState({ scenario: 'codex', theme: 'custom', locale: 'en', width });
    await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
    assert.equal((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())).toLowerCase(), '#182430');
    await assertSingleLine(`custom/${width}`);
    const consistency = await checkControlConsistency(page, '.chat-compose-shell');
    assertNoControlViolations(consistency, `custom/${width} composer`);
    await shot(`composer-codex-custom-en-${width}.png`);
  }
  report.checks.push('the custom theme remaps the surface/accent tokens with zero violations');

  assert.deepEqual(report.errors, [], 'the fixture has no renderer page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'COMPOSER OPTIONS VISUAL QA PASSED' : 'COMPOSER OPTIONS VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
