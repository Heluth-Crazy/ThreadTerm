// R15/R14 component fixture: the 待处理 workbench and the automatic row in Chat, with synthetic RPCs.
// Never starts the runtime or an agent. Screenshots land in qa/results/operator-inbox/.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const qaTemp = resolve(process.env.TEMP ?? tmpdir());
const scratch = await mkdtemp(join(qaTemp, 'threadterm-operator-inbox-'));
const out = resolve('qa/results/operator-inbox');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { InboxPage } from './renderer/src/components/InboxPage';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const copy = (en, zh) => state.locale === 'zh-CN' ? zh : en;
const project = { id: 'proj', name: 'ThreadTerm-v3', path: 'D:/qa/threadterm', pinned: false, sortOrder: 0, revision: 0 };
const catalog = [{ ...project, git: { available: true, branch: 'main' } }];
const providers = [
  { id: 'claude', name: 'Claude', installed: true, terminal: true, chat: true, history: true, resume: true, auth: 'authenticated' },
  { id: 'codex', name: 'Codex', installed: true, terminal: true, chat: true, history: true, resume: true, auth: 'authenticated' },
  { id: 'kimi', name: 'Kimi', installed: true, terminal: true, chat: true, history: true, resume: true, auth: 'authenticated' },
  { id: 'pi', name: 'pi', installed: true, terminal: true, chat: true, history: true, resume: true, auth: 'authenticated' },
];

const session = (id, provider, updatedAt, extra = {}) => ({ id, title: id, provider, mode: 'chat', status: 'idle', createdAt: '2026-11-02T08:00:00Z', updatedAt, projectId: project.id, worktreePath: project.path, ...extra });
const child = (id, provider, state, extra = {}) => session(id, provider, extra.updatedAt ?? '2026-11-02T10:00:00Z', { delegation: { id: 'del-' + id, parentSessionId: extra.parent ?? 'goal-a', workspace: 'shared', state, ...(extra.delegation ?? {}) }, ...(extra.session ?? {}) });

const AUTOMATIC = [
  '[ThreadTerm] Automatic delegate update, not a message from the user:',
  '- "Fix chat history restore" (codex, del-a1) completed. Read it with delegate_result.',
  '- "Multi-monitor probe" (pi, del-a2) asks: "Which screen should the island follow?". Answer with delegate_respond (requestId r1; choices in delegate_status).',
  '- "Read-only review" (kimi, del-a3) has had no activity for 12 min. Check it with delegate_status; stop it with delegate_cancel if it is stuck.',
  'Handle these, then end your turn. ThreadTerm wakes you again on the next update. Use ask_user only for decisions that belong to the user.'
].join('\\n');

const questionPart = { type: 'approval', approvalId: 'q1', status: 'pending', data: { approvalId: 'q1', interaction: 'question', answerable: true, isBlocking: true, form: { kind: 'questions', questions: [{ id: 'approach', header: 'Approach', question: 'Which approach should the island take?', options: [{ label: 'Detect per screen', description: 'Accurate, checks every 500 ms.' }, { label: 'Main screen only', description: 'Simple, shows on a full-screen second screen.' }], multiSelect: false, allowOther: false, secret: false }] } } };
const commandApproval = { type: 'approval', approvalId: 'a1', status: 'pending', data: { approvalId: 'a1', title: 'Run command', requestType: 'commandExecution', submittable: true, choices: [{ choiceId: 'allow', label: 'Allow once', kind: 'allow', scope: 'once' }, { choiceId: 'deny', label: 'Deny', kind: 'deny', scope: 'turn' }] } };
const command = (text, exitCode, status) => ({ type: 'tool', toolName: 'Bash', status, data: { input: { command: text }, ...(exitCode === undefined ? {} : { exitCode }) } });

