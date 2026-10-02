// Visual check of the agent-delegation UI in the real app (task 09-30-agent-delegation):
// isolated Electron (own data, user data and pipe) on the target-qa runtime with the source
// Claude sidecar, a Claude parent Chat and real Codex delegates (their file writes ask first).
//   A) relay: a worktree delegate's file-write approval goes to Claude ("Waiting for parent agent").
//      Claude first writes a file, which needs the user's approval; this driver holds that
//      approval until the screenshots are taken, so the waiting state stays on screen.
//   B) escalation: Claude starts a delegate and ends its turn; the delegate's request becomes
//      the user's ("Needs you"), and this driver answers it in the delegate's approval card.
// Screenshots (English and zh-CN) go to qa/results/delegation-visual. The app bundle is built
// into the scratch folder, so desktop-dist stays untouched. Never sends browser-opening
// commands; removes the probe's agent history afterwards (qa/agent-history.mjs).
//   node qa/delegation-visual.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { removeAgentHistory } from './agent-history.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime)) throw Error(`Refusing non-QA runtime: ${runtime}`);
assert.ok(existsSync(join(dirname(runtime), 'threadterm-v3-mcp.exe')), 'build threadterm-v3-mcp next to the QA runtime');
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-deleg-visual-'));
const slug = basename(scratch).toLowerCase();
const workspace = join(scratch, `${basename(scratch)}-ws`);
const appDir = join(scratch, 'app');
const out = join(root, 'qa/results/delegation-visual');
const report = { passed: false, scratch, checks: [], notes: [], shots: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page;

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-delegation-qa', version: '0.1.0', main: 'main.cjs' }));
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 120000) {
  const end = Date.now() + timeout;
  for (;;) { const value = await test(); if (value) return value; if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(250); }
}
const snapshot = () => request('runtime.snapshot');
const sessionOf = async id => (await snapshot()).sessions.find(session => session.id === id);
const delegatesOf = (snap, parentId) => snap.sessions.filter(session => session.delegation?.parentSessionId === parentId);
const pendingApprovals = async sessionId => (await request('chat.read', { sessionId }))
  .flatMap(item => item.parts.filter(part => part.type === 'approval' && part.status === 'pending').map(part => ({ item, part })));
// DOM clicks: a background Electron window may not acknowledge OS-level input.
const click = locator => locator.evaluate(element => element.click());
const chat = id => page.locator(`[data-testid="session-chat-${id}"]`);
const row = id => page.locator(`.sess-row-wrap[data-session-id="${id}"]`);

