// Settings layout QA: every page in zh-CN/en, light/dark. Captures each page
// (scrolled in segments) and audits geometry inside grouped cards: content must
// keep the card inset, stay inside the card, and never overlap other content.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, cpSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? (() => { throw new Error('TEMP must be tt-qa-temp'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const mode = process.argv.includes('--toolbar') ? 'toolbar' : process.argv.includes('--start') ? 'start' : 'settings';
const out = join(root, { toolbar: 'qa/results/toolbar-views', start: 'qa/results/start-composer', settings: 'qa/results/settings-layout' }[mode]);
const scratch = await mkdtemp(join(base, 'tt-settings-layout-'));
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const data = join(scratch, 'data'), profile = join(scratch, 'profile'), pipe = `\\\\.\\pipe\\tt-settings-layout-${randomUUID()}`;
const reportOnly = process.argv.includes('--report');
const only = process.argv.find(arg => arg.startsWith('--tab='))?.slice(6);
const report = { passed: false, issues: [], screenshots: [], errors: [] };
let app, page, runtimeProcess, runtimeLog, releaseLock, qaApp;
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const wait = async (probe, label, timeout = 30_000) => { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`); await new Promise(done => setTimeout(done, 100)); } };

function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_runtime_bin'].includes(key.toLowerCase())));
  return Object.assign(env, {
    TEMP: base, TMP: base, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_PROVIDER_BIN: bin,
  });
}

// Runs in the page. A "card" is a rounded, filled group box inside the active page.
function audit() {
  const body = document.querySelector('.mac-settings-window > .settings-body');
  const page = body.querySelector('.settings-group.active') ?? body;
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
  const filled = s => s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none' || s.backgroundImage !== 'none';
  const isCard = el => { const s = getComputedStyle(el); return parseFloat(s.borderTopLeftRadius) >= 8 && filled(s) && el.getBoundingClientRect().width >= 320; };
  const name = el => { const parts = []; for (let node = el; node && node !== page && parts.length < 3; node = node.parentElement) parts.unshift(`${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`); return parts.join(' > '); };
  const textOf = el => [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
  const control = el => el.matches('button,input:not([type=hidden]),select,textarea,[role=switch],[role=combobox],.tt-select');
  const leaves = [...page.querySelectorAll('*')].filter(el => visible(el) && !el.closest('.sr-only') && (control(el) || textOf(el)) && !el.closest('svg') && !(el.parentElement && control(el.parentElement)) && !el.parentElement?.closest('.tt-select'));
  const issues = [];
  const cards = [...page.querySelectorAll('*')].filter(el => visible(el) && isCard(el));
  const cardOf = el => { for (let node = el.parentElement; node && node !== page; node = node.parentElement) if (cards.includes(node)) return node; return undefined; };
  for (const el of leaves) {
    const card = cardOf(el); if (!card) continue;
    if (el.closest('.theme-gallery-grid,.background-layout,.background-library,.mac-mode-thumb,.astryx-root,[data-settings-audit="skip"]')) continue;
    const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
    // Content that is not itself full-bleed (rows, separators) must keep a 10px inset.
    const label = `${name(el)} "${(textOf(el) || el.getAttribute('aria-label') || el.tagName).slice(0, 40)}"`;
    if (r.left < c.left + 10 - 0.5) issues.push({ kind: 'inset-left', at: label, px: Math.round(r.left - c.left) });
    if (r.right > c.right - 10 + 0.5) issues.push({ kind: 'inset-right', at: label, px: Math.round(c.right - r.right) });
    if (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) issues.push({ kind: 'outside-card', at: label });
  }
  const boxes = leaves.filter(el => !el.closest('.theme-gallery-grid,.background-library,.astryx-root')).map(el => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 1 && h > 1) issues.push({ kind: 'overlap', at: `${name(a.el)} "${textOf(a.el).slice(0, 24)}" × ${name(b.el)} "${textOf(b.el).slice(0, 24)}"`, px: `${Math.round(w)}x${Math.round(h)}` });
  }
  // Horizontal overflow of the page itself.
  if (body.scrollWidth > body.clientWidth + 1) issues.push({ kind: 'page-overflow-x', at: 'settings-body', px: body.scrollWidth - body.clientWidth });
  return issues;
}

async function openSettings(zh) {
  if (await page.locator('.settings-panel').count()) { await page.keyboard.press('Escape'); await page.locator('.settings-panel').waitFor({ state: 'detached' }); }
  await page.getByRole('button', { name: zh ? '本地用户' : 'Local user', exact: true }).click();
  await page.locator('.shell-menu-foot').getByRole('button', { name: zh ? '设置' : 'Settings', exact: true }).click();
  await page.locator('.settings-panel').waitFor();
}

async function capture(label, tab) {
  const body = page.locator('.mac-settings-window > .settings-body');
  await body.evaluate(node => { node.scrollTop = 0; });
  await page.mouse.move(0, 0); await settle();
  const { scrollHeight, clientHeight } = await body.evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  const issues = [];
  for (let top = 0, index = 0; ; top += clientHeight - 40, index++) {
    await body.evaluate((node, value) => { node.scrollTop = value; }, top); await settle();
    for (const issue of await page.evaluate(audit)) if (!issues.some(seen => seen.kind === issue.kind && seen.at === issue.at)) issues.push(issue);
    const file = `${label}-${tab}-${index}.png`;
    await page.locator('.settings-panel').screenshot({ path: join(out, file), animations: 'disabled' }); report.screenshots.push(file);
    if (top + clientHeight >= scrollHeight || index > 8) break;
  }
  for (const issue of issues) report.issues.push({ variant: label, tab, ...issue });
  if (process.argv.includes('--dom') && label === 'zh-CN-light') await writeFile(join(out, `dom-${tab}.txt`), await page.evaluate(() => {
    const lines = [], walk = (node, depth) => { if (depth > 9) return; const s = getComputedStyle(node); if (s.display === 'none') return; const own = [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent.trim()).join(' ').slice(0, 30); const r = node.getBoundingClientRect();
      lines.push(`${'  '.repeat(depth)}${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : ''}${node.getAttribute('role') ? `[${node.getAttribute('role')}]` : ''} ${Math.round(r.left)},${Math.round(r.width)} pad=${s.padding} ${own ? JSON.stringify(own) : ''}`);
      if (!node.matches('svg, .astryx-scope *')) for (const child of node.children) walk(child, depth + 1); };
    walk(document.querySelector('.mac-settings-window > .settings-body .settings-group.active'), 0); return lines.join(String.fromCharCode(10)); }));
  return issues;
}

// The start page composer (project, worktree and agent pickers) in light and dark.
async function start() {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', '-b', 'fix/terminal-workbench-polish', work]);
  await request('project.add', { path: work, name: 'ThreadTerm', operationId: randomUUID() });
  await page.getByRole('button', { name: 'ThreadTerm', exact: true }).first().click();
  const composer = page.locator('.workbench-page .composer'); await composer.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.workbench-page .composer-chip')].every(chip => !/Loading|加载/.test(chip.textContent)));
  for (const theme of ['light', 'dark']) {
    const snap = await request('runtime.snapshot');
    await request('settings.update', { patch: { theme }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme); await page.mouse.move(0, 0); await settle();
    await composer.screenshot({ path: join(out, `start-composer-${theme}.png`), animations: 'disabled' }); report.screenshots.push(`start-composer-${theme}.png`);
    report.measurements = { ...report.measurements, [`start-${theme}`]: await page.locator('.workbench-page .composer-row').evaluate(row => [...row.querySelectorAll('.composer-chip, .composer-chip .tt-select, .composer-send')].map(node => { const s = getComputedStyle(node); return `${node.className} border=${s.borderTopWidth} ${s.borderTopColor} shadow=${s.boxShadow} bg=${s.backgroundColor} h=${node.getBoundingClientRect().height}`; })) };
  }
}

// The session toolbar's view switcher next to the prototype's, both at CSS scale 1, light and dark.
async function toolbar() {
  const { chromium } = await import('@playwright/test');
  const project = await request('project.add', { path: work, name: 'Toolbar QA project with a deliberately long name', operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'terminal', title: 'Toolbar QA', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), session.id);
  const views = page.locator('.wb-toolbar-views'); await views.waitFor();
  const browser = await chromium.launch(); const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    for (const theme of ['light', 'dark']) {
      const snap = await request('runtime.snapshot');
      await request('settings.update', { patch: { theme }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme); await page.mouse.move(0, 0); await settle();
      await views.screenshot({ path: join(out, `toolbar-real-${theme}.png`), scale: 'css', animations: 'disabled' });
      await proto.goto(`file:///${join(root, 'prototypes/mac-style/index.html').replaceAll('\\', '/')}?screen=session&palette=mac&style=flush&theme=${theme}`);
      const seg = proto.locator('.toolbar .seg').first(); await seg.waitFor();
      const box = await seg.evaluate(node => { const a = node.getBoundingClientRect(), b = node.nextElementSibling.querySelector('button').getBoundingClientRect(); return { x: a.left, y: Math.min(a.top, b.top), width: b.right - a.left, height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) }; });
      await proto.screenshot({ path: join(out, `toolbar-proto-${theme}.png`), clip: box, animations: 'disabled' });
      const geometry = root => [...document.querySelectorAll(root)].flatMap(group => [group, ...group.querySelectorAll('button, svg')]).map(node => { const r = node.getBoundingClientRect(); return `${node.tagName.toLowerCase()}${node.dataset?.view ? '[' + node.dataset.view + ']' : ''} ${r.width.toFixed(1)}x${r.height.toFixed(1)} @${r.left.toFixed(1)},${r.top.toFixed(1)}`; });
      report.measurements = { ...report.measurements, [`real-${theme}`]: await page.evaluate(geometry, '.wb-toolbar-views'), [`proto-${theme}`]: await proto.evaluate(geometry, '.toolbar .seg, .toolbar .seg + .tb-group') };
      report.screenshots.push(`toolbar-real-${theme}.png`, `toolbar-proto-${theme}.png`);
    }
  } finally { await browser.close(); }
  // The minimum window (960 px) with the sidebar open: nothing in the toolbar may run under the caption buttons or
  // under its neighbour.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 640)); await page.setViewportSize({ width: 960, height: 640 }); await settle();
  await page.locator('.ws-top').screenshot({ path: join(out, 'toolbar-960.png'), animations: 'disabled' }); report.screenshots.push('toolbar-960.png');
  const crowd = await page.evaluate(() => {
    const caption = document.querySelector('.app-shell > .window-controls').getBoundingClientRect();
    const items = [...document.querySelectorAll('.ws-top > *, .ws-top .wb-toolbar-views > *, .session-toolbar-subtitle')].filter(node => node.getBoundingClientRect().width > 0 && !node.classList.contains('top-spacer'));
    const issues = [];
    for (const node of items) { const r = node.getBoundingClientRect(); if (r.right > caption.left + 0.5) issues.push(`${node.className} runs under the caption buttons by ${Math.round(r.right - caption.left)} px`); }
    const subtitle = document.querySelector('.session-toolbar-subtitle'), run = document.querySelector('.ws-top .ql-activity');
    if (subtitle && run && subtitle.getBoundingClientRect().right > run.getBoundingClientRect().left + 0.5 && subtitle.scrollWidth > subtitle.clientWidth + 0.5 && getComputedStyle(subtitle).overflow !== 'hidden') issues.push('subtitle runs under the Run field');
    return issues;
  });
  report.issues.push(...crowd.map(at => ({ variant: '960', tab: 'toolbar', kind: 'crowded', at })));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)); await page.setViewportSize({ width: 1440, height: 900 });
}

