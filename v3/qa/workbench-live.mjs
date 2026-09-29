// Real Electron + isolated runtime QA for the Cursor-style workbench:
// side bar views, file CRUD, quick open, search, Source Control (hunk staging,
// commit, branches), history, blame, agent-change review/revert and send-to-agent.
// Isolated data/profile/pipe and a temporary Git repository; no provider or model calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,writeFile as write} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {_electron as electron} from '@playwright/test';

const out=join('qa','results','workbench-live',new Date().toISOString().replace(/[:.]/g,'-'));
const scratch=await mkdtemp(join(tmpdir(),'threadterm-workbench-'));
const project=join(scratch,'repo 工作区');
const pipe='\\\\.\\pipe\\threadterm-v3-workbench-'+randomUUID();
const runtimeBin=process.env.THREADTERM_V3_RUNTIME_BIN||resolve('runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtimeBin),`runtime binary missing: ${runtimeBin}`);
const env={...process.env,THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:pipe,THREADTERM_V3_RUNTIME:runtimeBin};
const report={startedAt:new Date().toISOString(),scratch,runtimeBin,checks:[],screenshots:[],notes:[]};
let app,page,settingsRevision=0;
const rpc=(method,params={})=>page.evaluate(([m,p])=>Promise.race([window.threadterm.request(m,p),new Promise((_,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+m)),45000))]),[method,params]);
const git=(args)=>new Promise((res,rej)=>{const p=spawn('git',['-c','core.quotepath=off',...args],{cwd:project,windowsHide:true});let o='',e='';p.stdout.on('data',b=>o+=b);p.stderr.on('data',b=>e+=b);p.once('exit',code=>code===0?res(o):rej(Error('git '+args.join(' ')+': '+e)));});
const panelShot=async name=>{await page.waitForTimeout(250);await page.locator('.wb-panel').screenshot({path:join(out,name)});report.screenshots.push(name);};
const shot=async name=>{await page.waitForTimeout(200);await page.screenshot({path:join(out,name)});report.screenshots.push(name);};
const until=async(check,message,timeout=15000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{if(await check())return;}catch(error){last=error;}await new Promise(r=>setTimeout(r,150));}throw new Error(message+(last?`: ${last.message}`:''));};
const setSettings=async patch=>{const value=await rpc('settings.update',{patch,expectedRevision:settingsRevision,operationId:randomUUID()});settingsRevision=value.revision;};
const size=width=>app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,900),width);
const rail=name=>page.locator('.wb-switcher').getByRole('button',{name,exact:true});
const openView=async name=>{if(await rail(name).getAttribute('aria-pressed')!=='true')await rail(name).click();};
const blurTerminal=()=>page.locator('.wb-panel-head').click();

