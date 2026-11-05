// Real runtime + Electron TS/JS navigation probe. Do not run until a fresh runtime
// binary is supplied and this worker has been granted the Electron/Rust slot.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const toolsPath = resolve(process.env.THREADTERM_NAVIGATION_TOOLS ?? join(root, '.trellis/tasks/11-05-editor-navigation-lsp/qa-tools/tools.json'));
const scratch = await mkdtemp(join(tmpdir(), 'tt-editor-navigation-integrated-'));
const project = join(scratch, 'project'), data = join(scratch, 'data'), rendererRoot = join(scratch, 'renderer');
const pipe = `\\\\.\\pipe\\tt-nav-integrated-${randomUUID()}`, out = join(root, 'qa/results/editor-navigation-integrated');
const report = { passed:false, runtime, toolsPath, checks:[], timings:{}, screenshots:[], errors:[] };
let daemon, peer, app, release, qaApp, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolPath = value => typeof value === 'string' ? value : value?.path;
function runtimeChildren() {
  if (!daemon?.pid || process.platform !== 'win32') return [];
  const rows = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],{encoding:'utf8'}));
  const all = Array.isArray(rows) ? rows : [rows], ids = new Set([daemon.pid]), children=[];
  for (let changed=true;changed;) { changed=false; for (const row of all) if (ids.has(row.ParentProcessId) && !ids.has(row.ProcessId)) { ids.add(row.ProcessId); children.push({pid:row.ProcessId,name:row.Name}); changed=true; } }
  return children;
}
async function until(probe, label, timeout=30_000) { const end=Date.now()+timeout; let last; while(Date.now()<end){try{const result=await probe();if(result)return result;last=result;}catch(error){last=error;}await delay(100);}throw Error(`${label} timed out${last?`: ${last}`:''}`); }
async function writeFixture() {
  await mkdir(rendererRoot,{recursive:true});
  await symlink(join(root,'node_modules'),join(rendererRoot,'node_modules'),process.platform==='win32'?'junction':'dir');
  const source = `import React from 'react';import{createRoot}from'react-dom/client';import{FileWorkspace}from${JSON.stringify(join(root,'renderer/src/components/FileWorkspace.tsx'))};import{I18nProvider}from${JSON.stringify(join(root,'renderer/src/i18n.tsx'))};import${JSON.stringify(join(root,'renderer/src/styles.css'))};
const rootNode=createRoot(document.getElementById('root'));window.__mountNavigation=(projectId)=>rootNode.render(<I18nProvider locale='en'><main className='fixture'><FileWorkspace projectId={projectId} worktreePath=${JSON.stringify(project)} rootPath=${JSON.stringify(project)} initialPath='src/source.ts' initialView='file' editorId='integrated'/></main></I18nProvider>);`;
  await writeFile(join(rendererRoot,'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/src.tsx"></script>');
  await writeFile(join(rendererRoot,'src.tsx'),source);
}
async function startRuntime() {
  daemon=spawn(runtime,[],{windowsHide:true,stdio:'ignore',env:{...process.env,THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe}});
  peer=await until(async()=>{try{const value=await connectPeer(`${pipe}-control`);await value.auth((await readFile(join(data,'runtime.credential'),'utf8')).trim());return value;}catch{return undefined;}},'runtime pipe');
}
try {
  await mkdir(out,{recursive:true});
  if (!existsSync(runtime)) throw Error(`Missing runtime binary: ${runtime}`);
  if (!existsSync(toolsPath)) throw Error(`Missing tools manifest: ${toolsPath}`);
  const manifest=JSON.parse(await readFile(toolsPath,'utf8')), typescript=toolPath(manifest.typescript?.server ?? manifest.tools?.typescript?.server);
  if (!typescript || !existsSync(typescript)) throw Error(`Configured TypeScript language server is unavailable: ${typescript}`);
  await mkdir(join(project,'src'),{recursive:true});
  await writeFile(join(project,'tsconfig.json'),'{"compilerOptions":{"target":"ES2022","module":"ESNext"}}');
  await writeFile(join(project,'src/target.ts'),'export function realTarget(){ return 7; }\nexport const targetSymbol = realTarget;\n');
  await writeFile(join(project,'src/source.ts'),"import { realTarget } from './target';\nexport const sourceSymbol = realTarget();\n");
  await writeFixture(); await startRuntime();
  const baselineChildren=runtimeChildren(); assert.ok(baselineChildren.every(child=>/^conhost(?:\.exe)?$/i.test(child.name)),'only the runtime console host exists before service configuration'); report.baselineRuntimeChildren=baselineChildren;
  // FileWorkspace also starts ordinary Git bootstrap workers; TS services run as node.
  const serviceChildren=()=>runtimeChildren().filter(child=>/^node(?:\.exe)?$/i.test(child.name));
  const configured=await peer.request('editorNavigation.configure',{enabled:true,tools:{typescript}}); assert.equal((configured.result??configured).enabled,true,'runtime accepts the valid task-local TypeScript configuration before UI mount');
  // Configuration may perform bounded compatibility discovery; let it settle before the no-service baseline.
  await delay(350);
  release=await acquireElectronQaLock(); qaApp=await buildQaApp({root,outDir:join(scratch,'app'),viteOptions:{root:rendererRoot}});
  app=await electron.launch({args:['--disable-features=CalculateNativeWinOcclusion',qaApp.appDir],cwd:root,env:{...process.env,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,THREADTERM_V3_DATA:data,THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe},timeout:60_000});
  page=await app.firstWindow({timeout:45_000}); const pageErrors=[]; report.pageErrors=pageErrors; page.on('pageerror',error=>pageErrors.push(error.message)); page.on('console',message=>{if(message.type()==='error')pageErrors.push(message.text());});
  await page.waitForFunction(()=>typeof window.threadterm?.request==='function'&&typeof window.__mountNavigation==='function');
  const added=await page.evaluate(path=>window.threadterm.request('project.add',{path,name:'Integrated navigation QA',operationId:crypto.randomUUID()}),project); await page.evaluate(id=>window.__mountNavigation(id),added.id);
  const editor=page.locator('.cm-content[contenteditable=true]'); await editor.waitFor();
  report.beforeSemanticChildren=runtimeChildren(); assert.deepEqual(serviceChildren(),[],'runtime has no TypeScript language-service child before a semantic action'); report.checks.push('zero TypeScript language-service child before semantic action');
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('// DIRTY_SOURCE'); await editor.evaluate(element=>{const view=element.cmView?.view??element.parentElement?.cmView?.view, at=view.state.doc.toString().indexOf('realTarget');view.dispatch({selection:{anchor:at}});}); const cold=performance.now(); await page.keyboard.press('F12');
  await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('realTarget')&&!document.querySelector('.cm-content')?.textContent?.includes('sourceSymbol'),undefined,{timeout:45_000}); report.timings.coldDefinitionMs=Math.round(performance.now()-cold); assert.ok((await editor.textContent()).includes('realTarget'),'real TypeScript definition opens target'); assert.ok(serviceChildren().length>0,'semantic action starts an actual runtime-managed child process');
  await page.keyboard.press('Control+Alt+ArrowLeft'); await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('sourceSymbol')); assert.ok((await editor.textContent()).includes('DIRTY_SOURCE'),'back preserves dirty text'); await page.keyboard.press('Control+z'); assert.equal((await editor.textContent()).includes('DIRTY_SOURCE'),false,'back preserves undo'); report.checks.push('definition/back retain dirty text and undo');
  const warm=performance.now(); await page.keyboard.press('Control+F12'); const chooser=page.getByRole('dialog'); await chooser.waitFor({timeout:15_000}); report.timings.warmSymbolsMs=Math.round(performance.now()-warm); await chooser.screenshot({path:join(out,'symbols-light.png')}); report.screenshots.push('symbols-light.png'); await page.evaluate(()=>document.documentElement.dataset.theme='dark'); await chooser.screenshot({path:join(out,'symbols-dark.png')}); report.screenshots.push('symbols-dark.png'); await page.keyboard.press('Escape'); report.checks.push('current-file symbols chooser shown from real TypeScript service');
  // Inspect actual detected-tool and configuration feedback after the semantic assertions.
  await page.evaluate(()=>document.documentElement.dataset.theme='light'); await editor.click({button:'right'}); const services=page.getByText(/language services/i).first(); await services.waitFor({timeout:10_000}); await services.click(); const setup=page.locator('.editor-navigation-dialog'); await setup.waitFor({timeout:10_000}); await setup.screenshot({path:join(out,'setup-light.png'),animations:'disabled'}); await page.evaluate(()=>document.documentElement.dataset.theme='dark'); await setup.screenshot({path:join(out,'setup-dark.png'),animations:'disabled'}); report.screenshots.push('setup-light.png','setup-dark.png'); report.checks.push('actual language-services setup dialog visible');
  assert.deepEqual(pageErrors,[],'no page errors'); report.passed=true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if(page){report.failureText=await page.locator('body').innerText().catch(()=>undefined);report.failureChildren=runtimeChildren();await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});} throw error; }
finally { if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});} await release?.(); if(peer){await peer.request('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});peer.close();} if(daemon?.exitCode===null)daemon.kill(); await qaApp?.cleanup().catch(()=>{}); report.finishedAt=new Date().toISOString(); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)); await rm(scratch,{recursive:true,force:true}).catch(()=>{}); console.log(JSON.stringify(report,null,2)); }
