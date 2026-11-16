import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const source=`
import React from 'react';import{createRoot}from'react-dom/client';
import{ExplorerView}from'./renderer/src/components/ExplorerView';import{SearchView}from'./renderer/src/components/SearchView';import{SourceControlView}from'./renderer/src/components/SourceControlView';import{QuickOpen}from'./renderer/src/components/QuickOpen';import{AgentChangesView}from'./renderer/src/components/AgentChangesView';import{SessionDocuments}from'./renderer/src/components/SessionDocuments';
const scope={projectId:'project-a',worktreePath:'D:/worktree',rootPath:'D:/worktree'};
window.calls=[];window.opens=[];window.closes=0;
const change={path:'src/sample.ts',status:'M',indexStatus:' ',worktreeStatus:'M',added:1,removed:0};
window.threadterm={onEvent:()=>()=>{},revealFileLocation:async target=>{window.calls.push(target);if(window.revealError)throw Error('Missing');return{kind:'file'};},request:async(method,params)=>{
if(method==='filesystem.list')return[{path:'src/sample.ts',name:'sample.ts',kind:'file'},{path:'docs',name:'docs',kind:'directory'}];
if(method==='filesystem.files')return{paths:['src/sample.ts'],truncated:false};
if(method==='filesystem.external.list')return{files:[{id:'external-a',path:'D:/outside/note.md',name:'note.md',exists:true}]};
if(method==='filesystem.search')return{files:[{path:'src/sample.ts',matches:[{line:3,column:1,preview:'sample',previewColumn:0,length:6}]}],truncated:false};
if(method==='review.list')return{available:true,worktreePath:'D:/review-worktree',checkpoints:[{id:'cp',kind:'turn',status:'ready',createdAt:new Date().toISOString(),skipped:[]}]};
if(method==='review.changes')return{files:[change]};
if(method==='agentReview.list'||method==='provider.list')return[];
if(method==='git.stash.list')return{entries:[]};
if(method==='git.compare.files')return{base:{ref:'main',oid:'abc'},mergeBase:'abc',files:[{path:'src/sample.ts',status:'M',additions:1,deletions:0}]};
if(method==='git.branches')return{branches:[],current:'main'};
if(method==='git.undo.list')return{entries:[]};
throw Error('Unexpected request: '+method);
}};
const actions={openFile:(...args)=>window.opens.push(args),openDiff:(...args)=>window.opens.push(args),dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}};
const git={status:{available:true,branch:'main',changes:[change],ahead:0,behind:0},loading:false,refresh:async()=>{}};
const docs={documents:[{path:'plan.md',missing:false}],loading:false,retain:()=>()=>{},refresh:()=>{},pin:async()=>{},unpin:async()=>{}};
const session={id:'session-a',projectId:'project-a',worktreePath:'D:/session-worktree',cwd:'D:/session-worktree/nested',provider:'shell',mode:'terminal',title:'Session A'};
const app=createRoot(document.getElementById('root'));
window.renderSurface=(name)=>{window.calls=[];window.opens=[];app.render(<React.Fragment key={name}>{name==='explorer'?<ExplorerView scope={scope} actions={actions} git={git} zh={false}/>:name==='search'?<SearchView scope={scope} actions={actions} zh={false}/>:name==='git'?<SourceControlView scope={scope} actions={actions} git={git} zh={false}/>:name==='quick'?<QuickOpen scope={scope} zh={false} onOpen={actions.openFile} onOpenExternal={()=>{}} onClose={()=>window.closes++}/>:name==='agent'?<AgentChangesView sessions={[session]} activeSessionId='session-a' actions={actions} zh={false} visible/>:<SessionDocuments sessionId='session-a' zh={false} state={docs} onPick={()=>{}} openFile={actions.openFile}/>}</React.Fragment>)};
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?js:'<!doctype html><html><head><style>svg{width:16px;height:16px}.app-context-menu{position:fixed;z-index:99;background:white;display:flex;flex-direction:column}.app-context-menu button{min-height:28px}button{min-height:24px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let browser;const passed=[];
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 await page.goto('http://127.0.0.1:'+server.address().port);
 const show=async name=>{await page.evaluate(name=>window.renderSurface(name),name);await page.waitForTimeout(100);};
 const reveal=async(selector,target,testId='file-reveal-system',keyboard=false)=>{
 const row=selector==='.palette-results > button.cmd-row'?page.locator(selector).filter({hasText:'sample.ts'}):page.locator(selector).first();await row.waitFor();if(keyboard){await row.focus();await row.press('Shift+F10');}else await row.click({button:'right'});
 await page.getByTestId(testId).click();await page.waitForFunction(()=>window.calls.length>0);assert.deepEqual(await page.evaluate(()=>window.calls.pop()),target);assert.deepEqual(await page.evaluate(()=>window.opens),[]);};
 const target={projectId:'project-a',worktreePath:'D:/worktree',path:'src/sample.ts'};
 await show('explorer');await reveal('.wb-tree-row[data-path="src/sample.ts"]',target,'explorer-reveal-location');await reveal('.wb-tree-row[data-path="docs"]',{...target,path:'docs'},'explorer-reveal-location',true);passed.push('Explorer file/directory, pointer/keyboard, scoped target');
 await show('search');await page.getByPlaceholder('Search in files').fill('sample');await reveal('.wb-result-head',target);await reveal('.wb-result-line',target,'file-reveal-system',true);passed.push('Search group/match and keyboard, no collapse/open');
 await show('git');await reveal('.wb-change-open',target);await page.getByRole('tab',{name:'Branch',exact:true}).click();await reveal('.wb-branch-open',target,'file-reveal-system',true);passed.push('Git changes and branch comparison, no diff/stage side effect');
 await show('agent');await reveal('.wb-change-open',{...target,worktreePath:'D:/review-worktree'});await page.locator('.wb-checkpoint-head').click();await reveal('.wb-checkpoint .wb-change-open',{...target,worktreePath:'D:/review-worktree'},'file-reveal-system',true);passed.push('Agent latest/historical changes use selected review worktree, not launch cwd');
 await show('docs');await reveal('.session-document-row',{sessionId:'session-a',path:'plan.md',workspaceRelative:true});const doc=page.locator('.session-document-row button').first();await doc.focus();await doc.press('Shift+F10');await page.getByTestId('file-reveal-system').waitFor();await page.keyboard.press('Escape');assert.equal(await doc.evaluate(el=>el===document.activeElement),true);passed.push('Session documents are literal workspace-relative; keyboard focus restored');
 await show('quick');await reveal('.palette-results > button.cmd-row',target);passed.push('Quick Open workspace target');
 await reveal('.external-file-recent',{externalId:'external-a'});passed.push('Quick Open recent external uses registration ID');
 const row=page.locator('.palette-results > button.cmd-row').filter({hasText:'sample.ts'});await row.focus();await row.press('Shift+F10');await page.getByTestId('file-reveal-system').waitFor();await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.closes),0);assert.equal(await page.locator('.app-context-menu').count(),0);passed.push('Quick Open Escape closes menu only');
 const ext=page.locator('.external-file-open-row');await ext.focus();await ext.press('Shift+F10');await page.getByTestId('file-reveal-system').waitFor();await page.keyboard.press('Escape');assert.equal(await ext.evaluate(el=>el===document.activeElement),true);passed.push('Quick Open external child keyboard focus restored');
 await page.evaluate(()=>window.revealError=true);await reveal('.external-file-recent',{externalId:'external-a'});assert.match(await page.locator('[role=alert]').innerText(),/Could not locate/);passed.push('Native rejection is visible; no silent failure');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed},null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}



