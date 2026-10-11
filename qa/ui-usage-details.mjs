// Isolated production-component QA for Usage details spacing. Uses synthetic
// usage rows and a fake renderer bridge; it never starts the runtime/providers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';

process.env.TT_QA_DESKTOP = '1';
const root = resolve(import.meta.dirname, '..');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const out = resolve(option('--out') ?? join(root, 'qa', 'results', 'ui-usage-details'));
const scratch = await mkdtemp(join(tmpdir(), 'tt-usage-ui-'));
const jsPath = join(scratch, 'usage-fixture.js');
const profile = join(scratch, 'electron-profile');
const isolatedHome = join(scratch, 'home');
const isolatedCodexHome = join(isolatedHome, '.codex');
const isolatedAppData = join(scratch, 'appdata');
const isolatedLocalAppData = join(scratch, 'localappdata');
const isolatedData = join(scratch, 'data');
const isolatedUserData = join(scratch, 'user-data');
const isolatedPipe = `\\\\.\\pipe\\threadterm-usage-${randomUUID()}`;
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(childEnv, {
  Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
  HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2),
  CODEX_HOME: isolatedCodexHome, APPDATA: isolatedAppData, LOCALAPPDATA: isolatedLocalAppData,
  THREADTERM_V3_DATA: isolatedData, THREADTERM_V3_USER_DATA: isolatedUserData, THREADTERM_V3_PIPE: isolatedPipe,
  TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: profile,
});

