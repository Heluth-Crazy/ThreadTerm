// Isolated Electron coverage for Source Control merge/pull operation state. No Git or runtime is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(join(tmpdir(),'tt-git-merge-pull-flow-'));
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SourceControlView} from './renderer/src/components/SourceControlView';import {GitMergeControls} from './renderer/src/components/GitMergeControls';import {I18nProvider} from './renderer/src/i18n';import './renderer/src/styles.css';import './renderer/src/workbench/workbench.css';
const conflict={path:'conflict.ts',indexStatus:'U',worktreeStatus:'U',untracked:false};const staged={path:'resolved.ts',indexStatus:'M',worktreeStatus:' ',untracked:false};
const base={branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[]};
window.__requests=[];window.__setStatus=undefined;window.__pullDiverged=false;window.__mergeError='';window.__mergeWarning='';window.__mergeConflicted=false;window.__refreshes=0;window.__controlsRefreshes=0;window.__statusOnRefresh=undefined;
window.threadterm={request:async(method,params)=>{window.__requests.push([method,params]);if(method==='git.pull'&&window.__pullDiverged)throw Error('pull_diverged: 3 2');if(method==='git.merge'){if(window.__mergeError)throw Error(window.__mergeError);return {output:'merge output',conflicted:window.__mergeConflicted,...(window.__mergeWarning?{warning:window.__mergeWarning}:{})};}if(method==='worktree.branches')return [{name:'topic',current:false,remote:false}];if(method==='git.branches')return {branches:[]};return {};},onEvent:()=>()=>{}};
const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}};
function Probe(){const [status,setStatus]=useState({...base,changes:[conflict],operation:{kind:'merge',head:'integration',message:'Merge upstream integration'}});window.__setStatus=setStatus;const refresh=async()=>{window.__refreshes++;if(window.__statusOnRefresh)setStatus(window.__statusOnRefresh);};const controlsChanged=async()=>{window.__controlsRefreshes++;if(window.__statusOnRefresh)setStatus(window.__statusOnRefresh);};return <I18nProvider locale="en"><main><SourceControlView scope={{projectId:'p',rootPath:'C:/repo'}} actions={actions} git={{status,loading:false,refresh}} zh={false}/><GitMergeControls scope={{projectId:'p'}} operation={status.operation} disabled={false} onChanged={controlsChanged}/></main></I18nProvider>};createRoot(document.getElementById('root')).render(<Probe/>);`;

let app,releaseLock;
try {
 await build({stdin:{contents:source,resolveDir:root,sourcefile:'git-merge-pull-flow-probe.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(scratch,'probe.js'),logLevel:'error'});
 await writeFile(join(scratch,'index.html'),'<!doctype html><html data-theme="light"><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>');
 await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))})})`);
 releaseLock=await acquireElectronQaLock();
 app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')],cwd:root,timeout:30_000});
 const page=await app.firstWindow({timeout:20_000});page.setDefaultTimeout(10_000);
 const setStatus=status=>page.evaluate(status=>window.__setStatus(status),status);
 const requests=method=>page.evaluate(method=>window.__requests.filter(([name])=>name===method),method);

 await page.getByTestId('git-operation-banner').getByText('Merging integration · 1 conflicts').waitFor();
 const conclude=page.getByRole('button',{name:'Conclude merge'});assert.equal(await conclude.isDisabled(),true,'conflicted merge cannot conclude');
 await setStatus({branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[{path:'resolved.ts',indexStatus:'M',worktreeStatus:' ',untracked:false}],operation:{kind:'merge',head:'integration',message:'Merge upstream integration'}});
 await page.waitForFunction(()=>document.querySelector('[aria-label="Commit message"]')?.value==='Merge upstream integration');
 assert.equal(await conclude.isDisabled(),false,'resolved merge with staging can conclude');
 await page.getByRole('textbox',{name:'Commit message'}).fill('Keep my merge note');
 await setStatus({branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[{path:'resolved.ts',indexStatus:'M',worktreeStatus:' ',untracked:false}],operation:{kind:'merge',head:'integration',message:'A later merge message'}});
 await page.waitForTimeout(30);assert.equal(await page.getByRole('textbox',{name:'Commit message'}).inputValue(),'Keep my merge note','same merge must prefill once only');
 await conclude.click();await page.waitForFunction(()=>window.__requests.some(([method])=>method==='git.commit'));
 assert.equal((await requests('git.commit')).at(-1)[1].message,'Keep my merge note');

 await page.getByRole('button',{name:'Abort merge',exact:true}).click();await page.getByRole('dialog').getByText('Abort this merge and restore the state before the merge?').waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();assert.equal((await requests('git.merge.abort')).length,0,'cancel never dispatches abort');
 await page.getByRole('button',{name:'Abort merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Abort merge',exact:true}).click();await page.waitForFunction(()=>window.__requests.some(([method])=>method==='git.merge.abort'));

 const mergeControls=page.locator('.git-merge-controls');await mergeControls.getByRole('button',{name:'Merge branch…'}).click();await mergeControls.getByLabel('Source branch').click();await page.getByRole('option',{name:'topic',exact:true}).click();
 const controlsMergeBefore=(await requests('git.merge')).length;await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();assert.equal((await requests('git.merge')).length,controlsMergeBefore,'merge-controls cancel never dispatches');
 await page.evaluate(()=>{window.__mergeError='git_merge_failed'});await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge',exact:true}).click();await mergeControls.getByRole('status').waitFor();assert.equal(await mergeControls.getByRole('status').textContent(),'The Git merge failed.','merge-controls maps runtime errors for display');
 await page.evaluate(()=>{window.__mergeError='';window.__mergeWarning='merge_completed_after_error'});await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.git-merge-controls [role="status"]')?.textContent==='The merge completed, but Git reported an error afterward. Review the result.');
 const controlsRefreshBefore=await page.evaluate(()=>window.__controlsRefreshes);await page.evaluate(()=>{window.__mergeWarning='merge_completed_after_error';window.__mergeConflicted=true});await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.git-merge-controls [role="status"]')?.textContent?.includes('Merge has conflicts. Open the changed files, resolve and save them, then stage them and choose Conclude merge.'));assert.equal(await page.evaluate(()=>window.__controlsRefreshes),controlsRefreshBefore+1,'standalone controls refresh once after a conflicted merge');assert.match(await mergeControls.getByRole('status').textContent(),/The merge completed, but Git reported an error afterward\./,'a conflict keeps its warning visible');
 await page.evaluate(()=>{window.__mergeWarning='';window.__mergeError='merge_incomplete'});await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.git-merge-controls [role="status"]')?.textContent==='The merge did not finish and is still in progress. Review the merge banner, then conclude or abort it.');
 await page.evaluate(()=>{window.__mergeError='merge_interrupted: git_timeout'});await mergeControls.getByRole('button',{name:'Merge',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.git-merge-controls [role="status"]')?.textContent==='The merge was interrupted before Git recorded it, so your working tree may contain partial merge changes. Review them in Source Control before committing; to retry, discard those changes and run the merge again.');
 const controlsAbortBefore=(await requests('git.merge.abort')).length;await mergeControls.getByRole('button',{name:'Abort current merge'}).click();await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();assert.equal((await requests('git.merge.abort')).length,controlsAbortBefore,'merge-controls abort cancel never dispatches');

 await setStatus({branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[],operation:{kind:'rebase',head:'main'}});
 await page.getByTestId('git-operation-banner').getByText('Rebase in progress; finish or abort it in a terminal.').waitFor();
 assert.equal(await page.getByTestId('git-operation-banner').getByRole('button').count(),0,'non-merge operations are informational only');

 await setStatus({branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[]});await page.evaluate(()=>{window.__mergeError='';window.__mergeWarning='merge_completed_after_error';window.__mergeConflicted=false;window.__pullDiverged=true});
 const upstreamMergeBefore=(await requests('git.merge')).length;
 await page.getByRole('button',{name:'Pull'}).click();await page.getByRole('dialog').getByText('feature and origin/feature have diverged (3 ahead, 2 behind)').waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();assert.equal((await requests('git.merge')).length,upstreamMergeBefore,'cancel never dispatches upstream merge');
 await page.getByRole('button',{name:'Pull'}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge origin/feature into feature'}).click();await page.waitForFunction(before=>window.__requests.filter(([method])=>method==='git.merge').length>before,upstreamMergeBefore);
 assert.equal((await requests('git.merge')).at(-1)[1].upstream,true);
 await page.locator('.wb-notice').filter({hasText:'The merge completed, but Git reported an error afterward. Review the result.'}).waitFor();
 await page.evaluate(()=>{window.__mergeWarning='merge_completed_after_error';window.__mergeConflicted=true;window.__statusOnRefresh={branch:'feature',upstream:'origin/feature',ahead:0,behind:2,changes:[{path:'conflict.ts',indexStatus:'U',worktreeStatus:'U',untracked:false}],operation:{kind:'merge',head:'origin/feature',message:'Merge origin/feature'}}});
 const conflictRefreshBefore=await page.evaluate(()=>window.__refreshes), conflictMergeBefore=(await requests('git.merge')).length;
 await page.getByRole('button',{name:'Pull'}).click();await page.getByRole('dialog').getByRole('button',{name:'Merge origin/feature into feature'}).click();await page.waitForFunction(before=>window.__requests.filter(([method])=>method==='git.merge').length>before,conflictMergeBefore);await page.waitForFunction(before=>window.__refreshes===before+1,conflictRefreshBefore);
 await page.getByTestId('git-operation-banner').getByText('Merging origin/feature · 1 conflicts').waitFor();const scmIssue=page.locator('.wb-scm .wb-issue');await scmIssue.getByText('Merge has conflicts. Open the changed files, resolve and save them, then stage them and choose Conclude merge.').waitFor();assert.equal(await page.locator('.wb-scm').getByText('Merged upstream.',{exact:true}).count(),0,'a conflicted upstream merge never reports a clean merge');await scmIssue.getByText('The merge completed, but Git reported an error afterward. Review the result.').waitFor();
 console.log('PASS merge banner state, single message prefill, conflict/warning outcomes, abort confirmation, informational rebase, divergent pull dialog and refreshed upstream merge state');
} finally {
 const process=app?.process();
 await app?.close().catch(error=>console.error(`Electron cleanup: ${error.message}`));
 if(process?.exitCode===null) {
  process.kill();
  await new Promise(resolve=>{const timer=setTimeout(resolve,5_000);process.once('exit',()=>{clearTimeout(timer);resolve();});});
  if(process.exitCode===null) console.error('Electron cleanup: child did not exit after kill');
 }
 await releaseLock?.().catch(error=>console.error(`Electron lock cleanup: ${error.message}`));
 await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(error=>console.error(`Scratch cleanup: ${error.message}`));
}
