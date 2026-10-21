// Visual QA for the task map. This deliberately uses a hidden Electron window
// and fixture data only: it never starts the runtime or an agent CLI.
//   node qa/task-map-visual.mjs [label]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const label = process.argv[2] || 'current';
assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'label must be a single safe results directory name');
const out = join(root, 'qa/results/task-map', label);
const qaTemp = resolve(root, '..', 'tt-qa-temp');
await mkdir(qaTemp, { recursive: true });
const scratch = await mkdtemp(join(qaTemp, 'threadterm-task-map-'));
assert.ok(resolve(scratch).startsWith(qaTemp + sep), 'scratch must remain inside tt-qa-temp');

const entry = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TaskMapView } from './renderer/src/components/TaskMapView';
import { taskMapFixture, taskMapFixtureLastTime } from './renderer/src/fixtures/taskMapFixtures';
import { buildTaskMap } from './renderer/src/taskMap';
import { flattenTaskFlow, taskFlowOffsets, taskFlowIndex } from './renderer/src/taskFlow';
import { registerChatHandle, publishChatView, chatViewWatched } from './renderer/src/chatFlowSync';
import { I18nProvider } from './renderer/src/i18n';
import { applyThemeTokens } from './renderer/src/themes';
import './renderer/src/styles.css';

