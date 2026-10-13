// Isolated production ChatView regression for tool-drawer inspection and
// transcript follow.  It bundles renderer source with a deterministic bridge:
// no production main/preload, runtime, provider, account, model, or user data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { electron } from './lib/desktop1.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-tool-inspection-'));
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg >= 0 ? process.argv[outArg + 1] : join(root, 'qa/results/chat-tool-inspection'));
const privatePaths = Object.fromEntries(['fixture','renderer','profiles','home','appdata','localappdata','data','user-data'].map(name => [name, join(scratch, name)]));
const pipe = `\\\\.\\pipe\\tt-chat-tool-inspection-${randomUUID()}`;
const report = { passed: false, baseline: {}, checks: [], screenshots: [], errors: [] };
const baselineOnly = process.argv.includes('--baseline');
const providers = ['pi','codex','claude','kimi','gemini','grok','opencode','plugin-unknown'];
let app, page, child;
const frozenSources = new Map();
const check = label => { report.checks.push(label); console.log(`PASS ${label}`); };

const entry = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ChatView} from '${join(root, 'renderer/src/components/ChatView.tsx').replaceAll('\\','/')}';
import {I18nProvider} from '${join(root, 'renderer/src/i18n.tsx').replaceAll('\\','/')}';
import {SessionSurfaceContext} from '${join(root, 'renderer/src/components/SessionSurfaceContext.tsx').replaceAll('\\','/')}';
import '${join(root, 'renderer/src/styles.css').replaceAll('\\','/')}';
const t=text=>({type:'text',text});
const tool=(id,name,status,data,text)=>({type:'tool',toolId:id,toolName:name,status,data,text});
const row=(id,parts,extra={})=>({id,role:'assistant',turnId:'turn-inspect',createdAt:id,parts,...extra});
const providerNames=['pi','codex','claude','kimi','gemini','grok','opencode','plugin-unknown'];
const common=(provider)=>{
 const body=[]; for(let i=0;i<24;i++) body.push(row('context-'+i,[t('Transcript context '+i+' — scrolling establishes a real inspectable viewport.') ]));
 body.push({id:'user',role:'user',turnId:'turn-inspect',createdAt:'user',parts:[t('Inspect all provider tools without losing my reading position.')]});
 body.push(row('pi-command',[tool('pi-command','bash','completed',{type:'tool_execution_update',toolCallId:'pi-command',toolName:'bash',args:{command:'git status --short'},partialResult:{content:[{type:'text',text:' M renderer/src/components/ChatView.tsx\n M renderer/src/components/ToolActivity.tsx'}]},result:{content:[{type:'text',text:' M renderer/src/components/ChatView.tsx\n M renderer/src/components/ToolActivity.tsx'}]}},'git status')]));
 body.push(row('codex-command',[tool('codex-command','commandExecution','completed',{command:'npm run typecheck',aggregatedOutput:'Typecheck completed successfully\\nextra output that must remain inspectable'},'typecheck')]));
 body.push(row('claude-command',[tool('claude-command','Bash','completed',{input:{command:'git diff --stat'},output:' renderer/src/components/ChatView.tsx | 42 +++++++++++++++++'},'git diff')]));
 body.push(row('kimi-command',[tool('kimi-command','execute_command','completed',{arguments:{command:'dir'},result:{content:[{type:'text',text:'README.md\\nrenderer\\nruntime'}]}},'dir')]));
 body.push(row('gemini-read',[tool('gemini-read','read_file','completed',{path:'renderer/src/components/ChatView.tsx',content:'export function ChatView() { /* source retained */ }'},'read')]));
 body.push(row('grok-search',[tool('grok-search','Search','completed',{query:'chat follow',output:'renderer/src/components/ChatView.tsx: follow state'},'search')]));
 body.push(row('opencode-browser',[tool('opencode-browser','browser_navigate','completed',{arguments:{url:'https://example.test/tool'},result:{content:[{type:'text',text:'Opened example test tool page'}]}},'browser')]));
 body.push(row('plugin-tool',[tool('plugin-tool','plugin.custom_tool','completed',{arguments:{query:'plugin evidence'},result:{content:[{type:'text',text:'Plugin fixture result content'}]}},'plugin')]));
 body.push(row('approval',[{type:'approval',approvalId:'inspect-approval',status:'pending',data:{}}]));
 body.push(row('question',[{type:'approval',approvalId:'inspect-question',status:'pending',data:{interaction:'question',answerable:true,form:{kind:'questions',questions:[{id:'q',header:'Inspection',question:'Continue?',options:[{label:'Continue'}],multiSelect:false,allowOther:false,secret:false}]}}}]));
 body.push(row('error',[{type:'error',text:'A provider error remains visible outside the tool drawer.'}]));
 body.push(row('final',[t('Inspection response remains visible after the drawer.')],{elapsedMs:2200})); return body;
};
const inspection=()=>{const body=[];for(let i=0;i<36;i++)body.push(row('inspect-context-'+i,[t('Inspection context '+i)]));body.push({id:'inspect-user',role:'user',turnId:'turn-inspect',createdAt:'inspect-user',parts:[t('Inspect the running tool.')]});const output=Array.from({length:180},(_,i)=>'live output line '+i).join('\n');body.push(row('inspect-live',[tool('inspect-live','bash','running',{type:'tool_execution_update',toolCallId:'inspect-live',toolName:'bash',args:{command:'npm run very-long-inspection'},partialResult:{content:[{type:'text',text:output}]},result:{content:[{type:'text',text:output}]}},output)]));return body;};
const sessions=new Map(); let active='inspect-codex', seq=0, snapshotDelay=0, childRevision=1; const listeners=new Set();
window.threadterm={onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},request:async (method,params)=>{
 if(method==='chat.snapshot'){const id=params.sessionId;await new Promise(resolve=>setTimeout(resolve,snapshotDelay));window.__toolInspection.lastHydrated=id;return {items:sessions.get(id)||[],revision:1};}
 if(method==='chat.subagent.read'){window.__toolInspection.lastChildRead=childRevision;return {items:inspection(),rev:childRevision,source:'native',truncated:false};}
 if(method==='chat.draft.read')return{text:'',revision:0}; if(method==='chat.queue.read')return{sessionId:active,paused:false,items:[]}; if(method==='chat.options')return{options:[],commands:[]}; if(method==='chat.feedback.read')return{notes:[]}; throw Error('Unexpected deterministic bridge request: '+method);
}};
const emit=item=>listeners.forEach(fn=>fn({event:'chat.item',seq:++seq,data:{sessionId:active,item}}));
const root=createRoot(document.getElementById('root')); let locale='en';
window.__toolInspection={render(provider='codex',nextLocale='en'){active='inspect-'+provider;locale=nextLocale;sessions.set(active,common(provider));root.render(<I18nProvider locale={locale}><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:active,provider,mode:'chat',status:'waiting',readOnly:true,title:'Tool inspection QA',createdAt:'now',updatedAt:'now'}}/></SessionSurfaceContext.Provider></I18nProvider>)},inspect(){active='inspection-last';sessions.set(active,inspection());root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:active,provider:'pi',mode:'chat',status:'waiting',readOnly:true,title:'Inspection QA',createdAt:'now',updatedAt:'now'}}/></SessionSurfaceContext.Provider></I18nProvider>)},appendOutput(){emit(row('plugin-tool',[tool('plugin-tool','plugin.custom_tool','completed',{arguments:{query:'plugin evidence'},result:{content:[{type:'text',text:'Plugin fixture output update must not move the reader'}]}},'plugin')]))},session(provider){this.render(provider,locale)}};
document.documentElement.dataset.theme='light'; window.__toolInspection.render();
window.__toolInspection.snapshotDelay=value=>{snapshotDelay=value;};
window.__toolInspection.nested=()=>{
 active='nested-inspection'; childRevision=1;
 const card=row('nested-card',[{type:'subagent',data:{key:'nested-child',provider:'pi',status:'running',transcript:'native',name:'Nested inspection',rev:childRevision}}]);
 sessions.set(active,[...inspection().filter(item=>item.role==='user'),card]);
 root.render(<I18nProvider locale="en"><SessionSurfaceContext.Provider value={{primaryHost:null,menuHost:null,focused:true,openFile:()=>{}}}><ChatView session={{id:active,provider:'pi',mode:'chat',status:'running',readOnly:true,title:'Nested QA',createdAt:'now',updatedAt:'now'}}/></SessionSurfaceContext.Provider></I18nProvider>);
};
window.__toolInspection.updateChild=()=>{childRevision++;emit(row('nested-card',[{type:'subagent',data:{key:'nested-child',provider:'pi',status:'running',transcript:'native',name:'Nested inspection',rev:childRevision}}]));};
`;

function env() {
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  result.Path = [dirname(process.execPath), join(systemRoot, 'System32')].join(';');
  Object.assign(result, { HOME: privatePaths.home, USERPROFILE: privatePaths.home, HOMEDRIVE: privatePaths.home.slice(0, 2), HOMEPATH: privatePaths.home.slice(2), CODEX_HOME: join(privatePaths.home, '.codex'), APPDATA: privatePaths.appdata, LOCALAPPDATA: privatePaths.localappdata, THREADTERM_V3_DATA: privatePaths.data, THREADTERM_V3_USER_DATA: privatePaths['user-data'], THREADTERM_V3_PIPE: pipe, TT_PARITY_PROFILE: privatePaths.profiles, TT_QA_DESKTOP: '1' });
  return result;
}
async function shot(name) { const path = join(out, name); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(name); }
async function setSize(width) { await page.setViewportSize({ width, height:width===390?844:900 }); await page.waitForFunction(value => innerWidth === value, width); }
async function drawer() { const value = page.locator('.chat-tool-activity').first(); await value.waitFor(); return value; }
async function logState() { return page.locator('.v3-chat-log').evaluate(node => ({ top:node.scrollTop,height:node.scrollHeight,client:node.clientHeight })); }
async function hydrated(id, entries=8) {
  await page.waitForFunction(([value,count])=>window.__toolInspection.lastHydrated===value && document.querySelectorAll('.chat-tool-entry').length===count,[id,entries]);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

async function sessionAndNestedQA() {
  await page.setViewportSize({ width:1280, height:900 });
  const log=page.locator('.v3-chat-log');
  const settled=async id=>{
    await page.waitForFunction(value=>window.__toolInspection.lastHydrated===value && document.querySelectorAll('.chat-tool-entry').length===8,id);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  await page.evaluate(()=>window.__toolInspection.render('pi')); await settled('inspect-pi');
  await log.evaluate(node=>{node.scrollTop=180;node.dispatchEvent(new Event('scroll'));}); const positionA=(await logState()).top;
  await page.evaluate(()=>window.__toolInspection.render('kimi')); await settled('inspect-kimi');
  await log.evaluate(node=>{node.scrollTop=300;node.dispatchEvent(new Event('scroll'));}); const positionB=(await logState()).top;
  await page.evaluate(()=>{window.__toolInspection.snapshotDelay(250);window.__toolInspection.render('pi');}); await settled('inspect-pi');
  assert.ok(Math.abs((await logState()).top-positionA)<3,'delayed hydration restores paused position A');
  await page.evaluate(()=>window.__toolInspection.render('kimi')); await settled('inspect-kimi');
  assert.ok(Math.abs((await logState()).top-positionB)<3,'delayed hydration restores paused position B');
  await page.evaluate(()=>window.__toolInspection.snapshotDelay(0));
  check('bidirectional paused session positions survive delayed snapshot hydration');

  await page.evaluate(()=>window.__toolInspection.nested());
  const subagent=page.locator('.chat-subagent-card'); await subagent.locator(':scope > details > summary').click();
  const inner=page.locator('.chat-subagent-transcript'); await inner.locator('.chat-tool-activity').waitFor();
  const nestedDrawer=inner.locator('.chat-tool-activity'); const closedInnerTop=await inner.evaluate(node=>node.scrollTop); await nestedDrawer.locator('> summary').click();
  await inner.locator('.chat-tool-entry').waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const openedInnerTop=await inner.evaluate(node=>node.scrollTop);
  assert.ok(Math.abs(openedInnerTop-closedInnerTop)<3,'nested disclosure opens without pulling its scroll owner to the bottom');
  await page.evaluate(()=>window.__toolInspection.updateChild()); await page.waitForFunction(()=>window.__toolInspection.lastChildRead===2);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await inner.evaluate(node=>node.scrollTop)-openedInnerTop)<3,'nested output after expansion preserves the pre-scroll inspection position');
  await inner.evaluate(node=>{node.scrollTop=250;node.dispatchEvent(new Event('scroll'));});
  const nestedTop=await inner.evaluate(node=>node.scrollTop), outerTop=(await logState()).top;
  await page.evaluate(()=>window.__toolInspection.updateChild());
  await page.waitForFunction(()=>window.__toolInspection.lastChildRead===3 && !document.querySelector('.chat-subagent-note[role="status"]'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await inner.evaluate(node=>node.scrollTop)-nestedTop)<3,'nested streamed revision retains the inner reading position');
  await nestedDrawer.locator('.chat-tool-collapse').click();
  await page.waitForFunction(()=>!document.querySelector('.chat-subagent-transcript .chat-tool-activity')?.open);
  const nestedHeader=await nestedDrawer.locator('> summary').boundingBox(), innerBox=await inner.boundingBox();
  assert.ok(nestedHeader.y>=innerBox.y-2 && nestedHeader.y+Math.min(nestedHeader.height,40)<=innerBox.y+innerBox.height+2,'nested footer collapse reveals the header in its own scroll owner');
  assert.ok(Math.abs((await logState()).top-outerTop)<3,'nested collapse leaves outer transcript position intact');
  check('native subagent tools preserve inner reading position and collapse in the nearest scroll container');
}

try {
  await Promise.all([...Object.values(privatePaths), join(privatePaths.home, '.codex'), out].map(path => mkdir(path, { recursive: true })));
  const freeze = ['renderer/src/components/ChatView.tsx','renderer/src/components/ToolActivity.tsx','renderer/src/toolActivity.ts','renderer/src/styles.css','renderer/src/components/tool-activity.css'];
  for (const relative of freeze) {
    const original = join(root, relative);
    // A baseline must remain faithful even after the renderer is repaired.
    const contents = baselineOnly ? execFileSync('git', ['show', `11ed6eb:${relative.replaceAll('\\','/')}`], { cwd: root, encoding: 'utf8' }) : await readFile(original, 'utf8');
    frozenSources.set(resolve(original), contents);
  }
  report.baseline.frozenFiles = [...frozenSources.keys()].map(path => path.slice(root.length + 1));
  await build({ stdin:{contents:entry,resolveDir:root,loader:'tsx'}, bundle:true, outfile:join(privatePaths.fixture,'qa.js'), jsx:'automatic', plugins:[{name:'frozen-chat-tool-baseline',setup(build){
    build.onResolve({filter:/./},args=>{ const candidate=resolve(args.resolveDir||root,args.path); for(const path of frozenSources.keys()) if(candidate===path||`${candidate}.tsx`===path||`${candidate}.ts`===path||`${candidate}.css`===path) return {path,namespace:'frozen-chat'}; return undefined; });
    build.onLoad({filter:/./,namespace:'frozen-chat'},args=>({contents:frozenSources.get(args.path),loader:args.path.endsWith('.css')?'css':args.path.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(args.path)}));
  }}], loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'} });
  await writeFile(join(privatePaths.fixture,'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;height:100vh;max-height:100vh;overflow:hidden}#root{display:flex;flex-direction:column}#root>.chat-view{min-height:0;flex:1}</style><div id="root"></div><script src="qa.js"></script>');
  await writeFile(join(privatePaths.fixture,'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(privatePaths['user-data'])}); app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(privatePaths.fixture,'index.html'))})})`);
  const childEnv = env(); assert.equal(childEnv.Path.includes(process.env.USERPROFILE ?? '__user__'), false, 'curated Electron PATH excludes the user profile');
  for (const value of [childEnv.HOME,childEnv.USERPROFILE,childEnv.CODEX_HOME,childEnv.APPDATA,childEnv.LOCALAPPDATA,childEnv.THREADTERM_V3_DATA,childEnv.THREADTERM_V3_USER_DATA,childEnv.TT_PARITY_PROFILE]) assert.ok(value.startsWith(scratch), 'all Electron storage paths are private scratch paths');
  app = await electron.launch({ args:['--disable-gpu','--in-process-gpu','--no-sandbox',join(privatePaths.fixture,'main.cjs')], env:childEnv, timeout:30000 }); child=app.process(); page=await app.firstWindow({timeout:30000}); page.setDefaultTimeout(10000); page.on('pageerror',error=>report.errors.push(String(error)));
  await page.waitForFunction(() => Boolean(window.__toolInspection));
  // Dedicated live, last-drawer fixture: starts in true follow state and has
  // no trailing answer/question card that could cause Playwright to scroll it.
  await page.evaluate(()=>window.__toolInspection.inspect()); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const inspectionLog=page.locator('.v3-chat-log'); const inspectionInitial=await logState(); assert.ok(inspectionInitial.height>inspectionInitial.client+200,'dedicated inspection fixture is scrollable'); assert.ok(inspectionInitial.top>=inspectionInitial.height-inspectionInitial.client-4,'dedicated inspection starts following bottom');
  await inspectionLog.evaluate(node=>{node.scrollTop-=80;});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await inspectionLog.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await inspectionLog.evaluate(node=>node.style.overflowAnchor),'none','the scroll handler confirms follow before opening');
  const inspectionDrawer=await drawer(); const inspectionBefore=await logState(); await inspectionDrawer.locator('> summary').click(); await page.waitForFunction(()=>document.querySelector('.chat-tool-activity')?.open); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); const inspectionAfter=await logState(); assert.ok(inspectionAfter.height-inspectionBefore.height>1000,`opening the long drawer adds meaningful body height (${inspectionAfter.height-inspectionBefore.height})`); report.baseline.trueFollowLastDrawerDelta=inspectionAfter.top-inspectionBefore.top;
  if (baselineOnly) throw new Error(`Expected frozen last-drawer deficiencies: trueFollowDelta=${report.baseline.trueFollowLastDrawerDelta}, previewMissing=${await inspectionDrawer.locator('.chat-tool-output-preview').count()===0}`);
  assert.ok(Math.abs(inspectionAfter.top-inspectionBefore.top)<8,'true-follow live last drawer preserves scrollTop when disclosure expands');
  await inspectionLog.evaluate(node=>{node.scrollTop+=900;});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const sticky=await inspectionDrawer.locator('> summary').boundingBox(), viewport=await inspectionLog.boundingBox();
  assert.ok(sticky.y>=viewport.y-2 && sticky.y<viewport.y+80,'expanded long drawer keeps its collapse header in the reading viewport');
  await shot('tool-inspection-live-expanded-en-light.png');
  await inspectionDrawer.locator('.chat-tool-collapse-label').click();
  await page.waitForFunction(()=>!document.querySelector('.chat-tool-activity')?.open);
  check('following long disclosure preserves position and offers a reachable sticky collapse header');
  await page.evaluate(()=>window.__toolInspection.render()); await hydrated('inspect-codex');
  const initial = await logState(); report.baseline.initialFollow = initial; assert.ok(initial.height > initial.client + 200, `fixture produces a scrollable production log (${initial.height} > ${initial.client})`); assert.ok(initial.top >= Math.max(0, initial.height-initial.client-4), 'initial ChatView follows the latest transcript content');
  const initialDrawer=await drawer(); report.baseline = {...report.baseline, outputPreviewPresent:await initialDrawer.locator('.chat-tool-output-preview').count(), stickySummaryPresent:await initialDrawer.locator(':scope > summary .chat-tool-collapse-label').count()};
  check('baseline records the pre-repair one-line preview and sticky-collapse selector state without treating missing controls as a pass');
  for (const provider of providers) { await page.evaluate(value=>window.__toolInspection.render(value),provider); await hydrated('inspect-'+provider); const activity=await drawer(); assert.equal(await activity.locator('.chat-tool-entry').count(),8,`${provider} retains all mixed provider tool records`); assert.equal(await page.locator('.chat-part.approval').count(),2,`${provider} retains question and approval outside drawer`); assert.ok(await page.getByText('A provider error remains visible outside the tool drawer.').count(),`${provider} retains error visibility`); }
  check('Pi actual arguments/result.content plus Codex, Claude, Kimi, Gemini, Grok, OpenCode, and plugin tool shapes preserve independent question, approval, and error rows');
  const activity=await drawer(); const log=page.locator('.v3-chat-log'); await log.evaluate(node=>node.scrollTop=Math.max(0,node.scrollHeight-node.clientHeight-360)); const beforeOpen=await logState(); await page.evaluate(()=>document.querySelector('.chat-tool-activity > summary')?.click()); await page.waitForFunction(()=>document.querySelector('.chat-tool-activity')?.open); const afterOpen=await logState();
  report.baseline.openingScrollDelta = afterOpen.top-beforeOpen.top;
  report.baseline.missingPreview = await activity.locator('.chat-tool-output-preview').count() === 0;
  report.baseline.missingStickyCollapse = await activity.locator(':scope > summary .chat-tool-collapse-label').count() === 0;
  report.baseline.missingFooterCollapse = await activity.locator('.chat-tool-collapse[data-chat-collapse]').count() === 0;
  if (baselineOnly) throw new Error(`Expected pre-repair deficiencies: preview=${report.baseline.missingPreview}, sticky=${report.baseline.missingStickyCollapse}, footer=${report.baseline.missingFooterCollapse}, openingScrollDelta=${report.baseline.openingScrollDelta}`);
  assert.ok(Math.abs(afterOpen.top-beforeOpen.top)<8,'opening the drawer preserves pre-click reading position');
  assert.equal(await activity.locator('.chat-tool-output-preview').count(),1,'one-line output preview remains visible outside expanded details'); assert.ok(await activity.locator('.chat-tool-output-preview > span:last-child').evaluate(node=>getComputedStyle(node).whiteSpace).then(value=>/nowrap/.test(value)),'output preview text is one line');
  assert.equal(await activity.locator(':scope > summary .chat-tool-collapse-label').count(),1,'expanded sticky summary exposes Collapse tools label'); assert.equal(await activity.locator('.chat-tool-collapse[data-chat-collapse]').count(),1,'expanded mid-body footer exposes Collapse tools control');
  await activity.locator('.chat-tool-collapse').click(); await page.waitForFunction(()=>!document.querySelector('.chat-tool-activity')?.open); check('activating disclosure pauses follow before resize, preserves scroll, and exposes both collapse controls when expanded');
  assert.equal(await page.locator('.chat-back-to-bottom').count(),1,'paused follow reveals back-to-bottom overlay'); await page.locator('.chat-back-to-bottom').click(); await page.waitForFunction(()=>{const node=document.querySelector('.v3-chat-log');return !!node&&node.scrollTop>=node.scrollHeight-node.clientHeight-4}); const resumed=await logState(); assert.ok(resumed.top >= resumed.height-resumed.client-4,'back-to-bottom resumes follow at the end');
  await activity.locator('> summary').click(); const stayed=await logState(); await page.evaluate(()=>window.__toolInspection.appendOutput()); await page.waitForFunction(()=>document.querySelector('.chat-tool-output-preview')?.textContent?.includes('output update')); const updated=await logState(); assert.ok(Math.abs(updated.top-stayed.top)<8,'live output update while inspecting preserves viewport'); assert.equal(await activity.evaluate(node=>node.open),true,'output update retains open state');
  await log.focus(); await page.keyboard.press('Escape'); assert.equal(await activity.evaluate(node=>node.open),true,'Escape from the focused log resumes follow without collapsing the inspected drawer'); const escaped=await logState(); assert.ok(escaped.top>=escaped.height-escaped.client-4,'Escape from the focused log returns to the bottom');
  await activity.locator('> summary').focus(); await page.keyboard.press('Space'); assert.equal(await activity.evaluate(node=>node.open),false,'Space closes the native summary disclosure'); await page.keyboard.press('Enter'); assert.equal(await activity.evaluate(node=>node.open),true,'Enter opens the native summary disclosure from follow');
  await page.evaluate(()=>window.__toolInspection.session('kimi')); await hydrated('inspect-kimi'); const restored=await logState(); assert.ok(restored.top >= restored.height-restored.client-4,'switching session restores its own followed viewport'); check('back-to-bottom, live updates, keyboard disclosure, completion/inactive state and session restore preserve inspection state');
  for (const theme of ['light','dark']) for (const locale of ['en','zh-CN']) for (const width of [1280,1440,1920,390]) { await page.evaluate(([nextLocale,nextTheme])=>{document.documentElement.dataset.theme=nextTheme;window.__toolInspection.render('codex',nextLocale)},[locale,theme]); await setSize(width); const current=await drawer(); if(width===390) await current.locator('> summary').click(); const horizontal=await page.locator('.v3-chat-log').evaluate(node=>node.scrollWidth<=node.clientWidth+1); assert.equal(horizontal,true,`${theme}/${locale}/${width} has no horizontal log clipping`); await shot(`tool-inspection-${theme}-${locale}-${width}.png`); }
  check('light/dark English/Chinese 1280/1440/1920/390 screenshots cover collapsed and expanded production ChatView without horizontal clipping');
  await sessionAndNestedQA();
  assert.deepEqual(report.errors,[],'fixture has no renderer page errors'); report.passed=true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if(page) await shot('failure.png').catch(()=>{}); process.exitCode=1; }
finally {
  if(app) await app.close().catch(error=>report.errors.push(`Electron close failed: ${error}`));
  if(child?.exitCode==null) await Promise.race([new Promise(resolve=>child?.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
  const childExited=!child || child.exitCode!=null;
  if(!childExited) report.errors.push('Electron child did not exit; retained scratch for inspection.');
  await mkdir(out,{recursive:true}); report.passed=report.passed&&report.errors.length===0;
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  const safeScratch=dirname(resolve(scratch)).toLowerCase()===resolve(tmpdir()).toLowerCase() && basename(scratch).startsWith('tt-chat-tool-inspection-');
  if(childExited && safeScratch) await rm(scratch,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
  console.log(`${report.passed?'CHAT TOOL INSPECTION QA PASSED':'CHAT TOOL INSPECTION QA FAILED'}; report: ${join(out,'report.json')}`);
}
assert.equal(report.errors.length,0,report.errors.join('\n'));
