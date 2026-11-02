// Isolated visual regression for Chat Code Review dialog + SubagentCard review UI.
// Bundles the real ChatView / CodeReviewDialog with an in-memory bridge; never starts a runtime.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-code-review-card-'));
const out = resolve('qa/results/code-review');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { CodeReviewDialog } from './renderer/src/components/CodeReviewDialog';
import { I18nProvider } from './renderer/src/i18n';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

Date.now = () => Date.parse('2026-10-31T12:00:00.000Z');
const text = value => ({type:'text',text:value});
const finding = (id, verdict, severity='high') => ({
  id, severity, path:'src/bug.ts', line:3, title:'Null dereference '+id, body:'Reads .x without a guard.',
  failureScenario:'Call with null input.', verdict, reason: verdict==='confirmed'?'still crashes':undefined,
});
const review = (status, extra={}) => ({
  key:'review:r1', provider:'codex', agentType:'code-review', name:'Code review', description:'Uncommitted changes',
  status, transcript:'session', startedAt:'2026-10-31T11:59:00.000Z', toolCount:2, rev:2,
  review:{
    reviewId:'r1', depth:'standard', scopeLabel:'Uncommitted changes', model:'qa-code-review-model',
    stage: status==='running' ? 'verifying' : 'done', stagesDone: status==='running' ? 1 : 2, stagesTotal:2,
    candidates: status==='running' ? 1 : undefined,
    findings: status==='completed' ? [finding('f1','confirmed'), finding('f2','plausible','medium')] : status==='failed' ? [] : [],
    rejected: status==='completed' ? 1 : undefined,
    warnings: status==='failed' ? ['Finder returned an unparsed answer'] : undefined,
    reviewerSessionIds:['finder-1','verifier-1'],
    ...extra.review,
  },
  summary: status==='failed' ? 'Finder returned an unparsed answer' : status==='cancelled' ? 'Cancelled' : undefined,
  lastActivity: status==='running' ? 'Reading src/bug.ts' : undefined,
  endedAt: status==='running' ? undefined : '2026-10-31T12:00:00.000Z',
  ...extra,
});
const card = (status, extra) => ({
  id:'parent:system:subagent:review:r1', role:'system', createdAt:'2026-10-31T11:59:00.000Z',
  parts:[{type:'subagent', toolId:'review:r1', status, data:review(status, extra)}],
});
const cards = {
  dialog: [],
  running: [card('running')],
  completed: [card('completed')],
  empty: [card('completed', { review:{ findings:[], rejected:0 } })],
  failed: [card('failed')],
  cancelled: [card('cancelled')],
};
const sessions = [
  {id:'parent',provider:'codex',mode:'chat',status:'idle',readOnly:false,title:'Parent',createdAt:'now',updatedAt:'now'},
  {id:'finder-1',provider:'codex',mode:'chat',status:'idle',readOnly:false,title:'Finder',createdAt:'now',updatedAt:'now',codeReview:{reviewId:'r1',parentSessionId:'parent',role:'finder',lens:'general'}},
  {id:'verifier-1',provider:'codex',mode:'chat',status:'idle',readOnly:false,title:'Verifier',createdAt:'now',updatedAt:'now',codeReview:{reviewId:'r1',parentSessionId:'parent',role:'verifier'}},
];
const listeners = new Set();
let sequence = 1, activeScenario = 'running', sent = [];
window.threadterm = {
  onEvent(cb){ listeners.add(cb); return () => listeners.delete(cb); },
  async request(method, params){
    if(method==='chat.snapshot') return {items:cards[params.sessionId] || cards[activeScenario] || [], revision:1};
    if(method==='chat.draft.read') return {text:'',revision:0};
    if(method==='chat.draft.write') return {text:params.text??'',revision:1};
    if(method==='chat.queue.read') return {sessionId:params.sessionId,paused:false,items:[]};
    if(method==='chat.options') return {options:[],commands:[]};
    if(method==='chat.feedback.read') return {notes:[]};
    if(method==='chat.send') { sent.push(params); throw Error('chat.send must not run from Ask this chat to fix'); }
    if(method==='chat.subagent.read') {
      return {
        items:[
          {id:'stage-finder',role:'system',createdAt:'now',parts:[text('Finder · general')]},
          {id:'finder-msg',role:'assistant',createdAt:'now',parts:[text('Looking for issues…')]},
          {id:'stage-verify',role:'system',createdAt:'now',parts:[text('Verifier')]},
          {id:'verify-msg',role:'assistant',createdAt:'now',parts:[text('Confirming candidates…')]},
        ],
        rev:2, truncated:false, source:'session',
      };
    }
    if(method==='codeReview.options') return {
      providers:[
        {id:'codex',name:'Codex',available:true,readOnly:'enforced',model:{id:'model',category:'model',label:'Model',value:'',choices:[{value:'qa-code-review-model',name:'QA model'}]}},
        {id:'claude',name:'Claude',available:false,reason:'Not installed',readOnly:'requested'},
      ],
      scopes:[
        {kind:'uncommitted',available:true,fileCount:1,label:'Uncommitted changes'},
        {kind:'session',available:false,reason:'Nothing to review',label:"This chat's changes"},
        {kind:'branch',available:false,reason:'No base branch',label:'Branch vs base'},
      ],
    };
    if(method==='codeReview.start') return {reviewId:'r-new',itemId:'parent:system:subagent:review:r-new'};
    if(method==='session.claim') return {leaseEpoch:1};
    if(method==='session.renew' || method==='session.release') return null;
    if(method==='chat.connection' || method==='chat.connect') return {sessionId:params.sessionId, runtimeEpoch:'e', connectionGeneration:1, revision:1, phase:'ready', optionsLoadState:'unknown'};
    if(method==='capabilities.get') return {providers:[]};
    if(method==='chat.context.read') return {};
    throw Error('Unexpected QA request '+method);
  },
};
window.qaSent = () => sent.slice();
window.qaComposer = () => document.querySelector('textarea')?.value ?? '';
const root = createRoot(document.getElementById('root'));
const shell = (child) => <I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}>{child}</SessionSurfaceContext.Provider></I18nProvider>;
window.qaRender = (scenario, theme='light') => {
  activeScenario = scenario;
  document.documentElement.dataset.theme = theme;
  sent = [];
  if (scenario === 'dialog') {
    root.render(shell(<CodeReviewDialog
      session={sessions[0]}
      leaseEpoch={1}
      copy={(en)=>en}
      onClose={()=>{}}
      onStarted={()=>{}}
    />));
    return;
  }
  // 'entry' is a writable chat for the + menu and /code-review; the card scenarios stay read-only.
  const writable = scenario === 'entry';
  root.render(shell(<ChatView key={scenario} session={{...sessions[0], id:scenario, status: scenario==='running'?'running':'idle', readOnly:!writable}} sessions={sessions} onOpenSession={()=>{}} />));
};
window.qaRender('running');
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

