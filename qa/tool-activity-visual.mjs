// Isolated visual regression for the provider-neutral normal-turn tool drawer.
// The production ChatView is bundled with a deterministic in-memory bridge;
// it never starts a runtime, provider, account, or user-data profile.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-tool-activity-'));
const out = resolve('qa/results/tool-activity');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';
const text = value => ({type:'text',text:value});
const assistant = (id, parts, extra={}) => ({id,role:'assistant',turnId:'turn-complete',createdAt:'now',parts,...extra});
const command = (id, status, data, extra={}) => ({type:'tool',toolId:id,toolName:'commandExecution',status,data,...extra});
const browser = (id, status, data, extra={}) => ({type:'tool',toolId:id,toolName:'mcp__playwright__browser_navigate',status,data,...extra});
const items = [
  {id:'user-complete',role:'user',turnId:'turn-complete',createdAt:'now',parts:[text('Inspect the project and open the documentation page.')]},
  assistant('commentary-start',[text('I will inspect the project first.')]),
  assistant('command-codex',[command('command-codex','completed',{command:'npm run typecheck',aggregatedOutput:'typecheck complete'}, {fileReferences:[{path:'D:\\\\project\\\\ThreadTerm\\\\ThreadTerm-v3\\\\package.json',line:1}]})]),
  assistant('browser-mcp',[browser('browser-mcp','success',{server:'playwright',tool:'browser_navigate',arguments:{url:'https://example.test/docs/start'}})]),
  assistant('commentary-middle',[text('The project checks passed; I will inspect the source next.')]),
  assistant('command-claude',[command('command-claude','completed',{input:{command:'git status --short'},output:' M renderer/src/components/ChatView.tsx'})]),
  assistant('browser-acp',[browser('browser-acp','completed',{title:'Open page',rawInput:{url:'https://example.test/reference'}})]),
  assistant('file-tool',[{type:'tool',toolId:'file-read',toolName:'Read',status:'completed',data:{path:'README.md'},text:'README.md'}]),
  assistant('search-tool',[{type:'tool',toolId:'search',toolName:'Search',status:'completed',data:{query:'tool drawer'},text:'tool drawer'}]),
  assistant('delegation',[{type:'tool',toolId:'delegate',toolName:'delegate_task',status:'completed',data:{task:'Review the result'}}]),
  assistant('failure',[{type:'tool',toolId:'failed-command',toolName:'commandExecution',status:'failed',data:{command:'npm run unavailable'},text:'exit 1'}, {type:'tool',toolId:'cancelled-browser',toolName:'mcp__playwright__browser_navigate',status:'cancelled',data:{server:'playwright',tool:'browser_navigate',arguments:{url:'https://example.test/cancelled'}}}]),
  assistant('approval',[{type:'approval',approvalId:'approval-one',status:'pending',data:{}}]),
  assistant('error',[{type:'error',text:'A visible provider error remains outside tool activity.'}]),
  assistant('answer',[text('The inspection is complete.')]),
  assistant('turn-complete',[],{elapsedMs:18000}),
];
const listeners = new Set(); let sequence = 1, activeSessionId = 'tool-activity-codex';
window.threadterm = {onEvent: cb => {listeners.add(cb); return () => listeners.delete(cb);},request:async method => {
  if(method==='chat.snapshot') return {items,revision:1};
  if(method==='chat.draft.read') return {text:'',revision:0};
  if(method==='chat.options') return {options:[],commands:[]};
  throw Error('Unexpected QA request '+method);
}};
window.qaUpdate = item => { const event={event:'chat.item',seq:sequence++,data:{sessionId:activeSessionId,item}}; listeners.forEach(listener=>listener(event)); };
const root = createRoot(document.getElementById('root'));
window.qaRender = (provider,status='running') => { activeSessionId='tool-activity-'+provider; return root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:activeSessionId,provider,mode:'chat',status,readOnly:true,title:'Tool activity QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>); };
document.documentElement.dataset.theme='light'; window.qaRender('codex');
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

let app, page;
const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
async function selectProvider(provider) {
  await page.evaluate(value => window.qaRender(value), provider);
  await page.waitForFunction(value => document.querySelector('.chat-view')?.getAttribute('data-provider') === value, provider);
  await page.locator('.chat-tool-activity').waitFor({ state: 'attached' });
}
async function openCompleteTurnIfNeeded() {
  const work = page.locator('.codex-work');
  if (await work.count() && !await work.evaluate(node => node.open)) await work.locator('summary').click();
}
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  for (const provider of ['codex', 'claude', 'kimi', 'gemini', 'grok', 'opencode', 'plugin-unknown']) {
    await selectProvider(provider);
    await openCompleteTurnIfNeeded();
    const drawer = page.locator('.chat-tool-activity');
    assert.equal(await drawer.count(), 1, `${provider}: one activity drawer for the normal turn`);
    assert.equal(await page.locator('.codex-command-group').count(), 0, `${provider}: legacy Codex command group is absent`);
    assert.equal(await drawer.locator('.codex-tool-disclosure').count(), 0, `${provider}: no nested per-tool drawers`);
    assert.equal(await drawer.locator('.chat-tool-entry').count(), 9, `${provider}: ordinary calls retain chronological entries`);
    assert.deepEqual(await drawer.locator('.chat-tool-entry').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-id'))), ['command-codex','browser-mcp','command-claude','browser-acp','file-read','search','delegate','failed-command','cancelled-browser'], `${provider}: entries retain call order rather than category sort`);
    const summary = drawer.locator('> summary');
    assert.match(await summary.locator('.chat-tool-current-action').textContent() ?? '', /Tool activity|npm run unavailable/i, `${provider}: idle summary uses current/recent action`);
    assert.match(await summary.locator('.chat-tool-count').textContent() ?? '', /9 tools/i, `${provider}: summary includes ordinary-call count`);
    assert.equal(await summary.locator('.chat-tool-active-count').count(), 0, `${provider}: completed turn never claims an active tool`);
    assert.equal(await drawer.evaluate(node => Boolean(node.closest('.codex-work'))), false, `${provider}: completed tool activity stays outside elapsed commentary fold`);
    assert.equal(await page.locator('.chat-tool-failures').count(), 1, `${provider}: failures have a visible row outside details body`);
    assert.equal(await page.locator('.chat-part.approval').count(), 1, `${provider}: approval remains independent`);
    assert.ok(await page.getByText('A visible provider error remains outside tool activity.').count(), `${provider}: errors remain independent`);
  }
  report.checks.push('all providers use one generic normal-turn drawer with ordered entries, independent approval/error/failure rows, and no legacy nested drawers');

  // Use a non-Codex live provider here so the generic drawer assertions are
  // independent of Codex's deliberately paced transcript stream queue.
  await selectProvider('claude');
  const drawers = page.locator('.chat-tool-activity');
  assert.equal(await drawers.count(), 1, 'the completed turn starts with one tool drawer');
  const drawer = drawers.first();
  const summary = drawer.locator('> summary');
  assert.equal(await drawer.evaluate(node => node.open), false, 'drawer starts collapsed');
  await summary.focus();
  await summary.press('Enter');
  assert.equal(await drawer.evaluate(node => node.open), true, 'Enter opens the generic activity drawer');
  await summary.press('Space');
  assert.equal(await drawer.evaluate(node => node.open), false, 'Space closes the generic activity drawer');
  await summary.click();
  assert.equal(await drawer.evaluate(node => node.open), true, 'manual expansion opens the drawer');
  await page.evaluate(() => window.qaUpdate({id:'live-user',role:'user',turnId:'turn-live',createdAt:'later',parts:[{type:'text',text:'Run two commands and open a page.'}]}));
  await page.evaluate(() => window.qaUpdate({id:'live-command',role:'assistant',turnId:'turn-live',createdAt:'later',parts:[{type:'tool',toolId:'live-command',toolName:'commandExecution',status:'running',data:{command:'npm run lint'}},{type:'tool',toolId:'live-browser',toolName:'mcp__playwright__browser_navigate',status:'running',data:{server:'playwright',tool:'browser_navigate',arguments:{url:'https://example.test/live/page'}}}]}));
  await page.waitForFunction(() => document.querySelectorAll('.chat-tool-activity').length === 2);
  const live = page.locator('.chat-tool-activity').last();
  assert.equal(await live.isVisible(), true, 'live-turn drawer is outside the completed activity fold');
  assert.match(await live.locator('.chat-tool-current-action').textContent() ?? '', /Browsing: Open page · example\.test\/live\/page/i, 'latest browser descriptor appears in the outer summary');
  assert.match(await live.locator('.chat-tool-active-count').textContent() ?? '', /2 running/i, 'summary exposes parallel active count');
  await live.locator('> summary').click();
  await live.locator('.chat-tool-entry[data-tool-id="live-browser"]').waitFor();
  assert.equal(await live.evaluate(node => node.open), true, 'initial live calls preserve the manually expanded drawer');
  await live.locator('> summary').click();
  assert.equal(await live.evaluate(node => node.open), false, 'a manually closed live drawer remains closed');
  await page.evaluate(() => window.qaUpdate({id:'live-search',role:'assistant',turnId:'turn-live',createdAt:'later',parts:[{type:'tool',toolId:'live-search',toolName:'Search',status:'running',data:{query:'activity drawer'}}]}));
  await live.locator('.chat-tool-entry[data-tool-id="live-search"]').waitFor({ state: 'attached' });
  assert.equal(await live.evaluate(node => node.open), false, 'an appended call never reopens a manually closed drawer');
  await page.evaluate(() => window.qaUpdate({id:'live-command',role:'assistant',turnId:'turn-live',createdAt:'later',parts:[{type:'tool',toolId:'live-command',toolName:'commandExecution',status:'completed',data:{command:'npm run lint',aggregatedOutput:'lint complete'}},{type:'tool',toolId:'live-browser',toolName:'mcp__playwright__browser_navigate',status:'completed',data:{server:'playwright',tool:'browser_navigate',arguments:{url:'https://example.test/live/page'}}}]}));
  await page.waitForFunction(() => document.querySelector('[data-tool-id="live-command"]')?.getAttribute('data-tool-status') === 'complete');
  assert.equal(await live.evaluate(node => node.open), false, 'an output/status update never reopens a manually closed drawer');
  await live.locator('> summary').click();
  assert.equal(await live.evaluate(node => node.open), true, 'user can expand the drawer before a later status update');
  await page.evaluate(() => window.qaUpdate({id:'live-search',role:'assistant',turnId:'turn-live',createdAt:'later',parts:[{type:'tool',toolId:'live-search',toolName:'Search',status:'completed',data:{query:'activity drawer',output:'search complete'}}]}));
  await page.waitForFunction(() => document.querySelector('[data-tool-id="live-search"]')?.getAttribute('data-tool-status') === 'complete');
  assert.equal(await live.evaluate(node => node.open), true, 'an output/status update preserves an expanded drawer');
  await page.evaluate(() => window.qaRender('claude','idle'));
  await page.waitForFunction(() => !document.querySelector('.chat-tool-active-count'));
  assert.match(await live.locator('.chat-tool-current-action').textContent() ?? '', /Tool activity/i, 'idle session suppresses stale running labels');
  assert.equal(await live.evaluate(node => node.open), true, 'idle transition preserves expanded disclosure state');
  await page.evaluate(() => window.qaUpdate({id:'live-complete',role:'assistant',turnId:'turn-live',createdAt:'later',parts:[],elapsedMs:4000}));
  await page.locator('.chat-duration').filter({ hasText: '4s' }).waitFor({ state: 'visible' });
  assert.equal(await live.evaluate(node => node.open), true, 'whole-turn completion preserves expanded disclosure state');
  report.checks.push('append, output update, idle transition, and whole-turn completion preserve open and closed disclosure state without stale running labels');

  if (await drawer.evaluate(node => node.open)) await summary.click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 1280, 1440, 1920]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
      const collapsed = join(out, `${theme}-${width}-collapsed.png`);
      await page.screenshot({ path: collapsed, animations: 'disabled' });
      report.snapshots.push(collapsed);
      const expanded = join(out, `${theme}-${width}-expanded.png`);
      await summary.click();
      await page.screenshot({ path: expanded, animations: 'disabled' });
      report.snapshots.push(expanded);
      await summary.click();
      assert.equal(await page.evaluate(() => document.querySelector('.v3-chat-log').scrollWidth <= document.querySelector('.v3-chat-log').clientWidth), true, `${theme}/${width}: no horizontal overflow`);
    }
  }
  report.checks.push('light/dark 320/1280/1440/1920 screenshots include collapsed and expanded generic activity drawers');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) {
    report.failureDom = await page.evaluate(() => ({
      provider: document.querySelector('.chat-view')?.getAttribute('data-provider'),
      drawers: Array.from(document.querySelectorAll('.chat-tool-activity')).map(node => ({ open: node.open, summary: node.querySelector('summary')?.textContent, entries: Array.from(node.querySelectorAll('.chat-tool-entry')).map(entry => entry.getAttribute('data-tool-id')) })),
    })).catch(() => undefined);
    await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close();
  console.log(`${report.passed ? 'TOOL ACTIVITY VISUAL QA PASSED' : 'TOOL ACTIVITY VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
