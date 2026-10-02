// Renders actual isolated-runtime chat.read rows in the production ChatView.
// No provider, native permission, or paid model is contacted by this display test.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';

const statePath = process.argv[2];
assert.ok(statePath, 'pass the chatview-state.json path printed by opencode-chat.integration.mjs');
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.ok(state.sessionId && Array.isArray(state.beforeApproval) && Array.isArray(state.afterApproval));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-opencode-chatview-'));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from './renderer/src/components/ChatView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const root=createRoot(document.getElementById('root'));
let items=[], generation=0;
const listeners=new Set();
window.threadterm={
  onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  async request(method,params){
    if(method==='chat.snapshot')return {items,revision:0};
    if(method==='chat.draft.read')return {text:'',revision:0};
    if(method==='chat.draft.save')return {revision:(params.expectedRevision||0)+1};
    if(method==='chat.connection'||method==='chat.connect')return {sessionId:params.sessionId,runtimeEpoch:'qa',connectionGeneration:1,revision:1,phase:'ready',optionsLoadState:'ready'};
    if(method==='chat.options')return {options:[],commands:[],loadState:'ready'};
    if(method==='session.claim'||method==='session.renew')return {leaseEpoch:1};
    if(method==='session.release'||method==='chat.cancel')return null;
    throw Error('Unexpected visual QA request '+method);
  }
};
window.qaRender=(sessionId,rows)=>{
  items=rows;generation++;
  root.render(React.createElement(I18nProvider,{locale:'en'},React.createElement(ChatView,{key:generation,session:{id:sessionId,provider:'opencode',mode:'chat',status:'waiting',title:'OpenCode fixture',createdAt:'now',updatedAt:String(generation)}})));
};
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  const render = async rows => {
    await page.evaluate(([sessionId, items]) => window.qaRender(sessionId, items), [state.sessionId, rows]);
    await page.locator('.v3-chat-log').waitFor();
    await page.locator('.chat-approval-card').first().waitFor();
  };
  await render(state.beforeApproval);
  assert.equal(await page.locator('.v3-chat-message.assistant').filter({ hasText: 'FIRST-PART' }).count(), 1, 'first native message is visible');
  assert.equal(await page.locator('.v3-chat-message.assistant').filter({ hasText: 'SECOND-PART' }).count(), 1, 'second native message is visible');
  assert.equal(await page.locator('.chat-approval-card.pending').count(), 2, 'both native approval cards are visible');
  await page.locator('.v3-chat-log').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(scratch, 'two-distinct-messages.png'), fullPage: true });
  await page.locator('.v3-chat-log').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: join(scratch, 'two-parts-two-approvals.png'), fullPage: true });
  await render(state.afterApproval);
  const expectedResolved = state.afterApproval.filter(row => row.parts[0]?.type === 'approval' && row.parts[0]?.status === 'resolved').length;
  await page.waitForFunction(count => document.querySelectorAll('.chat-approval-card.resolved').length === count, expectedResolved);
  assert.equal(await page.locator('.chat-approval-card.pending').count(), 1, 'resolving one request leaves its peer pending');
  await page.screenshot({ path: join(scratch, 'one-resolved-one-pending.png'), fullPage: true });
  console.log(JSON.stringify({ passed: true, statePath, screenshots: [join(scratch, 'two-distinct-messages.png'), join(scratch, 'two-parts-two-approvals.png'), join(scratch, 'one-resolved-one-pending.png')] }));
} finally {
  await app?.close();
}
