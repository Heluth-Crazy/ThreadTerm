// UI review captures: the built production renderer on the QA-only memory bridge (qa/parity/fixture.mjs),
// seeded from the approved prototype's demo data. No runtime, database or user profile is touched.
// Usage: node qa/ui-review-capture.mjs [--build] [--routes=branch,project] [--themes=light,dark]
//        [--sizes=1280x800,1920x1080] [--langs=zh,en] [--usage] [--label=name]
//        [--css=file] [--script=file]   (preview a proposal: extra stylesheet / DOM script before each shot)
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const here = dirname(fileURLToPath(import.meta.url)), v3Root = resolve(here, '..');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3).split(',') ?? fallback;
const routes = arg('routes', ['branch', 'project', 'terminals', 'inbox', 'settings', 'session']);
const themes = arg('themes', ['light', 'dark']);
const sizes = arg('sizes', ['1280x800', '1920x1080']).map(size => size.split('x').map(Number));
const langs = arg('langs', ['zh', 'en']);
const usage = process.argv.includes('--usage');
const extraCss = arg('css', [])[0], extraScript = arg('script', [])[0];
const proposalCss = extraCss ? await readFile(resolve(extraCss), 'utf8') : undefined;
const proposalScript = extraScript ? await readFile(resolve(extraScript), 'utf8') : undefined;
const label = arg('label', [new Date().toISOString().replace(/[:.]/g, '-')])[0];
const out = join(here, 'results/ui-review', label);
await mkdir(out, { recursive: true });

const text = (zh, en) => new RegExp(`^\\s*(${zh}|${en})`);
async function route(page, name) {
  const sideNav = label => page.locator('.side-nav button').filter({ hasText: label }).first().click();
  if (name === 'branch') await page.locator('.tree-row').filter({ hasText: 'feature/checkout-a11y' }).first().click();
  if (name === 'branch-main') await page.locator('.tree-row').filter({ hasText: /^\s*main(\d|\s|$)/ }).first().click();
  if (name === 'project') await page.locator('.proj-row').filter({ hasText: 'orbit-web' }).first().click();
  if (name === 'terminals') await sideNav(text('所有终端', 'All terminals'));
  if (name === 'inbox') await sideNav(text('待处理|收件箱', 'Inbox'));
  if (name === 'settings') {
    await page.locator('.user-row').click();
    await page.locator('.account-menu .menu-item').filter({ hasText: text('设置', 'Settings') }).click();
    await page.locator('.settings-panel').waitFor();
  }
  if (name === 'session') {
    await page.locator('.sess-row').filter({ hasText: '清理前的完成记录' }).first().click();
    await page.locator('.session-screen').waitFor();
  }
  await page.waitForTimeout(350);
}

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-ui-review-'));
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const staticEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(staticEnv, { Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'), TT_QA_DESKTOP: '1' });
let referenceServer, productionServer, app, qaApp, releaseLock;
const report = { label, usage, shots: [], errors: [] };
try {
  qaApp = await buildQaApp({ root: v3Root });
  releaseLock = await acquireElectronQaLock();
  referenceServer = await startReadonlyReferenceServer(join(v3Root, 'reference'));
  productionServer = await startReadonlyReferenceServer(join(qaApp.appDir, 'renderer'));
  app = await electron.launch({ args: [join(here, 'parity/electron-static.cjs')], env: { ...staticEnv, TT_PARITY_PROFILE: join(scratch, 'profile') }, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('threadterm.app.v3', JSON.stringify({ welcomeSeen: true, theme: 'light' })));
  await page.goto(referenceServer.origin + '/prototype/');
  await page.waitForFunction(() => !!window.ThreadTermPrototype);
  const seed = await page.evaluate(() => { const api = window.ThreadTermPrototype; return { projects: api.projects, trees: api.trees, sessions: api.sessions(), store: api.store, fileContents: Object.fromEntries(Object.entries(api.projects).map(([id, p]) => [id, Object.fromEntries(p.files.map((path, index) => [path, api.fileValue(api.sessions().find(item => item.project === id), index)]))])) }; });
  await page.addInitScript(installVisualFixture, { seed, theme: 'light' });
  for (const [width, height] of sizes) for (const theme of themes) for (const lang of langs) for (const name of routes) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.goto(`${productionServer.origin}/?theme=${theme}&lang=${lang}${usage ? '&usage=1' : ''}`);
    const { settings } = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
    const language = lang === 'zh' ? 'zh-CN' : 'en';
    await page.evaluate(([language, revision, id]) => window.threadterm.request('settings.update', { patch: { language }, expectedRevision: revision, operationId: id }), [language, settings.revision, crypto.randomUUID()]);
    await page.waitForFunction(language => document.body.innerText.includes(language === 'zh-CN' ? '所有终端' : 'All terminals'), language);
    await page.addStyleTag({ content: '.titlebar.app-chrome{display:none!important}.app-shell{grid-template-rows:minmax(0,1fr)!important}.app-shell>.sidebar,.app-shell>.content.main{grid-row:1!important}*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.locator('.proj-row').first().waitFor();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    if (proposalCss) await page.addStyleTag({ content: proposalCss });
    await route(page, name);
    if (proposalScript) { const result = await page.evaluate(proposalScript); if (result !== undefined) (report.scriptResults ??= []).push({ route: name, theme, lang, width, result }); await page.waitForTimeout(150); }
    await page.evaluate(() => document.fonts.ready);
    const file = `${name}-${theme}-${lang}-${width}.png`;
    await page.screenshot({ path: join(out, file), animations: 'disabled' });
    report.shots.push(file);
  }
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {}); await productionServer?.close(); await referenceServer?.close();
  await releaseLock?.(); await qaApp?.cleanup?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, shots: report.shots.length, errors: report.errors, error: report.error }, null, 2));
}
