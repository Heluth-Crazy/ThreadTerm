import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-conflict-resolver-'));
const one = 'before\n<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\nafter\n';
const two = '<<<<<<< ours\nfirst current\n=======\nfirst incoming\n>>>>>>> theirs\nmid\n<<<<<<< ours\nsecond current\n=======\nsecond incoming\n>>>>>>> theirs\n';
const malformed = '<<<<<<< ours\ncurrent\n=======\nincoming\n';
const source = String.raw`import React,{useState}from 'react';
import {createRoot}from 'react-dom/client';
import {FileWorkspace}from './renderer/src/components/FileWorkspace';
import {SourceControlView}from './renderer/src/components/SourceControlView';
import {I18nProvider}from './renderer/src/i18n';
import {EditorView}from '@codemirror/view';
import {SearchQuery,findNext,openSearchPanel,replaceNext,setSearchQuery}from '@codemirror/search';
import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
const original=${JSON.stringify(one)},status={branch:'main',upstream:null,ahead:0,behind:0,changes:[{path:'conflicted.ts',indexStatus:'U',worktreeStatus:'U',untracked:false}]};
let saved={content:original,fingerprint:'one'};let serial=1;window.__requests=[];
window.__editorText=()=>{const content=document.querySelector('.cm-content');return content?EditorView.findFromDOM(content)?.state.doc.toString():'';};
window.__editorLines=()=>{const content=document.querySelector('.cm-content'),view=content&&EditorView.findFromDOM(content);return view?.state.doc.lines??0;};
window.__editCurrent=()=>{const view=EditorView.findFromDOM(document.querySelector('.cm-content'));const from=view.state.doc.toString().indexOf('current');view.dispatch({changes:{from,to:from+7,insert:'changed'}});};
window.__pasteLf=(text)=>{const view=EditorView.findFromDOM(document.querySelector('.cm-content'));view.focus();const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);view.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));};
window.__searchReplaceLf=()=>{const view=EditorView.findFromDOM(document.querySelector('.cm-content'));openSearchPanel(view);view.dispatch({effects:setSearchQuery.of(new SearchQuery({search:'replace_me',replace:'replacement one\nreplacement two'}))});findNext(view);replaceNext(view);};
window.threadterm={request:async(method,params)=>{window.__requests.push([method,params]);switch(method){
case 'filesystem.read':if(window.__readFailure)throw Error(window.__readFailure);return {path:'conflicted.ts',content:saved.content,fingerprint:saved.fingerprint,readonly:false,size:saved.content.length,modifiedAt:''};
case 'filesystem.write':saved={content:params.content,fingerprint:'saved-'+(++serial)};return {path:'conflicted.ts',content:saved.content,fingerprint:saved.fingerprint,readonly:false,size:saved.content.length,modifiedAt:''};
case 'draft.list':return [];case 'draft.put':return {id:'draft',path:params.path,content:params.content,baseFingerprint:params.baseFingerprint,revision:1};case 'draft.delete':return {};case 'git.status':return status;case 'git.branches':return {branches:[]};case 'git.diff':return {path:'conflicted.ts',oldText:'before\n',newText:saved.content,fingerprint:saved.fingerprint,indexFingerprint:'index',binary:false};case 'git.index.write':return {};case 'git.stage':return {};default:return {};}},onEvent:()=>()=>{}};
function Probe(){const [version,setVersion]=useState(0);const [revision,setRevision]=useState(0);const [view,setView]=useState('file');const [staleScm,setStaleScm]=useState(false);window.__staleScm=()=>setStaleScm(true);window.__resetConflict=(content=original)=>{window.__readFailure=undefined;window.__requests=[];saved={content,fingerprint:'reset-'+(++serial)};setStaleScm(false);setView('file');setVersion(value=>value+1);setRevision(value=>value+1);setTimeout(()=>dispatchEvent(new CustomEvent('threadterm:workbench-files-changed',{detail:{path:'conflicted.ts'}})),0);};window.__showDiff=()=>{setView('diff');setVersion(value=>value+1)};window.__readFailure=undefined;return <I18nProvider locale="en"><main><section id="workspace"><FileWorkspace key={version} projectId="p" worktreePath="C:/repo" rootPath="C:/repo" initialPath="conflicted.ts" initialView={view} embedded/></section><section id="scm"><SourceControlView scope={{projectId:'p',worktreePath:'C:/repo',rootPath:'C:/repo'}} actions={{openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}}} git={{status:{...status,changes:staleScm?[{path:'conflicted.ts',indexStatus:' ',worktreeStatus:'M',untracked:false}]:status.changes,revision},loading:false,refresh:async()=>{}}} zh={false}/></section></main></I18nProvider>};createRoot(document.getElementById('root')).render(<Probe/>);`;

