// Isolated Electron probe for the sidebar's stability (owner report 11-19): opening a row's ⋯ menu must not reorder
// the rows, and on startup no project or branch row may open, close and open again. It renders the production
// ProjectCatalog with a synthetic bridge whose machine list and machine tree answer after IPC-like delays, and samples
// every frame from the first render. Never starts the runtime or an agent.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const scratch = await mkdtemp(join(resolve(process.env.TEMP ?? tmpdir()), 'threadterm-sidebar-stability-'));
const out = resolve('qa/results/sidebar-stability');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectCatalog } from './renderer/src/components/ProjectCatalog';
import { MachineProvider } from './renderer/src/machines';
import { I18nProvider } from './renderer/src/i18n';
import { CATALOG_FOLD_KEY, foldKey, writeCatalogFolds } from './renderer/src/catalogTidy';
import { machineTreeKey } from './renderer/src/machineTypes';
import './renderer/src/styles.css';

const scenario = new URLSearchParams(location.search);
const mode = scenario.get('mode') ?? 'local';
const project = {id:'proj', name:'cdispatching-service-workbench', path:'D:/qa/cdispatching', pinned:false, sortOrder:0, revision:0, git:{available:true}};
const workbench = {id:'tree-workbench', projectId:project.id, path:'D:/qa/cdispatching', branch:'feature-workbench-2026', isMain:true};
const jiaxiao = {id:'tree-jiaxiao', projectId:project.id, path:'D:/qa/cdispatching-jiaxiao', branch:'feature-jiaxiaomode-w', isMain:false};
const quiet = {id:'tree-quiet', projectId:project.id, path:'D:/qa/cdispatching-quiet', branch:'feature-quiet', isMain:false};
const session = (id, title, path, created, state, extra = {}) => ({id, title, projectId:project.id, worktreePath:path, provider:'codex', mode:'chat',
  status: state === 'running' ? 'running' : state === 'exited' ? 'exited' : 'idle', createdAt:created, updatedAt:created,
  activity:{state: state === 'exited' ? 'idle' : state, revision:1}, ...extra});
const sessions = [
  session('golden', '黄金指标场景', workbench.path, '2026-11-10T00:00:00Z', 'idle'),
  // Newer and idle above older and running: the display order; the old frozen order swapped them.
  session('readonly', '只读检查网页导航', jiaxiao.path, '2026-11-15T00:00:00Z', 'idle'),
  session('driving', '驾校模式', jiaxiao.path, '2026-11-01T00:00:00Z', 'running'),
  ...[1, 2, 3].map(n => session('driving-child-' + n, '子任务 ' + n, jiaxiao.path, '2026-11-0' + (n + 1) + 'T00:00:00Z', 'exited', {delegation:{parentSessionId:'driving', state:'completed'}})),
];
const selected = scenario.get('selected') ?? undefined;
// The saved folds: the branch of the selected chat was folded by the user last time.
const collapsed = scenario.get('collapsed');
try { localStorage.setItem(CATALOG_FOLD_KEY, writeCatalogFolds(collapsed ? {[foldKey('branch', collapsed)]: false} : {})); } catch {}
const listDelay = Number(scenario.get('listDelay') ?? 30), treeDelay = Number(scenario.get('treeDelay') ?? 90), expandDelay = Number(scenario.get('expandDelay') ?? 40);
let expanded = collapsed ? {[machineTreeKey('local', 'branch', collapsed)]: false} : {};
const treeListeners = new Set(), machineListeners = new Set(), listeners = new Set();
const machines = [{id:'local', name:'This PC', kind:'local'}, {id:'remote', name:'公司电脑', kind:'remote'}];
const feed = () => ({machines: machines.map(machine => ({machine, projects: [], sessions: []})), expanded: {...expanded}});
const calls = [];
window.threadterm = {
  machineId: 'local',
  onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async request(method, params) {
    calls.push(method);
    if (method === 'project.catalog.list') return [project];
    if (method === 'worktree.list') return [workbench, jiaxiao, quiet];
    if (method === 'group.list') return [];
    if (method === 'session.processes') return {sessions: []};
    if (method === 'catalog.visibility.list') return [];
    if (method === 'runtime.snapshot') return {sessions};
    throw Error('Unexpected fixture RPC ' + method);
  },
  ...(mode === 'shared' ? {
    machineList: () => { calls.push('machineList@' + Math.round(performance.now())); return new Promise(done => setTimeout(() => { calls.push('machineList-done@' + Math.round(performance.now())); done({enabled: true, currentId: 'local', machines}); }, listDelay)); },
    onMachinesChanged(fn) { machineListeners.add(fn); return () => machineListeners.delete(fn); },
    machineTree: () => { calls.push('machineTree@' + Math.round(performance.now())); return new Promise(done => setTimeout(() => { calls.push('machineTree-done@' + Math.round(performance.now())); done(feed()); }, treeDelay)); },
    onMachineTree(fn) { treeListeners.add(fn); return () => treeListeners.delete(fn); },
    machineExpand: (key, open) => new Promise(done => setTimeout(() => { expanded = {...expanded, [key]: open}; treeListeners.forEach(fn => fn(feed())); done(); }, expandDelay)),
    machineShow: async () => {}, machineSettings: async () => {},
  } : {}),
};