const chatItems = (id) => {
  if (id === 'goal-a') return [
    { id: 'chain-1', role: 'user', turnId: 'turn-parent', createdAt: '2026-11-02T08:00:00Z', parts: [{ type: 'text', text: 'Make the island follow the full-screen window.' }] },
    { id: 'chain-2', role: 'assistant', turnId: 'turn-parent', createdAt: '2026-11-02T08:01:00Z', parts: [{ type: 'text', text: 'Delegated three subtasks.' }] },
    { id: 'auto-1', role: 'user', turnId: 'turn-auto', createdAt: '2026-11-02T09:00:00Z', parts: [{ type: 'text', text: AUTOMATIC, automatic: true }] },
    { id: 'auto-2', role: 'assistant', turnId: 'turn-auto', createdAt: '2026-11-02T09:01:00Z', parts: [{ type: 'text', text: 'Thanks, handling these now.' }] }
  ];
  if (id === 'kid-q') return [
    { id: 'kid-q:approval:q1', role: 'assistant', turnId: 'turn-q', createdAt: '2026-11-02T09:30:00Z', parts: [questionPart] }
  ];
  if (id === 'kid-ok') return [
    { id: 'kid-ok-user', role: 'user', turnId: 'turn-ok', createdAt: '2026-11-02T09:00:00Z', parts: [{ type: 'text', text: 'Fix the restore path.' }] },
    { id: 'kid-ok-work', role: 'assistant', turnId: 'turn-ok', createdAt: '2026-11-02T09:10:00Z', parts: [command('npm run typecheck', 0, 'complete'), command('cargo test --lib chat_projection', 0, 'complete')] }
  ];
  if (id === 'kid-ok2') return [
    { id: 'kid-ok2-user', role: 'user', turnId: 'turn-ok2', createdAt: '2026-11-02T09:00:00Z', parts: [{ type: 'text', text: 'Add regression tests.' }] },
    { id: 'kid-ok2-work', role: 'assistant', turnId: 'turn-ok2', createdAt: '2026-11-02T09:20:00Z', parts: [command('node scripts/run-renderer-tests.mjs', 0, 'complete')] }
  ];
  if (id === 'kid-back') return [
    { id: 'kid-back-user', role: 'user', turnId: 'turn-back', createdAt: '2026-11-02T09:00:00Z', parts: [{ type: 'text', text: 'Review the diff.' }] },
    { id: 'kid-back-work', role: 'assistant', turnId: 'turn-back', createdAt: '2026-11-02T09:40:00Z', parts: [command('git diff --stat', 0, 'complete'), command('npm run check:fast', 1, 'failed')] }
  ];
  if (id === 'lonely') return [
    { id: 'lonely:approval:a1', role: 'assistant', turnId: 'turn-lonely', createdAt: '2026-11-02T09:50:00Z', parts: [commandApproval] }
  ];
  return [];
};

let mode = 'full';
const fullSessions = () => [
  session('goal-a', 'claude', '2026-11-02T09:45:00Z', { status: 'running' }),
  child('kid-q', 'kimi', 'awaiting_user', { updatedAt: '2026-11-02T09:30:00Z' }),
  child('kid-run', 'pi', 'running', { updatedAt: '2026-11-02T09:44:00Z' }),
  child('kid-ok', 'codex', 'completed', { updatedAt: '2026-11-02T09:10:00Z', delegation: { outcome: 'Reconnect replays approvals by turn; the old dedupe stays.' } }),
  child('kid-ok2', 'pi', 'completed', { updatedAt: '2026-11-02T09:20:00Z', delegation: { outcome: '12 tests pass; two remote-view tests are skipped.' } }),
  session('goal-b', 'codex', '2026-11-02T09:35:00Z'),
  child('kid-b', 'kimi', 'running', { parent: 'goal-b', updatedAt: '2026-11-02T09:35:00Z' }),
  child('kid-back', 'claude', 'completed', { parent: 'goal-b', updatedAt: '2026-11-02T09:40:00Z', delegation: { outcome: 'Two files changed; the check failed on lint.' } }),
  session('lonely', 'claude', '2026-11-02T09:50:00Z')
];
const fullInbox = () => [
  { id: 'kid-q:approval:q1', sessionId: 'kid-q', kind: 'approval', title: 'Which approach should the island take?', createdAt: '2026-11-02T09:30:00Z', read: false },
  { id: 'lonely:approval:a1', sessionId: 'lonely', kind: 'approval', title: 'Run command', createdAt: '2026-11-02T09:50:00Z', read: false },
  { id: 'goal-b:autowake_exhausted:x', sessionId: 'goal-b', kind: 'autowake_exhausted', title: 'goal-b', createdAt: '2026-11-02T09:36:00Z', read: false }
];

