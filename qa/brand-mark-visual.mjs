// Desktop-1 visual QA for the shared product mark: first-paint boot screen and
// the in-app navigation brand. It uses the generated PNG and does not touch
// the user profile, icon cache, taskbar, or a live provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild, createServer as createViteServer } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/brand-mark');
const scratch = await mkdtemp(join(tmpdir(), 'tt-brand-mark-'));
const mark = join(root, 'renderer/public/brand-mark.png');
const sourceMark = join(root, 'desktop/assets/threadterm.png');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let splashApp;
let splashPage;
let app;
let page;
let server;

const check = value => { report.checks.push(value); process.stdout.write(`PASS ${value}\n`); };
const shot = async (target, name) => { const path = join(out, name); await target.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); };

async function buildApp(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'brand-mark-qa', version: '0.1.0', main: 'main.cjs' }));
}

try {
  assert.ok(existsSync(mark) && existsSync(sourceMark), 'generate desktop/assets and renderer/public brand marks before QA');
  assert.equal((await readFile(mark)).equals(await readFile(sourceMark)), true, 'boot/navigation PNG must be the same generated file as the desktop mark');
  await mkdir(out, { recursive: true });
  // Exercise Vite's real public-directory and relative-base behavior, rather
  // than emulating `/brand-mark.png` with a hand-written static server.
  server = await createViteServer({ configFile: join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const splashDir = join(scratch, 'splash-app');
  await mkdir(splashDir, { recursive: true });
  await mkdir(join(scratch, 'splash-profile'), { recursive: true });
  await writeFile(join(splashDir, 'package.json'), JSON.stringify({ name: 'brand-splash-qa', version: '0.1.0', main: 'main.cjs' }));
  // Vite serves the real entry module too. This inert bridge lets React begin
  // without starting a runtime or reporting expected bridge errors while the
  // test captures only index.html's pre-paint boot surface.
  await writeFile(join(splashDir, 'preload.cjs'), `window.threadterm={platform:'win32',request:()=>new Promise(()=>{}),onEvent:()=>()=>{},onDesktopNavigate:()=>()=>{},windowState:()=>Promise.resolve({maximized:false}),onWindowState:()=>()=>{}};`);
  await writeFile(join(splashDir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');\napp.setPath('userData',${JSON.stringify(join(scratch, 'splash-profile'))});\napp.whenReady().then(() => { const win = new BrowserWindow({ width: 1280, height: 880, show: true, backgroundColor: '#111111', webPreferences:{contextIsolation:false,preload:${JSON.stringify(join(splashDir, 'preload.cjs'))} } }); win.loadURL(process.env.TT_QA_URL); });\n`);
  splashApp = await electron.launch({ args: [splashDir], cwd: splashDir, env: { ...process.env, TT_QA_URL: `${origin}/index.html` }, timeout: 60_000 });
  splashPage = await splashApp.firstWindow({ timeout: 30_000 });
  splashPage.setDefaultTimeout(15_000);
  for (const [theme, locale, motion, width, label] of [['light', 'en', 'no-preference', 1280, 'wide'], ['dark', 'zh-CN', 'reduce', 420, 'narrow']]) {
    await splashPage.emulateMedia({ colorScheme: theme, reducedMotion: motion });
    await splashPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
    await splashPage.evaluate(({ theme: nextTheme, locale: nextLocale }) => {
      localStorage.setItem('threadterm.v3.boot-appearance', JSON.stringify({ theme: nextTheme, locale: nextLocale }));
    }, { theme, locale });
    await splashPage.reload({ waitUntil: 'domcontentloaded' });
    const splash = splashPage.locator('#boot-splash');
    await splash.waitFor();
    const measured = await splashPage.locator('.bs-mark').evaluate(node => {
      const image = node;
      const core = image.parentElement;
      const style = getComputedStyle(image);
      const coreStyle = getComputedStyle(core);
      return {
        complete: image.complete && image.naturalWidth === 512,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        coreOpacity: Number.parseFloat(coreStyle.opacity),
        halo: Boolean(document.querySelector('.bs-halo')),
        ring: Boolean(document.querySelector('.bs-ring')),
        terminal: Boolean(core.querySelector('svg')),
        theme: document.querySelector('#boot-splash')?.dataset.theme,
        lang: document.querySelector('#boot-splash')?.lang,
        motion: document.querySelector('#boot-splash')?.dataset.motion ?? '',
      };
    });
    assert.equal(measured.complete, true, `${label}: boot mark did not load the 512px asset`);
    assert.equal(measured.terminal, false, `${label}: boot core still uses the terminal glyph`);
    assert.equal(measured.halo && measured.ring, true, `${label}: boot ring or halo is missing`);
    assert.ok(Math.abs(measured.width - 64) < 1 && Math.abs(measured.height - 64) < 1, `${label}: boot mark is not 64px`);
    assert.equal(measured.theme, theme);
    assert.equal(measured.lang, locale === 'zh-CN' ? 'zh-CN' : 'en');
    if (motion === 'reduce') assert.equal(measured.motion, 'reduced');
    else assert.equal(measured.motion, '');
    await splashPage.setViewportSize({ width, height: 880 });
    await shot(splashPage, `boot-${theme}-${locale}-${motion}-${label}.png`);
  }
  check('boot first paint uses the shared mark through the real Vite dev server, in light/dark, English/Chinese, wide/narrow, and reduced motion');
  await splashApp.close();
  splashApp = undefined;

  assert.ok(existsSync(runtime), `missing runtime ${runtime}`);
  const appDir = join(scratch, 'app');
  await buildApp(appDir);
  const dropped = /^(path|codex_home|openai_api_key|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-brand-mark-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
  });
  await mkdir(scratch, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: scratch, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  const brand = page.locator('.brand-mark img');
  await brand.waitFor();
  const uncovered = await brand.evaluate(node => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === node || node.contains(hit);
  });
  assert.equal(uncovered, true, 'navigation mark is covered or not hit-testable');
  const box = await brand.boundingBox();
  assert.ok(box && Math.abs(box.width - 20) < 1 && Math.abs(box.height - 20) < 1, 'navigation mark is not the 20px tile');
  assert.equal(await page.locator('.brand-mark svg').count(), 0, 'navigation brand still renders the terminal glyph');
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  for (const [language, theme, width, label] of [['en', 'light', 1280, 'wide'], ['zh-CN', 'dark', 420, 'narrow']]) {
    const snap = await rpc('runtime.snapshot');
    await rpc('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
    await page.setViewportSize({ width, height: 880 });
    await page.locator('.brand-home').waitFor();
    await shot(page, `nav-${language}-${theme}-${label}.png`);
  }
  check('navigation brand uses the shared 20px mark in English/Chinese, light/dark, and wide/narrow');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!report.passed && splashPage) await splashPage.screenshot({ path: join(out, 'splash-failure.png') }).catch(() => undefined);
  if (!report.passed && page) await page.screenshot({ path: join(out, 'nav-failure.png'), fullPage: true }).catch(() => undefined);
  if (splashApp) await splashApp.close().catch(() => undefined);
  if (app) {
    await page?.evaluate(id => window.threadterm?.request('runtime.shutdown', { operationId: id })).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await server?.close();
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  process.stdout.write(`${report.passed ? 'BRAND MARK QA PASSED' : 'BRAND MARK QA FAILED'} ${join(out, 'report.json')}\n`);
}
