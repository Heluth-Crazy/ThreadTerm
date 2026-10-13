// Isolated visual QA for F2 message navigation. It uses the production component
// with an in-memory transcript; no runtime or provider process is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-lane5-nav-'));
const out = join(root, 'qa/results/chat-parity/F2/message-navigation');
const report = { passed: false, checks: [], screenshots: [], visualConsistency: [], errors: [] };
await mkdir(out, { recursive: true });

const entry = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ChatMessageNavigation } from './renderer/src/components/ChatMessageNavigation';
import { I18nProvider } from './renderer/src/i18n'; import './renderer/src/styles.css';
const items = Array.from({length:205},(_,index)=>({id:'u-'+index,role:'user',createdAt:'2026-10-13T12:'+(index%60).toString().padStart(2,'0')+':00Z',parts:[{type:'text',text:index===0?'First request':index===1?'Second request':index===2?'Third request':'Message '+index+' with enough text to make the virtualized list useful.'}],turnId:'t-'+index}));
window.__lane5={navigated:[], copied:[]};
const root=createRoot(document.getElementById('root'));
window.qaRender=(locale,state='ready')=>root.render(<I18nProvider locale={locale}><main className={'lane5-nav-fixture '+state}><ChatMessageNavigation items={state==='empty'?items.slice(0,2):items} copy={(en,zh)=>locale==='zh-CN'?zh:en} onNavigate={id=>window.__lane5.navigated.push(id)} /></main></I18nProvider>);
window.qaRender('en');`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{padding:16px;background:var(--bg)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.PATH = [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
let app; let page;
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function check(label) { const result = await checkControlConsistency(page, '.lane5-nav-fixture'); report.visualConsistency.push({ label, ...result }); assertNoControlViolations(result, label); }
try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(10_000);
  const nav = page.locator('.chat-message-navigation'); await nav.waitFor();
  assert.match(await nav.innerText(), /Messages 205/, 'the trigger reports all user messages');
  await nav.getByRole('button').first().click(); const menu = page.locator('.chat-message-popover'); await menu.waitFor();
  assert.ok(await menu.locator('[role="button"],button').count() < 80, 'more than 200 messages are virtualized');
  await menu.getByText(/Third request/).click(); await page.waitForFunction(()=>window.__lane5.navigated.includes('u-2'));
  report.checks.push('shows only at three user messages, virtualizes >200 rows, and navigates through the supplied callback');
  await page.keyboard.press('Escape'); await page.waitForTimeout(50); assert.equal(await menu.count().catch(()=>0), 0, 'Escape closes the popover');
  for (const theme of ['light','dark','custom']) for (const locale of ['en','zh-CN']) for (const width of [1280,420]) {
    await page.evaluate(([nextLocale,nextTheme])=>{ const root=document.documentElement;root.dataset.theme=nextTheme==='custom'?'dark':nextTheme;root.dataset.customTheme=nextTheme==='custom'?'true':'';for(const[key,value]of Object.entries({'--custom-background':'#0b1016','--custom-surface':'#182430','--custom-text':'#f2f6fb','--custom-muted':'#93a3b5','--custom-accent':'#ff7a45','--custom-border':'#26323f'}))root.style.setProperty(key,nextTheme==='custom'?value:'');window.qaRender(nextLocale); },[locale,theme]);
    await app.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].setContentSize(value,900),width); await nav.waitFor(); await nav.getByRole('button').first().click(); await check(`${theme}/${locale}/${width}`); await shot(`navigation-${theme}-${locale}-${width}.png`); await page.keyboard.press('Escape');
  }
  await page.evaluate(()=>window.qaRender('en','empty')); assert.equal(await page.locator('.chat-message-navigation').count(),0,'two-user state has no navigation chip'); report.checks.push('empty/under-three state is omitted');
  report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if (page) await shot('failure.png').catch(()=>{}); process.exitCode=1; }
finally { if (app) await app.close().catch(()=>{}); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)); await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{}); }
assert.deepEqual(report.errors,[],report.errors.join('\n'));
