// Isolated Electron fixture QA: Chat connection overlay and approval cards.
// Does not launch a provider or touch user runtime data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-connect-'));
const out = resolve('qa/results/chat-connect');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { PaneWorkspace } from './renderer/src/components/PaneWorkspace';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const listeners = [];
let phase = 'connecting';
let provider = 'kimi';
let items = [];
let options = [];
let connectHang = true;
let splitMode = false;
window.threadterm = {
  onEvent(cb){ listeners.push(cb); return ()=>{}; },
  async request(method, params){
    if(method==='chat.snapshot') return {items:splitMode && params.sessionId==='qa-split-ready' ? [{id:'ready-message',role:'assistant',turnId:'ready-turn',createdAt:'now',parts:[{type:'text',text:'Ready pane remains readable.'}]}] : items, revision:1};
    if(method==='chat.draft.read') return {text:'', revision:0};
    if(method==='chat.draft.save') return {text:params.text, revision:(params.expectedRevision||0)+1};
    if(method==='chat.options') return {options, commands:[], loadState: options.length ? 'ready' : 'unknown'};
    if(method==='chat.connection') return {sessionId:params.sessionId, runtimeEpoch:'e', connectionGeneration:1, revision:1, phase:splitMode && params.sessionId==='qa-split-ready' ? 'ready' : phase, optionsLoadState:'unknown'};
    if(method==='chat.connect'){
      if(connectHang) return new Promise(()=>{});
      if(phase==='failed') throw new Error('native_resume_failed: resume failed');
      return {sessionId:params.sessionId, runtimeEpoch:'e', connectionGeneration:2, revision:2, phase, optionsLoadState:'unknown'};
    }
    if(method==='session.claim') return {leaseEpoch:1};
    if(method==='session.renew') return {leaseEpoch:1};
    if(method==='session.release') return null;
    throw new Error('Unexpected QA request '+method);
  }
};
window.qaRender = (next) => {
  splitMode = false;
  provider = next.provider || provider;
  phase = next.phase || phase;
  items = next.items || items;
  options = next.options || [];
  connectHang = next.connectHang !== false;
  document.documentElement.dataset.theme = next.theme || 'light';
  const root = document.getElementById('root');
  root.replaceChildren();
  const session = {id:'qa-'+provider, provider, mode:'chat', status:'idle', title:'QA', createdAt:'now', updatedAt:'now'};
  createRoot(root).render(React.createElement(I18nProvider, {locale:'zh-CN'}, React.createElement(ChatView, {session})));
};
window.qaRenderSplit = () => {
  splitMode = true;
  phase = 'connecting';
  items = [];
  options = [];
  connectHang = true;
  document.documentElement.dataset.theme = 'light';
  const root = document.getElementById('root');
  root.replaceChildren();
  const sessions = [
    {id:'qa-split-running',provider:'grok',mode:'chat',status:'running',title:'Grok running startup',createdAt:'now',updatedAt:'now'},
    {id:'qa-split-ready',provider:'kimi',mode:'chat',status:'running',title:'Kimi ready session',createdAt:'now',updatedAt:'now'},
  ];
  const pane = (id, sessionId) => ({kind:'pane',id,tabs:[{id:'tab-'+sessionId,kind:'session',sessionId}],activeTabId:'tab-'+sessionId});
  const layout = {kind:'split',id:'qa-split',direction:'horizontal',ratio:.5,first:pane('qa-left',sessions[0].id),second:pane('qa-right',sessions[1].id)};
  createRoot(root).render(React.createElement(I18nProvider, {locale:'zh-CN'}, React.createElement(PaneWorkspace, {layout,sessions,theme:'light',terminalCompatibility:{},onChange:()=>{}})));
};
document.documentElement.dataset.theme='light';
window.qaRender({provider:'kimi', phase:'connecting'});
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>
html,body,#root{height:100%;margin:0}
#root{display:flex;flex-direction:column}
#root > *{flex:1;min-height:0;height:100%}
.chat-view.v3-session-chat{position:relative;height:100%;display:flex;flex-direction:column}
.chat-view.is-connecting > :not(.chat-connect-mask){visibility:hidden !important;pointer-events:none !important}
.chat-connect-mask{position:absolute !important;inset:0 !important;z-index:20 !important;display:grid;place-items:center;background:rgba(255,255,255,.94);color:#111}
html[data-theme="dark"] .chat-connect-mask{background:rgba(16,18,22,.94);color:#e8eef6}
.chat-connect-center{display:grid;justify-items:center;gap:12px;text-align:center;max-width:360px}
.chat-approval-actions{display:flex;flex-wrap:wrap;gap:8px}
.chat-approval-choice small{display:block;color:#667}
.btn{padding:6px 10px}
</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaRender);
  async function shot(name, setup, arg) {
    await page.evaluate(setup, arg);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, name) });
  }
  await page.locator('.chat-connect-mask').waitFor();
  assert.ok(await page.locator('[data-agent-icon="kimi"]').count());
  await page.screenshot({ path: join(out, 'kimi-connecting-light-1280.png') });
  await shot('codex-connecting-light-1280.png', () => window.qaRender({ provider: 'codex', phase: 'connecting' }));
  assert.ok(await page.locator('[data-agent-icon="codex"]').count());
  assert.equal(await page.locator('.chat-connect-logo .codex-tile').first().evaluate(el => getComputedStyle(el).display), 'none');
  assert.equal(await page.locator('.chat-connect-ripples').count(), 0);
  const wave = page.locator('.chat-connect-wave');
  for (const time of [500, 1100, 1700]) {
    await wave.evaluate((el, time) => { for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = time; } }, time);
    await page.screenshot({ path: join(out, `codex-corner-wave-${time}.png`) });
  }
  await shot('grok-connecting-light-1280.png', () => window.qaRender({ provider: 'grok', phase: 'connecting' }));
  assert.ok(await page.locator('[data-agent-icon="grok"]').count());
  await shot('kimi-failed-light-1280.png', () => window.qaRender({ provider: 'kimi', phase: 'failed', connectHang: false }));
  await page.locator('.chat-connect-mask.is-failed').waitFor();
  await shot('kimi-connecting-dark-1280.png', () => window.qaRender({ provider: 'kimi', phase: 'connecting', theme: 'dark' }));
  const approvalItems = [{
    id: 'approval-1', role: 'assistant', turnId: 't1', createdAt: 'now',
    parts: [{
      type: 'approval', approvalId: 'a1', status: 'pending',
      data: {
        approvalId: 'a1', title: 'Run command', requestType: 'session/request_permission', submittable: true,
        choices: [
          { choiceId: 'always', label: 'Always', kind: 'allow', scope: 'persistent' },
          { choiceId: 'once', label: 'Once', kind: 'allow', scope: 'once' },
        ],
      },
    }],
  }];
  await shot('kimi-approval-ready-1280.png', (items) => window.qaRender({
    provider: 'kimi', phase: 'ready', connectHang: false, items,
  }), approvalItems);
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot('codex-connecting-light-1440.png', () => window.qaRender({ provider: 'codex', phase: 'connecting', theme: 'light' }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await shot('grok-connecting-dark-1920.png', () => window.qaRender({ provider: 'grok', phase: 'connecting', theme: 'dark' }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('kimi-reduced-motion-1280.png', () => window.qaRender({ provider: 'kimi', phase: 'connecting', theme: 'light' }));
  await shot('split-running-connecting-ready-1280.png', () => window.qaRenderSplit());
  await page.locator('[data-testid="session-chat-qa-split-running"] .chat-connect-mask').waitFor();
  await page.getByText('Ready pane remains readable.').waitFor();
  assert.equal(await page.locator('.pane-workspace .chat-connect-mask').count(), 1, 'only the connecting split chat has a full logo mask');
  assert.equal(await page.locator('.pane-workspace .chat-reconnect-banner').count(), 0, 'activity status cannot downgrade a first connection to a banner');
  const splitMaskGeometry = await page.locator('.workspace-pane').first().evaluate(pane => {
    const body = pane.querySelector('.pane-body').getBoundingClientRect();
    const mask = pane.querySelector('.chat-connect-mask').getBoundingClientRect();
    return {body:{left:body.left,top:body.top,right:body.right,bottom:body.bottom},mask:{left:mask.left,top:mask.top,right:mask.right,bottom:mask.bottom}};
  });
  assert.deepEqual(splitMaskGeometry.mask, splitMaskGeometry.body, 'full mask stays inside its split pane body');
  assert.equal(await page.locator('[data-testid="session-chat-qa-split-ready"] .chat-connect-mask').count(), 0, 'ready sibling pane stays unobscured');
  assert.equal(errors.length, 0, errors.join('\n'));
  const geometry = [];
  const dialogue = [
    {id:'u',role:'user',turnId:'t',createdAt:'now',parts:[{type:'text',text:'Hello'}]},
    {id:'a',role:'assistant',turnId:'t',createdAt:'now',parts:[{type:'text',text:'Hello back'}]},
  ];
  for (const provider of ['kimi','codex','grok']) {
    await shot(`${provider}-message-layout.png`, ({provider,items}) => window.qaRender({provider,items,phase:'ready',connectHang:false,theme:'light'}), {provider,items:dialogue});
    geometry.push(await page.evaluate(() => {
      const user=document.querySelector('.v3-chat-message.user'), reply=document.querySelector('.v3-chat-message.assistant');
      const u=user.getBoundingClientRect(), a=reply.getBoundingClientRect();
      return {userRight:u.right,replyLeft:a.left,gap:a.top-u.bottom,padding:getComputedStyle(user).padding,font:getComputedStyle(user).fontSize};
    }));
  }
  for (const layout of geometry.slice(1)) {
    assert.deepEqual(layout, geometry[0], 'provider message geometry must match');
  }
  const bubbleDialogue = [
    {id:'u',role:'user',turnId:'t',createdAt:'now',parts:[{type:'text',text:'Please review this.\nSecond line of the user bubble.'}]},
    {id:'a',role:'assistant',turnId:'t',createdAt:'now',elapsedMs:7000,parts:[
      {type:'thinking',text:'Private thought',status:'complete'},
      {type:'text',text:'Here is a **reply** with `code`.\n\nSecond paragraph.'},
      {type:'tool',toolName:'Read',toolId:'read-1',status:'complete',text:'AGENTS.md'},
    ]},
  ];
  const bubbleChrome = [];
  for (const provider of ['kimi','codex','grok']) {
    await shot(`${provider}-bubbles.png`, ({provider,items}) => window.qaRender({provider,items,phase:'ready',connectHang:false,theme:'light'}), {provider,items:bubbleDialogue});
    bubbleChrome.push(await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return {
          padding: s.padding,
          margin: `${s.marginTop} ${s.marginRight} ${s.marginBottom} ${s.marginLeft}`,
          radius: s.borderRadius,
          bg: s.backgroundColor,
          color: s.color,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          maxWidth: s.maxWidth,
          border: s.border,
          boxShadow: s.boxShadow,
        };
      };
      const user = document.querySelector('.v3-chat-message.user');
      const reply = document.querySelector('.v3-chat-message.assistant');
      return {
        user: box(user),
        reply: box(reply),
        userText: box(user?.querySelector('.v3-message-text')),
        replyText: box(reply?.querySelector('.codex-markdown, .v3-message-text')),
      };
    }));
  }
  assert.deepEqual(bubbleChrome[2], bubbleChrome[0], 'grok message bubbles must match kimi');
  assert.deepEqual(bubbleChrome[2].user, bubbleChrome[1].user, 'grok user bubble must match codex');
  assert.deepEqual(bubbleChrome[2].reply, bubbleChrome[1].reply, 'grok assistant message box must match codex');
  const grokOptions = [
    {id:'model',name:'Model',value:'grok-4.6',choices:[{value:'grok-4.6',name:'Grok 4.6'}]},
    {id:'thinking',name:'Thinking',value:'high',choices:[{value:'high',name:'High'}]},
    {id:'mode',name:'Permission mode',value:'default',choices:[{value:'default',name:'Default'}]},
  ];
  const grokStatus = [{
    id:'status', role:'assistant', turnId:'status', createdAt:'now',
    parts:[{type:'text',text:'Session: grok-qa\nModel: grok-4.6\nMode: default\nWorking directory: D:\\\\repo'}],
  }];
  await shot('grok-compose-chips.png', ({provider,items,options}) => window.qaRender({provider,items,options,phase:'ready',connectHang:false,theme:'light'}), {provider:'grok',items:dialogue,options:grokOptions});
  await page.locator('.chat-model-chip').waitFor();
  await page.locator('.chat-mode-chip').waitFor();
  const grokChips = await page.evaluate(() => ({
    model: document.querySelector('.chat-model-chip')?.textContent?.replace(/\s+/g,' ').trim() ?? '',
    mode: document.querySelector('.chat-mode-chip')?.textContent?.replace(/\s+/g,' ').trim() ?? '',
  }));
  assert.match(grokChips.model, /Grok 4\.6/);
  assert.match(grokChips.mode, /默认|Default/);
  await shot('grok-status-card.png', ({provider,items}) => window.qaRender({provider,items,phase:'ready',connectHang:false,theme:'light'}), {provider:'grok',items:grokStatus});
  await page.locator('[data-testid="kimi-status-card"]').waitFor();
  assert.equal(await page.locator('[data-testid="kimi-status-card"]').count(), 1, 'grok /status uses the shared ACP status card');
  console.log('chat-connect visual fixtures written to', out);
} finally {
  await app?.close();
}
