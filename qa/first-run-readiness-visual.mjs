// First-run readiness visual QA (F22). This app gets an isolated Desktop 1,
// profile, runtime and PATH; every provider action is a local fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempRoot = resolve(process.env.TEMP || process.env.TMP || tmpdir());
const scratchRoot = join(tempRoot, 'threadterm-first-run-readiness-qa');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, 'run-'));
const out = join(root, 'qa/results/first-run-readiness', `run-${Date.now()}`);
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime)) throw Error(`Refusing non-QA runtime: ${runtime}`);
const report = { passed: false, checks: [], screenshots: [], external: [], requests: [], errors: [] };
let app; let page; let releaseLock;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function until(test, label, timeout = 45_000) { const deadline = Date.now() + timeout; let error; while (Date.now() < deadline) { try { const value = await test(); if (value) return value; } catch (next) { error = next; } await sleep(100); } throw Error(`Timed out: ${label}${error ? ` (${error})` : ''}`); }
function environment({ home, data, plugins, claudeHost }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && !/^(THREADTERM_|CLAUDE_CODE_)/iu.test(key) && !/^(CODEX_HOME|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|ELECTRON_RUN_AS_NODE)$/iu.test(key)));
  const system = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined;
  env.PATH = [dirname(process.execPath), ...(system ? [system] : [])].join(delimiter);
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), CODEX_HOME: join(home, 'codex'), TEMP: scratchRoot, TMP: scratchRoot, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(home, 'profile'), THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PIPE: `\\\\.\\pipe\\first-run-readiness-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_CLAUDE_SDK_HOST: claudeHost });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH'], 'PATH isolation keeps only the fixture/node/System32 path');
  return env;
}
function bridgeFixture() {
  return {
    name: 'first-run-readiness-qa-hook', enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\\\/g, '/').endsWith('/renderer/src/bridge.ts')) return null;
      const snapshotSource = 'export const snapshot = () => facade().request("runtime.snapshot", {});';
      const requestSource = 'export const request = <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => facade().request(method, params);';
      const readinessFixture = 'const __firstRunFixture = (snapshot: any) => { const fixture = (globalThis as any).__RT_FIRST_RUN_READINESS_FIXTURE__; if (fixture) return fixture(snapshot); return { ...snapshot, providers: snapshot.providers.map((row: any) => row.id === "shell" || row.id === "custom" ? row : ({ ...row, installed: false, terminal: false, chat: false, reason: "not_installed" })) }; };';
      const snapshotReplacement = `${readinessFixture} export const snapshot = () => facade().request("runtime.snapshot", {}).then(__firstRunFixture);`;
      const requestReplacement = 'export const request = async <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => { const trace = ((globalThis as any).__RT_FIRST_RUN_READINESS_REQUESTS__ ||= []); trace.push({ method, params }); if (method === "chat.draft.save" && (globalThis as any).__RT_FIRST_RUN_READINESS_DRAFT_SAVE_FAILURES__ > 0) { (globalThis as any).__RT_FIRST_RUN_READINESS_DRAFT_SAVE_FAILURES__--; throw new Error("intentional draft-save failure"); } const result = await facade().request(method, params); return method === "runtime.snapshot" ? __firstRunFixture(result) : result; };';
      const externalSource = 'export const openExternal = (url: string) => facade().openExternal(url);';
      const externalReplacement = 'export const openExternal = async (url: string) => { ((globalThis as any).__RT_FIRST_RUN_READINESS_EXTERNAL__ ||= []).push(url); };';
      if (!code.includes(snapshotSource) || !code.includes(requestSource) || !code.includes(externalSource)) throw Error('first-run readiness QA bridge sources were not found');
      return { code: code.replace(snapshotSource, snapshotReplacement).replace(requestSource, requestReplacement).replace(externalSource, externalReplacement), map: null };
    },
  };
}
async function build(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', plugins: [bridgeFixture()], build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'first-run-readiness-qa', version: '0.0.0', main: 'main.cjs' }));
}
async function setFixture(kind) {
  await page.evaluate(mode => {
    globalThis.__RT_FIRST_RUN_READINESS_FIXTURE__ = snapshot => {
      const ready = snapshot.providers.find(row => row.id === 'first-run-ready');
      const codex = snapshot.providers.find(row => row.id === 'codex');
      const claude = snapshot.providers.find(row => row.id === 'claude');
      const unusable = row => ({ ...row, installed: false, terminal: false, chat: false, reason: 'not_installed', homepage: 'https://fixture.invalid/install' });
      const providers = snapshot.providers.map(row => {
        if (row.id === 'first-run-ready') return mode === 'none' ? unusable(row) : { ...row, name: 'Ready Chat', installed: true, terminal: true, chat: true, auth: 'authenticated', reason: undefined };
        if (row.id === 'codex') return { ...(codex ?? row), id: 'codex', name: 'Codex', installed: false, terminal: false, chat: false, auth: 'unknown', reason: 'not_installed', homepage: 'https://fixture.invalid/install' };
        if (row.id === 'claude') return { ...(claude ?? row), id: 'claude', name: 'Claude Code', installed: true, terminal: true, chat: true, auth: 'unauthenticated', reason: 'signed_out', signIn: { executable: 'node', args: [globalThis.__RT_FIRST_RUN_READINESS_FIXTURE_PATH__, '--acp'], display: 'node fixture --acp' } };
        if (row.id === 'gemini') return { ...row, installed: true, terminal: false, chat: false, reason: 'Version too old' };
        return mode === 'none' ? unusable(row) : row;
      });
      if (!providers.some(row => row.id === 'codex')) providers.push({ id: 'codex', name: 'Codex', installed: false, terminal: false, chat: false, history: false, resume: false, reason: 'not_installed', homepage: 'https://fixture.invalid/install' });
      if (!providers.some(row => row.id === 'claude')) providers.push({ id: 'claude', name: 'Claude Code', installed: true, terminal: true, chat: true, history: false, resume: false, auth: 'unauthenticated', reason: 'signed_out', signIn: { executable: 'node', args: [globalThis.__RT_FIRST_RUN_READINESS_FIXTURE_PATH__, '--acp'], display: 'node fixture --acp' } });
      return { ...snapshot, providers };
    };
  }, kind);
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { theme: snapshot.settings.theme ?? 'light' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await sleep(250);
}
async function settings(language, theme, width) {
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setContentSize(target, target < 700 ? 780 : 900), width);
  await page.waitForFunction(value => document.documentElement.lang === value, language);
}
async function screenshot(name) { await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`); }
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function requestTrace() { return page.evaluate(() => globalThis.__RT_FIRST_RUN_READINESS_REQUESTS__ || []); }
async function externalTrace() { return page.evaluate(() => globalThis.__RT_FIRST_RUN_READINESS_EXTERNAL__ || []); }
async function openMenu() { const chip = page.locator('.composer-agent-chip'); if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click(); const menu = page.locator('.composer-agent-menu'); await menu.waitFor(); return menu; }

