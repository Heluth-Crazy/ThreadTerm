// Isolated renderer integration: actual chat components, context menu and shared bridge; no OS reveal.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electron } from './lib/desktop1.mjs';
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-reference-location-'));
const refs = [{path:'D:\\Outside\\app.ts',line:42,column:3},{path:'\\\\server\\share\\app.ts',line:8},{path:'src/has%20space.ts',line:4}];
const source = `
import React,{useRef} from 'react'; import {createRoot} from 'react-dom/client';
import {FileLinkedMarkdown,FileLinkedText,FileReferenceChips,FileReferenceScopeProvider} from './renderer/src/components/FileReferenceText';
import {useTerminalContextMenu} from './renderer/src/components/TerminalContextMenu';
import './renderer/src/styles.css';
window.__calls=[];window.__opens=[];window.__parentMenus=0;
window.threadterm={onEvent:()=>()=>{},request:async(method,params)=>({projectId:'project',path:params.path,kind:'text'}),revealFileLocation:async target=>{window.__calls.push(target);return {kind:'file'};}};
const open=ref=>window.__opens.push(ref);
window.__selection='src/terminal.ts:23:4';window.__mouse='none';
function TerminalProbe(){const host=useRef(null);const term=useRef({getSelection:()=>window.__selection,options:{},get modes(){return {mouseTrackingMode:window.__mouse}},get textarea(){return document.querySelector('#terminal textarea')}});useTerminalContextMenu(host,term,{id:'terminal-session'},false);return <div id="terminal" ref={host}><textarea aria-label="Terminal input"/></div>}
createRoot(document.getElementById('root')).render(<main onContextMenu={()=>window.__parentMenus++}>
<FileReferenceScopeProvider sourceSessionId="source-worktree-session" canonicalRoot="D:/source-worktree">
<section id="plain"><FileLinkedText text="src/app.ts:12:3" openFile={open}/></section>
<section id="chips"><FileReferenceChips references={${JSON.stringify(refs)}} openFile={open}/></section>
<section id="markdown"><FileLinkedMarkdown sanitizedHtml='<p><a href="src/has%2520space.ts#L4">reference</a></p>' references={[]} openFile={open}/></section>
</FileReferenceScopeProvider>
<section id="unscoped"><FileReferenceChips references={[{path:'src/no-source.ts'}]} openFile={open}/></section>
<TerminalProbe/>
</main>);`;
await build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,outfile:join(scratch,'probe.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'});
await writeFile(join(scratch,'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>main{padding:30px}section{margin:20px}</style><div id="root"></div><script src="probe.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:850,height:650,show:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
let app;
try {
 app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:30000});
 const page=await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror',error=>console.error(error));
 await page.locator('#plain .file-reference-link').waitFor();
 const reveal=async(selector,index=0)=>{await page.locator(selector).nth(index).click({button:'right'});await page.getByTestId('file-reference-reveal').click();};
 await reveal('#plain .file-reference-link');
 for(let index=0;index<3;index++)await reveal('#chips .file-reference-link',index);
 await reveal('#markdown .file-reference-link');
 assert.deepEqual(await page.evaluate(()=>window.__calls),[
  {sessionId:'source-worktree-session',path:'src/app.ts'},
  {sessionId:'source-worktree-session',path:refs[0].path},
  {sessionId:'source-worktree-session',path:refs[1].path},
  {sessionId:'source-worktree-session',path:refs[2].path},
  {sessionId:'source-worktree-session',path:'src/has%20space.ts'},
 ]);
 assert.equal(await page.evaluate(()=>window.__parentMenus),0,'reference menu must not open parent message menu');
 await page.locator('#markdown .file-reference-link').click({button:'right'});
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#markdown .file-reference-link').evaluate(el=>el===document.activeElement),true,'dismiss restores link focus');
 await page.locator('#unscoped .file-reference-link').click({button:'right'});
 assert.equal(await page.getByTestId('file-reference-reveal').count(),0,'no session guessing');
 await page.keyboard.press('Escape');
 await page.locator('#plain .file-reference-link').click();
 assert.deepEqual(await page.evaluate(()=>window.__opens),[{path:'src/app.ts',line:12,column:3}]);
 await page.locator('#terminal textarea').focus();
 await page.keyboard.press('Shift+F10');
 await page.getByTestId('terminal-file-reveal').click();
 assert.deepEqual(await page.evaluate(()=>window.__calls.at(-1)),{sessionId:'terminal-session',path:'src/terminal.ts'});
 assert.equal(await page.locator('#terminal textarea').evaluate(el=>el===document.activeElement),true,'terminal input restored');
 await page.evaluate(()=>{window.__mouse='sgr';});
 await page.locator('#terminal').dispatchEvent('contextmenu',{clientX:10,clientY:10});
 assert.equal(await page.getByTestId('terminal-file-reveal').count(),0,'terminal application owns mouse-reporting click');
 await page.locator('#terminal').evaluate(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10,shiftKey:true})));
 await page.getByTestId('terminal-file-reveal').waitFor();
 await page.keyboard.press('Escape');
 await page.evaluate(()=>{window.__selection='src/a.ts\nother output';});
 await page.keyboard.press('Shift+F10');
 assert.equal(await page.getByTestId('terminal-file-reveal').count(),0,'multiline selection must not invent a location');
 await page.keyboard.press('Escape');
 console.log('PASS reference location: source session, drive/UNC, literal %, positions, Markdown, unscoped omission, event ownership, focus, original click');
 console.log('PASS terminal context: selected reference, keyboard menu, input focus, mouse reporting ownership/Shift override, multiline omission');
} finally {await app?.close();}
