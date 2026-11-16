import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const source=`
import{I18nProvider}from'./renderer/src/i18n';import React from 'react';import{createRoot}from'react-dom/client';
import{SurfaceDialog}from'./renderer/src/components/SurfaceDialog';import{FileLocationButton}from'./renderer/src/components/FileLocationButton';import{FileBarActions}from'./renderer/src/components/FileBarActions';import{fileLocationMenuItem}from'./renderer/src/fileLocation';import{SessionSurfaceContext}from'./renderer/src/components/SessionSurfaceContext';
import{FileWorkspace}from'./renderer/src/components/FileWorkspace';import{ReviewDiffView}from'./renderer/src/components/ReviewDiffView';import{GitHistoryView}from'./renderer/src/components/GitHistoryView';import{PaneWorkspace}from'./renderer/src/components/PaneWorkspace';
const scope={projectId:'project-a',worktreePath:'D:/worktree'},target={...scope,path:'src/sample.ts'},external={externalId:'external-a'};
const doc={path:'src/sample.ts',content:'const sample=2;\\n',fingerprint:'new',encoding:'utf8',lineEnding:'lf',size:16};const pair={path:doc.path,oldText:'const sample=1;\\n',newText:doc.content,binary:false,exists:true,fingerprint:'new',indexFingerprint:'idx'};
const commit={hash:'abcdef1234567890',parents:[],authorName:'QA',authorEmail:'qa@example.invalid',authoredAt:new Date().toISOString(),subject:'Synthetic fixture',refs:[]};
window.calls=[];window.opens=[];window.requests=[];window.closes=0;
window.threadterm={onEvent:()=>()=>{},machineId:'local',revealFileLocation:async target=>{window.calls.push(target);return{kind:'file'};},request:async(method,params)=>{window.requests.push(method);
 if(method==='draft.list'||method==='worktree.list')return[];
 if(method==='filesystem.read')return{...doc,path:params.path};
 if(method==='filesystem.external.read')return{...doc,path:'D:/outside/note.md',externalId:'external-a'};
 if(method==='git.diff'||method==='review.diff'||method==='git.commit.diff')return pair;
 if(method==='review.changes')return{files:[{path:doc.path,status:'M'}]};
 if(method==='git.status')return{branch:'main',upstream:null,ahead:0,behind:0,changes:[]};
 if(method==='git.branches')return{branches:[]};
 if(method==='git.log')return{commits:[commit],hasMore:false};
 if(method==='git.commit.show')return{commit,files:[{path:doc.path,status:'M',additions:1,deletions:1}],message:'Synthetic fixture'};
 if(method==='git.history.plan')return{hash:commit.hash,head:commit.hash,branch:'main',detached:false,isAncestor:true,parents:[],reset:{count:0,commits:[],pushed:false}};
 throw Error('Unexpected request: '+method);
 }};
const app=createRoot(document.getElementById('root'));let serial=0;
window.renderSurface=(name,remote=false)=>{window.threadterm.machineId=remote?'remote-a':'local';window.calls=[];window.opens=[];const ext=name.includes('external');const chosen=ext?external:target;
const item=fileLocationMenuItem(chosen,false);const simple=<><FileLocationButton target={chosen} zh={false}/><FileBarActions items={[item]} zh={false}/></>;
const layout={kind:'pane',id:'pane-a',activeTabId:'file-a',tabs:[{id:'file-a',kind:'file',...target,...(ext?{externalId:'external-a',path:'D:/outside/note.md'}:{})}]};
app.render(<I18nProvider locale="en"><React.Fragment key={++serial}>{name==='modal'?<SurfaceDialog title='Fixture modal' onClose={()=>window.closes++}>{simple}</SurfaceDialog>:name.startsWith('shared')?simple:name.startsWith('portal')?<SessionSurfaceContext.Provider value={{focused:true,menuHost:document.getElementById('portal')}}>{simple}</SessionSurfaceContext.Provider>:name==='review'?<ReviewDiffView {...target} sessionId='session-a' checkpointId='cp' editorId='review-qa' zh={false}/>:name==='history'?<GitHistoryView {...target} zh={false}/>:name.startsWith('tabs')?<PaneWorkspace layout={layout} sessions={[]} onChange={()=>{}} theme='light' terminalCompatibility={{}}/>:<FileWorkspace {...scope} initialPath={ext?'D:/outside/note.md':doc.path} initialView={name==='diff'?'diff':'file'} externalId={ext?'external-a':undefined} embedded editorId='qa-file'/ >}</React.Fragment></I18nProvider>);
};
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'empty','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/app.js'?js:'<!doctype html><html lang="en"><head><style>svg{width:16px;height:16px}.app-context-menu{position:fixed;z-index:999;background:white;display:flex;flex-direction:column}.app-context-menu button{min-height:28px}button{min-height:24px}.workspace-tab{display:inline-flex}.file-workspace{min-height:300px}.cm-editor{max-height:200px}</style></head><body><div id="root"></div><div id="portal"></div><script src="/app.js"></script></body></html>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;const passed=[];
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1400,height:950}});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error("PAGEERROR",String(e),e.name,e.message,e.stack);});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof window.renderSurface==='function',{},{timeout:15000});
 const show=async(name,remote=false)=>{await page.evaluate(([name,remote])=>window.renderSurface(name,remote),[name,remote]);await page.waitForTimeout(150);};
 const target={projectId:'project-a',worktreePath:'D:/worktree',path:'src/sample.ts'};
 const called=async(expected)=>{await page.waitForFunction(()=>window.calls.length>0);assert.deepEqual(await page.evaluate(()=>window.calls.pop()),expected);};
 for(const name of ['shared','portal','file','diff','review','history','tabs']){
 await show(name);await page.getByTestId('file-location-button').first().click();await called(target);passed.push(name+' toolbar scoped reveal');
 if(['file','diff','review','history'].includes(name)){
 await page.locator('.cm-content').first().click({button:'right'});await page.getByTestId('file-reveal-system').click();await called(target);passed.push(name+' editor context reveal');
 }
 if(name==='tabs'){
 const tab=page.locator('.workspace-tab [role=tab]').first();await tab.click({button:'right'});await page.getByTestId('file-reveal-system').click();await called(target);passed.push('workspace tab context reveal');
 }
 if(name==='shared'){
 const more=page.getByRole('button',{name:'Workspace actions'});await more.click();await page.getByTestId('file-reveal-system').click();await called(target);assert.equal(await more.evaluate(el=>el===document.activeElement),true);passed.push('standalone FileBarActions action and focus restoration');
 }
 if(name==='portal'){await page.getByTestId('file-reveal-system').click();await called(target);passed.push('portal FileBarActions action');}

 }
 for(const name of ['shared-external','portal-external','file-external','tabs-external']){
 await show(name,true);assert.equal(await page.getByTestId('file-location-button').isDisabled(),true);assert.match(await page.getByTestId('file-location-button').getAttribute('title'),/local computer/);
 if(name==='shared-external'||name==='file-external'){await page.getByRole('button',{name:'Workspace actions'}).click();assert.equal(await page.getByTestId('file-reveal-system').getAttribute('aria-disabled'),'true');await page.keyboard.press('Escape');}else if(name==='tabs-external'){await page.locator('.workspace-tab [role=tab]').first().click({button:'right'});assert.equal(await page.getByTestId('file-reveal-system').getAttribute('aria-disabled'),'true');await page.keyboard.press('Escape');}else assert.equal(await page.getByTestId('file-reveal-system').isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);passed.push(name+' remote disabled');
 }
 await show('shared',true);assert.equal(await page.getByTestId('file-location-button').getAttribute('aria-label'),'Reveal in remote files');await page.getByTestId('file-location-button').click();await called(target);passed.push('remote workspace label/routing');
 await show('modal');
 for(const key of ['Escape','Tab']){const more=page.getByRole('button',{name:'Workspace actions'});await more.click();await page.getByTestId('file-reveal-system').waitFor();await page.keyboard.press(key);assert.equal(await page.locator('.app-context-menu').count(),0);assert.equal(await page.evaluate(()=>window.closes),0);assert.equal(await more.evaluate(el=>el===document.activeElement),true);}
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.closes),1);passed.push('modal Escape/Tab belong to context menu; next Escape reaches modal');
 assert.equal(await page.evaluate(()=>window.requests.some(m=>['draft.put','filesystem.write','git.stage','git.unstage','git.commit','git.reset','git.checkout'].includes(m))),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed},null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