const mime = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = pathname === '/__usage_fixture.js' ? jsPath : resolve(root, `.${pathname}`);
    if (target !== jsPath && target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('out of scope');
    const body = target === jsPath ? await readFile(jsPath) : await readFile(target);
    response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { UsagePanel } from ${JSON.stringify(join(root, 'renderer/src/components/UsagePanel.tsx'))};
    import { SurfaceDialog } from ${JSON.stringify(join(root, 'renderer/src/components/SurfaceDialog.tsx'))};
    import { I18nProvider } from ${JSON.stringify(join(root, 'renderer/src/i18n.tsx'))};
    const rows = Array.from({length: 9}, (_, index) => ({ sessionId: 'session-'+index, recordedAt: new Date(Date.UTC(2026,9,11,12,index)).toISOString(), provider: index%2 ? 'claude' : 'codex', model: index%2 ? 'claude-sonnet-4' : 'gpt-5-codex', inputTokens: 1000+index, outputTokens: 300+index, status: 'completed', source: 'native-history' }));
    const settings = { revision: 1, language: 'en', theme: 'light', modelPrices: {} };
    const projects = [{id:'project-fixture', name:'Usage fixture project', path:'C:/qa/usage'}];
    window.__usageFixture = { calls: [], mount(language='en', theme='light', scoped=false) {
      settings.language = language === 'zh' ? 'zh-CN' : 'en'; settings.theme = theme;
      document.documentElement.dataset.theme = theme;
      const data = { settings, projects, providers: [{id:'codex', name:'Codex'}, {id:'claude', name:'Claude'}], sessions: [] };
      const app = <I18nProvider locale={settings.language}><SurfaceDialog title={language==='zh'?'用量明细':'Usage details'} subtitle="Usage fixture project" icon="layers" size="wide" onClose={()=>{ window.__usageFixture.modalEscapes = (window.__usageFixture.modalEscapes ?? 0) + 1; }}><UsagePanel data={data} initialProjectId={scoped ? projects[0].id : undefined}/></SurfaceDialog></I18nProvider>;
      window.__usageReactRoot?.unmount();
      window.__usageReactRoot = createRoot(document.getElementById('mount'));
      window.__usageReactRoot.render(app);
    }};
    window.threadterm = { request: async (method, params={}) => {
      window.__usageFixture.calls.push({method, params});
      if (method === 'usage.query') return { records: structuredClone(rows.filter(row => !params.provider || row.provider === params.provider)) };
      if (method === 'settings.update') return settings;
      return null;
    }};
  `, resolveDir: root, sourcefile: 'ui-usage-fixture.tsx', loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', outfile: jsPath,
});

const report = { passed: false, pageErrors: [], layouts: [], screenshots: [], interactions: [], knownFindings: [] };
let app;
try {
  await mkdir(out, { recursive: true });
  await Promise.all([profile, isolatedHome, isolatedCodexHome, isolatedAppData, isolatedLocalAppData, isolatedData, isolatedUserData].map(path => mkdir(path, { recursive: true })));
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa', 'parity', 'electron-static.cjs')], env: childEnv, timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(8_000);
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  await page.goto('about:blank');
  await page.setContent('<div id="mount"></div>');
  await page.addStyleTag({ url: `${origin}/renderer/src/styles.css` });
  await page.addStyleTag({ url: `${origin}/renderer/src/components/settings-parity.css` });
  await page.addScriptTag({ url: `${origin}/__usage_fixture.js` });
  await page.evaluate(() => window.__usageFixture.mount('en', 'light', false));
  await page.locator('.usage-details').waitFor();
  await page.locator('.usage-log').first().waitFor();

  const providerCombo = page.getByRole('combobox', { name: 'Provider' });
  await providerCombo.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await providerCombo.evaluate(node => node.matches(':focus-visible')), true, 'keyboard focus shows the provider control focus ring');
  const keyboardQueryCount = await page.evaluate(() => window.__usageFixture.calls.filter(call => call.method === 'usage.query').length);
  await page.keyboard.press('Enter');
  assert.equal(await providerCombo.getAttribute('aria-expanded'), 'true', 'Enter opens the provider listbox');
  await providerCombo.press('Escape');
  assert.equal(await providerCombo.getAttribute('aria-expanded'), 'false', 'first Escape closes the provider listbox');
  assert.equal(await page.evaluate(() => window.__usageFixture.modalEscapes ?? 0), 0, 'first Escape does not invoke the dialog close callback');
  await providerCombo.press('Escape');
  assert.equal(await page.evaluate(() => window.__usageFixture.modalEscapes), 1, 'second Escape invokes the dialog close callback');
  assert.equal(await page.evaluate(() => window.__usageFixture.calls.filter(call => call.method === 'usage.query').length), keyboardQueryCount, 'opening the filter does not change query state');
  report.interactions.push('provider select keyboard focus-visible; Enter opens and first Escape closes its listbox, second Escape closes dialog');

  const firstDialogControl = page.locator('.dialog.sheet-wide .sheet-head button');
  const lastDialogControl = page.locator('.usage-pricing > summary');
  assert.equal(await lastDialogControl.evaluate(node => node.checkVisibility()), true, 'closed pricing details summary remains the last visible dialog control');
  assert.equal(await page.locator('.usage-pricing textarea').evaluate(node => node.checkVisibility()), false, 'closed pricing details descendants are not visible tabbables');
  await lastDialogControl.focus();
  await page.keyboard.press('Tab');
  assert.equal(await firstDialogControl.evaluate(node => node === document.activeElement), true, 'Tab wraps from the final visible summary to the first dialog control');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await lastDialogControl.evaluate(node => node === document.activeElement), true, 'Shift+Tab wraps from the first dialog control to the final visible summary');
  report.interactions.push('SurfaceDialog traps Tab and Shift+Tab at boundaries using final visible pricing summary');

  const measure = async (label, width, language, theme, scoped) => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, 900), { width });
    await page.evaluate(({ language, theme, scoped }) => window.__usageFixture.mount(language, theme, scoped), { language, theme, scoped });
    await page.locator('.usage-details').waitFor();
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector('.dialog.sheet-wide').getBoundingClientRect();
      const filters = document.querySelector('.usage-details .sheet-filters').getBoundingClientRect();
      const filterContent = document.querySelector('.usage-details .sheet-filter-grid').getBoundingClientRect();
      const chipsRow = document.querySelector('.usage-details .sheet-chip-row').getBoundingClientRect();
      const scrollStyle = getComputedStyle(document.querySelector('.usage-details .sheet-scroll'));
      const headerStyle = getComputedStyle(document.querySelector('.dialog.sheet .dlg-head.sheet-head'));
      const sheetScroll = document.querySelector('.usage-details .sheet-scroll');
      const detailGrid = document.querySelector('.usage-details .usage-detail-grid');
      const detailChildren = [...detailGrid.children].map(node => { const rect = node.getBoundingClientRect(); return { className: node.className || node.tagName, width: rect.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; });
      const scrollRegions = [sheetScroll, detailGrid, ...detailGrid.children].map(node => ({ selector: node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      const chips = [...document.querySelectorAll('.usage-details .sheet-chip')].map(node => node.getBoundingClientRect());
      const controls = [...document.querySelectorAll('.usage-details .sheet-filter-grid .tt-select-trigger')].map(node => node.getBoundingClientRect());
      const uniqueRows = values => new Set(values.map(value => Math.round(value.top))).size;
      return { dialogWidth: dialog.width, filterWidth: filters.width, sheetScrollClientWidth: sheetScroll.clientWidth, sheetScrollWidth: sheetScroll.scrollWidth, detailGridClientWidth: detailGrid.clientWidth, detailGridScrollWidth: detailGrid.scrollWidth, detailChildren, scrollRegions, filterContentInsetLeft: filterContent.left - dialog.left, filterContentInsetRight: dialog.right - filterContent.right, bodyPaddingLeft: Number.parseFloat(scrollStyle.paddingLeft), bodyPaddingRight: Number.parseFloat(scrollStyle.paddingRight), headerPaddingLeft: Number.parseFloat(headerStyle.paddingLeft), headerPaddingRight: Number.parseFloat(headerStyle.paddingRight), chipInsetLeft: chipsRow.left - dialog.left, chipInsetRight: dialog.right - chipsRow.right, chipRows: uniqueRows(chips), filterRows: uniqueRows(controls), controlWidths: controls.map(item => Math.round(item.width)), controlHeights: [...new Set(controls.map(item => Math.round(item.height)))], filterFontSizes: [...new Set([...document.querySelectorAll('.usage-details .sheet-filter-grid .tt-select-trigger')].map(node => getComputedStyle(node).fontSize))], chipGap: getComputedStyle(document.querySelector('.usage-details .sheet-chip-row')).columnGap, overflow: filters.right > dialog.right + 1 };
    });
    report.layouts.push({ label, width, language, theme, scoped, ...geometry });
    const filename = `${label}-${width}-${language}-${theme}-${scoped ? 'project' : 'all'}.png`;
    await page.screenshot({ path: join(out, filename) }); report.screenshots.push(filename);
    return geometry;
  };

  await measure('global-wide-default', 1440, 'en', 'light', false);
  const interactionStart = await page.evaluate(() => window.__usageFixture.calls.length);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.waitForFunction(start => window.__usageFixture.calls.slice(start).some(call => call.method === 'usage.query'), interactionStart);
  await page.getByRole('combobox', { name: 'Provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.waitForFunction(() => window.__usageFixture.calls.some(call => call.method === 'usage.query' && call.params.provider === 'claude'));
  await page.waitForFunction(() => document.querySelectorAll('.usage-log').length === 4);
  const modelBefore = await page.evaluate(() => window.__usageFixture.calls.filter(call => call.method === 'usage.query').length);
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'claude-sonnet-4', exact: true }).click();
  await page.waitForTimeout(100);
  const modelAfter = await page.evaluate(() => window.__usageFixture.calls.filter(call => call.method === 'usage.query').length);
  assert.equal(modelAfter, modelBefore, 'model filter continues to filter fetched records locally');
  assert.equal(await page.locator('.usage-log').count(), 4, 'model selection filters the rendered usage records');
  report.interactions.push('range/provider/model filtering uses production UsagePanel; model filtering remains local');

  for (const width of [1280, 1440, 1920, 960, 720, 600, 390]) {
    const presentations = width === 1440 || width === 600 || width === 390
      ? [['en','light'], ['en','dark'], ['zh','light'], ['zh','dark']]
      : [['en','light'], ['zh','dark']];
    for (const [language, theme] of presentations) {
      for (const scoped of [false, true]) {
        const geometry = await measure('usage', width, language, theme, scoped);
        assert.equal(geometry.overflow, false, `${width}px ${language}/${theme} scoped=${scoped} has no dialog overflow`);
        assert.ok(geometry.scrollRegions.every(region => region.scrollWidth <= region.clientWidth + 1), `${width}px usage content and record areas have no horizontal overflow: ${JSON.stringify(geometry.scrollRegions)}`);
        assert.ok(geometry.filterContentInsetLeft >= 16 && geometry.filterContentInsetRight >= 16, `${width}px filters align with dialog content inset`);
        assert.ok(geometry.filterContentInsetLeft >= geometry.bodyPaddingLeft + 4 && geometry.filterContentInsetLeft <= geometry.headerPaddingLeft + 1, `${width}px filter inset sits between body and header content insets`);
        assert.ok(geometry.filterContentInsetRight >= geometry.bodyPaddingRight + 4 && geometry.filterContentInsetRight <= geometry.headerPaddingRight + 1, `${width}px right filter inset matches body/header rhythm`);
        assert.ok(geometry.chipInsetLeft >= 16 && geometry.chipInsetRight >= 16, `${width}px time chips align with dialog content inset`);
        assert.equal(geometry.controlHeights[0], 32, `${width}px filter controls have readable 32px height`);
        assert.ok(geometry.controlWidths.every(value => value >= 120), `${width}px filters retain at least 120px width`);
        if (width >= 1280) assert.equal(geometry.filterRows, 1, `${width}px has one aligned filter row`);
        else if (width <= 720) {
          const maxRows = width <= 420 ? 3 : 2;
          assert.ok(geometry.filterRows <= maxRows, `${width}px compact filters wrap to at most ${maxRows} rows`);
          if (!scoped) assert.ok(geometry.filterRows >= 2, `${width}px compact global filters wrap cleanly`);
        } else assert.equal(geometry.filterRows, 1, `${width}px filters stay aligned when they fit`);
      }
    }
  }
  assert.deepEqual(report.pageErrors, [], 'fixture produced no page errors');
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\r\n');
  await app?.close().catch(() => {});
  await new Promise(done => server.close(done));
  console.log(JSON.stringify(report));
}