try {
  assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
  await mkdir(scratchRoot, { recursive: true }); await mkdir(out, { recursive: true });
  const appDir = join(scratch, 'app'); const plugins = join(scratch, 'plugins'); const pluginDir = join(plugins, 'first-run-ready'); const home = join(scratch, 'home'); const work = join(scratch, 'work');
  await mkdir(pluginDir, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(work, { recursive: true });
  const fixture = join(root, 'qa/fixtures/fake-group-chat.cjs');
  await writeFile(join(pluginDir, 'threadterm-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'first-run-ready', name: 'First-run readiness QA', version: '0.0.0', publisher: 'ThreadTerm QA', description: 'Offline deterministic agent fixture.', contributes: { agents: [{ id: 'first-run-ready', name: 'Ready Chat', command: 'node', args: [fixture], versionArgs: ['--version'], chat: { protocol: 'acp', args: ['--acp'] } }] } }));
  await build(appDir); releaseLock = await acquireElectronQaLock({ directory: tempRoot });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: environment({ home, data: join(scratch, 'data'), plugins, claudeHost: fixture }), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(420, 640));
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });
  await page.evaluate(path => { globalThis.__RT_FIRST_RUN_READINESS_FIXTURE_PATH__ = path; }, fixture);
  await until(async () => (await rpc('plugin.list')).plugins.some(plugin => plugin.id === 'first-run-ready'), 'fixture plugin discovery');
  await rpc('plugin.setEnabled', { pluginId: 'first-run-ready', enabled: true, operationId: randomUUID() });
  await rpc('project.add', { path: work, name: 'First-run readiness QA', operationId: randomUUID() });
  await until(() => page.locator('.start-q').count(), 'Workbench start page');
  const projectPicker = page.getByRole('combobox', { name: 'Choose project' });
  await projectPicker.click();
  await page.getByRole('option', { name: 'First-run readiness QA', exact: true }).click();

  await setFixture('none');
  await until(async () => /No agent is ready\. Install or sign in to an agent\./.test(await page.locator('.workbench-page').innerText()), 'no-agent first-run notice');
  assert.match(await page.locator('.composer-agent-chip').innerText(), /Choose agent/, 'no usable agent does not silently preselect Shell');
  assert.equal(await page.locator('.composer-send').isDisabled(), true, 'start-page send is disabled until an agent is selected');
  await openMenu();
  assert.ok(await page.getByRole('menuitemradio', { name: /Shell/ }).count(), 'Shell remains an explicit start-page choice');
  await screenshot('no-ready-en-light-wide');
  await page.keyboard.press('Escape');
  check('no usable agent shows the first-run notice, Choose agent chip, disabled send, and an explicit Shell choice');

  await setFixture('mixed');
  await until(async () => /Ready Chat/.test(await page.locator('.composer-agent-chip').innerText()), 'usable Chat default');
  const menu = await openMenu();
  const disabled = menu.locator('[role="menuitemradio"]:disabled'); assert.ok(await disabled.count() >= 2, 'unavailable providers remain disabled for session start');
  const installHelp = menu.getByRole('menuitem', { name: /Install/ }).first(); const signInHelp = menu.getByRole('menuitem', { name: /Sign in/ }).first(); const settingsHelp = menu.getByRole('menuitem', { name: /Open provider settings/ }).first();
  await installHelp.focus(); assert.equal(await installHelp.evaluate(node => document.activeElement === node), true, 'Install help is keyboard reachable');
  await signInHelp.focus(); assert.equal(await signInHelp.evaluate(node => document.activeElement === node), true, 'Sign-in help is keyboard reachable');
  assert.ok(await settingsHelp.count(), 'unavailable mode can open provider settings');
  assert.match(await menu.innerText(), /Not installed|Signed out/, 'unavailable rows state their readiness reasons');
  await assertNoControlViolations(await checkControlConsistency(page, '.composer-agent-menu', { checkStates: true, checkDisabledRows: true }), 'start-page readiness menu');
  await installHelp.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('dialog').last(); await confirmation.waitFor(); await confirmation.getByRole('button', { name: /^(Open link|打开链接)$/ }).click();
  await until(async () => (await externalTrace()).includes('https://fixture.invalid/install'), 'mocked external-link confirmation path');
  report.external = await externalTrace();
  check('disabled menu rows expose keyboard-reachable Install, Sign in and settings remediation; Install uses the confirmed external-link path without a browser');

  await openMenu(); await menu.getByRole('menuitem', { name: /Open provider settings/ }).first().click();
  const accounts = page.locator('details.settings-tool-accounts'); assert.equal(await accounts.evaluate(node => node.open), true, 'provider accounts is expanded by the direct settings action'); await page.locator('#provider-settings-title').waitFor();
  check('Open provider settings routes to Settings → Tools → Provider accounts');
  await page.getByRole('button', { name: /Close settings|关闭设置/ }).click();
  await openMenu(); await signInHelp.click();
  await until(async () => (await requestTrace()).some(row => row.method === 'session.create' && row.params?.title?.includes('sign-in')), 'fake sign-in terminal create');
  check('Sign in starts only the fixture terminal flow');
  await page.locator('.ws-back').click();
  await page.locator('.brand-home').click();
  await until(() => page.locator('.composer-agent-chip').count(), 'return to Workbench after sign-in');

  // Visual matrix: same mixed readiness menu in both locales, themes and widths.
  for (const [language, theme, width, size] of [['en', 'light', 1280, 'wide'], ['en', 'light', 560, 'narrow'], ['en', 'dark', 1280, 'wide'], ['en', 'dark', 560, 'narrow'], ['zh-CN', 'light', 1280, 'wide'], ['zh-CN', 'light', 560, 'narrow'], ['zh-CN', 'dark', 1280, 'wide'], ['zh-CN', 'dark', 560, 'narrow']]) {
    await settings(language, theme, width); await until(() => page.locator('.composer-agent-chip').count(), `start-page chip ${language} ${theme} ${size}`); await openMenu(); const box = await menu.boundingBox(); const viewport = await page.evaluate(() => innerWidth); report.checks.push(`viewport ${language} ${theme} ${size}: ${viewport}px`); assert.ok(box && box.x >= -1 && box.x + box.width <= viewport + 1, `agent menu stays inside the ${size} window`); assert.equal(await page.evaluate(({ x, y, width: menuWidth, height }) => { const menu = document.querySelector('.composer-agent-menu'); const interiorY = y + Math.min(12, height / 2); return Boolean(menu?.contains(document.elementFromPoint(x + 2, interiorY)) && menu?.contains(document.elementFromPoint(x + menuWidth - 2, interiorY))); }, box), true, `agent menu is not ancestor-clipped in the ${size} window`); assert.equal(await page.locator('.main').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `main area has no horizontal overflow in the ${size} window`); await screenshot(`readiness-${language}-${theme}-${size}`); await page.keyboard.press('Escape');
  }
  check('captured the en/zh × light/dark × wide/narrow readiness matrix');
  await settings('en', 'light', 1280);
  const draft = 'Prepare the first safe task';
  const startDraft = page.getByRole('textbox', { name: 'Chat draft' });
  await startDraft.fill(draft); await page.locator('.composer-send').click();
  const dialog = page.getByTestId('session-create-dialog'); await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true', 'ready Chat is preferred for the start-page flow');
  assert.ok(await dialog.locator('.provider-choice:has(.create-type:disabled) .provider-readiness-action').count(), 'dialog unavailable provider is disabled with a sibling remediation action');
  for (const [language, theme, width, size] of [['en', 'light', 1280, 'wide'], ['en', 'light', 560, 'narrow'], ['en', 'dark', 1280, 'wide'], ['en', 'dark', 560, 'narrow'], ['zh-CN', 'light', 1280, 'wide'], ['zh-CN', 'light', 560, 'narrow'], ['zh-CN', 'dark', 1280, 'wide'], ['zh-CN', 'dark', 560, 'narrow']]) {
    await settings(language, theme, width);
    await dialog.waitFor();
    const viewport = await page.evaluate(() => innerWidth);
    report.checks.push(`dialog viewport ${language} ${theme} ${size}: ${viewport}px`);
    const dialogHelpLayout = await dialog.locator('.provider-readiness-action').evaluateAll(buttons => buttons.map(button => {
      const action = button.getBoundingClientRect();
      const choice = button.closest('.provider-choice')?.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(button);
      const textRects = [...range.getClientRects()];
      return {
        textInside: textRects.every(rect => rect.left >= action.left - 0.5 && rect.right <= action.right + 0.5 && rect.top >= action.top - 0.5 && rect.bottom <= action.bottom + 0.5),
        actionInsideChoice: Boolean(choice && action.bottom <= choice.bottom + 0.5),
      };
    }));
    assert.ok(dialogHelpLayout.every(result => result.textInside && result.actionInsideChoice), `dialog remediation actions fit their text and provider rows in the ${size} window`);
    await screenshot(`dialog-provider-reasons-${language}-${theme}-${size}`);
  }
  check('captured the en/zh × light/dark × wide/narrow provider-readiness dialog matrix');
  await settings('en', 'light', 1280);
  await page.evaluate(() => { globalThis.__RT_FIRST_RUN_READINESS_DRAFT_SAVE_FAILURES__ = 1; });
  const createButton = page.getByRole('dialog').last().getByRole('button', { name: 'Create', exact: true });
  await createButton.click();
  await page.getByText('intentional draft-save failure', { exact: false }).waitFor();
  await createButton.click();
  await until(async () => (await requestTrace()).filter(row => row.method === 'chat.draft.save' && row.params?.text === draft).length >= 2, 'initial Chat draft retry saved');
  const trace = await requestTrace(); const createdAt = trace.findIndex(row => row.method === 'session.create' && row.params?.mode === 'chat'); const savedAt = trace.findIndex(row => row.method === 'chat.draft.save' && row.params?.text === draft);
  assert.ok(createdAt >= 0 && savedAt > createdAt, 'the Chat session is created before its initial draft is saved');
  assert.equal(trace.filter(row => row.method === 'session.create' && row.params?.mode === 'chat').length, 1, 'draft retry reuses the already-created Chat');
  assert.equal(trace.some(row => row.method === 'chat.send' && row.params?.text === draft), false, 'initial draft is never auto-sent');
  const composer = page.locator('.chat-compose-shell textarea'); await composer.waitFor(); assert.equal(await composer.inputValue(), draft, 'created Chat composer contains the unsent initial draft');
  await screenshot('chat-draft-unsent-en-light-wide');
  check('start-page Chat draft becomes a saved, unsent composer draft after session creation; a save retry reuses that Chat');
  report.requests = await requestTrace();
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await screenshot('failure').catch(() => undefined);
} finally {
  if (page) report.requests = await requestTrace().catch(() => report.requests);
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => undefined);
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); }
  await releaseLock?.().catch(() => undefined);
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  console.log(report.passed ? 'FIRST-RUN READINESS VISUAL QA PASSED' : `FIRST-RUN READINESS VISUAL QA FAILED\n${report.errors.join('\n')}`);
  if (!report.passed) process.exitCode = 1;
}
