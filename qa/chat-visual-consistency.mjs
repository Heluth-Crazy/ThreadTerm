// Desktop-1 real-app visual-consistency QA for the Chat pane (V1, issue VC).
// It starts the production app on an isolated profile/data/pipe with a fake ACP
// plugin that emits a plan, a read, a search, a failed command, a two-file edit
// and a final answer with a code block. It then runs the shared
// qa/lib/visual-consistency.mjs helper over every Chat surface in the
// wide/420 x light/dark/custom x en/zh-CN matrix and asserts zero violations.
// It never starts a real agent CLI and never touches the user's profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/chat-visual-echo-acp');
const requiredSurfacesFixture = join(root, 'qa/fixtures/chat-visual-required-surfaces.tsx');
const out = join(root, 'qa/results/chat-parity/V1/chat-visual-consistency');
const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-visual-'));
const appDir = join(scratch, 'app');
const plugins = join(scratch, 'plugins');
const work = join(scratch, 'repo');
const report = { passed: false, checks: [], screenshots: [], visualConsistency: [], errors: [] };
// Finding 13 needs the complete violation list in one run. Collect every
// surface/cell violation here while keeping every assertion, then fail once
// before the run can be considered passed.
const controlViolations = [];
const surfaceFailures = [];
function recordControlViolations(label, result) {
  if (result.error) { surfaceFailures.push(`${label}: ${result.error}`); return; }
  if (result.violations.length) controlViolations.push({ label, violations: result.violations });
}
function recordSurfaceFailure(message) { surfaceFailures.push(message); }
let app; let page; let supplementaryApp;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await page.mouse.move(2, 2).catch(() => undefined); await delay(150); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'chat-visual-consistency-qa', version: '0.1.0', main: 'main.cjs' }));
}

