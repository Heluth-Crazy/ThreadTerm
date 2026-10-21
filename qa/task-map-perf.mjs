// Performance check for the Task map (task 10-21-task-map, acceptance A4), on a production React build like the app:
//   1. the long fixture (200 turns, ~3,000 tool calls; all 200 turns shown) paints its first box < 300 ms after the root
//      snapshot arrives;
//   2. while 60 live `chat.item` events stream in (32 ms apart, like Codex), no main-thread task exceeds 120 ms and
//      the new boxes appear;
//   3. expanding all turns and scrolling the topology in 40 animation frames has no task > 50 ms and never mounts
//      more than 400 boxes;
//   4. with Sync on, a Chat publishing a new on-screen range every frame (sweeping all 200 turns) causes no task > 50 ms;
//   5. a hidden map does no request and no DOM work for the same events.
// Hidden Electron window; no runtime, no agent CLIs. Usage: node qa/task-map-perf.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'qa/results/task-map-perf');
const qaTemp = resolve(root, '..', 'tt-qa-temp');
await mkdir(qaTemp, { recursive: true });
process.env.TEMP = qaTemp; process.env.TMP = qaTemp;
const entry = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TaskMapView } from './renderer/src/components/TaskMapView';
import { taskMapFixture, taskMapFixtureLastTime } from './renderer/src/fixtures/taskMapFixtures';
import { publishChatView, registerChatHandle } from './renderer/src/chatFlowSync';
import './renderer/src/styles.css';
const fixture = taskMapFixture('long');
const listeners = new Set();
window.qa = { requests: 0, longTasks: [] };
localStorage.setItem('threadterm.taskMap.sync', 'off');
new PerformanceObserver(list => { for (const entry of list.getEntries()) window.qa.longTasks.push(entry.duration); }).observe({ entryTypes: ['longtask'] });
window.threadterm = {
  platform: 'win32',
  async request(method, params) {
    window.qa.requests += 1;
    if (method === 'chat.snapshot') {
      const items = structuredClone(fixture.items.get(params.sessionId) ?? []);
      window.qa.delivered = performance.now();
      const paint = () => requestAnimationFrame(() => document.querySelector('.task-graph-box') ? (window.qa.firstRow = performance.now() - window.qa.delivered) : paint());
      paint();
      return { items, revision: 1, repair: { available: false } };
    }
    if (method === 'session.documents.list') return fixture.documents ?? [];
    throw new Error('unexpected ' + method);
  },
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
let seq = 1000;
const last = taskMapFixtureLastTime(fixture);
window.qa.stream = (count, prefix) => new Promise(done => {
  let index = 0;
  const tick = () => {
    if (index >= count) { done(); return; }
    const at = new Date(last + 1000 + index * 1000).toISOString();
    const item = { id: prefix + '-' + index, role: 'assistant', createdAt: at, turnId: 'perf-live-turn', parts: [{ type: 'tool', toolId: prefix + '-tool-' + index, toolName: index % 2 ? 'Bash' : 'Read', status: 'completed', data: index % 2 ? { input: { command: 'node --check perf-' + index + '.mjs' } } : { input: { file_path: 'src/perf-' + index + '.ts' } } }] };
    for (const listener of listeners) listener({ v: 1, event: 'chat.item', epoch: 'perf', seq: ++seq, data: { sessionId: fixture.rootSessionId, item } });
    index += 1; setTimeout(tick, 32);
  };
  tick();
});
window.qa.syncSweep = async frames => {
  const handle = { shown: () => true, reveal: () => true };
  const stop = registerChatHandle(fixture.rootSessionId, handle);
  const rootItems = fixture.items.get(fixture.rootSessionId) ?? [];
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.floor(frame * (rootItems.length - 12) / frames), shown = rootItems.slice(start, start + 12);
    const tools = shown.flatMap(item => item.parts.flatMap((part, index) => part.type === 'tool' ? [part.toolId || item.id + ':part:' + index] : []));
    publishChatView(handle, { sessionId: fixture.rootSessionId, items: shown.map(item => item.id), tools, turns: [], following: false });
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  window.qa.inView = document.querySelectorAll('.task-graph-box.is-in-view').length;
  stop();
};
const host = document.getElementById('root');
host.style.cssText = 'position:fixed;inset:0;display:flex';
const app = createRoot(host);
window.qa.render = visible => app.render(<main className="pane-tab-surface" style={{display:'flex',flex:1}}><TaskMapView sessionId={fixture.rootSessionId} sessions={fixture.sessions} visible={visible} zh={false} /></main>);
window.qa.render(true);
`;
const scratch = await mkdtemp(join(qaTemp, 'tt-task-map-perf-'));
assert.ok(resolve(scratch).startsWith(qaTemp + sep), 'scratch stays within tt-qa-temp');
let app;
const report = { passed: false, metrics: {} };
try {
  await mkdir(out, { recursive: true });
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
  await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><div id="root"></div><script src="qa.js"></script>');
  await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  env.TEMP = qaTemp; env.TMP = qaTemp;
  app = await electron.launch({ args: ['--disable-gpu', join(scratch, 'main.cjs')], env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Number.isFinite(window.qa?.firstRow), undefined, { timeout: 30_000 });
  report.metrics.firstRowMs = await page.evaluate(() => window.qa.firstRow);
  report.metrics.initialBoxes = await page.locator('.task-graph-box').count();
  assert.ok(report.metrics.firstRowMs < 300, `first box after ${report.metrics.firstRowMs} ms (budget 300 ms)`);

  await page.waitForTimeout(500);
  const before = await page.evaluate(() => Number(document.querySelector('.task-map')?.getAttribute('data-box-count')));
  await page.evaluate(() => { window.qa.longTasks.length = 0; });
  await page.evaluate(() => window.qa.stream(60, 'live'));
  await page.waitForFunction(count => Number(document.querySelector('.task-map')?.getAttribute('data-box-count')) > count, before, { timeout: 5_000 });
  await page.locator('.task-graph-box[data-node-id*="live-"]').first().waitFor();
  report.metrics.streamBoxes = Number(await page.locator('.task-map').getAttribute('data-box-count'));
  assert.ok(report.metrics.streamBoxes > before, `streamed events added boxes (${before} → ${report.metrics.streamBoxes})`);
  report.metrics.streamLongTasksMs = await page.evaluate(() => [...window.qa.longTasks]);
  report.metrics.streamMaxTaskMs = Math.max(0, ...report.metrics.streamLongTasksMs);
  assert.ok(report.metrics.streamMaxTaskMs <= 120, `a main-thread task took ${report.metrics.streamMaxTaskMs} ms while streaming (budget 120 ms)`);

  await page.locator('.task-map-expand').click();
  await page.waitForFunction(() => Number(document.querySelector('.task-map')?.getAttribute('data-box-count')) > 2_000);
  await page.waitForTimeout(100);
  report.metrics.expandedBoxes = Number(await page.locator('.task-map').getAttribute('data-box-count'));
  report.metrics.expandedEdges = Number(await page.locator('.task-map').getAttribute('data-edge-count'));
  report.metrics.renderedBoxes = await page.locator('.task-graph-box').count();
  assert.ok(report.metrics.renderedBoxes < 200, 'expanded long fixture renders only a viewport window');
  report.metrics.scrollMaxBoxes = await page.evaluate(async () => {
    const scroll = document.querySelector('.task-graph-scroll'); scroll.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
    window.qa.longTasks.length = 0;
    let maxBoxes = 0, maxEdges = 0;
    for (let step = 0; step <= 40; step++) {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * step / 40;
      await new Promise(resolve => requestAnimationFrame(resolve));
      maxBoxes = Math.max(maxBoxes, document.querySelectorAll('.task-graph-box').length);
      maxEdges = Math.max(maxEdges, document.querySelectorAll('path.task-graph-edge').length);
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.qa.scrollStats = { boxes: maxBoxes, edges: maxEdges };
    return maxBoxes;
  });
  report.metrics.scrollMaxEdges = await page.evaluate(() => window.qa.scrollStats.edges);
  assert.ok(report.metrics.scrollMaxBoxes < 400, `at most ${report.metrics.scrollMaxBoxes} boxes were in the DOM while scrolling (budget 400)`);
  report.metrics.scrollLongTasksMs = await page.evaluate(() => [...window.qa.longTasks]);
  report.metrics.scrollMaxTaskMs = Math.max(0, ...report.metrics.scrollLongTasksMs);
  assert.ok(report.metrics.scrollMaxTaskMs <= 50, `scrolling took ${report.metrics.scrollMaxTaskMs} ms (budget 50 ms)`);

  await page.locator('.task-map-sync').click();
  await page.waitForFunction(() => document.querySelector('.task-map')?.dataset.sync === 'on');
  await page.evaluate(() => { window.qa.longTasks.length = 0; });
  await page.evaluate(() => window.qa.syncSweep(120));
  report.metrics.syncLongTasksMs = await page.evaluate(() => [...window.qa.longTasks]);
  report.metrics.syncMaxTaskMs = Math.max(0, ...report.metrics.syncLongTasksMs);
  report.metrics.syncMarkedBoxes = await page.evaluate(() => window.qa.inView);
  assert.ok(report.metrics.syncMarkedBoxes > 0, 'the synced Chat range marks boxes');
  assert.ok(report.metrics.syncMaxTaskMs <= 50, `a synced Chat sweep took ${report.metrics.syncMaxTaskMs} ms (budget 50 ms)`);

  await page.evaluate(() => window.qa.render(false));
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => ({ requests: window.qa.requests, html: document.querySelector('.task-map')?.innerHTML }));
  await page.evaluate(() => { window.qa.longTasks.length = 0; });
  await page.evaluate(() => window.qa.stream(60, 'hidden'));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ requests: window.qa.requests, html: document.querySelector('.task-map')?.innerHTML, longTasks: [...window.qa.longTasks] }));
  report.metrics.hiddenLongTasksMs = after.longTasks;
  assert.equal(after.requests, hidden.requests, 'a hidden map issues no requests');
  assert.equal(after.html, hidden.html, 'a hidden map does no DOM work');
  await page.screenshot({ path: join(out, 'after-stream.png') }).catch(() => {});
  report.passed = true;
  console.log(`TASK MAP PERF PASSED ${JSON.stringify(report.metrics)}`);
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.log(`TASK MAP PERF FAILED ${report.error}`);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  await app?.close().catch(() => {});
  assert.ok(resolve(scratch).startsWith(qaTemp + sep), 'cleanup stays within tt-qa-temp');
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