try {
 await mkdir(out,{recursive:true});await mkdir(join(project,'src'),{recursive:true});await mkdir(join(project,'notes'),{recursive:true});
 await mkdir(join(scratch,'data'),{recursive:true});await mkdir(join(scratch,'profile'),{recursive:true});
 await git(['init','-q','-b','main']);await git(['config','user.email','qa@example.test']);await git(['config','user.name','QA']);await git(['config','core.autocrlf','false']);
 const app10=Array.from({length:12},(_,i)=>`export const line${i+1} = ${i+1};`).join('\n')+'\n';
 await writeFile(join(project,'src','app.ts'),app10);
 await writeFile(join(project,'README.md'),'# Workbench QA\n\nSearch for the needle here.\n');
 await writeFile(join(project,'notes','todo.md'),'- review agent changes\n');
 await git(['add','.']);await git(['commit','-qm','initial commit']);
 await writeFile(join(project,'src','app.ts'),app10.replace('line2 = 2','line2 = 20'));await git(['commit','-qam','second commit']);

 app=await electron.launch({args:[resolve('.')],env,timeout:60000});
 page=await app.firstWindow({timeout:30000});page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>!!window.threadterm);await page.locator('.app-shell').waitFor();
 await setSettings({language:'en',theme:'light'});
 await size(1280);
 const added=await rpc('project.add',{path:project,name:'Workbench QA',operationId:randomUUID()});
 const session=await rpc('session.create',{projectId:added.id,cwd:project,provider:'shell',mode:'terminal',title:'Workbench shell',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>!!window.threadterm);await page.locator('.app-shell').waitFor();
 await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.xterm').first().waitFor();
 await page.locator('.wb-tabrow .wb-switcher').waitFor();
 // Terminal fit: the host is content-box and the rendered xterm screen fits inside its content box
 // (a border-box host let FitAddon count the padding and clipped the last column/row).
 await page.waitForFunction(()=>document.querySelector('.terminal-host .xterm-screen')?.getBoundingClientRect().width>0);
 const fit=await page.evaluate(()=>{const host=document.querySelector('.terminal-host');const style=getComputedStyle(host);const screen=host.querySelector('.xterm-screen').getBoundingClientRect();return{box:style.boxSizing,screenW:screen.width,screenH:screen.height,contentW:host.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),contentH:host.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)};});
 report.notes.push(`terminal fit ${JSON.stringify(fit)}`);
 assert.equal(fit.box,'content-box','terminal host must be content-box');
 assert.ok(fit.screenW<=fit.contentW+0.5&&fit.screenH<=fit.contentH+0.5,`xterm screen must fit the host content box: ${JSON.stringify(fit)}`);
 const viewportBg=await page.evaluate(()=>getComputedStyle(document.querySelector('.terminal-host .xterm-viewport')).backgroundColor);
 assert.equal(viewportBg,'rgba(0, 0, 0, 0)','xterm viewport must be transparent (its #000 showed as a strip below the last row)');
 report.checks.push('terminal host is content-box, the fitted xterm screen fits inside it and the viewport paints no black strip');
 report.checks.push('session workspace shows the workbench view switcher in the tab bar row beside a live shell terminal');

 // A session opens as just a session: no side panel until a view is chosen; the panel has a close button.
 assert.equal(await page.locator('.wb-sidebar').count(),0,'side panel must start closed when a session opens');
 await openView('Files');await page.locator('.wb-sidebar').waitFor();
 await page.locator('.wb-panel-close').click();await page.locator('.wb-sidebar').waitFor({state:'detached'});
 assert.equal(await rail('Files').getAttribute('aria-pressed'),'false');
 report.checks.push('side panel starts closed on session open and closes with its close button');

 // ---- Files ----
 await openView('Files');
 await page.locator('.wb-tree [data-path="src"]').waitFor();
 await page.locator('.wb-tree [data-path="src"]').click();
 await page.locator('.wb-tree [data-path="src/app.ts"]').waitFor();
 await shot('light-1280-files.png');
 await page.getByRole('button',{name:'New file',exact:true}).click();
 // With a folder selected, New file creates inside it (VS Code semantics); nested names make folders.
 await page.getByRole('textbox',{name:'New file name'}).fill('nested/qa-new.ts');
 await page.getByRole('textbox',{name:'New file name'}).press('Enter');
 await until(()=>existsSync(join(project,'src','nested','qa-new.ts')),'new nested file was not created on disk');
 await page.locator('.wb-tree [data-path="src/nested/qa-new.ts"]').waitFor();
 await page.locator('[role=tab]',{hasText:'qa-new.ts'}).waitFor();
 report.checks.push('New file inside the selected folder with a nested name creates folders, reveals the file and opens it as a top-level tab');
 await page.locator('.wb-tree [data-path="src/nested/qa-new.ts"]').click();
 await page.locator('.wb-tree [data-path="src/nested/qa-new.ts"]').press('F2');
 await page.getByRole('textbox',{name:'New name'}).waitFor();await shot('light-1280-rename.png');
 await page.getByRole('textbox',{name:'New name'}).fill('qa-renamed.ts');
 await page.getByRole('textbox',{name:'New name'}).press('Enter');
 await until(()=>existsSync(join(project,'src','nested','qa-renamed.ts'))&&!existsSync(join(project,'src','nested','qa-new.ts')),'rename did not happen on disk');
 await page.locator('[role=tab]',{hasText:'qa-renamed.ts'}).waitFor();
 report.checks.push('F2 rename moves the file on disk and the open tab follows the new path');
 const badName=async()=>{await page.getByRole('button',{name:'New file',exact:true}).click();const box=page.getByRole('textbox',{name:'New file name'});await box.fill('CON');await box.press('Enter');await page.locator('.wb-inline-error').waitFor();await box.press('Escape');};
 await badName();
 report.checks.push('reserved/invalid names are refused inline without touching the disk');
 const recycleName=`threadterm-qa-recycle-${randomUUID().slice(0,8)}.txt`;
 await writeFile(join(project,recycleName),'temporary QA file\n');
 await page.getByRole('button',{name:'Refresh',exact:true}).first().click();
 await page.locator(`.wb-tree [data-path="${recycleName}"]`).click({button:'right'});
 await page.getByRole('menuitem',{name:/Delete/}).click();
 await page.getByRole('button',{name:'Move to Recycle Bin',exact:true}).click();
 await until(()=>!existsSync(join(project,recycleName)),'delete did not remove the file');
 report.checks.push('Delete moves a file to the Recycle Bin after confirmation');
 report.notes.push(`Recycle Bin now contains ${recycleName} from this QA run.`);

 // ---- Quick open ----
 await blurTerminal();
 await page.keyboard.press('Control+P');
 await page.getByRole('dialog',{name:'Go to file'}).waitFor();
 await page.keyboard.type('todo');
 await page.locator('.wb-quick-open .cmd-row.active').waitFor();
 await shot('light-1280-quick-open.png');
 await page.keyboard.press('Enter');
 await page.locator('[role=tab]',{hasText:'todo.md'}).waitFor();
 report.checks.push('Ctrl+P fuzzy-finds files outside the terminal and opens the match');
 // Inside the terminal Ctrl+P belongs to the shell.
 await page.locator('[role=tab]',{hasText:'Workbench shell'}).click();
 await page.locator('.xterm:visible').first().click();
 await page.keyboard.press('Control+P');
 await page.waitForTimeout(300);
 assert.equal(await page.getByRole('dialog',{name:'Go to file'}).count(),0,'Ctrl+P inside the terminal must not open quick open');
 report.checks.push('Ctrl+P is left to the terminal when an xterm has focus');

 // ---- Search ----
 await blurTerminal();
 await page.keyboard.press('Control+Shift+F');
 await page.getByRole('textbox',{name:'Search in files'}).fill('needle');
 await page.locator('.wb-result-line').first().waitFor();
 await shot('light-1280-search.png');
 await page.locator('.wb-result-line').first().click();
 await page.locator('[role=tab]',{hasText:'README.md'}).waitFor();
 report.checks.push('Ctrl+Shift+F searches file contents and opens the hit');

 // ---- Source Control: hunk staging, commit, branches ----
 await writeFile(join(project,'src','app.ts'),app10.replace('line2 = 2','line2 = 20').replace('line3 = 3','line3 = 300').replace('line11 = 11','line11 = 1100'));
 await openView('Source Control');
 await page.locator('.wb-panel-head').getByRole('button',{name:'Refresh',exact:true}).click();
 const appRow=page.locator('.wb-change-group[aria-label="Changes"] .wb-change-open',{hasText:'app.ts'});
 await appRow.waitFor();
 await appRow.click();
 await page.locator('.tt-diff-shell:visible .wb-hunk-nav').waitFor();
 await page.locator('[role=tab]',{hasText:'app.ts · changes'}).waitFor();
 await until(async()=>(await page.locator('.tt-diff-shell:visible .wb-hunk-count').textContent())==='1/2','expected two hunks');
 await shot('light-1280-scm-diff.png');
 await page.locator('.tt-diff-shell:visible').getByRole('button',{name:'Stage hunk',exact:true}).click();
 await until(async()=>(await git(['diff','--cached'])).includes('line3 = 300'),'first hunk was not staged');
 const cached=await git(['diff','--cached']),working=await git(['diff']);
 assert.ok(!cached.includes('line11 = 1100')&&working.includes('line11 = 1100'),'only the selected hunk may be staged');
 report.checks.push('Stage hunk writes exactly one hunk to the index (verified with git diff --cached / git diff)');
 await page.locator('.wb-change-group[aria-label="Staged changes"]').waitFor();
 await page.getByRole('textbox',{name:'Commit message'}).fill('QA: stage one hunk');
 await page.locator('.wb-commit').getByRole('button',{name:'Commit',exact:true}).click();
 await until(async()=>(await git(['log','-1','--format=%s'])).trim()==='QA: stage one hunk','commit did not happen');
 assert.ok((await git(['diff'])).includes('line11 = 1100'),'unstaged hunk remains in the working tree');
 report.checks.push('Commit records only staged content; the other hunk stays unstaged');
 await page.locator('.wb-branch-chip').click();
 await page.getByRole('textbox',{name:'Branch name'}).fill('qa/feature');
 await page.getByRole('menuitem',{name:/Create new branch/}).click();
 await page.getByRole('textbox',{name:'Branch name'}).press('Enter');
 await until(async()=>(await git(['branch','--show-current'])).trim()==='qa/feature','branch was not created/switched');
 await page.locator('.wb-branch-chip').click();
 await page.getByRole('menuitem',{name:'main'}).click();
 await until(async()=>(await git(['branch','--show-current'])).trim()==='main','did not switch back to main');
 report.checks.push('Branch picker creates, switches and returns between branches');
 await shot('light-1280-scm.png');
 await panelShot('panel-light-scm.png');

 // ---- History and blame ----
 // A commit reachable only from another branch that forks from HEAD~1 (built without touching the worktree or HEAD).
 const sideTree=(await git(['rev-parse','HEAD^{tree}'])).trim();
 const sideCommit=(await git(['commit-tree',sideTree,'-p','HEAD~1','-m','QA: side branch only'])).trim();
 await git(['branch','qa/side',sideCommit]);
 await page.locator('.wb-panel-head').getByRole('button',{name:'History',exact:true}).click();
 await page.locator('.wb-history .wb-commit-row').nth(2).waitFor();
 assert.ok(await page.locator('.wb-history .wb-commit-row .wb-graph').count()>=3,'repository history must draw the commit graph');
 assert.equal(await page.locator('.wb-history-scope [role=radio][aria-checked=true]').textContent(),'Current branch');
 assert.equal(await page.locator('.wb-history .wb-commit-row',{hasText:'QA: side branch only'}).count(),0,'current-branch history must exclude other branches');
 await page.locator('.wb-history .wb-commit-row',{hasText:'second commit'}).click();
 await page.locator('.wb-history-diff .merge-editor').waitFor();
 await shot('light-1280-history.png');
 report.checks.push('History lists commits and shows a selected commit file diff');
 await page.locator('.wb-history-scope').getByRole('radio',{name:'All branches',exact:true}).click();
 await page.locator('.wb-history .wb-commit-row',{hasText:'QA: side branch only'}).waitFor();
 const graph=await page.evaluate(()=>({lanes:Math.max(...[...document.querySelectorAll('.wb-history .wb-graph')].map(svg=>Number(svg.getAttribute('width')))),head:document.querySelectorAll('.wb-history .wb-graph circle.head').length,headRef:[...document.querySelectorAll('.wb-history .wb-ref.head')].map(node=>node.textContent),rowHeights:[...new Set([...document.querySelectorAll('.wb-history .wb-commit-row')].map(row=>Math.round(row.getBoundingClientRect().height)))]}));
 report.notes.push(`history graph ${JSON.stringify(graph)}`);
 assert.ok(graph.lanes>=32,`the side branch must get its own lane: ${JSON.stringify(graph)}`);
 assert.equal(graph.head,1,'exactly one HEAD node');
 assert.deepEqual(graph.headRef,['main']);
 assert.deepEqual(graph.rowHeights,[44],'graph rows share one height so lanes join');
 await shot('light-1280-history-graph.png');
 await page.locator('.wb-history-scope').getByRole('radio',{name:'Current branch',exact:true}).click();
 await until(async()=>!(await page.locator('.wb-history .wb-commit-row',{hasText:'QA: side branch only'}).count()),'Current branch must drop the side-branch commit again');
 await page.locator('.wb-history-scope').getByRole('radio',{name:'All branches',exact:true}).click();
 await page.locator('.wb-history .wb-commit-row',{hasText:'QA: side branch only'}).waitFor();
 report.checks.push('History draws a commit graph; All branches adds a side-branch commit in its own lane, Current branch removes it');
 await blurTerminal();
 await page.keyboard.press('Control+P');await page.keyboard.type('app.ts');await page.keyboard.press('Enter');
 await page.locator('.pane-tab-surface:visible .tt-editor-shell .cm-content').waitFor();
 await page.locator('.pane-tab-surface:visible').getByRole('button',{name:'Blame',exact:true}).click();
 // [data-commit] skips CodeMirror's hidden width spacer, which shares the entry class.
 await page.locator('.pane-tab-surface:visible .cm-blame-gutter .cm-blame-entry[data-commit]').first().waitFor();
 await page.locator('.pane-tab-surface:visible .cm-git-gutter .cm-git-marker').first().waitFor();
 await shot('light-1280-blame.png');
 report.checks.push('Editor shows blame and index change markers for the open file');
 // Sizing: the side panel header rule lines up with the file toolbar rule in the neighbouring card,
 // and the tab row keeps its height although the strip overflows (no scrollbar row).
 await openView('Files');
 const edges=await page.evaluate(()=>{const head=document.querySelector('.wb-panel-head').getBoundingClientRect();const bar=document.querySelector('.pane-tab-surface:not([hidden]) .file-view-tabs')?.getBoundingClientRect();const row=document.querySelector('.wb-tabrow').getBoundingClientRect();const tabs=document.querySelector('.wb-tabrow .workspace-tabs');return{head:head.bottom,bar:bar?.bottom,row:row.height,overflowing:tabs.scrollWidth>tabs.clientWidth};});
 report.notes.push(`panel head bottom ${edges.head}, file toolbar bottom ${edges.bar}, tab row ${edges.row}px, strip overflowing ${edges.overflowing}`);
 assert.ok(edges.bar!==undefined&&Math.abs(edges.head-edges.bar)<=0.5,`panel header and file toolbar rules must align: ${JSON.stringify(edges)}`);
 assert.ok(edges.row<=44,`tab row must keep its height: ${JSON.stringify(edges)}`);
 report.checks.push('side panel header rule aligns with the file toolbar rule; tab row height stays fixed');
 await until(()=>page.evaluate(()=>{const strip=document.querySelector('.wb-tabrow .workspace-tabs');const box=strip.getBoundingClientRect(),tab=strip.querySelector('.workspace-tab.active').getBoundingClientRect();return tab.left>=box.left-0.5&&tab.right<=box.right+0.5&&strip.classList.contains('fade-start');}),'active tab must stay fully visible after the strip narrows, with a fade on the hidden edge',3000);
 report.checks.push('active tab stays fully visible when the side panel narrows the tab strip; hidden overflow edges fade');

 // ---- Send to agent ----
 await page.locator('.pane-tab-surface:visible .cm-content').click();
 await page.keyboard.press('Control+L');
 await until(async()=>(await page.locator('.xterm-rows').first().textContent()).includes('src/app.ts:'),'reference did not reach the terminal input');
 report.checks.push('Ctrl+L inserts a one-line src/app.ts:<line> reference into the shell input without pressing Enter');

 // ---- Agent changes: checkpoint → edit → review → revert ----
 await openView('Agent changes');
 await page.locator('.wb-review').getByRole('button',{name:'Checkpoint',exact:true}).click();
 await page.locator('.wb-checkpoint').first().waitFor();
 const before=await readFile(join(project,'notes','todo.md'),'utf8');
 await write(join(project,'notes','todo.md'),before+'- edited by an agent\n');
 const reviewRow=page.locator('.wb-review .wb-change-open',{hasText:'todo.md'}).first();
 await until(()=>reviewRow.isVisible(),'review list did not pick up the edit',20000);
 await reviewRow.click();
 await page.locator('.wb-review-diff .cm-mergeView .cm-merge-revert button').first().waitFor();
 const merge=await page.locator('.wb-review-diff .merge-editor').evaluate(host=>{const view=host.querySelector('.cm-mergeView').getBoundingClientRect();const revert=host.querySelector('.cm-merge-revert button');return{host:host.getBoundingClientRect().width,view:view.width,revertText:revert.textContent,revertSvg:!!revert.querySelector('svg'),font:getComputedStyle(host.querySelector('.cm-scroller')).fontFamily};});
 assert.ok(merge.view>=merge.host-1,`merge view must fill the diff pane: ${JSON.stringify(merge)}`);
 assert.ok(merge.revertSvg&&!merge.revertText.trim(),`merge revert control must be an SVG icon: ${JSON.stringify(merge)}`);
 // CodeMirror's base theme sets .cm-scroller to generic monospace (NSimSun on Chinese Windows); diffs use the app mono font.
 assert.match(merge.font,/Cascadia Code/,`merge editors must use the app mono font: ${JSON.stringify(merge)}`);
 await shot('light-1280-review.png');
 report.checks.push('review diff fills its pane, uses the app mono font and SVG revert controls');
 await page.locator('.wb-review-diff').getByRole('button',{name:'Revert file…',exact:true}).click();
 await page.getByRole('button',{name:'Revert',exact:true}).click();
 await until(async()=>(await readFile(join(project,'notes','todo.md'),'utf8'))===before,'revert did not restore the checkpoint content');
 // The side bar list must follow the revert at once, not on its 5 s poll.
 await until(async()=>!(await reviewRow.isVisible()),'Agent changes list still shows the reverted file',3000);
 report.checks.push('Checkpoint → external edit → review diff → revert restores the file and clears it from the Agent changes list immediately');

 // ---- Dark theme and wide layout ----
 await setSettings({theme:'dark'});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await size(1920);
 await shot('dark-1920-review.png');
 await page.locator('.workspace-tab',{hasText:'Git history'}).locator('.workspace-tab-select').click();
 await page.locator('.wb-history .wb-commit-row',{hasText:'QA: side branch only'}).waitFor();
 await shot('dark-1920-history-graph.png');
 await openView('Source Control');await shot('dark-1920-scm.png');await panelShot('panel-dark-scm.png');
 await openView('Files');await shot('dark-1920-files.png');await panelShot('panel-dark-files.png');
 await size(1280);await shot('dark-1280-files.png');
 await setSettings({theme:'light'});await size(1920);await openView('Search');await shot('light-1920-search.png');
 report.checks.push('light/dark captures at 1280 and 1920');
 // Narrowest and widest panel, then Chinese labels (longer/denser) at 1280.
 const separator=page.getByRole('separator',{name:'Resize side bar'});
 await separator.focus();for(let i=0;i<24;i++)await page.keyboard.press('ArrowLeft');
 await size(1280);
 for(const view of ['Files','Search','Source Control','Agent changes']){
  await openView(view);
  const overflow=await page.evaluate(()=>{const panel=document.querySelector('.wb-panel');const bad=[...panel.querySelectorAll('*')].filter(node=>{const r=node.getBoundingClientRect();const p=panel.getBoundingClientRect();return r.width>0&&(r.right>p.right+1||r.left<p.left-1)&&getComputedStyle(node).position!=='fixed';}).map(node=>node.className||node.tagName);return{width:panel.getBoundingClientRect().width,bad:bad.slice(0,5)};});
  assert.deepEqual(overflow.bad,[],`${view} must not overflow the ${overflow.width}px panel`);
  await shot(`light-1280-min-${view.toLowerCase().replace(/ /g,'-')}.png`);
 }
 report.checks.push('every side bar view fits the minimum panel width without horizontal overflow');
 await separator.focus();for(let i=0;i<30;i++)await page.keyboard.press('ArrowRight');
 await openView('Source Control');await shot('light-1280-max-scm.png');
 await setSettings({language:'zh-CN'});
 await page.locator('.wb-panel-head strong',{hasText:'源代码管理'}).waitFor();
 await shot('zh-1280-scm.png');
 await page.locator('.wb-switcher button').nth(3).click();await page.locator('.wb-panel-head strong',{hasText:'Agent 改动'}).waitFor();await shot('zh-1280-changes.png');
 await page.locator('.wb-switcher button').nth(0).click();await shot('zh-1280-files.png');
 await setSettings({language:'en'});
 report.checks.push('Chinese captures of Files, Source Control and Agent changes');

 // ---- Opening the session again shows just the session (plus files with unsaved edits) ----
 await page.locator('.workspace-tab',{hasText:/^app\.ts$/}).locator('.workspace-tab-select').click();
 const appEditor=page.locator('.pane-tab-surface:visible .tt-editor-shell .cm-content');
 await appEditor.click();await page.keyboard.press('Control+End');await page.keyboard.type('// unsaved QA edit');
 await until(async()=>(await rpc('draft.list',{projectId:added.id,worktreePath:session.worktreePath??added.path})).some(draft=>draft.path==='src/app.ts'),'the unsaved edit did not reach the draft store',15000);
 const beforeTabs=await page.locator('.wb-tabrow .workspace-tab').allTextContents();
 await page.reload();await page.waitForFunction(()=>!!window.threadterm);await page.locator('.app-shell').waitFor();
 await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await page.locator('.xterm').first().waitFor();
 await until(async()=>(await page.locator('.wb-tabrow .workspace-tab').allTextContents()).some(label=>label.includes('app.ts')),'the tab with unsaved edits must come back');
 const afterTabs=await page.locator('.wb-tabrow .workspace-tab').allTextContents();
 report.notes.push(`tabs before reopen ${JSON.stringify(beforeTabs)}, after ${JSON.stringify(afterTabs)}`);
 assert.deepEqual(afterTabs.map(label=>label.trim()),['Workbench shell','app.ts'],'only the session and the file with unsaved edits reopen');
 assert.equal(await page.locator('.wb-sidebar').count(),0,'side panel stays closed on reopen');
 await shot('light-1280-reopened.png');
 // The restored tab opens with the stored draft; closing it then asks before dropping the edit.
 await page.locator('.workspace-tab',{hasText:/^app\.ts$/}).locator('.workspace-tab-select').click();
 await until(async()=>(await page.locator('.pane-tab-surface:visible .tt-editor-shell .cm-content').textContent()).includes('unsaved QA edit'),'the reopened tab must show the unsaved edit');
 await page.getByRole('button',{name:'Close tab src/app.ts',exact:true}).click();
 await page.getByRole('button',{name:'Discard changes',exact:true}).click();
 await until(async()=>(await page.locator('.wb-tabrow .workspace-tab').count())===1,'discarding the unsaved tab must leave just the session');
 report.checks.push('Opening the session again shows just the session and the one file with unsaved edits; other tabs and the panel stay closed');

 // ---- Closing the only view in a pane closes the pane ----
 await size(1920);
 await openView('Source Control');
 await page.locator('.wb-panel-head').getByRole('button',{name:'History',exact:true}).click();
 await page.locator('.wb-history .wb-commit-row').first().waitFor();
 assert.equal(await page.locator('[data-pane-id]').count(),2,'history opens in its own pane beside the session at 1920px');
 await page.getByRole('button',{name:'Close tab Git history',exact:true}).click();
 await until(async()=>(await page.locator('[data-pane-id]').count())===1,'closing the only view in a pane must close the pane');
 assert.equal(await page.locator('.pane-empty').count(),0,'no empty pane is left behind');
 report.checks.push('closing the last view in a pane closes that pane (no empty pane left behind)');
 await size(1280);

 // ---- Back returns to the branch home page, not All terminals ----
 assert.equal(await page.locator('.ws-back').getAttribute('aria-label'),'Back to main');
 await page.locator('.ws-back').click();
 await page.locator('h1.page-title',{hasText:/^main$/}).waitFor();
 assert.equal(await page.locator('.tree-row.active').count(),1,'the branch row is selected in the sidebar after Back');
 report.checks.push('Back from a session opens its branch home page and selects the branch in the sidebar');

 assert.deepEqual(errors,[],'renderer page errors');
 report.passed=true;
} catch(error) {
 report.passed=false;report.error=error instanceof Error?error.stack??error.message:String(error);
 if(page)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});
} finally {
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
 // The runtime outlives the window by design; stop the isolated one so it does not hold the pipes open.
 if(page)await rpc('runtime.shutdown',{operationId:randomUUID()}).catch(()=>{});
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 console.log(JSON.stringify({passed:report.passed,out,checks:report.checks.length,error:report.error?.split('\n').slice(0,3).join(' | ')},null,1));
 if(!report.passed)process.exitCode=1;
}
