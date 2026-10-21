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
import { taskFlowIndex } from './renderer/src/taskFlow';
import { layoutTaskGraph, taskGraphAncestors } from './renderer/src/taskGraph';
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
  const index = taskFlowIndex(graph, fixtureItems());
  return { graph, index, ancestors: taskGraphAncestors(graph) };
};
const layoutFor = (mode, width) => {
  const { graph, ancestors } = model();
  return layoutTaskGraph(graph, { mode, open: new Set(), closed: new Set() }, { width, ancestors });
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
          if (document.querySelector('.task-graph-box')) window.qaLongFirstNodePaintMs = performance.now() - window.qaLongSnapshotDeliveredAt;
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
  graphInfo() {
    const { graph, index } = model();
    return {
      hiddenPhases: graph.hiddenPhases,
      phases: graph.phases.map((phase, index) => ({ index, id: phase.id, label: phase.label, status: phase.status, promptItemId: phase.promptItemId })),
      lanes: graph.lanes.map(lane => ({ id: lane.id, kind: lane.kind, provider: lane.provider, sessionId: lane.sessionId, title: lane.title })),
      nodes: graph.nodes.map(node => ({ id: node.id, kind: node.kind, laneId: node.laneId, phase: node.phase, status: node.status, childSessionId: node.childSessionId })),
      targets: [...index.targets.entries()],
    };
  },
  layoutInfo(mode) {
    const scroll = document.querySelector('.task-graph-scroll');
    const layout = layoutFor(mode, scroll?.clientWidth || 1440);
    return {
      columns: layout.columnX.length,
      boxes: layout.boxes.map(box => ({ id: box.id, kind: box.kind, nodeId: box.nodeId, members: box.members, laneId: box.laneId, phase: box.phase, column: box.column, row: box.row, x: box.x, y: box.y, width: box.width, height: box.height, status: box.status, head: box.head, folded: box.folded })),
      bands: layout.bands.map(band => ({ key: band.key, phase: band.phase, open: band.open, top: band.top, bottom: band.bottom })),
    };
  },
  boxForNode(nodeId, mode = 'all') {
    const scroll = document.querySelector('.task-graph-scroll');
    const layout = layoutFor(mode, scroll?.clientWidth || 1440);
    const boxId = layout.boxOf.get(nodeId);
    return layout.boxes.find(box => box.id === boxId) ?? undefined;
  },
  targetFor(nodeId) { return clone(model().index.targets.get(nodeId)); },
  simulateChat(missing = false) {
    unregisterFake?.(); reveals = [];
    const handle = { shown: () => true, reveal: target => { reveals.push(clone(target)); return !missing; } };
    unregisterFake = registerChatHandle(rootId(), handle);
    const { graph, index } = model(); const phase = graph.phases[3];
    const node = graph.nodes.find(node => node.phase === 3 && node.kind === 'tools'); const target = index.targets.get(node.id);
    publishChatView(handle, { sessionId: rootId(), items: [target.itemId], tools: target.toolId ? [target.toolId] : [], turns: [phase.promptItemId].filter(Boolean), following: false });
    return { nodeId: node.id, phase: phase.index, turnKey: 'turn:' + phase.id, target };
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
async function assertGraphGeometry(label) {
  // Let pending scroll commits and ResizeObserver relayouts (details panel, window resize) settle first. A hidden
  // window gets few rendering opportunities, so wait until the world matches the scroll area's new width.
  await pause(80);
  await page.waitForFunction(() => {
    const scroll = document.querySelector('section.task-map .task-graph-scroll'), world = scroll?.querySelector('.task-graph-world');
    return !scroll || !world || world.offsetWidth <= scroll.clientWidth + 1 || Number(scroll.closest('section.task-map').dataset.columns || 0) * 164 - 8 > scroll.clientWidth + 1;
  }, undefined, { timeout: 3_000 }).catch(() => {});
  const geometry = await page.evaluate(() => {
    const map = document.querySelector('section.task-map');
    const scroll = map?.querySelector('.task-graph-scroll');
    if (!map || !scroll) return { missing: true, empty: Boolean(map?.querySelector('.note')) };
    const rectOf = element => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
    const overflow = element => Boolean(element) && element.scrollWidth > element.clientWidth + 1;
    const bands = [...map.querySelectorAll('.task-graph-band')];
    const bandsByPhase = new Map(bands.map(band => [Number(band.dataset.phase), band]));
    const boxes = [...map.querySelectorAll('.task-graph-box')].map(element => {
      const band = element.closest('.task-graph-band') ?? bandsByPhase.get(Number(element.dataset.phase));
      const header = band?.querySelector('.task-graph-turn');
      return { id: element.dataset.boxId, phase: Number(element.dataset.phase), column: Number(element.dataset.column),
        rect: rectOf(element), bandPhase: band ? Number(band.dataset.phase) : undefined, band: band ? rectOf(band) : undefined, header: header ? rectOf(header) : undefined };
    });
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].rect, b = boxes[j].rect;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left), height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 1 && height > 1) overlaps.push(`${boxes[i].id} × ${boxes[j].id}`);
    }
    const outsideBand = boxes.filter(box => !box.band || !box.header || box.phase !== box.bandPhase
      || box.rect.left < box.band.left - 1 || box.rect.right > box.band.right + 1 || box.rect.top < box.header.bottom - 1 || box.rect.bottom > box.band.bottom + 1)
      .map(box => `${box.id} (phase ${box.phase})`);
    const onBorder = (point, rect, tolerance) => {
      if (point.x < rect.left - tolerance || point.x > rect.right + tolerance || point.y < rect.top - tolerance || point.y > rect.bottom + tolerance) return false;
      return Math.abs(point.x - rect.left) <= tolerance || Math.abs(point.x - rect.right) <= tolerance || Math.abs(point.y - rect.top) <= tolerance || Math.abs(point.y - rect.bottom) <= tolerance;
    };
    const byId = new Map(boxes.map(box => [box.id, box]));
    const edgeProblems = [], edgeSamples = [];
    for (const path of map.querySelectorAll('path.task-graph-edge')) {
      const from = byId.get(path.dataset.from), to = byId.get(path.dataset.to);
      const total = path.getTotalLength(), matrix = path.getScreenCTM();
      if (!matrix) continue;
      const pointAt = length => { const point = path.getPointAtLength(length).matrixTransform(matrix); return { x: point.x, y: point.y }; };
      if (!path.dataset.edgeKind) edgeProblems.push(`edge without kind ${path.dataset.edgeId}`);
      if (from && to) {
        if (!onBorder(pointAt(0), from.rect, 1.5)) edgeProblems.push(`${path.dataset.edgeId} does not start on ${from.id}`);
        if (!onBorder(pointAt(total), to.rect, 1.5)) edgeProblems.push(`${path.dataset.edgeId} does not end on ${to.id}`);
      }
      const others = boxes.filter(box => box.id !== path.dataset.from && box.id !== path.dataset.to);
      for (let length = 0; length <= total; length += 4) {
        const point = pointAt(length);
        for (const box of others) {
          const rect = box.rect;
          if (point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2) edgeSamples.push(`${path.dataset.edgeId} crosses ${box.id} at ${Math.round(length)} px`);
        }
      }
    }
    const columns = Number(map.dataset.columns || 0), minimumWorld = columns * 132 + Math.max(0, columns - 1) * 32 + 24;
    return {
      missing: false, bands: bands.length, boxes: boxes.length, overlaps, outsideBand, edgeProblems, edgeSamples,
      mapOverflow: overflow(map), toolbarOverflow: overflow(map.querySelector('.task-map-toolbar')), summaryOverflow: overflow(map.querySelector('.task-map-summary')),
      scrollLeftOverflow: scroll.scrollWidth > scroll.clientWidth + 1, scrollClientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, columns, minimumWorld,
      widest: [...scroll.querySelectorAll('*')].map(node => ({ node: `${node.tagName.toLowerCase()}.${String(node.className?.baseVal ?? node.className).split(' ')[0]}`, right: Math.round(node.getBoundingClientRect().right - scroll.getBoundingClientRect().left + scroll.scrollLeft) })).sort((a, b) => b.right - a.right).slice(0, 3),
    };
  });
  assert.equal(geometry.missing && !geometry.empty, false, `${label}: the topology canvas is rendered`);
  if (geometry.missing) return;
  assert.deepEqual(geometry.overlaps, [], `${label}: no two boxes overlap`);
  assert.deepEqual(geometry.outsideBand, [], `${label}: every box lies inside its band, below its turn header`);
  assert.deepEqual(geometry.edgeProblems, [], `${label}: every edge starts and ends on its boxes' borders`);
  assert.deepEqual(geometry.edgeSamples, [], `${label}: no edge crosses another box`);
  assert.equal(geometry.mapOverflow, false, `${label}: the map itself has no horizontal overflow`);
  assert.equal(geometry.toolbarOverflow, false, `${label}: the toolbar has no horizontal overflow`);
  assert.equal(geometry.summaryOverflow, false, `${label}: the summary has no horizontal overflow`);
  if (geometry.scrollLeftOverflow) assert.ok(geometry.minimumWorld > geometry.scrollClientWidth + 1, `${label}: the world scrolls horizontally only because ${geometry.columns} minimum-width columns do not fit ${geometry.scrollClientWidth} px (scrollWidth ${geometry.scrollWidth}; widest ${JSON.stringify(geometry.widest)})`);
}
async function revealBox(nodeId) {
  const box = await page.evaluate(nodeId => window.qaTaskMap.boxForNode(nodeId), nodeId);
  assert.ok(box, `node ${nodeId} has a box in the expanded layout`);
  await page.locator('.task-graph-scroll').evaluate((scroll, target) => { scroll.scrollLeft = 0; scroll.scrollTop = Math.max(0, target.y - 120); }, box);
  const locator = page.locator(`.task-graph-box[data-box-id=${JSON.stringify(box.id)}]`);
  await locator.waitFor(); return locator;
}
async function revealBand(phase, mode = 'all') {
  const layout = await page.evaluate(mode => window.qaTaskMap.layoutInfo(mode), mode);
  const band = layout.bands.find(candidate => candidate.phase === phase);
  assert.ok(band, `phase ${phase} has a band in the ${mode} layout`);
  await page.locator('.task-graph-scroll').evaluate((scroll, top) => { scroll.scrollTop = Math.max(0, top); }, band.top);
  await page.locator(`.task-graph-band[data-phase="${phase}"]`).first().waitFor();
  return layout;
}
async function expandAll() {
  const button = page.locator('.task-map-expand');
  if (/Expand all|\u5168\u90e8\u5c55\u5f00/.test(await button.innerText())) await button.click();
}
// The button toggles all \u2194 none; from the default expansion it first offers "Expand all".
async function collapseAll() {
  const button = page.locator('.task-map-expand');
  if (/Expand all|\u5168\u90e8\u5c55\u5f00/.test(await button.innerText())) await button.click();
  if (/Collapse all|\u5168\u90e8\u6536\u8d77/.test(await button.innerText())) await button.click();
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

  // Step 14: theme × locale × width matrix for the two dense fixtures, plus the narrow default of every fixture.
  for (const fixture of ['parallel', 'long']) for (const theme of ['dark', 'light', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 480]) {
    await render({ fixture, theme, locale }, width);
    await assertGraphGeometry(`${fixture} ${theme}/${locale}/${width}`);
    await assertControls('.task-map-toolbar', `toolbar ${fixture} ${theme}/${locale}/${width}`);
    await screenshot(`${fixture}-${theme}-${locale}-${width}.png`);
  }
  for (const fixture of ['delegation', 'single', 'empty', 'running', 'long', 'nested', 'parallel']) {
    await render({ fixture, theme: 'dark', locale: 'en' }, 480);
    await assertGraphGeometry(`${fixture} narrow`); await screenshot(`${fixture}-narrow.png`);
  }

  // Step 2: every fixture's default view — the last band open, settled older bands folded, scrolled to the bottom.
  for (const fixture of ['delegation', 'single', 'empty', 'long', 'running', 'nested', 'parallel']) {
    await render({ fixture, theme: 'dark', locale: 'en' });
    const phases = (await page.evaluate(() => window.qaTaskMap.graphInfo())).phases;
    if (phases.length) await until(() => page.evaluate(() => { const scroll = document.querySelector('.task-graph-scroll'); return !scroll || scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 24; }), `${fixture}: starts scrolled to the bottom`, 3_000);
    const view = await page.evaluate(() => {
      const scroll = document.querySelector('.task-graph-scroll');
      return {
        bands: [...document.querySelectorAll('.task-graph-band')].map(band => ({ phase: Number(band.dataset.phase), open: band.dataset.open })),
        atBottom: scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : 0,
        boxes: document.querySelectorAll('.task-graph-box').length,
        note: Boolean(document.querySelector('.task-map .note')),
      };
    });
    if (!phases.length) {
      assert.equal(view.bands.length, 0, `${fixture}: a graph without turns draws no bands`);
      assert.ok(view.note, `${fixture}: an empty map shows the empty state`);
    } else {
      const last = phases.at(-1).index;
      for (const band of view.bands) {
        const phase = phases.find(candidate => candidate.index === band.phase);
        const expected = band.phase === last || phase.status === 'running' || phase.status === 'waiting';
        assert.equal(band.open, expected ? 'true' : 'false', `${fixture}: band ${band.phase} (${phase.status}) open state follows the default expansion`);
      }
      assert.ok(view.bands.some(band => band.phase === last), `${fixture}: the last band is rendered at the bottom`);
      assert.ok(view.atBottom <= 24, `${fixture}: the scroll area starts at the bottom (${view.atBottom} px away)`);
      assert.ok(view.bands.some(band => band.open === 'true'), `${fixture}: the default view shows one open band`);
    }
    await assertGraphGeometry(`${fixture} default`); await screenshot(`${fixture}-default.png`);
  }

  // Steps 3-5: folded topology, column reuse and the Expand/Collapse all flip on `parallel`.
  await render({ fixture: 'parallel', theme: 'dark', locale: 'en', sync: false });
  const parallel = await page.evaluate(() => window.qaTaskMap.graphInfo());
  assert.equal(parallel.phases.length, 3, 'parallel fixture has three turns');
  const rootLane = parallel.lanes.find(lane => lane.kind === 'agent').id;
  const claudeLane = parallel.lanes.find(lane => lane.kind === 'delegate' && lane.provider === 'claude').id;
  const kimiLane = parallel.lanes.find(lane => lane.kind === 'delegate' && lane.provider === 'kimi').id;
  const grokLane = parallel.lanes.find(lane => lane.kind === 'delegate' && lane.provider === 'grok').id;
  assert.ok(claudeLane && kimiLane && grokLane, 'parallel fixture has Claude, Kimi and Grok delegate lanes');
  await collapseAll();
  await until(() => page.evaluate(() => [...document.querySelectorAll('.task-graph-band')].every(band => band.dataset.open === 'false')), 'Collapse all folds every rendered band');
  await assertGraphGeometry('parallel collapsed');
  await revealBand(0, 'none');
  await page.locator('.task-graph-band[data-phase="0"]').waitFor();
  const folded = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.task-graph-box')].filter(box => Number(box.dataset.phase) === 0).map(box => ({ id: box.dataset.boxId, kind: box.dataset.boxKind, laneId: box.dataset.laneId, column: Number(box.dataset.column), top: box.getBoundingClientRect().top }));
    const edges = [...document.querySelectorAll('path.task-graph-edge')].map(path => ({ kind: path.dataset.edgeKind, from: path.dataset.from, to: path.dataset.to }));
    return { columns: Number(document.querySelector('.task-map').dataset.columns), boxes, edges };
  });
  const laneBox = laneId => folded.boxes.find(box => box.laneId === laneId);
  for (const laneId of [rootLane, claudeLane, kimiLane]) {
    const box = laneBox(laneId);
    assert.ok(box, `folded turn 1 has one box for lane ${laneId}`);
    assert.equal(box.kind, 'summary', `folded turn 1 lane ${laneId} is a summary box`);
    assert.ok(Math.abs(box.top - laneBox(rootLane).top) <= 1, 'folded turn 1 keeps every lane on one row');
  }
  assert.equal(folded.boxes.filter(box => box.laneId !== 'outputs').length, 3, 'folded turn 1 draws the root, Claude and Kimi lanes only');
  const edgeBetween = (from, to) => folded.edges.find(edge => edge.from === laneBox(from).id && edge.to === laneBox(to).id);
  for (const child of [claudeLane, kimiLane]) {
    assert.equal(edgeBetween(rootLane, child)?.kind, 'delegate', `folded turn 1 has a delegate edge from root to ${child}`);
    assert.equal(edgeBetween(child, rootLane)?.kind, 'return', `folded turn 1 has a return edge from ${child} to root`);
  }
  const outputs = parallel.nodes.filter(node => node.phase === 0 && (node.kind === 'files' || node.kind === 'document'));
  assert.equal(outputs.filter(node => node.kind === 'files').length, 2, 'folded turn 1 keeps both files outputs');
  assert.equal(outputs.filter(node => node.kind === 'document').length, 1, 'folded turn 1 keeps the pinned document');
  for (const node of outputs) {
    const box = folded.boxes.find(candidate => candidate.id === node.id);
    assert.ok(box, `output node ${node.id} keeps its own box`);
    assert.equal(box.column, folded.columns - 1, `output ${node.id} sits in the last column`);
    assert.equal(folded.edges.find(edge => edge.to === box.id)?.kind, 'produce', `output ${node.id} has a produce edge`);
  }
  await screenshot('parallel-folded.png');

  await expandAll();
  await until(() => page.evaluate(() => [...document.querySelectorAll('.task-graph-band')].every(band => band.dataset.open === 'true')), 'Expand all opens every rendered band');
  await assertGraphGeometry('parallel expanded');
  await revealBand(0);
  const expandedTurn1 = await page.evaluate(() => [...document.querySelectorAll('.task-graph-box')].filter(box => Number(box.dataset.phase) === 0).map(box => ({ laneId: box.dataset.laneId, column: Number(box.dataset.column) })));
  const expandedColumns = Number(await page.locator('.task-map').getAttribute('data-columns'));
  await revealBand(1);
  const expandedTurn2 = await page.evaluate(() => [...document.querySelectorAll('.task-graph-box')].filter(box => Number(box.dataset.phase) === 1).map(box => ({ laneId: box.dataset.laneId, column: Number(box.dataset.column) })));
  const lanesIn = (boxes, laneId) => [...new Set(boxes.filter(box => box.laneId === laneId).map(box => box.column))];
  assert.deepEqual(lanesIn(expandedTurn1, claudeLane), [1], 'Claude runs in column 1 in turn 1');
  assert.deepEqual(lanesIn(expandedTurn1, kimiLane), [2], 'Kimi runs in column 2 in turn 1');
  assert.deepEqual(lanesIn(expandedTurn2, grokLane), [1], 'Grok reuses column 1 in turn 2');
  assert.equal(expandedColumns, 4, 'the parallel fixture lays out four columns');
  await screenshot('parallel-expanded.png');
  await assertGraphGeometry('parallel expanded after scroll');

  // Step 6: summary unfold — a folded band opens and selects a box of its lane.
  await collapseAll();
  await until(() => page.evaluate(() => [...document.querySelectorAll('.task-graph-band')].every(band => band.dataset.open === 'false')), 'Collapse all folds the bands again');
  await revealBand(0, 'none');
  const summary = page.locator(`.task-graph-box[data-phase="0"][data-box-kind="summary"][data-lane-id=${JSON.stringify(rootLane)}]`);
  await summary.click();
  await until(() => page.evaluate(() => document.querySelector('.task-graph-band[data-phase="0"]')?.dataset.open === 'true'), 'clicking a summary box opens its band');
  await page.locator(`.task-graph-box.is-selected[data-box-kind="node"][data-lane-id=${JSON.stringify(rootLane)}]`).waitFor();
  await assertGraphGeometry('parallel summary unfold');

  // Step 7: lane fold — the head box folds its lane into a summary box, which unfolds it again.
  const headInfo = (await page.evaluate(() => window.qaTaskMap.layoutInfo('all'))).boxes.find(box => box.laneId === claudeLane && box.head);
  assert.ok(headInfo, 'Claude lane has a head box in the expanded layout');
  await page.locator('.task-graph-scroll').evaluate((scroll, top) => { scroll.scrollTop = Math.max(0, top); }, headInfo.y - 120);
  const head = page.locator(`.task-graph-box[data-box-id=${JSON.stringify(headInfo.id)}]`);
  await head.waitFor();
  assert.ok((await head.getAttribute('class')).includes('is-head'), 'the first box of a delegate lane is its head');
  await head.hover();
  // The fold button is the head box's next sibling (a button cannot nest inside a button).
  await page.locator(`.task-graph-box[data-box-id=${JSON.stringify(headInfo.id)}] + .task-graph-fold`).click();
  const laneSummary = page.locator(`.task-graph-box[data-box-kind="summary"][data-box-id^=${JSON.stringify(`fold:${claudeLane}:`)}]`);
  await laneSummary.waitFor();
  assert.equal(Number(await laneSummary.getAttribute('data-column')), 1, 'the folded lane summary stays in Claude column');
  await assertGraphGeometry('parallel lane folded');
  await laneSummary.click();
  await until(() => page.evaluate(laneId => document.querySelectorAll(`.task-graph-box[data-lane-id="${laneId}"]`).length > 1, claudeLane), 'clicking the lane summary unfolds the lane');
  await assertGraphGeometry('parallel lane unfolded');
  await screenshot('parallel-lane-unfolded.png');

  // Step 8: the details panel for every node kind, its docking, Escape and the summary member list.
  await render({ fixture: 'delegation', theme: 'dark', locale: 'en', sync: false });
  const delegation = await page.evaluate(() => window.qaTaskMap.graphInfo());
  const targets = new Map(delegation.targets);
  assert.ok(await page.evaluate(() => (window.qaTaskMap.state.requests['session.documents.list'] || 0) >= 1), 'the map loads the root session documents');
  await expandAll();
  for (const kind of ['tools', 'reply', 'plan', 'delegate', 'subagent', 'approval', 'question', 'error', 'files', 'document']) {
    if (await page.locator('aside.task-graph-details').count()) { await page.keyboard.press('Escape'); await page.locator('aside.task-graph-details').waitFor({ state: 'detached' }); }
    const node = delegation.nodes.find(node => node.kind === kind);
    assert.ok(node, `delegation fixture contains a ${kind} node`);
    const box = await revealBox(node.id);
    const boxId = await box.getAttribute('data-box-id');
    await box.click();
    const panel = page.locator(`aside.task-graph-details[data-box-id=${JSON.stringify(boxId)}]`);
    await panel.waitFor();
    assert.equal(await panel.getAttribute('data-docked'), 'right', `${kind}: the details panel docks right at 1440 px`);
    assert.ok(await panel.locator('.task-map-details').count(), `${kind}: the panel renders TaskMapDetails`);
    if (kind === 'tools') assert.ok(await panel.locator('.chat-tool-entry.tool-card').count(), 'tools render the Chat tool cards');
    if (kind === 'subagent') {
      await panel.getByRole('button', { name: 'Load transcript', exact: true }).click();
      await panel.getByText('Fixture subagent transcript.', { exact: true }).waitFor();
    }
    if (targets.get(node.id)) assert.ok(await panel.getByRole('button', { name: 'Show in Chat', exact: true }).count(), `${kind} has Show in Chat`);
    await assertGraphGeometry(`details ${kind}`); await screenshot(`details-${kind}.png`);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.boxId), boxId, `${kind}: Escape closes the panel and keeps focus on the box`);
  }
  for (const width of [700, 480]) {
    await render({ fixture: 'delegation', theme: 'dark', locale: 'en', sync: false }, width);
    const narrow = await page.evaluate(() => window.qaTaskMap.graphInfo());
    await expandAll();
    const box = await revealBox(narrow.nodes.find(node => node.kind === 'tools').id);
    const boxId = await box.getAttribute('data-box-id');
    await box.click();
    const panel = page.locator(`aside.task-graph-details[data-box-id=${JSON.stringify(boxId)}]`);
    await panel.waitFor();
    assert.equal(await panel.getAttribute('data-docked'), 'bottom', `${width} px: the details panel docks to the bottom`);
    await page.keyboard.press('Escape');
  }
  await render({ fixture: 'parallel', theme: 'dark', locale: 'en', sync: false });
  await collapseAll();
  await revealBand(0, 'none');
  const memberSummary = page.locator('.task-graph-box[data-phase="0"][data-box-kind="summary"]').first();
  await memberSummary.focus();
  await page.keyboard.press('Space');
  const memberPanel = page.locator('aside.task-graph-details');
  await memberPanel.waitFor();
  const members = memberPanel.locator('.task-graph-members .task-graph-member');
  await members.first().waitFor();
  assert.ok(await members.count() > 1, 'Space on a summary lists its members');
  const memberIds = await members.evaluateAll(nodes => nodes.map(node => node.dataset.nodeId));
  const parallelNodes = (await page.evaluate(() => window.qaTaskMap.graphInfo())).nodes;
  const memberId = memberIds.find(id => parallelNodes.find(node => node.id === id)?.kind !== 'prompt');
  assert.ok(memberId, 'the summary member list contains a step');
  await page.locator(`aside.task-graph-details .task-graph-member[data-node-id=${JSON.stringify(memberId)}]`).click();
  await page.locator(`.task-graph-box.is-selected[data-node-id=${JSON.stringify(memberId)}]`).waitFor();
  await assertGraphGeometry('summary member selected');
  await screenshot('summary-members.png');
  await page.keyboard.press('Escape');
  report.checks.push('graph geometry, default view, folded/expanded parallel topology, column reuse, summary unfold, lane fold, details kinds and docking, summary members');

  await render({ fixture: 'delegation', promptLess: true, theme: 'light', locale: 'en', sync: false });
  await expandAll();
  // Bands are windowed: scroll to the first turn and address it by phase, not by DOM order.
  await page.locator('.task-graph-scroll').evaluate(scroll => { scroll.scrollTop = 0; });
  const promptlessBand = page.locator('.task-graph-band[data-phase="0"]');
  const promptlessToggle = promptlessBand.locator('.task-graph-turn-toggle');
  await promptlessToggle.click();
  await until(async () => (await promptlessBand.getAttribute('data-open')) === 'false', 'a prompt-less turn folds safely');
  await promptlessToggle.click();
  await until(async () => (await promptlessBand.getAttribute('data-open')) === 'true', 'a prompt-less turn opens safely');
  await assertGraphGeometry('prompt-less turn');
  await page.locator('.task-graph-box').first().focus();
  const escapeBefore = await page.evaluate(() => window.qaEscapeBubbles);
  await page.keyboard.press('Space'); await page.locator('aside.task-graph-details').waitFor();
  await page.keyboard.press('Escape'); await page.locator('aside.task-graph-details').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.qaEscapeBubbles), escapeBefore, 'Escape closing details stays inside the map');
  // The second Escape clears the selection (still inside the map); only an Escape with nothing to do bubbles.
  await page.keyboard.press('Escape'); await until(async () => await page.locator('.task-graph-box.is-selected').count() === 0, 'a second Escape clears the selection');
  assert.equal(await page.evaluate(() => window.qaEscapeBubbles), escapeBefore, 'Escape clearing the selection stays inside the map');
  await page.keyboard.press('Escape'); assert.ok((await page.evaluate(() => window.qaEscapeBubbles)) > escapeBefore, 'unhandled Escape reaches workspace');

  // Step 9: the sticky turn header inside an open band, pushed up by the next band's header.
  await render({ fixture: 'long', theme: 'dark', locale: 'en', sync: false });
  await expandAll();
  const longLayout = await page.evaluate(() => window.qaTaskMap.layoutInfo('all'));
  const longPhases = (await page.evaluate(() => window.qaTaskMap.graphInfo())).phases;
  const middleBand = longLayout.bands[Math.floor(longLayout.bands.length / 2)];
  const middleLabel = longPhases.find(phase => phase.index === middleBand.phase).label;
  await page.locator('.task-graph-scroll').evaluate((scroll, top) => { scroll.scrollTop = top; }, middleBand.top + 60);
  await until(() => page.evaluate(label => (document.querySelector('.task-graph-sticky-turn')?.textContent ?? '').includes(label), middleLabel), 'the sticky header shows the scrolled band');
  assert.ok((await page.locator('.task-graph-sticky-turn').innerText()).includes(middleLabel), `the sticky header shows ${middleLabel}`);
  const stickyBox = await page.locator('.task-graph-sticky-turn').boundingBox(), scrollBox = await page.locator('.task-graph-scroll').boundingBox();
  assert.ok(Math.abs(stickyBox.y - scrollBox.y) <= 1, 'the sticky header sits at the top of the scroll area');
  const nextBandInfo = longLayout.bands.find(band => band.phase === middleBand.phase + 1);
  await page.locator('.task-graph-scroll').evaluate((scroll, top) => { scroll.scrollTop = top; }, nextBandInfo.top - 20);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pushedBox = await page.locator('.task-graph-sticky-turn').boundingBox();
  const nextHeaderBox = await page.locator(`.task-graph-band[data-phase="${nextBandInfo.phase}"] .task-graph-turn`).boundingBox();
  assert.ok(pushedBox.y + pushedBox.height <= nextHeaderBox.y + 1, 'the next turn header pushes the sticky header up');
  await screenshot('long-sticky-turn.png');
  report.longRenderedBoxes = await page.locator('.task-graph-box').count();
  report.longTotalBoxes = Number(await page.locator('.task-map').getAttribute('data-box-count'));
  assert.ok(report.longTotalBoxes > 2_000, 'the expanded long fixture has thousands of boxes');
  assert.ok(report.longRenderedBoxes < 200, 'the expanded long fixture renders only a window of boxes');

  // Step 12: keyboard navigation over boxes, band headers and the details panel.
  await render({ fixture: 'delegation', theme: 'dark', locale: 'en', sync: false });
  await expandAll();
  await revealBand(0);
  const rootBox = page.locator('.task-graph-box[data-column="0"]').first();
  await rootBox.scrollIntoViewIfNeeded(); await rootBox.focus();
  const startBox = await page.evaluate(() => ({ id: document.activeElement.dataset.boxId, column: Number(document.activeElement.dataset.column), top: document.activeElement.getBoundingClientRect().top }));
  await page.keyboard.press('ArrowDown');
  await until(() => page.evaluate(startId => document.activeElement?.dataset?.boxId !== startId, startBox.id), 'ArrowDown moves the focus');
  const down = await page.evaluate(() => ({ box: document.activeElement.dataset.boxId ? { column: Number(document.activeElement.dataset.column), top: document.activeElement.getBoundingClientRect().top } : undefined, header: Boolean(document.activeElement.closest('.task-graph-turn')) }));
  assert.ok(down.header || (down.box && down.box.column === startBox.column && down.box.top > startBox.top), 'ArrowDown moves down a column or onto a band header');
  await rootBox.focus(); await page.keyboard.press('ArrowRight');
  await until(() => page.evaluate(column => Number(document.activeElement?.dataset?.column) > column, startBox.column), 'ArrowRight moves the focus to a larger column');
  const rightColumn = await page.evaluate(() => document.activeElement.dataset.column ? Number(document.activeElement.dataset.column) : undefined);
  assert.ok(rightColumn !== undefined && rightColumn > startBox.column, 'ArrowRight moves to a box in a larger column');
  await page.keyboard.press('Home');
  await until(() => page.evaluate(() => { const element = document.activeElement, scroll = document.querySelector('.task-graph-scroll'); const rect = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect(); return Boolean(element.dataset.boxId) && element === document.querySelector('.task-graph-box') && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1; }), 'Home focuses the first box inside the viewport');
  await page.keyboard.press('End');
  await until(() => page.evaluate(() => { const element = document.activeElement, scroll = document.querySelector('.task-graph-scroll'); const rect = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect(); return Boolean(element.dataset.boxId) && element === [...document.querySelectorAll('.task-graph-box')].at(-1) && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1; }), 'End focuses the last box inside the viewport');
  const lastBoxId = await page.evaluate(() => document.activeElement.dataset.boxId);
  await page.keyboard.press('Enter');
  await page.locator(`aside.task-graph-details[data-box-id=${JSON.stringify(lastBoxId)}]`).waitFor();
  await assertGraphGeometry('keyboard details');
  await page.keyboard.press('Escape');
  report.checks.push('sticky turn header and push-up, keyboard arrows/Home/End/Enter, box windowing');

  // Step 10: the lane strip follows horizontal scrolling at 480 px.
  await render({ fixture: 'parallel', theme: 'dark', locale: 'en', sync: false }, 480);
  await expandAll();
  await page.locator('.task-graph-scroll').evaluate(scroll => { scroll.scrollLeft = 60; scroll.scrollTop = 0; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const laneStrip = await page.evaluate(() => {
    const scroll = document.querySelector('.task-graph-scroll');
    return {
      scrollLeft: scroll.scrollLeft,
      labels: [...document.querySelectorAll('.task-graph-lane-label')].map(label => ({ column: Number(label.dataset.column), left: label.getBoundingClientRect().left })),
      boxes: [...document.querySelectorAll('.task-graph-box')].map(box => ({ column: Number(box.dataset.column), left: box.getBoundingClientRect().left })),
    };
  });
  assert.ok(laneStrip.scrollLeft > 0, 'the narrow parallel world scrolls horizontally');
  assert.ok(laneStrip.labels.length > 1, 'the lane strip labels several columns');
  for (const label of laneStrip.labels) {
    const box = laneStrip.boxes.find(box => box.column === label.column);
    if (!box) continue;
    assert.ok(Math.abs(label.left - box.left) <= 1, `the lane label of column ${label.column} follows its boxes`);
  }
  await screenshot('parallel-lane-strip-480.png');
  await assertGraphGeometry('parallel narrow lane strip');

  // Step 11: the overview strip scrolls the canvas and mirrors the viewport.
  await render({ fixture: 'long', theme: 'dark', locale: 'en', sync: false });
  await expandAll();
  const overviewCanvas = page.locator('.task-graph-overview canvas');
  await overviewCanvas.waitFor();
  const canvasBox = await overviewCanvas.boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height * 0.25);
  await pause(120);
  const overview = await page.evaluate(() => {
    const scroll = document.querySelector('.task-graph-scroll');
    return { scrollTop: scroll.scrollTop, range: scroll.scrollHeight - scroll.clientHeight, viewportTop: document.querySelector('.task-graph-overview-viewport').getBoundingClientRect().top };
  });
  assert.ok(Math.abs(overview.scrollTop - overview.range * 0.25) <= overview.range * 0.1, `a click at 25% of the overview scrolls to ${Math.round(overview.scrollTop)} of ${overview.range}`);
  await page.locator('.task-graph-scroll').evaluate(scroll => { scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.8; });
  // The hidden QA window gets no rendering frames on its own, so a programmatic scroll fires no `scroll` event until
  // something requests a frame; waitForFunction polls on animation frames.
  await page.waitForFunction(before => document.querySelector('.task-graph-overview-viewport').getBoundingClientRect().top > before + 1, overview.viewportTop, { timeout: 3_000 })
    .catch(() => {});
  const movedViewportTop = await page.evaluate(() => document.querySelector('.task-graph-overview-viewport').getBoundingClientRect().top);
  assert.ok(movedViewportTop > overview.viewportTop + 1, `the overview viewport moves with scrolling (${overview.viewportTop} → ${movedViewportTop})`);
  await screenshot('long-overview.png');
  await assertGraphGeometry('long overview scrolled');
  report.checks.push('lane strip at 480 px, overview click and viewport');

  await page.locator('.task-map-toolbar [role="combobox"]').click(); await page.getByRole('option').nth(5).click();
  await until(() => page.evaluate(() => { const scroll = document.querySelector('.task-graph-scroll'); const rect = scroll.getBoundingClientRect(); return [...document.querySelectorAll('.task-graph-band')].some(band => band.dataset.open === 'true' && Math.abs(band.getBoundingClientRect().top - rect.top) <= 2); }), 'turn picker opens and aligns the chosen turn');

  await render({ fixture: 'long', theme: 'dark', locale: 'en', focusTurn: 3 });
  await until(() => page.evaluate(() => { const scroll = document.querySelector('.task-graph-scroll'); const band = document.querySelector('.task-graph-band[data-phase="3"]'); return band?.dataset.open === 'true' && Math.abs(band.getBoundingClientRect().top - scroll.getBoundingClientRect().top) <= 2; }), 'item focus opens and aligns an old root band');
  await render({ fixture: 'nested', theme: 'dark', locale: 'en', focusSession: 'grok' });
  await page.locator('.task-graph-box.is-selected[data-node-kind="delegate"].chat-message-highlight').waitFor();
  const focusedDelegate = await page.locator('.task-graph-box.is-selected').getAttribute('data-node-id');
  const focusedNode = (await page.evaluate(() => window.qaTaskMap.graphInfo())).nodes.find(node => node.id === focusedDelegate);
  assert.equal(focusedNode.childSessionId, 'grok', 'delegate focus opens its ancestors and selects its delegate box');
  await assertGraphGeometry('delegate focus');
  await screenshot('delegate-focus.png');

  // Step 13: Chat sync through the chatFlowSync seam.
  await render({ fixture: 'long', theme: 'dark', locale: 'en' });
  const synced = await page.evaluate(() => window.qaTaskMap.simulateChat());
  const bandSelector = `.task-graph-band[data-band-key=${JSON.stringify(synced.turnKey)}]`;
  const markedSelector = `.task-graph-box.is-in-view[data-phase="${synced.phase}"]`;
  await until(() => page.evaluate(selector => document.querySelector(selector)?.dataset.open === 'true', bandSelector), 'Chat auto-opens an old band');
  await page.locator(markedSelector).first().waitFor();
  await until(() => page.evaluate(selector => { const scroll = document.querySelector('.task-graph-scroll'); const box = document.querySelector(selector); if (!box) return false; const rect = box.getBoundingClientRect(), viewport = scroll.getBoundingClientRect(); return rect.top >= viewport.top && rect.bottom <= viewport.bottom; }, markedSelector), 'the guarded auto-scroll reveals the marked boxes', 4_000);
  const scrollBeforeClick = await page.locator('.task-graph-scroll').evaluate(scroll => scroll.scrollTop);
  const syncedBox = page.locator(markedSelector).first();
  await syncedBox.click();
  assert.deepEqual((await page.evaluate(() => window.qaTaskMap.reveals)).at(-1), synced.target, 'box click reveals the exact item/tool target');
  await pause(200);
  assert.ok(Math.abs((await page.locator('.task-graph-scroll').evaluate(scroll => scroll.scrollTop)) - scrollBeforeClick) <= 1, 'a Chat reveal does not move the canvas');
  await assertGraphGeometry('sync old band');
  await screenshot('sync-old-turn.png');
  await page.evaluate(() => window.qaTaskMap.simulateChat(true));
  await page.locator(markedSelector).first().click();
  await page.locator('aside.task-graph-details').waitFor();
  assert.equal(await page.locator('aside.task-graph-details').getAttribute('data-box-id'), await syncedBox.getAttribute('data-box-id'), 'a reveal miss falls back to the details');
  await page.keyboard.press('Escape'); await page.locator('aside.task-graph-details').waitFor({ state: 'detached' });
  await page.locator('.task-map-sync').click();
  assert.equal(await page.evaluate(() => window.qaTaskMap.watched()), false, 'Sync off removes every Chat watcher');
  assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.taskMap.sync')), 'off', 'Sync preference persists');
  await expandAll();
  const unsynced = await revealBox(synced.nodeId);
  await unsynced.click(); await page.locator('aside.task-graph-details').waitFor();
  assert.equal(await page.locator('aside.task-graph-details').getAttribute('data-box-id'), await unsynced.getAttribute('data-box-id'), 'with Sync off a box click opens the details');
  await page.evaluate(() => window.qaTaskMap.setVisible(false));
  assert.equal(await page.evaluate(() => window.qaTaskMap.watched()), false, 'hidden maps have no Chat watchers');
  report.checks.push('sync auto-open, marked boxes, guarded auto-scroll, reveal target, reveal miss and Sync off');

  await render({ fixture: 'running', theme: 'dark', locale: 'en' });
  await screenshot('running-before-live-events.png');
  const initialCount = Number(await page.locator('.task-map').getAttribute('data-node-count')); const beforeLive = await page.evaluate(() => window.qaTaskMap.state.requests['chat.snapshot'] || 0);
  const initialPhases = (await page.evaluate(() => window.qaTaskMap.graphInfo())).phases.length;
  await page.evaluate(() => { for (let index = 1; index <= 3; index++) window.qaTaskMap.emit(window.qaTaskMap.liveItem(index)); });
  // Each live user message opens a new turn (a band stands for its prompt); earlier finished turns may fold.
  await until(async () => Number(await page.locator('.task-map').getAttribute('data-node-count')) >= initialCount + 3
    && (await page.evaluate(() => window.qaTaskMap.graphInfo())).phases.length >= initialPhases + 3, 'three live turns within one second', 2_000);
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
  await until(() => page.evaluate(() => Number.isFinite(window.qaLongFirstNodePaintMs)), 'long fixture first box paint');
  report.timings.longFirstBoxMs = await page.evaluate(() => window.qaLongFirstNodePaintMs);
  assert.ok(report.timings.longFirstBoxMs < 2_000, 'development first box budget; production has the strict budget');
  await expandAll();
  await until(async () => Number(await page.locator('.task-map').getAttribute('data-box-count')) > 2_000, 'the long fixture expands into thousands of boxes');
  report.longRenderedBoxes = await page.locator('.task-graph-box').count(); report.longTotalBoxes = Number(await page.locator('.task-map').getAttribute('data-box-count'));
  assert.ok(report.longRenderedBoxes < 200 && report.longRenderedBoxes < report.longTotalBoxes, 'long fixture virtualizes the expanded topology');
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