let state = { locale: 'en', theme: 'light', view: 'inbox', sessions: fullSessions(), inbox: fullInbox(), calls: [], opened: [], rejectApproval: true, created: [] };
const listeners = new Set();
const call = (method, params) => { state.calls.push({ method, params }); };
const decideAcceptance = (params) => {
  const childId = state.sessions.find(item => item.delegation && item.delegation.id === params.delegationId)?.id;
  if (!childId) throw new Error('delegation_not_completed');
  state.sessions = state.sessions.map(item => item.id === childId ? { ...item, delegation: { ...item.delegation, acceptance: params.decision === 'accept' ? 'accepted' : 'sent_back' } } : item);
};
const settleInbox = (sessionId, approvalId) => {
  state.inbox = state.inbox.filter(item => item.sessionId !== sessionId || !item.id.endsWith(approvalId));
  state.sessions = state.sessions.map(item => item.id === sessionId ? { ...item, status: 'running' } : item);
};
const chatItemsLive = (id) => {
  const items = chatItems(id);
  if (state.inbox.some(item => item.sessionId === id)) return items;
  return items.map(item => ({ ...item, parts: item.parts.map(part => part.type === 'approval' && part.status === 'pending' ? { ...part, status: 'resolved' } : part) }));
};

window.threadterm = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method, params) {
    call(method, params);
    if (method === 'project.catalog.list') return catalog;
    if (method === 'worktree.list') return [];
    if (method === 'chat.snapshot') return { items: chatItemsLive(params.sessionId), revision: 1, repair: { offered: false, degraded: false }, hasEarlier: false };
    if (method === 'chat.connection') return { sessionId: params.sessionId, phase: 'disconnected', connectionGeneration: 0 };
    if (method === 'chat.options') return { options: [], commands: [] };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.queue.read') return { sessionId: params.sessionId, paused: false, items: [] };
    if (method === 'chat.feedback.read') return { notes: [] };
    if (method === 'session.claim') return { leaseEpoch: 1 };
    if (method === 'session.renew') return { leaseEpoch: 1 };
    if (method === 'session.release') return null;
    if (method === 'session.update') return null;
    if (method === 'inbox.read') {
      const ids = new Set(params.ids);
      state.inbox = state.inbox.filter(item => !ids.has(item.id));
      return null;
    }
    if (method === 'delegation.decide') { decideAcceptance(params); return { delegationId: params.delegationId, acceptance: params.decision === 'accept' ? 'accepted' : 'sent_back' }; }
    if (method === 'chat.answer') { settleInbox('kid-q', 'q1'); return null; }
    if (method === 'chat.approve') {
      if (state.rejectApproval) { const error = new Error('approval_expired'); error.code = 'approval_expired'; throw error; }
      settleInbox('lonely', 'a1');
      return null;
    }
    if (method === 'session.create') {
      const created = session('created-goal', params.provider, '2026-11-02T10:00:00Z', { title: params.title });
      state.sessions = [...state.sessions, created];
      state.created.push(created);
      return created;
    }
    if (method === 'chat.connect') return { sessionId: params.sessionId, phase: 'connected' };
    if (method === 'chat.send') return { turnId: 'turn-created' };
    if (method === 'settings.update') return {};
    throw new Error('Unexpected fixture RPC ' + method);
  }
};

