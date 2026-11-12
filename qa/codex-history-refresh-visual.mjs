// Real Electron return-to-Chat path using only a synthetic Codex thread.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const runtime = process.env.THREADTERM_V3_RUNTIME_BIN;
assert.ok(runtime, 'Set THREADTERM_V3_RUNTIME_BIN to the debug runtime under test');
const scratch = await mkdtemp(join(tmpdir(), 'tt-history-refresh-visual-'));
const cwd = join(scratch, 'workspace');
const bin = join(scratch, 'bin');
const historyFile = join(scratch, 'history.json');
const log = join(scratch, 'native.jsonl');
const fixture = fileURLToPath(new URL('./fixtures/fake-codex-history-refresh.cjs', import.meta.url));
const out = fileURLToPath(new URL('./results/codex-history-refresh/', import.meta.url));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|ProgramData)$/i.test(key)));
const env = {
  ...inherited, HOME: scratch, USERPROFILE: scratch, HOMEDRIVE: scratch.slice(0, 2), HOMEPATH: scratch.slice(2),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local'),
  TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp'), CODEX_HOME: join(scratch, 'codex'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: '\\\\.\\pipe\\tt-history-refresh-visual-' + randomUUID(),
  THREADTERM_QA_PROVIDER_BIN: bin, THREADTERM_V3_RUNTIME: resolve(runtime),
  TT_QA_HISTORY_FILE: historyFile, TT_QA_HISTORY_CWD: cwd, TT_QA_HISTORY_LOG: log,
};

function turn(id, prompt, reply) {
  return { id, status: 'completed', items: [
    { id: id + '-prompt', type: 'userMessage', content: [{ type: 'text', text: prompt, text_elements: [] }] },
    { id: id + '-reply', type: 'agentMessage', phase: 'final_answer', text: reply },
  ] };
}

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

let app;
let built;
try {
  await Promise.all([cwd, bin, out, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CODEX_HOME,
    env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(bin, 'codex.cmd'), '@"' + process.execPath + '" "' + fixture + '" %*\r\n');
  const local = turn('original', 'Original ThreadTerm prompt', 'Original ThreadTerm reply');
  await writeFile(historyFile, JSON.stringify([local]));
  built = await buildQaApp();
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', built.appDir],
    cwd, env, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const settings = async theme => {
    const { settings } = await rpc('runtime.snapshot');
    await rpc('settings.update', { patch: { language: 'en', theme, notifications: { native: false, attention: false, completed: false, sound: false } },
      expectedRevision: settings.revision, operationId: randomUUID() });
  };
  await settings('light');
  const project = await rpc('project.add', { path: cwd, name: 'Codex history refresh QA', operationId: randomUUID() });
  const session = await rpc('session.create', { provider: 'codex', mode: 'chat', nativeId: 'qa-history-refresh-thread',
    projectId: project.id, cwd, operationId: randomUUID() });
  const present = () => rpc('session.present', { sessionId: session.id, placement: 'workspace',
    presentation: 'focused', operationId: randomUUID() });
  await present();
  const chat = page.getByTestId('session-chat-' + session.id);
  await chat.getByText('Original ThreadTerm reply', { exact: true }).waitFor();
  const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Keep this unsent draft');
  await until(async () => (await rpc('chat.draft.read', { sessionId: session.id })).text === 'Keep this unsent draft', 'draft saved');

  const external = turn('external-latest', 'External Codex prompt', 'External Codex reply');
  await writeFile(historyFile, JSON.stringify([local, external]));
  // The fixture window stays on the QA virtual desktop. Deliver the same focus
  // event as an OS return without taking focus from the user's active desktop.
  const returnToWindow = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await returnToWindow();
  const reply = chat.getByText('External Codex reply', { exact: true });
  await reply.waitFor();
  assert.equal(await chat.getByText('External Codex prompt', { exact: true }).count(), 1);
  assert.equal(await reply.count(), 1);
  assert.equal(await composer.inputValue(), 'Keep this unsent draft');
  const readCount = async () => (await readFile(log, 'utf8')).trim().split(/\r?\n/u)
    .map(JSON.parse).filter(row => row.method === 'thread/read').length;
  const reads = await readCount();
  await returnToWindow();
  await until(async () => (await readCount()) > reads, 'repeat focus checked native history');
  assert.equal(await reply.count(), 1);

  for (const theme of ['light', 'dark']) {
    await settings(theme);
    for (const width of [1280, 1440, 1920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
      await page.waitForFunction(width => window.innerWidth === width, width);
      await page.screenshot({ path: join(out, theme + '-' + width + '.png'), animations: 'disabled' });
    }
  }
  console.log('PASS: Electron focus imported external messages once and retained the draft');
} finally {
  await app?.close();
  await built?.cleanup();
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
