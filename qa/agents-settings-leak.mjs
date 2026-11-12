// Settings › Agents leak check. Opens every other Settings tab and the workbench before the Agents chunk has ever
// loaded, then again after it loaded, and diffs a geometry/style census of each. Also proves the Astryx stylesheet is
// added once, stays once after a second open, and does not overwrite ThreadTerm's :root custom properties.
// Production renderer + QA-only memory bridge; no runtime, database or user profile is touched.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const out = join(here, 'results/agents-settings-leak', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const report = { passed: false, diffs: {}, errors: [] };

function census() {
  const round = value => Math.round(value * 10) / 10;
  const visible = element => !!element.offsetParent && element.getBoundingClientRect().width > 0;
  const one = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(), cls: String(element.className), testid: element.getAttribute('data-testid') ?? '',
      x: round(rect.left), y: round(rect.top), w: round(rect.width), h: round(rect.height),
      fs: style.fontSize, fw: style.fontWeight, lh: style.lineHeight, color: style.color, bg: style.backgroundColor,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`, radius: style.borderRadius, pad: style.padding,
    };
  };
  const group = document.querySelector('.settings-scroll .settings-group.active');
  if (group) return [...group.querySelectorAll('*')].filter(visible).slice(0, 4000).map(one);
  return [...document.querySelectorAll('.app-shell [data-testid], .app-shell > *')].filter(visible).slice(0, 4000).map(one);
}

function rootRead(names) {
  const style = getComputedStyle(document.documentElement);
  return {
    dataset: Object.fromEntries([...document.documentElement.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])),
    style: { color: style.color, background: style.backgroundColor, fontFamily: style.fontFamily, fontSize: style.fontSize },
    tokens: Object.fromEntries(names.map(name => [name, style.getPropertyValue(name).trim()])),
  };
}

const tokenNames = () => {
  const names = new Set();
  const walk = rules => { for (const rule of rules) { if (rule.style) for (const property of rule.style) if (property.startsWith('--')) names.add(property); if (rule.cssRules) walk(rule.cssRules); } };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin sheet */ } }
  return [...names];
};
const stylesheets = () => [...document.querySelectorAll('link[rel="stylesheet"], style[data-vite-dev-id]')].map(node => node.getAttribute('href') ?? node.getAttribute('data-vite-dev-id') ?? 'inline');

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-agents-leak-'));
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const staticEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(staticEnv, { Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'), TT_QA_DESKTOP: '1' });
let referenceServer, productionServer, app, qaApp, releaseLock;
const openSettings = async page => {
  await page.locator('.user-row').click();
  await page.locator('.account-menu .menu-item').filter({ hasText: /^\s*(设置|Settings)/ }).click();
  await page.locator('.settings-panel').waitFor();
};
try {
  qaApp = await buildQaApp({ root });
  releaseLock = await acquireElectronQaLock();
  referenceServer = await startReadonlyReferenceServer(join(root, 'reference'));
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
  for (const theme of ['light', 'dark']) {
    const tag = `${theme}-zh`;
    await page.goto(`${productionServer.origin}/?theme=${theme}&lang=zh`);
    const { settings } = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
    await page.evaluate(([revision, id]) => window.threadterm.request('settings.update', { patch: { language: 'zh-CN' }, expectedRevision: revision, operationId: id }), [settings.revision, crypto.randomUUID()]);
    await page.waitForFunction(() => document.body.innerText.includes('所有终端'));
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const names = await page.evaluate(tokenNames);
    const before = { tabs: {}, root: await page.evaluate(rootRead, names), sheets: await page.evaluate(stylesheets) };

    await openSettings(page);
    let tabs = await page.locator('.settings-layout nav [role="tab"]').allInnerTexts();
    for (const [index, name] of tabs.entries()) {
      if (/Agents|智能体/.test(name)) continue;
      await page.locator('.settings-layout nav [role="tab"]').nth(index).click();
      await page.waitForTimeout(500);
      before.tabs[name] = await page.evaluate(census);
    }
    await page.keyboard.press('Escape');
    before.workbench = await page.evaluate(census);

    await openSettings(page);
    tabs = await page.locator('.settings-layout nav [role="tab"]').allInnerTexts();
    const agentsIndex = tabs.findIndex(name => /Agents|智能体/.test(name));
    await page.locator('.settings-layout nav [role="tab"]').nth(agentsIndex).click();
    await page.locator('[data-testid="agents-settings"]').waitFor();
    await page.waitForTimeout(500);
    const after = { tabs: {}, root: {}, sheets: [] };
    for (const [index, name] of tabs.entries()) {
      if (/Agents|智能体/.test(name)) continue;
      await page.locator('.settings-layout nav [role="tab"]').nth(index).click();
      await page.waitForTimeout(500);
      after.tabs[name] = await page.evaluate(census);
    }
    for (const name of Object.keys(before.tabs)) {
      if (JSON.stringify(before.tabs[name]) !== JSON.stringify(after.tabs[name])) {
        report.diffs[`${tag}/${name}`] = 'settings tab census changed after the Agents chunk loaded';
        await writeFile(join(out, `${tag}-${name}-before.json`), JSON.stringify(before.tabs[name], null, 2));
        await writeFile(join(out, `${tag}-${name}-after.json`), JSON.stringify(after.tabs[name], null, 2));
      }
    }
    await page.keyboard.press('Escape');
    after.workbench = await page.evaluate(census);
    if (JSON.stringify(before.workbench) !== JSON.stringify(after.workbench)) {
      report.diffs[`${tag}/workbench`] = 'workbench census changed after the Agents chunk loaded';
      await writeFile(join(out, `${tag}-workbench-before.json`), JSON.stringify(before.workbench, null, 2));
      await writeFile(join(out, `${tag}-workbench-after.json`), JSON.stringify(after.workbench, null, 2));
    }
    after.root = await page.evaluate(rootRead, names);
    if (JSON.stringify(before.root.tokens) !== JSON.stringify(after.root.tokens)) {
      report.diffs[`${tag}/tokens`] = 'ThreadTerm :root custom properties changed after the Agents chunk loaded';
      await writeFile(join(out, `${tag}-tokens-before.json`), JSON.stringify(before.root, null, 2));
      await writeFile(join(out, `${tag}-tokens-after.json`), JSON.stringify(after.root, null, 2));
    }
    after.sheets = await page.evaluate(stylesheets);
    const added = after.sheets.filter(sheet => !before.sheets.includes(sheet));
    report[`sheets-${tag}`] = { before: before.sheets, added };
    if (!added.length) report.diffs[`${tag}/sheets`] = 'opening Agents added no stylesheet';
    // A second open must not add the same stylesheet again.
    await openSettings(page);
    tabs = await page.locator('.settings-layout nav [role="tab"]').allInnerTexts();
    await page.locator('.settings-layout nav [role="tab"]').nth(tabs.findIndex(name => /Agents|智能体/.test(name))).click();
    await page.locator('[data-testid="agents-settings"]').waitFor();
    const reopened = await page.evaluate(stylesheets);
    if (JSON.stringify(reopened) !== JSON.stringify(after.sheets)) {
      report.diffs[`${tag}/sheets-reopen`] = 'opening Agents a second time changed the stylesheet list';
      report[`sheets-reopen-${tag}`] = reopened;
    }
    await page.keyboard.press('Escape');
  }
  report.passed = Object.keys(report.diffs).length === 0 && report.errors.length === 0;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {}); await productionServer?.close(); await referenceServer?.close();
  await releaseLock?.(); await qaApp?.cleanup?.();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.passed, diffs: report.diffs, error: report.error }));
}
if (!report.passed) process.exitCode = 1;
