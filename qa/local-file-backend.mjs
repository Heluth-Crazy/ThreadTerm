// Real Electron parity probe for the optional local main-process filesystem backend.
// Run only after the parent runtime batch has copied a current executable to target-qa:
//   node qa/local-file-backend.mjs [--keep]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `missing ${runtime}; parent must build and copy the QA runtime first`);
const scratch = await mkdtemp(join(tmpdir(), 'tt-local-file-backend-'));
const projectPath = join(scratch, 'project'), nested = join(projectPath, 'nested'), outside = join(scratch, 'outside');
const data = join(scratch, 'data'), profile = join(scratch, 'profile');
const pipe = `\\\\.\\pipe\\tt-local-file-backend-${randomUUID()}`;
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [], limitations: ['Does not verify DSE encrypted/protected-volume behavior.', 'Restart persistence is covered by LocalFileBackendConfig unit reopen tests; this Electron probe only round-trips the setting in one process.', 'Remote routing remains covered by router unit tests, not this local-only Electron fixture.'], runtime };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let app, page, daemon, releaseLock, cleanupApp, runtimeStderr = '';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0c8AAAAASUVORK5CYII=', 'base64');
const windowBytes = Buffer.from('首行 UTF-8 😀\r\n'.repeat(100_000) + 'final line');
const environment = () => {
  const dropped = /^(path|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  return { ...env, Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime };
};
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const local = (method, params = {}) => page.evaluate(async ([name, value]) => {
  const api = window.threadterm.localFiles;
  if (!api) throw Error('local-files bridge unavailable');
  return window.threadterm.request(name, value);
}, [method, params]);
const setBackend = mode => page.evaluate(async value => window.threadterm.localFiles?.setBackend(value), mode);
const getBackend = () => page.evaluate(() => window.threadterm.localFiles?.getBackend());
const failure = (method, params) => page.evaluate(async ([name, value]) => {
  try { await window.threadterm.request(name, value); return { ok: true }; }
  catch (error) { return { ok: false, code: error?.code, message: String(error?.message ?? error) }; }
}, [method, params]);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['fingerprint', 'modifiedAt', 'openedAt', 'size'].includes(key)).map(([key, entry]) => [key, normalized(entry)]));
}

async function waitForBridge() {
  await page.waitForFunction(() => Boolean(window.threadterm?.request && window.threadterm.localFiles?.getBackend), undefined, { timeout: 20_000 });
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 20_000 });
}

