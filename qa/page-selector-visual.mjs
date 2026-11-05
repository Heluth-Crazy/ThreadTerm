// Real Electron regression for #27: repeated nested elements need a unique selector.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve('.'), out = join(root, 'qa/results/page-selector-visual');
const scratch = await mkdtemp(join(tmpdir(), 'tt-page-selector-'));
const release = await acquireElectronQaLock('page-selector-visual');
let app;
const report = { passed: false, checks: [], errors: [] };
try {
  await mkdir(out, { recursive: true });
  await mkdir(join(root, 'runtime/target-qa'), { recursive: true });
  await writeFile(join(scratch, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  await build({ stdin: { contents: `
    import { app, BrowserWindow } from 'electron';
    import { pagePickerSource } from ${JSON.stringify(join(root, 'desktop/src/pagePickerScript.ts'))};
    import { sanitizePagePick } from ${JSON.stringify(join(root, 'desktop/src/pageCommentsCore.ts'))};
    app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
    globalThis.pickSource = pagePickerSource;
    globalThis.validatePick = sanitizePagePick;
    app.whenReady().then(() => { const win = new BrowserWindow({width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}); win.loadURL('about:blank'); });
  `, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(scratch, 'main.cjs') });
  app = await electron.launch({ args: [scratch], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')) });
  const page = await app.firstWindow();
  // Replace the remote response entirely; no external page or provider is used.
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Repeated nested form</title></head><body></body></html>' }));
  await page.goto('https://example.test/');
  await page.evaluate(() => {
    document.body.style.cssText = 'display:flex;gap:40px;padding:40px;font:18px sans-serif';
    for (let card = 0; card < 2; card++) {
      let parent = document.createElement('section'); document.body.append(parent);
      for (let depth = 0; depth < 10; depth++) { const child = document.createElement('div'); parent.append(child); parent = child; }
      const form = document.createElement('form'); parent.append(form);
      form.innerHTML = `<label>Card ${card + 1}<input placeholder="Name"></label><button type="button">Save</button>`;
    }
  });
  for (const [index, selector] of [[0, 'button'], [1, 'input']]) {
    const target = page.locator('section').nth(index).locator(selector);
    const rect = await target.boundingBox(); assert.ok(rect);
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.pendingPick = BrowserWindow.getAllWindows()[0].webContents.executeJavaScriptInIsolatedWorld(999, [{ code: globalThis.pickSource('pick') }]);
    });
    await page.waitForFunction(() => document.querySelector('[data-threadterm-page-picker]') || document.documentElement.children.length > 2);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.screenshot({ path: join(out, `picker-${index}.png`) });
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const pick = await app.evaluate(async () => globalThis.validatePick(await globalThis.pendingPick));
    assert.equal(pick.target.type, 'element');
    assert.equal(pick.target.tag, selector);
    assert.ok(pick.target.selector.length <= 500);
    assert.equal(await target.evaluate((node, path) => document.querySelectorAll(path).length === 1 && document.querySelector(path) === node, pick.target.selector), true);
    report.checks.push(`Repeated 10-level card ${index + 1} ${selector}: exact unique selector accepted`);
  }
  report.passed = true;
} catch (error) { report.errors.push(String(error.stack ?? error)); }
finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  release();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}
