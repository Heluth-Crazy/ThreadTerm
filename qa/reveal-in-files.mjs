// Real components + supplied runtime, served by Vite: no app/runtime build.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from '@playwright/test';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(import.meta.dirname, '..');
const baseline = process.argv.includes('--baseline');
const scratch = await mkdtemp(join(tmpdir(), 'tt-reveal-'));
const project = join(scratch, 'project'), data = join(scratch, 'data');
const target = 'deep/nested/folder/target.ts';
const pipe = `\\\\.\\pipe\\tt-reveal-${randomUUID()}`;
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const report = { baseline, checks:[] };
const note = check => { report.checks.push(check); console.log(`PASS ${check}`); };
let daemon, peer, server, app, release, page;
const out = join(root,'qa/results/reveal-in-files');
async function until(probe, label) {
 const end = Date.now() + 30000;
 while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(100); }
 throw Error(`Timed out: ${label}`);
}
try {
 await mkdir(join(project, 'deep/nested/folder'), { recursive:true });
 await mkdir(out,{recursive:true});
 await writeFile(join(project, target), 'export const target = 1;\n');
 for(let index=0;index<85;index++) await writeFile(join(project, `deep/nested/folder/a${index.toString().padStart(2,'0')}.ts`), 'padding\n');
 execFileSync('git',['init','-q','-b','main'],{cwd:project,windowsHide:true});
 execFileSync('git',['config','core.autocrlf','false'],{cwd:project,windowsHide:true});
 execFileSync('git',['add','.'],{cwd:project,windowsHide:true});
 execFileSync('git',['-c','user.name=QA','-c','user.email=qa@example.test','commit','-qm','fixture'],{cwd:project,windowsHide:true});
 await writeFile(join(project,target),'export const target = 2;\n');
 await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
 const modulePath = path => JSON.stringify(join(root, path).replaceAll('\\', '/'));
 await writeFile(join(scratch, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/probe.tsx"></script>');
 await writeFile(join(scratch, 'probe.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{FileWorkspace}from${modulePath('renderer/src/components/FileWorkspace.tsx')};import{SessionWorkspace}from${modulePath('renderer/src/components/SessionWorkspace.tsx')};import{requestFilesReveal}from${modulePath('renderer/src/workbench/revealInFiles.ts')};import{I18nProvider}from${modulePath('renderer/src/i18n.tsx')};import${modulePath('renderer/src/styles.css')};
window.revealFiles=requestFilesReveal;window.requests=[];
window.threadterm={request:(method,params)=>{window.requests.push([method,params]);return window.runtimeRequest(method,params);},onEvent:()=>()=>{},onBrowserEvent:()=>()=>{},onBrowserHandoffEvent:()=>()=>{},subscribeOutput:async()=>()=>{},onPageContextMenu:()=>()=>{},browserCommand:async()=>({linkTarget:'preview',tabs:[]})};
const root=createRoot(document.getElementById('root'));
window.mount=(id)=>root.render(<I18nProvider locale="en"><main style={{height:650,width:'100%'}}><FileWorkspace projectId={id} rootPath=${JSON.stringify(project)} initialPath=${JSON.stringify(target)}/></main></I18nProvider>);
window.mountSession=(data,id)=>root.render(<I18nProvider locale="en"><div className="app-shell native-chrome" style={{display:'block'}}><SessionWorkspace session={data.sessions.find(s=>s.id===id)} data={data} theme="light" onBack={()=>{}} onSelect={()=>{}} onProject={()=>{}} onChanged={()=>{}} onBackgroundPresented={()=>{}}/></div></I18nProvider>);`);
 await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({show:false,width:1600,height:900,webPreferences:{contextIsolation:false,sandbox:false,backgroundThrottling:false}}).loadURL(process.env.PROBE_URL)})`);
 daemon = spawn(runtime, [], { windowsHide:true, stdio:'ignore', env:{...process.env, THREADTERM_V3_DATA:data, THREADTERM_V3_PIPE:pipe} });
 peer = await until(async () => { try { const value=await connectPeer(`${pipe}-control`);await value.auth((await readFile(join(data,'runtime.credential'),'utf8')).trim());return value; } catch { return undefined; } }, 'runtime');
 const added = await peer.request('project.add', { path:project, name:'Reveal QA', operationId:randomUUID() });
 // Peer is sequential; renderer components may issue requests concurrently.
 let pending = Promise.resolve();
 const request = (method, params) => { const next = pending.then(() => peer.request(method, params)); pending = next.catch(() => {}); return next; };
 server = await createServer({configFile:false,root:scratch,plugins:[react()],cacheDir:join(scratch,'.vite'),css:{postcss:{plugins:[]}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,scratch]}}});
 await server.listen();release = await acquireElectronQaLock();
 app = await electron.launch({args:['--disable-gpu',join(scratch,'main.cjs')],cwd:root,env:{...process.env,PROBE_URL:server.resolvedUrls.local[0]},timeout:60000});
 page = await app.firstWindow();page.setDefaultTimeout(15000);
 await page.exposeFunction('runtimeRequest',request);await page.waitForFunction(()=>typeof window.mount==='function');await page.evaluate(id=>window.mount(id),added.id);
 await page.locator('.cm-content').waitFor();
 await page.getByRole('button',{name:'Workspace actions',exact:true}).click();
 await page.getByRole('menuitem',{name:'Files & Git',exact:true}).click();
 const row = page.locator(`[role=treeitem][data-path="${target}"]`);await row.waitFor();
 await page.getByRole('button',{name:'Collapse all',exact:true}).click();await row.waitFor({state:'detached'});
 await page.getByRole('button',{name:'Workspace actions',exact:true}).click();
 await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();
 if (baseline) {
  await delay(400);
  report.rowVisible=await row.count()>0;report.focused=await row.count()>0&&await row.evaluate(node=>document.activeElement===node);
  assert.equal(report.rowVisible,false,'baseline reproduces collapsed active file staying hidden');
  note('reproduced: Reveal leaves the active deep file hidden after Collapse all');
 } else {
  const assertRevealed = async (path, focus=true) => {
   const row=page.locator(`[role=treeitem][data-path="${path}"]:visible`);await row.waitFor();
   if(focus) await page.waitForFunction(path=>document.activeElement?.getAttribute('data-path')===path,path);
   assert.equal(await row.getAttribute('aria-selected'),'true');
   const parts=path.split('/');for(let index=1;index<parts.length;index++) assert.equal(await page.locator(`[role=treeitem][data-path="${parts.slice(0,index).join('/')}"]:visible`).getAttribute('aria-expanded'),'true');
   assert.ok(await row.evaluate(node=>{const box=node.getBoundingClientRect();let host=node.parentElement;while(host&&!/(auto|scroll)/.test(getComputedStyle(host).overflowY))host=host.parentElement;const viewport=host.getBoundingClientRect();return box.top>=viewport.top-1&&box.bottom<=viewport.bottom+1;}),'selected row is in its scroll viewport');
  };
  await assertRevealed(target);note('standalone file bar: repeated reveal expands, selects, scrolls and focuses');
  // Same path after manual scrolling, with no active-file state change.
  await row.evaluate(node=>{let host=node.parentElement;while(host&&!/(auto|scroll)/.test(getComputedStyle(host).overflowY))host=host.parentElement;host.scrollTop=0;});
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await assertRevealed(target);
  await page.keyboard.press('ArrowUp');assert.match(await page.evaluate(()=>document.activeElement?.getAttribute('data-path')),/a84\.ts$/);note('repeat after scroll and arrow-key continuation');
  await rm(join(project,target));
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await assertRevealed('deep/nested/folder');await page.getByRole('alert').filter({hasText:'File missing.'}).waitFor();
  note('deleted file falls back to nearest existing folder with notice');
  await rm(join(project,'deep'),{recursive:true,force:true});
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await assertRevealed('');note('deleted ancestor chain falls back to focusable root row');
  await mkdir(join(project,'deep/nested/folder'),{recursive:true});await writeFile(join(project,target),'export const target = 3;\n');
  const session=await request('session.create',{projectId:added.id,cwd:project,provider:'shell',mode:'terminal',title:'Reveal session',operationId:randomUUID()});
  await request('session.stop',{sessionId:session.id,operationId:randomUUID()});
  const snapshot=await request('runtime.snapshot',{}),defaultRoot=snapshot.sessions.find(item=>item.id===session.id).worktreePath??snapshot.projects.find(item=>item.id===added.id).path;
  await page.evaluate(([data,id])=>window.mountSession(data,id),[snapshot,session.id]);
  await page.locator('.runtime-workspace').waitFor();
  await page.evaluate(()=>dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'quick-open'}})));
  await page.getByRole('textbox',{name:'File name',exact:true}).fill('target.ts');
  await page.locator('.wb-quick-open [role=option]').filter({hasText:'target.ts'}).click();await page.locator('.cm-content:visible').waitFor();
  await page.locator('[data-workspace-tab][data-tab-kind=session] .workspace-tab-close').click();
  await page.getByRole('button',{name:'Files',exact:true}).click();await row.waitFor();
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  const tab=page.locator('[data-workspace-tab][data-tab-kind=file] [role=tab]');await tab.focus();await tab.press('Shift+F10');
  await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await assertRevealed(target);note('actual SessionWorkspace file tab context menu');
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  await page.getByRole('button',{name:'Source Control',exact:true}).click();
  const change=page.locator(`[data-change-path="${target}"] .wb-change-open`).first();await change.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await change.click({button:'right'});await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).press('Enter');await assertRevealed(target);note('actual SessionWorkspace Source Control row');
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('textbox',{name:'Search in files',exact:true}).fill('export const target');
  await page.locator('.wb-result-line').first().click({button:'right'});await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await assertRevealed(target);note('actual SessionWorkspace search result');
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  await page.evaluate(()=>dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'quick-open'}})));await page.getByRole('textbox',{name:'File name',exact:true}).fill('target.ts');
  await page.locator('.wb-quick-open [role=option]').filter({hasText:'target.ts'}).click({button:'right'});await page.getByRole('menuitem',{name:'Reveal in Files',exact:true}).click();await page.locator('.wb-quick-open').waitFor({state:'detached'});await assertRevealed(target);note('actual SessionWorkspace Quick Open workspace result closes picker');
  const alternate=join(scratch,'alternate');await request('worktree.create',{projectId:added.id,path:alternate,branch:'reveal-alternate',createBranch:true,operationId:randomUUID()});
  await page.evaluate(([projectId,root,path])=>window.revealFiles({projectId,worktreePath:root,rootPath:root},path),[added.id,alternate,target]);await assertRevealed(target);
  await row.click();await page.waitForFunction(()=>[...document.querySelectorAll('.cm-content')].some(node=>node.textContent.includes('target = 1')));
  note('alternate registered worktree: reveal and opened row use target provenance');
  await page.locator('[data-workspace-tab][data-tab-kind=file] [role=tab]').first().click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.cm-content')].some(node=>node.textContent.includes('target = 3')));
  await page.evaluate(()=>dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'files'}})));await row.waitFor();
  await page.waitForFunction(root=>window.requests.filter(([method])=>method==='filesystem.list').at(-1)?.[1].worktreePath===root,defaultRoot);
  await assertRevealed(target,false);
  note('current file tab and normal Files navigation restore default tree');
  await writeFile(join(project,'.git/reveal-filter.txt'),'filtered fixture\n');
  await page.evaluate(([projectId,root])=>window.revealFiles({projectId,worktreePath:root,rootPath:root},'.git/reveal-filter.txt'),[added.id,defaultRoot]);await assertRevealed('.git/reveal-filter.txt');
  note('explicit reveal bypasses hidden .git tree entry');
 }
 report.passed=true;
 await page.screenshot({path:join(out,'revealed.png')});
} catch(error) {
 report.error=error.stack;report.failureText=await page?.locator('body').innerText().catch(()=>undefined);
 await page?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
 throw error;
} finally {
 console.log(JSON.stringify(report,null,2));await writeFile(join(out,baseline?'baseline.json':'report.json'),JSON.stringify(report,null,2));
 await app?.close().catch(()=>{});await release?.();await server?.close();
 if(peer){await peer.request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});peer.close();}
 if(daemon?.exitCode===null)daemon.kill();
 assert.equal(dirname(resolve(scratch)),resolve(tmpdir()));assert.ok(basename(scratch).startsWith('tt-reveal-'));
 await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
