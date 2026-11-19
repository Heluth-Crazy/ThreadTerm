// Isolated Electron probe for one fold per output segment (11-18 chat-activity-fold).
// It uses the production ChatView and CSS bundle only; no runtime and no provider start.
// The turn is played as snapshot/item updates so every rule in R1–R4 is asserted while it grows.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-fold-'));
const out = resolve('qa', 'results', 'chat-activity-fold', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from './renderer/src/components/ChatView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';

let listeners = new Set(), items = [], status = 'running', sequence = 0, locale = 'zh-CN', provider = 'codex', sessionId = 'qa-fold-0', stages = [], sessionSeq = 0;
const connection = id => ({sessionId:id, runtimeEpoch:'qa', connectionGeneration:1, revision:1, phase:'ready', optionsLoadState:'ready'});
window.threadterm = {
  onEvent(listener) { listeners.add(listener); window.qaReady = true; return () => listeners.delete(listener); },
  async request(method, params) {
    if (method === 'chat.snapshot') return {items, revision:sequence};
    if (method === 'chat.draft.read') return {text:'', revision:0};
    if (method === 'chat.draft.save') return {text:params.text, revision:1};
    if (method === 'chat.options') return {options:[], commands:[], loadState:'ready'};
    if (method === 'chat.connection' || method === 'chat.connect') return connection(params.sessionId);
    if (method === 'chat.queue.read') return {sessionId:params.sessionId, paused:false, items:[]};
    if (method === 'chat.feedback.read') return {notes:[]};
    if (method === 'session.claim') return {leaseEpoch:1};
    if (method === 'session.renew') return {leaseEpoch:1};
    if (method === 'session.release') return null;
    if (method === 'chat.cancel') return null;
    throw new Error('Unexpected QA request '+method);
  }
};

// ── The prototype's turn, one stage per snapshot update ──
const think = (text, streaming = true) => ({type:'thinking', text, status:streaming ? 'streaming' : 'complete'});
const say = text => ({type:'text', text, status:'complete', phase:'commentary'});
const answer = (text, streaming = false) => ({type:'text', text, status:streaming ? 'streaming' : 'complete', phase:'final_answer'});
const file = (toolId, toolName, text, status = 'completed', extra = {}) => ({type:'tool', toolId, toolName, text, status, data:{...extra}});
const input = value => ({state:{input:value}});
const read = (toolId, path) => file(toolId, 'Read', undefined, 'completed', input({file_path:path}));
const search = (toolId, query) => file(toolId, 'Grep', undefined, 'completed', {...input({pattern:query}), commandActions:[{type:'search'}]});
const edit = (toolId, path) => file(toolId, 'Edit', undefined, 'completed', {kind:'edit', ...input({file_path:path})});
const command = (toolId, text, status = 'completed', extra = {}) => file(toolId, 'commandExecution', undefined, status, {type:'commandExecution', command:text, ...extra});
const approval = st => ({type:'approval', approvalId:'appr-1', status:st, data:{approvalId:'appr-1', requestType:'commandExecution', title:'Approve command', details:{command:'cargo test --lib auth'}, choices:[{choiceId:'allow', label:'Allow once', kind:'allow', scope:'once'},{choiceId:'deny', label:'Deny', kind:'deny', scope:'once'}]}});

const CODEX = [
  {item:{id:'a1', parts:[think('先找到重试逻辑在哪，再看上限是怎么算的。')]}},
  {item:{id:'a1b', parts:[{type:'text', text:'我先看一下 auth 模块的重试实现。', status:'streaming', phase:'commentary'}]}},
  {item:{id:'a2', parts:[read('read-1', 'runtime/src/auth/retry.rs')]}},
  {item:{id:'a3', parts:[search('search-1', 'max_retries')]}},
  {item:{id:'a4', parts:[read('read-2', 'runtime/src/auth/client.rs')]}},
  {item:{id:'a5', parts:[think('上限写死了 3 次，慢网络下 3 次很快就用完，应该改成按总时长。')]}},
  {item:{id:'a6', parts:[say('找到了：重试次数写死在 retry.rs。我改成按总时长（10 秒）限制。')]}},
  {item:{id:'a7', parts:[edit('edit-1', 'runtime/src/auth/retry.rs')]}},
  {item:{id:'a8', parts:[edit('edit-2', 'runtime/src/auth/client.rs')]}},
  {item:{id:'a9', parts:[approval('pending')]}, status:'waiting'},
  {item:{id:'a9', parts:[approval('resolved')]}, status:'running', replace:true},
  {item:{id:'a10', parts:[command('cmd-1', 'cargo test --lib auth', 'completed', {exitCode:0, aggregatedOutput:'test result: ok. 41 passed'})]}},
  {item:{id:'a11', parts:[think('单元测试过了，再跑一遍登录的集成测试。')]}},
  {item:{id:'a12', parts:[command('cmd-2', 'npm run test -- login', 'failed', {exitCode:1, aggregatedOutput:'✕ auth_login_slow (10012 ms)'})]}},
  {item:{id:'a13', parts:[say('集成测试有一个失败，是测试配置里的超时没同步，我顺手改掉。')]}},
  {item:{id:'a14', parts:[edit('edit-3', 'qa/integration.config.json')]}},
  {item:{id:'a15', parts:[command('cmd-3', 'npm run test -- login', 'completed', {exitCode:0, aggregatedOutput:'12 passed'})]}},
  {item:{id:'a16', parts:[answer('已修复登录偶尔超时的问题。', true)]}},
  {item:{id:'a16', parts:[answer('已修复登录偶尔超时的问题。')]}, replace:true},
  {item:{id:'done', parts:[], elapsedMs:134000, turnStatus:'completed', turnModel:'GPT-6.1-Sol', turnUsage:{inputTokens:48200, outputTokens:3100, cachedInputTokens:41000}}, status:'idle'},
];
// A provider that marks no phase: the newest text streams outside, joins the fold when a tool follows,
// and only the trailing text is the answer (R1's one accepted jump).
const CLAUDE = [
  {item:{id:'c1', parts:[think('我先读一下这个文件。')]}},
  {item:{id:'c2', parts:[{type:'text', text:'让我先看看重试的实现。', status:'streaming'}]}},
  {item:{id:'c2', parts:[{type:'text', text:'让我先看看重试的实现。', status:'complete'}]}, replace:true},
  {item:{id:'c3', parts:[read('c-read', 'runtime/src/auth/retry.rs')]}},
  {item:{id:'c4', parts:[{type:'text', text:'问题出在固定的重试次数上。', status:'complete'}]}},
  {item:{id:'c5', parts:[edit('c-edit', 'runtime/src/auth/retry.rs')]}},
  {item:{id:'c6', parts:[{type:'text', text:'已改成按总时长限制，并补了一条测试。', status:'complete'}]}},
  {item:{id:'c-done', parts:[], elapsedMs:61000, turnStatus:'completed'}, status:'idle'},
];

// The real Claude adapter (11-19 live turn): the turn's prose is ONE item, created first and still growing
// after the tools; each tool call is its own item recorded after it. The answer must stay outside the fold.
const CLAUDE_REAL = [
  {item:{id:'ct', parts:[think('先确认仓库状态。')]}},
  {item:{id:'ct', parts:[think('先确认仓库状态。', false), {type:'text', text:"I'll run both read-only commands together.", status:'streaming'}]}, replace:true},
  {item:{id:'ct-bash-1', parts:[file('bash-1', 'Bash', undefined, 'completed', input({command:'git status'}))]}},
  {item:{id:'ct-bash-2', parts:[file('bash-2', 'Bash', undefined, 'completed', input({command:'dir'}))]}},
  {item:{id:'ct', parts:[think('先确认仓库状态。', false), {type:'text', text:"I'll run both read-only commands together.\\n\\n当前目录有 README.md 和 notes.txt，notes.txt 被修改了。", status:'complete'}]}, replace:true},
  {item:{id:'ct-done', parts:[], elapsedMs:48000, turnStatus:'completed'}, status:'idle'},
];

const root = createRoot(document.getElementById('root'));
const session = () => ({id:sessionId, provider, mode:'chat', status, title:'QA fold', createdAt:'now', updatedAt:'now'});
const render = () => root.render(React.createElement(I18nProvider, {locale, key:sessionId}, React.createElement(ChatView, {session:session()})));
window.qaReset = (kind = 'codex', nextLocale = 'zh-CN') => {
  provider = kind === 'claude' || kind === 'claude-real' ? 'claude' : 'codex';
  // A fresh session id makes ChatView remount, so the probe always starts from an empty transcript.
  sessionId = 'qa-fold-' + kind + '-' + (++sessionSeq);
  locale = nextLocale;
  stages = kind === 'claude' ? CLAUDE : kind === 'claude-real' ? CLAUDE_REAL : CODEX;
  items = []; status = 'running'; sequence = 0; listeners.clear(); window.qaReady = false;
  document.documentElement.dataset.theme = 'light';
  render();
  return stages.length;
};
window.qaSetTheme = theme => { document.documentElement.dataset.theme = theme; };
window.qaStage = index => {
  const stage = stages[index];
  if (!stage) throw new Error('no stage ' + index);
  // Codex records every command, edit and search as its own role:'tool' row (as do ACP agents and Grok);
  // Claude keeps tool_use inside the assistant row. The probe plays both shapes.
  const role = provider === 'codex' && stage.item.parts.some(part => part.type === 'tool') ? 'tool' : 'assistant';
  const item = {turnId:'turn-1', role, createdAt:'now', ...stage.item};
  if (stage.status) status = stage.status;
  items = stage.replace ? items.map(row => row.id === item.id ? item : row) : [...items, item];
  render();
  listeners.forEach(listener => listener({event:'chat.item', seq:++sequence, epoch:'qa', data:{sessionId, item}}));
  // Resolve after React has committed and the browser painted, so callers never assert mid-update.
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
};
window.qaState = () => {
  const log = document.querySelector('.v3-chat-log');
  if (!log) return {missing:true};
  let marks = (window.qaMarks ||= {fold:0});
  const folds = [...log.querySelectorAll('details.chat-fold')];
  for (const fold of folds) if (!fold.dataset.qaMark) fold.dataset.qaMark = 'fold-' + (++marks.fold);
  const steps = [...log.querySelectorAll('.chat-fold > .chat-tool-entries > *')].map(node => {
    if (node.matches('.chat-tool-entry')) return 'tool:' + node.dataset.toolId;
    if (node.matches('.chat-fold-step.is-thinking')) return 'think:' + node.querySelector('.chat-fold-step-value')?.textContent;
    // A closed fold keeps one line per note; an open fold renders the whole note (Markdown).
    if (node.matches('.chat-fold-step.is-note')) return 'note:' + (node.querySelector('.chat-fold-step-value') ?? node.querySelector('.chat-fold-note-body'))?.textContent?.trim();
    if (node.matches('.chat-fold-step.is-approval')) return 'approval:' + node.querySelector('.chat-fold-step-value')?.textContent;
    return 'other:' + node.className;
  });
  const footer = log.querySelector('[data-testid="chat-turn-footer"]');
  return {
    folds: folds.map(fold => ({mark:fold.dataset.qaMark, open:fold.open, head:fold.querySelector('summary')?.textContent ?? '', steps:steps})),
    foldCount: folds.length,
    openDetails: [...log.querySelectorAll('details[open]')].map(node => node.className),
    liveSpinners: log.querySelectorAll('.chat-fold.is-live .chat-tool-spinner').length,
    // A tool call rendered as its own card outside a fold (the 11-18 role:'tool' regression).
    looseTools: [...log.querySelectorAll('.chat-part.tool, .codex-tool-disclosure')].filter(node => !node.closest('details.chat-fold')).length,
    approvalCards: [...log.querySelectorAll('.chat-part.approval')].map(node => node.closest('details.chat-fold') ? 'folded' : 'outside'),
    steps,
    outsideText: [...log.querySelectorAll('.v3-chat-log article.assistant .chat-part.text')].filter(node => !node.closest('details.chat-fold')).map(node => node.textContent?.trim()),
    workingIndicators: log.querySelectorAll('.chat-live-activity, [data-testid="turn-speed-live"]').length,
    answerAfterFold: (() => { const fold = log.querySelector('details.chat-fold'); const texts = [...log.querySelectorAll('article.assistant .chat-part.text')].filter(node => !node.closest('details.chat-fold')); return fold && texts.length ? Boolean(fold.compareDocumentPosition(texts.at(-1)) & Node.DOCUMENT_POSITION_FOLLOWING) : null; })(),
    footer: footer ? footer.textContent?.replace(/\\s+/g, ' ') ?? '' : undefined,
    // Everything that is not inside the fold: the answer, pending cards, status lines.
    outsideFolds: [...log.querySelectorAll('article, footer')].filter(node => !node.closest('details.chat-fold') && !node.querySelector('details.chat-fold')).length,
    scrollWidth: log.scrollWidth, clientWidth: log.clientWidth,
  };
};
window.qaReset('codex');
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{display:flex;height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const report = { passed: false, checks: [], stages: [], screenshots: [] };
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => typeof window.qaStage === 'function');
  await page.setViewportSize({ width: 1280, height: 900 });

  const state = () => page.evaluate(() => window.qaState());
  const reset = async (kind, locale) => {
    const total = await page.evaluate(([k, l]) => window.qaReset(k, l), [kind, locale ?? 'zh-CN']);
    await page.waitForFunction(() => window.qaReady === true && document.querySelector('.v3-chat-log'));
    return total;
  };
  const stage = async index => {
    await page.evaluate(value => window.qaStage(value), index);
    return state();
  };
  const check = (label, condition, detail) => {
    assert.ok(condition, `${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    report.checks.push(label);
  };
  const fold = state => state.folds[0];
  const shot = async name => { const path = join(out, `${name}.png`); await page.screenshot({ path }); report.screenshots.push(path); };

  // ── The Codex turn: one fold from the first thought to the last command ──
  const total = await reset('codex');
  let mark;
  for (let index = 0; index < total; index += 1) {
    const now = await stage(index);
    const label = `stage ${index}`;
    check(`${label}: one fold for the working segment`, now.foldCount === 1, now.foldCount);
    check(`${label}: nothing opens by itself`, now.openDetails.length === 0, now.openDetails);
    check(`${label}: no tool call renders outside the fold`, now.looseTools === 0, now.looseTools);
    if (mark === undefined) mark = fold(now).mark;
    check(`${label}: the fold is the same element`, fold(now).mark === mark, [mark, fold(now).mark]);
    if (index === 2 || index === 9 || index === 13) await shot(`light-mid-${index}`);
    if (index === 9) {
      check('pending approval stays outside the fold', now.approvalCards.join() === 'outside', now.approvalCards);
      check('pending approval is not a fold step', !now.steps.some(step => step.startsWith('approval:')), now.steps);
      check('the live approval spinner does not open anything', now.liveSpinners === 1, now.liveSpinners);
      await shot('light-pending-approval');
    }
    if (index === 10) {
      check('a resolved approval joins the fold', now.steps.some(step => step.startsWith('approval:')), now.steps);
      check('the resolved approval is no longer a card', now.approvalCards.length === 0, now.approvalCards);
    }
    report.stages.push({ index, folds: now.foldCount, steps: now.steps.length, open: now.openDetails.length });
  }
  const settledState = await state();
  check('the settled turn is one fold, the answer and the footer', settledState.foldCount === 1 && settledState.footer !== undefined, settledState.footer);
  check('the answer stays outside the fold', settledState.outsideText.includes('已修复登录偶尔超时的问题。'), settledState.outsideText);
  check('nothing is open at the end', settledState.openDetails.length === 0, settledState.openDetails);
  check('the settled header says it is done and carries no duration', /已完成/.test(fold(settledState).head) && !/2m 14s/.test(fold(settledState).head), fold(settledState).head);
  check('the duration lives only in the footer', /用时 2m 14s/.test(settledState.footer ?? ''), settledState.footer);
  check('the fold counts what it did', /运行 3 条命令/.test(fold(settledState).head) && /修改 2 个文件|查看/.test(fold(settledState).head), fold(settledState).head);
  check('a failed call is reported in the header', /1 项失败|1 次失败/.test(fold(settledState).head), fold(settledState).head);
  check('the layout does not overflow horizontally', settledState.scrollWidth <= settledState.clientWidth + 1, [settledState.scrollWidth, settledState.clientWidth]);
  await shot('light-end');

  // Opening the fold shows every step in order.
  await page.locator('.v3-chat-log details.chat-fold > summary').click();
  await page.waitForFunction(() => document.querySelector('.v3-chat-log details.chat-fold')?.open === true);
  const expanded = await state();
  check('the reader can open the fold', expanded.openDetails.length === 1, expanded.openDetails);
  assert.deepEqual(expanded.steps, [
    'think:先找到重试逻辑在哪，再看上限是怎么算的。',
    'note:我先看一下 auth 模块的重试实现。',
    'tool:read-1', 'tool:search-1', 'tool:read-2',
    'think:上限写死了 3 次，慢网络下 3 次很快就用完，应该改成按总时长。',
    'note:找到了：重试次数写死在 retry.rs。我改成按总时长（10 秒）限制。',
    'tool:edit-1', 'tool:edit-2',
    'approval:已作出决定：cargo test --lib auth',
    'tool:cmd-1',
    'think:单元测试过了，再跑一遍登录的集成测试。',
    'tool:cmd-2',
    'note:集成测试有一个失败，是测试配置里的超时没同步，我顺手改掉。',
    'tool:edit-3',
    'tool:cmd-3',
  ], 'every step is in the fold, in order');
  report.checks.push('expanded steps keep their order and their kinds');
  const noteBodies = await page.locator('.v3-chat-log details.chat-fold[open] .chat-fold-note-body').count();
  check('an open fold shows every note in full, not one line', noteBodies === 3, noteBodies);
  await shot('light-end-expanded');
  // Collapsing scrolls the header back, as before.
  await page.locator('.v3-chat-log .chat-tool-collapse').first().click();
  await page.waitForFunction(() => document.querySelector('.v3-chat-log details.chat-fold')?.open === false);

  // ── A Claude-shaped turn: unphased text is the answer until a tool follows ──
  const claudeTotal = await reset('claude');
  let claudeMark;
  for (let index = 0; index < claudeTotal; index += 1) {
    const now = await stage(index);
    const label = `claude stage ${index}`;
    check(`${label}: one fold`, now.foldCount === 1, now.foldCount);
    check(`${label}: nothing opens by itself`, now.openDetails.length === 0, now.openDetails);
    check(`${label}: no tool call renders outside the fold`, now.looseTools === 0, now.looseTools);
    if (claudeMark === undefined) claudeMark = fold(now).mark;
    check(`${label}: the fold keeps its element`, fold(now).mark === claudeMark, [claudeMark, fold(now).mark]);
    if (index === 2) {
      check('a streaming unphased text is the answer outside the fold', now.steps.length === 1 && now.outsideText.includes('让我先看看重试的实现。'), [now.steps, now.outsideText]);
    }
    if (index === 3) {
      check('a tool after the text keeps that text the visible answer, below the fold', now.steps.includes('tool:c-read') && !now.steps.includes('note:让我先看看重试的实现。') && now.outsideText.includes('让我先看看重试的实现。') && now.answerAfterFold === true, [now.steps, now.outsideText, now.answerAfterFold]);
    }
    if (index === 4) {
      check('the next text takes the answer over and the earlier text joins the same fold', now.steps.includes('note:让我先看看重试的实现。') && !now.outsideText.includes('让我先看看重试的实现。') && now.outsideText.includes('问题出在固定的重试次数上。'), [now.steps, now.outsideText]);
    }
  }
  const claudeEnd = await state();
  check('the Claude answer stays outside the fold', claudeEnd.outsideText.includes('已改成按总时长限制，并补了一条测试。'), claudeEnd.outsideText);
  check('the Claude fold is settled and counted', /已完成/.test(fold(claudeEnd).head), fold(claudeEnd).head);
  check('the Claude turn keeps one fold', claudeEnd.foldCount === 1, claudeEnd.foldCount);

  // ── The real Claude shape: one growing prose item before its tool items ──
  const realTotal = await reset('claude-real');
  let realMark;
  for (let index = 0; index < realTotal; index += 1) {
    const now = await stage(index);
    const label = `claude-real stage ${index}`;
    check(`${label}: at most one fold`, now.foldCount <= 1, now.foldCount);
    check(`${label}: nothing opens by itself`, now.openDetails.length === 0, now.openDetails);
    check(`${label}: no tool call renders outside the fold`, now.looseTools === 0, now.looseTools);
    if (now.foldCount === 1) {
      if (realMark === undefined) realMark = fold(now).mark;
      check(`${label}: the fold keeps its element`, fold(now).mark === realMark, [realMark, fold(now).mark]);
    }
    if (index >= 2 && index < realTotal - 1) {
      check(`${label}: the prose stays visible after the fold while tools run`, now.outsideText.some(text => text.startsWith("I'll run both read-only commands together.")) && now.answerAfterFold === true, [now.outsideText, now.answerAfterFold]);
    }
  }
  const realEnd = await state();
  check('the real Claude answer is outside the fold, after it', realEnd.outsideText.some(text => text.includes('当前目录有 README.md 和 notes.txt')) && realEnd.answerAfterFold === true, [realEnd.outsideText, realEnd.answerAfterFold]);
  check('the real Claude fold holds the thinking and both tool calls', realEnd.steps.filter(step => step.startsWith('tool:')).length === 2 && realEnd.steps.some(step => step.startsWith('think:')), realEnd.steps);
  check('the real Claude fold is settled', /已完成/.test(fold(realEnd).head), fold(realEnd).head);
  await shot('light-claude-real-end');

  // ── Screenshots in dark, replayed to the states that matter ──
  await reset('codex');
  await page.evaluate(() => window.qaSetTheme('dark'));
  for (let index = 0; index <= 5; index += 1) await stage(index);
  await shot('dark-mid');
  for (let index = 6; index <= 9; index += 1) await stage(index);
  await shot('dark-pending-approval');
  for (let index = 10; index < total; index += 1) await stage(index);
  await shot('dark-end');
  await page.locator('.v3-chat-log details.chat-fold > summary').click();
  await page.waitForFunction(() => document.querySelector('.v3-chat-log details.chat-fold')?.open === true);
  await shot('dark-end-expanded');

  report.passed = true;
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, out, checks: report.checks.length, screenshots: report.screenshots.length }));
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
}
