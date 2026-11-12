// Real Electron/component fixture with synthetic catalog RPCs. Never starts the runtime or an Agent.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const qaTemp = resolve(process.env.TEMP ?? tmpdir());
const scratch = await mkdtemp(join(qaTemp, 'threadterm-delegation-fold-'));
const out = resolve('qa/results/delegation-fold');
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectCatalog } from './renderer/src/components/ProjectCatalog';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const gitProject={id:'git-project',name:'Git fixture',path:'D:/qa/git',pinned:false,sortOrder:0,revision:0,git:{available:true}};
const plainProject={id:'plain-project',name:'Plain fixture',path:'D:/qa/plain',pinned:false,sortOrder:1,revision:0,git:{available:false}};
const tree={id:'git-tree',projectId:gitProject.id,path:gitProject.path,branch:'feature/delegation-fold',isMain:true};
const terminal=['completed','failed','cancelled','interrupted'];
const make=(id,project,path,state,extra={})=>({
 id,title:id,projectId:project.id,worktreePath:path,provider:'codex',mode:'chat',status:state==='running'?'running':terminal.includes(state)?'exited':'idle',
 createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',activity:{state:state==='running'?'running':'idle',revision:1,turnId:'turn-'+id},...extra,
});
const family=(prefix,project,path)=>{
 const parent=make(prefix+' parent',project,path,'running');
 const delegate=(name,state,extra={})=>make(prefix+' '+name,project,path,state,{delegation:{parentSessionId:parent.id,state},...extra});
 return [parent,delegate('running one','running'),delegate('running two','running'),...terminal.map((state,index)=>delegate('finished '+(index+1),state))];
};
const allSessions=[...family('Git',gitProject,gitProject.path),...family('Plain',plainProject,plainProject.path)];
let sessions=sessionStorage.getItem('delegation-fold-start-empty')==='true'?[]:[...allSessions],sessionsProvided=true;
let visibility=[],locale='en',theme='light',selected=undefined;
const calls=[],listeners=new Set();
const root=createRoot(document.getElementById('root'));
const render=()=>{const catalogProps=sessionsProvided?{sessions:[...sessions]}:{};document.documentElement.lang=locale;document.documentElement.dataset.theme=theme;root.render(<I18nProvider locale={locale}><aside style={{width:340,padding:12}}><ProjectCatalog selectedProjectId={gitProject.id} selectedWorktreePath={gitProject.path} selectedSessionId={selected} {...catalogProps} visibility={visibility} onAll={()=>{}} onProject={()=>{}} onWorktree={()=>{}} onSession={id=>{selected=id;render();}} onChanged={render}/></aside><main><h1>Delegation fold QA</h1></main></I18nProvider>);};
window.threadterm={onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(method,params){
 calls.push({method,params});
 if(method==='project.catalog.list')return [gitProject,plainProject];
 if(method==='worktree.list')return params.projectId===gitProject.id?[tree]:[];
 if(method==='group.list')return [];
 if(method==='runtime.snapshot')return {sessions};
 if(method==='catalog.visibility.list')return visibility;
 if(method==='catalog.visibility.update'){
  visibility=visibility.filter(row=>!(row.kind===params.kind&&row.id===params.id)).concat({kind:params.kind,id:params.id,visibility:params.visibility,revision:1,projectId:params.projectId});render();return;
 }
 throw Error('Unexpected fixture RPC '+method);
}};
window.qaDelegationFold={configure(next){locale=next.locale??locale;theme=next.theme??theme;render();},select(id){selected=id;render();},setActivity(id,state){sessions=sessions.map(session=>session.id===id?{...session,status:state==='awaiting_approval'?'waiting':state==='awaiting_input'?'idle':state==='idle'&&session.delegation?'exited':session.status,activity:{...session.activity,state,revision:session.activity.revision+1}}:session);render();},setSessions(next){sessions=next;sessionsProvided=true;render();},omitSessions(){sessionsProvided=false;render();},restoreSessions(){sessions=[...allSessions];sessionsProvided=true;render();},calls(){return calls;},selected(){return selected;}};
render();
`;

await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}aside{flex-shrink:0;background:var(--surface);border-right:1px solid var(--border)}main{padding:24px}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);

let app,page,releaseLock;
const report={passed:false,checks:[],screenshots:[],errors:[]};
const row=(parentId)=>page.locator(`.delegate-fold-row[data-parent-id="${parentId}"]`);
const ids=(scope)=>scope.locator('.sess-row-wrap[data-session-id]').evaluateAll(rows=>rows.map(value=>value.dataset.sessionId));
const familyIds=prefix=>({parent:`${prefix} parent`,running:[`${prefix} running one`,`${prefix} running two`],finished:['completed','failed','cancelled','interrupted'].map((_,index)=>`${prefix} finished ${index+1}`)});
try{
 releaseLock=await acquireElectronQaLock({directory:qaTemp});
 app=await electron.launch({args:[join(scratch,'main.cjs')],cwd:resolve('.'),timeout:20_000});
 page=await app.firstWindow({timeout:20_000});page.setDefaultTimeout(10_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const git=familyIds('Git'),plain=familyIds('Plain');
 const gitScope=page.locator('.catalog-tree-group');
 const plainScope=page.locator('.proj-group').filter({hasText:'Plain fixture'});
 await row(git.parent).waitFor();await row(plain.parent).waitFor();
 assert.equal(await row(git.parent).innerText(),'4 finished');
 assert.equal(await row(plain.parent).innerText(),'4 finished');
 for(const family of [git,plain]){
  const scope=family===git?gitScope:plainScope;
  const visible=await ids(scope);
  assert.deepEqual(visible,[family.parent,...family.running],`${family.parent} keeps its running delegates visible while four finished delegates are folded`);
  assert.equal(await scope.locator('.sess-row-wrap.is-delegate[data-session-id]').count(),2,`${family.parent} has only its running delegates before expansion`);
 }
 await page.evaluate(id=>window.qaDelegationFold.select(id),git.finished[0]);
 await page.waitForFunction(id=>document.querySelector(`.delegate-fold-row[data-parent-id="${id}"]`)?.textContent==='3 finished',git.parent);
 assert.equal(await gitScope.locator(`.sess-row-wrap[data-session-id="${git.finished[0]}"]`).count(),1,'selected finished delegate remains visible');
 await page.evaluate((ids)=>{window.qaDelegationFold.select(undefined);window.qaDelegationFold.setActivity(ids[0],'awaiting_approval');window.qaDelegationFold.setActivity(ids[1],'awaiting_input');},[git.finished[1],git.finished[2]]);
 await page.waitForFunction(id=>document.querySelector(`.delegate-fold-row[data-parent-id="${id}"]`)?.textContent==='2 finished',git.parent);
 assert.equal(await gitScope.locator(`.sess-row-wrap[data-session-id="${git.finished[1]}"]`).count(),1,'approval delegate remains visible');
 assert.equal(await gitScope.locator(`.sess-row-wrap[data-session-id="${git.finished[2]}"]`).count(),1,'input delegate remains visible');
 await page.evaluate(ids=>{window.qaDelegationFold.setActivity(ids[0],'idle');window.qaDelegationFold.setActivity(ids[1],'idle');},[git.finished[1],git.finished[2]]);
 await page.waitForFunction(id=>document.querySelector(`.delegate-fold-row[data-parent-id="${id}"]`)?.textContent==='4 finished',git.parent);
 report.checks.push('both worktree and plain-directory paths start collapsed; selected, approval, and input finished delegates remain visible');

 await row(git.parent).focus();assert.equal(await row(git.parent).evaluate(element=>element===document.activeElement),true,'fold row receives keyboard focus');
 await row(git.parent).press('Enter');
 await page.waitForFunction(id=>document.querySelector(`.delegate-fold-row[data-parent-id="${id}"]`)?.getAttribute('aria-expanded')==='true',git.parent);
 assert.deepEqual(await ids(gitScope),[git.parent,...git.running,...git.finished],'expanded worktree puts finished delegates after visible delegates');
 assert.equal(await row(git.parent).evaluate(element=>element===document.activeElement),true,'keyboard expansion preserves fold-row focus');
 await page.screenshot({path:join(out,'en-light-expanded.png')});report.screenshots.push('en-light-expanded.png');
 await row(git.parent).press('Space');await page.waitForFunction(id=>document.querySelector(`.delegate-fold-row[data-parent-id="${id}"]`)?.getAttribute('aria-expanded')==='false',git.parent);
 await page.screenshot({path:join(out,'en-light-collapsed.png')});report.screenshots.push('en-light-collapsed.png');
 report.checks.push('Enter/Space toggle the fold row, preserve focus, and expansion keeps the finished delegates after the visible delegates');

 await row(git.parent).click();await page.reload();await row(git.parent).waitFor();
 assert.equal(await row(git.parent).getAttribute('aria-expanded'),'true','expanded choice persists after reload');
 await row(plain.parent).click();
 assert.deepEqual(await ids(plainScope),[plain.parent,...plain.running,...plain.finished],'plain-directory expansion uses the same order');
 report.checks.push('expanded choices persist through reload and plain-directory expansion has the same ordering');

 await page.evaluate(()=>localStorage.setItem('threadterm.expandedFinishedDelegates','not json'));
 await page.reload();await row(git.parent).waitFor();
 assert.equal(await row(git.parent).getAttribute('aria-expanded'),'false','malformed saved preferences safely fall back to collapsed');
 await page.evaluate(()=>localStorage.setItem('threadterm.expandedFinishedDelegates',JSON.stringify(['Git parent','removed parent'])));
 await page.reload();await row(git.parent).waitFor();
 await page.waitForFunction(()=>localStorage.getItem('threadterm.expandedFinishedDelegates')===JSON.stringify(['Git parent']));
 assert.equal(await row(git.parent).getAttribute('aria-expanded'),'true','known saved parent remains expanded while removed parent is pruned');
 await page.evaluate(()=>{localStorage.setItem('threadterm.expandedFinishedDelegates',JSON.stringify(['Git parent']));window.qaDelegationFold.omitSessions();});
 await page.waitForTimeout(30);
 assert.equal(await page.evaluate(()=>localStorage.getItem('threadterm.expandedFinishedDelegates')),JSON.stringify(['Git parent']),'omitted sessions while loading preserve saved preferences');
 await page.evaluate(()=>window.qaDelegationFold.setSessions([]));
 await page.waitForFunction(()=>localStorage.getItem('threadterm.expandedFinishedDelegates')==='[]');
 await page.evaluate(()=>window.qaDelegationFold.restoreSessions());await row(git.parent).waitFor();
 assert.equal(await row(git.parent).getAttribute('aria-expanded'),'false','an authoritative empty catalog clears saved parents');
 report.checks.push('malformed preferences fall back safely; stale parents prune after sessions arrive; loading preserves preferences while an authoritative empty catalog clears them');

 await page.evaluate(next=>window.qaDelegationFold.configure(next),{locale:'zh-CN',theme:'dark'});await page.waitForTimeout(80);
 assert.equal(await row(git.parent).innerText(),'4 个已结束');
 await row(git.parent).click();await row(plain.parent).click();
 await page.screenshot({path:join(out,'zh-dark-expanded.png')});report.screenshots.push('zh-dark-expanded.png');
 await row(git.parent).click();await row(plain.parent).click();
 await page.screenshot({path:join(out,'zh-dark-collapsed.png')});report.screenshots.push('zh-dark-collapsed.png');
 report.checks.push('English/light and Chinese/dark fold labels render with expanded and collapsed screenshots');

 await page.evaluate(next=>window.qaDelegationFold.configure(next),{locale:'en',theme:'light'});
 await row(git.parent).click();
 const archived=gitScope.locator(`.sess-row-wrap[data-session-id="${git.finished[0]}"]`);
 await archived.hover();await archived.locator('.row-more').click();
 const menu=page.getByRole('menu',{name:git.finished[0],exact:true});await menu.waitFor();
 await menu.getByRole('menuitem',{name:'Archive',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Archive in ThreadTerm',exact:true});await dialog.waitFor();await dialog.getByRole('button',{name:'Confirm archive',exact:true}).click();
 await archived.waitFor({state:'detached'});
 assert.ok((await page.evaluate(()=>window.qaDelegationFold.calls())).some(call=>call.method==='catalog.visibility.update'&&call.params.id==='Git finished 1'&&call.params.visibility==='archived'),'existing archive menu remains usable for an expanded finished delegate');
 // Group actions on the fold row (2026-11-12): archive or delete every finished delegate of a parent at once.
 const remaining=git.finished.slice(1),gitFold=row(git.parent).locator('xpath=..');
 await gitFold.hover();await gitFold.getByTestId('delegate-group-more').click();
 const groupMenu=page.getByRole('menu',{name:`${remaining.length} finished delegates`,exact:true});await groupMenu.waitFor();
 await page.screenshot({path:join(out,'en-light-group-menu.png')});report.screenshots.push('en-light-group-menu.png');
 await groupMenu.getByTestId('delegate-group-archive').click();
 const groupDialog=page.getByRole('dialog',{name:'Archive finished delegates',exact:true});await groupDialog.waitFor();
 await page.screenshot({path:join(out,'en-light-group-dialog.png')});report.screenshots.push('en-light-group-dialog.png');
 const callsBefore=(await page.evaluate(()=>window.qaDelegationFold.calls())).length;
 await groupDialog.getByTestId('delegate-group-confirm').click();
 await row(git.parent).waitFor({state:'detached'});
 const groupUpdates=(await page.evaluate(()=>window.qaDelegationFold.calls())).slice(callsBefore).filter(call=>call.method==='catalog.visibility.update');
 assert.deepEqual(groupUpdates.map(call=>[call.params.kind,call.params.id,call.params.visibility]).sort(),remaining.map(id=>['session',id,'archived']).sort(),'one archive per remaining finished delegate and nothing else');
 assert.deepEqual(await ids(gitScope),[git.parent,...git.running],'the parent and its running delegates stay; the fold is gone');
 const plainFold=row(plain.parent).locator('xpath=..');
 await plainFold.hover();await plainFold.getByTestId('delegate-group-more').click();
 await page.getByTestId('delegate-group-delete').click();
 const deleteDialog=page.getByRole('dialog',{name:'Delete finished delegates',exact:true});await deleteDialog.waitFor();
 const callsBeforeDelete=(await page.evaluate(()=>window.qaDelegationFold.calls())).length;
 await deleteDialog.getByTestId('delegate-group-confirm').click();
 await row(plain.parent).waitFor({state:'detached'});
 const deletes=(await page.evaluate(()=>window.qaDelegationFold.calls())).slice(callsBeforeDelete).filter(call=>call.method==='catalog.visibility.update');
 assert.deepEqual(deletes.map(call=>[call.params.id,call.params.visibility]).sort(),plain.finished.map(id=>[id,'removed']).sort(),'delete removes exactly the finished delegates of the plain parent');
 assert.deepEqual(await ids(plainScope),[plain.parent,...plain.running],'plain parent and running delegates stay after the group delete');
 report.checks.push('the fold row archives or deletes the whole finished group after one confirmation; parent and running delegates stay');
 assert.deepEqual(errors,[],'fixture has no renderer errors');
 report.checks.push('an expanded finished delegate keeps its existing context menu and Archive action');
 report.passed=true;
}catch(error){report.errors.push(String(error.stack??error));process.exitCode=1;if(page){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});report.screenshots.push('failure.png');}}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await releaseLock?.();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));const scratchRelative=relative(qaTemp,scratch);if(scratchRelative&&!scratchRelative.startsWith('..')&&!isAbsolute(scratchRelative))await rm(scratch,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));}