async function exercise(mode, project, session, tag) {
  assert.equal(await setBackend(mode), mode, `${mode} selection round-trips through bridge`);
  assert.equal(await getBackend(), mode, `${mode} selection reads through bridge`);
  const scope = { projectId: project.id };
  const listed = await local('filesystem.list', { ...scope, path: '' });
  assert.ok(listed.some(entry => entry.path === 'seed.txt'), `${mode} lists registered root`);
  const initial = await local('filesystem.read', { ...scope, path: 'seed.txt' });
  assert.equal(initial.content, 'seed\nneedle\n', `${mode} reads text`);
  const browsed = await local('filesystem.browse', { path: projectPath });
  assert.ok(browsed.entries.some(entry => entry.name === 'seed.txt'), `${mode} browses local directories`);
  const preview = await local('filesystem.preview.read', { ...scope, path: 'seed.txt', offset: 0, limit: 1024 });
  assert.equal(Buffer.from(preview.chunk, 'base64').toString(), initial.content, `${mode} reads preview chunks`);
  const image = await local('filesystem.image', { ...scope, path: 'pixel.png' });
  assert.equal(image.mime, 'image/png', `${mode} reads image by signature`);
  const files = await local('filesystem.files', scope);
  assert.ok(files.paths.includes('seed.txt'), `${mode} walks files`);
  const search = await local('filesystem.search', { ...scope, query: 'needle' });
  assert.ok(search.files.some(file => file.path === 'seed.txt'), `${mode} searches content`);
  const created = `${tag}-created.txt`, renamed = `${tag}-renamed.txt`;
  await local('filesystem.create', { ...scope, path: created, kind: 'file', operationId: randomUUID() });
  await local('filesystem.rename', { ...scope, path: created, newPath: renamed, operationId: randomUUID() });
  const blank = await local('filesystem.read', { ...scope, path: renamed });
  const saved = await local('filesystem.write', { ...scope, path: renamed, content: 'saved parity', expectedFingerprint: blank.fingerprint, operationId: randomUUID() });
  assert.equal(saved.content, 'saved parity', `${mode} writes with fingerprint`);
  await local('filesystem.delete', { ...scope, path: renamed, permanent: true, operationId: randomUUID() });
  assert.equal((await failure('filesystem.read', { ...scope, path: renamed })).ok, false, `${mode} permanent delete removes target`);
  const resolved = await local('filesystem.resolve', { sessionId: session.id, path: '../seed.txt', line: 2, column: 1 });
  assert.equal(resolved.path, 'seed.txt', `${mode} resolves a session-relative file`);
  const external = await local('filesystem.external.open', { path: join(outside, 'external.txt'), source: 'dialog', sessionId: session.id });
  assert.ok('file' in external, `${mode} registers external local file`);
  assert.equal(external.file.size, Buffer.byteLength('external read only\n'), `${mode} reports external byte size`);
  assert.ok(external.file.modifiedAt, `${mode} reports external modified time`);
  assert.ok((await local('filesystem.external.list')).files.some(file => file.id === external.file.id), `${mode} lists registered external file`);
  const externalText = await local('filesystem.external.read', { id: external.file.id });
  assert.equal(externalText.readonly, true, `${mode} retains external read-only boundary`);
  assert.equal(externalText.modifiedAt, external.file.modifiedAt, `${mode} external reads retain exact filesystem timestamp`);
  await local('filesystem.external.forget', { id: external.file.id, operationId: randomUUID() });
  const forgotten = await failure('filesystem.external.read', { id: external.file.id });
  assert.equal(forgotten.ok, false, `${mode} forget revokes external id`);
  assert.match(forgotten.message, /external_file_unknown/, `${mode} forgotten external id is unknown through Electron's message-only error transport`);
  return { parity: normalized({ listed: listed.filter(entry => entry.path === 'seed.txt'), browsed: browsed.entries.filter(entry => entry.name === 'seed.txt'), preview, image, files: files.paths.filter(path => path === 'seed.txt'), search, resolved, external: { name: external.file.name, readonly: externalText.readonly, content: externalText.content } }), externalMetadata: { size: external.file.size, modifiedAt: external.file.modifiedAt }, fingerprints: { initial: initial.fingerprint, saved: saved.fingerprint, preview: preview.fingerprint } };
}

async function exerciseWindows(mode, project, session) {
  await setBackend(mode);
  const workspace = { projectId: project.id, path: 'window.txt' };
  const opened = await local('filesystem.external.open', { path: join(outside, 'window.txt'), source: 'dialog', sessionId: session.id });
  assert.ok('file' in opened, `${mode} registers external large text`);
  const result = {};
  for (const [kind, method, params] of [
    ['workspace', 'filesystem.readWindow', workspace],
    ['external', 'filesystem.external.readWindow', { id: opened.file.id }],
  ]) {
    const windows = []; let changeToken;
    for (const [offset, maxBytes] of [[0, 32], [3, 32], [65_539, 131_072], [windowBytes.length - 7, 32], [windowBytes.length + 1, 32]]) {
      const value = await local(method, { ...params, offset, maxBytes, ...(changeToken ? { changeToken } : {}) });
      changeToken = value.changeToken;
      assert.equal(value.size, windowBytes.length, `${mode}/${kind} reports full byte size`);
      assert.ok(value.start <= value.end && value.end <= value.size, `${mode}/${kind} returns a valid byte range`);
      assert.ok(value.end - value.start <= maxBytes, `${mode}/${kind} keeps the requested memory bound`);
      assert.deepEqual(Buffer.from(value.content), windowBytes.subarray(value.start, value.end), `${mode}/${kind} preserves exact UTF-8 and CRLF bytes`);
      if (offset > value.size) assert.equal(value.content, '', `${mode}/${kind} returns an empty EOF window`);
      windows.push(value);
    }
    result[kind] = windows;
  }
  await local('filesystem.external.forget', { id: opened.file.id, operationId: randomUUID() });
  const forgotten = await failure('filesystem.external.readWindow', { id: opened.file.id, offset: 0 });
  assert.equal(forgotten.ok, false, `${mode} forget revokes window reads`);
  assert.match(forgotten.message, /external_file_unknown/, `${mode} window lookup respects its own external registry`);

  const changedPath = join(outside, `changed-${mode}.txt`);
  await writeFile(changedPath, 'before window change\r\n');
  const changed = await local('filesystem.external.open', { path: changedPath, source: 'dialog', sessionId: session.id });
  const before = await local('filesystem.external.readWindow', { id: changed.file.id, offset: 0 });
  await writeFile(changedPath, 'after window change with different size\r\n');
  const stale = await failure('filesystem.external.readWindow', { id: changed.file.id, offset: 0, changeToken: before.changeToken });
  assert.equal(stale.ok, false, `${mode} rejects stale external window tokens`);
  assert.match(stale.message, /file_changed/, `${mode} preserves the reloadable file_changed error through Electron`);
  await local('filesystem.external.forget', { id: changed.file.id, operationId: randomUUID() });
  return result;
}

