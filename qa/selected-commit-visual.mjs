// Desktop-1 renderer coverage for selected-file Source Control actions. No real Git is invoked.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'qa/results/selected-commit');
const scratch=await mkdtemp(join(tmpdir(),'tt-selected-commit-'));
const source=`
 import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
 import {SourceControlView} from './renderer/src/components/SourceControlView'; import './renderer/src/styles.css'; import './renderer/src/workbench/workbench.css';
 const selectedCommit={head:{kind:'branch',oid:'a'.repeat(40),target:'refs/heads/main'},indexFingerprint:'d'.repeat(64),supported:true,gitVersion:'2.54.0'};
 const changes=[{path:'src/dual.ts',indexStatus:'M',worktreeStatus:'M',untracked:false},{path:'src/staged.ts',indexStatus:'A',worktreeStatus:' ',untracked:false},{path:'src/change.ts',indexStatus:' ',worktreeStatus:'M',untracked:false},{path:'new.ts',indexStatus:'?',worktreeStatus:'?',untracked:true}];
 window.__requests=[]; window.__refreshes=[]; window.__failSelected=true; window.__postCommitWarning=false; window.__holdSelected=false; window.__holdLegacy=false; window.__failLegacy=false; window.__holdRefresh=false; window.__failRefresh=false;
 window.threadterm={request:async(method,params)=>{window.__requests.push([method,params]);if(method==='git.commit.selected'){if(window.__holdSelected)await new Promise(resolve=>window.__releaseSelected=resolve);if(window.__failSelected)throw Error('git_selected_commit_stale');return {commit:'b'.repeat(40),tree:'c'.repeat(40),parent:'a'.repeat(40),refTarget:'refs/heads/main',committedPaths:params.selected.map(row=>row.path),retainedStagedPaths:['src/staged.ts'],retainedStagedPathsTruncated:false,...(window.__postCommitWarning?{postCommitError:'post-commit exited 1',cleanupError:'private index cleanup failed'}:{})};}if(method==='git.stage'){if(window.__holdLegacy)await new Promise(resolve=>window.__releaseLegacy=resolve);if(window.__failLegacy)throw Error('legacy_stage_failed');return {paths:params.paths};}return method==='git.branches'?{branches:[]}:{};},onEvent:()=>()=>{}};
 const actions={openFile:()=>{},openDiff:()=>{},dirtyPaths:()=>[],renamed:()=>{},deleted:()=>{}};
 function Probe(){const [rootPath,setRootPath]=useState('C:/one'),[zh,setZh]=useState(false),[width,setWidth]=useState(440);window.__setRoot=setRootPath;window.__setView=(nextZh,nextWidth)=>{setZh(nextZh);setWidth(nextWidth)};const status={branch:'main',upstream:null,ahead:0,behind:0,changes,selectedCommit:rootPath==='C:/old'?{...selectedCommit,supported:false,unsupportedReason:'Git 2.33 lacks required hooks'}:selectedCommit};const refresh=async()=>{window.__refreshes.push(rootPath);if(window.__holdRefresh)await new Promise(resolve=>window.__releaseRefresh=resolve);if(window.__failRefresh)throw Error('git_status_changed')};return <main className="probe" style={{width}}><SourceControlView scope={{projectId:'p',rootPath}} actions={actions} git={{status,loading:false,refresh}} zh={zh}/></main>};createRoot(document.getElementById('root')).render(<Probe/>);
`;
await mkdir(out,{recursive:true});
await build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,outfile:join(scratch,'probe.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'});
await writeFile(join(scratch,'index.html'),'<!doctype html><link rel="stylesheet" href="probe.css"><style>html,body,#root{margin:0;min-height:100%;background:var(--bg)}.probe{width:440px;min-height:620px;margin:12px;border:1px solid var(--border);background:var(--surface)}</style><div id="root"></div><script src="probe.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1040,height:760,show:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch,'index.html'))})})`);
let app; const report={passed:false,checks:[],screenshots:[],errors:[]};
try {const blocked=/^(path|home|userprofile|codex_home|data|profile|pipe|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime)$/iu;const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!blocked.test(key)));Object.assign(env,{Path:[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-selected-commit-${process.pid}`});assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['Path']);app=await electron.launch({args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(scratch,'main.cjs')],env,timeout:30_000});const page=await app.firstWindow({timeout:20_000});page.setDefaultTimeout(10_000);await page.getByRole('textbox',{name:'Commit message'}).fill('selected only');
 const stagedDual=page.getByRole('checkbox',{name:'Select src/dual.ts in staged'}), stagedOnly=page.getByRole('checkbox',{name:'Select src/staged.ts in staged'}), changed=page.getByRole('checkbox',{name:'Select src/change.ts in changes'});
 await stagedDual.check(); await changed.check();
 await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage selected files'}).click();
 const stagedRequest=await page.evaluate(()=>window.__requests.filter(([method])=>method==='git.stage').at(-1));
 assert.deepEqual(stagedRequest[1].paths,['src/change.ts'],'stage selected must never stage an unselected dual-status remainder');
 assert.equal(await changed.isChecked(),false,'only the completed Changes selection clears');
 await page.getByRole('button',{name:'Commit selected'}).click();
 await page.getByRole('alert').waitFor();
 assert.equal(await stagedDual.isChecked(),true,'failed selected commit must retain its staged selection');
 const failed=await page.evaluate(()=>window.__requests.filter(([method])=>method==='git.commit.selected').at(-1));
 assert.deepEqual(failed[1].selected,[{path:'src/dual.ts',indexStatus:'M'}]);
 assert.deepEqual(failed[1].expectedHead,{kind:'branch',oid:'a'.repeat(40),target:'refs/heads/main'});
 assert.equal(failed[1].expectedIndexFingerprint,'d'.repeat(64));
 await page.evaluate(()=>{window.__failSelected=false;window.__postCommitWarning=true}); await page.getByRole('textbox',{name:'Commit message'}).press('Control+Enter');
 await page.waitForFunction(()=>document.querySelector('[aria-label="Select src/dual.ts in staged"]').checked===false);
 await page.getByText(/Committed, but the post-commit hook reported/).waitFor();
 await page.getByText(/cleanup after publication reported an error/).waitFor();
 await page.waitForTimeout(4100); assert.equal(await page.getByText(/cleanup after publication reported an error/).count(),1,'published-commit warnings remain visible after transient notices expire');
 await stagedOnly.check(); await page.evaluate(()=>window.__setRoot('C:/old')); await page.getByRole('checkbox',{name:'Select src/dual.ts in staged'}).check();
 await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.getAttribute('title')?.includes('Git 2.33'));
 assert.equal(await page.locator('.wb-commit-main').isDisabled(),true,'old Git snapshot must visibly disable selected commit');
 assert.match(await page.locator('.wb-commit-main').getAttribute('title'),/Git 2\.33/);
 await page.evaluate(()=>window.__setRoot('C:/one')); await page.waitForFunction(()=>document.querySelector('[aria-label="Select src/staged.ts in staged"]')?.checked===true);
 assert.equal(await stagedOnly.isChecked(),true,'selection remains local to and survives return to its canonical root'); await page.getByRole('textbox',{name:'Commit message'}).fill('held selected');
 await page.evaluate(()=>{window.__holdSelected=true;window.__postCommitWarning=false}); await page.getByRole('button',{name:'Commit selected'}).click(); await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent?.includes('Committing selected'));
 await page.evaluate(()=>window.__setRoot('C:/two')); await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent?.includes('Commit all staged'));
 assert.equal(await page.locator('.wb-commit-main').isDisabled(),false,'a held request from another root must not leave this root busy'); await page.evaluate(()=>window.__releaseSelected()); await page.waitForTimeout(30);
 await page.evaluate(()=>window.__setRoot('C:/one')); await page.waitForFunction(()=>document.querySelector('[aria-label="Select src/staged.ts in staged"]')?.checked===true);
 const ordinaryStage=()=>page.locator('section[aria-label="Changes"] .wb-change-row').filter({hasText:'change.ts'}).getByRole('button',{name:'Stage'});
 for(const failingLegacy of [false,true]){
  await page.evaluate(fail=>{window.__holdLegacy=true;window.__failLegacy=fail},failingLegacy); await ordinaryStage().click(); await page.getByText('Working…').waitFor();
  await page.evaluate(()=>window.__setRoot('C:/two')); await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent?.includes('Commit all staged'));
  await page.getByRole('checkbox',{name:'Select src/dual.ts in staged'}).check(); await page.getByRole('textbox',{name:'Commit message'}).fill(`new scope pending ${failingLegacy?'error':'success'}`); await page.evaluate(()=>window.__holdSelected=true); await page.getByRole('button',{name:'Commit selected'}).click(); await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent?.includes('Committing selected'));
  const oldRefreshes=await page.evaluate(()=>window.__refreshes.filter(root=>root==='C:/one').length); await page.evaluate(()=>window.__releaseLegacy()); await page.waitForTimeout(30);
  assert.match(await page.locator('.wb-commit-main').textContent(),/Committing selected/,'an old ordinary request must not clear new-scope selected busy state'); assert.equal(await page.getByRole('alert').count(),0,'an old ordinary error must not appear in the new scope');
  assert.equal(await page.evaluate(()=>window.__refreshes.filter(root=>root==='C:/one').length),oldRefreshes,'a stale old-scope action must not issue an old-scope refresh');
  await page.evaluate(()=>window.__releaseSelected()); await page.waitForFunction(()=>document.querySelector('.wb-commit-main')?.textContent?.includes('Commit all staged'));
  await page.evaluate(()=>window.__setRoot('C:/one')); await page.waitForFunction(()=>document.querySelector('[aria-label="Select src/staged.ts in staged"]')?.checked===true);
 }
 await changed.check(); await page.evaluate(()=>{window.__holdLegacy=false;window.__failLegacy=true;window.__failRefresh=true}); await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage selected files'}).click(); await page.getByRole('alert').waitFor();
 assert.doesNotMatch(await page.getByRole('alert').textContent(),/completed/i,'a failed mutation followed by failed refresh must never claim completion');
 assert.equal(await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage selected files'}).isDisabled(),false,'a same-scope failed stage must clear busy and retain the next action'); await page.evaluate(()=>{window.__failLegacy=false;window.__failRefresh=false}); await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage selected files'}).click(); await page.waitForFunction(()=>document.querySelector('[aria-label="Select src/change.ts in changes"]')?.checked===false);
 await changed.check(); await page.evaluate(()=>{window.__holdRefresh=true}); await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage selected files'}).click(); await page.getByText('Working…').waitFor();
 assert.equal(await page.locator('section[aria-label="Changes"]').getByRole('button',{name:'Stage all changes'}).isDisabled(),true,'a same-scope action stays locked until its refresh settles'); const requestsWhileBusy=await page.evaluate(()=>window.__requests.length); await page.getByRole('textbox',{name:'Commit message'}).press('Control+Enter'); await page.waitForTimeout(30); assert.equal(await page.evaluate(()=>window.__requests.length),requestsWhileBusy,'Ctrl+Enter must not bypass an in-flight action or refresh'); await page.evaluate(()=>window.__releaseRefresh()); await page.waitForFunction(()=>document.querySelector('section[aria-label="Changes"] button[aria-label="Stage all changes"]')?.disabled===false);
 for(const zh of [false,true])for(const [label,width] of [['narrow',420],['wide',900]])for(const theme of ['light','dark']){await page.evaluate(([nextZh,nextWidth,nextTheme])=>{window.__setView(nextZh,nextWidth);document.documentElement.dataset.theme=nextTheme},[zh,width,theme]);await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);const shot=join(out,`selected-${zh?'zh':'en'}-${label}-${theme}.png`);await page.screenshot({path:shot});report.screenshots.push(shot);}
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.__requests.map(([method])=>method))].sort()),['git.commit.selected','git.stage']);
 report.checks.push('per-group dual-status selection, selected-only stage, typed selected-commit snapshot/receipt, persistent post-commit and cleanup warnings, failed mutation plus failed-refresh copy, and selected/ordinary held scope-switch busy/error/refresh isolation; same-scope actions and Ctrl+Enter remain locked through a held refresh; Desktop 1 fixtures isolate profile/data/pipe and cover EN/ZH light/dark narrow/wide'); report.passed=true; console.log('PASS selected commit UI');
} catch(error) { report.errors.push(error instanceof Error?error.stack??error.message:String(error)); process.exitCode=1; } finally { await app?.close().catch(()=>undefined); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n'); process.exit(report.passed?0:1); }
