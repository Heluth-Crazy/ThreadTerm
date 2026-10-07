// Isolated visual regression for native subagent cards. This bundles the real
// ChatView with an in-memory bridge; it never starts a runtime or provider.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-subagent-card-'));
const out = resolve('qa/results/subagent-card');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';
let qaNow = Date.parse('2026-10-07T12:02:14.000Z');
Date.now = () => qaNow;
const nativeSetInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
let intervalStarts = 0, intervalStops = 0;
window.setInterval = (...args) => { intervalStarts++; return nativeSetInterval(...args); };
window.clearInterval = id => { intervalStops++; return nativeClearInterval(id); };
const text = value => ({type:'text',text:value});
const tool = (id,status='completed') => ({type:'tool',toolId:id,toolName:'commandExecution',status,data:{command:'npm run '+id,aggregatedOutput:'finished '+id}});
const subagent = (key, info) => ({type:'subagent',data:{key,provider:'codex',agentType:'general-purpose',description:'Inspect the renderer implementation and report the layout findings.',prompt:'Inspect renderer components, run focused checks, and explain any layout risks.',status:'running',transcript:'live',startedAt:'2026-10-07T12:00:00.000Z',toolCount:2,rev:1,...info}});
const assistant = (id,turnId,parts,extra={}) => ({id,role:'assistant',turnId,createdAt:'2026-10-07T12:00:00.000Z',parts,...extra});
const user = (id,turnId,value) => ({id,role:'user',turnId,createdAt:'2026-10-07T12:00:00.000Z',parts:[text(value)]});
const long = 'A deliberately long description for a narrow chat pane that must ellipsize cleanly instead of creating horizontal scrolling or pushing the state controls outside the card.';
const tallPrompt = Array.from({length:15}, (_, index) => 'Step '+(index+1)+': inspect the renderer boundary and preserve the visible transcript hierarchy.').join('\\n');
const cards = {
  running: [user('u1','live','Review the renderer.'), assistant('run-before','live',[tool('before-subagent')]), assistant('run','live',[subagent('running',{lastActivity:'Reading renderer/src/components/ChatView.tsx and comparing compact-pane spacing.'})]), assistant('run-after','live',[tool('after-subagent')])],
  parallel: [user('u2','live','Review three areas.'), assistant('p1','live',[subagent('parallel-one',{agentType:'explore',description:'Trace the renderer entry point.',lastActivity:'Reading the transcript renderer.'})]), assistant('p2','live',[subagent('parallel-two',{agentType:'test',description:'Check narrow pane behavior.',lastActivity:'Capturing compact visual cases.'})]), assistant('p3','live',[subagent('parallel-three',{agentType:'review',description:'Review accessibility labels.',lastActivity:'Checking disclosure semantics.'})])],
  completed: [user('u3','done','Finish the review.'), assistant('done-commentary','done',[text('I will review the work before answering.')]), assistant('done-work','done',[tool('parent-tool')]), assistant('done-card','done',[subagent('complete',{status:'completed',description:undefined,name:'/root/count_files',summary:'The renderer already uses the shared card spacing. The new subagent card fits the existing transcript hierarchy and needs no further changes.',toolCount:12,usage:{totalTokens:34000,toolUses:12,durationMs:134000}})]), assistant('done-answer','done',[text('The parent response remains outside the elapsed work fold.')],{elapsedMs:18000})],
  failed: [user('u4','failed','Try a risky check.'), assistant('failed','failed',[subagent('failed',{status:'failed',summary:'The isolated check could not open the requested fixture because the fixture was unavailable.',lastActivity:'Opening fixture',toolCount:1})])],
  expanded: [user('u5','live','Inspect details.'), assistant('expanded','live',[subagent('expanded',{lastActivity:'Running the focused visual check.',rev:1,prompt:tallPrompt})])],
  native: [user('u6','done','Read the native transcript.'), assistant('retracted-agent','done',[]), assistant('native','done',[subagent('native',{provider:'kimi',agentType:'coder',description:'Kimi agent transcript becomes available after completion.',transcript:'none',status:'running',summary:'Waiting for the native session transcript.'})])],
  truncated: [user('u7','done','Read the retained work.'), assistant('truncated','done',[subagent('truncated',{status:'completed',truncated:true,summary:'The retained final report remains readable after old rows were trimmed.'})])],
  approval: [user('u8','live','Use the helper.'), assistant('approval','live',[{type:'approval',approvalId:'approval-subagent',status:'pending',data:{title:'Allow command?',requestType:'command',interaction:'permission',submittable:true,subagent:{key:'approval-agent',label:'Layout reviewer'},choices:[{choiceId:'allow',label:'Allow',kind:'allow',scope:'once'}]}}])],
  zh: [user('u9','live','检查子代理。'), assistant('zh','live',[subagent('zh',{agentType:'审查',description:'检查窄窗口中的卡片层级和溢出处理。',lastActivity:'正在读取组件并检查间距。',toolCount:3})])],
  narrow: [user('u10','live','Check the long description.'), assistant('narrow','live',[subagent('narrow',{description:long,lastActivity:long,summary:long})])],
};
const transcripts = {
  expanded: {items:[assistant('sub-text','sub',[text('The transcript keeps ordinary subagent messages readable.')]),assistant('sub-tool','sub',[tool('subagent-command')]),assistant('sub-nested','sub',[{type:'subagent',data:{key:'nested-child',provider:'codex',name:'Nested helper',status:'completed',transcript:'none',summary:'Nested work stays a plain transcript line.'}}])],rev:2,truncated:false,source:'live'},
  native: {items:[user('kimi-prompt','sub','List and count folder files.'),user('kimi-followup','sub','Also include hidden files.'),assistant('kimi-text','sub',[text('Kimi loaded this report from the local agent session files.')]),assistant('kimi-tool','sub',[tool('kimi-command')])],rev:1,truncated:false,source:'native'},
};
const listeners = new Set(), readCalls = []; let sequence = 1, activeScenario = 'running';
window.threadterm = {onEvent(cb){listeners.add(cb); return () => listeners.delete(cb);}, async request(method,params){
  if(method==='chat.snapshot') return {items:cards[params.sessionId] || [],revision:1};
  if(method==='chat.draft.read') return {text:'',revision:0};
  if(method==='chat.queue.read') return {sessionId:params.sessionId,paused:false,items:[]};
  if(method==='chat.options') return {options:[],commands:[]};
  if(method==='chat.subagent.read') { readCalls.push({...params}); const key=params.key; return transcripts[key] || {items:[],rev:params.afterRev || 0,truncated:false,source:'live'}; }
  throw Error('Unexpected QA request '+method);
}};
window.qaReads = () => readCalls.slice();
window.qaTimerCounts = () => ({starts:intervalStarts,stops:intervalStops});
window.qaEmit = item => { const event={event:'chat.item',seq:sequence++,data:{sessionId:activeScenario,item}}; listeners.forEach(listener=>listener(event)); };
const root = createRoot(document.getElementById('root'));
window.qaRender = (scenario, locale='en', theme='light') => { activeScenario=scenario; document.documentElement.dataset.theme=theme; root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView key={scenario} session={{id:scenario,provider:scenario==='native'?'kimi':'codex',mode:'chat',status:scenario==='completed'?'idle':'running',readOnly:true,title:'Subagent card QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>); };
window.qaRender('running');
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

let app, page;
const report = { passed:false, scratch, checks:[], snapshots:[], errors:[] };
async function render(scenario, locale = 'en', theme = 'light') {
  await page.evaluate(([next, language, selectedTheme]) => window.qaRender(next, language, selectedTheme), [scenario, locale, theme]);
  await page.waitForFunction(() => document.querySelector('.chat-view'));
  const keys = { running:'running', parallel:'parallel-one', completed:'complete', failed:'failed', expanded:'expanded', native:'native', truncated:'truncated', zh:'zh', narrow:'narrow' };
  if (scenario !== 'approval') {
    await page.locator(`.chat-subagent-card[data-subagent-key="${keys[scenario]}"]`).waitFor({ state:'attached' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-subagent-heading')).display === 'flex');
  }
}
async function shot(name) { const path = join(out, name); await page.screenshot({path, animations:'disabled'}); report.snapshots.push(path); }
try {
  app = await electron.launch({args:[join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox']});
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  await render('running');
  const running = page.locator('.chat-subagent-card');
  assert.equal(await running.count(), 1, 'running card is visible');
  assert.match(await running.textContent() ?? '', /Now:.*Reading renderer/i, 'running card exposes current activity');
  assert.match(await running.textContent() ?? '', /Running/i, 'running card exposes state');
  assert.equal((await page.evaluate(() => window.qaReads())).length, 0, 'collapsed card never reads a transcript');
  assert.equal(await page.locator('.chat-tool-activity').count(), 2, 'live cards remain between their surrounding tool drawers');
  assert.ok((await page.evaluate(() => window.qaTimerCounts())).starts >= 1, 'running card owns an elapsed-time interval');
  const markBounds = await running.locator('.chat-subagent-status .brand-ico').first().evaluate(node => { const box=node.getBoundingClientRect(); return {width:box.width,height:box.height}; });
  assert.ok(markBounds.width <= 16 && markBounds.height <= 16, 'running mark remains inside the status pill');
  await shot('01-running-single-light.png');

  await render('parallel');
  assert.equal(await page.locator('.chat-subagent-card').count(), 3, 'parallel agents render as independent cards');
  await shot('02-parallel-running-light.png');

  await render('completed');
  const completed = page.locator('.chat-subagent-card');
  assert.match(await completed.textContent() ?? '', /The renderer already uses/i, 'completed card previews its summary');
  assert.equal(await completed.locator('.chat-subagent-description').textContent(), 'count_files', 'Codex path fallback uses its last segment');
  assert.equal(await completed.evaluate(node => Boolean(node.closest('.codex-work'))), false, 'completed card is outside the elapsed work fold');
  assert.equal(await page.locator('.chat-tool-activity').count(), 1, 'parent tool drawer remains before completed cards');
  const work = page.locator('.codex-work');
  assert.equal(await work.count(), 1, 'completed Codex-style turn retains its elapsed fold');
  assert.equal(await work.evaluate(node => node.open), false, 'elapsed fold starts closed');
  assert.ok((await page.evaluate(() => window.qaTimerCounts())).stops >= 1, 'leaving the running card clears its elapsed-time interval');
  assert.equal(await completed.evaluate(node => node.previousElementSibling?.classList.contains('chat-tool-activity-card')), true, 'completed card follows the parent tool drawer');
  await shot('03-completed-summary-light.png');
  await work.locator('> summary').click();
  assert.equal(await completed.evaluate(node => Boolean(node.closest('.codex-work'))), false, 'opening elapsed fold never captures the card');
  await shot('10-completed-turn-outside-fold-light.png');

  await render('failed');
  assert.match(await page.locator('.chat-subagent-card').textContent() ?? '', /Failed/i, 'failed card exposes its state');
  assert.match(await page.locator('.chat-subagent-meta').textContent() ?? '', /1 tool(?!s)/, 'card meta uses singular tool copy');
  await shot('04-failed-light.png');

  await render('expanded');
  const expanded = page.locator('.chat-subagent-card');
  assert.equal((await page.evaluate(() => window.qaReads())).length, 0, 'a new collapsed card still has no read');
  await expanded.locator('> details > summary').click();
  await page.locator('.chat-subagent-transcript').waitFor({state:'attached'});
  assert.deepEqual(await page.evaluate(() => window.qaReads()), [{sessionId:'expanded',key:'expanded',afterRev:0}], 'opening reads once from the initial transcript revision');
  await page.waitForTimeout(1100);
  assert.equal((await page.evaluate(() => window.qaReads())).length, 1, 'open running card does not poll without a newer revision');
  assert.equal(await page.locator('.chat-subagent-card .chat-subagent-card').count(), 0, 'nested subagent stays a plain transcript line');
  assert.ok(await page.locator('.chat-subagent-transcript .chat-tool-activity').count(), 'transcript tools reuse the activity drawer');
  await expanded.locator('.chat-subagent-task > summary').click();
  const prompt = expanded.locator('.chat-subagent-prompt');
  await expanded.getByRole('button', {name:'Show more'}).waitFor({state:'visible'});
  assert.equal(await prompt.evaluate(node => node.classList.contains('is-expanded')), false, 'long task starts clamped to twelve lines');
  await expanded.getByRole('button', {name:'Show more'}).click();
  assert.equal(await prompt.evaluate(node => node.classList.contains('is-expanded')), true, 'Show more expands a clipped task');
  await expanded.getByRole('button', {name:'Show less'}).click();
  assert.equal(await prompt.evaluate(node => node.classList.contains('is-expanded')), false, 'Show less restores the clamp');
  await expanded.locator('.chat-subagent-task > summary').click();
  await expanded.locator('.chat-tool-activity > summary').click();
  await expanded.locator('.chat-tool-entry').waitFor({state:'visible'});
  await shot('05-expanded-transcript-light.png');
  await page.evaluate(() => window.qaEmit({id:'expanded',role:'assistant',turnId:'live',createdAt:'later',parts:[{type:'subagent',data:{key:'expanded',provider:'codex',status:'running',transcript:'live',rev:3,lastActivity:'Reading update'}}]}));
  await page.waitForFunction(() => window.qaReads().length === 2);
  assert.deepEqual(await page.evaluate(() => window.qaReads().at(-1)), {sessionId:'expanded',key:'expanded',afterRev:2}, 'an expanded card reads incrementally after revision growth');
  await expanded.locator('> details > summary').click();
  await page.evaluate(() => window.qaEmit({id:'expanded',role:'assistant',turnId:'live',createdAt:'later',parts:[{type:'subagent',data:{key:'expanded',provider:'codex',status:'running',transcript:'live',rev:4,lastActivity:'Closed update'}}]}));
  await page.waitForTimeout(100);
  assert.equal((await page.evaluate(() => window.qaReads())).length, 2, 'closed card ignores revision growth');
  await expanded.locator('> details > summary').click();
  await page.waitForFunction(() => window.qaReads().length === 3);
  assert.deepEqual(await page.evaluate(() => window.qaReads().at(-1)), {sessionId:'expanded',key:'expanded',afterRev:2}, 'reopening catches up from cached revision once');

  await render('native');
  const native = page.locator('.chat-subagent-card');
  await native.locator('> details > summary').click();
  await native.locator('.chat-subagent-note').waitFor({state:'visible'});
  assert.match(await native.textContent() ?? '', /only reports a final summary/i, 'none transcript explains its availability');
  assert.equal((await page.evaluate(() => window.qaReads())).filter(call => call.key === 'native').length, 0, 'none transcript never requests unavailable rows');
  assert.equal(await page.locator('.v3-chat-log article.v3-chat-message').count(), 2, 'retracted empty snapshot renders no article');
  assert.equal(await page.locator('.chat-tool-activity').count(), 0, 'retracted Agent is absent from the parent drawer');
  await page.evaluate(() => window.qaEmit({id:'native',role:'assistant',turnId:'done',createdAt:'later',parts:[{type:'subagent',data:{key:'native',provider:'kimi',agentType:'coder',description:'Kimi agent transcript becomes available after completion.',usage:{durationMs:134000},status:'completed',transcript:'native',rev:1,prompt:'List and count folder files.',summary:'Found **3 files** in `src`.'}}]}));
  await page.waitForFunction(() => document.querySelector('.chat-subagent-card')?.textContent?.includes('Loaded from'));
  assert.equal((await page.evaluate(() => window.qaReads())).filter(call => call.key === 'native').length, 1, 'native transition reads its available rows once');
  await native.locator('> details > summary').click(); await native.locator('> details > summary').click(); await page.waitForTimeout(100);
  assert.equal((await page.evaluate(() => window.qaReads())).filter(call => call.key === 'native').length, 1, 'native transcript does not reread on reopen');
  assert.match(await native.textContent() ?? '', /Loaded from/i, 'none to native transition explains native source');
  assert.equal(await native.locator('.chat-subagent-preview').textContent(), 'Found 3 files in src.', 'summary preview hides inline Markdown delimiters');
  assert.equal(await native.locator('.chat-subagent-transcript .v3-chat-message.user').count(), 1, 'leading prompt echo is removed while later user rows remain');
  assert.equal(await native.locator('.chat-subagent-transcript .v3-chat-message.user').textContent(), 'Also include hidden files.', 'later user message is retained');
  const userStyle = await native.locator('.chat-subagent-transcript .v3-chat-message.user').evaluate(node => ({padding:getComputedStyle(node).padding,fontSize:getComputedStyle(node).fontSize}));
  assert.deepEqual(userStyle, {padding:'6px 8px',fontSize:'12px'}, 'transcript user messages use compact styling');
  await native.locator('.chat-subagent-task > summary').click();
  assert.equal(await native.locator('.chat-subagent-prompt').textContent(), 'List and count folder files.', 'Task remains the single prompt display');
  await shot('06-kimi-native-light.png');

  await render('truncated');
  const truncated = page.locator('.chat-subagent-card');
  await truncated.locator('> details > summary').click();
  await truncated.getByText('Earlier steps were trimmed', {exact:false}).waitFor({state:'visible'});
  assert.match(await truncated.textContent() ?? '', /Earlier steps were trimmed/i, 'trimmed transcript note is visible');
  await shot('07-truncated-light.png');

  await render('approval');
  assert.match(await page.locator('.chat-approval-card').textContent() ?? '', /Subagent.*Layout reviewer/i, 'approval identifies the requesting subagent');
  assert.ok(await page.locator('.chat-subagent-chip').count(), 'approval subagent chip uses its dedicated class');
  await shot('08-approval-chip-light.png');

  await render('zh', 'zh-CN');
  assert.match(await page.locator('.chat-subagent-card').textContent() ?? '', /正在|审查/, 'Chinese locale uses localized card copy');
  assert.match(await page.locator('.chat-subagent-meta').textContent() ?? '', /3 个工具/, 'card meta localizes tool count');
  await shot('09-zh-light.png');

  await render('narrow');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(320, 900));
  assert.equal(await page.evaluate(() => document.querySelector('.v3-chat-log').scrollWidth <= document.querySelector('.v3-chat-log').clientWidth), true, 'long narrow content has no horizontal overflow');
  const visibleTitlePrefix = await page.locator('.chat-subagent-description').evaluate(node => {
    const text = node.firstChild;
    const bounds = node.getBoundingClientRect();
    const prefix = node.textContent.slice(0, 25);
    // textContent alone includes clipped text; check each glyph's painted line
    // against the two-line clamp and reserve room for its trailing ellipsis.
    for (let index = 0; index < prefix.length; index++) {
      const range = document.createRange();
      range.setStart(text, index); range.setEnd(text, index + 1);
      const glyph = range.getBoundingClientRect();
      if (glyph.top < bounds.top || glyph.bottom > bounds.bottom + 1 || glyph.right > bounds.right - 12) return null;
    }
    return prefix;
  });
  assert.equal(visibleTitlePrefix, 'A deliberately long descr', 'narrow title visibly retains its first 25 description characters');
  assert.equal(await page.locator('.chat-subagent-heading .chat-subagent-chip').count(), 0, 'type chip leaves the primary title row');
  assert.equal(await page.locator('.chat-subagent-meta .chat-subagent-chip').count(), 1, 'type chip belongs to muted meta');
  await shot('11-narrow-light.png');
  await page.evaluate(() => { document.documentElement.dataset.theme='dark'; });
  await shot('12-narrow-dark.png');

  assert.deepEqual(report.errors, []);
  report.checks.push('all ten S7 states: running, parallel, completed, failed, expanded, none-to-native, truncated, approval, zh, and completed-turn placement');
  report.checks.push('lazy transcript reads, incremental expanded revision reads, no collapsed reads, nested plain lines, reusable transcript tool drawer, and narrow no-overflow');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({path:join(out, 'failure.png'),animations:'disabled'}).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close();
  console.log(`${report.passed ? 'SUBAGENT CARD VISUAL QA PASSED' : 'SUBAGENT CARD VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
