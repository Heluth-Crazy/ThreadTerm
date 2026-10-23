// Isolated production-ChatView QA for the typed tool cards (B2) and the
// per-turn tool summary (B3). It bundles the renderer with a deterministic
// in-memory bridge and real corpus shapes; it never starts a runtime, provider,
// account, or user profile. Screenshots cover the matrix: wide (~1280) and
// ~420 px, light and dark, en and zh-CN, collapsed and expanded, plus a running
// command and the empty state.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-tool-cards-'));
const out = resolve('qa/results/chat-parity/B2/tool-cards');
await mkdir(out, { recursive: true });

// One representative native part per kind, read from the committed corpus.
const wanted = ['codex-filechange-multi', 'codex-command-complete', 'pi-bash-failed', 'claude-read', 'claude-grep', 'codex-websearch', 'claude-todo', 'claude-skill', 'codex-mcp', 'codex-image-view', 'codex-compaction', 'claude-generic'];
const providers = ['claude', 'codex', 'acp', 'grok', 'opencode', 'pi'];
const all = new Map();
for (const provider of providers) {
  const fixture = JSON.parse(await readFile(join(root, 'renderer/src/fixtures/tool-parts', `${provider}.json`), 'utf8'));
  for (const entry of fixture.cases) all.set(entry.id, entry.part);
}
const corpus = wanted.map(id => {
  const part = all.get(id);
  assert.ok(part, `corpus fixture ${id} is present`);
  // Flat arguments render as compact lines (10-20-delegation-tool-ux); nest the generic card's input so the
  // JSON disclosure checks below still have a tree to drive.
  return id === 'claude-generic' ? { ...part, data: { ...part.data, input: { ...part.data.input, options: { depth: 2, tags: ['a', 'b'] } } } } : part;
});

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';
const text = value => ({type:'text',text:value});
let scenario = 'cards';
const normalItems = () => [
  {id:'cards-user',role:'user',turnId:'turn-cards',createdAt:'now',parts:[text('Run the full tool set.')]},
  ...window.__corpus.map((part,index)=>({id:'cards-'+index,role:'assistant',turnId:'turn-cards',createdAt:'now',parts:[part]})),
  {id:'cards-final',role:'assistant',turnId:'turn-cards',createdAt:'now',parts:[text('The tool set is complete.')],elapsedMs:12000},
];
const runningItems = () => [
  {id:'run-user',role:'user',turnId:'turn-run',createdAt:'now',parts:[text('Build the project.')]},
  {id:'run-command',role:'assistant',turnId:'turn-run',createdAt:'now',parts:[{type:'tool',toolId:'run-1',toolName:'bash',status:'running',data:{type:'tool_execution_update',toolName:'bash',args:{command:'npm run build'},partialResult:{content:[{type:'text',text:'building modules\\ncompiled 42 modules\\nwaiting for the next output line'}]}}}]},
  {id:'run-final',role:'assistant',turnId:'turn-run',createdAt:'now',parts:[]},
];
const emptyItems = () => [
  {id:'empty-user',role:'user',turnId:'turn-empty',createdAt:'now',parts:[text('No tools here.')]},
  {id:'empty-final',role:'assistant',turnId:'turn-empty',createdAt:'now',parts:[text('Done without tools.')],elapsedMs:900},
];
const listeners = new Set(); let sequence = 1, activeSessionId = 'tool-cards-en';
window.threadterm = {onEvent: cb => {listeners.add(cb); return () => listeners.delete(cb);},request:async method => {
  if(method==='chat.snapshot') return {items:scenario==='running'?runningItems():scenario==='empty'?emptyItems():normalItems(),revision:1};
  if(method==='chat.draft.read') return {text:'',revision:0};
  if(method==='chat.queue.read') return {sessionId:activeSessionId,paused:false,items:[]};
  if(method==='chat.options') return {options:[],commands:[]};
  // ChatView mounts ChatNotes, which reads feedback on mount; return the real
  // empty state so the unmocked read cannot render an error banner.
  if(method==='chat.feedback.read') return {notes:[]};
  throw Error('Unexpected QA request '+method);
}};
const root = createRoot(document.getElementById('root'));
window.__corpus = ${JSON.stringify(corpus)};
window.qaRender = (locale='en', nextScenario='cards') => {
  scenario = nextScenario;
  activeSessionId = 'tool-cards-'+locale+'-'+nextScenario;
  return root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{},openDiff:()=>{}}}><ChatView session={{id:activeSessionId,provider:'codex',mode:'chat',status:scenario==='running'?'running':'idle',readOnly:true,title:'Tool cards QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>);
};
document.documentElement.dataset.theme='light';
window.qaRender('en','cards');
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';');

