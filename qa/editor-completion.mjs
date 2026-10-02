// Isolated production CodeEditor completion check: real keystrokes in Electron, light and
// dark palettes. No runtime, provider process or project filesystem is involved.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-editor-completion-'));
const out = resolve('qa/results/editor-completion');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {language} from '@codemirror/language';
import {CodeEditor} from './renderer/src/components/CodeEditor';
import './renderer/src/styles.css';
import './renderer/src/components/file-workspace.css';
let root;
window.mount=(path,value,readOnly=false)=>{
 root?.unmount();
 root=createRoot(document.getElementById('root'));
 window.doc=value;
 root.render(<div className="tt-editor-shell" style={{height:'100%'}}><CodeEditor path={path} value={value} readOnly={readOnly} onChange={next=>{window.doc=next;}} onSave={()=>{}}/></div>);
};
window.editor=()=>{const dom=document.querySelector('.cm-editor');return dom&&EditorView.findFromDOM(dom);};
window.languageReady=()=>Boolean(window.editor()?.state.facet(language));
window.cursorAt=offset=>{const view=window.editor();view.dispatch({selection:{anchor:offset}});view.focus();};
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{height:340px;width:720px}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:760,height:400,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
  const open = async (path, value, { readOnly = false, grammar = true } = {}) => {
    await page.evaluate(([file, text, locked]) => window.mount(file, text, locked), [path, value, readOnly]);
    await page.waitForFunction(() => window.editor());
    if (grammar) await page.waitForFunction(() => window.languageReady());
  };
  const placeAt = marker => page.evaluate(text => window.cursorAt(window.doc.indexOf(text)), marker);
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel')].map(item => item.textContent));
  const popup = page.locator('.cm-tooltip-autocomplete');
  const noPopupAfterTyping = async (text, reason) => {
    await page.keyboard.type(text, { delay: 25 });
    await page.waitForTimeout(400);
    assert.equal(await popup.count(), 0, reason);
  };
  const checks = [];

  // TypeScript: names in scope and keywords come from the language package.
  await open('src/app.ts', 'function run() {\n  const handleSubmit = 1;\n  @\n}\n');
  await placeAt('@'); await page.keyboard.press('Delete');
  await page.keyboard.type('hand', { delay: 25 });
  await popup.waitFor();
  assert.ok((await labels()).includes('handleSubmit'), 'TS suggests a local name');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const colors = await page.evaluate(() => {
      const probe = document.createElement('div'); probe.style.background = 'var(--raised)'; probe.style.color = 'var(--text)'; document.body.append(probe);
      const palette = getComputedStyle(probe); const tooltip = getComputedStyle(document.querySelector('.cm-tooltip-autocomplete'));
      const result = { expected: [palette.backgroundColor, palette.color], actual: [tooltip.backgroundColor, tooltip.color] }; probe.remove(); return result;
    });
    assert.deepEqual(colors.actual, colors.expected, `${theme}: popup uses the app palette`);
    await page.screenshot({ path: join(out, `ts-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.keyboard.press('Enter');
  assert.match(await page.evaluate(() => window.doc), /\n {2}handleSubmit\n/, 'Enter accepts the suggestion instead of inserting a newline');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ret', { delay: 25 });
  await popup.waitFor();
  assert.ok((await labels()).includes('return'), 'TS suggests keywords');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await popup.count(), 0, 'Escape closes the list');
  checks.push('ts');

  // Rust has no completion source of its own: words already in the file are offered,
  // but not inside comments.
  await open('src/lib.rs', 'fn compute_total() -> u32 { 0 }\n\n@\n');
  await placeAt('@'); await page.keyboard.press('Delete');
  await page.keyboard.type('comp', { delay: 25 });
  await popup.waitFor();
  assert.ok((await labels()).includes('compute_total'), 'Rust offers words from the file');
  // CodeMirror ignores Enter for 75 ms after the list opens, so a fast Enter stays a newline.
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  assert.match(await page.evaluate(() => window.doc), /\ncompute_total\n$/, 'accepting inserts the word');
  await page.keyboard.press('Enter');
  await noPopupAfterTyping('// comp', 'no word list inside a comment');
  checks.push('rust');

  // Plain text and read-only views never pop a list.
  await open('notes.txt', 'compute_total\n', { grammar: false });
  await page.evaluate(() => window.cursorAt(window.doc.length));
  await noPopupAfterTyping('comp', 'plain text stays quiet');
  await open('src/app.ts', 'const handleSubmit = 1;\n', { readOnly: true });
  await page.evaluate(() => window.cursorAt(window.doc.length));
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(300);
  assert.equal(await popup.count(), 0, 'read-only view has no completion');
  checks.push('quiet');

  assert.deepEqual(errors, [], 'no renderer exceptions');
  console.log(JSON.stringify({ passed: true, out, checks }));
} finally { await app?.close(); }