/** Runs the helper on one surface after scrolling it into view. */
async function checkSurface(selector, label) {
  const instances = page.locator(selector);
  const count = await instances.count();
  if (!count) { recordSurfaceFailure(`${label}: required surface is present`); return { checked: 0 }; }
  let checked = 0;
  for (let index = 0; index < count; index += 1) {
    const instance = instances.nth(index);
    const probe = `vc-surface-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index}`;
    try {
      await instance.evaluate((node, value) => node.setAttribute('data-vc-surface', value), probe);
      await instance.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => undefined);
      const result = await checkControlConsistency(page, `[data-vc-surface="${probe}"]`);
      assert.ok(result.checked > 0, `${label} #${index + 1}: the helper collected visible controls`);
      checked += result.checked;
      report.visualConsistency.push({ label: `${label} #${index + 1}`, ...result, violations: result.violations });
      recordControlViolations(`${label} #${index + 1}`, result);
    } catch (error) {
      recordSurfaceFailure(`${label} #${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await instance.evaluate(node => node.removeAttribute('data-vc-surface')).catch(() => undefined);
    }
  }
  return { checked };
}

// BEGIN supplementary required-surface fixture (finding 13)
// The ACP fixture above owns plan/tool/reply coverage. These cards come from
// incompatible native protocols, so this production-ChatView bundle supplies
// contract-shaped fake bridge snapshots without starting another provider.
async function checkRequiredSurfacesMatrix() {
  const fixtureDir = join(scratch, 'required-surfaces');
  await mkdir(fixtureDir, { recursive: true });
  await esbuild({ entryPoints: [requiredSurfacesFixture], bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', outfile: join(fixtureDir, 'fixture.js'), logLevel: 'error' });
  await writeFile(join(fixtureDir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;min-height:0}</style><div id="root"></div><script src="fixture.js"></script>');
  await writeFile(join(fixtureDir, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(join(fixtureDir, 'profile'))}); app.whenReady().then(() => new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }).loadFile(${JSON.stringify(join(fixtureDir, 'index.html'))}));`);
  const supplementaryEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  supplementaryEnv.PATH = [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
  assert.equal(Object.keys(supplementaryEnv).filter(key => key.toLowerCase() === 'path').length, 1, 'supplementary fixture PATH is isolated');
  supplementaryApp = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(fixtureDir, 'main.cjs')], cwd: root, env: supplementaryEnv, timeout: 60_000 });
  const supplementaryPage = await supplementaryApp.firstWindow({ timeout: 30_000 });
  supplementaryPage.setDefaultTimeout(20_000);
  supplementaryPage.on('pageerror', error => report.errors.push(`required surfaces page: ${error.message}`));
  await supplementaryPage.waitForFunction(() => typeof window.qaRequiredSurfaces?.mount === 'function');
  await supplementaryPage.evaluate(() => localStorage.setItem('threadterm.compose.context.visual-required-surfaces', JSON.stringify([{ kind: 'file', id: 'required-context', path: 'src/required.ts', startLine: 1, endLine: 2 }])));
  const required = [
    ['approval card', '.chat-approval-card:not(.chat-question-wrapper)'],
    ['question card', '.chat-question-wrapper'],
    ['queue row', '[data-testid="chat-queue-item"]'],
    ['context tray', '[data-testid="context-tray"]'],
    ['subagent card', '.chat-subagent-card'],
    ['usage card', '[data-testid="plan-usage-card"]'],
    ['repair banner', '.chat-repair-banner'],
    ['network banner', '.chat-network-notice'],
  ];
  for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    await supplementaryApp.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await supplementaryPage.evaluate(([nextLocale, nextTheme]) => window.qaRequiredSurfaces.mount(nextLocale, nextTheme), [locale, theme]);
    await supplementaryPage.locator('.chat-compose-shell').waitFor();
    await supplementaryPage.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    for (const [label, selector] of required) {
      const instances = supplementaryPage.locator(selector);
      const count = await instances.count();
      if (!count) { recordSurfaceFailure(`${label} ${theme}/${locale}/${width}: required surface is present`); continue; }
      for (let index = 0; index < count; index += 1) {
        const instance = instances.nth(index);
        const probe = `vc-required-${theme}-${locale}-${width}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index}`;
        try {
          await instance.evaluate((node, value) => node.setAttribute('data-vc-surface', value), probe);
          await instance.scrollIntoViewIfNeeded();
          const bounds = await instance.boundingBox();
          assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${label} ${theme}/${locale}/${width} #${index + 1}: the required surface is visible`);
          const result = await checkControlConsistency(supplementaryPage, `[data-vc-surface="${probe}"]`);
          if (['approval card', 'question card', 'queue row', 'context tray'].includes(label)) {
            assert.ok(result.checked > 0, `${label} ${theme}/${locale}/${width} #${index + 1}: controls are visible to the helper`);
          }
          report.visualConsistency.push({ label: `${label} ${theme}/${locale}/${width} #${index + 1}`, ...result, violations: result.violations });
          recordControlViolations(`${label} ${theme}/${locale}/${width} #${index + 1}`, result);
          const name = `required-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index + 1}-${theme}-${width}-${locale}.png`;
          await supplementaryPage.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name);
        } catch (error) {
          recordSurfaceFailure(`${label} ${theme}/${locale}/${width} #${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await instance.evaluate(node => node.removeAttribute('data-vc-surface')).catch(() => undefined);
        }
      }
    }
    if (theme === 'custom') {
      const surface = await supplementaryPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
      assert.equal(surface.toLowerCase(), '#182430', `custom ${locale}/${width} remaps the supplementary surface token`);
    }
  }
  await supplementaryApp.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await supplementaryApp.close().catch(() => {}); supplementaryApp = undefined;
  check('wide/420, light/dark/custom, en/zh-CN: approval/question, queue, context, subagent/usage, repair and network surfaces are present and have zero helper violations');
}
// END supplementary required-surface fixture

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing chat-visual Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await mkdir(plugins, { recursive: true }); cpSync(fixture, join(plugins, 'chat-visual-echo-acp'), { recursive: true });
  await buildApp();
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value))
    || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-visual-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');

  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src/app.ts'), 'const version = 0;\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial');

  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });

  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'chat-visual-echo-acp'), 'Chat visual Echo discovered');
  await request('plugin.setEnabled', { pluginId: 'chat-visual-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'chat-visual-echo' && row.chat), 'Chat visual Echo enabled');

  const project = await request('project.add', { path: work, name: 'Chat visual QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Chat visual QA', provider: 'chat-visual-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = chatScope(chat.id);
  const composer = scope.locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'chat composer ready');
  await composer.fill('Emit the plan, tools and a final answer.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, 'tool drawer appears');
  await until(async () => (await request('chat.snapshot', { sessionId: chat.id })).items.some(item => item.parts?.some(part => part.type === 'text' && /Chat visual fixture complete/.test(part.text ?? ''))), 'turn completion');
  await until(() => scope.locator('.chat-plan-panel').count(), 'plan panel appears');
  await delay(400);

  const drawer = scope.locator('.chat-tool-activity');
  if (!(await drawer.evaluate(node => node.open))) await drawer.locator('> summary').click();
  await until(async () => (await scope.locator('.tool-card-body').count()) === 4, 'four card bodies');
  check('one session shows the plan, the tool drawer/cards, the reply copy and the code-block copy');

  // V1-6: the drawer chevron follows the app's shared disclosure convention:
  // closed points right (no rotation), open rotates a quarter turn to point down.
  // This is the rule 846c272 used and workbench.css / subagent-card.css still use.
  const chevronRotation = () => scope.locator('.chat-tool-chevron').first().evaluate(node => {
    const transform = getComputedStyle(node).transform;
    if (transform === 'none') return 0;
    const match = transform.match(/^matrix\(([^)]+)\)$/);
    if (!match) return null;
    const [a, b] = match[1].split(',').map(value => Number(value.trim()));
    return Math.round(Math.atan2(b, a) * 180 / Math.PI);
  });
  if (await drawer.evaluate(node => node.open)) {
    await drawer.locator('> summary').click();
    await until(async () => !(await drawer.evaluate(node => node.open)), 'drawer collapsed for the chevron check');
  }
  const collapsedChevron = await chevronRotation();
  assert.equal(collapsedChevron, 0, `the collapsed drawer chevron points right (rotation ${collapsedChevron})`);
  await drawer.locator('> summary').click();
  await until(async () => (await drawer.evaluate(node => node.open)), 'drawer re-expanded for the chevron check');
  const expandedChevron = await chevronRotation();
  assert.equal(((expandedChevron % 360) + 360) % 360, 90, `the expanded drawer chevron points down (rotation ${expandedChevron})`);
  check('V1-6 the tool drawer chevron keeps the shared disclosure direction (right collapsed, down expanded)');

  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const surfaces = [
    ['plan panel', '.chat-plan-panel'],
    ['tool card', '.chat-tool-entry'],
    ['tool drawer', '.chat-tool-activity-card'],
    ['reply actions', '.v3-chat-message.has-reply-actions'],
    ['code copy', '.md-code-block'],
    ['composer', '.chat-compose-shell'],
  ];

  for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    const snapshot = await request('runtime.snapshot');
    const patch = theme === 'custom'
      ? { language: locale, theme: 'dark', themeSelection: 'custom:qa', customThemes: { qa: custom } }
      : { language: locale, theme, themeSelection: theme };
    await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, `${theme}/${locale}/${width} drawer`);
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === 'custom' ? 'dark' : theme);
    if (theme === 'custom') await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
    for (const [label, selector] of surfaces) {
      if (!(await page.locator(selector).count() > 0)) { recordSurfaceFailure(`${label} ${theme}/${locale}/${width}: required surface is present`); continue; }
      const result = await checkSurface(selector, `${label} ${theme}/${locale}/${width}`);
      assert.ok(result.checked >= 1, `${label} ${theme}/${locale}/${width}: the helper saw at least one control`);
      if (result.checked < 1) surfaceFailures.push(`${label} ${theme}/${locale}/${width}: no control collected`);
    }
    // V1-1: the tool header is one deliberate line. The headline ellipsizes and
    // the failure/Collapse/chevron controls stay on line 1; the turn summary is
    // its own line 2. No control is ever alone on a wrapped line.
    const header = await scope.locator('.chat-tool-head').first().evaluate(node => {
      const boxes = {};
      for (const name of ['.chat-tool-current-action', '.chat-tool-active-count', '.chat-tool-failed-count', '.chat-tool-collapse-label', '.chat-tool-chevron']) {
        const element = node.querySelector(name);
        if (element) { const rect = element.getBoundingClientRect(); boxes[name] = { top: rect.top, center: rect.top + rect.height / 2 }; }
      }
      const count = node.parentElement && node.parentElement.querySelector('.chat-tool-count');
      const headRect = node.getBoundingClientRect();
      const chevron = node.querySelector('.chat-tool-chevron');
      const chevronTransform = chevron ? getComputedStyle(chevron).transform : 'none';
      let chevronRotation = 0;
      if (chevronTransform && chevronTransform !== 'none') {
        const match = chevronTransform.match(/^matrix\(([^)]+)\)$/);
        if (match) { const [a, b] = match[1].split(',').map(value => Number(value.trim())); chevronRotation = Math.round(Math.atan2(b, a) * 180 / Math.PI); }
      }
      return { boxes, countTop: count ? count.getBoundingClientRect().top : null, headBottom: headRect.bottom, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, flexWrap: getComputedStyle(node).flexWrap, chevronRotation };
    });
    const headerCenters = Object.values(header.boxes).map(box => box.center);
    assert.ok(headerCenters.length >= 3, `${theme}/${locale}/${width}: the header exposes the headline, failure count and chevron`);
    assert.ok(Math.max(...headerCenters) - Math.min(...headerCenters) <= 1.5, `${theme}/${locale}/${width}: the header controls share one line ${JSON.stringify(header.boxes)}`);
    assert.equal(header.flexWrap, 'nowrap', `${theme}/${locale}/${width}: the header never wraps`);
    assert.ok(header.scrollWidth <= header.clientWidth + 1, `${theme}/${locale}/${width}: the headline ellipsizes instead of overflowing (${header.scrollWidth} > ${header.clientWidth})`);
    assert.ok(header.countTop === null || header.countTop >= header.headBottom - 1, `${theme}/${locale}/${width}: the turn summary sits on its own line below the header`);
    assert.equal(((header.chevronRotation % 360) + 360) % 360, 90, `${theme}/${locale}/${width}: the expanded drawer chevron points down (rotation ${header.chevronRotation})`);
    // V1-5: the floating overlay keeps the shared .btn surface and a real shadow,
    // and the transcript reserve clears its height so it cannot cover the card.
    await scope.locator('.v3-chat-log').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await until(() => scope.locator('.chat-back-to-bottom').count(), `${theme}/${locale}/${width} back-to-bottom overlay`);
    const backToBottom = await scope.locator('.chat-back-to-bottom').evaluate(node => ({ classes: node.className, shadow: getComputedStyle(node).boxShadow, background: getComputedStyle(node).backgroundColor }));
    assert.match(backToBottom.classes, /(^|\s)btn(\s|$)/, `${theme}/${locale}/${width}: the overlay uses the shared .btn surface`);
    assert.notEqual(backToBottom.shadow, 'none', `${theme}/${locale}/${width}: the overlay has the shared overlay shadow`);
    const reserve = await scope.locator('.v3-chat-log').evaluate(node => parseFloat(getComputedStyle(node).paddingBottom) || 0);
    assert.ok(reserve >= 40, `${theme}/${locale}/${width}: the transcript reserves the overlay height (${reserve}px)`);
    await shot(`chat-${theme}-${width}-${locale}.png`);
  }
  check('V1-1 the tool header keeps its controls on one line with an ellipsized headline and an own-line summary');
  check('V1-5 the back-to-bottom overlay keeps a shared .btn surface, a real shadow and a 52 px reserve');
  check('wide/420, light/dark/custom, en/zh-CN: zero helper violations on the plan, tool cards, drawer, reply actions, code copy and composer');
  await checkRequiredSurfacesMatrix();

  // The custom-theme screenshot must show a measurably different surface.
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { theme: 'dark', themeSelection: 'custom:qa', customThemes: { qa: custom } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
  const customSurface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
  assert.equal(customSurface.toLowerCase(), custom.surface, 'the custom surface token is applied');
  check('the custom theme remaps the surface/accent tokens (helper ran against it)');

  // Fail once with the complete list after every surface and matrix cell ran.
  if (controlViolations.length || surfaceFailures.length) {
    report.controlViolations = controlViolations;
    report.surfaceFailures = surfaceFailures;
    const lines = [
      ...controlViolations.flatMap(entry => entry.violations.map(violation => `  - ${entry.label}: [${violation.kind}] ${violation.message}`)),
      ...surfaceFailures.map(message => `  - ${message}`),
    ];
    throw new Error(`${controlViolations.length} surface(s) with control-consistency violations and ${surfaceFailures.length} surface failure(s):\n${lines.join('\n')}`);
  }

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (supplementaryApp) { await supplementaryApp.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await supplementaryApp.close().catch(() => {}); }
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'CHAT VISUAL-CONSISTENCY QA PASSED' : `CHAT VISUAL-CONSISTENCY QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