const root = createRoot(document.getElementById('root'));
const render = () => {
  document.documentElement.lang = state.locale;
  document.documentElement.dataset.theme = state.theme;
  const data = { epoch: 'operator-inbox-fixture', revision: state.calls.length + 1, projects: [project], sessions: state.sessions, settings: { revision: 1, language: state.locale }, workspaces: [], inbox: state.inbox, providers };
  const inbox = <InboxPage
    data={data}
    onSession={id => { state.opened.push(id); render(); }}
    onRead={() => render()}
    onCreate={() => {}}
    supervision={{ enabled: false, rangeMinutes: 15, threshold: 3 }}
    onSupervision={async () => {}}
    supervisionAlerts={new Map()}
  />;
  const chat = <ChatView session={{ ...session('goal-a', 'claude', '2026-11-02T09:45:00Z'), readOnly: true }} />;
  root.render(<I18nProvider locale={state.locale}>{state.view === 'chat' ? chat : inbox}</I18nProvider>);
};

window.qaInbox = {
  configure(next) { state.locale = next.locale ?? state.locale; state.theme = next.theme ?? state.theme; state.view = next.view ?? state.view; render(); },
  clear() {
    state.inbox = [];
    state.sessions = state.sessions.map(item => item.delegation && item.delegation.state === 'completed' ? { ...item, delegation: { ...item.delegation, acceptance: 'accepted' } } : item);
    render();
  },
  allowApproval() { state.rejectApproval = false; render(); },
  calls() { return state.calls; },
  opened() { return state.opened; },
  count(method) { return state.calls.filter(entry => entry.method === method).length; }
};
render();
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{overflow:auto}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app, page, releaseLock;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const shot = async (name) => { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); };
const calls = () => page.evaluate(() => window.qaInbox.calls());
const decisions = async () => (await calls()).filter(entry => entry.method === 'delegation.decide');

