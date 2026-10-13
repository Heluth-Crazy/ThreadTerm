// D1 isolated hidden Electron surface with synthetic envelopes; no runtime/provider.
// Real-app QA uses Desktop 1 through the named question-app regression.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const out=resolve('qa/results/chat-parity/D1/approval-diff');
const scratch=await mkdtemp(join(tmpdir(),'tt-lane2-d1-'));
await mkdir(out,{recursive:true});
const files=Array.from({length:5},(_,i)=>({path:'src/module-'+i+'.ts',kind:{type:'update'},diff:'@@ -1,220 +1,220 @@\n'+Array.from({length:220},(_,j)=>'-const old'+j+' = false;\n+const next'+j+' = true;').join('\n')}));
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatApprovalCard} from './renderer/src/components/ChatApprovalCard';import './renderer/src/styles.css';
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});
const root=createRoot(document.getElementById('root'));window.choices=[];let renderSerial=0;
window.qaRender=(locale='en',state='pending')=>{const copy=(en,zh)=>locale==='zh-CN'?zh:en;const details=state==='command'?{command:'npm run test -- --reporter=verbose',cwd:'project'}:state==='empty'?{}:{changes:${JSON.stringify(files)}};
root.render(<ChatApprovalCard key={++renderSerial} part={{type:'approval',approvalId:'d1',status:['resolved','failed'].includes(state)?state:'pending',data:{approvalId:'d1',title:state==='command'?'Run command':'Review proposed edits',details,submittable:true,choices:[{choiceId:'allow',label:'Allow once',kind:'allow',scope:'once'},{choiceId:'deny',label:'Deny',kind:'deny',scope:'once'}]}}} writable={state!=='disabled'} submitting={state==='loading'?'allow':undefined} onChoose={id=>window.choices.push(id)} copy={copy}/>);};window.qaRender();`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><title>Lane 2 D1 approval QA</title><link rel="stylesheet" href="qa.css"><style>body{margin:0;padding:12px;background:var(--bg);color:var(--text)}#root{padding:12px;border:1px solid var(--border);border-radius:var(--radius-card);background:var(--surface)}button{white-space:nowrap}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({title:'Lane 2 D1 approval QA',width:1280,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path'));env.PATH=join(process.env.SystemRoot||'C:/Windows','System32');
const report={passed:false,screenshots:[],checks:[],errors:[]};let app,page;
try{app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')],env});page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.waitForFunction(()=>window.qaRender);
for(const theme of ['light','dark','custom'])for(const locale of ['en','zh-CN'])for(const width of [1280,420]){
 await page.setViewportSize({width,height:900});await page.evaluate(([theme,locale])=>{document.documentElement.dataset.theme=theme==='custom'?'dark':theme;document.documentElement.dataset.customTheme=String(theme==='custom');if(theme==='custom'){document.documentElement.style.setProperty('--custom-surface','#25332b');document.documentElement.style.setProperty('--custom-accent','#c39f57');}window.qaRender(locale);},[theme,locale]);await page.locator('.chat-approval-preview').waitFor();
 assert.ok(await page.locator('.chat-approval-preview').evaluate(e=>e.clientHeight<=240&&e.scrollHeight>e.clientHeight));assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth<=window.innerWidth),true);assert.equal(await page.locator('.tool-edit-file').count(),3);
 assertNoControlViolations(await checkControlConsistency(page,'.chat-approval-card'),theme+'/'+locale+'/'+width);
 const cardBox=await page.locator('.chat-approval-card').boundingBox();const showAllBox=await page.getByRole('button',{name:locale==='en'?'Show all':'显示全部',exact:true}).boundingBox();
 assert.ok(showAllBox.width<cardBox.width*0.5,'Show all stays compact instead of stretching across the card');assert.ok(Math.abs(showAllBox.x-cardBox.x)<24,'Show all is left-aligned with the card content');
 const name='approval-'+theme+'-'+locale+'-'+width+'.png';await page.screenshot({path:join(out,name)});report.screenshots.push(name);
 await page.getByRole('button',{name:locale==='en'?'Show all':'显示全部',exact:true}).click();assert.equal(await page.locator('.tool-edit-file').count(),5);
 assert.ok(await page.locator('.chat-approval-actions').evaluate(e=>e.getBoundingClientRect().bottom<=window.innerHeight));
}
for(const state of ['empty','command','loading','resolved','failed','disabled']){await page.evaluate(state=>window.qaRender('en',state),state);await page.locator('.chat-approval-card').waitFor();assertNoControlViolations(await checkControlConsistency(page,'.chat-approval-card'),state);const name=state+'.png';await page.screenshot({path:join(out,name)});report.screenshots.push(name);if(state==='disabled'||state==='loading')assert.equal(await page.locator('.chat-approval-actions button:enabled').count(),0);}
await page.evaluate(()=>window.qaRender('en'));await page.locator('.chat-approval-actions button').first().press('Enter');assert.deepEqual(await page.evaluate(()=>window.choices),['allow']);assert.deepEqual(report.errors,[]);report.checks.push('bounded diff scrolling; file counts and show all; choices visible at 420; zero control violations; keyboard; all states');report.passed=true;
}catch(e){report.errors.push(e.stack||String(e));process.exitCode=1;if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});}finally{await app?.close();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
