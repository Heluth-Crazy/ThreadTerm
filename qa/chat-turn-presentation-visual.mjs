// Isolated Electron visual regression for shared completed-turn presentation.
// It uses the production ChatView and CSS bundle only; no runtime or provider starts.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-turn-'));
const out = resolve('qa', 'results', 'chat-turn-presentation', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, {recursive:true});
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from './renderer/src/components/ChatView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const text = text => ({type:'text',text,status:'complete'});
const user = {id:'user',role:'user',turnId:'turn-1',createdAt:'now',parts:[text('Same user message')]};
const approval = {type:'approval',approvalId:'approval-1',status:'pending',data:{approvalId:'approval-1',title:'Approval stays visible',requestType:'command',submittable:false,choices:[]}};
const plan = {type:'text',status:'complete',text:'Plan usage',data:{kind:'plan',rows:[{label:'Weekly limit',percent:10,reset:'resets in 1d'}]}};
const live = {id:'live',role:'assistant',turnId:'turn-live',createdAt:'now',parts:[{type:'thinking',text:'Live thinking remains visible',status:'streaming'}]};
const transcripts = {
  kimi: [user,{id:'kimi-response',role:'assistant',turnId:'turn-1',createdAt:'now',elapsedMs:7000,parts:[{type:'thinking',text:'Kimi private thought',status:'complete'},text('Final answer'),plan,approval]},live],
  grok: [user,{id:'grok-response',role:'assistant',turnId:'turn-1',createdAt:'now',elapsedMs:7000,parts:[{type:'thinking',text:'Grok private thought',status:'complete'},text('Final answer'),plan,approval]},live],
  codex: [user,{id:'codex-thought',role:'assistant',turnId:'turn-1',createdAt:'now',parts:[{type:'thinking',text:'Codex private thought',status:'complete'}]},{id:'codex-tool',role:'assistant',turnId:'turn-1',createdAt:'now',parts:[{type:'tool',toolName:'Read',toolId:'read-1',status:'complete',text:'AGENTS.md'}]},{id:'codex-final',role:'assistant',turnId:'turn-1',createdAt:'now',parts:[text('Final answer'),approval]},{id:'codex-completed',role:'assistant',turnId:'turn-1',createdAt:'now',elapsedMs:7000,parts:[]},live],
};
window.threadterm = {
  onEvent: () => () => {},
  async request(method, params) {
    if (method === 'chat.snapshot') {
      const key = String(params.sessionId).replace(/^single-/, '');
      return {items:transcripts[key] ?? (key.includes('codex') ? transcripts.codex : transcripts.kimi),revision:1};
    }
    if (method === 'chat.draft.read') return {text:'',revision:0};
    if (method === 'chat.options') return {options:[],commands:[]};
    throw new Error('Unexpected QA request '+method);
  },
};
const root=createRoot(document.getElementById('root'));
const session=(id,provider) => ({id,provider,mode:'chat',status:'idle',readOnly:true,title:provider+' QA',createdAt:'now',updatedAt:'now'});
window.qaRenderProvider = provider => root.render(<I18nProvider locale="zh-CN"><ChatView session={session('single-'+provider,provider)} /></I18nProvider>);
root.render(<I18nProvider locale="zh-CN"><div className="qa-turn-grid"><section data-panel="kimi"><ChatView session={session('kimi','kimi')} /></section><section data-panel="codex"><ChatView session={session('codex','codex')} /></section></div></I18nProvider>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{height:100vh}.qa-turn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:100%;gap:1px;background:var(--border)}.qa-turn-grid>section{min-width:0;min-height:0;display:flex;background:var(--bg)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);

