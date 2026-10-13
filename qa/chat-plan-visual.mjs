// Isolated production-ChatView QA for the agent plan panel (B4). It bundles the
// renderer with a deterministic in-memory bridge and never starts a runtime,
// provider, account, or user profile. Screenshots cover the matrix: wide
// (~1280) and ~420 px, light and dark, en and zh-CN, collapsed/expanded,
// history (no auto-open), the 0/0 edge and the no-plan empty state.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-plan-'));
const out = resolve('qa/results/chat-parity/B4/plan-panel');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';
const text = value => ({type:'text',text:value});
const plan = (entries, explanation) => ({type:'plan',toolId:'plan:turn-plan',status:'complete',data:{entries,...(explanation?{explanation}:{})}});
const ENTRIES = () => [
  {content:'Map the existing chat projection',status:'completed'},
  {content:'Add the additive plan part to every adapter',status:'in_progress',priority:'high'},
  {content:'Build the pinned plan panel',status:'pending',priority:'medium'},
  {content:'Run the regression suite',status:'pending',priority:'low'},
];
const LONG = () => Array.from({length:24},(_,index)=>({content:'Step '+(index+1)+' with a deliberately long description that has to wrap inside the narrow card without clipping',status:index<6?'completed':index===6?'in_progress':'pending',...(index%4===0?{priority:'high'}:{})}));
const items = scenario => {
  if (scenario==='noplan') return [
    {id:'u',role:'user',turnId:'turn-none',createdAt:'now',parts:[text('No plan here.')]},
    {id:'a',role:'assistant',turnId:'turn-none',createdAt:'now',parts:[text('Done without a plan.')],elapsedMs:400},
  ];
  if (scenario==='zero') return [
    {id:'u',role:'user',turnId:'turn-zero',createdAt:'now',parts:[text('Empty plan.')]},
    {id:'a',role:'assistant',turnId:'turn-zero',createdAt:'now',parts:[plan([])],elapsedMs:400},
  ];
  const history = scenario==='history';
  const long = scenario==='long';
  return [
    {id:'u',role:'user',turnId:'turn-plan',createdAt:'now',parts:[text('Work through the plan.')]},
    {id:'p',role:'assistant',turnId:'turn-plan',createdAt:'now',turnOrigin:history?'history':undefined,parts:[plan(long?LONG():ENTRIES(),'The agent wrote this plan before editing.')]},
    {id:'a',role:'assistant',turnId:'turn-plan',createdAt:'now',turnOrigin:history?'history':undefined,parts:[text('Still working.')],...(history?{elapsedMs:9000}:{})},
  ];
};
const listeners = new Set(); let sequence = 1, activeSessionId = 'plan-en', scenario = 'live';
window.threadterm = {onEvent: cb => {listeners.add(cb); return () => listeners.delete(cb);},request:async method => {
  if(method==='chat.snapshot') return {items:items(scenario),revision:1};
  if(method==='chat.draft.read') return {text:'',revision:0};
  if(method==='chat.queue.read') return {sessionId:activeSessionId,paused:false,items:[]};
  if(method==='chat.options') return {options:[],commands:[]};
  // ChatView mounts ChatNotes, which reads feedback on mount; return the real
  // empty state so the unmocked read cannot render an error banner.
  if(method==='chat.feedback.read') return {notes:[]};
  throw Error('Unexpected QA request '+method);
}};
const root = createRoot(document.getElementById('root'));
window.qaEmitPlan = () => {
  const item = items(scenario).find(item => item.id === 'p');
  for (const listener of listeners) listener({event:'chat.item',seq:2,data:{sessionId:activeSessionId,item}});
};
window.qaRender = (locale='en', nextScenario='live') => {
  scenario = nextScenario;
  activeSessionId = 'chat-plan-'+locale+'-'+nextScenario+'-'+(sequence++);
  return root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{},openDiff:()=>{}}}><ChatView key={activeSessionId} session={{id:activeSessionId,provider:'codex',mode:'chat',status:scenario==='live'?'running':'idle',readOnly:true,title:'Plan QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>);
};
document.documentElement.dataset.theme='light';
window.qaRender('en','live');
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';');

const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
let app, page;
async function shot(name) { const path = join(out, name); await page.screenshot({ path, animations: 'disabled' }); report.snapshots.push(name); }
async function setState({ theme = 'light', locale = 'en', width = 1280, scenario = 'live' } = {}) {
  await page.evaluate(([nextLocale, nextScenario]) => window.qaRender(nextLocale, nextScenario), [locale, scenario]);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (scenario === 'live') {
    await page.locator('.chat-plan-panel').waitFor();
    assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'false', 'even a running saved-plan snapshot stays closed during hydration');
    await page.evaluate(() => window.qaEmitPlan());
    await page.waitForFunction(() => document.querySelector('.chat-plan-chip')?.getAttribute('aria-expanded') === 'true');
  }
}

