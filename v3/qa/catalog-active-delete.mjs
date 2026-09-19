import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {startReadonlyReferenceServer} from './parity/reference-server.mjs';
import {installVisualFixture} from './parity/fixture.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..');
const out=join(here,'results/catalog-active-delete',new Date().toISOString().replace(/[:.]/g,'-'));
const report={startedAt:new Date().toISOString(),staticFixture:true,checks:[],visuals:[],errors:[]};

function extendActiveDeleteFixture(){
  const prior=window.threadterm.request.bind(window.threadterm),priorSubscribe=window.threadterm.onEvent.bind(window.threadterm);
  const listeners=new Set(),visibility=[],statePromise=prior('runtime.snapshot',{});let sequence=0,failStopFor,activateDuringStop,releaseHeldStop,holdNextStop=false;
  const active=session=>!session.readOnly&&['starting','running','idle','waiting'].includes(session.status);
  const changed=()=>listeners.forEach(listener=>listener({v:1,event:'state.changed',epoch:'active-delete-fixture',seq:++sequence,data:{kind:'catalog.visibility'}}));
  window.__catalogActiveDelete={failStopFor:sessionId=>{failStopFor=sessionId;},setStatus:async(sessionId,status)=>{const state=await statePromise,session=state.sessions.find(row=>row.id===sessionId);if(!session)throw new Error('session_not_found');session.status=status;changed();},addLongActiveSessions:async count=>{const state=await statePromise,base=state.sessions.find(row=>row.projectId==='orbit');for(let index=0;index<count;index+=1)state.sessions.push({...base,id:`long-active-${index}`,title:`Long active session ${index} — catalogue confirmation must keep its actions reachable`,worktreePath:'D:/demo/orbit-web',status:'running'});changed();},activateDuringStop:config=>{activateDuringStop=config;},holdNextStop:()=>{holdNextStop=true;},releaseHeldStop:()=>{releaseHeldStop?.();}};
  window.threadterm.onEvent=listener=>{listeners.add(listener);const unsubscribe=priorSubscribe(listener);return()=>{listeners.delete(listener);unsubscribe();};};
  window.threadterm.request=async(method,params)=>{
    const state=await statePromise;
    if(method==='runtime.snapshot')return structuredClone(state);
    if(method==='catalog.visibility.list')return structuredClone(visibility);
    if(method==='session.stop'){
      window.__parityFixture.calls.push({method,params});
      if(params.sessionId===failStopFor)throw new Error('fixture_stop_failed');
      const session=state.sessions.find(row=>row.id===params.sessionId);
      if(!session)throw new Error('session_not_found');
      if(holdNextStop){holdNextStop=false;await new Promise(resolve=>{releaseHeldStop=resolve;});releaseHeldStop=undefined;}
      session.status='exited';
      if(activateDuringStop?.afterSessionId===params.sessionId){const added=state.sessions.find(row=>row.id===activateDuringStop.sessionId);if(added)added.status='running';activateDuringStop=undefined;}
      changed();return null;
    }
    if(method==='catalog.visibility.update'){
      window.__parityFixture.calls.push({method,params});
      const current=visibility.find(row=>row.kind===params.kind&&row.id===params.id);
      if(params.expectedRevision!==(current?.revision??(params.kind==='session'?state.sessions.find(row=>row.id===params.id)?.organizationRevision??0:0)))throw new Error('revision_conflict');
      const trees=(await Promise.all(state.projects.map(project=>prior('worktree.list',{projectId:project.id})))).flat();
      const tree=trees.find(row=>row.id===params.id);
      const scoped=params.kind==='session'?state.sessions.filter(row=>row.id===params.id):params.kind==='project'?state.sessions.filter(row=>row.projectId===params.id):state.sessions.filter(row=>row.projectId===tree?.projectId&&row.worktreePath===tree?.path);
      if(params.visibility!=='active'&&scoped.some(active))throw new Error('end_active_sessions_before_changing_catalog_visibility');
      const next={kind:params.kind,id:params.id,visibility:params.visibility,revision:(current?.revision??0)+1,...(params.kind==='session'?{projectId:state.sessions.find(row=>row.id===params.id)?.projectId,worktreePath:state.sessions.find(row=>row.id===params.id)?.worktreePath}:params.kind==='worktree'?{projectId:tree?.projectId,worktreePath:tree?.path}:{})};
      if(current)Object.assign(current,next);else visibility.push(next);changed();return structuredClone(next);
    }
    return prior(method,params);
  };
}

