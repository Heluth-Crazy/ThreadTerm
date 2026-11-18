// Visual QA for the Chat overview (variant A): the docked card beside the message
// column, the header button and its popover, folding, plan and changes.
// Hidden Electron window with fixtures only: no runtime, no agent CLIs.
//   node qa/chat-overview-visual.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'qa/results/chat-overview');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-overview-'));

const entry = String.raw`
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ChatOverview } from './renderer/src/components/ChatOverview';
import { ChatMessageNavigation } from './renderer/src/components/ChatMessageNavigation';
import { SessionSurfaceContext } from './renderer/src/components/SessionSurfaceContext';
import './renderer/src/styles.css';

const now = Date.now();
const iso = minutes => new Date(now - minutes * 60000).toISOString();
const session = (id, provider, title, state, minutes, extra = {}) => ({
  id, provider, title, mode: 'chat', status: state === 'running' ? 'running' : state === 'awaiting_user' ? 'waiting' : 'exited',
  createdAt: iso(minutes), updatedAt: iso(minutes), projectId: 'p', worktreePath: 'D:/qa/chat-overview',
  delegation: { id: 'd-' + id, parentSessionId: 'parent', workspace: 'shared', state, ...extra },
});
const parent = { id: 'parent', provider: 'codex', title: 'Office preview spike', mode: 'chat', status: 'running', createdAt: iso(120), updatedAt: iso(1), projectId: 'p' };
const delegates = [
  session('need', 'codex', 'Review sheet core edge cases', 'awaiting_user', 50, { outcome: 'Needs a decision on the cell merge.' }),
  session('quiet', 'pi', 'Spike B: docx-preview sandbox', 'running', 40, { lastActivityAt: iso(18) }),
  session('run', 'pi', 'Spike A+C: calamine in WebAssembly', 'running', 38),
  session('done1', 'claude', 'Update validation.md', 'completed', 70, { outcome: 'Merged to the spike branch.' }),
  session('done2', 'kimi', 'Check external-files spec', 'completed', 80),
  session('failed', 'codex', 'Read features.xlsx', 'failed', 90, { outcome: 'openpyxl is not installed.', branch: 'feat/office-fixtures' }),
];
const text = value => ({ type: 'text', text: value });
const plan = { type: 'plan', data: { explanation: 'The agent wrote this plan before editing.', entries: [
  { content: 'Map the existing chat projection', status: 'completed' },
  { content: 'Add the additive plan part to every adapter', status: 'completed' },
  { content: 'Build the overview card', status: 'in_progress', priority: 'high' },
  { content: 'Dock it beside the message column', status: 'pending' },
  { content: 'Run the regression suite', status: 'pending', priority: 'low' },
] } };
const messages = Array.from({ length: 10 }, (_, index) => 'Message ' + (index + 1) + ': the office preview spike is moving; the delegate found the sheet core edge cases and is waiting for a decision on the merged cells.');
const items = [
  { id: 'u1', role: 'user', createdAt: iso(100), parts: [text(messages[0])] },
  { id: 'a1', role: 'assistant', createdAt: iso(99), parts: [text(messages[1])] },
  { id: 'u2', role: 'user', createdAt: iso(90), parts: [text(messages[2])] },
  { id: 'a2', role: 'assistant', createdAt: iso(89), parts: [text(messages[3])], turnReview: { from: 'a', to: 'b', fileCount: 7 } },
  { id: 'u3', role: 'user', createdAt: iso(80), parts: [text(messages[4])] },
  { id: 'p1', role: 'assistant', createdAt: iso(79), parts: [plan] },
];

function ChatFrame({ locale, docked, project }) {
  const zh = locale === 'zh-CN';
  const copy = (en, cn) => zh ? cn : en;
  const [host, setHost] = React.useState(null);
  const surface = { primaryHost: host, menuHost: null, focused: true };
  // Case 2: a session without a project has no branch row to load.
  const current = project ? parent : { ...parent, projectId: undefined };
  return <div className="qa-app">
    <header className="qa-top">
      <span className="qa-brand">ThreadTerm</span><span className="qa-title">Office preview spike</span><span className="qa-spacer" />
      <div className="qa-actions" ref={setHost} />
    </header>
    <div className="qa-body"><section className="chat-view v3-session-chat qa-chat">
      <SessionSurfaceContext.Provider value={surface}>
        <div className="chat-log-shell qa-log-shell">
          <ChatOverview session={current} delegates={delegates} items={items} copy={copy} zh={zh} docked={docked}
            onOpenSession={() => {}}
            navigation={<ChatMessageNavigation items={items} copy={copy} onNavigate={() => {}} />} />
          <div className="chat-scroll qa-scroll" data-qa-scroll>
            <div className="qa-messages">{messages.map((message, index) => <p className={'qa-message' + (index % 3 === 0 ? ' is-user' : '')} key={index}>{message}</p>)}</div>
          </div>
        </div>
      </SessionSurfaceContext.Provider>
      <form className="chat-compose-shell qa-compose" onSubmit={event => event.preventDefault()}><div className="qa-compose-text">Ask the agent…</div></form>
    </section></div>
  </div>;
}

// R2 fixtures: the four RPCs the changes section reads. The session row compares the oldest ready
// checkpoint (cp-old) with the current files: 4 files, +120 -12, with one binary file counting no lines.
const reviewFiles = [
  { path: 'renderer/src/chatOverview.ts', status: 'M', added: 60, removed: 4 },
  { path: 'renderer/src/components/ChatOverview.tsx', status: 'M', added: 40, removed: 8 },
  { path: 'renderer/src/components/chat-overview.css', status: 'M', added: 20, removed: 0 },
  { path: 'qa/logo.png', status: 'A', binary: true },
];
// The branch row: 3 files, +30 -5, the same sums Source Control's branch scope shows.
const compareFiles = [
  { path: 'renderer/src/chatOverview.ts', status: 'modified', additions: 18, deletions: 3, binary: false },
  { path: 'runtime/src/providers/codex.rs', status: 'modified', additions: 12, deletions: 2, binary: false },
  { path: 'docs/overview.md', status: 'added', additions: 0, deletions: 0, binary: false },
];
const oid = letter => letter.repeat(40);
const fixtureRpc = () => ({
  'review.list': () => ({ available: true, projectId: 'p', worktreePath: 'D:/qa/chat-overview', checkpoints: [
    { id: 'cp-new', sessionId: parent.id, kind: 'turn', turnId: 't9', createdAt: iso(20), status: 'ready', skipped: [] },
    { id: 'cp-old', sessionId: parent.id, kind: 'launch', createdAt: iso(110), status: 'ready', skipped: [] },
  ] }),
  'review.changes': params => ({ files: params.from === 'cp-old' ? reviewFiles : [] }),
  'git.status': () => ({ branch: 'feat/office-preview', upstream: 'origin/feat/office-preview', ahead: 2, behind: 0, changes: [] }),
  'git.compare.files': () => ({ base: { ref: 'main', oid: oid('a') }, mergeBase: oid('a'), head: oid('b'), files: compareFiles, truncated: false }),
});

window.qaRpcLog = [];
window.qaEvents = [];
addEventListener('threadterm:workbench', event => window.qaEvents.push(event.detail));
window.qaRpc = fixtureRpc();
// A case swaps answers (or throws from them); the next render reads the new table.
window.qaSetRpc = (overrides = {}) => { window.qaRpc = Object.assign(fixtureRpc(), overrides); };
window.threadterm = {
  onEvent: () => () => {},
  request: async (method, params) => {
    window.qaRpcLog.push({ method, params });
    const answer = window.qaRpc[method];
    if (typeof answer !== 'function') throw Error('Unexpected ' + method);
    return JSON.parse(JSON.stringify(answer(params)));
  },
  browserCommand: async () => ({}),
};
const root = createRoot(document.getElementById('root'));
let renders = 0;
window.qaRender = ({ locale = 'en', theme = 'light', docked = false, project = true } = {}) => {
  document.documentElement.lang = locale;
  document.documentElement.dataset.theme = theme;
  flushSync(() => root.render(<ChatFrame key={++renders} locale={locale} docked={docked} project={project} />));
};
window.qaRender();
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{height:100%}.qa-app{height:100%;display:flex;flex-direction:column;background:var(--bg)}.qa-top{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--border);position:relative;z-index:10;flex:none}.qa-brand{font-weight:600}.qa-title{color:var(--muted)}.qa-spacer{flex:1}.qa-actions{display:flex;align-items:center;gap:2px;position:relative}.qa-body{flex:1;min-height:0;display:flex}.qa-chat{flex:1;min-width:0;display:flex;flex-direction:column;height:100%}.qa-log-shell{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}.qa-scroll{flex:1;min-height:0;overflow-y:auto;padding:24px max(24px, calc((100% - 920px) / 2));padding-right:max(52px, calc((100% - 920px) / 2))}.qa-messages{max-width:920px}.qa-message{margin:0 0 18px;font-size:14px;line-height:1.6;color:var(--text)}.qa-message.is-user{margin-left:auto;max-width:78%;width:fit-content;padding:9px 14px;border-radius:16px;background:var(--soft)}.qa-compose{margin:8px max(16px, calc((100% - 920px) / 2)) 16px;height:84px;border:1px solid var(--border);border-radius:20px;background:var(--surface);padding:12px}.qa-compose-text{color:var(--faint)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1680,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const report = { passed: false, screenshots: [], checks: [], errors: [], consoleErrors: [] };
let app, page;
const shot = async (name) => { await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`); };
const setSize = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await page.setViewportSize({ width, height });
};
const render = async ({ locale, theme, docked, project }) => {
  await page.evaluate(next => window.qaRender(next), { locale, theme, docked, project });
  await page.waitForTimeout(250);
};
const rect = (locator) => locator.evaluate(node => { const value = node.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; });
const noOverlap = async (card, messages) => {
  const box = await rect(card);
  const boxes = await messages.evaluateAll(nodes => nodes.map(node => { const value = node.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }; }));
  return boxes.every(message => box.right <= message.left + 1 || box.left >= message.right - 1 || box.bottom <= message.top + 1 || box.top >= message.bottom - 1);
};

