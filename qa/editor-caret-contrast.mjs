// Real Electron coverage for CodeMirror's native, drawn and drop cursor colors.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-editor-caret-'));
const appDir = join(scratch, 'app');
const out = join(root, 'qa/results/editor-caret-contrast');
let app, release;
const ratio = (a, b) => {
  const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => { channel /= 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
  const light = values => values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  const [one, two] = [light(rgb(a)), light(rgb(b))].sort((x, y) => y - x);
  return (one + .05) / (two + .05);
};
const fixture = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{EditorView}from'@codemirror/view';import{CodeEditor}from'./renderer/src/components/CodeEditor';import{MergeEditor}from'./renderer/src/components/MergeEditor';
const snapshots=new Map();const viewFor=selector=>{const editor=document.querySelector(selector),view=editor&&EditorView.findFromDOM(editor);if(!view)throw Error('missing editor view '+selector);return view};window.qa={capture(key,selector,selection){const view=viewFor(selector);view.dispatch({selection});const main=view.state.selection.main;if(main.empty)throw Error('expected noncollapsed selection '+key);snapshots.set(key,{view,dom:view.dom,anchor:main.anchor,head:main.head,text:view.state.doc.toString()})},state(key,selector){const snapshot=snapshots.get(key),view=viewFor(selector),main=view.state.selection.main;return{sameView:view===snapshot?.view,sameDom:view.dom===snapshot?.dom,anchor:main.anchor,head:main.head,text:view.state.doc.toString()}}};
function App(){const[value,setValue]=useState('const visible = true;\\n');return <main><section className="tt-editor-shell"><CodeEditor path="sample.ts" value={value} readOnly={false} onChange={setValue} onSave={()=>{}}/></section><section className="merge-editor"><MergeEditor path="sample.ts" oldText={'const oldValue = false;\\n'} newText={'const newValue = true;\\n'} readOnly={false} onChange={()=>{}} onSave={()=>{}}/></section></main>}createRoot(document.getElementById('root')).render(<App/>);`;
try {
  release = await acquireElectronQaLock();
  await mkdir(appDir, { recursive: true });
  await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: join(root, 'qa/fixtures/editor-caret.tsx'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outdir: appDir, entryNames: 'fixture', loader: { '.css': 'css' }, logLevel: 'error' });
  await writeFile(join(appDir, 'index.html'), '<!doctype html><style>:root{--editor:#fefdfb;--bg:var(--editor);--text:#23221f;--border:#ddd}html,body,#root,main{margin:0;height:100%;display:flex;gap:8px}section{flex:1;min-width:0;height:300px;border:1px solid var(--border);background:var(--editor)}</style><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  await writeFile(join(appDir, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:500,webPreferences:{contextIsolation:true}}).loadFile(${JSON.stringify(join(appDir, 'index.html'))}));`);
  await writeFile(join(appDir, 'package.json'), '{"name":"editor-caret-qa","main":"main.cjs"}');
  app = await electron.launch({ args: [appDir], cwd: root, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.locator('.cm-content').first().waitFor();
  const verify = async (name, editor) => {
    await page.evaluate(({ editor, name }) => { const root = document.documentElement; const themes = { light:['#fefdfb','#23221f'], dark:['#2c2c2a','#ecebe5'], adverse:['#777777','#777777'] }; const [surface,text]=themes[name]; root.dataset.theme=name; root.style.setProperty('--editor',surface); root.style.setProperty('--text',text); document.querySelectorAll(editor).forEach(host=>{const view=host.querySelector('.cm-editor');for(const className of ['cm-cursor','cm-dropCursor'])view.append(Object.assign(document.createElement('div'),{className}));}); }, { editor, name });
    await page.locator(`${editor} .cm-content`).first().click(); await page.waitForTimeout(30);
    const colors = await page.locator(editor).evaluate(host => { let surface=host; while (surface.parentElement && getComputedStyle(surface).backgroundColor.endsWith(', 0)')) surface=surface.parentElement; const cursor=host.querySelector('.cm-cursor'); return { background:getComputedStyle(surface).backgroundColor, native:getComputedStyle(host.querySelector('.cm-content')).caretColor, drawn:getComputedStyle(cursor).borderLeftColor, drop:getComputedStyle(host.querySelector('.cm-dropCursor')).borderLeftColor, cursor:cursor.outerHTML, variable:getComputedStyle(cursor).getPropertyValue('--tt-editor-caret') }; });
    for (const [kind, color] of Object.entries({ native:colors.native, drawn:colors.drawn, drop:colors.drop })) { const value=ratio(colors.background, color); console.log(`${editor} ${name} ${kind}: ${colors.background} / ${color} = ${value}; variable=${colors.variable}`); if(value<3)console.log(colors.cursor); assert.ok(value >= 3, `${editor} ${name} ${kind} has >=3:1 contrast`); }
  };
  const sourceHost = '.tt-editor-shell', sourceEditor = `${sourceHost} .cm-editor`, editableDiffHost = '.merge-editor.tt-diff-host .cm-mergeViewEditor:has(.cm-content[contenteditable="true"])', editableDiffEditor = `${editableDiffHost} .cm-editor`;
  await mkdir(out, { recursive: true });
  for (const name of ['light','dark','adverse']) { await verify(name, sourceHost); await verify(name, editableDiffHost); await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); }
  await page.evaluate(({ sourceEditor, editableDiffEditor })=>{window.qa.capture('source',sourceEditor,{anchor:6,head:13});window.qa.capture('diff',editableDiffEditor,{anchor:6,head:14});},{sourceEditor,editableDiffEditor});
  await page.evaluate(()=>{document.documentElement.dataset.theme='retained';document.documentElement.style.setProperty('--editor','#2c2c2a');document.documentElement.style.setProperty('--text','#ecebe5');}); await page.waitForTimeout(30);
  for (const [key,selector,expected] of [['source',sourceEditor,{anchor:6,head:13,text:'const visible = true;\n'}],['diff',editableDiffEditor,{anchor:6,head:14,text:'const newValue = true;\n'}]]) { const state=await page.evaluate(({key,selector})=>window.qa.state(key,selector),{key,selector});assert.equal(state.sameView,true,`${key} keeps its EditorView`);assert.equal(state.sameDom,true,`${key} keeps its editor DOM`);assert.equal(state.anchor,expected.anchor,`${key} keeps selection anchor`);assert.equal(state.head,expected.head,`${key} keeps selection head`);assert.notEqual(state.anchor,state.head,`${key} selection remains noncollapsed`);assert.equal(state.text,expected.text,`${key} keeps its document`); }
  for (const [key,selector,editor,expected] of [['source',sourceHost,sourceEditor,'const visible = true;\n'],['diff',editableDiffHost,editableDiffEditor,'const newValue = true;\n']]) { const content=page.locator(`${selector} .cm-content`);await content.click();await page.keyboard.press('Control+Home');await page.keyboard.press('End');await page.keyboard.type('x');const typed=await page.evaluate(({key,selector})=>window.qa.state(key,selector),{key,selector:editor});assert.equal(typed.sameView,true,`${key} keeps its EditorView while typing`);assert.equal(typed.text,`${expected.slice(0,-1)}x\n`,`${key} accepts typing before theme update`);await page.evaluate(()=>{document.documentElement.dataset.theme='undo';document.documentElement.style.setProperty('--editor','#777777');document.documentElement.style.setProperty('--text','#777777');});await page.waitForTimeout(30);await page.keyboard.press('Control+z');assert.equal(await page.evaluate(({key,selector})=>window.qa.state(key,selector).text,{key,selector:editor}),expected,`${key} theme update preserves typing and undo history`); }
  console.log('editor caret contrast: PASS (source + editable diff, light/dark/adverse; exact selection, view identity, typing and undo preserved)');
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await release?.();
  await rm(scratch, { recursive: true, force: true });
}