const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
let app, page;
async function shot(name) { const path = join(out, name); await page.screenshot({ path, animations: 'disabled' }); report.snapshots.push(name); }
async function setState({ theme = 'light', locale = 'en', width = 1280, scenario = 'cards' } = {}) {
  await page.evaluate(([nextLocale, nextScenario]) => window.qaRender(nextLocale, nextScenario), [locale, scenario]);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize({ width, height: 900 });
  if (scenario === 'empty') { await page.waitForFunction(() => document.querySelector('.v3-chat-log')); return; }
  await page.locator('.chat-tool-activity').first().waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function drawerOpen(open) {
  const current = await page.locator('.chat-tool-activity').first().evaluate(node => node.open);
  if (current !== open) await page.locator('.chat-tool-activity').first().locator('> summary').click();
  await page.waitForFunction(value => document.querySelector('.chat-tool-activity')?.open === value, open);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  await setState({});

  // Collapsed: entry shells and identity survive; no card bodies are built.
  await drawerOpen(false);
  assert.equal(await page.locator('.chat-tool-entry').count(), corpus.length, 'every corpus part renders one entry shell');
  assert.equal(await page.locator('.tool-card-body').count(), 0, 'a collapsed drawer renders no card bodies');
  assert.deepEqual(await page.locator('.chat-tool-entry').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-kind'))), ['edit', 'command', 'command', 'read', 'search', 'web', 'todo', 'skill', 'mcp', 'image', 'compaction', 'generic']);
  assert.match(await page.locator('.chat-tool-current-action').textContent(), /Explored .* · Ran .* · Edited .* · .*/, 'the idle summary describes the turn');
  report.checks.push('collapsed drawer keeps every entry shell, no card bodies, kind order and the idle summary');

  // Expanded: typed bodies render, never as nested drawers.
  await drawerOpen(true);
  assert.equal(await page.locator('.tool-card-body').count(), corpus.length - 1, 'expanded entries render bodies except the resultless web card whose target is in its title');
  assert.equal(await page.locator('.chat-tool-entry details details').count(), 0, 'cards never nest per-tool drawers');
  assert.ok(await page.locator('.tool-diff-rows').count() >= 1, 'the edit card renders a diff');
  assert.ok(await page.locator('.tool-json-tree, .tool-argument-lines').count() >= 1, 'the MCP/generic cards render their arguments (compact lines when flat, else a JSON tree)');
  assert.ok(await page.locator('.tool-todos .tool-todo').count() >= 1, 'the todo card renders its checklist');
  assert.match(await page.locator('.tool-card-status').first().textContent(), /Completed|已?完成/, 'status chips are labelled');
  report.checks.push('expanded cards render diff, JSON tree, checklist and status chips without nested drawers');

  // Matrix screenshots.
  for (const theme of ['light', 'dark']) for (const locale of ['en', 'zh-CN']) for (const width of [1280, 420]) {
    await setState({ theme, locale, width });
    await drawerOpen(false);
    await shot(`cards-${theme}-${locale}-${width}-collapsed.png`);
    await drawerOpen(true);
    assert.equal(await page.locator('.v3-chat-log').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${theme}/${locale}/${width}: collapsed drawer has no horizontal clipping`);
    assert.equal(await page.locator('.v3-chat-log').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${theme}/${locale}/${width}: expanded drawer has no horizontal clipping`);
    await shot(`cards-${theme}-${locale}-${width}-expanded.png`);
  }
  report.checks.push('wide/420 light/dark en/zh-CN collapsed and expanded screenshots have no horizontal clipping');

  // Visual consistency (V1, issue VC): check every card entry after scrolling
  // it into view so no control is missed by the clipping guard.
  await setState({ theme: 'light', locale: 'en', width: 1280, scenario: 'cards' });
  await drawerOpen(true);
  const entryCount = await page.locator('.chat-tool-entry').count();
  let cardControls = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const selector = `.chat-tool-entries > .chat-tool-entry:nth-child(${index + 1})`;
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const result = await checkControlConsistency(page, selector);
    assertNoControlViolations(result, `tool card ${index + 1}`);
    cardControls += result.checked;
  }
  report.checks.push(`zero visual-consistency violations across ${cardControls} tool-card controls (${entryCount} entries)`);

  // Disclosure semantics: JSON uses labelled buttons rather than an incomplete
  // ARIA tree, and tool drawer entries preserve list semantics.
  const jsonToggle = page.locator('.tool-json button[aria-expanded]').first();
  await jsonToggle.waitFor();
  assert.equal(await page.locator('[role="tree"], [role="treeitem"]').count(), 0, 'JSON disclosure does not expose an unsupported ARIA tree');
  assert.match(await jsonToggle.getAttribute('aria-label'), /(?:Expand|Collapse).+/, 'JSON toggle has a contextual expand/collapse label');
  assert.equal(await page.locator('.chat-tool-entries > [role="listitem"]').count(), entryCount, 'every direct tool entry is a list item');
  await jsonToggle.focus(); await page.keyboard.press('Enter');
  assert.equal(await jsonToggle.getAttribute('aria-expanded'), 'false', 'Enter collapses the JSON root disclosure');
  await jsonToggle.focus(); await page.keyboard.press('Space');
  assert.equal(await jsonToggle.getAttribute('aria-expanded'), 'true', 'Space reopens the JSON root disclosure');
  report.checks.push('JSON uses contextual disclosure buttons with Enter/Space root toggling; every tool entry is a listitem');

  // Running command: live preview outside, Running chip and streaming output inside.
  await setState({ theme: 'light', locale: 'en', width: 1280, scenario: 'running' });
  await drawerOpen(false);
  assert.match(await page.locator('.chat-tool-output-preview').textContent(), /waiting for the next output line/, 'the live output preview shows outside the drawer');
  await shot('running-light-en-1280-collapsed.png');
  await drawerOpen(true);
  assert.match(await page.locator('.tool-card-status').first().textContent(), /Running/, 'a live command card reports Running');
  assert.match(await page.locator('.tool-output').first().textContent(), /compiled 42 modules/, 'the expanded running card shows its streamed output');
  await shot('running-light-en-1280-expanded.png');
  await setState({ theme: 'dark', locale: 'zh-CN', width: 420, scenario: 'running' });
  await drawerOpen(true);
  assert.equal(await page.locator('.v3-chat-log').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'running command at 420 px has no horizontal clipping');
  await shot('running-dark-zh-420-expanded.png');
  report.checks.push('running command shows the live preview, Running chip and streamed output, and fits at 420 px');

  // Expanding a 300-entry turn must stay inside the 100 ms frame budget.
  await page.evaluate(() => { window.__corpus = Array.from({ length: 300 }, (_, index) => ({ type: 'tool', toolId: `perf-${index}`, toolName: 'commandExecution', status: 'completed', data: { type: 'commandExecution', command: `run task ${index}`, aggregatedOutput: `output ${index}` } })); });
  await setState({ theme: 'light', locale: 'en', width: 1280, scenario: 'cards' });
  await drawerOpen(false);
  const measureExpansion = () => page.evaluate(() => new Promise(resolve => {
    const details = document.querySelector('.chat-tool-activity');
    const start = performance.now();
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    const commit = () => {
      const entries = document.querySelectorAll('.chat-tool-entry').length;
      const bodies = document.querySelectorAll('.tool-card-body').length;
      const committed = performance.now();
      void document.body.offsetHeight; // force a layout of the expanded bodies
      resolve({ elapsed: performance.now() - start, commit: committed - start, entries, bodies });
    };
    setTimeout(() => (document.querySelectorAll('.tool-card-body').length >= 300 ? commit() : setTimeout(commit, 0)), 0);
  }));
  const warmup = await measureExpansion();
  assert.equal(warmup.entries, 300, 'the warmup keeps every entry shell');
  assert.equal(warmup.bodies, 300, 'the warmup builds every card body');
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    await drawerOpen(false);
    assert.equal(await page.locator('.tool-card-body').count(), 0, 'each sample starts with the bodies unmounted');
    const sample = await measureExpansion();
    samples.push(sample);
    assert.equal(sample.entries, 300, `sample ${index + 1}: the drawer keeps every entry shell`);
    assert.equal(sample.bodies, 300, `sample ${index + 1}: expanding builds all 300 card bodies`);
  }
  const median = values => [...values].sort((left, right) => left - right)[2];
  const perf = { warmup, samples, elapsed: median(samples.map(sample => sample.elapsed)), commit: median(samples.map(sample => sample.commit)), entries: 300, bodies: 300 };
  report.perf = perf;
  assert.ok(perf.elapsed < 100, `the median of 5 expansions took ${perf.elapsed.toFixed(1)} ms including forced layout (budget 100 ms); samples: ${samples.map(sample => sample.elapsed.toFixed(1)).join(', ')}`);
  report.checks.push(`after one warmup, 5 expansions had median commit ${perf.commit.toFixed(1)} ms and median layout-inclusive duration ${perf.elapsed.toFixed(1)} ms (budget 100 ms)`);

  // Empty state: no plan/tool DOM at all.
  await setState({ theme: 'light', locale: 'en', width: 1280, scenario: 'empty' });
  assert.equal(await page.locator('.chat-tool-activity').count(), 0, 'a turn without tools renders no drawer');
  await shot('empty-light-en-1280.png');
  report.checks.push('a turn without tools renders no drawer (empty state)');

  assert.deepEqual(report.errors, [], 'the fixture has no renderer page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'TOOL CARDS VISUAL QA PASSED' : 'TOOL CARDS VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
