// Production QuickLaunchMenu UI QA. The real component and renderer styles are
// bundled into an isolated Desktop 1 window; the bridge only serves fixture data.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'tt-script-import-ui-'));
const fixture = join(scratch, 'fixture');
const renderer = join(scratch, 'renderer');
const profile = join(scratch, 'profile');
const isolatedHome = join(scratch, 'home');
const isolatedCodexHome = join(isolatedHome, '.codex');
const isolatedAppData = join(scratch, 'appdata');
const isolatedLocalAppData = join(scratch, 'localappdata');
const isolatedData = join(scratch, 'data');
const isolatedUserData = join(scratch, 'user-data');
const isolatedPipe = `\\\\.\\pipe\\tt-script-import-${randomUUID()}`;
const out = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? join(root, 'qa', 'results', 'ui-script-import'));
const data = { projectId: 'script-import-project', root: 'C:/qa/worktree', projects: [{ id: 'script-import-project', path: 'C:/qa/worktree', name: 'Fixture' }] };
const report = { passed: false, screenshots: [], geometry: [], checks: [], calls: [], errors: [] };
let server, app, page;
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const shot = async name => { await page.screenshot({ path: join(out, name) }); report.screenshots.push(name); };
try {
  await Promise.all([fixture, profile, out, isolatedHome, isolatedCodexHome, isolatedAppData, isolatedLocalAppData, isolatedData, isolatedUserData].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quick Launch import QA</title></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(fixture, 'entry.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'${join(root, 'renderer/src/i18n.tsx').replaceAll('\\', '/')}';import{QuickLaunchMenu}from'${join(root, 'renderer/src/components/QuickLaunch.tsx').replaceAll('\\', '/')}';import'${join(root, 'renderer/src/styles.css').replaceAll('\\', '/')}';import'${join(root, 'renderer/src/workbench/workbench.css').replaceAll('\\', '/')}';const props={projectId:'${data.projectId}',root:'${data.root}',data:{epoch:'qa',revision:1,projects:${JSON.stringify(data.projects)},sessions:[],settings:{language:'en',theme:'light'},workspaces:[],presets:[],inbox:[],providers:[]},onOpenSession:()=>{throw Error('No session should open during import QA')}};function App(){const[locale,setLocale]=React.useState('en');window.__setScriptImportLocale=setLocale;return <I18nProvider locale={locale}><main style={{height:'100vh',display:'grid',placeItems:'center'}}><div><button>QA fixture</button><QuickLaunchMenu {...props}/></div></main></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`);
  await viteBuild({ root: fixture, configFile: false, plugins: [react()], resolve: { alias: [
    { find: /^react$/, replacement: join(root, 'node_modules/react/index.js') },
    { find: /^react-dom\/client$/, replacement: join(root, 'node_modules/react-dom/client.js') },
    { find: /^react\/jsx-runtime$/, replacement: join(root, 'node_modules/react/jsx-runtime.js') },
    { find: '@threadterm/protocol', replacement: join(root, 'protocol/index.ts') },
  ] }, build: { outDir: renderer, emptyOutDir: true, rollupOptions: { input: join(fixture, 'index.html') } } });
  await mkdir(profile, { recursive: true });
  server = await startReadonlyReferenceServer(renderer);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
  Object.assign(env, { Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2), CODEX_HOME: isolatedCodexHome, APPDATA: isolatedAppData, LOCALAPPDATA: isolatedLocalAppData, THREADTERM_V3_DATA: isolatedData, THREADTERM_V3_USER_DATA: isolatedUserData, THREADTERM_V3_PIPE: isolatedPipe, TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: profile });
  assert.equal(env.CODEX_HOME, isolatedCodexHome); assert.equal(env.APPDATA, isolatedAppData); assert.equal(env.LOCALAPPDATA, isolatedLocalAppData);
  assert.equal(env.THREADTERM_V3_DATA, isolatedData); assert.equal(env.THREADTERM_V3_USER_DATA, isolatedUserData); assert.equal(env.THREADTERM_V3_PIPE, isolatedPipe);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa/parity/electron-static.cjs')], env, timeout: 30000 });
  page = await app.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(String(error)));
  await page.addInitScript(({ projectId }) => {
    const calls = [], saved = []; let failBuildOnce = true;
    window.__scriptImportQA = { calls, saved };
    window.threadterm = { request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'quickLaunch.list') return structuredClone(saved);
      if (method === 'quickLaunch.setup.status') return [];
      if (method === 'filesystem.read') return { content: JSON.stringify({ scripts: { dev: 'node server.mjs', start: 'node start.mjs', build: 'node build.mjs', test: 'node test.mjs', lint: 'node lint.mjs' } }) };
      if (method === 'filesystem.list') return [{ kind: 'file', name: 'pnpm-lock.yaml' }];
      if (method === 'quickLaunch.save') { if (params.name === 'build' && failBuildOnce) { failBuildOnce = false; throw Error('synthetic save failure'); } saved.push({ ...params, id: `saved-${params.name}`, revision: 1 }); return saved.at(-1); }
      throw Error(`Unexpected fixture request ${method}`);
    }, onEvent: () => () => {}, onDesktopNavigate: () => () => {}, chooseDirectory: async () => null, openWindow: async () => {}, openExternal: async () => {}, openDirectory: async () => {}, windowAction: async () => {} };
  }, { projectId: data.projectId });
  await page.goto(`${server.origin}/`); await page.waitForFunction(() => Boolean(window.threadterm));
  const openDialog = async () => {
    const trigger = page.getByRole('button', { name: /Run|运行/ }).first();
    await trigger.click(); await page.getByTestId('quick-launch-menu').waitFor();
    await page.getByRole('button', { name: /Import scripts|导入脚本/ }).click();
    const dialog = page.getByRole('dialog', { name: /Import scripts|导入脚本/ }); await dialog.waitFor();
    await dialog.getByRole('button', { name: /Load scripts|加载脚本/ }).click();
    await dialog.locator('.ql-script').first().waitFor();
    return dialog;
  };
  if (!process.argv.includes('--skip-visuals')) for (const width of [1280, 1440, 1920, 390]) for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(([nextLocale, nextTheme]) => { window.__setScriptImportLocale(nextLocale); document.documentElement.dataset.theme = nextTheme; }, [locale, theme]);
    const visualDialog = await openDialog();
    console.log(`Visual QA ${width}/${locale}/${theme}`);
    const geometry = await visualDialog.evaluate(node => {
      const rect = selector => { const element = node.querySelector(selector); const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fontSize: style.fontSize, radius: style.borderRadius }; };
      return { input: rect('.ql-directory input'), load: rect('.ql-directory .btn'), count: rect('.sheet-foot-meta'), cancel: rect('.dlg-foot > .btn:first-of-type'), primary: rect('.dlg-foot > .btn:last-of-type') };
    });
    assert.equal(geometry.input.height, 32, `input height at ${width}/${locale}/${theme}`);
    assert.equal(geometry.load.height, 32, `load height at ${width}/${locale}/${theme}`);
    assert.equal(geometry.cancel.height, 32, `cancel height at ${width}/${locale}/${theme}`);
    assert.equal(geometry.primary.height, 32, `import height at ${width}/${locale}/${theme}`);
    assert.equal(geometry.input.fontSize, '13px'); assert.equal(geometry.load.fontSize, '13px');
    assert.equal(geometry.cancel.fontSize, '13px'); assert.equal(geometry.primary.fontSize, '13px'); assert.equal(geometry.count.fontSize, '13px');
    assert.equal(geometry.input.radius, '6px'); assert.equal(geometry.load.radius, '6px');
    assert.equal(geometry.cancel.radius, '6px'); assert.equal(geometry.primary.radius, '6px');
    assert.ok(Math.abs(geometry.load.x - geometry.input.x - geometry.input.width - 8) < 1, 'directory input and load action keep an 8 px gap');
    assert.ok(Math.abs(geometry.primary.x - geometry.cancel.x - geometry.cancel.width - 8) < 1, 'footer actions keep an 8 px gap');
    if (width <= 520) assert.ok(geometry.count.y < geometry.cancel.y, 'compact layout puts count above both actions');
    else assert.ok(geometry.count.x + geometry.count.width < geometry.cancel.x, 'wide layout keeps count to the left of actions');
    report.geometry.push({ width, locale, theme, inputHeight: geometry.input.height, loadHeight: geometry.load.height, cancelHeight: geometry.cancel.height, importHeight: geometry.primary.height, inputType: geometry.input.fontSize, actionType: geometry.load.fontSize, countType: geometry.count.fontSize, cornerRadius: geometry.input.radius, directoryGap: geometry.load.x - geometry.input.x - geometry.input.width, footerActionGap: geometry.primary.x - geometry.cancel.x - geometry.cancel.width });
    const screenshot = `import-${width}-${locale}-${theme}.png`;
    await shot(screenshot);
    if (width === 1280 && locale === 'en' && theme === 'light') {
      await visualDialog.locator('.dlg-head button').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const loadFocus = await visualDialog.locator('.ql-directory .btn').evaluate(button => ({ focused: document.activeElement === button, visible: button.matches(':focus-visible'), outline: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth }));
      assert.equal(loadFocus.focused, true); assert.equal(loadFocus.visible, true); assert.equal(loadFocus.outline, 'solid');
      assert.ok(parseFloat(loadFocus.width) >= 1.5 && parseFloat(loadFocus.width) <= 2.5, 'keyboard focus outline remains 2 CSS pixels at the Desktop 1 scale');
      for (let i = 0; i < 16 && !await visualDialog.locator('.dlg-foot .btn-primary').evaluate(button => document.activeElement === button); i++) await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
      await visualDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.ql-trigger').evaluate(button => document.activeElement === button), true, 'Escape closes the plain dialog and restores Run focus');
      assert.equal(await page.evaluate(() => window.__scriptImportQA.calls.some(call => call.method === 'quickLaunch.save')), false, 'Escape never saves scripts');
      check('keyboard focus outline, Escape dismissal, and Run focus restoration remain intact');
    } else {
      await visualDialog.getByRole('button', { name: /Cancel|取消/ }).click();
      await visualDialog.waitFor({ state: 'hidden' });
    }
  }
  if (!process.argv.includes('--skip-visuals')) check('import field and footer geometry remains coordinated in 16 locale/theme/viewport combinations');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { window.__setScriptImportLocale('en'); document.documentElement.dataset.theme = 'light'; });
  const dialog = await openDialog();
  assert.equal(await dialog.getByRole('button', { name: /Import selected|导入所选/ }).isEnabled(), true);
  const initialCount = await dialog.locator('.sheet-foot-meta').innerText();
  assert.match(initialCount, /4/); // dev/start/build/test are the component's default selection.
  const longDirectory = `C:/qa/worktree/${'nested/'.repeat(24)}leaf`;
  await dialog.locator('.ql-directory input').fill(longDirectory);
  await dialog.getByRole('button', { name: /Load scripts|加载脚本/ }).click();
  await dialog.locator('.ql-script').first().waitFor();
  const longRead = await page.evaluate(() => window.__scriptImportQA.calls.filter(call => call.method === 'filesystem.read').at(-1).params.path);
  assert.ok(longRead.length > 150 && longRead.endsWith('leaf/package.json'), 'a long in-scope directory remains editable and loads scripts');
  await dialog.locator('.ql-directory input').fill(data.root);
  await dialog.getByRole('button', { name: /Load scripts|加载脚本/ }).click();
  await dialog.locator('.ql-script').first().waitFor();
  for (const name of ['dev', 'start', 'build', 'test']) await dialog.locator('.ql-script').filter({ hasText: new RegExp(`^${name}`) }).getByRole('checkbox').uncheck();
  assert.match(await dialog.locator('.sheet-foot-meta').innerText(), /0/);
  const emptyImport = dialog.getByRole('button', { name: /Import selected|导入所选/ });
  assert.equal(await emptyImport.isDisabled(), true, 'empty selection disables import');
  assert.ok(Number(await emptyImport.evaluate(button => getComputedStyle(button).opacity)) <= 0.6, 'disabled import remains visually disabled');
  await emptyImport.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.__scriptImportQA.calls.some(call => call.method === 'quickLaunch.save')), false, 'empty import does not call save');
  for (const name of ['dev', 'start', 'build', 'test']) await dialog.locator('.ql-script').filter({ hasText: new RegExp(`^${name}`) }).getByRole('checkbox').check();
  assert.match(initialCount, /4/);
  for (const name of ['dev', 'start', 'build', 'test']) await dialog.locator('.ql-script').filter({ hasText: new RegExp(`^${name}`) }).getByRole('checkbox').uncheck();
  assert.match(await dialog.locator('.sheet-foot-meta').innerText(), /0/);
  assert.equal(await dialog.getByRole('button', { name: /Import selected|导入所选/ }).isDisabled(), true, 'empty selection disables import');
  await dialog.locator('.ql-script').filter({ hasText: /^test/ }).getByRole('checkbox').check();
  await dialog.locator('.ql-script').filter({ hasText: /^dev/ }).getByRole('checkbox').check();
  await dialog.locator('.ql-script').filter({ hasText: /^build/ }).getByRole('checkbox').check();
  await dialog.locator('.ql-script').filter({ hasText: /^start/ }).getByRole('checkbox').check();
  assert.match(await dialog.locator('.sheet-foot-meta').innerText(), /4/);
  await dialog.getByRole('button', { name: /Import selected|导入所选/ }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.locator('.ql-script').filter({ hasText: /^dev/ }).getByRole('checkbox').isDisabled(), true, 'a successfully saved row stays disabled after partial failure');
  assert.equal(await dialog.locator('.ql-script').filter({ hasText: /^start/ }).getByRole('checkbox').isDisabled(), true, 'all earlier successful rows stay disabled after partial failure');
  assert.match(await dialog.locator('.sheet-foot-meta').innerText(), /4/);
  await dialog.getByRole('button', { name: /Import selected|导入所选/ }).click();
  await dialog.waitFor({ state: 'hidden' });
  const saves = await page.evaluate(() => window.__scriptImportQA.calls.filter(call => call.method === 'quickLaunch.save').map(call => call.params.name));
  assert.deepEqual(saves, ['dev', 'start', 'build', 'build', 'test']);
  const buildIds = await page.evaluate(() => window.__scriptImportQA.calls.filter(call => call.method === 'quickLaunch.save' && call.params.name === 'build').map(call => call.params.operationId));
  assert.equal(buildIds[0], buildIds[1], 'retry keeps the original operation ID for the uncertain build save');
  assert.equal(await page.evaluate(() => window.__scriptImportQA.calls.some(call => call.method === 'quickLaunch.run')), false, 'import does not execute scripts');
  check('production component loads, counts, disables empty import, preserves completed rows through partial failure, retries with stable IDs, and does not execute scripts');
  await page.locator('.ql-trigger').click();
  const menu = page.getByTestId('quick-launch-menu'); await menu.waitFor();
  await menu.getByRole('button', { name: /Edit|编辑/ }).first().click();
  const editor = page.getByRole('dialog', { name: /Edit command|编辑命令/ }); await editor.waitFor();
  const editorPath = editor.locator('input[id$="-cwd"]');
  const editorGeometry = await editorPath.evaluate(input => { const box = input.getBoundingClientRect(), style = getComputedStyle(input); return { height: box.height, radius: style.borderRadius, fontSize: style.fontSize }; });
  assert.ok(editorGeometry.height > 32, 'command editor retains its independent field height');
  assert.equal(await editorPath.locator('xpath=ancestor::div[contains(@class,"ql-directory")]').count(), 0);
  await shot('command-editor-en-light.png');
  check('existing command editor working-directory field keeps its independent geometry');
  report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); console.error(`FAIL ${report.errors.at(-1)}`); }
finally {
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  server?.close();
  const safeScratch = resolve(scratch);
  assert.equal(dirname(safeScratch), resolve(tmpdir()), 'scratch deletion target stays directly inside the OS temp directory');
  assert.ok(basename(safeScratch).startsWith('tt-script-import-ui-'), 'scratch deletion target has this QA fixture prefix');
  await rm(safeScratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
