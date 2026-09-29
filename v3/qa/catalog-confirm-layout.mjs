import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'results/catalog-confirm-layout', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { checks: [], screenshots: [], errors: [] };
const longName = '极长目录名称 '.repeat(22) + 'continuous_unbroken_identifier_'.repeat(12);
const longError = 'Fixture archive rejected: '.repeat(18) + 'continuous_unbroken_error_'.repeat(12);

function interceptArchive() {
  const original = window.threadterm.request.bind(window.threadterm);
  window.threadterm.request = async (method, params) => {
    if (method === 'catalog.visibility.update' && params.visibility === 'archived') throw new Error(window.__catalogLayoutError);
    return original(method, params);
  };
}

await mkdir(out, { recursive: true });
const seed = JSON.parse(await readFile(join(here, 'results/parity/2026-09-10T14-50-58-408Z/visual-fixture.json'), 'utf8'));
seed.sessions.find(session => session.id === 'pulse-shell').name = longName;
let app, server, page;
try {
  const profile = await mkdtemp(join(tmpdir(), 'threadterm-confirm-layout-'));
  app = await electron.launch({ args: [join(here, 'parity/electron-static.cjs')], env: { ...process.env, TT_PARITY_PROFILE: profile }, timeout: 15000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.addInitScript(installVisualFixture, { seed, theme: 'light' });
  await page.addInitScript(interceptArchive);
  server = await startReadonlyReferenceServer(join(root, 'desktop-dist/renderer'));
  const cases = [
    { theme: 'light', width: 1280, height: 900, scale: 1 },
    { theme: 'dark', width: 1280, height: 900, scale: 1 },
    { theme: 'light', width: 1440, height: 900, scale: 1 },
    { theme: 'dark', width: 1440, height: 900, scale: 1 },
    { theme: 'light', width: 1920, height: 900, scale: 1 },
    { theme: 'dark', width: 1920, height: 900, scale: 1 },
    { theme: 'light', width: 640, height: 520, scale: 1.25 },
    { theme: 'dark', width: 640, height: 520, scale: 1.25 },
  ];
  for (const config of process.env.TT_LAYOUT_SMOKE ? cases.slice(0, 1) : process.env.TT_LAYOUT_NARROW ? cases.slice(-2) : cases) {
    await page.setViewportSize({ width: config.width, height: config.height });
    await app.evaluate(({ BrowserWindow }, scale) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(scale), config.scale);
    await page.goto(`${server.origin}/?theme=${config.theme}`);
    await page.evaluate(error => { window.__catalogLayoutError = error; }, longError);
    await page.locator('.proj-row').first().waitFor();
    for (const kind of ['remove', 'archive', 'remove-active']) {
      const name = `${kind}-${config.theme}-${config.width}-${config.scale}`;
      console.log(`checking ${name}`);
      try {
        const row = kind === 'remove-active'
          ? page.locator('.sess-row-wrap').filter({ hasText: '开发服务器' })
          : page.locator('.sess-row-wrap').filter({ hasText: longName });
        await row.hover();
        await row.locator('.row-more').click();
        const menu = page.locator('.catalogue-popover');
        await menu.getByRole('menuitem', { name: kind === 'archive' ? '归档' : '删除', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        if (kind === 'archive') {
          await dialog.getByRole('button', { name: '确认归档' }).click();
          await dialog.getByRole('alert').filter({ hasText: longError }).waitFor();
        }
        const layout = await dialog.evaluate(element => {
          const body = element.querySelector('.dlg-body');
          const footer = element.querySelector('.dlg-foot');
          const headText = element.querySelector('.sheet-head-text');
          const bodyBox = body.getBoundingClientRect();
          const footerBox = footer.getBoundingClientRect();
          const dialogBox = element.getBoundingClientRect();
          const style = getComputedStyle(body);
          return { className: element.className, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, fontSize: style.fontSize, lineHeight: style.lineHeight, bodyOverflow: body.scrollWidth > body.clientWidth, headOverflow: headText.scrollWidth > headText.clientWidth, dialogOverflow: element.scrollWidth > element.clientWidth, footerVisible: footerBox.bottom <= innerHeight + 1 && footerBox.top >= dialogBox.top && bodyBox.bottom <= footerBox.top + 1, footerButtonVisible: [...footer.querySelectorAll('button')].every(button => { const box = button.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1; }) };
        });
        const screenshot = join(out, `${name}.png`);
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        report.screenshots.push(screenshot);
        assert.equal(layout.paddingLeft, '20px', JSON.stringify(layout));
        assert.equal(layout.paddingRight, '20px', JSON.stringify(layout));
        assert.equal(layout.fontSize, '14px', JSON.stringify(layout));
        assert.equal(layout.lineHeight, '22.4px', JSON.stringify(layout));
        assert.equal(layout.bodyOverflow, false, JSON.stringify(layout));
        assert.equal(layout.headOverflow, false, JSON.stringify(layout));
        assert.equal(layout.dialogOverflow, false, JSON.stringify(layout));
        assert.equal(layout.footerVisible, true, JSON.stringify(layout));
        assert.equal(layout.footerButtonVisible, true, JSON.stringify(layout));
        const mutations = await page.evaluate(() => window.__parityFixture.calls.filter(call => ['session.stop', 'catalog.visibility.update'].includes(call.method)));
        assert.deepEqual(mutations, [], 'layout QA must not stop sessions or change catalogue records');
        report.checks.push({ name, passed: true, layout });
      } catch (error) {
        report.checks.push({ name, passed: false, error: String(error) });
        report.errors.push(name);
      } finally {
        const cancel = page.getByRole('dialog').getByRole('button', { name: '取消', exact: true });
        if (await cancel.count()) await cancel.click().catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  }
} catch (error) { report.errors.push(error.stack ?? String(error)); }
finally {
  await app?.close().catch(() => {});
  await server?.close();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.checks.filter(check => check.passed).length, failed: report.checks.filter(check => !check.passed), errors: report.errors }, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
