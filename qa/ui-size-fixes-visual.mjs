// Real app sizing regression: isolated runtime/profile, no agent CLI or network fixtures.
// TEMP must point at the shared QA scratch directory. Run with `before` or `after`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const phase = process.argv[2] ?? 'after';
assert.ok(['before', 'after'].includes(phase));
const root = resolve(import.meta.dirname, '..');
const out = resolve(process.env.THREADTERM_QA_OUTPUT_DIR ?? join(root, 'qa/results/ui-size-fixes', phase));
const scratch = await mkdtemp(join(tmpdir(), 'tt-ui-size-'));
const work = join(scratch, 'work'), bin = join(scratch, 'bin');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), 'build the isolated QA runtime first');
const report = { phase, scratch, checks: [], measurements: {}, screenshots: [], errors: [] };
let app, page, releaseLock, qaApp;
const check = (id, passed, detail) => {
  report.checks.push({ id, passed: Boolean(passed), detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(detail)}`);
};
const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
async function size(width, height = 800) {
  // Use the actual outer window minimum, including native frame chrome.
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(...bounds), [width, height]);
  await frames();
}
async function appearance(theme, language = 'en') {
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { theme, themeSelection: theme, language }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  await frames();
}
async function shot(name) {
  await page.mouse.move(0, 0); await frames();
  await page.screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}
async function settings(tab) {
  await page.locator('.user-row').click();
  await page.locator('.account-menu').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
async function closeSettings() { await page.getByRole('button', { name: 'Close settings', exact: true }).click(); }
async function widths() {
  return page.locator('.runtime-workspace .ws-content:has(> .wb-sidebar)').evaluate(node => {
    const width = selector => node.querySelector(selector)?.getBoundingClientRect().width ?? 0;
    return { content: node.clientWidth, sidebar: width('.wb-sidebar'), pane: width('.ws-pane'), inspector: width('.inspector'), stored: JSON.parse(localStorage.getItem('threadterm.workbench.sidebar')).width, viewport: innerWidth };
  });
}
async function headerGeometry() {
  return page.locator('.usage-head').evaluate(node => {
    const rect = node.getBoundingClientRect(), children = [...node.children].map(child => ({ name: child.className || child.tagName, ...child.getBoundingClientRect().toJSON() }));
    const refresh = node.querySelector('button[aria-label="Refresh usage"]').getBoundingClientRect();
    const visible = children.filter(child => child.width > 0 && child.height > 0), style = getComputedStyle(node);
    const topGap = Math.min(...visible.map(child => child.top)) - rect.top - parseFloat(style.borderTopWidth);
    const bottomGap = rect.bottom - parseFloat(style.borderBottomWidth) - Math.max(...visible.map(child => child.bottom));
    return { header: rect.toJSON(), topGap, bottomGap, viewport: innerWidth, children, refresh: refresh.toJSON(), chips: [...node.querySelectorAll('.usage-filter')].map(child => child.getBoundingClientRect().width), overflow: children.filter(child => child.width > 0 && (child.left < rect.left - 1 || child.right > rect.right + 1 || child.top < rect.top - 1 || child.bottom > rect.bottom + 1)) };
  });
}
try {
  await mkdir(out, { recursive: true });
  for (const folder of [work, bin, 'home', 'data', 'profile', 'plugins'].map(value => resolve(scratch, value))) await mkdir(folder, { recursive: true });
  await writeFile(join(work, 'sizing.txt'), 'UI sizing fixture\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|pi_coding_agent_dir|kimi_code_home|grok_home|xdg_data_home|xdg_config_home|threadterm_.*|electron_run_as_node)$/i.test(key)));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
    CODEX_HOME: join(scratch, 'codex'), CLAUDE_CONFIG_DIR: join(scratch, 'claude'), PI_CODING_AGENT_DIR: join(scratch, 'pi'), KIMI_CODE_HOME: join(scratch, 'kimi'), GROK_HOME: join(scratch, 'grok'), XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-ui-size-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'),
  });
  qaApp = await buildQaApp();
  // Only breakdown responses are fixtures: real page state/clicks create all three filter chips.
  // All other requests use the isolated runtime; there are no real provider histories.
  const fixture = `import {ipcRenderer} from 'electron';
import ${JSON.stringify(join(root, 'desktop/src/preload.ts').replaceAll('\\', '/'))};
const invoke=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel,...args)=>{
 if(channel==='threadterm:request'&&args[0]==='usage.ledger.breakdown'){
  const dimension=args[1].dimension;
  const summary=await invoke(channel,'usage.ledger.summary',{filters:args[1].filters});
  const snapshot=await invoke(channel,'runtime.snapshot',{});
  const key=dimension==='project'?snapshot.projects[0].id:dimension==='provider'?'sizing-fixture-provider':'sizing-fixture-model-with-a-deliberately-long-name-to-fill-the-chip';
  return {dimension,items:[{...summary,key,label:dimension==='project'?snapshot.projects[0].name:key}]};
 }
 return invoke(channel,...args);
};`;
  await build({ stdin: { contents: fixture, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(qaApp.appDir, 'preload.cjs'), logLevel: 'error' });
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  await appearance('light'); await size(1440);
  const project = await rpc('project.add', { path: work, name: 'Sizing fixture project with a deliberately long name to fill the filter chip', operationId: randomUUID() });
  await page.evaluate(() => localStorage.setItem('threadterm.workbench.sidebar', JSON.stringify({ width: 520, view: 'files' })));
  await page.reload(); await page.locator('.app-shell').waitFor();

  for (const theme of ['light', 'dark']) {
    await appearance(theme); await size(1440, 900);
    await page.locator('.nav-item.new').click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Chat draft', exact: true }).fill('First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line');
    await frames();
    const a = await page.locator('textarea.create-input').evaluate(node => ({ height: node.getBoundingClientRect().height, padding: parseFloat(getComputedStyle(node).paddingTop), lineHeight: getComputedStyle(node).lineHeight, nameHeight: document.querySelector('input.create-input[maxlength="60"]').getBoundingClientRect().height }));
    report.measurements[`A-${theme}`] = a;
    check(`A-${theme}`, a.height >= 80 && a.padding > 0 && a.nameHeight === 36, a);
    await shot(`${theme}-A-chat-draft.png`);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await settings('Tools');
    await page.locator('.settings-chat-tool-row .setting-switch').first().waitFor();
    const reference = await page.locator('.settings-chat-tool-row .setting-switch').first().evaluate(node => ({ height: node.getBoundingClientRect().height, track: node.querySelector('span').getBoundingClientRect().toJSON(), radius: getComputedStyle(node.querySelector('span')).borderRadius, row: node.parentElement.getBoundingClientRect().height }));
    await shot(`${theme}-B-chat-reference.png`);
    await page.getByRole('tab', { name: 'Browser', exact: true }).click();
    await page.getByLabel('Local development server offers', { exact: true }).waitFor(); await frames();
    const b = await page.locator('.settings-group.active').evaluate(node => ({ raw: node.querySelectorAll('label.switch').length, controls: [...node.querySelectorAll('.setting-switch')].map(label => ({ height: label.getBoundingClientRect().height, track: label.querySelector('span').getBoundingClientRect().toJSON(), radius: getComputedStyle(label.querySelector('span')).borderRadius, row: label.parentElement.getBoundingClientRect().toJSON(), text: label.parentElement.firstElementChild.getBoundingClientRect().toJSON() })) }));
    report.measurements[`B-${theme}`] = { reference, ...b };
    check(`B-${theme}`, b.raw === 0 && b.controls.length === 2 && b.controls.every(control => control.height === reference.height && control.track.height === reference.track.height && control.track.width === reference.track.width && control.radius === reference.radius && control.track.left >= control.text.right && control.row.height >= reference.row), { reference, ...b });
    await shot(`${theme}-B-browser.png`); await closeSettings();
  }
  const session = await rpc('session.create', { projectId: project.id, cwd: work, title: 'Sizing terminal', provider: 'shell', mode: 'terminal', operationId: randomUUID() });
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.runtime-workspace').waitFor();
  await page.locator('.wb-switcher button[aria-label="Files"]').click();
  await page.locator('.wb-sidebar').waitFor();
  for (const theme of ['light', 'dark']) {
    await appearance(theme); await size(960, 640);
    const c = await widths(); report.measurements[`C-${theme}`] = c;
    check(`C-${theme}-main`, c.pane >= 319.5 && c.sidebar >= 220 && c.stored === 520, c);
    await shot(`${theme}-C-960-files.png`);
    await page.locator('.wb-resize').focus(); await page.keyboard.press('ArrowLeft'); await frames();
    const keyed = await widths();
    check(`C-${theme}-keyboard-direct`, Math.abs(keyed.sidebar - (c.sidebar - 16)) <= 1, { start: c, keyed });
    await shot(`${theme}-C-960-keyboard.png`);
    // Restore the remembered 520px through the real resize handle before the remaining checks.
    const restoreHandle = await page.locator('.wb-resize').boundingBox();
    await page.mouse.move(restoreHandle.x + restoreHandle.width / 2, restoreHandle.y + restoreHandle.height / 2); await page.mouse.down();
    await page.mouse.move(restoreHandle.x + restoreHandle.width / 2 + 520 - keyed.sidebar, restoreHandle.y + restoreHandle.height / 2); await page.mouse.up(); await frames();
    await page.getByRole('button', { name: 'Session details', exact: true }).click(); await frames();
    const inspector = await widths(); report.measurements[`C-${theme}-inspector`] = inspector;
    check(`C-${theme}-inspector`, inspector.sidebar >= 220 && inspector.pane > 0 && inspector.inspector === 320 && inspector.stored === 520, inspector);
    await shot(`${theme}-C-960-inspector.png`);
    await page.getByRole('button', { name: 'Close session details', exact: true }).click();
    await size(1440);
    const wide = await widths(); check(`C-${theme}-restore`, wide.sidebar === 520 && wide.stored === 520, wide);
    await shot(`${theme}-C-1440-restored.png`);
  }
  await size(960, 640);
  const start = await widths(), handle = await page.locator('.wb-resize').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 24, handle.y + handle.height / 2); await page.mouse.up(); await frames();
  const dragged = await widths(); check('C-drag-direct', Math.abs(dragged.sidebar - (start.sidebar - 24)) < 2 && dragged.stored >= 220 && dragged.stored <= 520, { start, dragged });

  await page.getByRole('button', { name: 'Close side bar', exact: true }).click();
  await size(1440);
  await page.locator('.user-row').click(); await page.locator('.account-menu').getByRole('button', { name: 'Usage', exact: true }).click();
  await page.locator('.usage-page').waitFor();
  for (const theme of ['light', 'dark']) {
    await appearance(theme);
    await page.locator('.usage-range .tt-select-trigger').click(); await page.locator('[role="option"][data-value="custom"]').click();
    for (const dimension of ['provider', 'model', 'project']) await page.locator(`.usage-bd-${dimension} button.usage-bd-row`).first().click();
    await page.locator('.usage-filter').nth(2).waitFor();
    for (const width of [1000, 1280]) {
      await size(width); const d = await headerGeometry(); report.measurements[`D-${theme}-${width}`] = d;
      check(`D-${theme}-${width}`, d.overflow.length === 0 && d.refresh.right <= d.viewport && d.refresh.right <= d.header.right && d.refresh.right >= d.header.right - 12 && d.chips.length === 3 && d.chips.filter(value => value >= 219).length >= 2, d);
      // A 32px range Select + 0.8px border in a 38px row leaves <=2.6px per side; wrapped rows share the single-row edge spacing.
      check(`D-${theme}-${width}-padding`, d.topGap >= 1.99 && d.bottomGap >= 1.99, { topGap: d.topGap, bottomGap: d.bottomGap });
      await page.locator('.usage-scroll').evaluate(node => node.scrollTop = 0); await shot(`${theme}-D-${width}-filters.png`);
    }
    while (await page.locator('.usage-filter').count()) await page.locator('.usage-filter').first().click();
    await page.locator('.usage-range .tt-select-trigger').click(); await page.locator('[role="option"][data-value="30d"]').click();
    await size(1440); const oneRow = await headerGeometry();
    check(`D-${theme}-single-row`, oneRow.header.height === 38 && oneRow.overflow.length === 0 && oneRow.refresh.right >= oneRow.header.right - 12, oneRow);
    await shot(`${theme}-D-1440-single-row.png`);
  }
  check('no-renderer-errors', report.errors.length === 0, report.errors);
} catch (error) {
  report.errors.push(String(error.stack ?? error)); console.error(error);
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {});
  await releaseLock?.();
  // Retain scratch app for inspection; never delete outside the caller's approved TEMP.
}
const failed = report.checks.filter(check => !check.passed);
if (phase === 'before') {
  for (const fix of ['A', 'B', 'C', 'D']) assert.ok(failed.some(check => check.id.startsWith(fix)), `${fix} must demonstrate a baseline failure`);
} else assert.equal(failed.length, 0, `${failed.length} sizing checks failed`);
assert.equal(report.errors.length, 0, 'harness/renderer errors');
console.log(`PASS ${phase} sizing verification: ${report.checks.length} checks, ${report.screenshots.length} screenshots (${failed.length} expected baseline failures)`);