await mkdir(out,{recursive:true});let app,server,page;
const deadline=setTimeout(()=>{report.errors.push('180s hard deadline');void app?.close().catch(()=>{});},180000);
async function caseOf(name,action){try{await action();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:String(error)});report.errors.push(name);await page.screenshot({path:join(out,name+'-failure.png')}).catch(()=>{});}finally{const cancel=page.getByRole('dialog').getByRole('button',{name:'取消',exact:true});if(await cancel.count())await cancel.click().catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});}}
try{
  const seed=JSON.parse(await readFile(join(here,'results/parity/2026-09-10T14-50-58-408Z/visual-fixture.json'),'utf8'));
  const profile=await mkdtemp(join(tmpdir(),'threadterm-active-delete-'));
  app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:15000});
  page=await app.firstWindow();page.setDefaultTimeout(7000);
  await page.addInitScript(installVisualFixture,{seed,theme:'light'});await page.addInitScript(extendActiveDeleteFixture);
  server=await startReadonlyReferenceServer(join(root,'desktop-dist/renderer'));await page.goto(server.origin+'/?theme=light');await page.locator('.proj-row').first().waitFor();
  const menu=()=>page.locator('.catalogue-popover');
  const more=async(selector,title)=>{const row=page.locator(selector).filter({hasText:title});await row.hover();await row.locator('.row-more').click();await menu().waitFor();};
  const choose=async(name)=>menu().getByRole('menuitem',{name,exact:true}).click();
  const confirm=async(name)=>page.getByRole('dialog').getByRole('button',{name,exact:true}).click();
  await caseOf('active-delete-modal-renders-at-supported-themes-and-widths',async()=>{
    for(const theme of ['light','dark'])for(const width of [1280,1440,1920]){
      await page.setViewportSize({width,height:900});await page.goto(server.origin+`/?theme=${theme}`);await page.locator('.proj-row').first().waitFor();await more('.sess-row-wrap','开发服务器');await choose('删除');const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'会话需要结束后才可删除'}).waitFor();const bodyMetrics=await dialog.locator('.dlg-body').evaluate(element=>{const style=getComputedStyle(element);return {paddingLeft:style.paddingLeft,paddingRight:style.paddingRight,fontSize:style.fontSize,lineHeight:style.lineHeight};});assert.deepEqual(bodyMetrics,{paddingLeft:'20px',paddingRight:'20px',fontSize:'14px',lineHeight:'22.4px'});
      const path=join(out,`active-delete-${theme}-${width}.png`);await page.screenshot({path,animations:'disabled'});report.visuals.push({theme,width,path});await confirm('取消');
    }
  });
  await caseOf('cancel-active-session-delete-has-no-mutations',async()=>{
    const before=await page.evaluate(()=>window.__parityFixture.calls.length);
    await more('.sess-row-wrap','开发服务器');await choose('删除');
    const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'会话需要结束后才可删除'}).waitFor();await dialog.getByText('此范围内有 1 个活动会话').waitFor();await dialog.getByText('需要结束：开发服务器',{exact:true}).waitFor();
    await confirm('取消');assert.equal(await page.locator('.sess-row').filter({hasText:'开发服务器'}).count(),1);
    const calls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before);assert.equal(calls.some(call=>call.method==='session.stop'||call.method==='catalog.visibility.update'),false);
  });
  await caseOf('stop-failure-keeps-delete-dialog-recoverable',async()=>{
    await page.evaluate(()=>window.__catalogActiveDelete.failStopFor('orbit-shell'));
    const before=await page.evaluate(()=>window.__parityFixture.calls.length);
    await more('.sess-row-wrap','开发服务器');await choose('删除');await confirm('结束并删除');
    await page.getByRole('dialog').getByRole('alert').filter({hasText:'fixture_stop_failed'}).waitFor();assert.equal(await page.getByRole('dialog').getByRole('button',{name:'结束并删除',exact:true}).isEnabled(),true);
    const calls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before);assert.equal(calls.some(call=>call.method==='catalog.visibility.update'),false);await confirm('取消');
  });
  await caseOf('project-delete-reports-only-project-scoped-active-sessions',async()=>{
    const before=await page.evaluate(()=>window.__parityFixture.calls.length);
    await more('.proj-row-wrap','orbit-web');await choose('删除');
    const dialog=page.getByRole('dialog');await dialog.getByText('此范围内有 4 个活动会话').waitFor();await dialog.getByText(/checkout keyboard fix.*开发服务器.*支付超时复核.*抽取共享焦点组件/).waitFor();await confirm('取消');
    const calls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before);assert.equal(calls.some(call=>call.method==='session.stop'||call.method==='catalog.visibility.update'),false);
  });
  await caseOf('new-active-session-before-confirmation-requires-another-confirmation-without-stops',async()=>{
    const before=await page.evaluate(()=>window.__parityFixture.calls.length);
    await more('.proj-row-wrap','orbit-web');await choose('删除');await page.evaluate(()=>window.__catalogActiveDelete.setStatus('orbit-main-lint','running'));await confirm('结束并删除');
    const dialog=page.getByRole('dialog');await dialog.getByText('此范围内有 5 个活动会话').waitFor();await dialog.getByRole('status').filter({hasText:'活动会话已变化'}).waitFor();
    const calls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before);assert.equal(calls.some(call=>call.method==='session.stop'||call.method==='catalog.visibility.update'),false);await page.evaluate(()=>window.__catalogActiveDelete.setStatus('orbit-main-lint','exited'));await confirm('取消');
  });
  await caseOf('new-active-session-during-stop-requires-reconfirmation-before-it-is-stopped',async()=>{
    await page.evaluate(()=>window.__catalogActiveDelete.failStopFor(undefined));
    const before=await page.evaluate(()=>window.__parityFixture.calls.length);
    await more('.tree-row-wrap','feature/checkout-a11y');await choose('删除');
    const dialog=page.getByRole('dialog');await dialog.getByText('此范围内有 3 个活动会话').waitFor();await dialog.getByText('checkout keyboard fix').waitFor();await dialog.getByText('开发服务器').waitFor();await dialog.getByText('抽取共享焦点组件').waitFor();
    await page.evaluate(()=>window.__catalogActiveDelete.activateDuringStop({afterSessionId:'orbit-claude',sessionId:'orbit-checkout-audit'}));await confirm('结束并删除');
    await dialog.getByText('此范围内有 1 个活动会话').waitFor();await dialog.getByText('结账 a11y 审计').waitFor();await dialog.getByRole('status').filter({hasText:'活动会话已变化'}).waitFor();
    const firstCalls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before),firstStopped=firstCalls.filter(call=>call.method==='session.stop').map(call=>call.params.sessionId).sort();assert.deepEqual(firstStopped,['orbit-checkout-extract','orbit-claude','orbit-shell']);assert.equal(firstCalls.some(call=>call.method==='catalog.visibility.update'),false);
    await confirm('结束并删除');await page.locator('.tree-row').filter({hasText:'feature/checkout-a11y'}).waitFor({state:'detached'});
    const calls=await page.evaluate(start=>window.__parityFixture.calls.slice(start),before),stopped=calls.filter(call=>call.method==='session.stop').map(call=>call.params.sessionId).sort();
    assert.deepEqual(stopped,['orbit-checkout-audit','orbit-checkout-extract','orbit-claude','orbit-shell']);assert.ok(calls.some(call=>call.method==='catalog.visibility.update'&&call.params.kind==='worktree'&&call.params.visibility==='removed'));assert.equal(calls.some(call=>['project.remove','worktree.remove','filesystem.write'].includes(call.method)),false);
  });
  await caseOf('busy-delete-modal-cannot-close-through-escape-or-backdrop',async()=>{
    await page.evaluate(()=>window.__catalogActiveDelete.holdNextStop());await more('.sess-row-wrap','支付超时复核');await choose('删除');await confirm('结束并删除');
    const dialog=page.getByRole('dialog'),overlay=page.locator('.overlay.runtime-overlay').filter({has:dialog});await dialog.getByRole('button',{name:'正在结束…',exact:true}).waitFor({state:'visible'});assert.equal(await dialog.getByRole('button',{name:'正在结束…',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');await overlay.click({position:{x:4,y:4}});assert.equal(await dialog.count(),1);await page.evaluate(()=>window.__catalogActiveDelete.releaseHeldStop());await page.locator('.sess-row').filter({hasText:'支付超时复核'}).waitFor({state:'detached'});
  });
  await caseOf('long-active-session-list-scrolls-within-a-visible-confirmation-footer',async()=>{
    await page.evaluate(()=>window.__catalogActiveDelete.addLongActiveSessions(24));await more('.proj-row-wrap','orbit-web');await choose('删除');
    const dialog=page.getByRole('dialog'),body=dialog.locator('.dlg-body'),footer=dialog.locator('.dlg-foot');await dialog.getByText('此范围内有 24 个活动会话').waitFor();const [bodyBox,footerBox]=await Promise.all([body.boundingBox(),footer.boundingBox()]);assert.ok((bodyBox?.height??0)>0&&body.evaluate(element=>element.scrollHeight>element.clientHeight));assert.ok((footerBox?.y??Infinity)+(footerBox?.height??0)<=900);await confirm('取消');
  });
  await page.screenshot({path:join(out,'complete.png'),animations:'disabled'});
}catch(error){report.errors.push(error.stack??String(error));}
finally{clearTimeout(deadline);await app?.close().catch(()=>{});await server?.close();report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,report},null,2));if(report.errors.length)process.exitCode=1;}
