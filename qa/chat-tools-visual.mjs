// Isolated E1 SettingsChatTools visual QA.  This deliberately imports the
// standalone component (rather than SettingsDialog) so the setting-key and
// switch contract stays cheap to exercise.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-tools-visual-'));
const out = join(root, 'qa/results/chat-parity/E1/chat-tools-visual');
const keys = ['chatTools.ask', 'chatTools.sessionInfo', 'chatTools.feedback', 'chatTools.delegation'];
const entry = `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {SettingsChatTools} from './renderer/src/components/SettingsChatTools'; import './renderer/src/styles.css';
const keys=${JSON.stringify(keys)};
function Harness({state,locale}){const [settings,setSettings]=useState({...Object.fromEntries(keys.map(key=>[key,true])),...(state==='off'?{'chatTools.ask':false}:{} )});
 const update=patch=>{window.qaPatches.push(patch);if(state==='failed')return Promise.reject(new Error('QA save failed'));if(state==='loading'||state==='disabled')return new Promise(()=>{});return new Promise(resolve=>setTimeout(()=>{setSettings(current=>({...current,...patch}));resolve()},40));};
 return <SettingsChatTools settings={settings} zh={locale==='zh-CN'} update={update}/>};
const root=createRoot(document.getElementById('root'));window.qaPatches=[];window.qaRender=(next={})=>{const style=document.documentElement.style,custom={background:'#0b1016',surface:'#182430',text:'#f2f6fb',muted:'#93a3b5',accent:'#ff7a45',border:'#26323f'};document.documentElement.dataset.theme=next.theme==='custom'?'dark':next.theme||'light';document.documentElement.dataset.customTheme=next.theme==='custom'?'true':'false';for(const [key,value]of Object.entries(custom))next.theme==='custom'?style.setProperty('--custom-'+key,value):style.removeProperty('--custom-'+key);root.render(<Harness key={JSON.stringify(next)} state={next.state||'on'} locale={next.locale||'en'}/>)};window.qaRender();
`;
await build({ stdin:{contents:entry,resolveDir:root,loader:'tsx'}, bundle:true, outfile:join(scratch,'qa.js'), jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}, logLevel:'error' });
await writeFile(join(scratch,'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;min-height:100%;padding:12px;background:var(--surface,#fff)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:700,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))})})`);
const report={passed:false,checks:[],screenshots:[],errors:[]}; let app;
const shot=async(page,name)=>{await page.screenshot({path:join(out,name),animations:'disabled'});report.screenshots.push(name)};
try {
  await rm(out,{recursive:true,force:true}); await mkdir(out,{recursive:true});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path')); env.Path=[join(process.env.SystemRoot||'C:\\Windows','System32'),dirname(process.execPath)].join(';');
  app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')],env}); const page=await app.firstWindow();
  page.on('pageerror',error=>report.errors.push(error.message)); await page.locator('.settings-chat-tools').waitFor();
  const switches=page.getByRole('switch'); assert.equal(await switches.count(),4,'four chat-tool switches');
  assert.deepEqual(await switches.evaluateAll(nodes=>nodes.map(node=>({klass:node.className,checked:node.getAttribute('aria-checked')}))), keys.map(()=>({klass:'btn btn-sm btn-ghost',checked:'true'})),'defaults use shared small ghost buttons and checked switches');
  assert.match(await page.locator('.settings-chat-tools > p').innerText(),/Applies to chats connected afterwards/);
  report.checks.push('four dot-notation settings default on, have switch semantics, shared button classes and reconnect hint');
  for(const stateName of ['on','off','loading','disabled','failed','done']) for(const theme of ['light','dark','custom']) for(const locale of ['en','zh-CN']) for(const width of [1280,420]){
    await page.setViewportSize({width,height:700}); await page.evaluate(next=>window.qaRender(next),{theme,locale,state:stateName});
    await page.waitForTimeout(30); if(['loading','disabled'].includes(stateName)) await switches.nth(0).click(); else if(stateName==='failed') { await switches.nth(0).click(); await page.getByRole('alert').waitFor(); } else if(stateName==='done') { await switches.nth(0).click(); await page.waitForTimeout(70); }
    const state=await checkControlConsistency(page,'.settings-chat-tools');assertNoControlViolations(state,`${stateName}/${theme}/${locale}/${width}`);
    assert.equal(await page.locator('.settings-chat-tools').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,`${theme}/${locale}/${width} fits`);
    await shot(page,`settings-${stateName}-${theme}-${locale}-${width}.png`);
  }
  report.checks.push('wide/420 × light/dark/custom × en/zh-CN × every on/off/loading/disabled/failed/done state fits with zero consistency violations');
  await page.evaluate(()=>window.qaRender({theme:'light',locale:'en',state:'loading'})); await switches.nth(1).click(); await page.waitForFunction(() => [...document.querySelectorAll('[role=switch]')].every(node => node.disabled));
  assert.equal(await switches.evaluateAll(nodes=>nodes.every(node=>node.disabled)),true,'pending save disables every switch');
  await page.evaluate(()=>window.qaRender({theme:'light',locale:'en',state:'on'})); await switches.nth(0).focus(); await page.keyboard.press('Space'); await page.waitForTimeout(70); assert.equal(await switches.nth(0).getAttribute('aria-checked'),'false'); assert.deepEqual(await page.evaluate(()=>window.qaPatches.at(-1)),{'chatTools.ask':false});
  report.checks.push('loading/running (disabled), failed alert, and completed save states are rendered and asserted');
  assert.deepEqual(report.errors,[]); report.passed=true;
} catch(error) { report.errors.push(error.stack||String(error)); process.exitCode=1; }
finally { await app?.close(); await mkdir(out,{recursive:true}); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)); await rm(scratch,{recursive:true,force:true}); console.log(JSON.stringify(report,null,2)); }
assert.equal(report.errors.length,0,report.errors.join('\n'));
