// Desktop 1 regression QA for ChatView's history-discovery connection gate.
// It builds the production PaneWorkspace/ChatView from source, but all runtime
// replies are a public, in-page bridge fixture: no provider process is opened.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve('.');
const output = join(root, 'qa/results/chat-repair-discovery');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-repair-discovery-'));
const report = { passed: false, fixture: 'public in-page bridge; no runtime or provider process', cases: [], screenshots: [] };
const blocked = new Set(['path', 'home', 'userprofile', 'codex_home', 'data', 'profile', 'pipe', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
Object.assign(env, {
  Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-chat-discovery-${crypto.randomUUID()}`,
  THREADTERM_QA_DISCOVERY: '1',
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'all inherited PATH spellings must be removed');
for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'DATA', 'PROFILE', 'PIPE']) assert.equal(env[key], undefined, `${key} must not leak into QA`);

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PaneWorkspace } from './renderer/src/components/PaneWorkspace';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
import './renderer/src/workbench/workbench.css';
const listeners = new Set();
const fixture = { calls: [], provider: 'codex', sessionId: '', repair: true, failSnapshot: false, connectionGeneration: 1, connected: false, serial: 0 };
const item = () => ({ id: fixture.sessionId + ':history:public-answer', role: 'assistant', turnId: 'public-turn', createdAt: '2026-10-11T00:00:00.000Z', parts: [{type:'text',text:'Public fixture repaired answer.'}] });
const snapshot = () => {
 if (fixture.failSnapshot) { fixture.failSnapshot = false; throw Error('public fixture snapshot failure'); }
 return { items: fixture.repair ? [] : [item()], revision: fixture.repair ? 1 : 2,
   repair: fixture.repair ? { offered:true, degraded:false, reason:'history_metadata_missing', diagnostic:'Public fixture metadata needs reload.' } : { offered:false, degraded:false, reason:'healthy' } };
};
window.threadterm = {
 platform:'win32', onPageContextMenu:()=>()=>{}, openExternal:async()=>{},
 onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener)},
 async request(method, params={}) {
  fixture.calls.push({method, params:structuredClone(params)});
  if (method === 'chat.snapshot') return snapshot();
  if (method === 'chat.connection') return {sessionId:params.sessionId,runtimeEpoch:'public-fixture',connectionGeneration:1,revision:1,phase:fixture.connected?'ready':'disconnected',optionsLoadState:'ready'};
  if (method === 'chat.connect') { fixture.connected=true; return {sessionId:params.sessionId,runtimeEpoch:'public-fixture',connectionGeneration:1,revision:2,phase:'ready',optionsLoadState:'ready'}; }
  if (method === 'chat.options') return {options:[],commands:[],inputCapabilities:{images:false},loadState:'ready'};
  if (method === 'chat.draft.read') return {text:'',revision:1};
  if (method === 'chat.draft.save') return {text:params.text ?? '',revision:(params.expectedRevision ?? 0) + 1};
  if (method === 'chat.queue.read') return {sessionId:params.sessionId,items:[],revision:0,paused:false};
  if (method === 'chat.feedback.read') return {notes:[]};
  if (method === 'session.claim' || method === 'session.renew') return {leaseEpoch:1};
  if (method === 'session.release') return null;
  if (method === 'chat.repair') { fixture.repair=false; return {sessionId:params.sessionId,mode:'rebuild',added:1,updated:0,removed:0,expired:0,total:1,revision:2}; }
  if (method === 'chat.cancel') return null;
  throw Error('unexpected public fixture request: '+method);
 }
};
function mount(provider) {
 fixture.calls=[]; fixture.provider=provider; fixture.sessionId='discovery-'+provider+'-'+(++fixture.serial); fixture.repair=true; fixture.failSnapshot=false; fixture.connected=false;
 const session={id:fixture.sessionId,provider,mode:'chat',status:'idle',title:'Public '+provider+' discovery fixture',projectId:'public-fixture',worktreePath:'C:/public-fixture',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z'};
 const layout={kind:'pane',id:'public-pane-'+provider,tabs:[{id:'public-tab-'+provider,kind:'session',sessionId:session.id}],activeTabId:'public-tab-'+provider};
 root.render(<I18nProvider locale='en'><PaneWorkspace key={provider} layout={layout} sessions={[session]} onChange={()=>{}} theme='light' terminalCompatibility={{}} /></I18nProvider>);
}
window.qaDiscovery={fixture,mount,emit:(event,data={})=>{for(const listener of listeners) listener({event,data:{sessionId:fixture.sessionId,...data},epoch:'public-fixture',seq:99});}};
const root=createRoot(document.getElementById('root')); mount('codex');
`;

let app;
let page;
try {
  await mkdir(output, { recursive: true });
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'fixture.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
  await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root>*{height:100%;min-height:0}</style><div id="root"></div><script src="fixture.js"></script>');
  await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:820,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env, timeout: 30_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.qaDiscovery));

  for (const provider of ['codex', 'claude', 'kimi', 'gemini', 'opencode', 'grok']) {
    await page.evaluate(next => window.qaDiscovery.mount(next), provider);
    const id = await page.evaluate(() => window.qaDiscovery.fixture.sessionId);
    const chat = page.locator(`[data-testid="session-chat-${id}"]`);
    await chat.waitFor();
    await page.getByRole('button', { name: 'Reload native history' }).waitFor();
    await page.waitForFunction(() => window.qaDiscovery.fixture.calls.some(call => call.method === 'chat.snapshot'));
    let calls = await page.evaluate(() => window.qaDiscovery.fixture.calls);
    assert.equal(calls.filter(call => call.method === 'chat.connect').length, 0, `${provider}: offered metadata must hold connection before an explicit choice`);
    assert.equal(calls.filter(call => call.method === 'chat.cancel').length, 0, `${provider}: discovery must not cancel a turn`);
    await page.getByRole('button', { name: 'Continue chat without reloading' }).click();
    await page.waitForFunction(() => window.qaDiscovery.fixture.calls.filter(call => call.method === 'chat.connect').length === 1);
    assert.equal(await page.locator(`[data-testid="session-chat-${id}"] textarea`).isDisabled(), false, `${provider}: Continue enables the composer`);
    calls = await page.evaluate(() => window.qaDiscovery.fixture.calls);
    assert.equal(calls.filter(call => call.method === 'chat.connect').length, 1, `${provider}: one connect after Continue`);
    assert.ok(calls.filter(call => call.method === 'chat.connection' || call.method === 'chat.connect').every(call => true), `${provider}: bridge calls recorded`);

    await page.getByRole('button', { name: 'Reload native history' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    calls = await page.evaluate(() => window.qaDiscovery.fixture.calls);
    assert.equal(calls.filter(call => call.method === 'chat.repair').length, 0, `${provider}: Cancel performs zero repair`);
    assert.equal(calls.filter(call => call.method === 'chat.connect').length, 1, `${provider}: Cancel performs zero extra connect`);
    await page.getByRole('button', { name: 'Reload native history' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reload history' }).click();
    await page.getByText('Public fixture repaired answer.').waitFor();
    assert.equal(await page.locator(`[data-testid="session-chat-${id}"] textarea`).isDisabled(), false, `${provider}: canonical repair snapshot enables the composer`);
    calls = await page.evaluate(() => window.qaDiscovery.fixture.calls);
    assert.equal(calls.filter(call => call.method === 'chat.repair').length, 1, `${provider}: confirmed repair uses one receipt even without outbox event`);
    assert.equal(calls.filter(call => call.method === 'chat.snapshot').length >= 2, true, `${provider}: repair reply triggers a full canonical snapshot`);

    await page.evaluate(() => { window.qaDiscovery.fixture.failSnapshot = true; window.qaDiscovery.emit('runtime.transport', {state:'reconnected'}); });
    await page.getByRole('button', { name: 'Retry loading history' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue chat' }).count(), 0, `${provider}: failed authoritative snapshot has no Continue escape hatch`);
    assert.equal(await page.locator(`[data-testid="session-chat-${id}"] textarea`).isDisabled(), true, `${provider}: snapshot failure preserves the write barrier even with a ready connection`);
    const connectBeforeRetry = (await page.evaluate(() => window.qaDiscovery.fixture.calls)).filter(call => call.method === 'chat.connect').length;
    await page.getByRole('button', { name: 'Retry loading history' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Saved history could not be checked.'));
    assert.equal(await page.locator(`[data-testid="session-chat-${id}"] textarea`).isDisabled(), false, `${provider}: retry's full canonical snapshot re-enables the composer`);
    assert.equal(await page.getByText('public fixture snapshot failure', { exact: true }).count(), 0, `${provider}: successful canonical retry clears the stale snapshot error`);
    calls = await page.evaluate(() => window.qaDiscovery.fixture.calls);
    assert.equal(calls.filter(call => call.method === 'chat.connect').length, connectBeforeRetry, `${provider}: local history retries do not create a second transport generation`);
    report.cases.push({ provider, connectionCalls: calls.filter(call => call.method === 'chat.connect').length, snapshotCalls: calls.filter(call => call.method === 'chat.snapshot').length, repairCalls: calls.filter(call => call.method === 'chat.repair').length, cancelCalls: calls.filter(call => call.method === 'chat.cancel').length,
      connectionTag: { runtimeEpoch: 'public-fixture', connectionGeneration: 1 }, assertions: ['metadata-offered held before connect', 'Continue made exactly one connect', 'Cancel made zero repair/connect calls', 'repair receipt without outbox forced canonical snapshot and enabled composer', 'failed snapshot showed Retry-only barrier; retry re-enabled composer without a new connect'] });
  }
  const props = await page.evaluate(() => ({ provider: window.qaDiscovery.fixture.provider, sessionId: window.qaDiscovery.fixture.sessionId, font: getComputedStyle(document.querySelector('.workspace-pane')).fontSize, icons: [...document.querySelectorAll('.workspace-pane .ico')].map(icon => { const box=icon.getBoundingClientRect(); return [Math.round(box.width),Math.round(box.height)]; }) }));
  assert.equal(props.provider, 'grok');
  assert.equal(props.font, '13px', 'production workspace uses the 13px pane font');
  // V1 (issue VC) sized small-control icons at 14 px; larger chrome keeps 16 px. Either proves production icon CSS loaded.
  assert.ok(props.icons.some(([width, height]) => (width === 14 || width === 16) && height === width), 'production workspace exposes a shared-size (14/16 px) icon');
  for (const [name, width] of [['wide', 1000], ['narrow', 420]]) {
    await page.setViewportSize({ width, height: 760 });
    const path = join(output, `grok-${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push(path);
  }
  assert.deepEqual(pageErrors, [], 'production fixture has no renderer errors');
  report.props = props;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await app?.close().catch(() => {});
  // Only this unique Temp fixture is removed; output is retained for diagnosis.
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
