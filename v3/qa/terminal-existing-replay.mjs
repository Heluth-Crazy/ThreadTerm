// Read-only acceptance test against the already-running default runtime and a
// caller-selected retained terminal. It never launches/stops a runtime or mutates a
// session; only terminal history/status reads and output subscription ACKs are
// exposed to the sandboxed production preload.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { terminalWindowArguments } from '../desktop/src/terminalEnvironment.ts';

const SESSION_ID = process.env.THREADTERM_QA_SESSION_ID;
if (!SESSION_ID) throw new Error('THREADTERM_QA_SESSION_ID is required');
const REPLAY_PAGE_BYTES = 1024 * 1024;
const dataRoot = process.env.THREADTERM_QA_DATA
  ?? process.env.THREADTERM_V3_DATA
  ?? join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'ThreadTermV3');
const databasePath = join(dataRoot, 'threadterm-v3.sqlite3');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-existing-replay-'));
const screenshotPath = join(scratch, 'existing-replay.png');

const database = new DatabaseSync(databasePath, { readOnly: true });
const row = database.prepare(`
  SELECT id,project_id,worktree_path,title,provider,mode,status,created_at,
         updated_at,native_id,exit_code,cols,rows,followed,read_only
    FROM sessions WHERE id=?
`).get(SESSION_ID);
const output = database.prepare(`
  SELECT COUNT(*) AS chunk_count,
         COALESCE(MAX(start_cursor + length(data)),0) AS output_end
    FROM output_chunks WHERE session_id=?
`).get(SESSION_ID);
database.close();

assert.ok(row, `Existing session ${SESSION_ID} was not found in ${databasePath}`);
assert.equal(row.mode, 'terminal');
assert.ok(!['starting', 'running', 'idle', 'waiting'].includes(String(row.status)), 'the acceptance fixture must stay non-live');
assert.equal(Number(row.read_only), 0);
assert.ok(Number(output.output_end) > REPLAY_PAGE_BYTES, 'fixture must exercise paged full replay');

const session = {
  id: String(row.id),
  projectId: String(row.project_id),
  worktreePath: row.worktree_path == null ? undefined : String(row.worktree_path),
  title: String(row.title),
  provider: String(row.provider),
  mode: String(row.mode),
  status: String(row.status),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  nativeId: row.native_id == null ? undefined : String(row.native_id),
  exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
  cols: row.cols == null ? undefined : Number(row.cols),
  rows: row.rows == null ? undefined : Number(row.rows),
  followed: Boolean(row.followed),
  readOnly: Boolean(row.read_only),
};

