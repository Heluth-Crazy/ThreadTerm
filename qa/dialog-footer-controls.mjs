// Isolated Desktop-1 QA for the production FileWorkspace dirty-close dialog.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-dialog-footer-'));
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'before';
const out = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? join(root, 'qa/results/dialog-footer-controls', phase));
await mkdir(out, { recursive: true });
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const isolatedHome = join(scratch, 'home');
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(childEnv, {
  Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
  HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2),
  CODEX_HOME: join(isolatedHome, '.codex'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'userdata'),
  THREADTERM_V3_PIPE: '\\\\.\\pipe\\threadterm-dialog-' + randomUUID(), TT_QA_DESKTOP: '1',
});

const entry = String.raw`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {FileWorkspace} from './renderer/src/components/FileWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import {confirmCloseEditors} from './renderer/src/dirtyEditors';
import './renderer/src/styles.css';
const content='export const fixture = true;\\n';const drafts=new Map();let writes=[];
window.qa={calls:[],writes,mounted:true,closeResult:undefined,holdWrite:false,draftCount:()=>drafts.size};
window.threadterm={onPageContextMenu:()=>()=>{},platform:'win32',windowsPty:{backend:'conpty',buildNumber:22631},onEvent:()=>()=>{},openExternal:async()=>{},request:async(method,params)=>{window.qa.calls.push({method,params});
if(method==='filesystem.read')return{path:params.path,content,readonly:false,fingerprint:'fixture-fingerprint',size:content.length,modifiedAt:'now'};
if(method==='filesystem.list')return[{path:'src/fixture.ts',name:'fixture.ts',kind:'file'}];
if(method==='git.status')return{branch:'fixture',changes:[],ahead:0,behind:0};
if(method==='git.diff')return{oldText:'',newText:'',binary:false};
if(method==='draft.list')return[...drafts.values()];
if(method==='draft.put'){const value={...params,id:params.path,revision:(drafts.get(params.path)?.revision??0)+1};drafts.set(params.path,value);return value;}
if(method==='draft.delete'){drafts.delete(params.id);return{};}
if(method==='filesystem.write'){writes.push(params);if(window.qa.holdWrite)return await new Promise((resolve,reject)=>{window.qa.resolveWrite=ok=>ok?resolve({path:params.path,content:params.content,readonly:false,fingerprint:'saved-'+writes.length,size:params.content.length,modifiedAt:'now'}):reject(new Error('fixture save failure'));});return{path:params.path,content:params.content,readonly:false,fingerprint:'saved-'+writes.length,size:params.content.length,modifiedAt:'now'};}
throw Error('Unexpected fixture request '+method);}};
function Fixture(){const[shown,setShown]=useState(true),[locale,setLocale]=useState('en');window.qa.setLocale=value=>{const next=value==='zh'?'zh-CN':'en';document.documentElement.lang=next;setLocale(next);};window.qa.requestClose=async()=>{const accepted=await confirmCloseEditors();window.qa.closeResult=accepted;if(accepted){window.qa.mounted=false;setShown(false);}return accepted;};return <I18nProvider locale={locale}>{shown&&<FileWorkspace projectId='fixture-project' worktreePath='D:/fixture' initialPath='src/fixture.ts' editorId='fixture-editor' rootPath='D:/fixture'/>}</I18nProvider>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root{display:flex}#root>.file-workspace{flex:1;min-width:0;min-height:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), 'const {app,BrowserWindow}=require("electron");app.setPath("userData",' + JSON.stringify(join(scratch, 'profile')) + ');app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.loadFile(' + JSON.stringify(join(scratch, 'index.html')) + ');});');

const report = { phase, passed: false, cases: [], screenshots: [], errors: [] };
let intentionalTeardown=false;
let app, page;
try {
  app = await electron.launch({ args: ['--disable-gpu','--in-process-gpu','--no-sandbox','--disable-notifications',join(scratch, 'main.cjs')], env: childEnv, timeout: 15_000 });
  console.log('electron-ready');
  page = await app.firstWindow({ timeout: 10_000 }); page.setDefaultTimeout(8_000);
  console.log('first-window', await page.url());
  page.on('close',()=>{if(!intentionalTeardown)report.errors.push('page closed before QA completion');});
  page.on('crash',()=>report.errors.push('page crashed'));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if(message.type()==='error') report.errors.push('console: '+message.text()); });
  await page.locator('.cm-content[contenteditable=true]').waitFor({timeout:8_000});
  console.log('fileworkspace-editor-ready');
  const editor = page.locator('.cm-content[contenteditable=true]');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.setViewportSize({ width: 1280, height: 800 });
  await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('// baseline dirty');
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-dirty"]')?.hidden === false);
  const closeAttempt = page.evaluate(() => window.qa.requestClose()).catch(error=>{report.errors.push('initial close request rejected: '+error.message);return 'rejected';});
  const dialog = page.getByRole('dialog', { name: 'Save changes to this file?' });
  await dialog.waitFor();
  const result = await dialog.locator('.dlg-foot').evaluate(footer => {
    const rect = element => { const box=element.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width,height:box.height}; };
    return {footer:{...rect(footer),gap:getComputedStyle(footer).gap},buttons:[...footer.querySelectorAll(':scope > button')].map(button=>({...rect(button),label:button.innerText.trim(),fontSize:getComputedStyle(button).fontSize,borderRadius:getComputedStyle(button).borderRadius}))};
  });
  report.cases.push({ name: 'actual-fileworkspace-footer-dark-en-1280', result });
  await page.screenshot({ path: join(out, 'fileworkspace-dark-en-1280.png') });
  report.screenshots.push('fileworkspace-dark-en-1280.png');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await closeAttempt, false, 'before capture uses Cancel to leave the workspace open');
  if (phase === 'after') {
    const activeDialog = () => page.locator('[role="dialog"]:visible').last();
    const reloadWorkspace = async (width=1280,height=800,theme='dark',lang='en') => {
      await page.setViewportSize({width,height});
      await page.reload();
      await page.locator('.cm-content[contenteditable=true]').waitFor();
      await page.evaluate(({theme,lang})=>{document.documentElement.dataset.theme=theme;document.documentElement.lang=lang==='zh'?'zh-CN':'en';window.qa.setLocale(lang);},{theme,lang});
    };
    const edit = async marker => {
      const input=page.locator('.cm-content[contenteditable=true]');
      await input.click();await input.press('Control+End');await input.pressSequentially(marker);
      await page.waitForFunction(()=>{const dirty=document.querySelector('[data-testid="editor-dirty"]');return dirty&&!dirty.hidden;});
      await page.waitForFunction(()=>window.qa.draftCount()>0,{timeout:4_000});
    };
    const requestDirtyClose = async () => {
      const closing=page.evaluate(()=>window.qa.requestClose()).catch(error=>{report.errors.push('close request rejected: '+error.message);return 'rejected';});
      console.log('requesting dirty editor close');
      const current=activeDialog();await current.waitFor();
      console.log('dirty close dialog shown');
      return {closing,dialog:current};
    };
    const waitForDecision = async (closing,expected) => assert.equal(await closing,expected,'dirty-editor host close result');
    const assertFooter = async (current,tag) => {
      const measured=await current.locator('.dlg-foot').evaluate(footer=>{
        const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        return{footer:{...rect(footer),gap:getComputedStyle(footer).gap},dialog:rect(footer.closest('[role="dialog"]')),buttons:[...footer.querySelectorAll(':scope > button')].map(button=>({...rect(button),label:button.innerText.trim(),fontSize:getComputedStyle(button).fontSize,borderRadius:getComputedStyle(button).borderRadius}))};
      });
      for(const button of measured.buttons){assert.ok(Math.abs(button.height-32)<=1,tag+': '+button.label+' height is 32px');assert.equal(button.fontSize,'13px',tag+': '+button.label+' font is 13px');assert.match(button.borderRadius,/8px/,tag+': '+button.label+' radius is 8px');}
      assert.equal(measured.footer.gap,'8px',tag+': footer gap is 8px');
      assert.equal(measured.buttons.length,3,tag+': all actions remain available');
      assert.ok(measured.buttons.every(button=>button.x>=measured.footer.x-1&&button.right<=measured.footer.right+1),tag+': footer buttons do not clip horizontally');
      assert.ok(measured.footer.bottom<=measured.dialog.bottom+1,tag+': footer does not clip vertically');
      return measured;
    };
    await reloadWorkspace();await edit('// cancel preserves text');
    let pendingClose=await requestDirtyClose();
    await assertFooter(pendingClose.dialog,'wide dark English');
    await pendingClose.dialog.locator('.dlg-foot button').nth(0).click();
    await waitForDecision(pendingClose.closing,false);
    console.log('cancel resolved');
    assert.equal(await page.evaluate(()=>window.qa.mounted),true,'Cancel leaves workspace mounted');
    assert.ok((await page.locator('.cm-content').innerText()).includes('// cancel preserves text'),'Cancel preserves dirty editor text');
    assert.ok(await page.evaluate(()=>window.qa.draftCount()>0),'Cancel preserves draft');
    assert.equal(await page.evaluate(()=>window.qa.writes.length),0,'Cancel does not save');
    pendingClose=await requestDirtyClose();await pendingClose.dialog.locator('.dlg-foot button').last().focus();await page.keyboard.press('Tab');
    assert.equal(await pendingClose.dialog.locator('.dlg-head .icon-btn').evaluate(element=>element===document.activeElement),true,'Tab from Save cycles to the dialog close control');
    await page.keyboard.press('Escape');await pendingClose.dialog.waitFor({state:'hidden'});await waitForDecision(pendingClose.closing,false);
    console.log('escape resolved');
    assert.equal(await page.evaluate(()=>window.qa.mounted),true,'Escape leaves workspace mounted');
    report.cases.push({name:'cancel-escape-focus-trap-preserve-draft',passed:true});

    await edit('// discard');
    pendingClose=await requestDirtyClose();const writesBefore=await page.evaluate(()=>window.qa.writes.length);
    await pendingClose.dialog.locator('.dlg-foot button').nth(1).click();await waitForDecision(pendingClose.closing,true);
    assert.equal(await page.evaluate(()=>window.qa.mounted),false,'Discard confirms and closes workspace');
    assert.equal(await page.evaluate(()=>window.qa.writes.length),writesBefore,'Discard never writes');
    assert.equal(await page.evaluate(()=>window.qa.draftCount()),0,'Discard deletes draft');
    report.cases.push({name:'discard-closes-without-saving',passed:true});

    await reloadWorkspace();await edit('// save succeeds after retry');pendingClose=await requestDirtyClose();
    await page.evaluate(()=>window.qa.holdWrite=true);
    await pendingClose.dialog.locator('.dlg-foot button').last().click();
    await page.waitForFunction(()=>typeof window.qa.resolveWrite==='function');
    assert.equal(await pendingClose.dialog.locator('.dlg-foot button').last().isDisabled(),true,'Save disables while write is pending');
    await page.evaluate(()=>window.qa.resolveWrite(false));
    await page.getByRole('alert').waitFor();assert.equal(await activeDialog().count(),1,'failed Save keeps prompt open');
    assert.ok((await page.locator('.cm-content').innerText()).includes('// save succeeds after retry'),'failed Save retains text');
    assert.ok(await page.evaluate(()=>window.qa.draftCount()>0),'failed Save retains draft');
    assert.equal(await page.evaluate(()=>window.qa.mounted),true,'failed Save does not close host');
    await page.evaluate(()=>window.qa.holdWrite=false);
    await pendingClose.dialog.locator('.dlg-foot button').last().click();await waitForDecision(pendingClose.closing,true);
    const writes=await page.evaluate(()=>window.qa.writes);
    assert.equal(writes.length,2,'failed Save is followed by one successful retry');
    assert.ok(writes[1].content.includes('// save succeeds after retry'),'Save forwards edited content');
    assert.equal(writes[1].expectedFingerprint,'fixture-fingerprint','Save forwards expected fingerprint');
    assert.equal(await page.evaluate(()=>window.qa.mounted),false,'only successful Save confirms host closure');
    report.cases.push({name:'failed-save-retry-content-fingerprint-and-close',passed:true,writes});

    for(const width of [1280,390,320])for(const theme of ['light','dark'])for(const lang of ['en','zh']){
      const tag=width+'-'+theme+'-'+lang;
      await reloadWorkspace(width,width<=390?844:800,theme,lang);await edit('// visual '+tag);
      const visualClose=await requestDirtyClose();const measured=await assertFooter(visualClose.dialog,tag);
      const expectedLabels=lang==='zh'?['取消','放弃更改','保存文件']:['Cancel','Discard changes','Save file'];
      assert.deepEqual(measured.buttons.map(button=>button.label),expectedLabels,tag+': actual FileWorkspace dialog locale is applied');
      if(width===320&&lang==='en')assert.ok(measured.buttons[2].y>measured.buttons[1].y,tag+': Save wraps intact at compact widths');
      const file='fileworkspace-'+tag+'.png';await page.screenshot({path:join(out,file)});report.screenshots.push(file);
      report.cases.push({name:'actual-fileworkspace-footer-'+tag,passed:true,measured});
      await visualClose.dialog.locator('.dlg-foot button').nth(0).click();await waitForDecision(visualClose.closing,false);
    }
  }
} catch(error) {
  report.errors.push(error instanceof Error ? error.stack : String(error));
  if(page){report.pageText=await page.locator('body').innerText().catch(()=>'<unavailable>');await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});report.screenshots.push('failure.png');}
  process.exitCode = 1;
} finally {
  const child=app?.process();
  intentionalTeardown=true;
  await app?.close().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5_000))]);
  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  if(!childExited)report.errors.push('isolated Electron child did not exit after app.close(); scratch retained');
  const tempRoot = resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/');
  if(childExited && resolve(scratch).startsWith(tempRoot) && basename(resolve(scratch)).startsWith('threadterm-dialog-footer-')) await rm(scratch,{recursive:true,force:true});
  report.passed = report.errors.length === 0;
  if(!report.passed)process.exitCode = 1;
  report.completedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, phase, passed: report.passed, cases: report.cases.length, errors: report.errors }, null, 2));
}