try {
  await mkdir(out, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = [join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
  app = await electron.launch({ args: ['--disable-gpu', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof window.qaRender === 'function');

  // Wide: the card docks in the empty gutter right of the message column.
  await setSize(1680, 900);
  await render({ locale: 'en', theme: 'light', docked: true });
  const dock = page.locator('.chat-overview-dock');
  await dock.waitFor();
  assert.equal(await page.locator('.chat-overview-button').count(), 0, 'docked mode shows the card, not the header button');
  const sections = dock.locator('.chat-overview-section');
  assert.equal(await sections.count(), 3, 'delegates, changes and plan sections');
  for (const section of await sections.all()) assert.ok((await section.innerText()).trim().length > 0, 'no empty section');
  const activeRows = dock.locator('.chat-overview-row');
  assert.equal(await activeRows.count(), 3, 'needs you, quiet and running above the fold');
  assert.match(await dock.innerText(), /No activity for 18 min/);
  // R6: the sentence reads in full, not as "No activity for 1…".
  const quietLabel = dock.locator('.chat-overview-row.is-quiet .delegate-quiet');
  assert.equal(await quietLabel.count(), 1, 'the quiet row labels its silence');
  assert.equal(await quietLabel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'the quiet label is not truncated');
  assert.match(await activeRows.filter({ hasText: 'Spike A+C' }).innerText(), /Running · 38 min/);
  assert.match(await dock.innerText(), /3 finished/);
  assert.match(await dock.innerText(), /1 failed/);
  assert.match(await dock.innerText(), /2\/5 · Now: Build the overview card/);
  // R1/R2: the replaced single "7 files" row is two rows, each with its own stat and the head above.
  const changeRows = page.locator('.chat-overview-change');
  assert.equal(await changeRows.count(), 2, 'a session row and a branch row');
  const MINUS = '\u2212';
  const rowStat = async locator => ({
    label: await locator.getAttribute('aria-label'),
    files: (await locator.locator('.chat-overview-stat-files').innerText()).trim(),
    added: (await locator.locator('.chat-overview-stat-add').innerText()).trim(),
    removed: (await locator.locator('.chat-overview-stat-del').innerText()).trim(),
  });
  assert.deepEqual(await rowStat(page.locator('.chat-overview-change.is-session')), {
    label: 'This session: 4 files, 120 added, 12 removed', files: '4 files', added: '+120', removed: `${MINUS}12`,
  }, 'the session row compares the oldest ready checkpoint; the binary file adds no lines');
  assert.deepEqual(await rowStat(page.locator('.chat-overview-change.is-branch')), {
    label: 'Current branch: 3 files, 30 added, 5 removed', files: '3 files', added: '+30', removed: `${MINUS}5`,
  }, 'the branch row sums git.compare.files');
  const branchName = page.locator('.chat-overview-branch-name');
  assert.equal((await branchName.innerText()).trim(), 'feat/office-preview', 'the head names the checked-out branch');
  assert.equal(await branchName.getAttribute('title'),
    'feat/office-preview compared with main, uncommitted changes included', 'the head is titled with the base');
  assert.equal(await page.locator('.chat-plan-sticky').count(), 0, 'the sticky plan chip is gone');
  assert.equal(await page.locator('.delegation-strip').count(), 0, 'the delegation strip is gone');
  assert.equal(await page.locator('.qa-scroll > .qa-messages > :first-child').evaluate(node => node.className.includes('qa-message')), true, 'the first transcript element is a message');
  assert.equal(await noOverlap(dock, page.locator('.qa-message')), true, 'the docked card never covers a message');
  const rowHeights = await activeRows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.deepEqual(rowHeights.map(value => Math.round(value)), [28, 28, 28], 'delegate rows are one line');
  await shot('chat-overview-en-light-docked');

  const dockTopBeforeScroll = (await rect(dock)).top;
  await page.locator('.qa-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(120);
  assert.equal(await noOverlap(dock, page.locator('.qa-message')), true, 'scrolling does not put the card over a message');
  assert.equal((await rect(dock)).top, dockTopBeforeScroll, 'the card stays in the gutter while the transcript scrolls');

  await render({ locale: 'zh-CN', theme: 'dark', docked: true });
  await dock.waitFor();
  assert.match(await dock.innerText(), /无活动 18 分钟/);
  assert.match(await dock.innerText(), /3 个已结束/);
  assert.match(await dock.innerText(), /2\/5 · 当前：Build the overview card/);
  assert.match(await dock.innerText(), /\u672c\u4f1a\u8bdd/);
  assert.match(await dock.innerText(), /\u5f53\u524d\u5206\u652f/);
  await shot('chat-overview-zh-dark-docked');

  // Manual collapse stays a button; the button expands the card again.
  await page.locator('.chat-overview-collapse').evaluate(node => node.click());
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-button').count(), 1, 'collapsing leaves the header button');
  assert.equal(await page.locator('.chat-overview-dock').count(), 0, 'collapsed card is not docked');
  await page.locator('.chat-overview-button').evaluate(node => node.click());
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-dock').count(), 1, 'clicking the collapsed button restores the docked card');
  report.checks.push('dock, no strip/plan chip, one-line rows, sections, no overlap while scrolling, collapse/expand');

  // Folding the finished delegates is remembered for this parent.
  const fold = page.locator('.chat-overview-fold-button');
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  await fold.evaluate(node => node.click());
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-row').count(), 6, 'expanded fold shows all finished rows');
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  await render({ locale: 'en', theme: 'light', docked: true });
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-fold-button').getAttribute('aria-expanded'), 'true', 'the finished fold is remembered per parent');
  await page.locator('.chat-overview-fold-button').evaluate(node => node.click());
  report.checks.push('finished fold expands, remembers per parent and collapses again');

  // Narrow: the header button opens the same card as a popover below it.
  await setSize(900, 900);
  await render({ locale: 'en', theme: 'light', docked: false });
  const button = page.locator('.chat-overview-button');
  await button.waitFor();
  assert.equal(await page.locator('.chat-overview-dock').count(), 0);
  await button.evaluate(node => node.click());
  const popover = page.locator('.chat-overview-popover');
  await popover.waitFor();
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  const buttonBox = await rect(button), popoverBox = await rect(popover), composerBox = await rect(page.locator('.qa-compose'));
  assert.ok(popoverBox.top >= buttonBox.bottom, 'the popover opens below the button');
  assert.ok(popoverBox.bottom <= composerBox.top + 1, `the popover never covers the composer: ${JSON.stringify({ popoverBox, composerBox })}`);
  assert.equal(await popover.locator('.chat-overview-section').count(), 3);
  await shot('chat-overview-en-light-popover');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-popover').count(), 0, 'Escape closes the popover');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-overview-button')), true, 'Escape returns focus to the button');
  await button.evaluate(node => node.click());
  await page.locator('.qa-top').evaluate(node => node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.chat-overview-popover').count(), 0, 'outside click closes the popover');

  await render({ locale: 'zh-CN', theme: 'dark', docked: false });
  await page.locator('.chat-overview-button').evaluate(node => node.click());
  await page.locator('.chat-overview-popover').waitFor();
  assert.match(await page.locator('.chat-overview-popover').innerText(), /委派的代理/);
  await shot('chat-overview-zh-dark-popover');
  report.checks.push('narrow button, popover below it, no composer overlap, Esc/outside close with focus return, both languages');

  // Part C cases 1-3: the same RPCs drive both rows; a session without a project has no branch row,
  // and a branch that is its own base shows the uncommitted wording.
  await setSize(1680, 900);
  const caseDock = page.locator('.chat-overview-dock');
  const sessionRow = page.locator('.chat-overview-change.is-session');
  const branchRow = page.locator('.chat-overview-change.is-branch');
  const settle = async method => {
    await page.waitForFunction(name => window.qaRpcLog.some(entry => entry.method === name), method, { timeout: 4000 });
    await page.waitForTimeout(120);
  };

  await page.evaluate(() => window.qaSetRpc());
  await render({ locale: 'en', theme: 'light', docked: true });
  await settle('git.compare.files');
  assert.equal(await changeRows.count(), 2, 'case 1: both rows show');
  await shot('chat-overview-changes-both-light');
  await render({ locale: 'en', theme: 'dark', docked: true });
  await settle('git.compare.files');
  assert.equal(await changeRows.count(), 2, 'case 1: both rows show in the dark theme too');
  await shot('chat-overview-changes-both-dark');

  await page.evaluate(() => { window.qaRpcLog.length = 0; window.qaSetRpc(); });
  await render({ locale: 'en', theme: 'light', docked: true, project: false });
  await settle('review.changes');
  assert.equal(await sessionRow.count(), 1, 'case 2: the session row still shows without a project');
  assert.equal(await branchRow.count(), 0, 'case 2: no project means no branch row');
  assert.equal((await page.evaluate(() => window.qaRpcLog.filter(entry => entry.method.startsWith('git.')).length)), 0,
    'case 2: and no git RPC at all');
  await shot('chat-overview-changes-session-only-light');

  await page.evaluate(() => window.qaSetRpc({
    'git.status': () => ({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] }),
    'git.compare.files': () => ({ base: { ref: 'main', oid: 'a'.repeat(40) }, mergeBase: 'a'.repeat(40), head: 'b'.repeat(40), files: [{ path: 'docs/overview.md', status: 'modified', additions: 9, deletions: 2, binary: false }], truncated: false }),
  }));
  await render({ locale: 'en', theme: 'dark', docked: true });
  await settle('git.compare.files');
  assert.equal((await branchName.innerText()).trim(), `main ${'\u00b7'} uncommitted`,
    'case 3: working on the base itself shows the uncommitted head');
  assert.equal(await branchName.getAttribute('title'), 'main compared with main, uncommitted changes included');
  await shot('chat-overview-changes-uncommitted-dark');

  // Case 4: every changes RPC rejects. The section disappears and nothing reaches the console.
  const consoleBefore = report.consoleErrors.length;
  await page.evaluate(() => {
    const fail = () => { throw Error('changes unavailable'); };
    window.qaSetRpc({ 'review.list': fail, 'review.changes': fail, 'git.status': fail, 'git.compare.files': fail });
  });
  await render({ locale: 'en', theme: 'light', docked: true });
  await settle('git.compare.files');
  await page.waitForTimeout(150);
  assert.equal(await changeRows.count(), 0, 'case 4: no change row survives a failure');
  assert.equal(await page.locator('.chat-overview-section[aria-label="Changes"]').count(), 0, 'case 4: no empty changes section');
  assert.equal(await page.locator('.chat-overview-section').count(), 2, 'case 4: delegates and plan remain');
  assert.equal(await caseDock.count(), 1, 'case 4: the card stays for its other sections');
  assert.deepEqual(report.consoleErrors.slice(consoleBefore), [], 'case 4: a rejected RPC logs nothing');
  await shot('chat-overview-changes-rpc-errors-light');
  report.checks.push('changes: both rows, session only without a project, uncommitted head, RPC errors hidden');

  // Case 5: the two rows ask the workbench for the right thing.
  await page.evaluate(() => { window.qaRpcLog.length = 0; window.qaSetRpc(); window.qaEvents.length = 0; });
  await render({ locale: 'en', theme: 'light', docked: true });
  await settle('git.compare.files');
  await sessionRow.evaluate(node => node.click());
  await page.waitForTimeout(80);
  await branchRow.evaluate(node => node.click());
  await page.waitForTimeout(80);
  const events = await page.evaluate(() => window.qaEvents);
  assert.equal(events.filter(event => event.view === 'changes').length, 1, 'case 5: the session row opens Agent Changes once');
  assert.equal(events.filter(event => event.view === 'scm').length, 1, 'case 5: the branch row opens Source Control once');
  const scm = events.find(event => event.view === 'scm');
  assert.equal(scm.scope, 'branch', 'case 5: Source Control opens in the branch scope');
  assert.equal(scm.action, undefined, 'case 5: the branch row runs no git action');
  assert.equal(typeof scm.key, 'string', 'case 5: the command carries a key');
  report.checks.push('changes: session row opens Agent Changes, branch row requests the branch scope');

  assert.deepEqual(report.consoleErrors, [], 'no renderer console errors');
  assert.deepEqual(report.errors, [], 'no renderer page errors');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(`${report.passed ? 'CHAT OVERVIEW VISUAL PASSED' : 'CHAT OVERVIEW VISUAL FAILED'} (${report.screenshots.length} shots); ${join(out, 'report.json')}`);
}