const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {TerminalSurface} from './renderer/src/components/TerminalSurface';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const session=${JSON.stringify(session)};
window.replayedBytes=0;window.replayWriteMetrics=[];
const open=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.term=this;return open.call(this,element)};
const write=Terminal.prototype.write;
Terminal.prototype.write=function(data,callback){
 if(!(data instanceof Uint8Array))return write.call(this,data,callback);
 window.replayedBytes+=data.byteLength;
 const started=performance.now(),bytes=data.byteLength;
 return write.call(this,data,()=>{window.replayWriteMetrics.push({bytes,elapsedMs:performance.now()-started});callback?.()});
};
function Fixture(){
 const [shown,setShown]=useState(false);
 window.showExistingSession=()=>setShown(true);
 return <I18nProvider locale="zh-CN"><div className="fixture">{shown&&<TerminalSurface sessionId={session.id} session={session} provider={session.provider} theme="light" terminalCompatibility={{}}/>}</div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(
  join(scratch, 'index.html'),
  '<link rel="stylesheet" href="qa.css"><style>html,body,#root,.fixture{height:100%;margin:0}.fixture{display:flex}.fixture>.terminal-wrap{flex:1;min-width:0;min-height:0}</style><div id="root"></div><script src="qa.js"></script>',
);

const main = `
import {app,BrowserWindow,ipcMain} from 'electron';
import {RuntimeClient,runtimePipeIsOpen} from './desktop/src/runtime-client';
import {validateRequest} from './protocol/index';
app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});
const allowed=new Set(['terminal.read','session.launch.read']);
const client=new RuntimeClient(),subscriptions=new Map();
const metrics={reads:[],subscribeCursors:[],subscribeDurationsMs:[]};
globalThis.__terminalExistingReplayMetrics=metrics;
function close(id){const subscription=subscriptions.get(id);if(!subscription)return;subscriptions.delete(id);subscription.unsubscribe?.();for(const acknowledge of subscription.acks)acknowledge()}
ipcMain.handle('threadterm:request',async(_event,method,params)=>{
 if(!allowed.has(method))throw new Error('QA read-only IPC rejected '+String(method));
 validateRequest(method,params);
 const started=performance.now();
 const result=await client.request(method,params);
 if(method==='terminal.read')metrics.reads.push({durationMs:performance.now()-started,params:{sessionId:params.sessionId,cursor:params.cursor,limit:params.limit,tail:params.tail},result:{fromCursor:result.fromCursor,nextCursor:result.nextCursor,truncated:result.truncated,dataBytes:Buffer.from(result.data,'base64').byteLength}});
 return result;
});
ipcMain.handle('threadterm:subscribe-output',async(event,sessionId,cursor,id)=>{
 if(sessionId!==${JSON.stringify(SESSION_ID)}||!Number.isSafeInteger(cursor)||cursor<0||typeof id!=='string')throw new Error('QA output subscription rejected');
 metrics.subscribeCursors.push(cursor);
 subscriptions.set(id,{acks:[]});
 try{
  const started=performance.now();
  const unsubscribe=await client.subscribeOutput(sessionId,cursor,chunk=>new Promise(resolve=>{const subscription=subscriptions.get(id);if(!subscription||event.sender.isDestroyed()){resolve();return}subscription.acks.push(resolve);event.sender.send('threadterm:output',{id,chunk})}));
  metrics.subscribeDurationsMs.push(performance.now()-started);
  const subscription=subscriptions.get(id);if(!subscription){unsubscribe();throw new Error('Output subscription was cancelled')}subscription.unsubscribe=unsubscribe;return{id};
 }catch(error){close(id);throw error}
});
ipcMain.handle('threadterm:ack-output',(_event,id)=>subscriptions.get(id)?.acks.shift()?.());
ipcMain.handle('threadterm:unsubscribe-output',(_event,id)=>close(id));
app.on('before-quit',()=>{for(const id of [...subscriptions.keys()])close(id);client.dispose()});
app.whenReady().then(async()=>{
 if(!await runtimePipeIsOpen())throw new Error('Default runtime is not already running; refusing to launch it');
 const window=new BrowserWindow({width:1200,height:820,show:false,webPreferences:{preload:${JSON.stringify(resolve('desktop-dist/preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,additionalArguments:${JSON.stringify(terminalWindowArguments(process.platform, release()))}}});
 await window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});
`;
await build({
  stdin: { contents: main, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: join(scratch, 'main.cjs'),
});

// If the already-running runtime disappears, RuntimeClient's fallback resolves
// this nonexistent executable and fails before spawn/openSync. This turns the
// no-launch rule into an enforced property rather than a timing assumption.
const noLaunchExecutable = join(scratch, 'runtime-launch-is-forbidden.exe');
const electronEnv = {
  ...process.env,
  THREADTERM_V3_DATA: dataRoot,
  ...(process.env.THREADTERM_QA_PIPE ? { THREADTERM_V3_PIPE: process.env.THREADTERM_QA_PIPE } : {}),
  THREADTERM_V3_RUNTIME: noLaunchExecutable,
};
let application;
try {
  application = await electron.launch({ args: [join(scratch, 'main.cjs')], env: electronEnv });
  const page = await application.firstWindow();
  page.setDefaultTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm && window.showExistingSession));

  const boundary = await page.evaluate(sessionId => window.threadterm.request('terminal.read', { sessionId, tail: true, limit: 1 }), SESSION_ID);
  assert.equal(boundary.nextCursor, Number(output.output_end), 'runtime boundary must match the read-only database snapshot');
  const startedAt = Date.now();
  await page.evaluate(() => window.showExistingSession());
  await page.waitForFunction(() => Boolean(document.querySelector('.term-loading-overlay')));
  await page.waitForFunction(() => Boolean(document.querySelector('.terminal-host')) && !document.querySelector('.term-loading-overlay'));
  const elapsedMs = Date.now() - startedAt;
  const replayedBytes = await page.evaluate(() => window.replayedBytes);
  const writeMetrics = await page.evaluate(() => window.replayWriteMetrics);
  assert.equal(replayedBytes, Number(output.output_end), 'xterm must receive every retained byte exactly once');

  const metrics = await application.evaluate(() => globalThis.__terminalExistingReplayMetrics);
  assert.deepEqual(metrics.subscribeCursors, [boundary.nextCursor], 'live output subscription must begin at the captured boundary');
  const pageReads = metrics.reads.filter(read => read.params.tail !== true);
  assert.ok(pageReads.length > 0, 'full replay must use indexed terminal.read pages');
  let cursor = 0;
  let pagedBytes = 0;
  for (const read of pageReads) {
    assert.equal(read.params.cursor, cursor, 'history page requests must be contiguous');
    assert.equal(read.params.limit, Math.min(REPLAY_PAGE_BYTES, boundary.nextCursor - cursor), 'history pages must use the full 1 MiB RPC limit except for the final remainder');
    assert.equal(read.result.fromCursor, cursor, 'history page results must preserve the requested cursor');
    assert.equal(read.result.nextCursor, cursor + read.result.dataBytes, 'history page must advance by its exact byte count');
    assert.ok(read.result.nextCursor > cursor, 'history page must advance');
    cursor = read.result.nextCursor;
    pagedBytes += read.result.dataBytes;
  }
  assert.equal(cursor, boundary.nextCursor, 'history pages must end at the captured boundary');
  assert.equal(pagedBytes, boundary.nextCursor);
  assert.equal(replayedBytes, pagedBytes, 'xterm must receive the full retained stream exactly once');
  assert.equal(writeMetrics.reduce((total, write) => total + write.bytes, 0), replayedBytes);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: screenshotPath });

  console.log(JSON.stringify({
    passed: true,
    sessionId: SESSION_ID,
    outputBytes: Number(output.output_end),
    chunkCount: Number(output.chunk_count),
    replayedBytes,
    pageCount: pageReads.length,
    elapsedMs,
    readTimingMs: summarize(metrics.reads.map(read => read.durationMs)),
    boundaryReadTimingMs: summarize(metrics.reads.filter(read => read.params.tail === true).map(read => read.durationMs)),
    pageReadTimingMs: summarize(pageReads.map(read => read.durationMs)),
    reads: metrics.reads.map(read => ({
      kind: read.params.tail === true ? 'boundary' : 'page',
      cursor: read.params.cursor,
      bytes: read.result.dataBytes,
      durationMs: Math.round(read.durationMs),
    })),
    writeTimingMs: summarize(writeMetrics.map(write => write.elapsedMs)),
    subscribeTimingMs: summarize(metrics.subscribeDurationsMs),
    screenshot: screenshotPath,
  }));
} finally {
  await application?.close();
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = ratio => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] : 0;
  return {
    count: sorted.length,
    total: Math.round(total),
    min: Math.round(sorted[0] ?? 0),
    median: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}