let app;
try {
  await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'git-conflict-resolver-probe.tsx', loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: join(scratch, 'probe.js'), logLevel: 'error' });
  await writeFile(join(scratch, 'index.html'), '<!doctype html><div id="root"></div><script src="probe.js"></script>');
  await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch, 'index.html'))})})`);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], cwd: root, timeout: 30000 });
  const page = await app.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(5000);
  const pageErrors=[];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const editorText = () => page.evaluate(() => window.__editorText());
  const normalized = text => text.replace(/\r\n?/g, '\n');
  const savedWrite = () => page.evaluate(() => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content);
  const assertOnlyCrlf = (text, message) => assert.equal(/(^|[^\r])\n/.test(text), false, message);
  const reset = async text => { const previous=await page.locator('#workspace .cm-editor').elementHandles(); try { await page.evaluate(text => window.__resetConflict(text), text); await Promise.all(previous.map(editor=>page.waitForFunction(node=>!node.isConnected,editor))); await page.locator('#workspace .cm-content').waitFor(); await page.waitForFunction(text => window.__editorText() === text, normalized(text)); } finally { await Promise.all(previous.map(editor=>editor.dispose())); } };
  const accept = async (label, expected) => { await reset(one); await page.getByRole('button', { name: label, exact: true }).click(); await page.waitForFunction(expected => window.__editorText() === expected, expected); assert.equal(await editorText(), expected); await page.locator('.cm-content').press('Control+z'); await page.waitForFunction(text => window.__editorText() === text, one); };

  await page.locator('.cm-conflict-actions').waitFor();
  for (const [label, expected] of [
    ['Accept current', 'before\ncurrent\nafter\n'],
    ['Accept incoming', 'before\nincoming\nafter\n'],
    ['Accept both (current first)', 'before\ncurrent\nincoming\nafter\n'],
    ['Accept both (incoming first)', 'before\nincoming\ncurrent\nafter\n'],
  ]) await accept(label, expected);

  const crlf = one.replace(/\n/g, '\r\n');
  await reset(crlf);
  assert.equal(await page.getByRole('button', { name: 'Save file', exact: true }).isDisabled(), true, 'a freshly opened CRLF file is not dirty');
  await page.getByRole('button', { name: 'Accept current', exact: true }).click();
  const resolvedCrlf = 'before\r\ncurrent\r\nafter\r\n';
  await page.waitForFunction(expected => window.__editorText() === expected, normalized(resolvedCrlf));
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, resolvedCrlf);
  assertOnlyCrlf(await savedWrite(), 'accepting a CRLF conflict preserves CRLF in the saved payload');

  await reset('before\r\nafter\r\n');
  const crlfContent = page.locator('.cm-content');
  await crlfContent.focus();
  await crlfContent.press('Control+End');
  await crlfContent.pressSequentially('typed');
  const typedCrlf = 'before\r\nafter\r\ntyped';
  await page.waitForFunction(expected => window.__editorText() === expected, normalized(typedCrlf));
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, typedCrlf);
  assertOnlyCrlf(await savedWrite(), 'ordinary typing preserves CRLF in the saved payload');

  await reset('before\r\nafter\r\n');
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').press('Control+End');
  await page.evaluate(() => window.__pasteLf('pasted one\npasted two'));
  const pastedLf = 'before\nafter\npasted one\npasted two';
  await page.waitForFunction(expected => window.__editorText() === expected, pastedLf);
  assert.equal(await page.evaluate(() => window.__editorLines()), 4, 'LF clipboard text is split into CodeMirror lines in a CRLF file');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, pastedLf.replace(/\n/g, '\r\n'));
  assertOnlyCrlf(await savedWrite(), 'LF clipboard text serializes as CRLF on save');

  await reset('before\r\nafter\r\n');
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').press('Control+End');
  await page.evaluate(() => window.__pasteLf('<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n'));
  await page.locator('.cm-conflict-actions').waitFor();
  assert.equal(await page.evaluate(() => window.__editorLines()), 8, 'an LF conflict block pasted into a CRLF file creates separate editor lines');
  await page.getByRole('button', { name: 'Accept current', exact: true }).click();
  const pastedConflictResolved = 'before\nafter\ncurrent\n';
  await page.waitForFunction(expected => window.__editorText() === expected, pastedConflictResolved);
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, pastedConflictResolved.replace(/\n/g, '\r\n'));
  assertOnlyCrlf(await savedWrite(), 'accepting an LF-pasted conflict block serializes as CRLF on save');

  await reset('before\r\nreplace_me\r\nafter\r\n');
  await page.evaluate(() => window.__searchReplaceLf());
  const replacedLf = 'before\nreplacement one\nreplacement two\nafter\n';
  await page.waitForFunction(expected => window.__editorText() === expected, replacedLf);
  assert.equal(await page.evaluate(() => window.__editorLines()), 5, 'search replacement with LF creates separate editor lines');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, replacedLf.replace(/\n/g, '\r\n'));
  assertOnlyCrlf(await savedWrite(), 'search replacement serializes as CRLF on save');

  const mixed = 'one\r\ntwo\r\nthree\nfour\r\n';
  await reset(mixed);
  assert.equal(await page.getByRole('button', { name: 'Save file', exact: true }).isDisabled(), true, 'a freshly opened mixed-EOL file is not dirty');
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').press('Control+End');
  await page.locator('.cm-content').pressSequentially('edited');
  const mixedSaved = 'one\r\ntwo\r\nthree\r\nfour\r\nedited';
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.waitForFunction(expected => window.__requests.filter(([method]) => method === 'filesystem.write').at(-1)?.[1].content === expected, mixedSaved);
  assertOnlyCrlf(await savedWrite(), 'mixed-EOL input uses its dominant CRLF separator on save');

  await reset(one);
  await page.evaluate(() => window.__editCurrent());
  await page.getByRole('button', { name: 'Accept current', exact: true }).click();
  assert.equal(await editorText(), 'before\nchanged\nafter\n', 'equal-length edits refresh action payloads');
  await page.locator('.cm-content').press('Control+z');
  assert.equal(await editorText(), one.replace('current', 'changed'), 'accept undo remains separate from prior typing');

  await reset(two);
  const content = page.locator('.cm-content');
  await content.focus();
  await page.locator('.cm-conflict-count').waitFor({ state: 'visible' });
  assert.match(await page.locator('.cm-conflict-count').textContent(), /1 of 2/);
  await content.press('F7');
  await page.waitForFunction(() => document.querySelector('.cm-conflict-count')?.textContent === '2 of 2');
  await content.press('Shift+F7');
  await page.waitForFunction(() => document.querySelector('.cm-conflict-count')?.textContent === '1 of 2');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.cm-conflict-count')?.textContent === '2 of 2');
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.cm-conflict-count')?.textContent === '1 of 2');

  await reset(one);
  const stageButtons = page.locator('#workspace').getByRole('button', { name: 'Mark resolved (stage)', exact: true });
  await stageButtons.waitFor();
  assert.equal(await stageButtons.isDisabled(), true, 'saved markers block editor staging even after the buffer becomes clean');
  await page.getByRole('button', { name: 'Accept current', exact: true }).click();
  assert.equal(await stageButtons.isDisabled(), true, 'unsaved resolved buffer does not clear the saved-marker guard');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'All conflicts resolved in this file. Stage it to mark it resolved.' }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('#workspace button')].some(button => button.textContent === 'Mark resolved (stage)' && button.disabled));

  await reset(one);
  await page.evaluate(() => window.__showDiff());
  const diffStage = page.locator('#workspace').getByRole('button', { name: 'Stage file', exact: true });
  const hunkStage = page.locator('#workspace').getByRole('button', { name: 'Stage hunk', exact: true });
  await diffStage.waitFor();
  await hunkStage.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#workspace button')].some(button => button.textContent === 'Stage file' && button.disabled));
  await page.waitForFunction(() => [...document.querySelectorAll('#workspace button')].some(button => button.textContent === 'Stage hunk' && button.disabled));
  assert.equal(await diffStage.isDisabled(), true, 'diff whole-file staging is guarded by saved markers');
  assert.equal(await hunkStage.isDisabled(), true, 'diff hunk staging is guarded by saved markers');

  await reset(one);
  const row = page.locator('#scm [data-change-group="conflicts"]');
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector('#scm button[aria-label="Mark resolved (stage)"]')?.disabled === true);
  await row.locator('button').first().focus();
  await row.locator('button').first().press('Shift+F10');
  const menuStage = page.locator('[data-testid="source-control-stage"]');
  await menuStage.waitFor();
  await page.waitForFunction(() => { const item=document.querySelector('[data-testid="source-control-stage"]'); return item?.getAttribute('aria-disabled')==='true' || item?.hasAttribute('disabled'); });
  assert.equal(await menuStage.isDisabled(), true, 'source-control context staging is guarded by saved markers');
  await page.keyboard.press('Escape');

  await reset(one);
  await page.evaluate(() => window.__staleScm());
  const stageAll = page.locator('#scm').getByRole('button', {name:'Stage all changes',exact:true});
  await stageAll.focus();
  await stageAll.press('Enter');
  await page.locator('#scm [role="alert"]').filter({hasText:'The saved file still contains conflict markers.'}).waitFor();
  assert.equal(await page.evaluate(() => window.__requests.filter(([method])=>method==='git.stage').length),0,'keyboard stage-all rechecks paths from stale groups');
  await page.locator('#scm').getByRole('checkbox',{name:'Select conflicted.ts in changes',exact:true}).check();
  await page.locator('#scm').getByRole('button',{name:'Stage selected files',exact:true}).press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#scm button[aria-label="Stage selected files"]')?.disabled);
  assert.equal(await page.evaluate(() => window.__requests.filter(([method])=>method==='git.stage').length),0,'selected-file staging also rechecks conflicts');

  await reset('clear\n');
  const clearScmStage = page.locator('#scm').getByRole('button', { name: 'Mark resolved (stage)', exact: true });
  await page.waitForFunction(() => document.querySelector('#scm button[aria-label="Mark resolved (stage)"]')?.disabled === false);
  await page.evaluate(() => { window.__readFailure = 'file_too_large'; });
  await clearScmStage.click();
  await page.getByRole('dialog').getByText('This file could not be checked for conflict markers. Stage anyway?').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { window.__readFailure = 'binary_file'; });
  await clearScmStage.click();
  await page.getByRole('dialog').getByText('This file could not be checked for conflict markers. Stage anyway?').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Stage anyway', exact: true }).click();
  await page.waitForFunction(() => window.__requests.filter(([method]) => method === 'git.stage').length === 1);

  await reset(malformed);
  const malformedEditorStage = page.locator('#workspace').getByRole('button', { name: 'Mark resolved (stage)', exact: true });
  await malformedEditorStage.click();
  await page.getByRole('dialog').getByText('Conflict markers are malformed or nested and cannot be parsed safely. Stage this file anyway?').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__requests.filter(([method]) => method === 'git.stage').length), 0);
  const scmStage = page.locator('#scm').getByRole('button', { name: 'Mark resolved (stage)', exact: true });
  await page.waitForFunction(() => document.querySelector('#scm button[aria-label="Mark resolved (stage)"]')?.disabled === false);
  await scmStage.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await dialog.count(), 0, 'malformed-stage confirmation can be cancelled');
  await scmStage.click();
  await dialog.getByRole('button', { name: 'Stage anyway', exact: true }).click();
  await page.waitForFunction(() => window.__requests.some(([method]) => method === 'git.stage'));
  const staged = await page.evaluate(() => window.__requests.filter(([method]) => method === 'git.stage').at(-1));
  assert.equal(staged[1].expectedFingerprints['conflicted.ts'].startsWith('reset-'), true, 'stage confirmation carries the checked saved fingerprint');
  assert.deepEqual(pageErrors, [], 'LF paste and conflict decorations must not produce page errors');
  console.log('PASS conflict resolver: actions/undo; CRLF accept/typing/paste/search/mixed-EOL saved bytes; navigation; file/diff/hunk/context/group/keyboard guards; unknown/binary/malformed confirmations');
} finally {
  await app?.close().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
