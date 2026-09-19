import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {startReadonlyReferenceServer} from './parity/reference-server.mjs';
import {installVisualFixture} from './parity/fixture.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..'),out=resolve(root,'qa/results/preset-restore-ui-final',new Date().toISOString().replace(/[:.]/g,'-'));
const launch=profile=>electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:30000});
await mkdir(out,{recursive:true});
const referenceServer=await startReadonlyReferenceServer(join(root,'reference'));
const referenceApp=await launch(join(await mkdtemp(join(tmpdir(),'preset-reference-')),'profile'));
const reference=await referenceApp.firstWindow();
await reference.addInitScript(()=>localStorage.setItem('threadterm.app.v3',JSON.stringify({welcomeSeen:true,theme:'light'})));
await reference.goto(referenceServer.origin+'/prototype/');await reference.waitForFunction(()=>!!window.ThreadTermPrototype);await reference.addStyleTag({content:'html,body,.desktop{width:100%!important;height:100%!important;overflow:hidden!important}.desktop{padding:0!important;background:none!important}.app-window{width:100%!important;max-width:none!important;height:100%!important;max-height:none!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important}.app-chrome{display:none!important}.app-stage{width:100%!important;max-width:none!important;height:100%!important}'});
const seed=await reference.evaluate(()=>{const api=window.ThreadTermPrototype;return {projects:api.projects,trees:api.trees,sessions:api.sessions(),store:api.store,fileContents:Object.fromEntries(Object.entries(api.projects).map(([id,p])=>[id,Object.fromEntries(p.files.map((path,index)=>[path,api.fileValue(api.sessions().find(item=>item.project===id),index)]))]))};});
await reference.evaluate(()=>window.ThreadTermPrototype.navigate('#/presets'));
await reference.screenshot({path:join(out,'reference-preset-cards.png'),animations:'disabled'});
await reference.locator('[data-action="preset-open"][data-id="orbit-parallel"]').click();
await reference.locator('.preset-entry').first().waitFor();
assert.equal(await reference.locator('.preset-entry').count(),2,'reference has two worktree candidates');
assert.equal(await reference.locator('.cmd-check').count(),4,'reference has four selectable commands');
await reference.screenshot({path:join(out,'reference-restore-open.png'),animations:'disabled'});
await referenceApp.close();await referenceServer.close();
const server=await startReadonlyReferenceServer(join(root,'desktop-dist/renderer'));
const app=await launch(join(await mkdtemp(join(tmpdir(),'preset-production-')),'profile'));
try{
 const page=await app.firstWindow();await page.addInitScript(installVisualFixture,{seed,theme:'light'});await page.goto(server.origin+'/?theme=light');await page.locator('.proj-row').first().waitFor();await page.addStyleTag({content:'.titlebar.app-chrome{display:none!important}.app-shell{grid-template-rows:minmax(0,1fr) 24px!important}.app-shell>.sidebar,.app-shell>.content.main{grid-row:1!important}.app-shell>.statusbar{grid-row:2!important}'});
 await page.locator('.side-nav button').filter({hasText:'工作预设'}).click();
 await page.screenshot({path:join(out,'production-preset-cards.png'),animations:'disabled'});
 await page.locator('.preset-card-main').filter({hasText:'结账功能与支付热修并行复核'}).click();
 await page.locator('.preset-restore').waitFor();await page.locator('.preset-restore-entry').first().waitFor();
 assert.equal(await page.locator('.preset-restore-entry').count(),2,'two worktree candidates');
 assert.equal(await page.locator('.cmd-check').count(),4,'each command can be selected');
 await page.screenshot({path:join(out,'restore-open.png'),animations:'disabled'});
 const mapBefore=await page.locator('.preset-layout-map > .pm-col').count();
 await page.locator('.preset-restore-entry .checkline input').first().uncheck();
 assert.ok(await page.locator('.preset-layout-map > .pm-col').count()<mapBefore,'layout preview prunes unselected scope');
 await page.locator('.cmd-check input').first().scrollIntoViewIfNeeded();
 await page.locator('.cmd-check input').first().uncheck();
 await page.screenshot({path:join(out,'restore-pruned.png'),animations:'disabled'});
 await page.locator('.btn-primary').filter({hasText:'确认并恢复'}).click();
 await page.locator('.preset-restore').waitFor({state:'detached'});
 await page.locator('.session-screen').waitFor();
 assert.equal(await page.locator('.cmd-opt').count(),3,'only checked commands reach the review queue');
 const calls=await page.evaluate(()=>window.__parityFixture.calls);
 assert.equal(calls.some(call=>call.method==='session.create'),false,'restore must never create a session');
 assert.equal(calls.some(call=>call.method==='session.resume'),false,'restore must never resume a session');
 assert.equal(calls.some(call=>call.method==='terminal.input'),false,'restore must never send commands');
 await page.screenshot({path:join(out,'restore-confirmed.png'),animations:'disabled'});
 const historyChecks=[];
 async function restoreHistory(name,imported=false){
  await page.locator('.side-nav button').filter({hasText:'工作预设'}).click();await page.locator('.preset-card-main').filter({hasText:'文档整理'}).click();await page.locator('.preset-restore-entry').waitFor();
  assert.equal(await page.locator('.preset-restore-entry input[type=checkbox]').first().isEnabled(),true,'historical view is eligible');
  const before=await page.evaluate(()=>window.__parityFixture.calls.length);await page.getByRole('button',{name:'确认并恢复',exact:true}).click();await page.locator('.preset-restore').waitFor({state:'detached'});await page.locator('.session-screen').waitFor();
  if(imported)await page.locator('.imported-history-view').waitFor();else await page.locator('.terminal-host').waitFor();
  const after=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before);assert.equal(after.some(call=>['session.claim','session.create','session.resume','terminal.input','chat.send'].includes(call.method)),false,'history restore never claims control or starts a lifecycle action');
  await page.screenshot({path:join(out,name+'.png'),animations:'disabled'});historyChecks.push({name,calls:after});
 }
 await restoreHistory('ended-preset-restored');
 await page.addInitScript(()=>{const prior=window.threadterm.request.bind(window.threadterm);window.threadterm.request=async(method,params)=>{if(method==='session.config.read'&&params.sessionId==='docs-gemini')throw new Error('launch_config_missing');const result=await prior(method,params);if(method==='runtime.snapshot')return {...result,sessions:result.sessions.map(session=>session.id==='docs-gemini'?{...session,readOnly:true}:session)};return result;};});
 await page.reload();await page.locator('.proj-row').first().waitFor();await restoreHistory('imported-preset-without-launch-config',true);
 // Exercise the Chat lifecycle without any provider process or paid request.
 await page.addInitScript(()=>{
  const prior=window.threadterm.request.bind(window.threadterm), priorOnEvent=window.threadterm.onEvent.bind(window.threadterm), listeners=new Set();
  const chat={status:'exited',draft:{text:'',revision:0},setStatus(status){this.status=status;for(const fn of listeners)fn({v:1,event:'state.changed',epoch:'visual-fixture',seq:900,data:{kind:'session'}});}};
  window.__historyChatQA=chat;
  window.threadterm.onEvent=fn=>{listeners.add(fn);const off=priorOnEvent(fn);return()=>{listeners.delete(fn);off();};};
  window.threadterm.request=async(method,params)=>{
   if(params?.sessionId==='docs-gemini'){
    if(method==='session.config.read')return {sessionId:'docs-gemini',provider:'gemini',mode:'chat',cwd:'',title:'Chat history QA',args:[],revision:0};
    if(method.startsWith('chat.')){
     window.__parityFixture.calls.push({method,params});
     if(method==='chat.snapshot')return {items:[],revision:0};
     if(method==='chat.draft.read')return {...chat.draft};
     if(method==='chat.draft.save'){if(params.expectedRevision!==chat.draft.revision)throw Error('revision_conflict');chat.draft={text:params.text,revision:chat.draft.revision+1};return {...chat.draft};}
     throw Error('Unexpected Chat write: '+method);
    }
   }
   const result=await prior(method,params);
   return method==='runtime.snapshot'?{...result,sessions:result.sessions.map(s=>s.id==='docs-gemini'?{...s,readOnly:false,mode:'chat',status:chat.status}:s)}:result;
  };
 });
 await page.reload();await page.locator('.proj-row').first().waitFor();
 await page.locator('.side-nav button').filter({hasText:'工作预设'}).click();await page.locator('.preset-card-main').filter({hasText:'文档整理'}).click();await page.locator('.preset-restore-entry').waitFor();
 const chatStart=await page.evaluate(()=>window.__parityFixture.calls.length);await page.getByRole('button',{name:'确认并恢复',exact:true}).click();await page.locator('.chat-view').waitFor();
 assert.equal(await page.locator('.chat-compose textarea').isDisabled(),true,'ended Chat stays read-only');
 assert.equal(await page.evaluate(start=>window.__parityFixture.calls.slice(start).some(c=>['session.claim','session.create','session.resume','chat.send','chat.draft.save'].includes(c.method)),chatStart),false,'ended Chat restore is read-only');
 await page.evaluate(()=>window.__historyChatQA.setStatus('idle'));await page.waitForFunction(()=>!document.querySelector('.chat-compose textarea')?.disabled);
 await page.locator('.chat-compose textarea').fill('LIVE_CHAT_FAST_NAV_DRAFT');
 await page.locator('.side-nav button').filter({hasText:'工作预设'}).click();
 await page.waitForFunction(()=>window.__historyChatQA.draft.text==='LIVE_CHAT_FAST_NAV_DRAFT');
 await page.locator('.preset-card-main').filter({hasText:'文档整理'}).click();await page.locator('.preset-restore-entry').waitFor();await page.getByRole('button',{name:'确认并恢复',exact:true}).click();await page.locator('.chat-view').waitFor();await page.waitForFunction(()=>!document.querySelector('.chat-compose textarea')?.disabled);
 await page.locator('.chat-compose textarea').fill('LIVE_CHAT_ENDED_DRAFT');await page.evaluate(()=>window.__historyChatQA.setStatus('exited'));await page.waitForFunction(()=>document.querySelector('.chat-compose textarea')?.disabled);
 assert.equal(await page.locator('.chat-compose textarea').inputValue(),'LIVE_CHAT_ENDED_DRAFT','ending Chat preserves the current draft in the mounted view');
 await page.screenshot({path:join(out,'ended-chat-preserves-draft.png'),animations:'disabled'});
 historyChecks.push({name:'chat-history-and-live-draft-lifecycle',calls:await page.evaluate(start=>window.__parityFixture.calls.slice(start),chatStart)});
 await writeFile(join(out,'report.json'),JSON.stringify({passed:true,calls,historyChecks},null,2));
 console.log('preset restore UI: passed');
}finally{await app.close();await server.close();}
