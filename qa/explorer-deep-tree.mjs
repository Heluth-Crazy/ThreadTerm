// Desktop-1 regression for a 12-level explorer filename. The tree keeps its own
// scroll width, reveals a selected name that starts outside the host, and does
// not take keyboard focus.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'qa/results/explorer-deep-tree');
const scratch = await mkdtemp(join(tmpdir(), 'tt-explorer-deep-'));
const deep = Array.from({ length: 12 }, (_, index) => `d${String(index).padStart(2, '0')}`);
const filename = 'a-deliberately-long-selected-filename-that-must-not-fit-in-a-narrow-explorer-pane.ts';
const target = `${deep.join('/')}/${filename}`;
const entries = new Map([['', [{ path: deep[0], name: deep[0], kind: 'directory' }]]]);
for (let index = 0; index < deep.length; index += 1) {
  const path = deep.slice(0, index + 1).join('/');
  entries.set(path, index + 1 === deep.length
    ? [{ path: target, name: filename, kind: 'file' }]
    : [{ path: deep.slice(0, index + 2).join('/'), name: deep[index + 1], kind: 'directory' }]);
}
const source = `
 import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
 import { ExplorerView } from './renderer/src/components/ExplorerView'; import './renderer/src/styles.css'; import './renderer/src/workbench/workbench.css';
 const entries = ${JSON.stringify(Object.fromEntries(entries))}; const target = ${JSON.stringify(target)};
 window.threadterm = { request: async (method, params) => { if (method === 'filesystem.list') return entries[params.path] ?? []; if (method === 'filesystem.rename') return null; throw Error('unexpected ' + method); }, onPageContextMenu: () => () => {}, platform: 'win32' };
 const actions = { openFile: path => window.__actions.push(['openFile', path]), openDiff: () => {}, dirtyPaths: () => [], renamed: (from, to) => window.__actions.push(['renamed', from, to]), deleted: () => {} };
 const git = { loading: false, refresh: async () => {} };
 function Probe() {
  const [path, setPath] = useState(target);
  const [width, setWidth] = useState(240);
  window.__probe = { setPath, setWidth }; window.__actions = window.__actions || [];
  return <main className="probe" style={{width}}><ExplorerView scope={{projectId:'public-fixture',rootPath:'C:/public-fixture'}} actions={actions} git={git} zh={false} activePath={path}/></main>;
 }
 createRoot(document.getElementById('root')).render(<Probe/>);
`;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
await mkdir(out, { recursive: true });
await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'probe.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>html,body,#root{margin:0;height:100%;background:var(--bg,#f6f3ee)}.probe{height:520px;overflow:auto;border:1px solid var(--border,#888);background:var(--surface,#fff);color:var(--text,#222)}</style><button id="focus-keeper" type="button">Keep focus</button><div id="root"></div><script src="probe.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:720,show:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
try {
  const blocked = /^(path|home|userprofile|codex_home|data|profile|pipe|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
  Object.assign(env, { Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-explorer-deep-${process.pid}` });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'PATH isolation keeps exactly one spelling');
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env, timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => Boolean(window.__probe));
  const measure = () => page.evaluate(file => {
    const row = document.querySelector(`[data-path="${CSS.escape(file)}"]`);
    const name = row?.querySelector('.wb-name');
    const host = document.querySelector('.probe');
    const hostBox = host.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    return {
      selected: row.getAttribute('aria-selected'),
      level: row.getAttribute('aria-level'),
      title: row.getAttribute('title'),
      nameWidth: name.clientWidth,
      nameScroll: name.scrollWidth,
      rowDisplay: getComputedStyle(name.parentElement).display,
      rowFont: getComputedStyle(name.parentElement).fontSize,
      hostClient: host.clientWidth,
      hostScroll: host.scrollWidth,
      scrollLeft: host.scrollLeft,
      nameLeft: nameBox.left - hostBox.left,
      nameRight: nameBox.right - hostBox.right,
      focused: document.activeElement?.id ?? document.activeElement?.getAttribute('data-path') ?? document.activeElement?.tagName,
      tools: (() => { const tools = document.querySelector('.wb-view-actions'); if (!tools) return null; const box = tools.getBoundingClientRect(); return { left: box.left - hostBox.left, right: box.right - hostBox.right }; })(),
      theme: document.documentElement.dataset.theme,
      text: getComputedStyle(name).color,
    };
  }, target);
  await page.locator(`[data-path="${target}"]`).waitFor();
  const selectedRow = page.locator(`[data-path="${target}"]`);
  await selectedRow.focus();
  await selectedRow.press('ArrowUp');
  await selectedRow.focus();
  await selectedRow.press('Enter');
  await page.waitForFunction(path => window.__actions.some(action => action[0] === 'openFile' && action[1] === path), target);
  // F2 invokes the same available Rename action exposed by the row's context menu.
  await selectedRow.press('F2');
  const rename = page.locator('.wb-tree-row.editing input');
  await rename.fill('renamed-after-reveal.ts');
  await rename.press('Enter');
  await page.waitForFunction(path => window.__actions.some(action => action[0] === 'renamed' && action[1] === path && action[2].endsWith('renamed-after-reveal.ts')), target);
  await selectedRow.click();
  await page.locator('#focus-keeper').focus();
  await page.locator('#focus-keeper').focus();
  for (const [theme, width, label] of [['light', 240, 'narrow'], ['dark', 960, 'wide']]) {
    await page.evaluate(({ theme: nextTheme, width: nextWidth }) => { document.documentElement.dataset.theme = nextTheme; window.__probe.setWidth(nextWidth); }, { theme, width });
    await page.waitForTimeout(80);
    const geometry = await measure();
    assert.equal(geometry.theme, theme, `${label} theme did not apply: ${geometry.theme}`);
    assert.equal(geometry.text, theme === 'dark' ? 'rgb(236, 235, 229)' : 'rgb(35, 34, 31)', `${label} theme colors did not apply: ${geometry.text}`);
    assert.equal(geometry.selected, 'true', `${label} row is not selected`);
    assert.equal(geometry.level, '13', `${label} aria level changed`);
    assert.equal(geometry.title, target, `${label} title attribute changed`);
    assert.equal(geometry.rowDisplay, 'flex', `${label} production row CSS is not linked: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.rowFont, '13px', `${label} production row metrics changed: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.nameWidth > 200, `${label} filename collapsed: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.nameWidth - geometry.nameScroll) < 2, `${label} filename is still ellipsized`);
    if (label === 'narrow') {
      assert.ok(geometry.hostScroll > geometry.hostClient + geometry.nameWidth / 2, `${label} host cannot reach the filename: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.nameLeft >= -2 && geometry.nameLeft < geometry.hostClient, `${label} filename start is outside the host: ${JSON.stringify(geometry)}`);
    } else {
      assert.ok(geometry.nameRight <= 2, `${label} filename extends past a wide host: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.scrollLeft, 0, `${label} scrolled a filename that already fits`);
    }
    assert.equal(geometry.focused, 'focus-keeper', `${label} reveal took focus`);
    assert.ok(geometry.tools && geometry.tools.left >= -2 && geometry.tools.right <= 8, `${label} fallback toolbar left the pane: ${JSON.stringify(geometry.tools)}`);
    const shot = join(out, `tree-${theme}-${label}.png`);
    await page.screenshot({ path: shot });
    report.screenshots.push(shot);
  }
  report.checks.push('deep filename keeps its width, scrolls inside the tree host, Arrow/Enter opens the selected file, and context Rename keeps actions scoped to that tree');
  report.passed = true;
  process.stdout.write('PASS explorer deep tree\n');
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!report.passed && app) await app.firstWindow().then(page => page.screenshot({ path: join(out, 'failure.png') })).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  if (app) await Promise.race([app.close().catch(() => undefined), new Promise(resolveClose => setTimeout(resolveClose, 5000))]);
  process.stdout.write(`${report.passed ? 'EXPLORER TREE QA PASSED' : 'EXPLORER TREE QA FAILED'} ${join(out, 'report.json')}\n`);
  process.exit(report.passed ? 0 : 1);
}
