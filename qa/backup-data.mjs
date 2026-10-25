// Settings → Data backup/verification QA. Uses Desktop 1, an isolated profile and a PATH without real providers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratchBase = resolve(process.env.TEMP || tmpdir());
const scratch = await mkdtemp(join(scratchBase, 'tt-backup-data-'));
const appDir = join(scratch, 'app'), userData = join(scratch, 'profile'), data = join(scratch, 'data'), backup = join(scratch, 'threadterm-backup.sqlite3');
const out = join(root, 'qa/results/backup-data');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app, page, releaseLock, launchEnvironment, electronProcess;
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function bounded(work, label, timeout = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function refreshQaRuntime() {
  if (process.env.THREADTERM_QA_BUILD_RUNTIME !== '1') return;
  await new Promise((resolve, reject) => execFile('cargo', ['build', '--offline', '--manifest-path', 'runtime/Cargo.toml', '--target-dir', 'runtime/target-qa', '-j', '2'], {
    cwd: root, env: { ...process.env, TEMP: scratchBase, TMP: scratchBase }, windowsHide: true, timeout: 900_000,
  }, error => error ? reject(error) : resolve()));
}

function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  assert.ok(systemRoot, 'Windows SystemRoot is required for Electron QA');
  Object.assign(env, {
    TEMP: scratchBase, TMP: scratchBase, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    PATH: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
    LOCALAPPDATA: join(scratch, 'local-app-data'), APPDATA: join(scratch, 'app-data'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: userData,
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-backup-data-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'exactly one isolated PATH');
  return env;
}

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, minify: false } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'backup-data-qa', version: '0.1.0', main: 'main.cjs' }));
}

async function request(method, params = {}) { return page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]); }
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) { try { const value = await probe(); if (value) return value; } catch {} if (Date.now() >= deadline) throw Error(`Timed out: ${label}`); await pause(150); }
}
async function waitForBackupResult() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const alert = (await page.getByRole('alert').allTextContents()).filter(Boolean).join(' · ');
    if (alert) throw Error(`backup UI error: ${alert}`);
    const status = await page.locator('.settings-panel [role="status"]').allTextContents();
    if (status.some(value => value.includes('Backup saved and verified'))) return;
    if (Date.now() >= deadline) throw Error('Timed out: backup result');
    await pause(150);
  }
}
async function apply(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, themeSelection: theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(([language, theme]) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme, [language, theme]);
}
async function verifyLocalized(language) {
  const expected = language === 'zh-CN' ? '备份校验通过' : 'Backup verified';
  await page.getByRole('button', { name: /^(Verify backup|校验备份)$/ }).click();
  await until(() => page.locator('.settings-panel [role="status"]').allTextContents().then(values => values.some(value => value.includes(expected))), `${language} verification result`);
  return page.locator('.settings-panel [role="status"]').filter({ hasText: expected }).first();
}
async function shot(name, reveal) {
  await page.getByRole('button', { name: /^(Back up ThreadTerm data|备份 ThreadTerm 数据)$/ }).scrollIntoViewIfNeeded();
  await reveal.scrollIntoViewIfNeeded();
  await page.locator('.settings-panel').screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}
