// Desktop-1 E2 acceptance QA. It builds an isolated app, installs only the
// local feedback-notes ACP fixture, and verifies a mid-turn note through the
// real runtime/renderer boundary: the agent calls feedback_check after the user
// sends a note, and the note flips Waiting -> Received. No provider binary,
// account, or user profile is reachable: PATH has one spelling and contains no
// agent executable.
import assert from 'node:assert/strict';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-e2-notes-'));
const runtime = process.env.THREADTERM_QA_E2_RUNTIME_EXE || process.env.THREADTERM_QA_RUNTIME_EXE || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/feedback-notes-acp');
const out = join(root, 'qa/results/chat-parity/E2/feedback-notes-real');
const appDir = join(scratch, 'app'), plugins = join(scratch, 'plugins'), bin = join(scratch, 'bin'), work = join(scratch, 'work');
let app, page;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
const request = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw Error(`timeout ${label}${error ? `: ${error.message}` : ''}`);
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), '{"name":"feedback-notes-qa","version":"1.0.0","main":"main.cjs"}');
}
try {
  assert.ok(existsSync(runtime), `missing E2 runtime ${runtime}`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await mkdir(plugins, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(work, { recursive: true });
  cpSync(fixture, join(plugins, 'feedback-notes-acp'), { recursive: true });
  await buildApp();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-e2-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'each PATH variant is removed before the isolated app starts');
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30000 });
  const first = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', 'chatTools.feedback': true }, expectedRevision: first.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('plugin.list')).plugins.some(plugin => plugin.id === 'feedback-notes-acp'), 'E2 ACP fixture discovery');
  await request('plugin.setEnabled', { pluginId: 'feedback-notes-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(provider => provider.id === 'feedback-notes-echo' && provider.chat), 'E2 ACP provider enabled');
  const project = await request('project.add', { path: work, name: 'E2 QA', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: work, provider: 'feedback-notes-echo', mode: 'chat', title: 'E2 notes', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${session.id}"]`), composer = scope.locator('textarea');
  await until(() => composer.isEnabled(), 'composer');
  const options = await until(async () => { const value = await request('chat.options', { sessionId: session.id }); return value.inputCapabilities?.steer ? value : undefined; }, 'note capability');
  assert.equal(options.inputCapabilities.steer, 'note', 'the feedback session is offered the note capability');
  await composer.fill('start the long job');
  await scope.locator('.chat-compose-send').click();
  await until(async () => (await scope.innerText()).includes('WAITING_FOR_NOTE'), 'fixture waiting for the note');
  await composer.fill('Prefer the narrow reading');
  await scope.locator('[data-testid="steer-send"] [aria-label="More send actions"]').click();
  await scope.locator('[data-testid="steer-note"]').click();
  await until(async () => await scope.locator('[data-testid="chat-note"][data-note-status="waiting"]').count() === 1, 'waiting note appears in the strip');
  assert.equal((await scope.locator('.chat-note-status').first().innerText()).trim(), 'Waiting');
  await writeFile(join(work, '.qa-note-sent'), 'go');
  await until(async () => (await scope.innerText()).includes('NOTE_RESULT'), 'fixture feedback_check result');
  await until(async () => await scope.locator('[data-testid="chat-note"][data-note-status="received"]').count() === 1, 'note flips to Received');
  assert.match(await scope.innerText(), /Prefer the narrow reading/, 'the fixture received the exact note text');
  const read = await request('chat.feedback.read', { sessionId: session.id });
  assert.equal(read.notes.length, 1, 'one note is stored');
  assert.equal(read.notes[0].status, 'received');
  assert.equal(read.notes[0].text, 'Prefer the narrow reading');
  assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${session.id}"] [data-testid="chat-notes"]`), 'notes strip after Received');
  await page.screenshot({ path: join(out, 'note-received.png'), animations: 'disabled' });
  report.screenshots.push('note-received.png');
  report.checks.push('fake ACP calls feedback_check mid-turn; the note flips Waiting to Received and survives chat.feedback.read');

  // E2-1: an unread note at turn end must clear through the real dismiss RPC.
  await composer.fill('run another long job');
  await scope.locator('.chat-compose-send').click();
  await until(async () => (await scope.innerText()).includes('WAITING_FOR_NOTE'), 'second turn waits for a note');
  await composer.fill('Keep this for the next check');
  await scope.locator('[data-testid="steer-send"] [aria-label="More send actions"]').click();
  await scope.locator('[data-testid="steer-note"]').click();
  await until(async () => await scope.locator('[data-testid="chat-note"][data-note-status="waiting"]').count() === 1, 'waiting note appears before turn end');
  await writeFile(join(work, '.qa-note-hold'), 'hold');
  await writeFile(join(work, '.qa-note-sent'), 'go');
  await until(async () => (await scope.innerText()).includes('NOTE_HELD'), 'fixture ends the turn with the note unread');
  await until(async () => await scope.locator('[data-testid="note-send-message"]').count() === 1, 'turn end offers Send as message');
  const waitingRead = await request('chat.feedback.read', { sessionId: session.id });
  assert.equal(waitingRead.notes.filter(note => note.status === 'waiting').length, 1, 'the unread note is stored at turn end');
  await page.screenshot({ path: join(out, 'turnend-waiting.png'), animations: 'disabled' });
  report.screenshots.push('turnend-waiting.png');
  await scope.locator('[data-testid="note-send-message"]').click();
  await until(async () => await scope.locator('[data-testid="chat-note"][data-note-status="waiting"]').count() === 0, 'Send as message clears the note');
  const cleared = await request('chat.feedback.read', { sessionId: session.id });
  assert.equal(cleared.notes.filter(note => note.status === 'waiting').length, 0, 'the dismiss RPC removed the waiting note');
  assert.doesNotMatch(await scope.innerText(), /operation_conflict/, 'no dismiss conflict is shown');
  assert.match(await scope.innerText(), /Keep this for the next check/, 'the note was sent as a message');
  await page.screenshot({ path: join(out, 'send-as-message.png'), animations: 'disabled' });
  report.screenshots.push('send-as-message.png');
  report.checks.push('turn-end Send as message sends the note text and clears it through the real chat.feedback.dismiss RPC');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
  try { await page?.screenshot({ path: join(out, 'failure.png') }); } catch { /* keep the original failure */ }
} finally {
  try { await request('runtime.shutdown', { operationId: randomUUID() }); } catch { /* the app may already be gone */ }
  try { await app?.close(); } catch { /* the app may already be gone */ }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
