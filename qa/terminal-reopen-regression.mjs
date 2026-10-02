// Real React/xterm regression: mixed worktree counts and bounded replay before control.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-reopen-'));
const entry = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ProjectOverview } from './renderer/src/components/ProjectOverview';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const enc = new TextEncoder();
const history = Array.from({length: 1700}, (_, i) => enc.encode('\\x1b[?2026h\\x1b[2J\\x1b[HFRAME-' + i + '\\x1b[30;1HAsk Codex to do anything\\x1b[?2026l'));
history.push(enc.encode('\\x1b[6n'));
const end = history.reduce((n, b) => n + b.length, 0);
const hugeEnd = 2 * 1024 * 1024 + 32;
const fullBytes = new Uint8Array(hugeEnd).fill(32);
// Put a truecolor escape across the page boundary. The terminal must keep its
// parser state; starting from the second page would expose numeric fragments.
fullBytes.set(enc.encode('\\x1b[38;2;128;128;128m'), 1048576 - 4);
fullBytes.set(enc.encode('\\x1b[0m\\r\\nFULL-HISTORY-END'), hugeEnd - 30);
const requests = window.requests = [];
window.replayWrites = 0;
window.subscriptions = 0;
let listener, cursor;
const open = Terminal.prototype.open;
Terminal.prototype.open = function(el) { window.term = this; return open.call(this, el); };
const write = Terminal.prototype.write;
Terminal.prototype.write = function(data, cb) {
  if (data instanceof Uint8Array) window.replayWrites += data.length;
  if (data instanceof Uint8Array && window.stallChunk) { window.delayedWrite=cb; return write.call(this,data); }
  return write.call(this, data, cb);
};
window.threadterm = {
  windowsPty: {backend: 'conpty', buildNumber: 22631},
  request: async (method, params) => {
    requests.push({method, params});
    if (method === 'worktree.list') return [{id:'tree', projectId:'p', path:'D:/repo', branch:'fix/test'}];
    if (method === 'usage.query') return {records:[]};
    if (method === 'terminal.read') {
      if (window.failRead) throw new Error('qa replay read failed');
      if (window.stallRead) return new Promise(()=>{});
      if (window.large) {
        if (params.tail) return {nextCursor:hugeEnd};
        const bytes=fullBytes.slice(params.cursor,params.cursor+params.limit);
        let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        return {fromCursor:params.cursor,nextCursor:params.cursor+bytes.length,data:btoa(binary)};
      }
      return {nextCursor: window.empty ? 0 : end};
    }
    if (method === 'session.launch.read') {
      if (params.sessionId === 'quiet-ended') return {phase:'running'};
      if (params.sessionId !== 'startup') throw new Error('session_launch_unavailable');
      return window.startupPhase === 'failed'
        ? {phase:'failed',error:{code:'qa_startup_failed',message:'QA startup failed'}}
        : {phase:window.startupPhase ?? 'running'};
    }
    if (method === 'session.resume' && params.sessionId === 'quiet-ended') return new Promise(resolve => { window.completeResume = resolve; });
    if (method === 'session.resume' && params.sessionId === 'startup') { window.startupPhase = 'preparing'; return null; }
    if (method === 'session.claim' || method === 'session.renew') return {leaseEpoch: 7};
    if (method === 'terminal.resize') {
      // Model the native CLI's authoritative repaint after the first live resize.
      const data = enc.encode('\\x1b[2J\\x1b[HLIVE-FRAME\\r\\nAsk Codex to do anything');
      await listener({sessionId:'s0', cursor, data}); cursor += data.length;
    }
    return null;
  },
  subscribeOutput: async (id, start, cb) => {
    window.subscriptions++; listener = cb; window.listener = cb; cursor = 0;
    if (window.initialGap) { await cb({sessionId:id,cursor:end,data:new Uint8Array(),gap:true});return()=>{window.gapUnsubscribed=true}; }
    if (window.stallChunk) { await cb({sessionId:id,cursor:0,data:history[0]});window.stallAck=true;return()=>{window.stallUnsubscribed=true}; }
    if (window.large) { window.attachedAt=start; return () => {}; }
    if (id === 'startup') return () => {};
    if (window.empty) return () => {};
    await cb({sessionId:id, cursor, data:history[0]}); cursor += history[0].length;
    window.paused = true;
    await new Promise(resolve => { window.releaseReplay = resolve; });
    for (const data of history.slice(1)) { await cb({sessionId:id, cursor, data}); cursor += data.length; }
    return () => {};
  },
};
const sessions = ['running','interrupted','interrupted','interrupted'].map((status, i) => ({id:'s'+i, title:'s'+i, provider:'codex',mode:'terminal',status,projectId:'p',worktreePath:'D:/repo',cols:120,rows:32,createdAt:'2026-09-22',updatedAt:'2026-09-22'}));
const startupSession = {id:'startup',title:'startup',provider:'codex',mode:'terminal',status:'starting',projectId:'p',worktreePath:'D:/repo',cols:120,rows:32,createdAt:'2026-09-22',updatedAt:'2026-09-22'};
const kimiStarting = {...startupSession,id:'kimi-starting',provider:'kimi'};
const quietEnded = {...startupSession,id:'quiet-ended',status:'interrupted',nativeId:'qa-original-native'};
const data = {projects:[{id:'p',name:'Repo',path:'D:/repo'}],sessions,inbox:[],providers:[],settings:{},workspaces:[],presets:[],revision:1};
function Fixture() {
  const [terminal, show] = useState(false), [variant, setVariant] = useState('normal'), [scope, setScope] = useState();
  window.showTerminal = show;
  window.showStartup = () => { window.empty=true; window.failRead=false; window.startupPhase='running'; setVariant('startup'); show(true); };
  window.showKimiStarting = () => { window.empty=true; window.failRead=false; setVariant('kimi'); show(true); };
  window.showQuietEnded = () => { window.empty=true; window.failRead=false; setVariant('quiet-ended'); show(true); };
  const shown = variant==='startup' ? startupSession : variant==='kimi' ? kimiStarting : variant==='quiet-ended' ? quietEnded : sessions[0];
  return <I18nProvider locale="zh-CN"><div className="fixture">{terminal ? <TerminalSurface sessionId={shown.id} session={shown} provider={shown.provider} theme="light" terminalCompatibility={{}}/> : <ProjectOverview projectId="p" data={data} initialWorktreePath={scope} onScopeChange={setScope}/>}</div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'), '<link rel="stylesheet" href="qa.css"><style>html,body,#root,.fixture{height:100%;margin:0}.fixture{display:flex}.fixture>.terminal-wrap{flex:1;min-width:0;min-height:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
const app = await electron.launch({args:[join(scratch,'main.cjs')]});
try {
  const page = await app.firstWindow();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const row = page.locator('[data-testid="home-tree-row"]');
  await row.waitFor();
  assert.match(await row.innerText(), /1 个运行中/);
  assert.doesNotMatch(await row.innerText(), /4 个运行中/);
  await row.click();
  assert.match(await page.locator('[data-testid="home-status"]').innerText(), /运行中\s*1[\s\S]*停滞\s*3/);
  await page.evaluate(()=>window.showTerminal(true));
  await page.waitForFunction(()=>window.paused);
  await page.waitForTimeout(600); // A quiet interval must NOT complete historical replay.
  assert.equal(await page.locator('.terminal-host').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  assert.equal(await page.evaluate(()=>window.term.cols),120);
  assert.equal(await page.evaluate(()=>window.term.rows),32);
  assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true);
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>['terminal.resize','terminal.input','session.claim'].includes(r.method)).length),0);
  await page.evaluate(()=>window.releaseReplay());
  await page.waitForFunction(()=>!document.querySelector('.term-replaying') && !window.term.options.disableStdin);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.terminal-host').evaluate(el=>getComputedStyle(el).visibility),'visible');
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.method==='terminal.resize').length),1);
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.method==='terminal.input').length),0,'historical DSR must not reach the live process');
  assert.equal(await page.evaluate(()=>window.subscriptions),1);
  const visible = await page.evaluate(()=>Array.from({length:window.term.rows},(_,i)=>window.term.buffer.active.getLine(window.term.buffer.active.baseY+i)?.translateToString(true)).join('\n'));
  assert.equal((visible.match(/Ask Codex to do anything/g)??[]).length,1);
  await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('hello');
  await page.waitForFunction(()=>window.requests.some(r=>r.method==='terminal.input'));
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.empty=true; window.showTerminal(true);});
  await page.waitForFunction(()=>!document.querySelector('.term-replaying') && !window.term.options.disableStdin);
  assert.equal(await page.evaluate(()=>window.subscriptions),2,'empty history must attach once and become live');
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.failRead=true; window.showTerminal(true);});
  await page.locator('.term-loading-overlay.is-failed').waitFor();
  // The failure is stated once, in the overlay: plain reason, Retry, technical cause behind Details.
  assert.equal(await page.locator('.surface-error').count(),0,'a failed replay is not repeated as a surface error under the overlay');
  assert.equal(await page.locator('[role="alert"]').count(),1,'one alert for one failed replay');
  assert.match(await page.locator('.term-loading-overlay .chat-connect-status').innerText(),/无法显示终端画面/);
  assert.equal(await page.locator('.term-failure-details').evaluate(el=>el.open),false,'technical detail starts collapsed');
  await page.locator('.term-failure-details summary').click();
  assert.match(await page.locator('.term-failure-details p').innerText(),/qa replay read failed/);
  assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true);
  assert.equal(await page.evaluate(()=>window.subscriptions),2,'failed boundary read must not silently attach from zero');
  await page.evaluate(()=>window.showStartup());
  await page.locator('.term-loading-overlay').waitFor();
  await page.waitForTimeout(650);
  assert.equal(await page.locator('.term-loading-overlay').count(),1,'a running PTY without a rendered frame keeps the Codex mark visible');
  assert.equal(await page.locator('[data-agent-icon="codex"]').count() > 0,true);
  await page.screenshot({ path: join(scratch, 'codex-native-frame-wait.png'), animations: 'disabled' });
  await page.waitForFunction(()=>typeof window.listener === 'function');
  await page.evaluate(()=>window.listener({sessionId:'startup',cursor:0,data:new TextEncoder().encode('Trust this folder?')}));
  await page.waitForFunction(()=>!document.querySelector('.term-loading-overlay'));
  assert.equal(await page.evaluate(()=>window.term.buffer.active.getLine(0)?.translateToString(true).includes('Trust this folder?')),true,'a rendered trust/auth frame hands off to the terminal');
  assert.equal(await page.locator('.term-ended-banner').count(),0,'deferred startup never presents the ended/missing-native-id footer');
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.startupPhase='failed'; window.empty=true; window.failRead=false; window.showStartup = window.showStartup;});
  await page.evaluate(()=>{window.showTerminal(true);});
  await page.locator('.term-loading-overlay.is-failed').waitFor();
  await page.locator('.term-loading-overlay.is-failed button').click();
  await page.waitForFunction(()=>window.requests.some(r=>r.method==='session.resume'&&r.params.sessionId==='startup'));
  assert.equal(await page.locator('.term-ended-banner').count(),0,'same-id startup retry has no false ended/legacy footer');
  await page.evaluate(()=>{window.showTerminal(false); window.showKimiStarting();});
  await page.locator('.term-starting').waitFor();
  await page.evaluate(()=>window.showQuietEnded());
  await page.waitForFunction(()=>!document.querySelector('.term-replaying'));
  await page.waitForTimeout(650);
  assert.equal(await page.locator('.term-loading-overlay').count(),0,'a quiet ended/reopened record never inherits a stale deferred-running loader');
  await page.evaluate(()=>new Promise(resolve=>window.term.write('OLD-SCREEN',resolve)));
  await page.getByRole('button',{name:'继续会话',exact:true}).click();
  await page.waitForFunction(()=>typeof window.completeResume==='function');
  await page.evaluate(()=>window.listener({sessionId:'quiet-ended',cursor:0,data:new TextEncoder().encode('\u001b[H')}));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.term-loading-overlay').count(),1,'old screen plus new cursor movement cannot release the resume logo');
  await page.evaluate(()=>window.listener({sessionId:'quiet-ended',cursor:3,data:new TextEncoder().encode('NEW-NATIVE-FRAME')}));
  await page.waitForFunction(()=>!document.querySelector('.term-loading-overlay'));
  await page.evaluate(()=>window.completeResume(null));
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.large=true;window.replayWrites=0;window.showTerminal(true)});
  await page.waitForFunction(()=>window.attachedAt&&!document.querySelector('.term-replaying'));
  assert.equal(await page.evaluate(()=>window.replayWrites),2*1024*1024+32,'complete history is parsed, without dropping the prefix');
  assert.equal(await page.evaluate(()=>window.attachedAt),2*1024*1024+32,'live subscription joins the captured watermark');
  const restored=await page.evaluate(()=>Array.from({length:window.term.buffer.active.length},(_,i)=>window.term.buffer.active.getLine(i)?.translateToString(true)).join('\n'));
  assert.ok(restored.includes('FULL-HISTORY-END'));
  assert.ok(!restored.includes('128;128;128m'),'ANSI split across pages must not become visible numeric text');
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.large=false;window.stallRead=true;window.showTerminal(true)});
  await page.locator('.term-replaying').waitFor();
  await page.evaluate(()=>{window.realNow=Date.now;const shifted=Date.now()+20000;Date.now=()=>shifted});
  await page.locator('.term-loading-overlay.is-failed').waitFor({timeout:5000});
  assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true,'stalled recovery never enables input');
  assert.match(await page.locator('.term-loading-overlay .chat-connect-hint').innerText(),/加载历史输出时没有响应/);
  assert.match(await page.locator('.term-failure-details p').textContent(),/terminal\.read/,'a boundary read that never answers says so instead of "byte 0"');
  await page.evaluate(()=>{Date.now=window.realNow;window.stallRead=false;window.empty=true});
  await page.locator('.term-loading-overlay.is-failed button').click();
  await page.waitForFunction(()=>!document.querySelector('.term-loading-overlay'));
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.initialGap=true;window.empty=false;window.showTerminal(true)});
  await page.locator('.term-loading-overlay.is-failed').waitFor();
  await page.waitForFunction(()=>window.gapUnsubscribed);
  assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true,'initial gap cannot open the control barrier');
  await page.evaluate(()=>window.showTerminal(false));
  await page.locator('[data-testid="project-home"]').waitFor();
  await page.evaluate(()=>{window.initialGap=false;window.stallChunk=true;window.showTerminal(true)});
  await page.waitForFunction(()=>Boolean(window.delayedWrite));
  await page.evaluate(()=>{window.realNow=Date.now;const shifted=Date.now()+20000;Date.now=()=>shifted});
  await page.locator('.term-loading-overlay.is-failed').waitFor({timeout:5000});
  await page.waitForFunction(()=>window.stallAck&&window.stallUnsubscribed);
  await page.evaluate(()=>{Date.now=window.realNow;window.delayedWrite()});
  assert.equal(await page.evaluate(()=>window.term.options.disableStdin),true,'late callback cannot turn failed replay into ready');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['mixed worktree badge matches details','1700 redraws hidden until durable watermark, not a quiet timer','recorded geometry and no control during replay','one live resize, no historical query feedback, one final prompt','live keyboard input restored','StrictMode, empty history and failed boundary read','Codex logo waits for an actual rendered native frame','auth/trust frame handoff, same-id retry and non-Codex starting presentation','quiet ended/reopen does not inherit deferred loading'],scratch}));
} finally { await app.close(); }
