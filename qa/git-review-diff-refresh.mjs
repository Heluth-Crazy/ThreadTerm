import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(join(tmpdir(),'tt-review-refresh-'));
let app;
try {
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ReviewDiffView} from './renderer/src/components/ReviewDiffView';import {I18nProvider} from './renderer/src/i18n';import {EditorView} from '@codemirror/view';import './renderer/src/styles.css';
 window.__requests=[];window.__pending=[];window.__writes=[];window.__listeners=new Set();window.__subscriptions=0;
 window.threadterm={request:(method,params)=>{window.__requests.push([method,params]);if(method==='review.diff')return new Promise((resolve,reject)=>window.__pending.push({resolve,reject}));if(method==='filesystem.write')return new Promise((resolve,reject)=>window.__writes.push({resolve,reject}));if(method==='runtime.snapshot')throw Error('Review Diff must not fetch runtime.snapshot');if(method==='reviewDrafts.list')return Promise.resolve({drafts:[]});if(method==='reviewDrafts.upsert')return Promise.resolve({status:'saved',draft:{draftId:params.draftId,revision:1}});return Promise.resolve({});},onEvent:f=>{window.__subscriptions++;window.__listeners.add(f);return()=>window.__listeners.delete(f);}};
 window.__editor=(side=1)=>{const el=document.querySelectorAll('.cm-editor')[side];return el?EditorView.findFromDOM(el):undefined;};
 window.__edit=text=>{const v=window.__editor();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text}})};
 window.__select=side=>{const v=window.__editor(side);v.focus();v.dispatch({selection:{anchor:0,head:Math.min(1,v.state.doc.length)}})};
 window.__emit=e=>{for(const f of window.__listeners)f(e)};
 const comments={projectRoot:()=>'C:/work',receivers:[],insert:async()=>{}};
 function Probe(){const [props,setProps]=useState({worktreeSessionIds:['sibling','own']});window.__setProps=setProps;window.__renderedProps=props;return <I18nProvider locale='en'><ReviewDiffView projectId='p' worktreePath='C:/work' path='a.txt' sessionId='own' checkpointId='cp' editorId='probe' zh={false} comments={comments} {...props}/></I18nProvider>}createRoot(document.getElementById('root')).render(<Probe/>);`;
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'review-refresh-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(scratch,'probe.js'),logLevel:'error'});
 await writeFile(join(scratch,'index.html'),'<!doctype html><div id="root"></div><script src="probe.js"></script>');
 await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))})})`);
 app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')],cwd:root,timeout:30000});
 const page=await app.firstWindow({timeout:20000});page.setDefaultTimeout(10000);
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const disk=(newText='disk',fingerprint='one')=>({path:'a.txt',oldText:'checkpoint',newText,fingerprint,exists:true,binary:false});
 const resolveDiff=async(value,index=0)=>{
  await page.waitForFunction(index=>window.__pending?.length>index,index);
  await page.evaluate(({value,index})=>window.__pending.splice(index,1)[0].resolve(value),{value,index});
 };
 const text=()=>page.evaluate(()=>window.__editor()?.state.doc.toString());
 const waitText=value=>page.waitForFunction(value=>window.__editor?.()?.state.doc.toString()===value,value);
 const count=()=>page.evaluate(()=>window.__requests.filter(([method])=>method==='review.diff').length);
 const fileEvent=()=>page.evaluate(()=>window.dispatchEvent(new Event('threadterm:workbench-files-changed')));
 const terminal=id=>page.evaluate(id=>window.__emit({event:'session.status',data:{sessionId:id,status:'idle'}}),id);
 const conflict=()=>page.getByText('This file changed on disk while you were editing.',{exact:true});
 const pending=()=>page.getByText('File updates are pending. Finish or cancel this comment to refresh.',{exact:true});
 const dialog=()=>page.getByRole('dialog');
 const refresh=()=>page.getByRole('button',{name:'Refresh',exact:true}).click();
 const openComment=async side=>{
  await page.evaluate(side=>window.__select(side),side);
  await page.getByRole('button',{name:'Comment',exact:true}).click();
  await page.getByRole('textbox',{name:'Comment for the agent'}).fill('keep this draft body');
 };
 const cancelComment=()=>page.locator('.wb-review-comment-form').getByRole('button',{name:'Cancel',exact:true}).click();

 await resolveDiff(disk());await waitText('disk');
 assert.equal(await page.evaluate(()=>window.__requests.some(([m])=>m==='runtime.snapshot')),false);
 let n=await count();await page.waitForTimeout(120);assert.equal(await count(),n,'idle makes no recurring requests');
 await terminal('sibling');await resolveDiff(disk('sibling text','two'));await waitText('sibling text');
 const subscriptions=await page.evaluate(()=>window.__subscriptions);n=await count();
 await page.evaluate(()=>window.__setProps({worktreeSessionIds:['own','sibling','own']}));
 await page.waitForFunction(()=>window.__renderedProps.worktreeSessionIds?.length===3);
 assert.equal(await page.evaluate(()=>window.__subscriptions),subscriptions,'same sorted IDs retain subscriptions');
 assert.equal(await count(),n,'same IDs do not reload');
 await page.evaluate(()=>window.__setProps({worktreeSessionIds:['own','added']}));
 await page.waitForFunction(previous=>window.__subscriptions>previous,subscriptions);
 await terminal('sibling');await page.waitForTimeout(40);assert.equal(await count(),n,'removed sessions no longer trigger refresh');
 await terminal('added');await resolveDiff(disk('added session','three'));await waitText('added session');

 await refresh();await refresh();await resolveDiff(disk('newest','four'),1);await waitText('newest');await resolveDiff(disk('stale','stale'));await page.waitForTimeout(30);assert.equal(await text(),'newest');
 await page.evaluate(()=>window.__edit('mine'));await fileEvent();await resolveDiff(disk('external','five'));await conflict().waitFor();
 await page.getByRole('button',{name:'Overwrite with my version',exact:true}).click();
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await resolveDiff(disk('external','five'));
 const overwrite=()=>dialog().getByRole('button',{name:'Overwrite with my version',exact:true});
 assert.equal(await overwrite().isEnabled(),true,'same fingerprint keeps confirmation enabled');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await resolveDiff(disk('external again','six'));
 await page.waitForFunction(()=>document.querySelector('[role="dialog"] .btn-danger')?.disabled);
 assert.equal(await overwrite().isDisabled(),true,'changed fingerprint requires a fresh confirmation');
 await dialog().getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Overwrite with my version',exact:true}).click();await overwrite().click();
 await page.waitForFunction(()=>window.__writes.length===1);
 assert.equal(await page.evaluate(()=>window.__requests.filter(([m])=>m==='filesystem.write').at(-1)[1].expectedFingerprint),'six');
 await page.evaluate(()=>window.__writes.shift().resolve({fingerprint:'saved',content:'mine'}));await resolveDiff(disk('mine','saved'));await waitText('mine');

 await page.evaluate(()=>window.__edit('confirmed edits'));await fileEvent();await resolveDiff(disk('disk reload','seven'));await conflict().waitFor();
 await page.getByRole('button',{name:'Reload from disk',exact:true}).click();await dialog().getByRole('button',{name:'Reload from disk',exact:true}).click();
 await page.waitForFunction(()=>window.__pending.length===1);await page.evaluate(()=>window.__edit('typed after reload confirmation'));
 await resolveDiff(disk('fresh disk','eight'));await conflict().waitFor();assert.equal(await text(),'typed after reload confirmation','reload preserves later typing');
 await page.locator('.cm-editor').nth(1).click();await page.keyboard.press('Control+s');assert.equal(await page.evaluate(()=>window.__writes.length),0,'plain Save stays fenced');
 await page.getByRole('button',{name:'Reload from disk',exact:true}).click();await dialog().getByRole('button',{name:'Reload from disk',exact:true}).click();await resolveDiff(disk('fresh disk','eight'));await waitText('fresh disk');

 await openComment(1);n=await count();
 await fileEvent();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await pending().waitFor();
 assert.equal(await count(),n,'current-side draft defers automatic requests');
 assert.equal(await page.getByRole('textbox',{name:'Comment for the agent'}).inputValue(),'keep this draft body');
 await cancelComment();await resolveDiff(disk('after cancel','nine'));await waitText('after cancel');assert.equal(await pending().count(),0);
 // A request already running when the user starts a draft must also preserve its anchor and body.
 await fileEvent();await page.waitForFunction(()=>window.__pending.length===1);await openComment(1);
 await resolveDiff(disk('after add','ten'));await pending().waitFor();assert.equal(await text(),'after cancel');
 assert.equal(await page.getByRole('textbox',{name:'Comment for the agent'}).inputValue(),'keep this draft body');
 await page.getByRole('button',{name:'Add comment',exact:true}).click();
 await resolveDiff(disk('after add','ten'));await waitText('after add');
 const added=await page.evaluate(()=>window.__requests.find(([m])=>m==='reviewDrafts.upsert')[1].draft);
 assert.equal(added.body,'keep this draft body');assert.equal(added.side,'new');assert.equal(added.startLine,1);
 await openComment(0);await fileEvent();await resolveDiff(disk('old-side unaffected','eleven'));await waitText('old-side unaffected');
 assert.equal(await page.getByRole('textbox',{name:'Comment for the agent'}).inputValue(),'keep this draft body','old-side body survives refresh');assert.equal(await pending().count(),0);await cancelComment();

 // Empty text alone cannot identify a safe response: binary/deletion transitions affect draft availability.
 for(const transition of [{binary:true},{exists:false}]) {
  await fileEvent();await resolveDiff(disk('','empty'));await waitText('');
  await fileEvent();await page.waitForFunction(()=>window.__pending.length===1);await openComment(1);
  const changed={...disk('','transition'),...transition};
  await resolveDiff(changed);await pending().waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Comment for the agent'}).inputValue(),'keep this draft body','availability transition preserves a cancellable form');
  await cancelComment();await resolveDiff(changed);
  if(transition.binary) await page.getByText('Binary file — no text diff.',{exact:true}).waitFor();
  else await page.getByText('This file was deleted after the checkpoint.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isEnabled(),true);
  await fileEvent();await resolveDiff(disk('recovered','recovered'));await waitText('recovered');
 }
 // If the host removes comment support while a refresh is deferred, no invisible draft may retain the block.
 await openComment(1);await fileEvent();await pending().waitFor();
 await page.evaluate(()=>window.__setProps({comments:undefined}));
 await resolveDiff(disk('host hid form','hidden'));await waitText('host hid form');
 assert.equal(await pending().count(),0);assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isEnabled(),true);
 await page.evaluate(()=>window.__setProps({}));
 assert.equal(await page.getByRole('textbox',{name:'Comment for the agent'}).count(),0,'hidden draft was cleared');
 await fileEvent();await resolveDiff(disk('refresh recovered','recovered2'));await waitText('refresh recovered');

 await page.evaluate(()=>window.__setProps({toCheckpointId:'fixed'}));await resolveDiff(disk('fixed'));await waitText('fixed');n=await count();
 await fileEvent();await terminal('own');await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(50);assert.equal(await count(),n,'fixed pairs ignore events');
 await page.evaluate(()=>window.__setProps({}));await resolveDiff(disk('fallback'));await waitText('fallback');
 await terminal('own');await resolveDiff(disk('own fallback','twelve'));await waitText('own fallback');
 assert.equal(await page.evaluate(()=>window.__requests.some(([m])=>m==='runtime.snapshot')),false);assert.deepEqual(pageErrors,[]);
 console.log('PASS Review Diff: reload typing, overwrite fingerprints, session IDs, current/old-side drafts, empty-file binary/deletion transitions, hidden-draft recovery, stale/fixed responses');
} finally {
 await app?.close().catch(()=>undefined);
 await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