const listeners = new Set();
let fixture; let fixtureName = 'delegation'; let visible = true; let failSession; let requestCounts = {}; let requestLog = []; let hangingSessions = new Set(); let hangingResolvers = []; let eventSequence = 0; let generation = 0; let sessions = []; let locale = 'en';
let profiler = { callbacks: 0 };
let unregisterFake; let reveals = []; let focusRequest;
const model = () => {
  const graph = buildTaskMap({ rootSessionId: rootId(), sessions, items: fixtureItems(), documents: fixture.documents || [], maxPhases: 200, copy: (en, zh) => locale === 'zh-CN' ? zh : en, zh: locale === 'zh-CN' });
  const flow = flattenTaskFlow(graph, { mode: 'all', open: new Set(), closed: new Set() });
  return { graph, flow, offsets: taskFlowOffsets(flow.rows, new Map()), index: taskFlowIndex(graph, fixtureItems()) };
};
window.__qaTaskMapCommit = () => { profiler.callbacks += 1; };
window.qaEscapeBubbles = 0;
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.qaEscapeBubbles += 1; });
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const fixtureItems = () => fixture.items instanceof Map ? fixture.items : new Map(Object.entries(fixture.items || {}));
const itemsFor = sessionId => fixtureItems().get(sessionId) || [];
const rootId = () => fixture.rootSessionId;
const repair = { offered: false };
window.threadterm = {
  request: async (method, params = {}) => {
    requestCounts[method] = (requestCounts[method] || 0) + 1;
    if (method === 'chat.snapshot') {
      requestLog.push({ method, sessionId: params.sessionId });
      if (params.sessionId === failSession) throw new Error('Fixture snapshot failure');
      const snapshotItems = clone(itemsFor(params.sessionId));
      if (fixtureName === 'long' && params.sessionId === rootId()) {
        window.qaLongSnapshotDeliveredAt = performance.now(); window.qaLongFirstNodePaintMs = undefined;
        const firstPaint = () => requestAnimationFrame(() => {
          if (document.querySelector('.task-map-row')) window.qaLongFirstNodePaintMs = performance.now() - window.qaLongSnapshotDeliveredAt;
          else firstPaint();
        });
        firstPaint();
      }
      const response = { items: snapshotItems, revision: snapshotItems.length, repair };
      if (hangingSessions.has(params.sessionId)) return new Promise(resolve => hangingResolvers.push(() => resolve(response)));
      return response;
    }
    if (method === 'session.documents.list') return clone(fixture.documents || []);
    if (method === 'review.changes') return { files: [{ path: 'renderer/src/components/TaskMapView.tsx', added: 12, removed: 3, status: 'M' }] };
    if (method === 'chat.subagent.read') return { items: [{ id: 'qa-subagent-text', role: 'assistant', createdAt: '2026-10-21T12:00:00.000Z', parts: [{ type: 'text', text: 'Fixture subagent transcript.' }, { type: 'tool', toolId: 'qa-subagent-tool', toolName: 'Read', status: 'completed', data: { input: { file_path: 'renderer/src/taskMap.ts' }, result: 'Fixture source' } }] }], rev: 1, source: 'native', truncated: false };
    throw new Error('Unexpected fixture request: ' + method);
  },
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
const root = createRoot(document.getElementById('root'));
function renderCurrent(locale = 'en') {
  const graph = buildTaskMap({ rootSessionId: rootId(), sessions, items: fixtureItems(), documents: fixture.documents || [], copy: (en, zh) => locale === 'zh-CN' ? zh : en, zh: locale === 'zh-CN' });
  flushSync(() => root.render(<div className="qa-task-map-host" style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg)' }} data-qa-graph-node-count={graph.nodes.length}><main className="pane-tab-surface qa-task-map-pane"><I18nProvider locale={locale}><TaskMapView key={'qa-' + generation} sessionId={rootId()} sessions={sessions} visible={visible} zh={locale === 'zh-CN'} focus={focusRequest} onClose={() => window.qaClosed = true} onOpenSession={() => {}} onOpenFile={() => {}} onOpenReview={() => {}} /></I18nProvider></main></div>));
}
function paint(options = {}) {
  unregisterFake?.(); unregisterFake = undefined; reveals = [];
  localStorage.setItem('threadterm.taskMap.sync', options.sync === false ? 'off' : 'on');
  fixtureName = options.fixture || 'delegation'; fixture = taskMapFixture(fixtureName); visible = options.visible !== false; failSession = options.failSession; generation++;
  if (options.promptLess) fixture.items.get(fixture.rootSessionId).unshift({ id: 'qa-no-prompt', role: 'assistant', createdAt: '2026-10-21T11:59:00.000Z', parts: [{ type: 'text', text: 'Imported answer without a user prompt.' }] });
  focusRequest = options.focusSession ? { sessionId: options.focusSession, key: 'focus-' + generation } : options.focusTurn !== undefined ? { sessionId: fixture.rootSessionId, itemId: fixture.items.get(fixture.rootSessionId).filter(item => item.role === 'user')[options.focusTurn].id, key: 'focus-' + generation } : undefined;
  sessions = options.deletedRoot ? fixture.sessions.filter(session => session.id !== fixture.rootSessionId) : fixture.sessions;
  requestCounts = {}; requestLog = [];
  const theme = options.theme === 'custom' ? 'dark' : (options.theme || 'light');
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.customTheme = 'false';
  applyThemeTokens(undefined, theme);
  const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const custom = options.theme === 'custom' ? { background: token('--bg'), surface: token('--raised') || token('--surface'), text: token('--text'), muted: token('--muted'), accent: token('--blue') || token('--primary'), border: token('--border') } : undefined;
  applyThemeTokens(custom, theme);
  document.documentElement.dataset.customTheme = custom ? 'true' : 'false';
  locale = options.locale || 'en'; renderCurrent(locale);
}
function setVisible(next, locale = 'en') {
  visible = next; window.qaTaskMapLocale = locale; renderCurrent(locale);
}
function emit(item, sessionId = rootId()) {
  const map = fixtureItems(); const list = map.get(sessionId) || []; map.set(sessionId, [...list, item]);
  fixture.items = map;
  const event = { v: 1, event: 'chat.item', epoch: 'qa', seq: ++eventSequence, data: { sessionId, item } };
  for (const listener of listeners) listener(event);
}
function liveItem(index) {
  const latest = taskMapFixtureLastTime(fixture);
  const base = typeof latest === 'number' ? latest : Date.parse(latest);
  return { id: 'qa-live-' + index, role: 'user', createdAt: new Date(base + index * 1_000).toISOString(), turnId: 'qa-live-turn-' + index, parts: [{ type: 'text', text: 'Live task-map fixture turn ' + index }] };
}
function parentRerender(addDelegate = false) {
  const next = sessions.map(session => ({ ...session }));
  if (addDelegate) {
    const root = next.find(session => session.id === rootId());
    next.push({ ...next.find(session => session.id !== rootId()), id: 'qa-hidden-delegate', title: 'Claude Code · hidden delegate', delegation: { id: 'qa-hidden-delegation', parentSessionId: root.id, workspace: 'shared', state: 'completed' } });
  }
  sessions = next; renderCurrent(locale);
}
function emitTransport(state, epoch) {
  const event = { v: 1, event: 'runtime.transport', epoch, seq: ++eventSequence, data: { state, epoch } };
  for (const listener of listeners) listener(event);
}
window.qaTaskMap = {
  paint,
  setVisible,
  rows() { const { graph, flow, offsets, index } = model(); return flow.rows.map((row, i) => ({ ...row, top: offsets.tops[i], node: graph.nodes.find(node => node.id === row.nodeId), target: index.targets.get(row.nodeId) })); },
  simulateChat(missing = false) {
    unregisterFake?.(); reveals = [];
    const handle = { shown: () => true, reveal: target => { reveals.push(clone(target)); return !missing; } };
    unregisterFake = registerChatHandle(rootId(), handle);
    const { graph, index } = model(); const phase = graph.phases[3];
    const node = graph.nodes.find(node => node.phase === 3 && node.kind === 'tools'); const target = index.targets.get(node.id);
    publishChatView(handle, { sessionId: rootId(), items: [target.itemId], tools: target.toolId ? [target.toolId] : [], turns: [phase.promptItemId].filter(Boolean), following: false });
    return { nodeId: node.id, turnKey: 'turn:' + phase.id, target };
  },
  watched() { return sessions.some(session => chatViewWatched(session.id)); },
  get reveals() { return clone(reveals); },
  clearFailure() { failSession = undefined; },
  emit,
  emitTransport,
  parentRerender,
  hangSnapshots(sessionId) { hangingSessions.add(sessionId); },
  releaseSnapshots() { hangingSessions.clear(); const pending = hangingResolvers; hangingResolvers = []; pending.forEach(resolve => resolve()); },
  resetProfiler() { profiler = { callbacks: 0 }; },
  liveItem,
  get state() { return { rootId: rootId(), sessions, requests: clone(requestCounts), requestLog: clone(requestLog), listeners: listeners.size, profiler: clone(profiler) }; },
};
paint();
`;

const taskMapViewPath = resolve(root, 'renderer/src/components/TaskMapView.tsx');
const profilerInsideTaskMap = {
  name: 'qa-profiler-inside-task-map',
  setup(esbuild) {
    esbuild.onLoad({ filter: /TaskMapView\.tsx$/ }, async args => {
      if (resolve(args.path) !== taskMapViewPath) return undefined;
      let source = await readFile(args.path, 'utf8');
      const reactImport = /import\s*\{([^}]+)\}\s*from\s*["']react["'];/;
      assert.match(source, reactImport, 'TaskMapView has a named React import for profiler instrumentation');
      source = source.replace(reactImport, (_match, names) => `import {${names}, Profiler as __QaProfiler} from 'react';`);
      const starts = (source.match(/return <section className="task-map"/g) ?? []).length;
      const ends = (source.match(/<\/section>;/g) ?? []).length;
      assert.equal(starts, 2, 'TaskMapView has two section returns for profiler instrumentation');
      assert.equal(ends, starts, 'TaskMapView section returns close for profiler instrumentation');
      source = source.replaceAll('return <section className="task-map"', 'return <__QaProfiler id="task-map" onRender={() => window.__qaTaskMapCommit?.()}><section className="task-map"');
      source = source.replace(/<\/section>;/g, '</section></__QaProfiler>;');
      return { contents: source, loader: 'tsx' };
    });
  },
};
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [profilerInsideTaskMap], logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root,.app-shell,.qa-task-map-pane{margin:0;width:100%;height:100%;overflow:hidden}.qa-task-map-pane{display:flex;min-width:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const report = { passed: false, label, screenshots: [], checks: [], timings: {}, requests: {}, errors: [] };
let app; let page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(40); }
  throw new Error(`Timed out: ${description}`);
}
async function screenshot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function render(options, width = 1440) {
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(value => window.qaTaskMap.paint(value), options);
  await page.waitForFunction(() => {
    const map = document.querySelector('.task-map');
    const note = map?.querySelector('.note')?.textContent || '';
    return (Number(map?.getAttribute('data-node-count') || 0) > 0 && map?.getAttribute('data-view-ready') === 'true') || /No activity yet|还没有活动/.test(note);
  });
}
async function assertControls(selector, label) {
  const result = await checkControlConsistency(page, selector);
  assert.ok(!result.error, `${label}: ${result.error || ''}`);
  assert.deepEqual(result.violations, [], `${label}: ${result.violations.map(value => value.message).join('; ')}`);
  report.checks.push(`${label}: ${result.checked} controls`);
}
async function assertFlowGeometry(label) {
  const geometry = await page.locator('.task-map-list').evaluate(list => {
    const bounds = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('.task-map-row')].map(row => {
      const box = row.getBoundingClientRect();
      return { key: row.dataset.rowKey, top: box.top, bottom: box.bottom, left: box.left, right: box.right, overflow: row.scrollWidth > row.clientWidth + 1 };
    }).sort((a, b) => a.top - b.top);
    return { rows, listOverflow: list.scrollWidth > list.clientWidth + 1, left: bounds.left, right: bounds.right };
  });
  assert.equal(geometry.listOverflow, false, `${label}: list has no horizontal overflow`);
  for (let i = 0; i < geometry.rows.length; i++) {
    const row = geometry.rows[i];
    assert.equal(row.overflow, false, `${label}: ${row.key} has no horizontal overflow`);
    assert.ok(row.left >= geometry.left - 1 && row.right <= geometry.right + 1, `${label}: ${row.key} fits the pane`);
    if (i) assert.ok(geometry.rows[i - 1].bottom <= row.top + 1, `${label}: rows are strictly stacked`);
  }
}
async function revealRow(key) {
  await page.evaluate(key => {
    const row = window.qaTaskMap.rows().find(row => row.key === key);
    const list = document.querySelector('.task-map-list'); list.scrollTop = Math.max(0, row.top - 80);
  }, key);
  const target = page.locator('.task-map-row').and(page.locator(`[data-row-key=${JSON.stringify(key)}]`));
  await target.waitFor(); return target;
}
async function expandAll() {
  const button = page.locator('.task-map-expand');
  if (/Expand all|\u5168\u90e8\u5c55\u5f00/.test(await button.innerText())) await button.click();
}
async function mapLifecycle() {
  return page.locator('.task-map').evaluate(map => ({ rebuilds: Number(map.getAttribute('data-rebuild-count') || 0), visible: map.getAttribute('data-visible') }));
}
async function waitForRebuild(after, label) {
  await until(async () => (await mapLifecycle()).rebuilds > after, label);
  await pause(300);
  const current = await mapLifecycle();
  assert.equal(current.rebuilds, after + 1, `${label}: exactly one graph rebuild`);
}

try {
  await mkdir(out, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  env.TEMP = qaTemp; env.TMP = qaTemp;
  app = await electron.launch({ args: ['--disable-gpu', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow(); page.setDefaultTimeout(8_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForLoadState('load'); await page.waitForFunction(() => Boolean(window.qaTaskMap));
  await page.waitForFunction(() => window.qaTaskMap.state.profiler.callbacks > 0);

  for (const theme of ['dark', 'light', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 480]) {
    await render({ fixture: 'delegation', theme, locale }, width);
    await assertFlowGeometry(`${theme}/${locale}/${width}`);
    await assertControls('.task-map-toolbar', `toolbar ${theme}/${locale}/${width}`);
    await screenshot(`delegation-${theme}-${locale}-${width}.png`);
  }
  for (const fixture of ['single', 'empty', 'running', 'long', 'nested']) {
    await render({ fixture, theme: 'dark', locale: 'en' });
    await assertFlowGeometry(fixture); await screenshot(`${fixture}-default.png`);
  }

  await render({ fixture: 'delegation', theme: 'dark', locale: 'en', sync: false });
  const defaultTurns = await page.locator('.task-map-row[data-row-kind="turn"]').evaluateAll(rows => rows.map(row => ({ phase: Number(row.dataset.phase), open: row.classList.contains('is-open') })));
  assert.ok(defaultTurns.some(row => !row.open), 'settled earlier turns start closed');
  assert.ok(defaultTurns.at(-1).open, 'last turn starts open');
  await expandAll();
  let allRows = await page.evaluate(() => window.qaTaskMap.rows());
  const expectedKinds = ['plan', 'tools', 'delegate', 'subagent', 'approval', 'question', 'error', 'reply', 'files', 'document'];
  for (const kind of expectedKinds) {
    // Closing details resets measured offsets before seeking the next virtual row.
    if (await page.locator('.task-map-details').count()) await page.keyboard.press('Escape');
    const info = allRows.find(row => row.kind === 'step' && row.node?.kind === kind);
    assert.ok(info, `fixture contains ${kind}`);
    const row = await revealRow(info.key);
    await row.locator('.task-map-row-details').click(); await page.locator('.task-map-details').waitFor();
    assert.equal(await page.locator('.task-map-details').count(), 1, `${kind} opens one inline details panel`);
    const panelRow = page.locator('.task-map-row[data-row-kind="details"]');
    assert.equal(await panelRow.getAttribute('data-node-id'), info.nodeId, `${kind} details belong to the selected row`);
    await assertControls('.task-map-details > .task-map-inspector-actions', `details ${kind}`);
    if (kind === 'tools') assert.ok(await page.locator('.task-map-details .chat-tool-entry.tool-card').count(), 'tools render the Chat tool cards');
    if (kind === 'subagent') {
      await page.getByRole('button', { name: 'Load transcript', exact: true }).click();
      await page.getByText('Fixture subagent transcript.', { exact: true }).waitFor();
    }
    if (info.target) assert.ok(await page.getByRole('button', { name: 'Show in Chat', exact: true }).count(), `${kind} has Show in Chat`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertFlowGeometry(`details ${kind}`); await screenshot(`details-${kind}.png`);
  }
  await page.keyboard.press('Escape');
  await page.locator('.task-map-expand').click();
  assert.equal(await page.locator('.task-map-row[data-row-kind="step"]').count(), 0, 'collapse all hides steps');
  await expandAll();
  await screenshot('expand-all.png');

  await render({ fixture: 'nested', theme: 'light', locale: 'en', sync: false }); await expandAll();
  allRows = await page.evaluate(() => window.qaTaskMap.rows());
  const nested = allRows.find(row => row.depth >= 2 && row.kind === 'step'); assert.ok(nested, 'nested delegation has depth two');
  await revealRow(nested.key);
  assert.ok(await page.locator('.task-map-guide').count(), 'nested steps draw depth guides');
  const branch = allRows.find(row => row.node?.kind === 'delegate' && row.bar); assert.ok(branch, 'delegate has a timed branch');
  const branchRow = await revealRow(branch.key); assert.ok(await branchRow.locator('.task-map-time-bar').count(), 'delegate renders time bar');
  await screenshot('nested-time-bars.png');

  await render({ fixture: 'delegation', promptLess: true, theme: 'light', locale: 'en', sync: false });
  const orphanTurn = page.locator('.task-map-row[data-row-kind="turn"]').first();
  await orphanTurn.locator('.task-map-row-body').click();
  assert.ok((await orphanTurn.getAttribute('class')).includes('is-open'), 'a prompt-less turn opens safely');
  await orphanTurn.locator('.task-map-row-body').focus();
  const escapeBefore = await page.evaluate(() => window.qaEscapeBubbles);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space'); await page.locator('.task-map-details').waitFor();
  await page.keyboard.press('Escape'); await page.locator('.task-map-details').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.qaEscapeBubbles), escapeBefore, 'Escape closing details stays inside the map');
  await page.keyboard.press('Escape'); assert.ok((await page.evaluate(() => window.qaEscapeBubbles)) > escapeBefore, 'unhandled Escape reaches workspace');

  await render({ fixture: 'long', theme: 'dark', locale: 'en', sync: false }); await expandAll();
  await page.locator('.task-map-list').evaluate(list => list.scrollTop = 0);
  await until(() => page.evaluate(() => !document.querySelector('.task-map-sticky-turn') && document.querySelector('.task-map-spacer > .task-map-row')?.dataset.rowKind === 'turn'), 'list settles at the first turn');
  // The sticky header copy comes first in the DOM; focus a real row.
  await page.locator('.task-map-spacer .task-map-row-body').first().focus();
  await page.keyboard.press('End');
  await until(() => page.evaluate(() => { const list = document.querySelector('.task-map-list'); const box = document.activeElement.getBoundingClientRect(), viewport = list.getBoundingClientRect(); return box.top >= viewport.top + 35 && box.bottom <= viewport.bottom + 1; }), 'End keeps virtualized focused row in viewport');
  await page.keyboard.press('Home');
  await until(() => page.evaluate(() => document.querySelector('.task-map-list').scrollTop === 0), 'Home returns to first turn');
  await page.keyboard.press('ArrowDown'); const keyboardBefore = await page.evaluate(() => document.activeElement.closest('[data-row-key]')?.dataset.rowKey);
  await page.keyboard.press('ArrowDown'); assert.notEqual(await page.evaluate(() => document.activeElement.closest('[data-row-key]')?.dataset.rowKey), keyboardBefore, 'arrow navigation advances row');
  await page.locator('.task-map-list').evaluate(list => list.scrollTop = 800);
  await page.locator('.task-map-sticky-turn').waitFor();
  const sticky = await page.locator('.task-map-sticky-turn').boundingBox(), listBox = await page.locator('.task-map-list').boundingBox();
  assert.ok(Math.abs(sticky.y - listBox.y) <= 1, 'turn copy sticks to the list top'); await screenshot('long-sticky-turn.png');
  await page.locator('.task-map-toolbar [role="combobox"]').click(); await page.getByRole('option').nth(5).click();
  await until(() => page.evaluate(() => { const list = document.querySelector('.task-map-list'); return [...list.querySelectorAll('.task-map-row[data-row-kind="turn"]')].some(row => Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top) <= 1 && row.classList.contains('is-open')); }), 'turn picker opens and aligns the chosen turn');

  await render({ fixture: 'long', theme: 'dark', locale: 'en', focusTurn: 3 });
  await until(() => page.evaluate(() => { const selected = document.querySelector('.task-map-row.is-selected'); const list = document.querySelector('.task-map-list'); return selected?.dataset.phase === '3' && selected.classList.contains('is-open') && Math.abs(selected.getBoundingClientRect().top - list.getBoundingClientRect().top) <= 1; }), 'item focus opens and aligns an old root turn');
  await render({ fixture: 'nested', theme: 'dark', locale: 'en', focusSession: 'grok' });
  await page.locator('.task-map-row.is-selected[data-node-kind="delegate"].chat-message-highlight').waitFor();
  const focusedDelegate = await page.locator('.task-map-row.is-selected').getAttribute('data-node-id');
  assert.equal((await page.evaluate(() => window.qaTaskMap.rows())).find(row => row.nodeId === focusedDelegate)?.node.childSessionId, 'grok', 'delegate focus opens its enclosing rows and selects its starter');
  await screenshot('delegate-focus.png');

  await render({ fixture: 'long', theme: 'dark', locale: 'en' });
  const synced = await page.evaluate(() => window.qaTaskMap.simulateChat());
  await until(() => page.evaluate(key => document.querySelector(`[data-row-key=${JSON.stringify(key)}]`)?.classList.contains('is-open'), synced.turnKey), 'Chat auto-opens an old turn');
  const marked = page.locator('.task-map-row.is-in-view[data-row-kind="step"]').first(); await marked.waitFor();
  await until(() => marked.evaluate(row => { const box = row.getBoundingClientRect(), viewport = row.closest('.task-map-list').getBoundingClientRect(); return box.top >= viewport.top && box.bottom <= viewport.bottom; }), 'Chat scroll marks and reveals flow rows');
  const scrollBeforeClick = await page.locator('.task-map-list').evaluate(list => list.scrollTop);
  await marked.locator('.task-map-row-body').click();
  assert.deepEqual((await page.evaluate(() => window.qaTaskMap.reveals)).at(-1), synced.target, 'row click reveals the exact item/tool target');
  await pause(200); assert.ok(Math.abs((await page.locator('.task-map-list').evaluate(list => list.scrollTop)) - scrollBeforeClick) <= 1, 'Chat reveal does not jump the flow');
  await screenshot('sync-old-turn.png');
  // An on-screen Chat that cannot find the step: the click opens the inline details instead of doing nothing.
  await page.evaluate(() => window.qaTaskMap.simulateChat(true));
  await marked.locator('.task-map-row-body').click();
  await page.locator('.task-map-details').waitFor();
  assert.equal(await page.locator('.task-map-row[data-row-kind="details"]').getAttribute('data-node-id'), await marked.getAttribute('data-node-id'), 'a reveal miss falls back to the details');
  await page.keyboard.press('Escape'); await page.locator('.task-map-details').waitFor({ state: 'detached' });
  await page.locator('.task-map-sync').click();
  assert.equal(await page.evaluate(() => window.qaTaskMap.watched()), false, 'Sync off removes every Chat watcher');
  assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.taskMap.sync')), 'off', 'Sync preference persists');
  await expandAll(); const unsynced = await revealRow(synced.nodeId);
  await unsynced.locator('.task-map-row-body').click(); await page.locator('.task-map-details').waitFor();
  await page.evaluate(() => window.qaTaskMap.setVisible(false));
  assert.equal(await page.evaluate(() => window.qaTaskMap.watched()), false, 'hidden maps have no Chat watchers');
  report.checks.push('stacking, overflow, theme/locale matrix, expansion, inline details, nesting, time bars, keyboard, sticky turn, picker, and Chat sync');

  await render({ fixture: 'running', theme: 'dark', locale: 'en' });
  await screenshot('running-before-live-events.png');
  const initialCount = Number(await page.locator('.task-map').getAttribute('data-node-count')); const beforeLive = await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0);
  const initialTurns = await page.locator('.task-map-spacer > .task-map-row[data-row-kind="turn"]').count();
  await page.evaluate(() => { for (let index = 1; index <= 3; index++) window.qaTaskMap.emit(window.qaTaskMap.liveItem(index)); });
  // Each live user message opens a new turn (a turn row stands for its prompt); earlier finished turns may fold.
  await until(async () => Number(await page.locator('.task-map').getAttribute('data-node-count')) >= initialCount + 3
    && await page.locator('.task-map-spacer > .task-map-row[data-row-kind="turn"]').count() >= initialTurns + 3, 'three live turns within one second', 1_000);
  assert.equal(await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0), beforeLive, 'live events do not re-snapshot');
  await screenshot('running-after-live-events.png');
  await page.evaluate(() => window.qaTaskMap.setVisible(false, 'en'));
  assert.equal(await page.evaluate(() => window.qaTaskMap.watched()), false, 'hiding a synced map removes Chat watchers');
  const hiddenBefore = await page.locator('.task-map').innerHTML();
  const hiddenRequests = await page.evaluate(() => window.qaTaskMap.state.requests);
  await page.evaluate(() => window.qaTaskMap.emit(window.qaTaskMap.liveItem(9)));
  await pause(350);
  assert.deepEqual(await page.evaluate(() => window.qaTaskMap.state.requests), hiddenRequests, 'hidden map makes no requests');
  assert.equal(await page.locator('.task-map').innerHTML(), hiddenBefore, 'hidden events make no DOM change');
  report.checks.push('live event coalescing and hidden-tab quiescence');

  // The hidden memo boundary must reject parent prop churn as well as live events.
  const cleanHidden = await mapLifecycle();
  const cleanHiddenRequests = await page.evaluate(() => window.qaTaskMap.state.requests);
  await page.evaluate(() => window.qaTaskMap.resetProfiler());
  await page.evaluate(() => { window.qaTaskMap.parentRerender(false); window.qaTaskMap.emit(window.qaTaskMap.liveItem(10)); });
  await pause(350);
  assert.deepEqual(await page.evaluate(() => window.qaTaskMap.state.requests), cleanHiddenRequests, 'hidden parent sessions change and chat item make no requests');
  assert.equal((await mapLifecycle()).rebuilds, cleanHidden.rebuilds, 'hidden parent sessions change makes no map rebuild');
  const hiddenProfiler = await page.evaluate(() => window.qaTaskMap.state.profiler);
  assert.equal(hiddenProfiler.callbacks, 0, 'hidden parent sessions change commits no profiled map subtree work');
  await page.evaluate(() => window.qaTaskMap.setVisible(true, 'en'));
  await waitForRebuild(cleanHidden.rebuilds, 'clean hidden show');
  assert.deepEqual(await page.evaluate(() => window.qaTaskMap.state.requests), cleanHiddenRequests, 'clean hidden show reuses loaded snapshots');

  // A delegate introduced while hidden has no snapshot yet, so showing requests only it.
  await page.evaluate(() => window.qaTaskMap.setVisible(false, 'en'));
  const delegateHidden = await mapLifecycle(); const delegateRequests = await page.evaluate(() => window.qaTaskMap.state.requests);
  await page.evaluate(() => { window.qaTaskMap.resetProfiler(); window.qaTaskMap.parentRerender(true); });
  await pause(150);
  assert.deepEqual(await page.evaluate(() => window.qaTaskMap.state.requests), delegateRequests, 'hidden new delegate makes no immediate request');
  assert.equal((await mapLifecycle()).rebuilds, delegateHidden.rebuilds, 'hidden new delegate makes no rebuild');
  assert.equal((await page.evaluate(() => window.qaTaskMap.state.profiler)).callbacks, 0, 'hidden new delegate commits no profiled map subtree work');
  const snapshotsBeforeDelegateShow = await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0);
  await page.evaluate(() => window.qaTaskMap.setVisible(true, 'en'));
  await until(async () => (await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0)) === snapshotsBeforeDelegateShow + 1, 'new delegate snapshot on show');
  await waitForRebuild(delegateHidden.rebuilds, 'new delegate show');
  const delegateLog = await page.evaluate(() => window.qaTaskMap.state.requestLog.filter(entry => entry.method === 'chat.snapshot').map(entry => entry.sessionId));
  assert.equal(delegateLog.at(-1), 'qa-hidden-delegate', 'only the new delegate receives a snapshot after hidden show');

  // A hidden reconnect makes every loaded session stale; a hung old request must not wedge the new effect.
  await page.evaluate(() => { window.qaTaskMap.hangSnapshots(window.qaTaskMap.state.rootId); window.qaTaskMap.emitTransport('disconnected', 'qa-old'); window.qaTaskMap.emitTransport('reconnected', 'qa-new'); window.qaTaskMap.setVisible(false, 'en'); window.qaTaskMap.releaseSnapshots(); });
  const reconnectHidden = await mapLifecycle(); const reconnectRequests = await page.evaluate(() => window.qaTaskMap.state.requests);
  await page.evaluate(() => window.qaTaskMap.resetProfiler());
  await page.evaluate(() => { window.qaTaskMap.emitTransport('disconnected', 'qa-hidden-old'); window.qaTaskMap.emitTransport('reconnected', 'qa-hidden-new'); });
  await pause(150);
  assert.deepEqual(await page.evaluate(() => window.qaTaskMap.state.requests), reconnectRequests, 'hidden reconnect makes no immediate request');
  assert.equal((await mapLifecycle()).rebuilds, reconnectHidden.rebuilds, 'hidden reconnect makes no rebuild');
  assert.equal((await page.evaluate(() => window.qaTaskMap.state.profiler)).callbacks, 0, 'hidden reconnect commits no profiled map subtree work');
  const snapshotsBeforeReconnect = await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0);
  const staleSessions = await page.evaluate(() => window.qaTaskMap.state.sessions.length);
  await page.evaluate(() => window.qaTaskMap.setVisible(true, 'en'));
  await until(async () => (await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0)) === snapshotsBeforeReconnect + staleSessions, 'all stale sessions re-snapshot after reconnect');
  await waitForRebuild(reconnectHidden.rebuilds, 'reconnect show');
  report.checks.push('hidden parent memo, clean show, new delegate, reconnect stale sessions and hung request recovery');

  await render({ fixture: 'long', theme: 'dark', locale: 'en' });
  await until(() => page.evaluate(() => Number.isFinite(window.qaLongFirstNodePaintMs)), 'long fixture first row paint');
  report.timings.longFirstRowMs = await page.evaluate(() => window.qaLongFirstNodePaintMs);
  assert.ok(report.timings.longFirstRowMs < 2_000, 'development first row budget; production has the strict budget');
  await expandAll();
  report.longRenderedRows = await page.locator('.task-map-row').count(); report.longTotalRows = Number(await page.locator('.task-map').getAttribute('data-row-count'));
  assert.ok(report.longRenderedRows < 100 && report.longRenderedRows < report.longTotalRows, 'long fixture virtualizes the expanded list');
  await screenshot('long-expanded.png');

  await render({ fixture: 'single', theme: 'light', locale: 'en' }); await screenshot('single.png');
  await render({ fixture: 'empty', theme: 'light', locale: 'zh-CN' }); assert.ok(await page.locator('.task-map .note').count(), 'empty fixture has an empty state'); await screenshot('empty.png');
  await render({ fixture: 'delegation', theme: 'light', locale: 'en' });
  const errorSession = await page.evaluate(() => window.qaTaskMap.state.sessions.find(session => session.id !== window.qaTaskMap.state.rootId)?.id);
  assert.ok(errorSession, 'delegation fixture includes a delegate session for the error-lane check');
  await render({ fixture: 'delegation', theme: 'light', locale: 'en', failSession: errorSession });
  const retry = page.getByRole('button', { name: /^(Retry|重试)$/ }).first(); await retry.waitFor();
  assert.ok(await retry.isVisible(), 'error lane exposes Retry before recovery');
  await screenshot('error-lane.png');
  const retryBefore = await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0); await page.evaluate(() => window.qaTaskMap.clearFailure()); await retry.click();
  await until(async () => (await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0)) > retryBefore, 'failed lane retry');
  await until(async () => (await page.getByRole('button', { name: /^(Retry|重试)$/ }).count()) === 0, 'failed lane recovery');
  await page.evaluate(() => window.qaTaskMap.paint({ fixture: 'delegation', theme: 'light', locale: 'en', deletedRoot: true }));
  await until(async () => (await page.getByText(/This chat no longer exists|这个对话已不存在/).count()) > 0, 'deleted root state');
  await screenshot('deleted-root.png');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.evaluate(() => window.qaClosed), true, 'deleted-root Close reaches the owner');
  report.requests = await page.evaluate(() => window.qaTaskMap.state.requests);
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  assert.ok(resolve(scratch).startsWith(qaTemp + sep), 'cleanup remains in tt-qa-temp');
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close(); await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(`${report.passed ? 'TASK MAP VISUAL PASSED' : 'TASK MAP VISUAL FAILED'}; ${join(out, 'report.json')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