async function resize(width, height = 900) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
  await page.setViewportSize({ width, height }).catch(() => undefined);
  await pause(200);
}
async function corruptFirstBackupFile(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare('SELECT path FROM backup_files ORDER BY path LIMIT 1').get();
    assert.ok(row?.path, 'backup contains a manifest entry');
    database.prepare("UPDATE backup_chunks SET data = X'00' WHERE path = ? AND sequence = 0").run(row.path);
    return row.path;
  } finally { database.close(); }
}
async function archiveManifest(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const archive = new DatabaseSync(path, { readOnly: true });
  try {
    const row = archive.prepare("SELECT body FROM backup_documents WHERE name = 'manifest.json'").get();
    assert.ok(row?.body, 'backup contains a manifest');
    return JSON.parse(row.body);
  } finally { archive.close(); }
}
async function archiveContainsText(path, text) {
  const { DatabaseSync } = await import('node:sqlite');
  const archive = new DatabaseSync(path, { readOnly: true });
  try {
    const needle = Buffer.from(text);
    const chunks = archive.prepare('SELECT data FROM backup_chunks').all();
    const documents = archive.prepare('SELECT body FROM backup_documents').all();
    return chunks.some(chunk => Buffer.from(chunk.data).includes(needle)) || documents.some(document => String(document.body).includes(text));
  } finally { archive.close(); }
}
async function openData() {
  await page.locator('.user-row').click();
  await page.locator('.account-menu').getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page.locator('.settings-panel').waitFor();
  await page.getByRole('tab', { name: /^(Data|数据)$/ }).click();
  await page.getByLabel('Backup file to verify').waitFor();
}
async function shutdownIsolatedRuntimeFallback() {
  const pipe = launchEnvironment?.THREADTERM_V3_PIPE;
  const credentialPath = join(data, 'runtime.credential');
  if (!pipe || !existsSync(credentialPath)) return;
  const peer = await connectPeer(`${pipe}-control`);
  try {
    await peer.auth((await readFile(credentialPath, 'utf8')).trim());
    const status = await peer.request('data.status', {}, 10_000);
    assert.equal(resolve(status.root).toLowerCase(), resolve(data).toLowerCase(), 'runtime fallback reached this QA data root');
    await peer.request('runtime.shutdown', { operationId: randomUUID() }, 15_000);
  } finally {
    peer.close();
  }
}
async function stopOwnedElectronFallback() {
  if (!electronProcess || electronProcess.exitCode !== null || electronProcess.killed) return;
  electronProcess.kill();
  await new Promise(resolve => electronProcess.once('exit', resolve));
}

