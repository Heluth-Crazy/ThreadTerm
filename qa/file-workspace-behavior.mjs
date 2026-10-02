// Production FileWorkspace + CodeMirror fixture. It uses an in-memory bridge
// and an isolated Electron profile; no runtime daemon or user files are used.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {_electron as electron} from '@playwright/test';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

process.chdir(resolve(fileURLToPath(new URL('..',import.meta.url))));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-file-workspace-'));
const out=resolve('qa/results/file-workspace-behavior');
await mkdir(out,{recursive:true});
const entry=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FileWorkspace} from './renderer/src/components/FileWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const calls=[];let resolveOldDraft;
const files={A:{'same.ts':'one\\ntwo\\nthree\\nfour\\n'},old:{'same.ts':'OLD_DISK\\n'},B:{'same.ts':'B_DISK\\n'},};
window.qa={calls,resolveOldDraft:()=>resolveOldDraft?.([{path:'same.ts',content:'OLD_DRAFT',baseFingerprint:'old',id:'old',revision:1}]),setBDisk:value=>files.B['same.ts']=value,conflict:false};
window.threadterm={platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},onEvent:()=>()=>{},openExternal:async()=>{},request:async(method,params)=>{
 calls.push({method,params}); const scope=params.projectId;
 if(method==='filesystem.list')return Object.keys(files[scope]??{}).map(path=>({path,name:path,kind:'file'}));
 if(method==='git.status')return{branch:'fixture',changes:[],ahead:0,behind:0};
 if(method==='draft.list'){if(scope==='old')return new Promise(resolve=>{resolveOldDraft=resolve;});return[];}
 if(method==='filesystem.read'){if(params.path==='missing.ts')throw Error('fixture missing');const content=files[scope]?.[params.path];if(content===undefined)throw Error('fixture missing');return{path:params.path,content,readonly:false,fingerprint:scope+'-v1',size:content.length,modifiedAt:'now'};}
 if(method==='filesystem.image'){if(params.path!=='extensionless')throw Error('unexpected image');return{mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0c8AAAAASUVORK5CYII='};}
 if(method==='draft.delete'||method==='draft.put')return{};
 if(method==='filesystem.write'){if(scope==='B'&&window.qa.conflict)throw Error('fixture conflict');return{path:params.path,content:params.content,readonly:false,fingerprint:scope+'-v2',size:params.content.length,modifiedAt:'now'};}
 throw Error('Unexpected fixture request '+method);
}};
function Fixture(){
 const [scope,setScope]=useState('A');const [path,setPath]=useState('same.ts');const [reveal,setReveal]=useState({line:3,column:1,key:'first'});const [assetKind,setAssetKind]=useState('text');
 window.qa.reveal=(line,key)=>setReveal({line,column:1,key});
 window.qa.startOld=()=>setScope('old');window.qa.switchB=()=>{setScope('B');setPath('same.ts');setAssetKind('text');};
 window.qa.openMissing=()=>setPath('missing.ts');window.qa.openImage=()=>{setPath('extensionless');setAssetKind('image');};
 return <I18nProvider locale="en"><div className="fixture"><FileWorkspace projectId={scope} worktreePath="D:/fixture" initialPath={path} initialView="file" reveal={reveal} assetKind={assetKind}/></div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root,.fixture{width:100%;height:100%;margin:0}.fixture{display:flex}.fixture>.file-workspace{flex:1;min-width:0;min-height:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
let app;let stage='launch';const report={passed:false,checks:[],screenshots:[]};
try{
 app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:15_000});stage='first window';const page=await app.firstWindow({timeout:15_000});page.setDefaultTimeout(10_000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 stage='initial document and reveal';const editor=page.locator('.cm-content[contenteditable=true]');await editor.waitFor();
 const anchor=()=>page.evaluate(()=>{const element=document.querySelector('.cm-content');const view=element?.cmView?.view??element?.parentElement?.cmView?.view;return view?.state.selection.main.anchor;});
 assert.equal(await anchor(),8,'initial reveal must select line 3 in the production CodeMirror view');
 await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('dirty');assert.ok((await editor.innerText()).includes('dirty'));
 await page.evaluate(()=>window.qa.reveal(2,'second'));await page.waitForFunction(()=>{const element=document.querySelector('.cm-content');const view=element?.cmView?.view??element?.parentElement?.cmView?.view;return view?.state.selection.main.anchor===4;});
 assert.ok((await editor.innerText()).includes('dirty'),'same-path reveal must not replace dirty content');await page.keyboard.press('Control+z');assert.equal((await editor.innerText()).includes('dirty'),false,'same-path reveal must retain CodeMirror undo history');report.checks.push('initial reveal anchors line 3; repeat key anchors line 2 without replacing dirty content or undo history');
 stage='old scope delayed draft list';await page.evaluate(()=>window.qa.startOld());await page.waitForFunction(()=>window.qa.calls.some(call=>call.method==='draft.list'&&call.params.projectId==='old'));await page.evaluate(()=>window.qa.switchB());
 await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('B_DISK'));const bReads=await page.evaluate(()=>window.qa.calls.filter(call=>call.method==='filesystem.read'&&call.params.projectId==='B'&&call.params.path==='same.ts').length);await page.evaluate(()=>window.qa.resolveOldDraft());await page.waitForTimeout(80);
 assert.ok((await editor.innerText()).includes('B_DISK'),'delayed A draft.list cannot hydrate B same-path document');assert.equal(await page.evaluate(()=>window.qa.calls.filter(call=>call.method==='filesystem.read'&&call.params.projectId==='B'&&call.params.path==='same.ts').length),bReads,'old completion cannot reopen B');report.checks.push('A/B same path scope remount rejects delayed old draft.list completion');
 stage='reload clears undo history';await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('old dirty');await page.evaluate(()=>{window.qa.setBDisk('C_DISK\\n');window.qa.conflict=true;});await page.keyboard.press('Control+s');await page.getByRole('button',{name:'Reload from disk',exact:true}).waitFor();await page.getByRole('button',{name:'Reload from disk',exact:true}).click();await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('C_DISK'));await editor.click();await page.keyboard.press('Control+z');assert.equal((await editor.innerText()).includes('old dirty'),false,'reload must not resurrect pre-reload dirty text through undo');assert.ok((await editor.innerText()).includes('C_DISK'));await page.evaluate(()=>window.qa.conflict=false);report.checks.push('reload/discard replaces editor atomically and Ctrl+Z cannot restore pre-reload content');
 stage='discard then failed open';await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('dirty B');await page.waitForFunction(()=>window.qa.calls.some(call=>call.method==='draft.put'&&call.params.projectId==='B'&&call.params.path==='same.ts'));await page.evaluate(()=>window.qa.openMissing());await page.getByRole('dialog',{name:'Save changes to this file?'}).waitFor();await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.getByRole('alert').filter({hasText:'fixture missing'}).waitFor();
 assert.equal((await editor.innerText()).includes('dirty B'),false,'discard before failed open must restore clean source');assert.ok((await editor.innerText()).includes('C_DISK'));assert.ok(await page.evaluate(()=>window.qa.calls.some(call=>call.method==='draft.delete')));report.checks.push('discard clears dirty document and history before an open failure');
 stage='extensionless image';const before=await page.evaluate(()=>window.qa.calls.length);await page.evaluate(()=>window.qa.openImage());await page.locator('.file-image-preview img').waitFor();const imageCalls=await page.evaluate(start=>window.qa.calls.slice(start),before);assert.ok(imageCalls.some(call=>call.method==='filesystem.image'&&call.params.path==='extensionless'));assert.equal(imageCalls.some(call=>call.method==='filesystem.read'&&call.params.path==='extensionless'),false);report.checks.push('extensionless assetKind image uses filesystem.image without filesystem.read');
 for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:join(out,theme+'.png')});report.screenshots.push(theme+'.png');}
 assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=`${stage}: ${error instanceof Error?error.message:String(error)}`;console.error('[file-workspace-behavior] '+report.error);process.exitCode=1;if(app)await app.windows()[0]?.screenshot({path:join(out,'failure.png')}).catch(()=>{});}
finally{if(app)await app.close().catch(()=>{});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
