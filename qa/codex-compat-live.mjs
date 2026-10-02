// Real Electron + real isolated Codex app-server compatibility QA.
// Requires a renderer build and runtime/target-qa; leaves its redacted report in TEMP.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qaDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(qaDir, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'threadterm-codex-compat-live-')));
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const codexHome = join(scratch, 'codex-home');
const pipe = `\\\\.\\pipe\\threadterm-codex-compat-${randomUUID()}`;
const report = { passed: false, runtime, scratch, checks: [], observations: {} };
let app;
let page;

if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime.replace(/\\/gu, '/'))) {
  throw new Error(`Refusing non-QA runtime: ${runtime}. Set THREADTERM_V3_RUNTIME_BIN only to runtime/target-qa/debug/threadterm-v3-runtime.exe.`);
}

async function request(method, params = {}) {
  return page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
}
async function renew(sessionId, leaseEpoch) {
  return (await request('session.renew', { sessionId, leaseEpoch })).leaseEpoch;
}
async function send(text) {
  const textarea = page.locator('.chat-compose-shell textarea');
  await textarea.fill(text);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
async function priorUserIds(sessionId, command) {
  const items = await request('chat.read', { sessionId });
  return new Set(items.filter(item => item.role === 'user' && item.parts.some(part => part.text === command)).map(item => item.id));
}
async function sendCommand(sessionId, command) {
  const prior = await priorUserIds(sessionId, command);
  await send(command);
  return prior;
}
async function waitAssistant(sessionId, command, requiredText, prior = new Set(), timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const items = await request('chat.read', { sessionId });
    const user = [...items].reverse().find(item => item.role === 'user' && !prior.has(item.id) && item.parts.some(part => part.text === command));
    if (user?.turnId) {
      const assistant = items.find(item => item.role === 'assistant' && item.turnId === user.turnId && item.parts.some(part => typeof part.text === 'string' && part.text.includes(requiredText)));
      if (assistant) return assistant;
    }
    await delay(150);
  }
  const items = await request('chat.read', { sessionId });
  throw new Error(`No ${command} result containing ${JSON.stringify(requiredText)}. Transcript: ${JSON.stringify(items).slice(-3000)}`);
}
async function selectMenuItem(menu, text) {
  const choice = menu.getByRole('menuitemradio', { name: text, exact: true });
  await choice.waitFor({ timeout: 20_000 });
  await choice.click();
}
async function waitOption(sessionId, optionId, value, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ui = await request('chat.options', { sessionId });
    if (ui.options.find(option => option.id === optionId)?.value === value) return ui;
    await delay(100);
  }
  throw new Error(`Option ${optionId} did not read back ${value}`);
}
async function waitStatus(sessionId, command, prior = new Set(), timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const items = await request('chat.read', { sessionId });
    const user = [...items].reverse().find(item => item.role === 'user' && !prior.has(item.id) && item.parts.some(part => part.text === command));
    const status = user?.turnId && items.find(item => item.role === 'assistant' && item.turnId === user.turnId && item.parts.some(part => part.type === 'status' && part.data?.kind === 'status'));
    if (status) return status;
    await delay(150);
  }
  throw new Error(`No structured status result for ${command}`);
}
async function waitNativeOperation(sessionId, command, prior = new Set(), timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let user;
  while (Date.now() < deadline) {
    const items = await request('chat.read', { sessionId });
    user ??= [...items].reverse().find(item => item.role === 'user' && !prior.has(item.id) && item.parts.some(part => part.text === command));
    const snapshot = await request('runtime.snapshot');
    const session = snapshot.sessions.find(candidate => candidate.id === sessionId);
    if (user && session?.status === 'idle' && !await page.locator('.chat-first-response-wait').count()) {
      return { userTurnId: user.turnId, status: session.status, items: items.filter(item => item.turnId === user.turnId) };
    }
    if (session?.status === 'error') throw new Error(`${command} entered error state: ${JSON.stringify(items.filter(item => item.turnId === user?.turnId)).slice(-2500)}`);
    await delay(200);
  }
  throw new Error(`${command} did not complete to idle within ${timeout}ms`);
}
async function updateSettings(patch) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
}
async function waitComposeIdle(sessionId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const snapshot = await request('runtime.snapshot');
    if (snapshot.sessions.find(session => session.id === sessionId)?.status === 'idle'
        && !await page.locator('.chat-first-response-wait').count()
        && await page.locator('.chat-compose-shell').getByRole('button', { name: 'Send', exact: true }).count()) return;
    await delay(150);
  }
  throw new Error('Previous native turn did not release the composer');
}
function redact(value, key = '') {
  if (/(?:email|account)/iu.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

try {
  await Promise.all([mkdir(workspace), mkdir(data), mkdir(profile), mkdir(codexHome)]);
  const skillRoot = join(workspace, '.agents', 'skills', 'threadterm-native-probe');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: threadterm-native-probe\ndescription: Native structured skill QA marker.\n---\n\nReply exactly `THREADTERM_NATIVE_SKILL_OK`.\n');
  // Copy credentials only; config, sessions, history, and plugin state stay isolated.
  const sourceAuth = join(process.env.USERPROFILE ?? '', '.codex', 'auth.json');
  await copyFile(sourceAuth, join(codexHome, 'auth.json'));
  const forbidden = new Set(['codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !forbidden.has(key.toLowerCase())));
  Object.assign(env, { CODEX_HOME: codexHome, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime });
  app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(25_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await updateSettings({ language: 'en' });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await request('project.add', { path: workspace, name: 'Codex compatibility live QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex compatibility live QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-compose-shell textarea').waitFor();
  await page.locator('.chat-model-chip').waitFor({ timeout: 60_000 });
  let leaseEpoch = (await request('session.claim', { sessionId: session.id, clientId: 'codex-compat-live' })).leaseEpoch;
  report.checks.push('Electron ChatView connected to the real isolated Codex app-server');

  const ui = await request('chat.options', { sessionId: session.id });
  report.observations.optionIds = ui.options.map(option => option.id);
  assert.ok(ui.options.some(option => option.id === 'mode' && /approval/i.test(option.name)), 'approval policy option missing');
  assert.ok(ui.options.some(option => option.id === 'collaboration'), 'collaboration option missing');
  assert.ok(ui.options.some(option => option.id === 'sandbox'), 'sandbox option missing');
  const shield = page.locator('.chat-mode-chip');
  await assert.doesNotMatch((await shield.textContent()) ?? '', /default|plan/iu, 'permission shield incorrectly displays collaboration mode');
  report.checks.push('permission shield uses Approval policy (option id mode), not Collaboration');

  for (const [command, expected] of [['/skills', 'threadterm-native-probe'], ['/approvals', 'Approval policy'], ['/sandbox', 'Sandbox']]) {
    leaseEpoch = await renew(session.id, leaseEpoch);
    const prior = await sendCommand(session.id, command);
    await waitAssistant(session.id, command, expected, prior);
    report.checks.push(`${command} completed locally with visible result`);
  }
  leaseEpoch = await renew(session.id, leaseEpoch);
  let prior = await sendCommand(session.id, '/approvals never');
  await waitAssistant(session.id, '/approvals never', 'Approval policy: never', prior);
  await shield.click();
  await selectMenuItem(page.locator('.chat-menu-mode'), 'Ask as needed');
  await waitOption(session.id, 'mode', 'on-request');
  report.checks.push('manual /approvals and permission-shield menu both applied and read back approval policy');
  leaseEpoch = await renew(session.id, leaseEpoch);
  prior = await sendCommand(session.id, '/sandbox read-only');
  await waitAssistant(session.id, '/sandbox read-only', 'Sandbox: read-only', prior);
  await waitOption(session.id, 'sandbox', 'read-only');
  report.checks.push('manual /sandbox applied and read back read-only sandbox');
  leaseEpoch = await renew(session.id, leaseEpoch);
  prior = await sendCommand(session.id, '/status');
  await waitStatus(session.id, '/status', prior);
  report.checks.push('/status completed with a structured status result');

  // Select /help from the actual suggestion list, then submit it; it must not become an arbitrary model prompt.
  const textarea = page.locator('.chat-compose-shell textarea');
  prior = await priorUserIds(session.id, '/help');
  await textarea.fill('/h');
  const helpSuggestion = page.locator('.chat-slash [role="option"]', { hasText: '/help' });
  await helpSuggestion.waitFor();
  await helpSuggestion.click();
  assert.equal(await textarea.inputValue(), '/help ');
  leaseEpoch = await renew(session.id, leaseEpoch);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  await waitAssistant(session.id, '/help', 'Chat commands:', prior);
  report.checks.push('slash-menu click selected and executed /help');

  // Collaboration and sandbox are extra model-menu controls. Their selection uses the live UI, not direct RPC.
  await page.locator('.chat-model-chip').click();
  const modelMenu = page.locator('.chat-menu-model');
  await modelMenu.getByText('Collaboration', { exact: true }).waitFor();
  await selectMenuItem(modelMenu, 'Plan');
  await waitOption(session.id, 'collaboration', 'plan');
  await page.locator('.chat-model-chip').click();
  await selectMenuItem(page.locator('.chat-menu-model'), 'Workspace write');
  await waitOption(session.id, 'sandbox', 'workspace-write');
  leaseEpoch = await renew(session.id, leaseEpoch);
  prior = await sendCommand(session.id, '/status');
  const statusAfterSelection = await waitStatus(session.id, '/status', prior);
  report.observations.statusAfterSelection = statusAfterSelection;
  const statusPart = statusAfterSelection.parts.find(part => part.type === 'status');
  assert.equal(statusPart?.data?.collaborationMode, 'plan', 'status did not read back selected collaboration mode');
  assert.equal(statusPart?.data?.sandbox?.type, 'workspaceWrite', 'status did not read back selected sandbox');
  report.checks.push('live collaboration and sandbox menu selections read back through /status');

  // Select the repo skill through the slash menu, then verify its marker from the real model turn.
  prior = await priorUserIds(session.id, '/threadterm-native-probe');
  await textarea.fill('/threadterm-native-probe');
  const skillSuggestion = page.locator('.chat-slash [role="option"]', { hasText: '/threadterm-native-probe' });
  await skillSuggestion.waitFor({ timeout: 30_000 });
  await skillSuggestion.click();
  leaseEpoch = await renew(session.id, leaseEpoch);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  await waitAssistant(session.id, '/threadterm-native-probe', 'THREADTERM_NATIVE_SKILL_OK', prior, 120_000);
  report.checks.push('project skill selected from slash menu executed through real Codex native input');

  await waitComposeIdle(session.id);
  prior = await sendCommand(session.id, '/compact');
  report.observations.compact = await waitNativeOperation(session.id, '/compact', prior);
  report.checks.push('manual /compact created a new native operation and returned the session to idle');

  const reviewCommand = '/review Do not run tools or modify files. Review this empty QA workspace and reply briefly.';
  await waitComposeIdle(session.id);
  prior = await sendCommand(session.id, reviewCommand);
  report.observations.review = await waitNativeOperation(session.id, reviewCommand, prior);
  assert.ok(report.observations.review.items.some(item => item.role === 'assistant'), 'inline /review did not produce an assistant item on its public operation');
  report.checks.push('inline custom /review completed on the same public operation without a separate session');

  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 1440, 1920]) {
    await updateSettings({ language: locale, theme });
    await page.waitForFunction(expected => document.documentElement.lang === expected, locale);
    await page.setViewportSize({ width, height: 960 });
    await page.locator('.chat-model-chip').click();
    const modelMenu = page.locator('.chat-menu-model');
    const labels = locale === 'en'
      ? { collaboration: 'Collaboration', plan: 'Plan', sandbox: 'Sandbox', workspace: 'Workspace write', shield: 'Ask as needed' }
      : { collaboration: '协作模式', plan: '规划', sandbox: '沙箱', workspace: '工作区可写', shield: '按需询问' };
    await modelMenu.getByText(labels.collaboration, { exact: true }).waitFor();
    await modelMenu.getByText(labels.sandbox, { exact: true }).waitFor();
    await modelMenu.getByRole('menuitemradio', { name: labels.plan, exact: true }).waitFor();
    await modelMenu.getByRole('menuitemradio', { name: labels.workspace, exact: true }).waitFor();
    await modelMenu.getByRole('menuitemradio', { name: labels.workspace, exact: true }).scrollIntoViewIfNeeded();
    assert.equal((await shield.textContent())?.trim(), labels.shield, `localized shield mismatch for ${locale}`);
    await page.screenshot({ path: join(scratch, `success-${locale}-${theme}-${width}.png`), fullPage: true });
    await page.locator('.chat-model-chip').click();
  }
  report.checks.push('captured English and Chinese light/dark menu screenshots at 1280, 1440, and 1920px');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try { if (page) await request('runtime.shutdown', { operationId: randomUUID() }); } catch {}
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await writeFile(join(scratch, 'report.json'), `${JSON.stringify(redact(report), null, 2)}\n`);
  process.stdout.write(`Codex live QA ${report.passed ? 'passed' : 'failed'}; report: ${join(scratch, 'report.json')}\n`);
}
