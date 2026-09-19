// Isolated Electron component QA: production ChatView/CSS, deterministic bridge
// fixtures only. Does not launch a provider or read/write a user's runtime data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-transcript-'));
const out = resolve('qa/results/codex-transcript');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const text = text => ({type:'text',text});
const row = (id,parts,extra={}) => ({id,role:'assistant',turnId:'t1',createdAt:'now',parts,...extra});
const items = [row('u',[text('测试消息')],{role:'user'}),
  row('a',[text('我先加载项目的 Trellis 会话指引，确认当前工作区状态。')]),
  row('tool',[{type:'tool',toolName:'commandExecution',status:'completed',data:{command:'Get-Content AGENTS.md',output:'Project instructions'}}]),
  row('answer',[text('收到，测试消息正常。此次对话需要创建一个 **Trellis 任务**吗？')]),
  row('done',[],{elapsedMs:22000})];
let listener;
window.threadterm = {onEvent: cb => {listener=cb; return ()=>{};},request:async method => {
  if(method==='chat.snapshot')return {items,revision:1};
  if(method==='chat.draft.read')return {text:'',revision:0};
  if(method==='chat.options')return {options:[],commands:[]};
  throw Error('Unexpected QA request '+method);
}};
window.qaUpdate = item => listener({event:'chat.item',seq:2,data:{sessionId:'qa',item}});
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><ChatView session={{id:'qa',provider:'codex',mode:'chat',status:'idle',readOnly:true,title:'QA',createdAt:'now',updatedAt:'now'}} /></I18nProvider>);
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.codex-work > summary').waitFor();
  const bubble = page.locator('.is-codex.user');
  const geometry = await bubble.evaluate(el => ({ height: el.getBoundingClientRect().height, text: el.innerText }));
  assert.equal(geometry.text, '测试消息');
  assert.equal(geometry.height, 44, 'shared 24px line height plus 20px vertical padding; no phantom Markdown newline');
  assert.equal(await page.locator('.codex-work').getAttribute('open'), null);
  assert.equal(await page.locator('.codex-work-body').isVisible(), false);
  assert.equal(await page.locator('.codex-turn > .assistant').innerText(), '收到，测试消息正常。此次对话需要创建一个 Trellis 任务吗？');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1280, 1440, 1920]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
      await page.screenshot({path:join(out,`${theme}-${width}-collapsed.png`)});
      await page.locator('.codex-work > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.codex-work-body').isVisible(), true);
      assert.equal(await page.locator('.codex-tool-disclosure summary').innerText(), '已运行命令');
      await page.screenshot({path:join(out,`${theme}-${width}-expanded.png`)});
      await page.keyboard.press('Space');
      assert.equal(await page.locator('.codex-work-body').isVisible(), false);
      assert.equal(await page.evaluate(() => document.querySelector('.v3-chat-log').scrollWidth <= document.querySelector('.v3-chat-log').clientWidth), true);
    }
  }
  await page.locator('.codex-work > summary').click();
  await page.locator('.codex-tool-disclosure summary').click();
  assert.equal(await page.locator('.codex-tool-disclosure pre').isVisible(), true);
  // State survives transcript updates, and intentional user line breaks survive.
  await page.evaluate(() => window.qaUpdate({id:'u2',role:'user',turnId:'t2',createdAt:'now',parts:[{type:'text',text:'第一行\n第二行'}]}));
  await page.locator('.is-codex.user').nth(1).waitFor();
  assert.equal(await page.locator('.is-codex.user').nth(1).innerText(), '第一行\n第二行');
  assert.equal(await page.locator('.codex-work-body').isVisible(), true);
  const liveTool = {id:'live-tool',role:'assistant',turnId:'t2',createdAt:'now',parts:[{type:'tool',toolName:'commandExecution',toolId:'live',status:'running',text:'Live output'}]};
  await page.evaluate(item => window.qaUpdate(item), liveTool);
  const liveDetails = page.locator('.codex-tool-disclosure').last();
  await liveDetails.waitFor();
  assert.equal(await liveDetails.evaluate(el => el.open), false, 'running tools start collapsed');
  await liveDetails.locator('summary').click();
  await page.evaluate(item => window.qaUpdate(item), {...liveTool,parts:[{...liveTool.parts[0],status:'complete',text:'Completed output'}]});
  await page.waitForTimeout(100);
  assert.equal(await liveDetails.evaluate(el => el.open), true, 'completion preserves manual expansion');
  await liveDetails.locator('summary').click();
  await page.evaluate(item => window.qaUpdate(item), {...liveTool,parts:[{...liveTool.parts[0],text:'More output'}]});
  await page.waitForTimeout(100);
  assert.equal(await liveDetails.evaluate(el => el.open), false, 'stream updates do not reopen details');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'report.json'), JSON.stringify({passed:true,geometry,checks:['collapsed/expanded','keyboard Enter/Space','tool details','update preserves expansion','intentional newlines','no horizontal overflow','1280/1440/1920 light/dark'],scratch},null,2));
  console.log(JSON.stringify({passed:true,out,geometry}));
} finally {
  if (app) await app.close();
}
