// Isolated Electron fixture QA for the pending-first-response feedback. It never starts a provider or runtime.
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {_electron as electron} from '@playwright/test';
import {build} from 'esbuild';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-first-response-'));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from './renderer/src/components/ChatView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
let provider = 'kimi', sessionId = 'qa-kimi', items = [], locale = 'zh-CN', sessionStatus = 'idle', sessionUpdatedAt = 'initial', failNextSend = false, deferNextSend = false, omitUserOnSend = false, resolveDeferredSend, sequence = 0;
const listeners = new Set();
window.qaSendCount = 0;
const connection = id => ({sessionId:id, runtimeEpoch:'qa', connectionGeneration:1, revision:1, phase:'ready', optionsLoadState:'ready'});
window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    if (method === 'chat.snapshot') return {items, revision:0};
    if (method === 'chat.draft.read') return {text:'', revision:0};
    if (method === 'chat.draft.save') return {revision:(params.expectedRevision || 0) + 1};
    if (method === 'chat.connection' || method === 'chat.connect') return connection(params.sessionId);
    if (method === 'chat.options') return {options:[], commands:[], loadState:'ready'};
    if (method === 'chat.send') {
      window.qaSendCount++;
      if (failNextSend) { failNextSend=false; throw new Error('QA send failure'); }
      if (!omitUserOnSend) {
        const userItem={id:'user-'+(++sequence),role:'user',turnId:'turn-1',createdAt:'now',parts:[{type:'text',text:params.text}]};
        items=[...items,userItem];
        listeners.forEach(listener => listener({event:'chat.item',seq:++sequence,epoch:'qa',data:{sessionId,item:userItem}}));
      }
      if (deferNextSend) { deferNextSend=false; return new Promise(resolve => { resolveDeferredSend=() => resolve({turnId:'turn-1'}); }); }
      return {turnId:'turn-1'};
    }
    if (method === 'session.claim' || method === 'session.renew') return {leaseEpoch:1};
    if (method === 'session.release' || method === 'chat.cancel') return null;
    throw new Error('Unexpected QA request '+method);
  }
};
const root = createRoot(document.getElementById('root'));
const render = () => root.render(React.createElement(I18nProvider, {locale}, React.createElement(ChatView, {session:{id:sessionId,provider,mode:'chat',status:sessionStatus,title:'QA',createdAt:'now',updatedAt:sessionUpdatedAt}})));
window.qaRender = next => {
  provider = next.provider || provider;
  sessionId = next.sessionId || ('qa-' + provider);
  items = next.items || [];
  locale = next.locale || locale;
  sessionStatus = next.status || 'idle';
  sessionUpdatedAt = next.updatedAt || sessionUpdatedAt;
  omitUserOnSend = false;
  document.documentElement.dataset.theme = next.theme || 'light';
  render();
};
window.qaEmitAssistant = (turnId, id='assistant-'+(++sequence)) => listeners.forEach(listener => listener({event:'chat.item',seq:++sequence,epoch:'qa',data:{sessionId,item:{id,role:'assistant',turnId,createdAt:'now',parts:[{type:'text',text:'Reply',status:'streaming'}]}}}));
window.qaEmitUsage = turnId => listeners.forEach(listener => listener({event:'chat.item',seq:++sequence,epoch:'qa',data:{sessionId,item:{id:'usage-'+(++sequence),role:'assistant',turnId,createdAt:'now',elapsedMs:2400,parts:[{type:'text',status:'complete',text:'Context: 0 / 1048576 tokens (0%)\\nSession total: no LLM calls yet'},{type:'text',status:'complete',text:'Plan usage',data:{kind:'plan',rows:[{label:'Weekly limit',percent:10,reset:'resets in 1d'}]}}]}}}));
window.qaFailNextSend = () => { failNextSend=true; };
window.qaDeferNextSend = () => { deferNextSend=true; };
window.qaOmitUserOnSend = () => { omitUserOnSend=true; };
window.qaResolveSend = () => resolveDeferredSend?.();
window.qaCompleteEmptyTurn = (status='idle') => { sessionStatus=status; sessionUpdatedAt='complete-'+(++sequence); render(); };
window.qaNetworkRetry = (state='retrying') => {
  const item={id:'network-retry',role:'assistant',turnId:'turn-1',createdAt:'now',parts:[{type:'status',data:{kind:'providerRetry',state,attempt:2,maxRetries:15,errorType:'http'}}]};
  items=[...items.filter(row=>row.id!==item.id),item];
  sessionStatus=state==='retrying'?'running':'idle';sessionUpdatedAt='retry-'+(++sequence);render();
  listeners.forEach(listener => listener({event:'chat.item',seq:++sequence,epoch:'qa',data:{sessionId,item}}));
};
window.qaRender({provider:'kimi'});
`;
await build({stdin:{contents:entry, resolveDir:resolve('.'), loader:'tsx'}, bundle:true, outfile:join(scratch, 'qa.js'), jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:900,height:700,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app;
try {
  app = await electron.launch({args:[join(scratch, 'main.cjs')]});
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  const ready = async () => {
    await page.waitForFunction(() => {
      const textarea = document.querySelector('.chat-compose-shell textarea');
      return textarea instanceof HTMLTextAreaElement && !textarea.disabled && !textarea.closest('[inert]') && getComputedStyle(textarea).visibility !== 'hidden';
    });
    await page.locator('.v3-chat-log').waitFor();
  };
  const send = async text => {
    await page.evaluate(value => {
      const textarea = document.querySelector('.chat-compose-shell textarea');
      if (!(textarea instanceof HTMLTextAreaElement) || !textarea.form) throw new Error('Composer is unavailable');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', {bubbles:true}));
      textarea.form.requestSubmit();
    }, text);
  };

  await page.setViewportSize({width:1280,height:900});
  for (const [provider, testLocale] of [['codex','en'],['claude','zh-CN'],['kimi','zh-CN'],['gemini','en'],['opencode','zh-CN'],['grok','en']]) {
    await page.evaluate(([nextProvider, nextLocale]) => window.qaRender({provider:nextProvider, sessionId:'qa-'+nextProvider, locale:nextLocale, updatedAt:'ready-'+nextProvider}), [provider, testLocale]);
    await ready();
    await send('first');
    await page.locator('.chat-first-response-wait').waitFor();
    assert.match(await page.locator('.chat-first-response-wait').innerText(), testLocale === 'zh-CN' ? /思考中/ : /Thinking/);
    if (provider === 'kimi') {
      assert.equal(await page.locator('.v3-empty').count(), 0, 'a sent user item replaces the empty transcript before the pending indicator is captured');
      assert.ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().length > 0), 'the production style bundle provides prototype theme tokens');
      await page.screenshot({path:join(scratch, 'thinking-light-1280.png')});
      await page.evaluate(() => window.qaEmitUsage('turn-1'));
    } else await page.evaluate(() => window.qaEmitAssistant('turn-1'));
    await page.locator('.chat-first-response-wait').waitFor({state:'detached'});
  }

  await page.evaluate(() => window.qaRender({provider:'codex', sessionId:'qa-codex-history', locale:'zh-CN', updatedAt:'history', items:[{id:'old',role:'assistant',turnId:'old-turn',createdAt:'before',parts:[{type:'text',text:'Old reply'}]}]}));
  await ready();
  assert.equal(await page.locator('.chat-first-response-wait').count(), 0, 'history replay must not create a wait indicator');
  await send('second');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.evaluate(() => window.qaEmitAssistant('old-turn', 'late-old'));
  assert.equal(await page.locator('.chat-first-response-wait').count(), 1, 'a stale turn cannot dismiss the current wait');
  await page.evaluate(() => window.qaEmitAssistant('turn-1', 'new-turn'));
  await page.locator('.chat-first-response-wait').waitFor({state:'detached'});

  await page.evaluate(() => window.qaRender({provider:'grok', sessionId:'qa-grok-wait-empty', locale:'zh-CN', updatedAt:'wait-empty'}));
  await ready();
  await page.evaluate(() => { window.qaOmitUserOnSend(); window.qaDeferNextSend(); });
  await send('hello');
  await page.locator('.chat-first-response-wait').waitFor();
  assert.equal(await page.locator('.v3-empty').count(), 0, 'waiting for grok hides the empty transcript');
  assert.equal(await page.locator('.chat-first-response-wait').evaluate(el => getComputedStyle(el).visibility), 'visible');
  await page.evaluate(() => window.qaResolveSend());

  await page.evaluate(() => window.qaRender({provider:'grok', sessionId:'qa-grok-error', updatedAt:'error-ready'}));
  await ready();
  await page.evaluate(() => window.qaFailNextSend());
  await send('fails');
  await page.locator('.surface-error').waitFor();
  assert.equal(await page.locator('.chat-first-response-wait').count(), 0, 'a rejected send clears the wait indicator');

  await page.evaluate(() => window.qaRender({provider:'kimi', sessionId:'qa-late-ack-old', updatedAt:'late-ack-old'}));
  await ready();
  await page.evaluate(() => window.qaDeferNextSend());
  await send('switch');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.evaluate(() => window.qaRender({provider:'kimi', sessionId:'qa-switched', updatedAt:'late-ack-new'}));
  await ready();
  await page.evaluate(() => window.qaResolveSend());
  assert.equal(await page.locator('.chat-first-response-wait').count(), 0, 'switching sessions clears the previous wait indicator');

  await page.evaluate(() => window.qaRender({provider:'claude', sessionId:'qa-empty-completion', updatedAt:'empty-start'}));
  await ready();
  await page.evaluate(() => window.qaDeferNextSend());
  await send('empty completion');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.evaluate(() => window.qaCompleteEmptyTurn());
  assert.equal(await page.locator('.chat-first-response-wait').count(), 1, 'a completion before send acknowledgement remains pending until its turn is identified');
  await page.evaluate(() => window.qaResolveSend());
  await page.locator('.chat-first-response-wait').waitFor({state:'detached'});

  await page.evaluate(() => window.qaRender({provider:'grok', sessionId:'qa-provider-error', updatedAt:'provider-error-start'}));
  await ready();
  await send('provider error');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.evaluate(() => window.qaCompleteEmptyTurn('error'));
  await page.locator('.chat-first-response-wait').waitFor({state:'detached'});

  await page.evaluate(() => window.qaDeferNextSend());
  await send('early response');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.evaluate(() => window.qaEmitAssistant('turn-1', 'arrived-before-ack'));
  await page.locator('.v3-chat-message.assistant').waitFor();
  assert.equal(await page.locator('.chat-first-response-wait').count(), 1, 'the indicator remains until its send acknowledgement identifies the turn');
  await page.evaluate(() => window.qaResolveSend());
  await page.locator('.chat-first-response-wait').waitFor({state:'detached'});
  await page.evaluate(() => window.qaRender({provider:'kimi', sessionId:'qa-reduced', locale:'zh-CN', theme:'dark', updatedAt:'reduced-ready'}));
  await ready();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(() => window.qaDeferNextSend());
  await send('reduced motion');
  await page.locator('.chat-first-response-wait').waitFor();
  await page.screenshot({path:join(scratch, 'thinking-dark-reduced-1280.png')});
  const animations = await page.locator('.chat-first-response-dots i').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations()).length);
  assert.equal(animations, 0, 'reduced motion stops the pending-response animation');
  const staleHistory = [
    {id:'old-stream',role:'assistant',turnId:'old',createdAt:'before',parts:[{type:'text',text:'Finished answer',status:'streaming'}]},
    {id:'old-completed',role:'assistant',turnId:'old',createdAt:'before',elapsedMs:9000,parts:[]},
  ];
  await page.evaluate(items => window.qaRender({provider:'codex',sessionId:'qa-reopened',status:'idle',items,theme:'light'}), staleHistory);
  await ready();
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  assert.equal(await page.locator('.chat-compose-send.is-stop').count(),0,'reopening completed history must show Send');
  await page.evaluate(items => window.qaRender({provider:'codex',sessionId:'qa-running',status:'running',items:[...items,{id:'new-user',role:'user',turnId:'new',createdAt:'now',parts:[{type:'text',text:'New prompt'}]}]}), staleHistory);
  await ready();
  await page.locator('.chat-compose-send.is-stop').waitFor();
  const runningCount = await page.evaluate(() => window.qaSendCount);
  await send('queued draft');
  assert.equal(await page.evaluate(() => window.qaSendCount),runningCount,'Enter cannot send a second prompt during a live turn');
  assert.equal(await page.locator('.chat-compose-shell textarea').inputValue(),'queued draft','blocked send retains the draft');
  await page.evaluate(() => window.qaCompleteEmptyTurn());
  await page.locator('.chat-compose-send[type="submit"]').waitFor();
  assert.equal(await page.locator('.chat-compose-send.is-stop').count(),0,'completion restores Send even if historical flags remain');

  await page.evaluate(() => window.qaRender({provider:'grok',sessionId:'qa-network-retry',locale:'zh-CN',theme:'light'}));
  await ready();
  await send('hello');
  await page.locator('.chat-first-response-wait').waitFor();
  const pendingCount = await page.evaluate(() => window.qaSendCount);
  await send('next draft');
  assert.equal(await page.evaluate(() => window.qaSendCount),pendingCount,'first-response wait fences sending before a running snapshot arrives');
  await page.evaluate(() => window.qaNetworkRetry());
  await page.locator('.chat-network-notice').waitFor();
  await page.locator('.chat-first-response-wait').waitFor({state:'detached'});
  assert.match(await page.locator('.chat-network-notice').innerText(),/正在重试.*2\/15/s);
  await page.screenshot({path:join(scratch,'grok-network-retry-light-1280.png')});
  for(const width of [1440,1920]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(() => {document.documentElement.dataset.theme='dark';window.qaNetworkRetry('failed');});
    assert.match(await page.locator('.chat-network-notice').innerText(),/设置 → 工具/);
    await page.screenshot({path:join(scratch,'grok-network-failed-dark-'+width+'.png')});
  }
  console.log('chat first-response fixture passed', JSON.stringify({
    lightScreenshot:join(scratch, 'thinking-light-1280.png'),
    darkReducedMotionScreenshot:join(scratch, 'thinking-dark-reduced-1280.png'),
  }));
} finally {
  await app?.close();
}