try {
  releaseLock = await acquireElectronQaLock({ directory: qaTemp });
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], cwd: resolve('.'), timeout: 20_000 });
  page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(10_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  // ── Grouping, decisions, acceptance, notices ──
  await page.getByRole('heading', { name: /Inbox/ }).waitFor();
  const goalIds = await page.locator('.goal[data-goal-id]').evaluateAll(nodes => nodes.map(node => node.dataset.goalId));
  assert.deepEqual(goalIds, ['goal-a', 'goal-b'], 'the goal with a pending decision comes first');
  assert.equal(await page.locator('.fchip').count(), 0, 'the type filter chips are gone');
  assert.equal(await page.locator('.page-title .count').innerText(), '6', 'the header counts every pending item');
  assert.match(await page.locator('.page-sub').innerText(), /decisions and acceptance/i);
  assert.equal(await page.locator('[data-inbox-item="kid-q:approval:q1"] .chat-question-wrapper').count(), 1, 'the child question is an inline card');
  assert.equal(await page.locator('[data-goal-id="goal-a"] [data-accept-id]').count(), 2, 'both finished children wait for acceptance');
  assert.match(await page.locator('[data-goal-id="goal-a"] .items-bar').innerText(), /Accept all \(2\)/, 'two acceptance rows offer the bulk action');
  const evidence = await page.locator('[data-accept-id="kid-ok"] .acc-ev').innerText();
  assert.match(evidence, /Run record/);
  assert.match(evidence, /npm run typecheck/);
  assert.match(evidence, /cargo test --lib chat_projection/);
  assert.match(evidence, /→ 0/, 'a known exit code is shown');
  assert.match(await page.locator('[data-accept-id="kid-back"] .acc-ev').innerText(), /npm run check:fast/, 'only the last two commands of the turn are listed');
  assert.equal(await page.locator('[data-accept-id="kid-back"] .proof.warn').count(), 1, 'a failed command turns the run-record chip amber');
  assert.match(await page.locator('[data-goal-id="goal-a"] .chip-br').innerText(), /main/, 'the branch chip comes from the project catalog');
  assert.match(await page.locator('[data-goal-id="goal-a"] .goal-act').innerText(), /kid-run Running/, 'the activity line names the newest child change with its state');
  const notice = await page.locator('[data-inbox-item="goal-b:autowake_exhausted:x"]').innerText();
  assert.match(notice, /Auto-wake paused/, 'the new kind has its own label');
  assert.equal(await page.locator('.other-goal [data-inbox-item="lonely:approval:a1"]').count(), 1, 'a decision outside any goal lands in 其他会话');
  assert.match(await page.locator('.other-goal .goal-head').innerText(), /Other sessions/);
  report.checks.push('grouping, order, decision cards, acceptance rows, run records, branch chip, notices and 其他会话');

  await shot('en-light-page.png');
  await page.locator('[data-goal-id="goal-a"] .it.decide').screenshot({ path: join(out, 'en-light-decision.png'), animations: 'disabled' });
  report.screenshots.push('en-light-decision.png');
  await page.evaluate(() => window.qaInbox.configure({ locale: 'zh-CN', theme: 'dark' }));
  await page.getByRole('heading', { name: /待处理/ }).waitFor();
  assert.match(await page.locator('.page-sub').innerText(), /只放两类事/);
  assert.equal(await page.locator('.page-title .count').innerText(), '6');
  assert.match(await page.locator('[data-inbox-item="goal-b:autowake_exhausted:x"]').innerText(), /不再自动叫醒/);
  assert.equal(await page.locator('[data-accept-id="kid-ok"] .proof').innerText(), '运行记录');
  await shot('zh-dark-page.png');
  await page.evaluate(() => window.qaInbox.configure({ locale: 'en', theme: 'light' }));
  await page.getByRole('heading', { name: /Inbox/ }).waitFor();
  report.checks.push('light/English and dark/Chinese render the same page');

  // ── 打回 needs a note ──
  await page.locator('[data-accept-id="kid-back"]').getByRole('button', { name: 'Send back' }).click();
  const back = page.locator('[data-accept-id="kid-back"] .acc-back');
  await back.waitFor();
  assert.equal(await back.getByRole('button', { name: 'Send back' }).isDisabled(), true, 'an empty note cannot be sent');
  await shot('en-light-send-back.png');
  await back.getByLabel('Why send it back').fill('The lint failure needs a fix before I accept this.');
  await back.getByRole('button', { name: 'Send back' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-accept-id="kid-back"]'));
  const backCall = (await decisions()).at(-1);
  assert.equal(backCall.params.decision, 'send_back');
  assert.equal(backCall.params.note, 'The lint failure needs a fix before I accept this.');
  assert.ok(backCall.params.delegationId.startsWith('del-'), 'the decision names the delegation, not the session');
  assert.match(await page.locator('[data-goal-id="goal-b"] .donebar').innerText(), /Handled 1/, 'the processed count follows the decision');
  report.checks.push('send back requires a note, records one delegation decision and increases 已处理');

  // ── Inline answer ──
  const question = page.locator('[data-inbox-item="kid-q:approval:q1"]');
  await question.getByRole('radio', { name: /Detect per screen/ }).check();
  await question.getByRole('button', { name: 'Submit' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-inbox-item="kid-q:approval:q1"]'));
  const answer = (await calls()).filter(entry => entry.method === 'chat.answer').at(-1);

  assert.equal(answer.params.sessionId, 'kid-q');
  assert.equal(answer.params.approvalId, 'q1');
  assert.equal(answer.params.turnId, 'turn-q');
  assert.equal(answer.params.leaseEpoch, 1);
  assert.equal(answer.params.response.action, 'submit');
  assert.deepEqual(answer.params.response.values, { approach: ['Detect per screen'] });
  report.checks.push('a question is answered inline with chat.answer under the user lease');

  // ── A refused approval stays inline with 打开会话 ──
  await page.locator('.other-goal').getByRole('button', { name: 'Allow once' }).click();
  const failure = page.locator('[data-failure="lonely:approval:a1"]');
  await failure.waitFor();
  assert.match(await failure.innerText(), /approval_expired/);
  await failure.getByRole('button', { name: 'Open session' }).click();
  assert.deepEqual(await page.evaluate(() => window.qaInbox.opened()), ['lonely'], 'the failure offers the session');
  const approveCall = (await calls()).filter(entry => entry.method === 'chat.approve').at(-1);
  assert.equal(approveCall.params.sessionId, 'lonely');
  assert.equal(approveCall.params.choiceId, 'allow');
  assert.equal(approveCall.params.leaseEpoch, 1);
  assert.equal(await page.evaluate(() => window.qaInbox.count('session.claim')), 2, 'one claim per inline session');
  assert.equal(await page.evaluate(() => window.qaInbox.count('session.release')), 2, 'a failed answer still hands control back');
  report.checks.push('a rejected approval shows the error inline with 打开会话, and its lease is released');

  // ── 全部接受 ──
  const before = (await decisions()).length;
  await page.locator('[data-goal-id="goal-a"] .items-bar').getByRole('button', { name: 'Accept all (2)' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-goal-id="goal-a"] [data-accept-id]').length === 0);
  const bulk = (await decisions()).slice(before);
  assert.deepEqual(bulk.map(entry => [entry.params.decision, entry.params.delegationId]), [['accept', 'del-kid-ok'], ['accept', 'del-kid-ok2']], 'one accept per row, in order');
  assert.match(await page.locator('[data-goal-id="goal-a"] .donebar').innerText(), /Handled 2/);
  await page.waitForFunction(() => document.querySelectorAll('[data-goal-id="goal-a"] [data-accept-id]').length === 0);
  assert.equal(await page.locator('.page-title .count').innerText(), '2', 'the notice and the refused approval are still pending');
  await shot('en-light-after-accept-all.png');

  // ── Empty state ──
  await page.evaluate(() => window.qaInbox.clear());
  await page.getByText('Nothing needs you right now').waitFor();
  assert.match(await page.locator('.calm').innerText(), /Nothing needs you right now/);
  assert.equal(await page.locator('.page-title .count').count(), 0, 'an empty list shows no count');
  await shot('en-light-empty.png');
  report.checks.push('accept all decides every row and the empty state replaces the list');

  // ── Composer (R16): create, connect, send, and keep the new goal on the page ──
  await page.getByLabel('New goal').fill('Make the island follow the full-screen window');
  await page.getByRole('button', { name: 'Send goal' }).click();
  await page.locator('[data-goal-id="created-goal"]').waitFor();
  const sendOrder = (await calls()).filter(entry => ['session.create', 'chat.connect', 'chat.send'].includes(entry.method)).map(entry => entry.method);
  assert.deepEqual(sendOrder, ['session.create', 'chat.connect', 'chat.send'], 'create, connect, then send');
  const created = (await calls()).find(entry => entry.method === 'session.create').params;
  assert.equal(created.cwd, 'D:/qa/threadterm', 'the goal opens in the project folder');
  assert.equal(created.mode, 'chat');
  assert.equal(created.title, 'Make the island follow the full-screen window');
  const sent = (await calls()).find(entry => entry.method === 'chat.send').params;
  assert.equal(sent.text, 'Make the island follow the full-screen window');
  assert.equal(sent.leaseEpoch, 1);
  assert.match(await page.locator('[data-goal-id="created-goal"] .prog').innerText(), /Just started/, 'the new goal is visible before its first subtask');
  assert.equal(await page.getByLabel('New goal').inputValue(), '', 'the composer clears after sending');
  assert.equal(await page.evaluate(() => window.qaInbox.count('session.claim')), 3);
  assert.equal(await page.evaluate(() => window.qaInbox.count('session.release')), 3);
  report.checks.push('the composer creates the goal chat, connects, sends the text and keeps the new goal visible');

  // ── R14: the automatic row in Chat ──
  const inboxClaims = (await calls()).filter(entry => entry.method === 'session.claim').length;
  const inboxReleases = (await calls()).filter(entry => entry.method === 'session.release').length;
  assert.equal(inboxClaims, inboxReleases, 'every inline decision and the composer hand their session claim back');
  await page.evaluate(() => window.qaInbox.configure({ view: 'chat' }));
  const auto = page.getByTestId('chat-automatic-row');
  await auto.waitFor();
  assert.equal(await page.locator('article.v3-chat-message.user').count(), 1, 'the automatic message is not drawn as a user bubble');
  assert.match(await auto.innerText(), /Automatic update/);
  assert.match(await auto.innerText(), /Fix chat history restore" finished/);
  assert.match(await auto.innerText(), /2 more/);
  const collapsedText = await auto.innerText();
  assert.doesNotMatch(collapsedText, /delegate_|requestId|del-a|ThreadTerm\]|Handle these/, 'no model-facing text reaches the user');
  assert.equal(await auto.getByRole('button').getAttribute('aria-expanded'), 'false');
  await shot('en-light-chat-automatic-collapsed.png');
  await auto.getByRole('button').click();
  const lines = auto.locator('.chat-auto-line');
  await lines.first().waitFor();
  assert.equal(await lines.count(), 3, 'every update line is listed');
  const expanded = await auto.innerText();
  assert.match(expanded, /asks: Which screen should the island follow\?/);
  assert.match(expanded, /12 min/, 'the quiet update keeps its minutes');
  assert.doesNotMatch(expanded, /delegate_|requestId|del-a/, 'expanded lines stay human-readable');
  assert.equal(await auto.locator('.agent-tile').count(), 3, 'each known agent gets its tile');
  assert.equal(await auto.getByRole('button').getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.qaInbox.configure({ locale: 'zh-CN', theme: 'dark' }));
  await page.getByTestId('chat-automatic-row').getByRole('button').click();
  await page.getByTestId('chat-automatic-row').getByRole('button').click();
  assert.match(await page.getByTestId('chat-automatic-row').innerText(), /自动唤醒/);
  await shot('zh-dark-chat-automatic-expanded.png');
  await page.getByTestId('chat-automatic-row').getByRole('button').click();
  assert.match(await page.getByTestId('chat-automatic-row').innerText(), /等 2 条/);
  assert.match(await page.locator('[data-testid="chat-automatic-row"] .chat-auto-text').innerText(), /「Fix chat history restore」已完成/);
  await shot('zh-dark-chat-automatic-collapsed.png');
  report.checks.push('an automatic message renders as the system row, collapsed and expanded, without model-facing text');

  assert.deepEqual(errors, [], 'fixture has no renderer errors');
  // Leaving Chat releases the lease it took while it was on screen.
  await page.evaluate(() => window.qaInbox.configure({ view: 'inbox' }));
  await page.waitForTimeout(100);
  const claims = (await calls()).filter(entry => entry.method === 'session.claim').length;
  const releases = (await calls()).filter(entry => entry.method === 'session.release').length;
  assert.equal(claims, releases, 'every session.claim is matched by a session.release');
  report.checks.push('every session claim is matched by a release');
  report.passed = true;
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); report.screenshots.push('failure.png'); }
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await releaseLock?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const scratchRelative = relative(qaTemp, scratch);
  if (scratchRelative && !scratchRelative.startsWith('..') && !isAbsolute(scratchRelative)) await rm(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
