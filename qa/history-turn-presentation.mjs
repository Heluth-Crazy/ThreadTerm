// Desktop-1 real-app QA for imported Codex native-turn presentation.
// It writes its fake provider only into an owned temp directory; no live CLI
// or user history is read. Run after the debug runtime with native history
// metadata support is built.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const legacyResumed = process.argv.includes('--legacy-resumed');
const continueWithoutReload = process.argv.includes('--continue-without-reload');
assert.ok(!continueWithoutReload || legacyResumed, '--continue-without-reload requires --legacy-resumed');
const out = join(resolve(process.env.TEMP ?? tmpdir()), `tt-history-turn-presentation-results-${randomUUID()}`);
const scratch = await mkdtemp(join(tmpdir(), 'tt-history-turn-presentation-'));
const bin = join(scratch, 'bin');
const work = join(scratch, 'work');
const log = join(scratch, 'codex.jsonl');
const nativeId = 'qa-history-turns';
const report = { passed: false, runtime, scratch, checks: [], screenshots: [], errors: [], observations: {} };
let app; let page;
let env;
let appDir;
let cleanupApp;
let releaseElectronLock;
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const check = value => { report.checks.push(value); process.stdout.write(`PASS ${value}\n`); };
async function until(probe, label, timeout = 45_000) { const deadline = Date.now() + timeout; let error; while (Date.now() < deadline) { try { const result = await probe(); if (result) return result; } catch (caught) { error = caught; } await delay(100); } throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); }
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function buildApp() {
  ({ appDir, cleanup: cleanupApp } = await buildQaApp({ root, outDir: join(scratch, 'app') }));
}
function fixtureSource() { return String.raw`
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const cwd = process.env.TT_QA_HISTORY_CWD; const log = process.env.TT_QA_HISTORY_LOG;
const primary = '${nativeId}'; let serial = 0;
if (process.argv.includes('--version')) { process.stdout.write('qa-history-codex 1.0.0\\n'); process.exit(0); }
if (process.argv.includes('--protocol-selftest')) process.exit(process.argv.includes('app-server') ? 0 : 64);
if (!process.argv.includes('app-server')) process.exit(64);
const emit = row => process.stdout.write(JSON.stringify(row)+'\n');
const result = (id, value) => emit({id,result:value});
const note = (method, detail={}) => appendFileSync(log, JSON.stringify({method,...detail})+'\n');
const thread = (id, includeTurns) => ({id,cwd,name:'QA imported turns',preview:'native turn presentation',status:{type:'idle'}, ...(includeTurns ? {turns: turns(id)} : {})});
const turns = id => id === primary ? [
 {id:'completed-missing-duration',status:'completed',items:[
   {id:'native-user',type:'userMessage',text:'Imported question'},
   {id:'native-commentary',type:'agentMessage',phase:'commentary',text:'Commentary must fold with activity.'},
   {id:'native-reasoning',type:'reasoning',summary:['Reasoning survives import.']},
   {id:'native-tool-one',type:'commandExecution',status:'completed',command:'echo qa'},
   {id:'native-tool-two',type:'fileChange',status:'completed',changes:[{path:'src/qa.ts'}]},
   {id:'native-final',type:'agentMessage',phase:'final_answer',text:'Final answer remains visible.'}
 ]},
 {id:'failed-empty',status:'failed',items:[]}
] : id === 'qa-history-interrupted' ? [{id:'interrupted-empty',status:'interrupted',items:[]}] : [{id:'progress-empty',status:'inProgress',items:[]}];
function response(id, includeTurns) { return {thread:thread(id,includeTurns),threadSettings:{model:'qa-history-model',approvalPolicy:'on-request'}}; }
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line', raw => { if (!raw.trim()) return; const request=JSON.parse(raw); if(request.id===undefined)return; const {id,method,params={}}=request; note(method,{threadId:params.threadId, ...(Object.hasOwn(params,'includeTurns') ? {includeTurns: params.includeTurns===true} : {})});
 if(method==='initialize')return result(id,{capabilities:{}}); if(method==='account/read')return result(id,{account:{type:'chatgpt'},requiresOpenaiAuth:false}); if(method==='account/rateLimits/read')return result(id,{});
 if(method==='model/list')return result(id,{data:[{id:'qa-history-model',displayName:'QA history model',supportedReasoningEfforts:[]}]}); if(method==='skills/list')return result(id,{data:[]});
 if(method==='thread/list')return result(id,{data:[primary,'qa-history-interrupted','qa-history-progress'].map(nativeId=>({id:nativeId,cwd,name:nativeId===primary?'QA imported turns':'QA status edge',preview:'isolated fixture',updatedAt:1788710460,status:{type:'idle'}}))});
 if(method==='thread/read')return result(id,response(params.threadId,params.includeTurns===true));
 if(method==='thread/resume')return result(id,response(params.threadId,false));
 if(method==='thread/start')return result(id,response(primary,false));
 if(method==='thread/inject_items')return result(id,{});
 if(method==='turn/start'){ const turnId='live-'+(++serial); emit({method:'turn/started',params:{threadId:params.threadId,turn:{id:turnId}}}); result(id,{turn:{id:turnId}}); const text=String(params.input?.[0]?.text||''); if(text==='slow stop'){ return; } emit({method:'item/completed',params:{threadId:params.threadId,turnId,item:{id:turnId+'-answer',type:'agentMessage',phase:'final_answer',text:'Live subsequent answer'}}}); emit({method:'turn/completed',params:{threadId:params.threadId,turn:{id:turnId,status:'completed',durationMs:17}}}); return; }
 if(method==='turn/interrupt'){ emit({method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}}); return result(id,{}); }
 emit({id,error:{code:-32601,message:'unsupported '+method}}); });`.replaceAll('${nativeId}', nativeId);
}
async function safeCleanup() { const target = resolve(scratch); assert.ok(target.startsWith(`${resolve(tmpdir())}\\`) && target.includes('tt-history-turn-presentation-')); await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); }
async function lease(sessionId) { return (await rpc('session.claim', { sessionId, clientId: 'history-turn-presentation-qa' })).leaseEpoch; }
async function send(sessionId, text) { const epoch = await lease(sessionId); return rpc('chat.send', { sessionId, text, leaseEpoch: epoch, operationId: randomUUID() }); }
async function session(sessionId) { return (await rpc('runtime.snapshot')).sessions.find(row => row.id === sessionId); }
async function idle(sessionId) { return until(async () => (await session(sessionId))?.status === 'idle', `session ${sessionId} idle`); }
async function providerCalls() { return (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
const workerMethod = method => ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'].includes(method);
async function shot(name) { const path = join(out, name); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); }
async function visualMatrix(dialog, view) { for (const [language, theme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) { const snap = await rpc('runtime.snapshot'); await rpc('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() }); for (const [width, label] of [[1280, 'wide'], [420, 'narrow']]) { await page.setViewportSize({ width, height: 880 }); const visual = await dialog.evaluate(node => { const body = node.querySelector('.dlg-body'); const confirm = node.querySelector('.chat-repair-confirm'); const rect = node.getBoundingClientRect(); const bodyStyle = body ? getComputedStyle(body) : undefined; const confirmStyle = confirm ? getComputedStyle(confirm) : undefined; return { width: rect.width, height: rect.height, viewport: innerHeight, paddingLeft: bodyStyle ? Number.parseFloat(bodyStyle.paddingLeft) : -1, paddingTop: bodyStyle ? Number.parseFloat(bodyStyle.paddingTop) : -1, gap: confirmStyle ? Number.parseFloat(confirmStyle.rowGap) : -1, bodyHeight: body?.getBoundingClientRect().height ?? -1, confirmHeight: confirm?.getBoundingClientRect().height ?? -1 }; }); assert.ok(visual.width <= width + 1 && visual.height < visual.viewport * 0.75 && visual.bodyHeight <= visual.confirmHeight + 48, `${language}/${theme}/${label}: dialog must auto-size rather than reserve a page-height body`); assert.ok(visual.paddingLeft >= 16 && visual.paddingTop >= 16 && visual.gap >= 12, `${language}/${theme}/${label}: repair copy lacks padded, spaced confirmation layout`); if (!legacyResumed) { const reload = view.getByRole('button', { name: /Reload (?:native|saved) history|重新加载(?:原生|已保存的)历史/ }); const resume = view.getByRole('button', { name: /Resume explicitly|显式恢复/ }); await reload.waitFor(); const header = view.locator('header'); const [head, left, right, layout] = await Promise.all([header.boundingBox(), reload.boundingBox(), resume.boundingBox(), header.evaluate(node => { const style = getComputedStyle(node); return { viewport: innerWidth, flexWrap: style.flexWrap, display: style.display, transform: style.transform, width: node.getBoundingClientRect().width }; })]); assert.ok(head && left && right && left.x >= head.x && left.x + left.width <= head.x + head.width && right.x >= head.x && right.x + right.width <= head.x + head.width, `${language}/${theme}/${label}: read-only header controls clip ${JSON.stringify({ head, left, right, layout })}`); } await shot(`repair-dialog-${legacyResumed ? 'resumed-' : ''}${language}-${theme}-${label}.png`); } } }
async function closeApp() { try { if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }); } catch {} if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); } app = undefined; page = undefined; }
function seedLegacyMetadataFreeTranscript(sessionId, expectedItems) {
  const database = join(env.THREADTERM_V3_DATA, 'threadterm-v3.sqlite3');
  const db = new DatabaseSync(database);
  try {
    db.exec('BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT id, data FROM chat_items WHERE session_id=? ORDER BY created_at,id').all(sessionId);
    assert.ok(expectedItems > 0, 'fixture import has legacy transcript rows to downgrade');
    assert.equal(rows.length, expectedItems, 'fixture downgrade preserves every stored legacy transcript row');
    // ff08b4ad introduced scoped history turn identity/status/origin and phase
    // preservation. This fixture is intentionally the pre-ff08b4ad payload.
    const update = db.prepare('UPDATE chat_items SET turn_id=NULL,data=? WHERE id=? AND session_id=?');
    for (const row of rows) {
      const item = JSON.parse(row.data);
      delete item.turnId; delete item.turnStatus; delete item.elapsedMs; delete item.turnOrigin;
      delete item.forkAnchor; delete item.turnModel; delete item.turnUsage; delete item.turnReview;
      for (const part of item.parts) delete part.phase;
      assert.equal(update.run(JSON.stringify(item), row.id, sessionId).changes, 1, `legacy downgrade rewrote ${row.id}`);
    }
    assert.equal(db.prepare('UPDATE sessions SET read_only=? WHERE id=?').run(legacyResumed ? 0 : 1, sessionId).changes, 1, 'legacy session state was persisted');
    const legacy = db.prepare('SELECT turn_id,data FROM chat_items WHERE session_id=?').all(sessionId);
    assert.ok(legacy.every(row => row.turn_id === null && !Object.hasOwn(JSON.parse(row.data), 'turnOrigin') && !Object.hasOwn(JSON.parse(row.data), 'turnStatus') && JSON.parse(row.data).parts.every(part => !Object.hasOwn(part, 'phase'))), 'seed is a metadata-free legacy transcript, not a weakened current import');
    db.exec('COMMIT');
    report.observations.legacySeed = { database, items: legacy.length, resumed: legacyResumed };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
async function launch(runtimeExe) {
  env.THREADTERM_V3_RUNTIME = runtimeExe;
  env.THREADTERM_V3_PIPE = `\\\\.\\pipe\\tt-history-turns-${randomUUID()}`;
  app = await electron.launch({ args: [appDir, '--disable-features=CalculateNativeWinOcclusion'], cwd: bin, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
}

try {
  assert.ok(existsSync(runtime), `missing runtime ${runtime}`);
  await Promise.all([mkdir(out, { recursive: true }), mkdir(bin), mkdir(work)]);
  await writeFile(log, ''); await writeFile(join(scratch, 'fake-codex.cjs'), fixtureSource());
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true }); assert.equal(compiled.status, 0, compiled.stderr);
  await buildApp();
  const dropped = /^(path|codex_home|openai_api_key|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), CODEX_HOME: join(scratch, 'codex-home'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-history-turns-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(scratch, 'fake-codex.cjs'), TT_QA_HISTORY_CWD: work, TT_QA_HISTORY_LOG: log });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
  releaseElectronLock = await acquireElectronQaLock(); await launch(runtime);
  const initial = await rpc('runtime.snapshot'); await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  const project = await rpc('project.add', { path: work, name: 'Turn presentation QA', operationId: randomUUID() });
  const legacyListed = await rpc('history.list', { provider: 'codex', cwd: work, limit: 20 }); assert.equal(legacyListed.items.filter(item => item.nativeId === nativeId).length, 1, 'fake native thread is discoverable through the legacy runtime');
  const imported = await rpc('history.import', { projectId: project.id, provider: 'codex', nativeId, cwd: work, mode: 'chat', title: 'QA imported turns', operationId: randomUUID() });
  const importedItems = await rpc('chat.read', { sessionId: imported.id });
  assert.ok(importedItems.some(item => Object.hasOwn(item, 'turnStatus') || item.parts.some(part => Object.hasOwn(part, 'phase'))), 'current public import provides metadata that the legacy fixture must remove');
  report.legacySessionId = imported.id; await closeApp(); seedLegacyMetadataFreeTranscript(imported.id, importedItems.length);
  await launch(runtime);
  const resumed = (await rpc('runtime.snapshot')).sessions.find(row => row.id === imported.id); assert.equal(Boolean(resumed?.readOnly), !legacyResumed, 'new runtime preserves legacy session read-only state');
  const listed = await rpc('history.list', { provider: 'codex', cwd: work, limit: 20 }); assert.equal(listed.items.filter(item => item.nativeId === nativeId).length, 1, 'fake native thread remains discoverable after upgrade');
  // 676ddc68 folds a completed empty boundary onto its final assistant item;
  // the failed zero-item outcome remains a distinct boundary.
  const native = await rpc('history.read', { provider: 'codex', nativeId }); assert.equal(native.length, 7, 'two turns retain every native item while folding only the completed empty boundary');
  const completed = native.find(item => item.id === 'native-final'); const failed = native.find(item => item.id === 'turn:failed-empty:boundary');
  assert.equal(completed.turnStatus, 'completed'); assert.equal(Object.hasOwn(completed, 'elapsedMs'), false, 'missing duration is not fabricated'); assert.equal(failed.turnStatus, 'failed'); assert.equal(failed.parts.length, 0, 'failed status has a true zero-item/no-error boundary');
  assert.equal(native.find(item => item.id === 'native-commentary').parts[0].phase, 'commentary'); assert.equal(native.find(item => item.id === 'native-final').parts[0].phase, 'final_answer');
  check('native decoder retained same-turn tools, reasoning, commentary/final phases, empty failed boundary, and absent duration');
  for (const [edgeId, status] of [['qa-history-interrupted', 'interrupted'], ['qa-history-progress', 'inProgress']]) { const edge = await rpc('history.read', { provider: 'codex', nativeId: edgeId }); assert.equal(edge.length, 1); assert.equal(edge[0].turnStatus, status); assert.equal(edge[0].parts.length, 0, `${status} has a true zero-item/no-error boundary`); }
  check('true zero-item interrupted and in-progress native turns remain explicit rather than silently completed');
  // A writable old import must expose the legacy reload choice before ChatView
  // starts a native worker. Keep this boundary against the provider log rather
  // than using a global count because connection is expected after the choice.
  const callsBeforePresent = await providerCalls();
  await rpc('session.present', { sessionId: imported.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const chat = legacyResumed ? page.locator(`[data-testid="session-chat-${imported.id}"]`) : page.locator('.imported-history-view'); await chat.waitFor();
  try { await until(async () => { const value = await rpc('chat.snapshot', { sessionId: imported.id }); return value.repair?.offered ? value : undefined; }, 'legacy metadata rebuild offer'); }
  catch (error) { report.observations.repairOfferTimeout = { snapshot: await rpc('chat.snapshot', { sessionId: imported.id }).catch(caught => ({ error: String(caught) })), session: await session(imported.id).catch(caught => ({ error: String(caught) })), items: await rpc('chat.read', { sessionId: imported.id }).catch(caught => ({ error: String(caught) })), providers: await rpc('provider.list').catch(caught => ({ error: String(caught) })) }; throw error; }
  const reload = chat.getByRole('button', { name: /Reload (?:native|saved) history|重新加载(?:原生|已保存的)历史/ }); const resume = chat.getByRole('button', { name: /Resume explicitly|显式恢复/ }); await reload.waitFor(); if (legacyResumed) { assert.equal(await chat.locator('.codex-work').count(), 0, 'resumed legacy Chat starts unfolded and has no invented turn metadata'); const preChoiceCalls = (await providerCalls()).slice(callsBeforePresent.length); assert.equal(preChoiceCalls.filter(row => workerMethod(row.method)).length, 0, 'presenting a legacy-resumed Chat never opens a worker before reload choice'); } else { await resume.waitFor(); const header = chat.locator('header'); const [headerBox, reloadBox, resumeBox] = await Promise.all([header.boundingBox(), reload.boundingBox(), resume.boundingBox()]); assert.ok(headerBox && reloadBox && resumeBox && reloadBox.x >= headerBox.x && reloadBox.x + reloadBox.width <= headerBox.x + headerBox.width && resumeBox.x >= headerBox.x && resumeBox.x + resumeBox.width <= headerBox.x + headerBox.width, 'read-only header has both controls without clipping'); }
  if (continueWithoutReload) {
    const continueButton = chat.getByRole('button', { name: /Continue chat without reloading|不重新加载，继续聊天/ }); await continueButton.waitFor(); const beforeContinue = await providerCalls(); await continueButton.click(); await until(async () => (await providerCalls()).slice(beforeContinue.length).some(row => row.method === 'thread/resume'), 'native connection after explicit continue'); const continuedItems = await rpc('chat.read', { sessionId: imported.id }); assert.equal(continuedItems.some(item => Object.hasOwn(item, 'turnStatus') || item.parts.some(part => Object.hasOwn(part, 'phase'))), false, 'continue without reload does not fabricate legacy turn activity'); const continueCalls = (await providerCalls()).slice(beforeContinue.length); assert.equal(continueCalls.filter(row => row.method === 'thread/read' && row.includeTurns === true).length, 0, 'continue without reload does not read native turn history'); assert.equal(continueCalls.filter(row => row.method === 'thread/read' && row.includeTurns !== true).length, 1, 'ordinary Codex connect reads thread identity once'); assert.equal(continueCalls.filter(row => row.method === 'thread/resume').length, 1, 'ordinary Codex connect resumes the existing thread once'); check('explicit Continue without reloading uses the ordinary identity read and resume, with no history rebuild or fabricated legacy activity'); report.passed = true;
  } else {
  await reload.click(); const dialog = page.getByRole('dialog'); await dialog.waitFor(); await visualMatrix(dialog, chat); const callsBeforeCancel = await providerCalls();
  await dialog.getByRole('button', { name: /Cancel|取消/ }).click(); await dialog.waitFor({ state: 'detached' }); const callsAfterCancel = (await providerCalls()).slice(callsBeforeCancel.length); assert.equal(callsAfterCancel.filter(row => row.method === 'thread/read').length, 0, 'cancel reads no native history after its pre-confirm baseline'); assert.equal(callsAfterCancel.filter(row => workerMethod(row.method)).length, 0, 'cancel leaves the legacy connection held without a worker');
  const reset = await rpc('runtime.snapshot'); await rpc('settings.update', { patch: { language: 'en', theme: 'light' }, expectedRevision: reset.settings.revision, operationId: randomUUID() }); const reloadAgain = chat.getByRole('button', { name: /Reload (?:native|saved) history/ }); await reloadAgain.waitFor(); await reloadAgain.click(); await dialog.waitFor(); const callsBeforeRepair = await providerCalls(); await dialog.getByRole('button', { name: /Reload history/ }).click(); await dialog.waitFor({ state: 'detached' });
  const callsAfterRepair = (await providerCalls()).slice(callsBeforeRepair.length);
  assert.equal(callsAfterRepair.filter(row => row.method === 'thread/read').length, 1); assert.equal(callsAfterRepair.filter(row => workerMethod(row.method)).length, 0, 'repair read completes before the post-resync connection starts');
  check('explicit legacy metadata rebuild used exactly one read-only native read and did not open or send a worker');
  const rebuiltItems = await until(async () => { const items = await rpc('chat.read', { sessionId: imported.id }); return items.length === native.length ? items : undefined; }, 'rebuilt imported transcript');
  if (legacyResumed) await until(async () => (await providerCalls()).some(row => row.method === 'thread/resume'), 'normal authenticated connection only after repair snapshot resync');
  const rebuiltCompleted = rebuiltItems.find(item => item.id.endsWith(':history:native-final')); assert.ok(rebuiltCompleted); assert.equal(rebuiltCompleted.turnStatus, 'completed'); assert.equal(Object.hasOwn(rebuiltCompleted, 'elapsedMs'), false);
  if (!legacyResumed) await resume.click(); const liveChat = page.locator(`[data-testid="session-chat-${imported.id}"]`); await liveChat.waitFor(); assert.equal(Boolean((await session(imported.id))?.readOnly), false, 'repair preserves resumed writable session state');
  await until(async () => (await liveChat.locator('.chat-tool-activity').count()) === 1, 'one folded completed activity');
  assert.equal(await liveChat.locator('.chat-tool-entry').count(), 2, 'same completed turn has two flat tool entries');
  const rebuiltText = await liveChat.innerText(); assert.match(rebuiltText, /Final answer remains visible/); assert.match(rebuiltText, /Turn failed|回合失败/); await shot('01-rebuilt-chat.png');
  check('legacy import rebuilt into resumed real Chat with scoped metadata, folded same-turn tools/reasoning, final answer, and visible zero-item failed outcome');
  await send(imported.id, 'ordinary subsequent'); await idle(imported.id); const afterLive = await rpc('chat.read', { sessionId: imported.id }); assert.ok(afterLive.some(item => item.parts.some(part => part.text === 'Live subsequent answer'))); check('ordinary fake Codex subsequent turn completed after explicit resume');
  await send(imported.id, 'slow stop'); await until(async () => (await session(imported.id))?.status === 'running', 'slow turn active'); const stop = liveChat.getByRole('button', { name: /Stop|停止/ }); await stop.click(); await idle(imported.id); await stop.waitFor({ state: 'detached' }); const interruptCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter(row => row.method === 'turn/interrupt'); assert.ok(interruptCalls.length >= 1, 'Stop dispatched exactly the fixture-native interrupt path'); check('Stop dispatched the native interrupt and settled the live session without assigning historical-only turn metadata');
  report.passed = true;
  }
} catch (error) { report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined); process.exitCode = 1; }
finally { await closeApp(); await releaseElectronLock?.().catch(error => { report.errors.push(`QA Electron lock release failed: ${error.message}`); }); await cleanupApp?.().catch(() => undefined); report.finishedAt = new Date().toISOString(); await mkdir(out, { recursive: true }).catch(() => undefined); await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined); if (report.passed) await safeCleanup().catch(() => undefined); process.stdout.write(`${report.passed ? 'HISTORY TURN PRESENTATION QA PASSED' : 'HISTORY TURN PRESENTATION QA FAILED'} ${join(out, 'report.json')}\n`); }