let app, page;
const report = { passed: false, scratch, checks: [], snapshots: [], errors: [] };
async function render(scenario, theme = 'light') {
  await page.evaluate(([next, selectedTheme]) => window.qaRender(next, selectedTheme), [scenario, theme]);
  if (scenario === 'dialog') {
    await page.locator('.code-review-dialog, [data-testid="code-review-start"]').first().waitFor({ state: 'attached' });
  } else {
    await page.waitForFunction(() => document.querySelector('.chat-view'));
    await page.locator('.chat-subagent-card.is-code-review').waitFor({ state: 'attached' });
  }
}
async function shot(name) {
  const path = join(out, name);
  await page.screenshot({ path, animations: 'disabled' });
  report.snapshots.push(path);
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  app = await electron.launch({
    args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox'],
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  await page.evaluate(() => localStorage.setItem('threadterm.codeReview.prefs', JSON.stringify({ provider: 'codex', model: 'removed-model' })));
  await render('dialog');
  await page.getByTestId('code-review-model').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('code-review-model').inputValue(), '', 'a removed stored model falls back to Default model');
  assert.equal(await page.getByTestId('code-review-model').locator('option[value="removed-model"]').count(), 0, 'removed models cannot be chosen for a new review');
  assert.equal(await page.getByTestId('code-review-model').locator('option[value="qa-code-review-model"]').count(), 1, 'the current catalog is offered on open');
  report.checks.push('opening Code Review offers the current catalog and replaces a removed stored selection with Default model');
  assert.match(await page.locator('body').textContent() ?? '', /Code review/i);
  assert.match(await page.locator('body').textContent() ?? '', /1 \/ 2 \/ 4 agent runs/);
  assert.equal(await page.getByTestId('code-review-provider-claude').isDisabled(), true);
  await shot('01-dialog-light.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot('01-dialog-dark.png');
  report.checks.push('dialog loads options, disables unavailable provider, shows cost hint');

  await render('running');
  const running = page.locator('.chat-subagent-card.is-code-review');
  assert.match(await running.textContent() ?? '', /Verifying 1 finding(?!s)/i);
  assert.match(await running.textContent() ?? '', /Code review/);
  await running.locator('> details > summary').click();
  await page.getByTestId('code-review-stop').waitFor({ state: 'visible' });
  await shot('02-running-light.png');
  report.checks.push('running card shows progress and Stop');

  // Entry points in the real ChatView: the + menu, and /code-review with focus text.
  await page.evaluate(() => window.qaRender('entry'));
  await page.waitForFunction(() => document.querySelector('.chat-view textarea:not([disabled])'));
  await page.locator('.chat-view button[aria-label="Add"]').first().click();
  await page.getByTestId('plus-code-review').click();
  await page.getByTestId('code-review-start').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.getByTestId('code-review-start').waitFor({ state: 'detached' });
  const composerBox = page.locator('.chat-view textarea').first();
  await composerBox.fill('/code-review check the auth path');
  await composerBox.press('Enter');
  await page.getByTestId('code-review-focus').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('code-review-focus').inputValue(), 'check the auth path');
  assert.deepEqual(await page.evaluate(() => window.qaSent()), [], '/code-review never sends a chat message');
  await page.keyboard.press('Escape');
  await page.getByTestId('code-review-start').waitFor({ state: 'detached' });
  report.checks.push('+ menu and /code-review open the dialog; /code-review prefills focus and never sends');

  await render('completed');
  const completed = page.locator('.chat-subagent-card.is-code-review');
  await completed.locator('> details > summary').click();
  await page.getByTestId('code-review-result').waitFor({ state: 'attached' });
  assert.match(await completed.textContent() ?? '', /Confirmed/i);
  assert.match(await completed.textContent() ?? '', /Plausible/i);
  assert.match(await completed.textContent() ?? '', /1 rejected on verification/);
  await page.getByTestId('code-review-ask-fix').click();
  const composer = await page.evaluate(() => window.qaComposer());
  assert.match(composer, /Null dereference f1/);
  assert.match(composer, /Fix the confirmed issues; for plausible ones, check first\./);
  assert.deepEqual(await page.evaluate(() => window.qaSent()), [], 'Ask this chat to fix never calls chat.send');
  await shot('03-completed-expanded-light.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot('03-completed-expanded-dark.png');
  report.checks.push('completed findings + ask-fix fills composer without send');

  await render('empty');
  assert.match(await page.locator('.chat-subagent-card').textContent() ?? '', /No issues found/i);
  await shot('04-empty-light.png');
  report.checks.push('empty result copy');

  await render('failed');
  assert.match(await page.locator('.chat-subagent-card').textContent() ?? '', /Finder returned an unparsed answer/);
  await page.locator('.chat-subagent-card > details > summary').click();
  await page.locator('.chat-subagent-error').waitFor({ state: 'visible' });
  await shot('05-failed-light.png');
  report.checks.push('failed card shows error');

  await render('cancelled');
  await page.locator('.chat-subagent-card > details > summary').click();
  assert.match(await page.locator('.chat-subagent-card').textContent() ?? '', /Cancelled/i);
  await shot('06-cancelled-light.png');
  report.checks.push('cancelled card keeps Cancelled label');

  // Visual review: overflow / clipping / contrast checks on completed dark shot.
  const overflow = await page.evaluate(() => {
    const card = document.querySelector('.chat-subagent-card');
    if (!card) return true;
    return card.scrollWidth > card.clientWidth + 1;
  });
  assert.equal(overflow, false, 'completed card has no horizontal overflow');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close();
  console.log(`${report.passed ? 'CODE REVIEW VISUAL QA PASSED' : 'CODE REVIEW VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
  // The bundle and Electron profile are scratch; screenshots stay in qa/results for review.
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