// Every frame from before the first render: each fold row's state and the order of the visible chats.
const frames = [];
const started = performance.now();
const sample = () => {
  const rows = [...document.querySelectorAll('.proj-row, .tree-row')].map(node => (node.classList.contains('proj-row') ? 'project ' : 'branch ') + (node.getAttribute('title')?.split('\\n')[0] ?? '') + '=' + node.getAttribute('aria-expanded'));
  const order = [...document.querySelectorAll('.sess-row[data-session-id]')].map(node => node.dataset.sessionId);
  const last = frames.at(-1);
  if (!last || JSON.stringify(last.rows) !== JSON.stringify(rows) || JSON.stringify(last.order) !== JSON.stringify(order)) frames.push({at: Math.round(performance.now() - started), rows, order});
};
// Every DOM change is a candidate frame: a hidden test window runs no animation frames, but mutations still fire.
new MutationObserver(sample).observe(document.getElementById('root'), {subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded']});
window.qaFrames = () => frames;
window.qaCalls = () => calls;

const root = createRoot(document.getElementById('root'));
root.render(<I18nProvider locale="zh-CN"><MachineProvider><aside style={{width:340, padding:12}}>
  <ProjectCatalog selectedProjectId={selected ? project.id : undefined} selectedWorktreePath={selected ? jiaxiao.path : undefined} selectedSessionId={selected} sessions={sessions}
    onAll={() => {}} onProject={() => {}} onWorktree={() => {}} onSession={() => {}} onChanged={() => {}} />
</aside></MachineProvider></I18nProvider>);
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}aside{flex-shrink:0;background:var(--surface)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{globalThis.qaWindow=new BrowserWindow({width:900,height:700,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});globalThis.qaWindow.loadURL("about:blank");});`);

const report = { passed: false, checks: [], scenarios: {}, errors: [] };
// Every check runs: a startup flicker usually breaks several rows at once, and all of them are worth seeing.
const failures = [];
const check = (label, condition, detail) => {
  if (condition) { report.checks.push(label); console.log(`PASS ${label}`); return; }
  failures.push(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  console.log(`FAIL ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
/** Each row's states in frame order; a stable row has exactly one. */
const rowStates = frames => {
  const states = new Map();
  for (const frame of frames) for (const row of frame.rows) {
    const [name, state] = row.split('=');
    const seen = states.get(name) ?? [];
    if (seen.at(-1) !== state) seen.push(state);
    states.set(name, seen);
  }
  return Object.fromEntries(states);
};
const orders = frames => frames.map(frame => frame.order.join(',')).filter((order, index, all) => order && order !== all[index - 1]);

let app, page, releaseLock;
try {
  releaseLock = await acquireElectronQaLock({ directory: resolve(process.env.TEMP ?? tmpdir()) });
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  await app.evaluate(async () => { while (!globalThis.qaWindow) await new Promise(done => setTimeout(done, 10)); });
  page = await app.firstWindow();
  const open = async search => {
    await app.evaluate(({}, url) => globalThis.qaWindow.loadURL(url), `file:///${join(scratch, 'index.html').replace(/\\/g, '/')}?${search}`);
    await page.waitForFunction(() => typeof window.qaFrames === 'function');
    await page.waitForTimeout(1700);
    return page.evaluate(() => window.qaFrames());
  };

  // ── A: the ⋯ menu of a row must not reorder any rows ──
  await open('mode=local');
  const visible = () => page.locator('.sess-row[data-session-id]').evaluateAll(nodes => nodes.map(node => node.dataset.sessionId));
  const before = await visible();
  check('the newer idle chat is listed above the older running one', before.indexOf('readonly') < before.indexOf('driving'), before);
  const goldenRow = page.locator('.sess-row-wrap[data-session-id="golden"]');
  await goldenRow.hover();
  await goldenRow.locator('.row-more').first().click();
  await page.locator('[role="menu"]').first().waitFor();
  await page.screenshot({ path: join(out, 'menu-open.png') });
  const during = await visible();
  check('opening a row menu keeps every row in place', JSON.stringify(during) === JSON.stringify(before), { before, during });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('closing the menu keeps every row in place', JSON.stringify(await visible()) === JSON.stringify(before));

  // ── B: startup with local folds, the selected chat's branch folded last time ──
  const local = await open(`mode=local&selected=driving&collapsed=${encodeURIComponent('D:/qa/cdispatching-jiaxiao')}`);
  report.scenarios.local = { rows: rowStates(local), orders: orders(local) };
  for (const [row, states] of Object.entries(report.scenarios.local.rows)) check(`local startup: ${row} appears once in its final state`, states.length === 1, states);
  check('local startup: the branch of the selected chat is open', report.scenarios.local.rows['branch feature-jiaxiaomode-w']?.at(-1) === 'true', report.scenarios.local.rows);
  check('local startup: the visible order never reshuffles', report.scenarios.local.orders.every((order, index, all) => index === 0 || order.startsWith(all[index - 1]) || all[index - 1].split(',').every(id => order.split(',').includes(id))), report.scenarios.local.orders);
  await page.screenshot({ path: join(out, 'local-startup.png') });

  // ── C: startup with two machines: the tree's folds come over IPC after the machine list ──
  const shared = await open(`mode=shared&selected=driving&collapsed=${encodeURIComponent('D:/qa/cdispatching-jiaxiao')}`);
  report.scenarios.shared = { rows: rowStates(shared), orders: orders(shared) };
  if (process.env.QA_SIDEBAR_FRAMES) console.log("CALLS", JSON.stringify(await page.evaluate(() => window.qaCalls())));
  if (process.env.QA_SIDEBAR_FRAMES) for (const frame of shared.filter((frame, index, all) => index === 0 || JSON.stringify(frame.rows) !== JSON.stringify(all[index - 1].rows))) console.log("FRAME", frame.at, JSON.stringify(frame.rows));
  for (const [row, states] of Object.entries(report.scenarios.shared.rows)) check(`shared startup: ${row} appears once in its final state`, states.length === 1, states);
  check('shared startup: the branch of the selected chat is open', report.scenarios.shared.rows['branch feature-jiaxiaomode-w']?.at(-1) === 'true', report.scenarios.shared.rows);
  await page.screenshot({ path: join(out, 'shared-startup.png') });

  // ── D: startup with two machines and nothing selected: saved folds are shown as saved ──
  const plain = await open(`mode=shared&collapsed=${encodeURIComponent('D:/qa/cdispatching-jiaxiao')}`);
  report.scenarios.plain = { rows: rowStates(plain) };
  for (const [row, states] of Object.entries(report.scenarios.plain.rows)) check(`shared startup without a selection: ${row} appears once`, states.length === 1, states);
  check('shared startup without a selection: the folded branch stays folded', report.scenarios.plain.rows['branch feature-jiaxiaomode-w']?.at(-1) === 'false', report.scenarios.plain.rows);
  report.failures = failures;
  assert.deepEqual(failures, [], `${failures.length} sidebar stability checks failed`);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await releaseLock?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, scenarios: report.scenarios, errors: report.errors.map(error => error.split('\n')[0]) }));
}
