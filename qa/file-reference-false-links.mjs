// Desktop-1 check that prose becomes a link only after its source session resolves it.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'qa/results/file-reference-false-links');
const scratch = await mkdtemp(join(tmpdir(), 'tt-file-ref-'));
const text = 'Run /usage and /status in /src/ before opening src/Foo.Ts:12:3, Dockerfile, or complaintList.srvFullName.';
const source = `
 import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
 import { FileLinkedMarkdown, FileLinkedText, FileReferenceScopeProvider } from './renderer/src/components/FileReferenceText';
 import './renderer/src/styles.css'; import './renderer/src/components/chat-network-notice.css';
 const text = ${JSON.stringify(text)};
 const markdown = '<table><tr><td><code>src/Foo.Ts:12:3</code></td><td><code>Dockerfile</code></td><td><code>complaintList.srvFullName</code></td><td>/usage</td></tr></table>';
 const listeners = new Set(); let complaintAvailable = false, transportGeneration = 0, clockAdvance = 0;
 const realNow = Date.now; Date.now = () => realNow() + clockAdvance;
 window.__makeComplaintAvailable = () => { complaintAvailable = true; };
 window.__advanceReferenceClock = milliseconds => { clockAdvance += milliseconds; };
 window.__reconnect = () => { transportGeneration++; listeners.forEach(listener => listener({event:'runtime.transport',data:{state:'reconnected'}})); };
 window.threadterm = { onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, request: (method, params) => new Promise((resolveRequest, reject) => {
   if (method !== 'filesystem.resolve') return reject(new Error('unexpected ' + method));
   const requestTransport = transportGeneration;
   const delay = params.sessionId === 'session-a' && requestTransport === 0 ? 120 : 0;
   setTimeout(() => {
     if (params.sessionId === 'session-a' && (params.path === 'src/Foo.Ts' || (params.path === 'Dockerfile' && requestTransport !== 1) || (params.path === 'complaintList.srvFullName' && complaintAvailable))) return resolveRequest({ projectId:'project', worktreePath:'C:/fixture-a', path:params.path, kind:'text', line:params.line, column:params.column });
     reject(new Error('file_reference_not_found'));
   }, delay);
  }) };
 function Probe() { const [sessionId, setSessionId] = useState('session-a'); const scope={sourceSessionId:sessionId,canonicalRoot:sessionId === 'session-a' ? 'C:/fixture-a' : 'C:/fixture-b'}; window.__setSourceSession = setSessionId; return <main className="probe"><FileReferenceScopeProvider {...scope}><section data-surface="plain"><FileLinkedText text={text} openFile={()=>{}}/></section><section data-surface="markdown"><FileLinkedMarkdown sanitizedHtml={markdown} references={[{path:'src/provider-only.ts',line:4}]} openFile={()=>{}}/></section></FileReferenceScopeProvider><section data-surface="override"><FileLinkedText text="src/Foo.Ts:12:3" sourceSessionId="session-b" canonicalRoot="C:/fixture-b" openFile={()=>{}}/></section><section data-surface="unscoped"><FileLinkedText text="src/Foo.Ts:12:3" openFile={()=>{}}/></section></main>; }
 createRoot(document.getElementById('root')).render(<Probe/>);
`;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
await mkdir(out, { recursive: true });
await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'probe.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>html,body,#root{margin:0;height:100%;background:var(--bg,#f6f3ee);color:var(--text,#222)}.probe{box-sizing:border-box;width:640px;margin:24px;padding:16px;border:1px solid var(--border,#888);background:var(--surface,#fff);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}</style><div id="root"></div><script src="probe.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({width:760,height:240,show:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(15_000);
  await page.locator('.probe').waitFor();
  await page.waitForTimeout(20);
  await page.evaluate(() => window.__setSourceSession('session-b'));
  await page.waitForTimeout(180);
  assert.deepEqual(await page.locator('[data-surface="plain"] .file-reference-link, [data-surface="markdown"] .codex-markdown .file-reference-link').allTextContents(), [], 'a stale source-session resolution linked the replacement session');
  await page.evaluate(() => window.__setSourceSession('session-a'));
  await page.waitForTimeout(20);
  await page.evaluate(() => window.__reconnect());
  await page.waitForFunction(() => document.querySelectorAll('[data-surface="plain"] .file-reference-link').length === 1 && document.querySelectorAll('[data-surface="markdown"] .codex-markdown .file-reference-link').length === 1);
  await page.waitForTimeout(180);
  assert.deepEqual(await page.locator('[data-surface="plain"] .file-reference-link, [data-surface="markdown"] .codex-markdown .file-reference-link').allTextContents(), ['src/Foo.Ts:12:3', 'src/Foo.Ts:12:3'], 'a pending pre-reconnect transport result was accepted by the new generation');
  assert.equal(await page.locator('[data-surface="override"] .file-reference-link').count(), 0, 'an explicit component session did not override the surrounding scope');
  assert.equal(await page.locator('[data-surface="unscoped"] .file-reference-link').count(), 0, 'unscoped auto prose must remain inert');
  assert.deepEqual(await page.locator('[data-surface="markdown"] .file-reference-chips .file-reference-link').allTextContents(), ['src/provider-only.ts:4']);
  await page.evaluate(() => { window.__makeComplaintAvailable(); window.__advanceReferenceClock(30_001); window.__setSourceSession('session-b'); });
  await page.waitForTimeout(20);
  await page.evaluate(() => window.__setSourceSession('session-a'));
  await page.waitForFunction(() => document.querySelectorAll('[data-surface="plain"] .file-reference-link').length === 2 && document.querySelectorAll('[data-surface="markdown"] .codex-markdown .file-reference-link').length === 2);
  await page.evaluate(() => window.__reconnect());
  await page.waitForFunction(() => document.querySelectorAll('[data-surface="plain"] .file-reference-link').length === 3 && document.querySelectorAll('[data-surface="markdown"] .codex-markdown .file-reference-link').length === 3);
  assert.equal(await page.locator('[data-surface="override"] .file-reference-link').count(), 0, 'an explicit component session did not override the surrounding scope after revalidation');
  assert.equal(await page.locator('[data-surface="unscoped"] .file-reference-link').count(), 0, 'unscoped auto prose became interactive after revalidation');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
    await page.waitForTimeout(50);
    const rendered = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      buttons: [...document.querySelectorAll('[data-surface="plain"] .file-reference-link')].map(node => node.textContent),
      markdownButtons: [...document.querySelectorAll('[data-surface="markdown"] .codex-markdown .file-reference-link')].map(node => node.textContent),
      text: document.querySelector('.probe').innerText,
      color: getComputedStyle(document.querySelector('.probe')).color,
    }));
    assert.equal(rendered.theme, theme);
    assert.equal(rendered.color, theme === 'dark' ? 'rgb(236, 235, 229)' : 'rgb(35, 34, 31)', rendered.color);
    const resolved = await page.locator('[data-surface="plain"] .file-reference-link, [data-surface="markdown"] .codex-markdown .file-reference-link').allTextContents();
    assert.deepEqual(rendered.buttons, ['src/Foo.Ts:12:3', 'Dockerfile', 'complaintList.srvFullName']);
    assert.deepEqual(rendered.markdownButtons, ['src/Foo.Ts:12:3', 'Dockerfile', 'complaintList.srvFullName']);
    assert.deepEqual(resolved, ['src/Foo.Ts:12:3', 'Dockerfile', 'complaintList.srvFullName', 'src/Foo.Ts:12:3', 'Dockerfile', 'complaintList.srvFullName']);
    for (const plain of ['/usage', '/status', '/src/', 'complaintList.srvFullName']) assert.ok(rendered.text.includes(plain), plain);
    const shot = join(out, `links-${theme}.png`);
    await page.screenshot({ path: shot });
    report.screenshots.push(shot);
  }
  report.checks.push('provider-scoped plain and Markdown table prose link only after resolution; explicit scope override and unscoped prose remain inert; provider chips persist; commands, stale source-session and pre-reconnect transport results, negative-cache expiry on a later scope render, and reconnect cache invalidation are covered');
  report.passed = true;
  process.stdout.write('PASS file reference false links\n');
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!report.passed && app) await app.firstWindow().then(page => page.screenshot({ path: join(out, 'failure.png') })).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  if (app) await Promise.race([app.close().catch(() => undefined), new Promise(resolveClose => setTimeout(resolveClose, 5000))]);
  process.stdout.write(`${report.passed ? 'FILE REFERENCE QA PASSED' : 'FILE REFERENCE QA FAILED'} ${join(out, 'report.json')}\n`);
  process.exit(report.passed ? 0 : 1);
}
