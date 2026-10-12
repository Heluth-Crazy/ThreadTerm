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
const question = (status='pending', nativeTitle) => ({type:'approval',approvalId:'b10-question',status,data:{approvalId:'b10-question',interaction:'question',answerable:true,...(nativeTitle?{title:nativeTitle}:{}),form:{kind:'questions',questions:[{id:'q0',header:'Choice',question:'Which color should I use?',options:[{label:'Blue',description:'A calm default'}],multiSelect:false,allowOther:false,secret:false}]},...(status==='answered'?{answerSummary:{q0:'Blue'}}:{})}});
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
  // Adapters may append final text to an existing row that also carries the
  // resolved question. Completed presentation must seat that question first.
  assistant('answer',[text('The inspection is complete.'),{type:'approval',approvalId:'question-late',status:'answered',data:{approvalId:'question-late',interaction:'question',answerable:true,form:{kind:'questions',questions:[{id:'q0',header:'Choice',question:'Which check?',options:[{label:'Typecheck'}],multiSelect:false,allowOther:false,secret:false}]},answerSummary:{q0:'Typecheck'}}}]),
  assistant('turn-complete',[],{elapsedMs:18000}),
];
const b10Items = (questionStatus='pending') => [
  {id:'b10-user',role:'user',turnId:'turn-b10',createdAt:'now',parts:[text('Pick a color.')]},
  {id:'b10-before',role:'assistant',turnId:'turn-b10',createdAt:'now',parts:[text('Before the question.')]},
  {id:'b10-read',role:'assistant',turnId:'turn-b10',createdAt:'now',parts:[{type:'tool',toolId:'b10-read',toolName:'Read',status:'completed',data:{path:'README.md'},text:'README.md'}]},
  {id:'b10-native-question',role:'assistant',turnId:'turn-b10',createdAt:'now',parts:[{type:'tool',toolId:'b10-question-tool',toolName:'Ask User',status:'completed',data:{title:'ask_user_question',_meta:{'x.ai/tool':{name:'ask_user_question',kind:'ask_user'}}}}]},
  {id:'b10-question-card',role:'assistant',turnId:'turn-b10',createdAt:'now',parts:[question(questionStatus)]},
  {id:'b10-after',role:'assistant',turnId:'turn-b10',createdAt:'now',parts:[text('After the answer.')],...(questionStatus==='answered'?{elapsedMs:2000}:{})},
];
const b11Question = (provider, status) => {
  const kimi = provider === 'kimi';
  const selected = kimi ? 'Sapphire' : 'Blue';
  return {type:'approval',approvalId:'b11-question',status,data:{approvalId:'b11-question',interaction:'question',answerable:true,...(kimi?{title:'AskUserQuestion'}:{}),form:{kind:'questions',questions:[{id:'q0',header:'Choice',question:kimi?'Which gemstone should be selected: Sapphire or Amber?':'Which color should the QA use?',options:kimi?[{label:'Sapphire'},{label:'Amber'}]:[{label:'Blue'},{label:'Red'}],multiSelect:false,allowOther:false,secret:false}]},...(status==='answered'?{answerSummary:{q0:selected}}:{})}};
};
const b11Items = (provider, answered=false, questionOnly=false) => {
  const grok = provider === 'grok';
  const questionTool = grok
    ? {type:'tool',toolId:'b11-question-tool',toolName:'Ask User',status:answered?'completed':'running',data:{_meta:{'x.ai/tool':{name:'ask_user_question',kind:'ask_user',label:'Ask User'}},...(answered?{rawOutput:{type:'AskUserQuestion'}}:{})}}
    : {type:'tool',toolId:'b11-question-tool',toolName:'Asking user questions',status:answered?'complete':'running',data:{title:'Asking user questions',toolCallId:'b11-question-tool',status:answered?'completed':'running'}};
  return [
    {id:'b11-'+provider+'-user',role:'user',turnId:'turn-b11-'+provider,createdAt:'now',parts:[text('Ask one question.')]},
    ...(!questionOnly ? [{id:'b11-'+provider+'-read',role:'assistant',turnId:'turn-b11-'+provider,createdAt:'now',parts:[{type:'tool',toolId:'b11-read',toolName:'Read',status:'completed',data:{path:'README.md'}}]}] : []),
    {id:'b11-'+provider+'-question-tool',role:'assistant',turnId:'turn-b11-'+provider,createdAt:'now',parts:[questionTool]},
    {id:'b11-'+provider+'-question-card',role:'assistant',turnId:'turn-b11-'+provider,createdAt:'now',parts:[b11Question(provider,answered?'answered':'pending')]},
    {id:'b11-'+provider+'-answer',role:'assistant',turnId:'turn-b11-'+provider,createdAt:'now',parts:[text(grok?'Blue':'Sapphire')],...(answered?{elapsedMs:2000}:{})},
  ];
};
const listeners = new Set(); let sequence = 1, activeSessionId = 'tool-activity-codex', scenario = 'normal';
window.threadterm = {onEvent: cb => {listeners.add(cb); return () => listeners.delete(cb);},request:async method => {
  if(method==='chat.snapshot') return {items:scenario==='b10-pending'?b10Items():scenario==='b10-answered'?b10Items('answered'):scenario.startsWith('b11-')?b11Items(scenario.split('-')[1],scenario.includes('-completed'),scenario.endsWith('only')):items,revision:1};
  if(method==='chat.draft.read') return {text:'',revision:0};
  if(method==='chat.queue.read') return {sessionId:activeSessionId,paused:false,items:[]};
  if(method==='chat.options') return {options:[],commands:[]};
  throw Error('Unexpected QA request '+method);
}};
window.qaUpdate = item => { const event={event:'chat.item',seq:sequence++,data:{sessionId:activeSessionId,item}}; listeners.forEach(listener=>listener(event)); };
const root = createRoot(document.getElementById('root'));
window.qaRender = (provider,status='running') => { scenario='normal'; activeSessionId='tool-activity-'+provider; return root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:activeSessionId,provider,mode:'chat',status,readOnly:true,title:'Tool activity QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>); };
window.qaRenderB10 = (locale='en',answered=false) => { scenario=answered?'b10-answered':'b10-pending'; activeSessionId='tool-activity-b10-'+scenario; return root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:activeSessionId,provider:'grok',mode:'chat',status:answered?'idle':'waiting',readOnly:true,title:'B10 QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>); };
window.qaRenderB11 = (provider,completed=false,questionOnly=false) => { scenario='b11-'+provider+'-'+(completed?'completed-':'')+(questionOnly?'only':'live'); activeSessionId='tool-activity-'+scenario; return root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:activeSessionId,provider,mode:'chat',status:completed?'idle':'waiting',readOnly:true,title:'B11 QA',createdAt:'now',updatedAt:'now'}} /></SessionSurfaceContext.Provider></I18nProvider>); };
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  app = await electron.launch({ args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox'], env });
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
    assert.match(await summary.locator('.chat-tool-count').textContent() ?? '', /Explored 1 file.*Searched 1.*Ran 3 commands.*Used 4 tools/, `${provider}: idle summary describes the turn's tool work`);
    assert.equal(await summary.locator('.chat-tool-active-count').count(), 0, `${provider}: completed turn never claims an active tool`);
    assert.equal(await drawer.evaluate(node => Boolean(node.closest('.codex-work'))), false, `${provider}: completed tool activity stays outside elapsed commentary fold`);
    assert.equal(await page.locator('.chat-tool-failures').count(), 1, `${provider}: failures have a visible row outside details body`);
    assert.equal(await page.locator('.chat-part.approval').count(), 2, `${provider}: approval and question remain independent`);
    const question = page.locator('.chat-question-wrapper');
    const final = page.getByText('The inspection is complete.', { exact: true });
    assert.equal(await question.isVisible(), true, `${provider}: completed question stays outside the activity fold`);
    assert.ok((await question.boundingBox()).y < (await final.boundingBox()).y, `${provider}: mixed-row question renders before final answer text`);
    assert.ok(await page.getByText('A visible provider error remains outside tool activity.').count(), `${provider}: errors remain independent`);
  }
  report.checks.push('all providers use one generic normal-turn drawer with ordered entries, independent approval/error/failure rows, and no legacy nested drawers');
  report.checks.push('completed mixed-row answered questions render before final answer for all seven provider descriptors');

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

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  await page.evaluate(() => window.qaRenderB10('en'));
  await page.waitForFunction(() => document.querySelector('.chat-view')?.getAttribute('data-provider') === 'grok' && document.querySelectorAll('.chat-tool-activity').length === 1);
  const b10Drawer = page.locator('.chat-tool-activity');
  assert.equal(await b10Drawer.locator('.chat-tool-entry').count(), 1, 'B10: only the real tool remains in the drawer');
  assert.equal(await b10Drawer.locator('[data-tool-id="b10-read"]').count(), 1, 'B10: the existing real tool remains visible');
  assert.equal(await b10Drawer.locator('[data-tool-id="b10-question-tool"]').count(), 0, 'B10: Grok native question tool is hidden behind its question card');
  assert.match(await b10Drawer.locator('.chat-tool-current-action').textContent() ?? '', /^Waiting for your answer$/, 'B10: pending question changes the English drawer header');
  const b10Before = page.getByText('Before the question.', { exact: true });
  const b10Card = page.locator('.chat-question-wrapper');
  const b10After = page.getByText('After the answer.', { exact: true });
  assert.ok((await b10Before.boundingBox()).y < (await b10Card.boundingBox()).y, 'B10: question card follows the first text segment');
  assert.ok((await b10Card.boundingBox()).y < (await b10After.boundingBox()).y, 'B10: second text segment follows the question card');
  const b10PendingWide = join(out, 'b10-pending-wide-en.png');
  await page.screenshot({ path:b10PendingWide, animations:'disabled' }); report.snapshots.push(b10PendingWide);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 900));
  await page.evaluate(() => window.qaRenderB10('zh-CN'));
  await page.waitForFunction(() => document.querySelector('.chat-tool-current-action')?.textContent?.trim() === '等待你的回答');
  assert.equal(await page.locator('[data-tool-id="b10-question-tool"]').count(), 0, 'B10: native question remains hidden in Chinese');
  const b10PendingNarrow = join(out, 'b10-pending-narrow-zh.png');
  await page.screenshot({ path:b10PendingNarrow, animations:'disabled' }); report.snapshots.push(b10PendingNarrow);
  assert.equal(await page.evaluate(() => document.querySelector('.v3-chat-log').scrollWidth <= document.querySelector('.v3-chat-log').clientWidth), true, 'B10: narrow pending question has no horizontal overflow');

  await page.evaluate(() => window.qaRenderB10('en', true));
  await page.locator('.chat-question-status').filter({ hasText:'Answered' }).waitFor({ state:'visible' });
  const answeredBefore = page.getByText('Before the question.', { exact: true });
  const answeredCard = page.locator('.chat-question-wrapper');
  const answeredAfter = page.getByText('After the answer.', { exact: true });
  assert.ok((await answeredBefore.boundingBox()).y < (await answeredCard.boundingBox()).y, 'B10: answered card remains after the first text segment');
  assert.ok((await answeredCard.boundingBox()).y < (await answeredAfter.boundingBox()).y, 'B10: completed final reply remains after the answered card');
  const b10AnsweredNarrow = join(out, 'b10-answered-narrow-en.png');
  await page.screenshot({ path:b10AnsweredNarrow, animations:'disabled' }); report.snapshots.push(b10AnsweredNarrow);
  report.checks.push('B10 renders segmented parent text around a native question card, hides its native tool row, localizes the pending drawer header, and preserves answered completed order');

  for (const provider of ['grok', 'kimi']) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
    await page.evaluate(value => window.qaRenderB11(value), provider);
    await page.waitForFunction(value => document.querySelector('.chat-view')?.getAttribute('data-provider') === value, provider);
    const liveQuestion = page.locator('.chat-tool-activity');
    assert.equal(await liveQuestion.count(), 1, `${provider}: live mixed question turn retains its real-tool drawer`);
    assert.equal(await liveQuestion.locator('.chat-tool-entry').count(), 1, `${provider}: live drawer retains only the real tool`);
    assert.equal(await liveQuestion.locator('[data-tool-id="b11-read"]').count(), 1, `${provider}: live real tool remains visible`);
    assert.equal(await liveQuestion.locator('[data-tool-id="b11-question-tool"]').count(), 0, `${provider}: live native question tool is hidden`);
    const liveShot = join(out, `b11-${provider}-live-wide.png`);
    await page.screenshot({ path:liveShot, animations:'disabled' }); report.snapshots.push(liveShot);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 900));
    await page.evaluate(value => window.qaRenderB11(value, true), provider);
    await page.locator('.chat-question-status').filter({ hasText:'Answered' }).waitFor({ state:'visible' });
    const completedQuestion = page.locator('.chat-tool-activity');
    assert.equal(await completedQuestion.count(), 1, `${provider}: completed mixed question turn retains its real-tool drawer`);
    assert.equal(await completedQuestion.locator('.chat-tool-entry').count(), 1, `${provider}: completed drawer retains only the real tool`);
    assert.equal(await completedQuestion.locator('[data-tool-id="b11-question-tool"]').count(), 0, `${provider}: completed native question tool is hidden`);
    assert.equal(await page.evaluate(() => document.querySelector('.v3-chat-log').scrollWidth <= document.querySelector('.v3-chat-log').clientWidth), true, `${provider}: narrow completed question has no horizontal overflow`);
    const completeShot = join(out, `b11-${provider}-completed-narrow.png`);
    await page.screenshot({ path:completeShot, animations:'disabled' }); report.snapshots.push(completeShot);

    await page.evaluate(value => window.qaRenderB11(value, false, true), provider);
    await page.waitForFunction(() => document.querySelector('.chat-question-wrapper'));
    assert.equal(await page.locator('.chat-tool-activity').count(), 0, `${provider}: a question-only live turn has no empty drawer`);
    await page.evaluate(value => window.qaRenderB11(value, true, true), provider);
    await page.locator('.chat-question-status').filter({ hasText:'Answered' }).waitFor({ state:'visible' });
    assert.equal(await page.locator('.chat-tool-activity').count(), 0, `${provider}: a question-only completed turn has no empty drawer`);
  }
  report.checks.push('B11 hides preserved Grok Ask User metadata and recorded Kimi Asking user questions rows live and completed, retaining real tools without empty question-only drawers');

  // Return to the mixed-tool fixture before its generic visual matrix so B10
  // coverage supplements rather than replaces the established drawer review.
  await page.evaluate(() => window.qaRender('codex', 'idle'));
  await page.waitForFunction(() => document.querySelectorAll('.chat-tool-entry').length === 9);
  assert.equal(await page.locator('.chat-tool-entry').count(), 9, 'generic screenshots retain the mixed-tool fixture after B10');
  if (await drawer.evaluate(node => node.open)) await summary.click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 420, 1280, 1440, 1920]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
      await page.waitForFunction(value => window.innerWidth === value, width);
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
  report.checks.push('light/dark 320/420/1280/1440/1920 screenshots include collapsed and expanded generic activity drawers');
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