async function exerciseSettings() {
  const output = join(root, 'qa/results/local-file-backend');
  await mkdir(output, { recursive: true });
  for (const [language, tone] of [['en', 'light'], ['zh-CN', 'dark']]) {
    const state = await request('runtime.snapshot');
    await request('settings.update', { patch: { language, theme: tone, themeSelection: `preset:threadterm-${tone}` }, expectedRevision: state.settings.revision, operationId: randomUUID() });
    await page.waitForFunction(locale => document.documentElement.lang === locale, language);
    await page.getByRole('button', { name: language === 'en' ? 'Local user' : '本地用户', exact: true }).click();
    await page.getByRole('button', { name: language === 'en' ? 'More themes…' : '更多主题…', exact: true }).click();
    await page.getByRole('tab', { name: language === 'en' ? 'Tools' : '工具', exact: true }).click();
    const control = page.locator('.local-file-access-settings');
    await control.scrollIntoViewIfNeeded();
    for (const mode of ['runtime', 'main']) {
      const label = mode === 'runtime' ? (language === 'en' ? 'Background process' : '后台进程') : (language === 'en' ? 'Main process' : '主进程');
      const radio = control.getByRole('radio', { name: new RegExp(label) });
      await radio.click();
      await page.waitForFunction(value => window.threadterm.localFiles.getBackend().then(actual => actual === value), mode);
      await page.waitForFunction(index => document.querySelectorAll('.local-file-access-settings input[type="radio"]')[index]?.checked, mode === 'runtime' ? 0 : 1);
      assert.equal(await radio.isChecked(), true, `${language} selector confirms ${mode}`);
    }
    const radios = control.getByRole('radio');
    await radios.nth(1).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.threadterm.localFiles.getBackend().then(actual => actual === 'runtime'));
    await page.waitForFunction(() => document.querySelectorAll('.local-file-access-settings input[type="radio"]')[0]?.checked);
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.threadterm.localFiles.getBackend().then(actual => actual === 'main'));
    await page.waitForFunction(() => document.querySelectorAll('.local-file-access-settings input[type="radio"]')[1]?.checked);
    for (const width of [1280, 1440, 1920]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
      await page.setViewportSize({ width, height: 900 });
      await control.scrollIntoViewIfNeeded();
      const geometry = await control.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
      assert.ok(geometry.content <= geometry.width + 1, `${language}/${width} setting has no horizontal overflow`);
      const aligned = await control.locator('label').evaluateAll(options => options.every(option => {
        const radio = option.querySelector('input').getBoundingClientRect(), text = option.querySelector('span').getBoundingClientRect();
        return radio.right <= text.left && Math.abs(radio.top - text.top) <= 6;
      }));
      assert.ok(aligned, `${language}/${width} each radio stays beside its label`);
      const file = join(output, `${language}-${tone}-${width}.png`);
      await page.screenshot({ path: file, animations: 'disabled' }); report.screenshots.push(file);
    }
    await page.keyboard.press('Escape'); await page.locator('.settings-panel').waitFor({ state: 'detached' });
  }
  check('actual settings radios support mouse and keyboard selection in English/light and Chinese/dark at 1280, 1440 and 1920 widths');
}