let app;
try {
  app = await electron.launch({args:[join(scratch,'main.cjs')]});
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const panel = provider => page.locator(`[data-panel="${provider}"]`);
  await panel('kimi').locator('.codex-work > summary').waitFor();
  await panel('codex').locator('.codex-work > summary').waitFor();

  for (const provider of ['kimi','codex']) {
    const root = panel(provider);
    assert.equal(await root.locator('.codex-work').evaluate(el => el.open), false, `${provider} completed turn starts collapsed`);
    assert.equal(await root.locator('.codex-work-body').isVisible(), false, `${provider} hidden process starts collapsed`);
    assert.equal(await root.locator('.chat-approval-card').count(), 1, `${provider} approval stays outside the collapsed process`);
    assert.equal(await root.locator('.v3-thinking').filter({hasText:'Live thinking remains visible'}).isVisible(), true, `${provider} streaming content remains visible`);
  }
  assert.equal(await panel('kimi').locator('[data-testid="plan-usage-card"]').count(), 1, 'Kimi quota remains outside the collapsed process');

  const geometry = await page.evaluate(() => Object.fromEntries(['kimi','codex'].map(provider => {
    const root = document.querySelector(`[data-panel="${provider}"]`);
    const relative = element => { const r=element.getBoundingClientRect(), base=root.getBoundingClientRect(); return {x:Math.round(r.left-base.left),y:Math.round(r.top-base.top),w:Math.round(r.width),h:Math.round(r.height)}; };
    const articles=[...root.querySelectorAll('article')];
    const final=articles.find(article => article.textContent.includes('Final answer'));
    return [provider,{user:relative(root.querySelector('article.user')),duration:relative(root.querySelector('.codex-work > summary')),final:relative(final)}];
  })));
  const position = ({x,y}) => ({x,y});
  assert.deepEqual(position(geometry.kimi.user), position(geometry.codex.user), 'user bubbles share turn coordinates');
  assert.deepEqual(position(geometry.kimi.duration), position(geometry.codex.duration), 'duration headers share turn coordinates');
  assert.deepEqual(position(geometry.kimi.final), position(geometry.codex.final), 'final replies share turn coordinates');

  for (const theme of ['light','dark']) {
    await page.evaluate(next => { document.documentElement.dataset.theme=next; }, theme);
    for (const width of [1280,1440,1920]) {
      await app.evaluate(({BrowserWindow}, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth,900), width);
      await page.screenshot({path:join(out,`${theme}-${width}-collapsed.png`)});
      for (const provider of ['kimi','codex']) await panel(provider).locator('.codex-work > summary').click();
      for (const provider of ['kimi','codex']) {
        const root=panel(provider);
        assert.equal(await root.locator('.codex-work-body').isVisible(), true, `${provider} process expands`);
        assert.equal(await root.locator('article').filter({hasText:provider === 'kimi' ? 'Kimi private thought' : 'Codex private thought'}).isVisible(), true, `${provider} expanded process is visible`);
        assert.equal(await root.locator('article').filter({hasText:'Final answer'}).isVisible(), true, `${provider} final reply remains visible while expanded`);
      }
      await page.screenshot({path:join(out,`${theme}-${width}-expanded.png`)});
      for (const provider of ['kimi','codex']) await panel(provider).locator('.codex-work > summary').click();
    }
  }
  for (const provider of ['codex','claude','kimi','gemini','opencode','grok']) {
    await page.evaluate(next => window.qaRenderProvider(next), provider);
    const chat=page.locator(`[data-testid="session-chat-single-${provider}"]`);
    await chat.waitFor();
    assert.equal(await chat.getAttribute('data-provider'), provider, `${provider} uses the shared ChatView presentation`);
    assert.equal(await chat.locator('article.user').count(), 1, `${provider} retains the user bubble`);
    assert.equal(await chat.locator('article').filter({hasText:'Final answer'}).isVisible(), true, `${provider} retains the final reply`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme='light'; });
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
  await page.evaluate(() => window.qaRenderProvider('grok'));
  const grok=page.locator('[data-testid="session-chat-single-grok"]');
  await grok.locator('.codex-work > summary').waitFor();
  assert.equal(await grok.locator('.codex-work').evaluate(el => el.open), false, 'grok completed turn starts collapsed');
  assert.equal(await grok.locator('.chat-approval-card').count(), 1, 'grok approval stays outside the collapsed process');
  assert.equal(await grok.locator('[data-testid="plan-usage-card"]').count(), 1, 'grok quota remains outside the collapsed process');
  assert.equal(await grok.locator('.v3-thinking').filter({hasText:'Live thinking remains visible'}).isVisible(), true, 'grok streaming content remains visible');
  const grokGeometry = await grok.evaluate(root => {
    const relative = element => { const r=element.getBoundingClientRect(), base=root.getBoundingClientRect(); return {x:Math.round(r.left-base.left),y:Math.round(r.top-base.top),w:Math.round(r.width),h:Math.round(r.height)}; };
    const articles=[...root.querySelectorAll('article')];
    const final=articles.find(article => article.textContent.includes('Final answer'));
    const approval=root.querySelector('.chat-part.approval');
    const style=approval ? getComputedStyle(approval) : undefined;
    return {
      user:relative(root.querySelector('article.user')),
      duration:relative(root.querySelector('.codex-work > summary')),
      final:relative(final),
      approvalPaddingTop:style?.paddingTop,
      approvalPaddingLeft:style?.paddingLeft,
      approvalRadius:style?.borderRadius,
    };
  });
  assert.equal(grokGeometry.user.x > grokGeometry.final.x, true, 'grok user bubble stays right-aligned');
  assert.equal(grokGeometry.approvalPaddingTop, '10px', 'grok approval uses the shared ACP card padding');
  assert.equal(grokGeometry.approvalPaddingLeft, '12px', 'grok approval uses the shared ACP card padding');
  await page.screenshot({path:join(out,'grok-full-collapsed.png')});
  await grok.locator('.codex-work > summary').click();
  assert.equal(await grok.locator('article').filter({hasText:'Grok private thought'}).isVisible(), true, 'grok expanded process is visible');
  await page.screenshot({path:join(out,'grok-full-expanded.png')});
  await writeFile(join(out,'report.json'),JSON.stringify({passed:true,geometry,checks:['Kimi/Codex collapsed parity','approval and Kimi quota visible','streaming visible','expand preserves final','light/dark 1280/1440/1920'],scratch},null,2));
  console.log(JSON.stringify({passed:true,out,geometry}));
} finally {
  await app?.close();
}
