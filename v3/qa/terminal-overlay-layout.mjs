// Visual regression for terminal loading overlays.  The fixture mounts the
// production TerminalSurface and stylesheet in Electron; it intentionally
// leaves replay pending so the overlay is present while controls are tested.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-overlay-'));
const out = resolve('qa/results/terminal-overlay-layout');
await mkdir(out, { recursive: true });

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

window.threadterm = {
  platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 },
  onEvent: () => () => {}, openExternal: async () => {},
  request: async (method) => {
    if (method === 'terminal.read') return { nextCursor: 64 };
    if (method === 'session.launch.read') throw Error('session_launch_unavailable');
    return { leaseEpoch: 1 };
  },
  // Deliberately no callback: the durable watermark has not arrived yet.
  subscribeOutput: async () => () => {},
};
function Fixture() {
  const [theme, setTheme] = useState('light');
  window.qaSetTheme = setTheme;
  const session = { id:'overlay-qa', title:'Overlay QA', provider:'codex', mode:'terminal',
    status:'interrupted', readOnly:false, worktreePath:'D:/project/ThreadTerm',
    createdAt:'now', updatedAt:'now', cols:120, rows:32 };
  return <I18nProvider locale="zh-CN"><main className="qa-shell"><div className="qa-pane">
    <TerminalSurface sessionId="overlay-qa" session={session} provider="codex" theme={theme}
      terminalCompatibility={{}} onCloseView={() => {}} onConfigure={() => {}} />
  </div></main></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>
html,body,#root { width:100%; height:100%; margin:0; }
.qa-shell { display:flex; box-sizing:border-box; width:100%; height:100%; padding:20px; background:#eef1f5; }
.qa-pane { display:flex; flex:1; min-width:0; min-height:0; border:1px solid #cad1dc; background:#fff; }
.qa-pane > .terminal-wrap { flex:1; min-width:0; min-height:0; }
.term-head { display:flex; align-items:center; gap:8px; flex:0 0 auto; min-width:0; min-height:36px; padding:6px 12px; border-bottom:1px solid #d7dce5; }
.term-head .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.term-head .btn { flex:0 0 auto; }
</style><link rel="stylesheet" href="qa.css"><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 860, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});`);

const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const rect = (value) => ({ left:value.x, top:value.y, right:value.x + value.width, bottom:value.y + value.height, width:value.width, height:value.height });
const report = { passed:false, checks:[], screenshots:[] };
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout:15_000 });
  const page = await app.firstWindow({ timeout:15_000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.term-content').waitFor();
  await page.locator('.term-loading-overlay.term-replaying').waitFor();
  assert.equal(await page.locator('.term-loading-overlay').innerText(), '', 'normal loading must show only the animated Agent Logo');
  assert.equal(await page.locator('.term-loading-overlay progress, .term-loading-overlay .term-replay-progress').count(), 0);
  assert.equal(await page.locator('.term-loading-overlay .chat-connect-wave').count(), 1);
  // BrowserWindow test runners do not consistently expose a configurable
  // deviceScaleFactor. CSS zoom exercises the same fractional layout path
  // that caused the fixed 64px overlay offset to cover controls at 125% DPI.
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });

  async function assertLayout(label, width, paneWidth) {
    await page.setViewportSize({ width, height:860 });
    await page.evaluate((nextPaneWidth) => {
      const scale = Number(getComputedStyle(document.documentElement).zoom) || 1;
      document.querySelector('.qa-pane').style.flex = '0 0 ' + (nextPaneWidth / scale) + 'px';
    }, paneWidth);
    await page.waitForTimeout(80);
    const geometry = await page.evaluate(() => {
      const get = (selector) => {
        const element = document.querySelector(selector);
        if (!element) throw Error('missing ' + selector);
        const box = element.getBoundingClientRect();
        return { x:box.x, y:box.y, width:box.width, height:box.height };
      };
      const controls = [...document.querySelectorAll('.v3-session-controls button')].map(button => {
        const box = button.getBoundingClientRect();
        const point = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { text:button.textContent, x:box.x, y:box.y, width:box.width, height:box.height,
          reachable:point === button || button.contains(point) };
      });
      return { head:get('.term-head'), controlBar:get('.v3-session-controls'), content:get('.term-content'),
        overlay:get('.term-loading-overlay'), host:get('.terminal-host'), foot:get('.term-foot'), controls,
        zoom:getComputedStyle(document.documentElement).zoom };
    });
    const content = rect(geometry.content), overlay = rect(geometry.overlay);
    assert.ok(overlay.left >= content.left && overlay.top >= content.top && overlay.right <= content.right && overlay.bottom <= content.bottom,
      `${label}: loading overlay escaped terminal content`);
    assert.equal(intersects(rect(geometry.overlay), rect(geometry.head)), false, `${label}: loading overlay covers the header`);
    assert.equal(intersects(rect(geometry.overlay), rect(geometry.controlBar)), false, `${label}: loading overlay covers session controls`);
    assert.equal(intersects(rect(geometry.overlay), rect(geometry.foot)), false, `${label}: loading overlay covers footer`);
    assert.ok(geometry.host.width > 0 && geometry.host.height > 0, `${label}: xterm host is not measurable while masked`);
    assert.ok(geometry.controls.every(control => control.reachable), `${label}: a visible session control is obscured`);
    await page.locator('.v3-session-controls button').last().focus();
    assert.equal(await page.locator('.v3-session-controls button').last().evaluate(button => document.activeElement === button), true,
      `${label}: keyboard focus cannot reach the final session control`);
    await page.screenshot({ path:join(out, `${label}.png`), animations:'disabled' });
    report.screenshots.push(`${label}.png`);
    return geometry;
  }

  const normal = [];
  for (const width of [1280, 1440, 1920]) normal.push(await assertLayout(`light-${width}`, width, width - 40));
  const small = await assertLayout('light-small-pane', 1280, 320);
  assert.ok(small.controlBar.height > normal[0].controlBar.height, 'small pane controls must wrap instead of overflowing below the overlay');
  await page.evaluate(() => window.qaSetTheme('dark'));
  const dark = await assertLayout('dark-1440', 1440, 1400);
  assert.equal(dark.zoom, '1.25', '125% layout zoom was not applied');
  assert.deepEqual(errors, []);
  report.passed = true;
  report.checks = ['overlay bounded by term-content', 'header/control/footer remain outside overlay', 'controls wrap and pass hit testing in a narrow pane', 'keyboard focus reaches controls', 'light/dark and 1.25 scale Electron captures'];
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed:true, out, checks:report.checks }));
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (app) await app.close().catch(() => {});
}
