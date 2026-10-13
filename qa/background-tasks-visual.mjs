// Isolated F6 visual QA. It uses production BackgroundTasksStrip, ToolActivity
// and background-output identity helpers, with no runtime or provider process.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-background-tasks-'));
const out = resolve('qa/results/chat-parity/F6/background-tasks');
await mkdir(out, { recursive: true });

const entry = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundTasksStrip } from './renderer/src/components/BackgroundTasksStrip';
import { ToolActivity } from './renderer/src/components/ToolActivity';
import { backgroundHasOutput, revealBackgroundOutput } from './renderer/src/backgroundTasks';
import './renderer/src/styles.css';

const copy = (en, zh) => window.__locale === 'zh-CN' ? zh : en;
const startedAt = '2026-10-13T12:00:00.000Z';
const task = (status = 'running') => ({ id:'native-task-1', toolId:'native-tool-1', title:'Build the release package', command:'npm run build', status, startedAt, canStop:true, ...(status === 'completed' ? {endedAt:'2026-10-13T12:02:00.000Z'} : {}) });
const part = { type:'tool', toolId:'native-tool-1', toolName:'commandExecution', status:'completed', data:{type:'commandExecution',command:'npm run build',aggregatedOutput:'compiled 42 modules'} };
const entries = [{ id:'output-item:tool:native-tool-1', itemId:'output-item', part }];

function Harness({ scenario, tick }) {
  const [stopPending, setStopPending] = useState(false);
  const rootRef = useRef(null);
  const data = scenario === 'empty' ? [] : [{ ...task(scenario === 'loading' || scenario === 'error' || scenario === 'stop-pending' || scenario === 'no-stop' || scenario === 'readonly' ? 'running' : scenario), ...(scenario === 'no-stop' ? {canStop:false} : {}) }];
  const writable = scenario !== 'readonly';
  const onExpand = async () => {
    window.__calls.expand++;
    if (scenario === 'loading') return new Promise(resolve => { window.__releaseRefresh = resolve; });
    if (scenario === 'error') throw Error('refresh failed');
  };
  const onStop = async row => {
    window.__calls.stop.push(row.id);
    if (scenario === 'stop-pending') { setStopPending(true); return new Promise(resolve => { window.__releaseStop = resolve; }); }
  };
  const onOutput = row => {
    window.__calls.output.push(row.id);
    revealBackgroundOutput(rootRef.current, row, () => { window.__calls.inspect++; });
  };
  return <main className="qa-background-log" ref={rootRef}>
    <BackgroundTasksStrip tasks={data} copy={copy} zh={window.__locale === 'zh-CN'} writable={writable} onExpand={onExpand} onStop={onStop} onOutput={onOutput} canOutput={row => backgroundHasOutput(row, [{id:'output-item',role:'assistant',createdAt:startedAt,parts:[part]}])} />
    <ToolActivity entries={entries} active={false} provider="codex" copy={copy} onInspect={() => { window.__calls.inspect++; }} />
    <output data-testid="stop-pending">{String(stopPending)}</output>
  </main>;
}
function Fixture() {
  const [scenario, setScenario] = useState('running');
  const [generation, setGeneration] = useState(0);
  const [rerender, setRerender] = useState(0);
  window.qaSet = (next, locale = 'en') => { window.__releaseRefresh?.(); window.__releaseStop?.(); window.__locale = locale; setScenario(next); setGeneration(value => value + 1); };
  window.qaRerender = () => setRerender(value => value + 1);
  window.qaNativeTerminalUpdate = status => setScenario(status);
  return <Harness key={generation} scenario={scenario} tick={rerender} />;
}
window.__calls = {expand:0,stop:[],output:[],inspect:0}; window.__locale = 'en';
createRoot(document.getElementById('root')).render(<Fixture />);
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff':'dataurl', '.ttf':'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
const report = { passed:false, scratch, checks:[], snapshots:[], errors:[] };
let app, page;
const nextFrame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
async function shot(name) { await page.screenshot({ path:join(out, name), animations:'disabled' }); report.snapshots.push(name); }
async function state(scenario, theme, locale, width) {
  await page.evaluate(([next, language]) => window.qaSet(next, language), [scenario, locale]);
  await page.evaluate(value => {
    document.documentElement.dataset.theme = value === 'custom' ? 'light' : value;
    document.documentElement.dataset.customTheme = value === 'custom' ? 'true' : 'false';
    document.documentElement.style.cssText = value === 'custom' ? '--custom-background:#efe4ff;--custom-surface:#f9f3ff;--custom-text:#23163a;--custom-muted:#67597a;--custom-accent:#6b36c9;--custom-border:#af9aca;' : '';
  }, theme);
  await page.setViewportSize({ width, height:900 });
  await nextFrame();
}
async function openStrip() {
  const button = page.locator('[data-testid="background-tasks-strip"] > button');
  if (await button.count() && await button.getAttribute('aria-expanded') === 'false') await button.click();
  await nextFrame();
}
async function consistency(label) {
  const result = await checkControlConsistency(page, '.qa-background-log');
  assertNoControlViolations(result, label);
  return result.checked;
}

