// Settings review capture: every Settings tab of the built production renderer on the QA-only memory bridge
// (qa/parity/fixture.mjs), photographed at full height, plus a layout census per tab (block edges, headings,
// buttons, fields and text sizes) so alignment and style drift can be checked as numbers.
// No runtime, database or user profile is touched.
// Usage: node qa/settings-review-capture.mjs [--themes=light,dark] [--langs=zh,en] [--label=name] [--css=file]
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { checkControlConsistency } from './lib/visual-consistency.mjs';

const here = dirname(fileURLToPath(import.meta.url)), v3Root = resolve(here, '..');
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3).split(',') ?? fallback;
const themes = arg('themes', ['light', 'dark']);
const langs = arg('langs', ['zh', 'en']);
const extraCss = arg('css', [])[0];
const proposalCss = extraCss ? await readFile(resolve(extraCss), 'utf8') : undefined;
const label = arg('label', [new Date().toISOString().replace(/[:.]/g, '-')])[0];
const out = join(here, 'results/settings-review', label);
await mkdir(out, { recursive: true });

// Grow the dialog to its content so one element screenshot shows the whole tab.
const FULL_HEIGHT = '.settings-drawer{position:absolute!important;inset:0 0 auto 0!important;align-items:flex-start!important;overflow:visible!important}'
  + '.settings-panel{height:auto!important;max-height:none!important;overflow:visible!important}.settings-layout,.settings-scroll{overflow:visible!important;flex:none!important}'
  + 'html,body,#root,.app-shell{height:auto!important;min-height:100%!important;overflow:visible!important}';

function census() {
  const round = value => Math.round(value * 10) / 10;
  const box = element => { const rect = element.getBoundingClientRect(); return { x: round(rect.left), right: round(rect.right), w: round(rect.width), h: round(rect.height) }; };
  const visible = element => !!element.offsetParent && element.getBoundingClientRect().width > 0;
  const text = element => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const group = document.querySelector('.settings-scroll .settings-group.active');
  const scroll = document.querySelector('.settings-scroll');
  if (!group) return { error: 'no active settings group' };
  const origin = scroll.getBoundingClientRect().left + parseFloat(getComputedStyle(scroll).paddingLeft);
  const rel = element => round(element.getBoundingClientRect().left - origin);
  const style = element => { const s = getComputedStyle(element); return { fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight, color: s.color, bg: s.backgroundColor, radius: s.borderRadius, border: `${s.borderTopWidth} ${s.borderTopStyle}`, pad: s.padding }; };
  const blocks = [...group.children].filter(visible).map(element => ({ tag: element.tagName.toLowerCase(), cls: String(element.className), left: rel(element), ...box(element), ...style(element) }));
  const headings = [...group.querySelectorAll('h2,h3,h4,h5,legend,summary,.settings-card-title,.settings-group-title,[class*="title"]')].filter(visible)
    .filter(element => !element.closest('button')).map(element => ({ text: text(element), tag: element.tagName.toLowerCase(), cls: String(element.className), left: rel(element), ...style(element) }));
  const buttons = [...group.querySelectorAll('button,[role="button"],a.btn')].filter(visible).map(element => ({ text: text(element), cls: String(element.className), left: rel(element), ...box(element), ...style(element) }));
  const fields = [...group.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select,textarea,.tt-select')].filter(visible)
    .map(element => ({ text: text(element), tag: element.tagName.toLowerCase(), type: element.type ?? '', cls: String(element.className), left: rel(element), ...box(element), ...style(element) }));
  const switches = [...group.querySelectorAll('input[type=checkbox],input[type=radio],.setting-switch,[role="switch"]')].filter(visible)
    .map(element => ({ cls: String(element.className), role: element.getAttribute('role') ?? '', type: element.type ?? '', left: rel(element), ...box(element) }));
  const textSizes = {};
  const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || !node.parentElement || !visible(node.parentElement)) continue;
    const key = getComputedStyle(node.parentElement).fontSize;
    (textSizes[key] ??= []).length < 6 && textSizes[key].push(node.textContent.trim().slice(0, 24));
  }
  const overflow = [...group.querySelectorAll('*')].filter(visible).filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible' && element.clientWidth > 0)
    .map(element => ({ cls: String(element.className), text: text(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  const outside = [...group.querySelectorAll('*')].filter(visible).filter(element => element.getBoundingClientRect().right > scroll.getBoundingClientRect().right - parseFloat(getComputedStyle(scroll).paddingRight) + 1)
    .map(element => ({ cls: String(element.className), text: text(element), right: round(element.getBoundingClientRect().right) }));
  return { blocks, headings, buttons, fields, switches, textSizes, overflow: overflow.slice(0, 20), outside: outside.slice(0, 20) };
}

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-settings-review-'));
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const staticEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(staticEnv, { Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'), TT_QA_DESKTOP: '1' });
let referenceServer, productionServer, app, qaApp, releaseLock;
const report = { label, shots: [], census: {}, errors: [] };
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  for (const theme of themes) for (const lang of langs) {
    await page.goto(`${productionServer.origin}/?theme=${theme}&lang=${lang}`);
    const { settings } = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
    const language = lang === 'zh' ? 'zh-CN' : 'en';
    await page.evaluate(([language, revision, id]) => window.threadterm.request('settings.update', { patch: { language }, expectedRevision: revision, operationId: id }), [language, settings.revision, crypto.randomUUID()]);
    await page.waitForFunction(language => document.body.innerText.includes(language === 'zh-CN' ? '所有终端' : 'All terminals'), language);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    if (proposalCss) await page.addStyleTag({ content: proposalCss });
    await page.locator('.user-row').click();
    await page.locator('.account-menu .menu-item').filter({ hasText: /^\s*(设置|Settings)/ }).click();
    await page.locator('.settings-panel').waitFor();
    const tabs = await page.locator('.settings-layout nav [role="tab"]').allInnerTexts();
    for (const [index, name] of tabs.entries()) {
      await page.locator('.settings-layout nav [role="tab"]').nth(index).click();
      await page.waitForTimeout(700);
      await page.evaluate(() => document.fonts.ready);
      const key = `${String(index).padStart(2, '0')}-${name.trim()}`;
      if (theme === themes[0] && lang === langs[0]) report.census[key] = await page.evaluate(census);
      const consistency = await checkControlConsistency(page, '.settings-scroll .settings-group.active');
      (report.controlViolations ??= {})[`${key}-${theme}-${lang}`] = consistency.error ? [consistency.error] : consistency.violations.map(violation => `[${violation.kind}] ${violation.parent ? `${violation.parent}: ` : ''}${violation.message}${violation.controls?.length ? ` (${violation.controls.join(', ')})` : ''}`);
      const style = await page.addStyleTag({ content: FULL_HEIGHT });
      const file = `${key}-${theme}-${lang}.png`;
      await page.locator('.settings-panel').screenshot({ path: join(out, file), animations: 'disabled' });
      await style.evaluate(node => node.remove());
      report.shots.push(file);
    }
    await page.keyboard.press('Escape');
  }
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {}); await productionServer?.close(); await referenceServer?.close();
  await releaseLock?.(); await qaApp?.cleanup?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, shots: report.shots.length, errors: report.errors, error: report.error }, null, 2));
}