try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  // Live turn: the panel opens itself once and shows the steps.
  await setState({ scenario: 'live' });
  await page.locator('.chat-plan-panel').waitFor();
  assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'true', 'a live plan auto-opens once');
  assert.equal((await page.locator('.chat-plan-label').textContent()).trim(), 'Plan 1/4');
  assert.equal(await page.locator('.chat-plan-entry').count(), 4);
  assert.match(await page.locator('.chat-plan-explanation').textContent(), /wrote this plan/);
  assert.equal(await page.locator('.chat-plan-priority.is-high').count(), 1);
  assert.equal(await page.locator('.chat-plan-mark.is-active i').count(), 1, 'the active step spins while the turn runs');
  assert.equal(await page.locator('.chat-part.plan').count(), 0, 'plan parts are never rendered inline');
  report.checks.push('a live plan auto-opens, counts completed/total, lists entries and stays out of the transcript');

  // Keyboard: Escape collapses and the chip toggles.
  await page.locator('.chat-plan-chip').press('Escape');
  assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'false', 'Escape collapses the card');
  await page.locator('.chat-plan-chip').click();
  assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'true', 'the chip toggles the card');
  report.checks.push('Escape collapses and the chip toggles the card');

  // History: shown but never auto-opened.
  await setState({ scenario: 'history' });
  await page.locator('.chat-plan-panel').waitFor();
  assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'false', 'a reloaded plan does not auto-open');
  await page.locator('.chat-plan-chip').click();
  assert.equal(await page.locator('.chat-plan-mark.is-active i').count(), 0, 'history never shows a running spinner');
  report.checks.push('a reloaded history plan shows collapsed and never spins');

  // Lane 3: ordinary persisted live rows have no turnOrigin on idle reload.
  await setState({ scenario: 'saved' });
  await page.locator('.chat-plan-panel').waitFor();
  assert.equal(await page.locator('.chat-plan-chip').getAttribute('aria-expanded'), 'false', 'an idle saved plan without history origin never auto-opens');
  assert.equal(await page.locator('.chat-plan-mark.is-active i').count(), 0, 'idle saved rows have no active spinner');
  report.checks.push('idle saved live-origin plans stay collapsed');

  // Matrix screenshots.
  for (const theme of ['light', 'dark']) for (const locale of ['en', 'zh-CN']) for (const width of [1280, 420]) {
    await setState({ theme, locale, width, scenario: 'live' });
    await page.locator('.chat-plan-panel').waitFor();
    await page.locator('.chat-plan-card').waitFor();
    assert.equal(await page.locator('.chat-plan-entry').count(), 4, `${theme}/${locale}/${width}: the expanded card lists every entry`);
    await shot(`plan-${theme}-${locale}-${width}-expanded.png`);
    const overflow = await page.locator('.v3-chat-log').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, widest: [...node.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).map(el => `${el.tagName}.${el.className}`).slice(0, 8) }));
    assert.equal(overflow.scrollWidth <= overflow.clientWidth + 1, true, `${theme}/${locale}/${width}: no horizontal clipping ${JSON.stringify(overflow)}`);
    await page.locator('.chat-plan-chip').press('Escape');
    await shot(`plan-${theme}-${locale}-${width}-collapsed.png`);
  }
  report.checks.push('wide/420 light/dark en/zh-CN expanded and collapsed screenshots have no horizontal clipping');

  // Visual consistency (V1, issue VC): the plan chip and the priority chips.
  await setState({ theme: 'light', locale: 'en', width: 1280, scenario: 'live' });
  await page.locator('.chat-plan-panel').waitFor();
  if (await page.locator('.chat-plan-chip').getAttribute('aria-expanded') === 'false') await page.locator('.chat-plan-chip').click();
  const planConsistency = await checkControlConsistency(page, '.chat-plan-panel');
  assertNoControlViolations(planConsistency, 'plan panel');
  report.checks.push(`zero visual-consistency violations across ${planConsistency.checked} plan controls`);

  // Long entries wrap inside the narrow card.
  await setState({ theme: 'dark', locale: 'en', width: 420, scenario: 'long' });
  await page.locator('.chat-plan-panel').waitFor();
  if (await page.locator('.chat-plan-chip').getAttribute('aria-expanded') === 'false') await page.locator('.chat-plan-chip').click();
  assert.equal(await page.locator('.chat-plan-entry').count(), 24);
  assert.equal(await page.locator('.chat-plan-card').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'the card never scrolls horizontally');
  await shot('plan-long-dark-en-420.png');
  report.checks.push('a 24-entry plan wraps inside the 420 px card without horizontal scroll');

  // 0/0 edge and the no-plan empty state render no panel DOM.
  await setState({ scenario: 'zero' });
  assert.equal(await page.locator('.chat-plan-panel').count(), 0, 'a plan with no usable entries renders nothing');
  await shot('plan-zero-light-en-1280.png');
  await setState({ scenario: 'noplan' });
  assert.equal(await page.locator('.chat-plan-panel').count(), 0, 'a turn without a plan renders no panel');
  await shot('plan-none-light-en-1280.png');
  report.checks.push('a 0/0 plan and a plan-free turn both render no panel DOM');

  assert.deepEqual(report.errors, [], 'the fixture has no renderer page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron close failed: ${error}`));
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'CHAT PLAN VISUAL QA PASSED' : 'CHAT PLAN VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
