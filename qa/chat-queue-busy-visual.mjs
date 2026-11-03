// Isolated Electron QA for the production ChatQueue blocker UI. It bundles a
// deterministic bridge and never starts a runtime, provider, or agent CLI.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must be tt-qa-temp'); })());
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP must be tt-qa-temp');
assert.equal(resolve(process.env.TMP ?? scratchBase), scratchBase, 'TMP must match TEMP');
await mkdir(scratchBase, { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'tt-chat-queue-busy-'));
const out = join(root, 'qa/results/chat-queue-busy');
await mkdir(out, { recursive: true });

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatQueue } from './renderer/src/components/ChatQueue';
import './renderer/src/styles.css';
const item = {id:'queued-1',text:'Review the queued change',images:[],revision:1,createdAt:'now',updatedAt:'now',state:'queued'};
const listeners = new Set();
let runtimeQueue = {sessionId:'queue-busy',paused:true,pauseReason:'stopped',blocked:'plan',items:[item]};
let raceBusy = false;
let readCount = 0;
let activeReads = 0;
let peakReads = 0;
let resumeCount = 0;
window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    if (method === 'chat.queue.read') {
      readCount += 1;
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try { await new Promise(resolve => setTimeout(resolve, 40)); return structuredClone(runtimeQueue); }
      finally { activeReads -= 1; }
    }
    if (method === 'chat.queue.resume') { resumeCount += 1; runtimeQueue = {...runtimeQueue, paused:false}; return structuredClone(runtimeQueue); }
    if (method === 'chat.queue.send') {
      if (raceBusy) { runtimeQueue = {...runtimeQueue, blocked:'working'}; throw Error('RuntimeRequestError: chat_busy'); }
      return structuredClone(runtimeQueue);
    }
    throw Error('Unexpected QA request '+method+' '+JSON.stringify(params));
  },
};
function App() {
  const [queue, setQueue] = useState();
  const [locale, setLocale] = useState('en');
  const [idle, setIdle] = useState(true);
  const [issue, setIssue] = useState('');
  window.qaSetLocale = value => { setIssue(''); setLocale(value); };
  window.qaSetIdle = value => setIdle(value);
  window.qaReadCount = () => readCount;
  window.qaReadPeak = () => peakReads;
  window.qaResetReadPeak = () => { peakReads = activeReads; };
  window.qaSubscriberCount = () => listeners.size;
  window.qaResumeCount = () => resumeCount;
  window.qaSetLocalQueue = next => setQueue(structuredClone(next));
  window.qaEmit = (event, next) => {
    runtimeQueue = structuredClone(next);
    for (const listener of listeners) listener({v:1,event,epoch:'qa',seq:1,data:{sessionId:'queue-busy'}});
  };
  window.qaEmitBurst = (next) => {
    runtimeQueue = structuredClone(next);
    for (const event of ['state.changed', 'session.activity', 'chat.approval.resolved']) {
      for (const listener of listeners) listener({v:1,event,epoch:'qa',seq:1,data:{sessionId:'queue-busy'}});
    }
  };
  window.qaEmitItemStorm = () => {
    for (let index = 0; index < 12; index += 1) {
      for (const listener of listeners) listener({v:1,event:'chat.item',epoch:'qa',seq:index,data:{sessionId:'queue-busy'}});
    }
  };
  window.qaRace = () => { raceBusy = true; setIssue(''); };
  return <main className="queue-busy-fixture">
    <ChatQueue sessionId="queue-busy" queue={queue} leaseEpoch={1} writable idle={idle} ingressFailed={false} onChange={setQueue} onIssue={setIssue} zh={locale === 'zh-CN'} />
    {issue && <p role="alert" data-testid="queue-issue">{issue}</p>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
window.qaReady = true;
`;

await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;min-height:100%;background:#f6f7f9}.queue-busy-fixture{max-width:760px;margin:48px auto;padding:24px;background:var(--surface,#fff);border:1px solid var(--border,#d8dde5);border-radius:10px}.queue-busy-fixture [role=alert]{margin:16px 0 0;color:#a00}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({width:960,height:640,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const queue = (blocked, paused = true, pauseReason = 'stopped') => ({ sessionId: 'queue-busy', paused, ...(paused ? { pauseReason } : {}), ...(blocked ? { blocked } : {}), items: [{ id: 'queued-1', text: 'Review the queued change', images: [], revision: 1, createdAt: 'now', updatedAt: 'now', state: 'queued' }] });
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [] };
let app;
let page;
let releaseLock;

async function emit(event, next) {
  await page.evaluate(([name, value]) => window.qaEmit(name, value), [event, next]);
  await page.waitForTimeout(80);
}
async function screenshot(name) {
  await page.screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}
function sendNow() { return page.getByRole('button', { name: /Send queued prompt now|立即发送队列提示/ }); }
function resume() { return page.getByRole('button', { name: /Resume queue|恢复队列/ }); }

try {
  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], env: { ...process.env, TEMP: scratchBase, TMP: scratchBase } });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.qaReady === true);
  await page.waitForFunction(() => window.qaSubscriberCount() === 1);
  await page.evaluate(next => window.qaEmit('session.activity', next), queue('plan', true));
  await page.waitForFunction(() => window.qaReadCount() === 2);
  await page.locator('[data-testid="chat-queue"]').waitFor();
  report.checks.push('a lifecycle event during initial queue discovery gets one trailing read when items exist');

  assert.match(await page.locator('[role=status]').innerText(), /Waiting for your plan review/);
  assert.equal(await sendNow().count(), 0, 'a pending plan does not offer Send now');
  assert.equal(await resume().isDisabled(), false, 'a pending plan permits Resume');
  await resume().click();
  assert.equal(await page.evaluate(() => window.qaResumeCount()), 1, 'Resume unpauses a blocked queue');
  assert.equal(await sendNow().count(), 0, 'resuming does not send through a pending plan');
  await screenshot('plan-blocked-en.png');
  report.checks.push('English plan blocker names the review, hides Send now, and permits Resume');

  await page.evaluate(() => window.qaSetLocale('zh-CN'));
  await page.waitForFunction(() => document.body.innerText.includes('等待你审阅计划'));
  assert.equal(await sendNow().count(), 0);
  assert.equal(await resume().count(), 0, 'the unpaused queue no longer offers Resume');
  await screenshot('plan-blocked-zh.png');
  report.checks.push('Chinese plan blocker has the matching compact status and hidden Send now control');

  await emit('session.activity', queue(undefined, true));
  await page.waitForFunction(() => document.body.innerText.includes('恢复队列'));
  assert.equal(await resume().isDisabled(), false, 'a resolved plan enables Resume after its card event');
  assert.equal(await sendNow().count(), 1, 'a resolved plan offers Send now after its card event');
  await screenshot('plan-resolved-zh.png');
  await page.evaluate(() => window.qaSetLocale('en'));
  await page.waitForFunction(() => document.body.innerText.includes('Resume queue'));
  await screenshot('plan-resolved-en.png');
  report.checks.push('session activity resolution rereads queue availability and restores both actions');

  const readsBeforeItems = await page.evaluate(() => window.qaReadCount());
  await page.evaluate(() => window.qaEmitItemStorm());
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.qaReadCount()), readsBeforeItems, 'streaming chat.item deltas do not reread the queue');
  report.checks.push('chat.item storms do not reread the queue');

  await page.evaluate(() => window.qaSetIdle(false));
  await emit('session.activity', queue('working', false));
  await page.waitForTimeout(80);
  assert.equal((await page.locator('[role=status]').allTextContents()).includes('Agent is still working'), false, 'a live turn does not duplicate its working status in the queue');
  assert.equal(await sendNow().count(), 0);
  await page.evaluate(() => window.qaSetIdle(true));
  await page.waitForFunction(() => document.body.innerText.includes('Agent is still working'));
  report.checks.push('working status only appears when the chat is unexpectedly idle');
  await emit('state.changed', queue('approval', true));
  await page.waitForFunction(() => document.body.innerText.includes('Waiting for your approval'));
  assert.equal(await resume().isDisabled(), false);
  report.checks.push('activity and state events refresh working and approval blockers without chat.item');

  const readsBeforeBurst = await page.evaluate(() => window.qaReadCount());
  await page.evaluate(() => window.qaResetReadPeak());
  await page.evaluate(next => window.qaEmitBurst(next), queue(undefined, true));
  await page.waitForTimeout(160);
  assert.equal(await page.evaluate(() => window.qaReadCount()), readsBeforeBurst + 2, 'an event burst performs one read and one trailing read');
  assert.equal(await page.evaluate(() => window.qaReadPeak()), 1, 'event burst reads never overlap');
  report.checks.push('event bursts coalesce to one read plus one trailing read without overlap');

  await emit('state.changed', queue(undefined, true, 'failed'));
  await page.waitForFunction(() => document.body.innerText.includes('Paused after a send failed'));
  assert.equal(await resume().isDisabled(), false, 'a terminal error without a blocker permits Resume');
  assert.equal(await sendNow().count(), 1, 'a terminal error without a blocker offers Send now');
  report.checks.push('terminal error pause remains actionable when the runtime reports no blocker');

  const empty = { sessionId: 'queue-busy', paused: true, pauseReason: 'stopped', items: [] };
  const readsBeforeEmptyResponse = await page.evaluate(() => window.qaReadCount());
  await page.evaluate(next => window.qaEmitBurst(next), empty);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.qaReadCount()), readsBeforeEmptyResponse + 1, 'a queued trailing refresh is dropped after the response empties the queue');
  report.checks.push('empty read results discard a pending trailing refresh');
  await page.evaluate(next => window.qaSetLocalQueue(next), empty);
  await page.waitForFunction(() => !document.body.innerText.includes('Queued ('));
  const readsWhileEmpty = await page.evaluate(() => window.qaReadCount());
  await emit('session.activity', empty);
  assert.equal(await page.evaluate(() => window.qaReadCount()), readsWhileEmpty, 'an empty local queue does not reread on events');
  await page.evaluate(next => window.qaSetLocalQueue(next), queue(undefined, true));
  await page.locator('[data-testid="chat-queue"]').waitFor();
  await emit('chat.connection', queue(undefined, true));
  await page.waitForFunction(() => document.body.innerText.includes('Resume queue'));
  assert.equal(await page.evaluate(() => window.qaReadCount()), readsWhileEmpty + 1, 'a populated queue resumes event refreshes after a local update');
  report.checks.push('empty queues skip event reads until a local update adds an item');

  await emit('state.changed', queue(undefined, false));
  await page.waitForFunction(async () => (await window.threadterm.request('chat.queue.read', {sessionId:'queue-busy'})).paused === false);
  await page.evaluate(() => window.qaRace());
  await sendNow().click();
  await page.getByTestId('queue-issue').waitFor();
  assert.equal(await page.getByTestId('queue-issue').innerText(), 'The agent is still working. Try again in a moment.');
  await page.waitForFunction(() => document.body.innerText.includes('Agent is still working'));
  assert.equal(await sendNow().count(), 0, 'chat_busy reread removes the stale Send now control');
  assert.doesNotMatch(await page.getByTestId('queue-issue').innerText(), /chat_busy/);
  report.checks.push('a chat_busy race is readable and reloads the current runtime blocker');

  assert.deepEqual(report.errors, [], 'fixture has no renderer page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  try { await app?.close(); }
  finally {
    await releaseLock?.();
    await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`${report.passed ? 'CHAT QUEUE BUSY VISUAL QA PASSED' : 'CHAT QUEUE BUSY VISUAL QA FAILED'}; report: ${join(out, 'report.json')}`);
}
