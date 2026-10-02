// Real Electron/components, synthetic state/RPC boundary. Never starts the product runtime or an Agent.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-session-attention-'));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectCatalog } from './renderer/src/components/ProjectCatalog';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';

const project = { id:'project', name:'ThreadTerm QA', path:'D:/qa/project', pinned:false, sortOrder:0, revision:0, git:{available:true} };
const plain = { ...project, id:'plain', name:'Plain directory', path:'D:/qa/plain', git:{available:false} };
const trees = [
 { id:'branch', projectId:'project', path:'D:/qa/project', branch:'feature/session-attention', isMain:true },
 { id:'other-branch', projectId:'project', path:'D:/qa/other', branch:'feature/independent', isMain:false },
];
const make = (id, day, state, extra={}) => ({
 id, title:id, projectId:project.id, worktreePath:project.path, provider:'codex', mode:'chat', status:state==='running'?'running':state==='awaiting_approval'?'waiting':'idle',
 createdAt:'2026-09-'+String(day).padStart(2,'0')+'T00:00:00Z', updatedAt:'2026-09-30T00:00:00Z',
 activity:{state,revision:1,turnId:'turn-'+id}, ...extra,
});
let sessions = [make('Idle newest',29,'idle'), make('Needs older',10,'awaiting_input'), make('Running older',9,'running'),
 make('Approval newest',28,'awaiting_approval'), make('Running newer',25,'running'), make('Idle oldest',1,'idle'),
 make('Terminal unknown',27,'unknown',{mode:'terminal',status:'running'}),
 make('Other branch',30,'awaiting_input',{worktreePath:'D:/qa/other'}),
 make('Plain idle',30,'idle',{projectId:plain.id,worktreePath:plain.path}),
 make('Plain needs',2,'awaiting_input',{projectId:plain.id,worktreePath:plain.path}),
];
let locale='en', theme='light', selected='Running newer';
const calls=[], listeners=new Set();
const root=createRoot(document.getElementById('root'));
const render=()=>{
 document.documentElement.lang=locale; document.documentElement.dataset.theme=theme;
 root.render(<I18nProvider locale={locale}><aside style={{width:300,padding:12}}><ProjectCatalog
 selectedProjectId="project" selectedWorktreePath={project.path} selectedSessionId={selected}
 sessions={[...sessions]} visibility={[]} onAll={()=>{}} onProject={()=>{}} onSession={id=>{selected=id;render();}}
 onChanged={render}/></aside><main style={{padding:32}}><h1>Session activity QA</h1><p>Isolated component fixture</p></main></I18nProvider>);
};
window.threadterm={
 onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},
 async request(method,params){
  if(method==='project.catalog.list')return [project,plain];
  if(method==='worktree.list')return params.projectId===project.id?trees:[];
  if(method==='session.attention.acknowledge'){
   calls.push({method,params});
   const session=sessions.find(s=>s.id===params.sessionId);
   if(session.activity.revision!==params.expectedRevision)throw Error('activity_revision_conflict');
   if(session.activity.state!=='awaiting_input')throw Error('activity_not_awaiting_input');
   session.activity={...session.activity,state:'idle',revision:session.activity.revision+1};
   render();return session;
  }
  throw Error('Unexpected fixture RPC '+method);
 }
};
window.qaSessionAttention={
 set(id,state){sessions=sessions.map(s=>s.id===id?{...s,activity:{...s.activity,state,revision:s.activity.revision+1},status:state==='running'?'running':state==='awaiting_approval'?'waiting':'idle'}:s);render();},
 configure(next){locale=next.locale??locale;theme=next.theme??theme;render();},
 calls(){return calls;},
 selected(){return selected;},
};
render();
`;

await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true,
  outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}aside{flex-shrink:0;background:var(--surface);border-right:1px solid var(--border)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);

let app, page;
const report={scratch, passed:false, checks:[], errors:[]};
try {
  app=await electron.launch({args:[join(scratch,'main.cjs')],timeout:20000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);
  await page.locator('.sess-row-wrap[data-session-id="Plain needs"]').waitFor();
  const branch=page.locator('.catalog-tree-group').first();
  const order=()=>branch.locator('.sess-row-wrap').evaluateAll(rows=>rows.map(row=>row.dataset.sessionId));
  assert.deepEqual(await order(),['Approval newest','Needs older','Running newer','Running older','Idle newest','Terminal unknown','Idle oldest']);
  const plain=page.locator('.proj-group').last();
  assert.deepEqual(await plain.locator('.sess-row-wrap').evaluateAll(rows=>rows.map(row=>row.dataset.sessionId)),['Plain needs','Plain idle']);
  report.checks.push('branch-local priorities, newest-first within groups, plain-directory parity');
  const selected=page.locator('.sess-row-wrap[data-session-id="Running newer"] .sess-row');
  assert.ok((await selected.getAttribute('class')).includes('active'));
  await page.evaluate(()=>window.qaSessionAttention.set('Running newer','awaiting_input'));
  await page.waitForFunction(()=>document.querySelector('[data-session-id="Running newer"]')?.getAttribute('data-activity')==='awaiting_input'||document.querySelector('[data-session-id="Running newer"] [data-activity="awaiting_input"]'));
  assert.deepEqual((await order()).slice(0,3),['Approval newest','Running newer','Needs older']);
  assert.ok((await selected.getAttribute('class')).includes('active'),'selected identity survives reorder');
  await selected.click();
  assert.equal((await page.evaluate(()=>window.qaSessionAttention.calls())).length,0,'viewing must not acknowledge');
  report.checks.push('completion reorders without changing selection; viewing does not acknowledge');

  const row=page.locator('.sess-row-wrap[data-session-id="Needs older"]');
  await row.hover();await row.locator('.row-more').click();
  const menu=page.getByRole('menu',{name:'Needs older',exact:true});
  await menu.waitFor();
  const handle=menu.getByRole('menuitem',{name:'Mark handled',exact:true});
  await handle.focus();
  await page.evaluate(()=>window.qaSessionAttention.set('Idle newest','awaiting_input'));
  await page.waitForTimeout(100);
  assert.equal(await handle.evaluate(el=>el===document.activeElement),true,'menu focus survives another row moving');
  const anchorBox=await row.locator('.row-more').boundingBox(),menuBox=await menu.boundingBox();
  assert.ok(anchorBox&&menuBox&&Math.abs(anchorBox.y-menuBox.y)<40,'menu remains attached to owning row');
  await handle.click();await menu.waitFor({state:'hidden'});
  const calls=await page.evaluate(()=>window.qaSessionAttention.calls());
  assert.equal(calls.length,1);assert.equal(calls[0].params.sessionId,'Needs older');assert.equal(calls[0].params.expectedRevision,1);
  assert.ok(calls[0].params.operationId);
  report.checks.push('menu identity/focus/geometry survive reorder; Mark handled carries revision and operation');
  const approval=page.locator('.sess-row-wrap[data-session-id="Approval newest"]');
  await approval.hover();await approval.locator('.row-more').click();
  assert.equal(await page.getByRole('menuitem',{name:'Mark handled',exact:true}).count(),0,'approval cannot be marked handled');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.qaSessionAttention.set('Running newer','running'));

  for(const locale of ['en','zh-CN'])for(const theme of ['light','dark'])for(const width of [1280,1440,1920]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(next=>window.qaSessionAttention.configure(next),{locale,theme});
   await page.waitForTimeout(80);
   const title=await approval.locator('.sess-row').getAttribute('title');
   assert.ok(title.includes(locale==='en'?'Awaiting approval':'待审批'),title);
   await page.screenshot({path:join(scratch,locale+'-'+theme+'-'+width+'.png')});
  }
  const animatedBefore=await page.locator('.project-catalog').evaluate(el=>el.getAnimations({subtree:true}).length);
  assert.ok(animatedBefore>0,'running/attention must visibly animate');
  const ring=page.locator('.session-attention-ring').first();
  const ringFrames=await ring.evaluate(el=>el.getAnimations().flatMap(animation=>animation.effect.getKeyframes()));
  assert.ok(ringFrames.some(frame=>String(frame.transform).includes('rotate')),'progress ring must rotate');
  const attentionRow=page.locator('.sess-row-wrap[data-session-id="Approval newest"]');
  const barBox=await attentionRow.locator('.session-attention-bar').boundingBox();
  const iconBox=await attentionRow.locator('.bico').boundingBox();
  assert.ok(barBox&&iconBox&&barBox.x+barBox.width<iconBox.x,'attention strip must sit left of the Agent icon');
  const rowBox=await attentionRow.boundingBox(),bellBox=await attentionRow.locator('.session-attention-icon').boundingBox();
  assert.ok(rowBox&&bellBox&&bellBox.y>=rowBox.y&&bellBox.y+bellBox.height<=rowBox.y+rowBox.height,'static attention icon must remain inside its own row');
  report.checks.push('rotating ring and attention strip on the left of retained Agent icon');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForTimeout(100);
  const animatedAfter=await page.locator('.project-catalog').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length);
  assert.equal(animatedAfter,0,'reduced motion must stop all state animations');
  await page.screenshot({path:join(scratch,'reduced-motion.png')});
  report.checks.push('bilingual tooltips, twelve theme/size screenshots, reduced-motion static indicators');
  report.passed=true;
}catch(error){report.errors.push(String(error.stack??error));await page?.screenshot({path:join(scratch,'failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await writeFile(join(scratch,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;}
