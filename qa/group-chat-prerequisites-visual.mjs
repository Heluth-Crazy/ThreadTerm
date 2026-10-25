// Focused prerequisite visual QA. Run after qa/group-chat-visual.mjs has built the QA runtime.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { checkControlConsistency, assertNoControlViolations } from './lib/visual-consistency.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempRoot = resolve(process.env.TEMP || process.env.TMP || tmpdir());
const scratchRoot = join(tempRoot, 'threadterm-group-chat-qa');
const scratch = join(scratchRoot, `prerequisites-${Date.now()}-${randomUUID().slice(0, 8)}`);
const out = join(root, 'qa/results/group-chat/rt2b');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime)) throw Error(`Refusing non-QA runtime: ${runtime}`);
const lock = join(tempRoot, 'qa-electron.lock');
const report = { passed: false, screenshots: [], checks: [], errors: [] };
let lockHeld = false;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function until(test, label, timeout = 60_000) { const end = Date.now() + timeout; for (;;) { const value = await test(); if (value) return value; if (Date.now() >= end) throw Error(`Timed out: ${label}`); await delay(200); } }
function command(name) { const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true }); const found = probe.status === 0 && probe.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean); if (!found) throw Error(`Required QA command not found: ${name}`); return resolve(found); }
function environment({ git, home, data, plugins, events }) { const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && !/^(THREADTERM_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|ELECTRON_RUN_AS_NODE)/i.test(key))); const system = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined; env.PATH = [dirname(process.execPath), ...(git ? [dirname(git)] : []), ...(system ? [system] : [])].join(delimiter); Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex'), TEMP: scratchRoot, TMP: scratchRoot, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(home, 'profile'), THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PIPE: `\\\\.\\pipe\\group-chat-prerequisites-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_GROUP_EVENTS: events }); return env; }
async function lockAcquire() { const end = Date.now() + 40 * 60_000; for (;;) { try { await mkdir(lock); lockHeld = true; return; } catch (error) { if (error?.code !== 'EEXIST') throw error; if (Date.now() >= end) throw Error('Timed out waiting for Electron QA lock'); await delay(15_000); } } }
async function build(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  const bridgeHook = {
    name: 'group-chat-prerequisites-qa-hook', enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/renderer/src/bridge.ts')) return null;
      const source = 'export const request = <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => facade().request(method, params);';
      const replacement = 'export const request = async <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => { const result = await facade().request(method, params); const hook = (globalThis as any).__RT_PREREQUISITE_FIXTURE__; return method === "group.prerequisites" && hook ? hook(result) : result; };';
      if (!code.includes(source)) throw Error('QA bridge hook source was not found');
      return { code: code.replace(source, replacement), map: null };
    },
  };
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', plugins: [bridgeHook], build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'group-chat-prerequisites-qa', version: '0.0.0', main: 'main.cjs' }));
}
async function screenshot(page, name) { await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`); }
async function settings(request, page, language, theme) { const snapshot = await request('runtime.snapshot'); await request('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() }); await page.waitForFunction(value => document.documentElement.lang === value, language); }
async function profile({ name, appDir, fixture, git, folder, prerequisiteFixture, expectBlocked, readOnlyFolder }) {
  const base = join(scratch, name); const plugins = join(base, 'plugins'); const pluginDir = join(plugins, 'group-chat-prerequisites'); const home = join(base, 'home'); await mkdir(pluginDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(pluginDir, 'threadterm-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'group-chat-prerequisites', name: 'Group chat prerequisites QA', version: '0.0.0', publisher: 'ThreadTerm QA', description: 'Offline deterministic prerequisite fixture.', contributes: { agents: [{ id: 'group-chat-prerequisite-agent', name: 'Group chat fixture agent', command: 'node', args: [fixture], versionArgs: ['--version'], chat: { protocol: 'acp', args: ['--acp'] } }] } }));
  const app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: environment({ git, home, data: join(base, 'data'), plugins, events: join(base, 'events.jsonl') }), timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 45_000 }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900)); page.setDefaultTimeout(20_000); const request = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
  try {
    await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });
    const project = await request('project.add', { path: folder, name: 'Group chat prerequisites QA', operationId: randomUUID() }); assert.ok(project.id);
    await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'group-chat-prerequisites'), 'fixture plugin discovery'); await request('plugin.setEnabled', { pluginId: 'group-chat-prerequisites', enabled: true, operationId: randomUUID() });
    if (prerequisiteFixture) await page.evaluate(blocked => { globalThis.__RT_PREREQUISITE_FIXTURE__ = result => ({ ...result, providers: result.providers.map(row => row.provider === 'group-chat-prerequisite-agent' && !blocked ? { ...row, usable: true, readOnly: 'prompt', readOnlyNote: 'Fixture read-only by instruction.' } : row.provider === 'codex' ? { ...row, usable: false, reason: 'not_installed', fix: { kind: 'install', text: 'Install the fixture provider.', homepage: 'https://fixture.invalid/install' } } : { ...row, usable: false, reason: 'signed_out', fix: { kind: 'sign_in', text: 'Sign in to the fixture provider.' } }) }); }, prerequisiteFixture === 'blocked');
    await page.locator('.nav-item.new').click(); const dialog = page.getByTestId('session-create-dialog'); await dialog.waitFor(); await dialog.getByTestId('session-kind-group').click(); await dialog.locator('input[placeholder]').first().fill('Group prerequisites');
    if (prerequisiteFixture) {
      await until(() => page.getByTestId('group-provider-notice').count().then(count => count >= 2), 'provider remediation notices');
      if (expectBlocked) {
        assert.equal(await page.getByTestId('group-create').isDisabled(), true, 'zero usable providers disable Create');
        await page.getByTestId('group-needs-agent').waitFor();
      } else {
        const providerSelect = dialog.getByTestId('group-member-0').getByRole('combobox').first();
        await providerSelect.click();
        const options = await page.getByRole('option').evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-disabled') === 'true').map(node => ({ value: node.getAttribute('data-value'), text: node.textContent ?? '', title: node.getAttribute('title') ?? '' })));
        await providerSelect.press('Escape');
        assert.ok(options.some(option => option.value === 'codex'), 'not-installed provider option is disabled');
        assert.ok(options.some(option => option.value !== 'group-chat-prerequisite-agent'), 'signed-out provider option is disabled');
        const more = dialog.getByTestId('group-other-notices');
        assert.equal(await more.evaluate(node => node.open), false, 'unavailable agents that no seat uses start folded');
        await more.locator('summary').click(); await until(() => more.evaluate(node => node.open), 'expanded unavailable agents');
        await screenshot(page, `${name}-expanded-1280`);
        assert.ok(await page.getByRole('button', { name: /Open homepage/i }).count(), 'provider notice renders a homepage action when remediation supplies one');
        await more.locator('summary').click(); await until(() => more.evaluate(node => !node.open), 'folded unavailable agents');
        assert.equal(await page.getByTestId('group-create').isDisabled(), false, 'one usable provider supports repeated seats');
      }
    }
    // Assert and capture only once the folder's prerequisites have loaded: a usable seat and an enabled Create.
    const settled = () => until(async () => !(await page.getByTestId('group-create').isDisabled()) && !/unavailable|不可用/.test(await dialog.getByTestId('group-member-0').innerText().catch(() => 'unavailable')), 'group prerequisites loaded');
    if (readOnlyFolder) { await settled(); assert.doesNotMatch(await dialog.innerText(), /Git not found|Not a Git repository|未找到 Git|不是 Git 仓库/, 'the create dialog must not claim Git is required for read-only file checks'); }
    const screenshotFocus = expectBlocked ? page.getByTestId('group-needs-agent') : dialog;
    for (const [language, theme] of [['en', 'light'], ['zh-CN', 'dark']]) { await settings(request, page, language, theme); if (!expectBlocked) await settled(); await assertNoControlViolations(await checkControlConsistency(page, '[role="dialog"] .group-members', { checkStates: true, checkDisabledRows: true }), `${name} Group chat participant controls`); await screenshotFocus.scrollIntoViewIfNeeded(); await screenshot(page, `${name}-${language}-${theme}-1280`); }
    if (expectBlocked) { check(`${name} disabled-provider remediation and no-agent blocker`); return; }
    if (readOnlyFolder) { const mode = dialog.getByTestId('group-member-0').getByRole('combobox').nth(1); await mode.click(); await page.locator('[role=option][data-value="read_only"]').click(); }
    await settings(request, page, 'en', 'light'); await page.getByTestId('group-create').click(); await page.getByTestId('group-view').waitFor({ timeout: 60_000 });
    if (readOnlyFolder) {
      // Change attribution compares the folder itself (group_folder snapshots), so a read-only
      // room works without Git and outside a repository and must not warn about either.
      const line = page.getByTestId('group-view').locator('.gc-files-check');
      assert.equal(await line.count(), 0, 'no file-check prerequisite notice in a room without Git');
      for (const [language, theme] of [['en', 'light'], ['zh-CN', 'dark']]) { await settings(request, page, language, theme); await screenshot(page, `${name}-room-${language}-${theme}-1280`); }
      check(`${name} read-only room and room file-check state`);
    } else check(`${name} prerequisites and repeated seats`);
  } finally { await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
}
try {
  assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`); await mkdir(scratchRoot, { recursive: true }); await mkdir(out, { recursive: true }); await lockAcquire(); const appDir = join(scratch, 'app'); const repository = join(scratch, 'repository'); const plain = join(scratch, 'plain'); const fixture = join(root, 'qa/fixtures/fake-group-chat.cjs'); const git = command('git'); await mkdir(repository, { recursive: true }); await mkdir(plain, { recursive: true }); await writeFile(join(repository, 'README.md'), 'fixture\n'); execFileSync(git, ['init', '-q'], { cwd: repository, windowsHide: true }); await build(appDir);
  await profile({ name: 'group-chat-prerequisites', appDir, fixture, git, folder: repository, prerequisiteFixture: true });
  await profile({ name: 'group-chat-no-usable', appDir, fixture, git, folder: repository, prerequisiteFixture: 'blocked', expectBlocked: true });
  await profile({ name: 'group-chat-nonrepo', appDir, fixture, git, folder: plain, readOnlyFolder: true });
  await profile({ name: 'group-chat-nogit', appDir, fixture, folder: plain, readOnlyFolder: true }); report.passed = true;
} catch (error) { report.errors.push(String(error?.stack ?? error)); } finally { if (lockHeld) await rm(lock, { recursive: true, force: true }).catch(() => {}); await writeFile(join(out, 'prerequisites-report.json'), JSON.stringify(report, null, 2)); await rm(scratch, { recursive: true, force: true }).catch(() => {}); console.log(report.passed ? 'GROUP CHAT PREREQUISITES VISUAL QA PASSED' : `GROUP CHAT PREREQUISITES VISUAL QA FAILED\n${report.errors.join('\n')}`); if (!report.passed) process.exitCode = 1; }