try {
  app = await electron.launch({ args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaSet === 'function');
  // Spy after setup: only strip lifecycle work is counted, not harness startup.
  await page.evaluate(() => { window.__timers={interval:0,timeout:0,active:0}; const interval=window.setInterval, clear=window.clearInterval, timeout=window.setTimeout; window.setInterval=(...args)=>{window.__timers.interval++;window.__timers.active++;return interval(...args)}; window.clearInterval=(handle)=>{window.__timers.active=Math.max(0,window.__timers.active-1);return clear(handle)}; window.setTimeout=(...args)=>{window.__timers.timeout++;return timeout(...args)}; });

  await state('running', 'light', 'en', 1440);
  const strip = page.locator('[data-testid="background-tasks-strip"]');
  assert.equal(await strip.locator('[aria-expanded]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => window.__calls.expand), 0, 'collapsed strip makes no list/refresh call');
  await openStrip(); await page.locator('.chat-background-row').waitFor();
  assert.equal(await page.evaluate(() => window.__calls.expand), 1, 'first expansion refreshes once');
  await strip.locator('[aria-expanded]').press('Escape');
  assert.equal(await strip.locator('[aria-expanded]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('[data-testid="background-tasks-strip"] > button')), true, 'Escape restores toggle focus');
  await state('loading', 'light', 'en', 1440); await page.locator('[data-testid="background-tasks-strip"] > button').click();
  await page.locator('[data-testid="background-tasks-strip"] > button').dblclick();
  assert.equal(await page.evaluate(() => window.__calls.expand), 2, 'pending refresh cannot duplicate');
  report.checks.push('collapsed strips are lazy, refresh once, and restore focus after Escape');

  await state('running', 'light', 'en', 1440); await openStrip();
  assert.ok(await page.evaluate(() => window.__timers.active) >= 1, 'an expanded strip with a running task keeps one ticker');
  const beforeElapsed = await page.locator('.chat-background-elapsed').textContent();
  await page.evaluate(() => { Date.now = () => Date.parse('2026-10-13T12:03:00.000Z'); window.qaRerender(); }); await nextFrame();
  assert.notEqual(await page.locator('.chat-background-elapsed').textContent(), beforeElapsed, 'running elapsed reflects the current clock');
  await page.evaluate(() => { Date.now = () => Date.parse('2026-10-13T13:00:00.000Z'); window.qaSet('completed','en'); }); await nextFrame(); await openStrip();
  const frozen = await page.locator('.chat-background-elapsed').textContent(); await page.evaluate(() => window.qaRerender()); await nextFrame();
  assert.equal(await page.locator('.chat-background-elapsed').textContent(), frozen, 'terminal endedAt freezes elapsed time');
  assert.equal(await page.evaluate(() => window.__timers.active), 0, 'no live interval once no task runs or the strip closes');
  assert.equal(await page.evaluate(() => window.__timers.timeout), 0, 'strip introduces no timeout while idle, collapsed or expanded');
  report.checks.push('elapsed ticks only while expanded with a running task and freezes at a terminal end without idle timers');

  await state('stop-pending', 'light', 'en', 1440); await openStrip();
  const stop = page.getByRole('button', { name:/Stop task/ }); await stop.dblclick();
  assert.deepEqual(await page.evaluate(() => window.__calls.stop), ['native-task-1'], 'double click emits exactly one stop');
  assert.equal(await stop.isDisabled(), true); assert.match(await stop.textContent(), /Stopping/);
  await page.evaluate(() => window.__releaseStop()); await nextFrame();
  assert.equal(await stop.isDisabled(), true, 'accepted Stop remains disabled until a native task update');
  await page.evaluate(() => window.qaNativeTerminalUpdate('stopped')); await nextFrame();
  assert.equal(await page.getByRole('button', { name:/Stop task/ }).count(), 0, 'native terminal update clears stopping control');
  report.checks.push('Stop is single-delivery and stays disabled until the native terminal update');

  await state('readonly', 'light', 'en', 1440); await openStrip();
  assert.equal(await page.getByRole('button', { name:/Stop task/ }).isDisabled(), true, 'readonly disables Stop');
  await state('no-stop', 'light', 'en', 1440); await openStrip();
  assert.equal(await page.getByRole('button', { name:/Stop task/ }).count(), 0, 'canStop false hides Stop');
  await state('error', 'light', 'en', 1440); await openStrip(); await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name:/Refresh/ }).click();
  assert.ok(await page.evaluate(() => window.__calls.expand) >= 2, 'error has inline refresh retry');
  report.checks.push('readonly Stop is disabled and refresh errors stay inline with retry');

  await state('running', 'light', 'en', 1440); await openStrip();
  await page.getByRole('button', { name:/Output/ }).click(); await nextFrame();
  assert.equal(await page.evaluate(() => window.__calls.output.at(-1)), 'native-task-1');
  assert.equal(await page.locator('[data-tool-id="native-tool-1"]').evaluate(node => document.activeElement === node), true, 'Output focuses the exact tool-id card');
  assert.ok(await page.evaluate(() => window.__calls.inspect) > 0, 'Output pauses follow before reveal');
  report.checks.push('Output reveals and focuses the real ToolActivity card by tool identity, then pauses follow');

  const scenarios = ['empty','loading','running','completed','failed','stopped','readonly','error','stop-pending','no-stop'];
  let controls = 0;
  for (const width of [1440,420]) for (const theme of ['light','dark','custom']) for (const locale of ['en','zh-CN']) for (const scenario of scenarios) {
    await state(scenario, theme, locale, width);
    if (scenario !== 'empty') await openStrip();
    else assert.equal(await page.locator('[data-testid="background-tasks-strip"]').count(), 0, 'empty tasks render no strip');
    if (scenario === 'stop-pending') {
      const pendingStop = page.getByRole('button', { name: locale === 'zh-CN' ? /停止任务/ : /Stop task/ });
      await pendingStop.click();
      assert.equal(await pendingStop.isDisabled(), true, `${theme}/${locale}/${width}: Stop is disabled while stopping`);
      assert.match(await pendingStop.textContent(), /Stopping|正在停止/, `${theme}/${locale}/${width}: Stop reports its pending state`);
    }
    controls += await consistency(`${scenario}/${theme}/${locale}/${width}`);
    const log = page.locator('.qa-background-log');
    assert.equal(await log.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${scenario}/${theme}/${locale}/${width}: no horizontal clipping`);
    await shot(`background-${scenario}-${theme}-${locale}-${width}.png`);
  }
  assert.equal(await page.locator('[data-testid="background-tasks-strip"]').count() > 0, true);
  assert.deepEqual(report.errors, [], 'fixture has no page errors');
  report.checks.push(`full 120-cell matrix has no clipping and zero visual-consistency violations across ${controls} controls`);
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'BACKGROUND TASKS VISUAL QA PASSED' : 'BACKGROUND TASKS VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
