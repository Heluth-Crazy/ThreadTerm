// Desktop-1 check that history preview and Chat share one Markdown table treatment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'qa/results/markdown-table');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
let page;
let server;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const path = 'C:/qa/nativehistory/NativeHistoryPathTokenThatCannotWrapAnywhere0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/sessiontranscript.ts';
const cells = ['Tool', 'Status', path];
const row = index => `<tr><td>Tool ${index}</td><td>Status ${index}</td><td>${path}</td></tr>`;
const table = `| ${cells.join(' | ')} |\n| --- | --- | --- |\n| Tool 1 | Status 1 | ${path} |\n| Tool 2 | Status 2 | ${path} |\n<script>window.__unsafeScriptRan=true</script><img src=x onerror="window.__unsafeAttributeRan=true">`;
const bounded = 'style="width:320px;max-width:320px"';
const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/renderer/src/styles.css"><link rel="stylesheet" href="/renderer/src/components/history-transcript.css"></head><body><main ${bounded}><section data-surface="history"><div id="root"></div></section><section class="v3-chat-message is-codex" data-surface="chat"><div class="chat-part"><div class="codex-markdown" id="chat-table"></div></div></section></main><script src="/fixture.js"></script></body></html>`;

function serve() {
  return new Promise(resolveServer => {
    const instance = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/fixture.html') {
          response.writeHead(200, { 'content-type': 'text/html' }).end(pageHtml);
          return;
        }
        if (url.pathname === '/fixture.js') {
          const body = await readFile(join(out, 'fixture.js'));
          response.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
          return;
        }
        const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/u, '');
        assert.ok(relative && !relative.includes('..'));
        const file = join(root, relative);
        assert.ok(file.startsWith(root));
        const body = await readFile(file);
        response.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/plain' }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    instance.listen(0, '127.0.0.1', () => resolveServer(instance));
  });
}

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {I18nProvider} from './renderer/src/i18n'; import {HistoryTranscript} from './renderer/src/components/HistoryTranscript'; import {marked} from 'marked'; import DOMPurify from 'dompurify'; const markdown=${JSON.stringify(table)}; const item={id:'public-history-table',role:'assistant',turnId:'public-turn',createdAt:'2026-10-11T00:00:00.000Z',parts:[{type:'text',text:markdown}]}; createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,{locale:'en'},React.createElement(HistoryTranscript,{items:[item]}))); const html=DOMPurify.sanitize(marked.parse(markdown,{gfm:true,breaks:true}),{FORBID_TAGS:['script','iframe','object','embed','form','input','button','link','meta','base','svg','math','audio','video','source','track'],FORBID_ATTR:['style','srcset','background','poster','data-threadterm-file-reference'],SANITIZE_NAMED_PROPS:true}); document.getElementById('chat-table').innerHTML=html;`;
  await build({ stdin:{contents:entry,resolveDir:root,loader:'tsx'}, bundle:true, outfile:join(out,'fixture.js'), jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'} });
  server = await serve();
  const port = server.address().port;
  const appDir = join(out, 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'markdown-table-qa', version: '0.1.0', main: 'main.cjs' }));
  await writeFile(join(appDir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => { const win = new BrowserWindow({ width: 1280, height: 800, show: true }); win.loadURL(process.env.TT_QA_URL); });\n`);
  const blocked = /^(path|home|userprofile|codex_home|data|profile|pipe|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
  Object.assign(env, { Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), TT_QA_URL: `http://127.0.0.1:${port}/fixture.html`, THREADTERM_V3_DATA: join(out, 'data'), THREADTERM_V3_USER_DATA: join(out, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-markdown-table-${process.pid}` });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'PATH isolation keeps exactly one spelling');
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: appDir, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  await page.locator('[data-surface="history"] table').waitFor();
  assert.equal(await page.locator('.codex-markdown script').count(), 0, 'production transcript sanitizer strips script elements');
  assert.equal(await page.locator('.codex-markdown [onerror]').count(), 0, 'production transcript sanitizer strips event attributes');
  assert.equal(await page.evaluate(() => Boolean(window.__unsafeScriptRan || window.__unsafeAttributeRan)), false, 'unsafe transcript markup never executed');
  const measure = () => page.locator('[data-surface]').evaluateAll(nodes => nodes.map(node => {
    const table = node.querySelector('table');
    const cell = node.querySelector('td');
    const tableStyle = getComputedStyle(table);
    const cellStyle = getComputedStyle(cell);
    return {
      surface: node.dataset.surface,
      display: tableStyle.display,
      overflow: tableStyle.overflowX,
      padding: cellStyle.padding,
      border: `${cellStyle.borderTopWidth} ${cellStyle.borderTopStyle} ${cellStyle.borderTopColor}`,
      scrolls: table.scrollWidth > table.clientWidth + 8,
    };
  }));
  for (const [theme, width, label] of [['light', 1280, 'wide'], ['dark', 420, 'narrow']]) {
    await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
    await page.setViewportSize({ width, height: 800 });
    const rows = await measure();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.display, 'block', `${label} ${row.surface} table is not a scroll box`);
      assert.equal(row.overflow, 'auto', `${label} ${row.surface} table does not scroll`);
      assert.equal(row.padding, '5px 8px');
      assert.match(row.border, /^(\d+(?:\.\d+)?)px solid /, `${label} ${row.surface} cell border: ${row.border}`);
      assert.ok(Number.parseFloat(row.border) > 0, `${label} ${row.surface} cell border: ${row.border}`);
      assert.equal(row.scrolls, true, `${label} ${row.surface} wide table does not overflow`);
    }
    assert.equal(rows[0].padding, rows[1].padding);
    assert.equal(rows[0].border, rows[1].border, 'history and Chat cell borders differ');
    await page.screenshot({ path: join(out, `tables-${theme}-${label}.png`) });
    report.screenshots.push(join(out, `tables-${theme}-${label}.png`));
  }
  report.checks.push('production HistoryTranscript/FileLinkedMarkdown renders GFM tables; unsafe script/event markup is stripped; history and Chat share bordered, padded, horizontally scrolling tables in light/dark and wide/narrow');
  report.passed = true;
  process.stdout.write('PASS history and Chat share Markdown table styling\n');
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => undefined);
  await new Promise(done => server?.close(() => done()));
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  process.stdout.write(`${report.passed ? 'MARKDOWN TABLE QA PASSED' : 'MARKDOWN TABLE QA FAILED'} ${join(out, 'report.json')}\n`);
}