try {
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside, { recursive: true }), mkdir(data, { recursive: true }), mkdir(profile, { recursive: true })]);
  await Promise.all([writeFile(join(projectPath, 'seed.txt'), 'seed\nneedle\n'), writeFile(join(projectPath, 'pixel.png'), png), writeFile(join(outside, 'external.txt'), 'external read only\n'), writeFile(join(projectPath, 'window.txt'), windowBytes), writeFile(join(outside, 'window.txt'), windowBytes)]);
  await symlink(outside, join(projectPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  ({ cleanup: cleanupApp } = await buildQaApp({ root, outDir: join(scratch, 'app') }));
  daemon = spawn(runtime, [], { windowsHide: true, env: environment(), stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { runtimeStderr = `${runtimeStderr}${chunk}`.slice(-65_536); });
  releaseLock = await acquireElectronQaLock({ directory: tmpdir() });
  app = await electron.launch({ args: [join(scratch, 'app')], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await waitForBridge();
  const project = await request('project.add', { path: projectPath, name: 'Local files QA', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: nested, provider: 'codex', mode: 'chat', title: 'Local files QA', operationId: randomUUID() });
  assert.equal(await getBackend(), 'runtime', 'default backend is existing Runtime');
  const runtimeResult = await exercise('runtime', project, session, 'runtime');
  const mainResult = await exercise('main', project, session, 'main');
  assert.deepEqual(mainResult.parity, runtimeResult.parity, 'main and Runtime give matching local filesystem results');
  assert.deepEqual(mainResult.externalMetadata, runtimeResult.externalMetadata, 'main and Runtime report matching external file size and modified time');
  assert.equal(mainResult.fingerprints.initial, runtimeResult.fingerprints.initial, 'main and Runtime read the same seed fingerprint');
  assert.equal(mainResult.fingerprints.saved, runtimeResult.fingerprints.saved, 'main and Runtime produce the same saved fingerprint');
  assert.equal(mainResult.fingerprints.preview, runtimeResult.fingerprints.preview, 'preview chunk identity remains stable across backend switches');
  check('runtime/main local read, browse, preview, list, files, search, create, rename, permanent delete, image, external and session resolve parity');
  const runtimeWindows = await exerciseWindows('runtime', project, session);
  const mainWindows = await exerciseWindows('main', project, session);
  assert.deepEqual(mainWindows, runtimeWindows, 'both backends return identical bounded windows, line flags and change tokens');
  const continued = await local('filesystem.readWindow', { projectId: project.id, path: 'window.txt', offset: 0, maxBytes: 32, changeToken: runtimeWindows.workspace[0].changeToken });
  assert.deepEqual(continued, runtimeWindows.workspace[0], 'main accepts a still-current Runtime window token after switching');
  check('large workspace/external window parity, UTF-8/CRLF byte boundaries, EOF, registered-ID revocation, stable switch tokens and file_changed errors');
  const blocked = await failure('filesystem.read', { projectId: project.id, path: 'escape/external.txt' });
  assert.equal(blocked.ok, false, `junction escape is rejected (${blocked.code ?? blocked.message})`);
  const invalid = await failure('filesystem.read', { projectId: project.id, path: '../outside/external.txt' });
  assert.equal(invalid.ok, false, `parent traversal is rejected (${invalid.code ?? invalid.message})`);
  check('forbidden traversal and junction paths remain rejected');
  await request('draft.put', { projectId: project.id, path: 'seed.txt', content: 'unsaved draft', baseFingerprint: (await request('filesystem.read', { projectId: project.id, path: 'seed.txt' })).fingerprint, expectedRevision: 0, operationId: randomUUID() });
  await setBackend('runtime');
  assert.ok((await request('draft.list', { projectId: project.id })).some(draft => draft.path === 'seed.txt' && draft.content === 'unsaved draft'), 'backend change does not modify editor draft records');
  check('draft storage remains untouched by backend selection');
  await page.evaluate(() => { window.__localFileBackendEvents = []; window.__localFileBackendOff = window.threadterm.onEvent(event => window.__localFileBackendEvents.push(event)); });
  await setBackend('main');
  const replayOperation = randomUUID();
  const params = { projectId: project.id, path: 'replay.txt', kind: 'file', operationId: replayOperation };
  const first = await local('filesystem.create', params);
  await setBackend('runtime');
  const replayed = await local('filesystem.create', params);
  assert.deepEqual(replayed, first, 'main mutation receipt replays through Runtime after mode switch');
  await delay(250);
  const eventCount = await page.evaluate(projectId => window.__localFileBackendEvents.filter(event => event.event === 'state.changed' && event.data?.kind === 'git' && event.data?.projectId === projectId && !event.data?.worktreePath).length, project.id);
  assert.equal(eventCount, 1, 'replayed operation publishes one state event');
  await page.evaluate(() => { window.__localFileBackendEvents = []; });
  const reverseOperation = randomUUID(), reverseParams = { projectId: project.id, path: 'reverse-replay.txt', kind: 'file', operationId: reverseOperation };
  const reverseFirst = await local('filesystem.create', reverseParams);
  await setBackend('main');
  assert.deepEqual(await local('filesystem.create', reverseParams), reverseFirst, 'Runtime mutation receipt replays through main after mode switch');
  const saveBase = await local('filesystem.read', { projectId: project.id, path: 'reverse-replay.txt' });
  const saveOperation = randomUUID(), saveParams = { projectId: project.id, path: 'reverse-replay.txt', content: 'replayed save', expectedFingerprint: saveBase.fingerprint, operationId: saveOperation };
  await setBackend('runtime');
  const saveFirst = await local('filesystem.write', saveParams);
  await setBackend('main');
  assert.deepEqual(await local('filesystem.write', saveParams), saveFirst, 'Runtime save receipt replays through main after mode switch');
  await delay(250);
  const reverseEventCount = await page.evaluate(projectId => window.__localFileBackendEvents.filter(event => event.event === 'state.changed' && event.data?.kind === 'git' && event.data?.projectId === projectId && !event.data?.worktreePath).length, project.id);
  assert.equal(reverseEventCount, 2, 'reverse create and save each publish one scoped state event');
  await page.evaluate(() => window.__localFileBackendOff?.());
  check('bidirectional create/save operation replay preserves results and emits one scoped event per mutation');
  await writeFile(join(projectPath, 'conflict.txt'), 'before conflict');
  await setBackend('main');
  const conflictRead = await local('filesystem.read', { projectId: project.id, path: 'conflict.txt' });
  await writeFile(join(projectPath, 'conflict.txt'), 'actual external bytes');
  const conflict = await failure('filesystem.write', { projectId: project.id, path: 'conflict.txt', content: 'stale overwrite', expectedFingerprint: conflictRead.fingerprint, operationId: randomUUID() });
  assert.equal(conflict.ok, false, 'stale fingerprint write is rejected');
  assert.match(conflict.message, /file_conflict/, 'stale fingerprint reports file_conflict');
  assert.equal(await readFile(join(projectPath, 'conflict.txt'), 'utf8'), 'actual external bytes', 'conflict preserves actual on-disk bytes');
  check('fingerprint conflict preserves external bytes');
  await exerciseSettings();
  assert.deepEqual(pageErrors, [], 'Electron renderer has no page errors');
  report.passed = true;
} catch (error) {
  if (runtimeStderr) report.runtimeStderr = runtimeStderr;
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await mkdir(join(root, 'qa/results'), { recursive: true });
  await writeFile(join(root, 'qa/results/local-file-backend.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) { await app.close().catch(() => {}); }
  await releaseLock?.();
  if (daemon?.exitCode === null) daemon.kill();
  if (daemon) await Promise.race([new Promise(resolveExit => daemon.once('exit', resolveExit)), delay(5_000)]);
  await cleanupApp?.().catch(() => {});
  if (!scratch.startsWith(join(tmpdir(), 'tt-local-file-backend-'))) throw new Error('Unexpected QA cleanup path');
  if (!keep) await rm(scratch, { recursive: true, force: true });
  console.log(`${report.passed ? 'LOCAL FILE BACKEND QA PASSED' : 'LOCAL FILE BACKEND QA FAILED'}; report: qa/results/local-file-backend.json`);
}