async function setLanguage(language) {
  const { settings } = await snapshot();
  if (settings.language !== language) await request('settings.update', { patch: { language }, expectedRevision: settings.revision, operationId: randomUUID() });
  await page.waitForFunction(lang => document.documentElement.lang === lang, language);
  await delay(200);
}
async function setTheme(theme) {
  const { settings } = await snapshot();
  if (settings.theme !== theme) await request('settings.update', { patch: { theme }, expectedRevision: settings.revision, operationId: randomUUID() });
  await delay(300);
}
async function shot(name) {
  await page.screenshot({ path: join(out, `${name}.png`) });
  report.shots.push(`${name}.png`);
}
/** Screenshot of the current view in English and zh-CN (back to English afterwards). */
async function bothLanguages(name, verify) {
  for (const language of ['en', 'zh-CN']) {
    await setLanguage(language);
    if (verify) await verify(language);
    await shot(`${name}-${language}`);
  }
  await setLanguage('en');
}
async function openFromCatalog(id) {
  await click(row(id).locator('.sess-row'));
  await chat(id).waitFor({ timeout: 30000 });
  await delay(400);
}
async function send(sessionId, text) {
  const input = chat(sessionId).locator('.chat-compose-shell textarea');
  await until(async () => await input.count() && !(await input.isDisabled()), 'writable composer', 90000);
  await input.fill(text);
  await chat(sessionId).locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
/** Clicks the first allow choice ("Allow once") of the pending card in the visible chat. */
async function allowInCard(sessionId) {
  const button = chat(sessionId).locator('.chat-approval-card.pending .chat-approval-choice.kind-allow').first();
  await button.waitFor({ timeout: 20000 });
  await until(async () => !(await button.isDisabled()), 'approval buttons enabled', 20000);
  await click(button);
}
async function turnEnded(sessionId, previousTurn) {
  const activity = (await sessionOf(sessionId))?.activity;
  return activity?.turnId && activity.turnId !== previousTurn && (activity.state === 'idle' || activity.state === 'awaiting_input');
}
async function assertNestedUnder(parentId, childId) {
  const order = await page.locator('.sess-row-wrap').evaluateAll(rows => rows.map(row => ({ id: row.dataset.sessionId, delegate: row.classList.contains('is-delegate') })));
  const at = order.findIndex(entry => entry.id === parentId);
  const children = [];
  for (const entry of order.slice(at + 1)) { if (!entry.delegate) break; children.push(entry.id); }
  assert.ok(at >= 0 && children.includes(childId), `delegate ${childId} is nested right under its parent: ${JSON.stringify(order)}`);
}

const PREAMBLE = 'You have ThreadTerm delegation tools from the "threadterm" MCP server (delegate_start, delegate_status, delegate_wait, delegate_respond, delegate_result). This is an automated UI test: follow the steps exactly and do not do the delegated work yourself.';

async function scenarioRelay(parent) {
  const before = (await sessionOf(parent.id)).activity?.turnId;
  await send(parent.id, `${PREAMBLE}
1) Call delegate_start with agent "codex", workspace "worktree", title "Codex worktree delegate" and prompt "Create a file named delegated.txt in the current folder containing exactly DELEGATED-OK. Then reply with exactly DONE-A and nothing else."
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled.
3) When delegate_wait reports pendingRequests: FIRST use your Write tool to create the file parent-check.txt in the current folder containing exactly CHECKED (the user is asked to allow that), and only AFTER that answer each pending request with delegate_respond choosing its allow-once choice.
4) Call delegate_result and reply with the delegate's finalAnswer.`);
  let child, started = false, waited = false;
  const end = Date.now() + 12 * 60000;
  // Diagnostics: who answered what, and when (state changes only).
  const t0 = Date.now(), timeline = report.relayTimeline = [];
  const mark = text => { if (timeline.at(-1)?.text !== text) timeline.push({ at: +((Date.now() - t0) / 1000).toFixed(1), text }); };
  for (;;) {
    if (Date.now() > end) throw Error('relay scenario timed out');
    const snap = await snapshot();
    child = delegatesOf(snap, parent.id)[0] ?? child;
    const current = child && snap.sessions.find(session => session.id === child.id);
    mark(`parent=${snap.sessions.find(session => session.id === parent.id)?.activity?.state ?? '-'} delegate=${current?.delegation.state ?? '-'}`);
    if (current && !started) {
      started = true;
      await row(current.id).waitFor();
      await assertNestedUnder(parent.id, current.id);
      const chip = row(current.id).locator('.delegate-chip');
      assert.equal(await chip.locator('svg').count(), 1, 'a nested worktree delegate shows a branch icon');
      assert.equal((await chip.innerText()).trim(), '', 'a nested delegate shows no "delegate" text');
      assert.match(await chip.getAttribute('title'), /threadterm\/delegate-codex-/);
      report.delegateTitleWidth = await row(current.id).locator('.grow').evaluate(element => ({ shown: element.clientWidth, full: element.scrollWidth }));
      await page.locator(`.delegate-card[data-session-id="${current.id}"]`).waitFor();
      await bothLanguages('a1-parent-delegate-started');
      check('a delegate appears nested under its parent in the catalog (branch-icon chip), with a card in the parent chat');
    }
    const pending = await pendingApprovals(parent.id);
    for (const { part } of pending) {
      mark(`parent approval pending: ${part.approvalId} ${JSON.stringify(part.data?.title ?? '')}`);
      assert.doesNotMatch(JSON.stringify(part.data?.title ?? ''), /threadterm|delegate_/i, 'the parent is never asked about its own delegation tools');
    }
    if (current?.delegation.state === 'awaiting_parent' && !waited) {
      waited = true;
      await captureWaiting(parent, current, pending.length > 0);
    }
    // Hold the parent's own approval (the file write) while its delegate waits for it.
    const hold = current && ['starting', 'running', 'awaiting_parent'].includes(current.delegation.state) && !waited;
    if (pending.length && !hold) { mark(`driver allows ${pending[0].part.approvalId}`); await openFromCatalog(parent.id); await allowInCard(parent.id); await until(async () => !(await pendingApprovals(parent.id)).some(card => card.part.approvalId === pending[0].part.approvalId), 'parent approval answered', 30000); }
    if (await turnEnded(parent.id, before) && !(await pendingApprovals(parent.id)).length) break;
    await delay(400);
  }
  assert.ok(child, 'Claude started a delegate');
  const steps = items => items.flatMap(item => item.parts.filter(part => part.type !== 'thinking').map(part =>
    part.type === 'tool' ? `tool ${part.toolName} [${part.status ?? '-'}]`
      : part.type === 'approval' ? `approval ${part.approvalId} ${JSON.stringify(part.data?.title ?? '')} [${part.status}] ${JSON.stringify(part.data?.delegation ?? {})}`
        : `${item.role} ${part.type}: ${String(part.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}`));
  report.relayParentSteps = steps(await request('chat.read', { sessionId: parent.id }));
  report.relayDelegateSteps = steps(await request('chat.read', { sessionId: child.id }));
  const done = await sessionOf(child.id);
  assert.equal(done.delegation.state, 'completed', `delegate finished: ${done.delegation.state}`);
  assert.ok(waited, 'the delegate waited for its parent at least once');
  await openFromCatalog(parent.id);
  const card = page.locator(`.delegate-card[data-session-id="${child.id}"]`);
  await card.locator('.delegate-card-preview').waitFor({ timeout: 20000 });
  assert.match(await card.locator('.delegate-card-preview').innerText(), /DONE-A/);
  await bothLanguages('a4-parent-delegate-completed', async language => {
    assert.equal((await card.locator('.delegation-state').innerText()).trim(), language === 'en' ? 'Completed' : '已完成');
    const tools = (await chat(parent.id).locator('.codex-tool-disclosure summary').allInnerTexts()).join(' | ');
    const labels = language === 'en'
      ? ['Started a delegate', 'Waited for delegates', "Answered a delegate's request", "Read a delegate's result"]
      : ['启动了委派', '等待了委派', '答复了委派的请求', '读取了委派结果'];
    for (const label of labels) assert.ok(tools.includes(label), `delegation tool label "${label}" in: ${tools}`);
  });
  // The parent's own approval the driver allowed (Claude) is settled, not expired at turn end.
  const parentCards = report.relayParentSteps.filter(step => step.startsWith('approval '));
  if (!parentCards.length) note('Claude asked for no approval of its own this run');
  assert.ok(parentCards.every(step => step.includes('[resolved]')), `parent approvals settled: ${parentCards.join(' / ')}`);
  await click(card.locator('.delegate-card-title'));
  await chat(child.id).waitFor();
  await bothLanguages('a5-delegate-completed');
  check('completed delegate: parent card shows the answer preview; delegate chat shows its resolved approval');
  return child;
}

/** The delegate waits for its parent agent: parent view, delegate view, both languages. */
async function captureWaiting(parent, child, held) {
  if (!held) note('the parent had no pending approval of its own when the delegate waited (screenshots race the parent)');
  try {
    await openFromCatalog(parent.id);
    const card = page.locator(`.delegate-card[data-session-id="${child.id}"]`);
    await card.locator('.delegation-state.st-awaiting_parent').waitFor({ timeout: 10000 });
    assert.match(await row(child.id).locator('.sess-row').getAttribute('title'), /Waiting for parent agent/);
    await shot('a2-parent-delegate-waiting-en');
    await click(card.locator('.delegate-card-title'));
    await chat(child.id).waitFor();
    const delegated = chat(child.id).locator('.chat-approval-card.pending.is-delegated');
    await delegated.waitFor({ timeout: 15000 });
    await bothLanguages('a3-delegate-waiting', async language => {
      assert.match(await delegated.locator('.chat-approval-delegated').innerText(), language === 'en' ? /delegated this session decides/ : /由委派这个会话的代理决定/);
      assert.match(await chat(child.id).locator('.delegation-origin').innerText(), language === 'en' ? /Delegated by/ : /委派自/);
      const choice = delegated.locator('.chat-approval-choice').first();
      const [button, scope] = [await choice.boundingBox(), await choice.locator('small').boundingBox()];
      assert.ok(button && scope && scope.y + scope.height <= button.y + button.height + 0.5, `the scope line fits inside its button: ${JSON.stringify({ button, scope })}`);
    });
    await setLanguage('zh-CN');
    await click(chat(child.id).locator('.delegation-origin .delegation-link'));
    await chat(parent.id).waitFor();
    await shot('a2-parent-delegate-waiting-zh-CN');
    await setLanguage('en');
    check('awaiting_parent: catalog label, parent card state, delegated note on the delegate\'s approval card, "Delegated by" link');
  } catch (error) {
    note(`waiting-state capture incomplete: ${error.message.split('\n')[0]}`);
    await shot('a-waiting-failure').catch(() => {});
  }
}

async function scenarioEscalation(parent, first) {
  await openFromCatalog(parent.id);
  const before = (await sessionOf(parent.id)).activity?.turnId;
  await send(parent.id, `${PREAMBLE}
1) Call delegate_start with agent "codex", workspace "shared", title "Codex escalation delegate" and prompt "Create a file named escalated.txt in the current folder containing exactly ESCALATED-OK. Then reply with exactly DONE-B and nothing else."
2) Do NOT call delegate_wait or any other tool afterwards: as soon as delegate_start returns, reply with exactly STARTED and end your turn.`);
  await until(() => turnEnded(parent.id, before), 'parent turn (escalation) ended', 5 * 60000);
  const child = await until(async () => delegatesOf(await snapshot(), parent.id).find(session => session.id !== first.id), 'second delegate', 30000);
  const card = await until(async () => (await pendingApprovals(child.id))[0], 'escalated request', 5 * 60000);
  const flags = card.part.data?.delegation ?? {};
  report.escalatedCard = flags;
  note(`escalated card data.delegation = ${JSON.stringify(flags)}`);
  const state = (await sessionOf(child.id)).delegation.state;
  assert.equal(state, 'awaiting_user', `escalated delegate state: ${state}`);
  const inbox = (await snapshot()).inbox.filter(item => item.sessionId === child.id && item.kind === 'approval');
  assert.ok(inbox.length >= 1, 'the escalated request is in the Inbox');
  await openFromCatalog(parent.id);
  await page.locator(`.delegate-card[data-session-id="${child.id}"] .delegation-state.st-awaiting_user`).waitFor();
  await bothLanguages('b1-parent-delegate-needs-you');
  assert.equal(await row(child.id).locator('.delegate-chip').count(), 0, 'a nested shared delegate needs no chip');
  await openFromCatalog(child.id);
  const pending = chat(child.id).locator('.chat-approval-card.pending');
  await pending.waitFor();
  await bothLanguages('b2-delegate-escalated', async language => {
    assert.match(await pending.locator('.chat-approval-delegated').innerText(), language === 'en' ? /no longer in its turn/ : /委派方已结束当前轮次/);
  });
  await allowInCard(child.id);
  await until(async () => (await sessionOf(child.id)).delegation.state === 'completed', 'escalated delegate completed', 5 * 60000);
  await delay(800);
  await bothLanguages('b3-delegate-completed');
  await openFromCatalog(parent.id);
  await page.locator(`.delegate-card[data-session-id="${child.id}"] .delegate-card-preview`).waitFor({ timeout: 20000 });
  await bothLanguages('b4-parent-both-completed');
  await setTheme('dark');
  await shot('b5-parent-both-completed-dark-en');
  await setTheme('light');
  check('escalation: awaiting_user in parent card and catalog, Inbox entry, user answered in the delegate card, delegate completed');
}

try {
  await mkdir(out, { recursive: true });
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const dir of [workspace, join(scratch, 'data'), join(scratch, 'profile')]) await mkdir(dir, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Delegation visual QA\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, stdio: 'pipe', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'QA fixture');
  console.log('building the QA app bundle…');
  await buildApp();
  // The desktop starts the runtime outside any Claude Code session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT|THREADTERM_|ELECTRON_RUN_AS_NODE)/i.test(key)));
  Object.assign(env, {
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-deleg-visual-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_CLAUDE_SDK_HOST: join(root, 'providers/claude-sdk/src/main.mjs'),
    THREADTERM_CLAUDE_NODE: process.execPath,
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60000 });
  const { settings } = await snapshot();
  await request('settings.update', { patch: { language: 'en', theme: 'light' }, expectedRevision: settings.revision, operationId: randomUUID() });
  const project = await request('project.add', { path: workspace, name: 'Delegation visual QA', operationId: randomUUID() });
  const parent = await request('session.create', { projectId: project.id, cwd: workspace, provider: 'claude', mode: 'chat', title: 'Delegation parent (Claude)', operationId: randomUUID() });
  await request('session.present', { sessionId: parent.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat(parent.id).waitFor({ timeout: 60000 });
  const first = await scenarioRelay(parent);
  await scenarioEscalation(parent, first);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  // Closed CLIs may still be writing for a few seconds (the Claude SDK allows ~7 s on Windows).
  await delay(8000);
  report.historyLeft = removeAgentHistory(slug);
  const log = join(scratch, 'data', 'runtime.log');
  if (!report.passed && existsSync(log)) report.runtimeLogTail = readFileSync(log, 'utf8').split('\n').slice(-30);
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
  if (!report.passed) process.exitCode = 1;
}