try {
  assert.ok(existsSync(runtime), `missing QA runtime ${runtime}`);
  await Promise.all([mkdir(out, { recursive: true }), mkdir(userData, { recursive: true }), mkdir(data, { recursive: true })]);
  await mkdir(join(userData, 'page-comments'), { recursive: true });
  await writeFile(join(userData, 'page-comments', `${randomUUID()}.png`), 'page comment screenshot fixture');
  await mkdir(join(data, 'plugins', 'backup-fixture'), { recursive: true });
  await writeFile(join(data, 'plugins', 'backup-fixture', 'owned.txt'), 'plugin fixture');
  await writeFile(join(data, 'remote-access-key.pem'), 'qa-remote-access-key-secret');
  console.log('QA phase: build desktop app');
  await buildApp();
  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  console.log('QA phase: refresh runtime');
  await refreshQaRuntime();
  launchEnvironment = environment();
  console.log('QA phase: launch Electron');
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: launchEnvironment, timeout: 60_000 });
  electronProcess = app.process();
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  const cookieFixture = 'qa-website-cookie-secret';
  const appLocalStorageFixture = 'qa-threadterm-local-state';
  await app.evaluate(async ({ session }, cookieFixture) => {
    await session.defaultSession.cookies.set({ url: 'https://threadterm.backup.test', name: 'backup-fixture', value: cookieFixture, path: '/' });
    await session.defaultSession.cookies.flushStore();
  }, cookieFixture);
  await page.evaluate(value => window.localStorage.setItem('threadterm-backup-local-state', value), appLocalStorageFixture);
  const runtimeCredential = await readFile(join(data, 'runtime.credential'), 'utf8');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  console.log('QA phase: open Settings Data');
  await openData();
  const statusBeforeBackup = await bounded(() => request('data.status'), 'data.status before backup', 10_000);
  assert.equal(resolve(statusBeforeBackup.root).toLowerCase(), resolve(data).toLowerCase(), 'backup uses this isolated data root');
  const referencesBeforeBackup = await bounded(() => request('reviewDrafts.assetReferences'), 'review asset references before backup', 10_000);
  console.log(`QA preflight: review legacyImportComplete=${referencesBeforeBackup.legacyImportComplete}`);
  await app.evaluate(({ dialog }, path) => {
    globalThis.__f19DialogUsed = false;
    dialog.showSaveDialog = async () => { globalThis.__f19DialogUsed = true; return { canceled: false, filePath: path }; };
  }, backup);
  await page.getByRole('button', { name: 'Back up ThreadTerm data', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.__f19DialogUsed), true, 'backup invoked the save dialog');
  console.log('QA phase: create backup');
  await waitForBackupResult();
  assert.equal(await page.getByLabel('Backup file to verify').inputValue(), backup, 'backup path is offered for verification');
  const manifest = await archiveManifest(backup);
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const excluded = manifest.excluded ?? [];
  const exclusion = (resource, reason) => excluded.some(item => String(item.resource).includes(resource) && String(item.reason).includes(reason));
  assert.equal(exclusion('desktop/Network', 'website sign-ins'), true, 'manifest excludes website sign-ins with a reason');
  assert.equal(exclusion('runtime.credential', 'recreated on start'), true, 'manifest excludes the runtime credential');
  assert.equal(exclusion('remote-access-key.pem', 'pair mobile devices again'), true, 'manifest excludes device pairing keys');
  assert.equal(await archiveContainsText(backup, cookieFixture), false, 'backup contains no website cookie value');
  assert.equal(await archiveContainsText(backup, runtimeCredential), false, 'backup contains no runtime credential text');
  assert.equal(await archiveContainsText(backup, 'qa-remote-access-key-secret'), false, 'backup contains no remote access key text');
  assert.equal(await archiveContainsText(backup, appLocalStorageFixture), true, 'backup retains ThreadTerm app local storage');
  check('backup excludes website sign-ins and ThreadTerm connection secrets with manifest reasons while retaining app local storage');
  await page.getByRole('button', { name: 'Verify backup', exact: true }).click();
  await until(() => page.locator('.settings-panel [role="status"]').allTextContents().then(values => values.some(value => value.includes('Backup verified'))), 'verification result');
  check('Settings → Data creates and verifies a backup through the save dialog');
  for (const [language, theme, widths] of [
    ['en', 'light', [1280, 1440, 1920]], ['en', 'dark', [1280, 1440, 1920]],
    ['zh-CN', 'light', [1280]], ['zh-CN', 'dark', [1280]],
  ]) {
    await apply(language, theme);
    const notice = await verifyLocalized(language);
    for (const width of widths) {
      await resize(width);
      await shot(`${language}-${theme}-settings-data-${width}.png`, notice);
    }
  }
  check('Settings → Data backup controls render at 1280/1440/1920 in English and at 1280 in Chinese, light and dark');
  const damaged = await corruptFirstBackupFile(backup);
  await assert.rejects(request('data.backup.verify', { path: backup }), error => String(error).includes(damaged));
  await page.getByLabel(/Backup file to verify|待校验的备份文件/).fill(backup);
  await page.getByRole('button', { name: /^(Verify backup|校验备份)$/ }).click();
  await until(() => page.getByRole('alert').textContent().then(value => value?.includes(damaged)), 'visible corrupted backup error');
  await shot('corrupt-backup-error.png', page.getByRole('alert'));
  check('backup verification names the manifest file whose stored bytes were corrupted in the UI');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await shot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log('QA phase: cleanup');
  if (page) await bounded(() => request('runtime.shutdown', { operationId: randomUUID() }), 'renderer runtime shutdown').catch(() => {});
  if (app) {
    await bounded(() => app.evaluate(({ app: electronApp }) => electronApp.exit(0)), 'Electron exit').catch(() => {});
    await bounded(() => app.close(), 'Electron close').catch(() => {});
  }
  await bounded(() => stopOwnedElectronFallback(), 'owned Electron fallback').catch(() => {});
  await bounded(() => shutdownIsolatedRuntimeFallback(), 'authenticated runtime fallback', 20_000).catch(() => {});
  await releaseLock?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (report.passed) await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  else console.log(`QA scratch preserved: ${scratch}`);
  if (report.errors.length) report.passed = false;
  console.log(report.passed ? 'BACKUP DATA QA PASSED' : `BACKUP DATA QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