try {
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(work, { recursive: true })]);
  cpSync(join(root, 'qa/fixtures/chat-visual-echo-acp'), join(plugins, 'chat-visual-echo-acp'), { recursive: true });
  await writeFile(join(bin, 'fake-terminal.cjs'), "process.stdout.write('Settings layout terminal ready\\r\\n');process.stdin.resume();\n");
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nif "%~1"=="--help" (echo codex-settings-qa --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root, 'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  runtimeLog = createWriteStream(join(scratch, 'runtime.log'));
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeProcess.stdout.pipe(runtimeLog); runtimeProcess.stderr.pipe(runtimeLog);
  await wait(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime');
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
  await wait(async () => (await request('provider.list')).some(item => item.id === 'codex'), 'fake Codex discovery');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)); await page.setViewportSize({ width: 1440, height: 900 });
  if (mode === 'toolbar') await toolbar();
  if (mode === 'start') await start();
  for (const [language, theme] of mode !== 'settings' ? [] : process.argv.includes('--dom') ? [['zh-CN', 'light']] : [['zh-CN', 'light'], ['zh-CN', 'dark'], ['en', 'light']]) {
    const snap = await request('runtime.snapshot');
    await request('settings.update', { patch: { language, theme, themeSelection: undefined, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
    await page.waitForFunction(value => document.documentElement.lang === value, language);
    const zh = language === 'zh-CN', label = `${language}-${theme}`;
    await openSettings(zh);
    // 11-19: the search pill owns the focus ring; the bare input inside draws none (it drew one larger than the pill).
    const search = page.locator('label.mac-settings-search');
    await search.locator('input').focus();
    const ring = await search.evaluate(pill => { const field = getComputedStyle(pill), input = getComputedStyle(pill.querySelector('input')); return { pill: `${field.outlineStyle} ${field.outlineWidth}`, input: `${input.outlineStyle} ${input.outlineWidth}` }; });
    if (ring.pill !== 'solid 3px' || !ring.input.startsWith('none ')) report.issues.push({ variant: label, tab: 'search', kind: 'search-focus-ring', at: JSON.stringify(ring) });
    const pillBox = await search.boundingBox();
    if (pillBox) { const file = `${label}-search-focus.png`; await page.screenshot({ path: join(out, file), clip: { x: Math.max(0, pillBox.x - 10), y: Math.max(0, pillBox.y - 10), width: pillBox.width + 20, height: pillBox.height + 20 }, animations: 'disabled' }); report.screenshots.push(file); }
    await search.locator('input').evaluate(input => input.blur());
    const tabs = await page.locator('[data-settings-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.settingsTab));
    for (const tab of tabs) {
      if (only && tab !== only) continue;
      await page.locator(`[data-settings-tab="${tab}"]`).click();
      await page.waitForTimeout(tab === 'agents' || tab === 'usage' || tab === 'plugins' ? 1500 : 400);
      const issues = await capture(label, tab);
      console.log(`${label} ${tab}: ${issues.length} issue(s)`);
    }
  }
  report.passed = reportOnly || report.issues.length === 0;
  if (!reportOnly) assert.deepEqual(report.issues, [], 'Settings cards keep their inset and nothing overlaps');
} catch (error) {
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1; console.error(error);
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); runtimeLog?.end();
  await releaseLock?.().catch(() => {}); await qaApp?.cleanup?.().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
