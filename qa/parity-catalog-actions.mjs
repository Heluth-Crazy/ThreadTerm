import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {startReadonlyReferenceServer} from './parity/reference-server.mjs';
import {installVisualFixture} from './parity/fixture.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..');
const out=join(here,'results/parity-catalog-actions',new Date().toISOString().replace(/[:.]/g,'-'));
const report={startedAt:new Date().toISOString(),staticFixture:true,checks:[],errors:[]};
function extendCatalog(){
  const prior=window.threadterm.request.bind(window.threadterm),priorSubscribe=window.threadterm.onEvent.bind(window.threadterm);
  const listeners=new Set(),visibility=[],metadata=new Map();let sequence=0;
  window.threadterm.onEvent=fn=>{listeners.add(fn);const unsubscribe=priorSubscribe(fn);return()=>{listeners.delete(fn);unsubscribe();};};
  const changed=()=>listeners.forEach(fn=>fn({v:1,event:'state.changed',epoch:'visual-fixture',seq:++sequence,data:{kind:'catalog.visibility'}}));
  window.threadterm.request=async(method,params)=>{
    if(method==='catalog.visibility.list'){window.__parityFixture.calls.push({method,params});return structuredClone(visibility);}
    if(method==='project.update'){
      window.__parityFixture.calls.push({method,params});
      const project=(await prior('project.catalog.list',{})).find(row=>row.id===params.id),current={...project,...metadata.get(params.id)};
      assertRevision(params.expectedRevision,current.revision);
      const next={...current,...params,revision:current.revision+1};metadata.set(params.id,next);changed();return next;
    }
    if(method==='catalog.visibility.update'){
      window.__parityFixture.calls.push({method,params});
      const current=visibility.find(row=>row.id===params.id&&row.kind===params.kind),data=await prior('runtime.snapshot',{});
      assertRevision(params.expectedRevision,current?.revision??0);
      const session=data.sessions.find(row=>row.id===params.id),trees=(await Promise.all(data.projects.map(project=>prior('worktree.list',{projectId:project.id})))).flat(),tree=trees.find(row=>row.id===params.id);
      const scope=params.kind==='session'?[session]:params.kind==='project'?data.sessions.filter(row=>row.projectId===params.id):data.sessions.filter(row=>row.projectId===tree?.projectId&&row.worktreePath===tree?.path);
      if(params.visibility!=='active'&&scope.some(row=>row&&!row.readOnly&&['starting','running','idle','waiting'].includes(row.status)))throw new Error('end_active_sessions_before_changing_catalog_visibility');
      const next={kind:params.kind,id:params.id,visibility:params.visibility,revision:(current?.revision??0)+1,...(params.kind==='session'?{projectId:session.projectId,worktreePath:session.worktreePath}:params.kind==='worktree'?{projectId:tree.projectId,worktreePath:tree.path}:{})};
      if(current)Object.assign(current,next);else visibility.push(next);changed();return structuredClone(next);
    }
    const result=await prior(method,params);
    if(method==='project.catalog.list')return result.map(row=>({...row,...metadata.get(row.id)}));
    if(method==='runtime.snapshot')return {...result,projects:result.projects.map(row=>({...row,...metadata.get(row.id)}))};
    return result;
  };
  function assertRevision(expected,current){if(expected!==current)throw new Error('revision_conflict');}
}

await mkdir(out,{recursive:true});let app,server,page;
const deadline=setTimeout(()=>{report.errors.push('240s hard deadline');void app?.close().catch(()=>{});},240000);
async function caseOf(name,action){const only=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);if(only&&name!==only)return;console.log(name+': starting');try{await action();report.checks.push({name,passed:true});console.log(name+': passed');}catch(error){report.checks.push({name,passed:false,error:String(error)});report.errors.push(name);await page.screenshot({path:join(out,name+'-failure.png')}).catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});}}
try{
  const seed=JSON.parse(await readFile(join(here,'results/parity/2026-09-10T14-50-58-408Z/visual-fixture.json'),'utf8'));
  const profile=await mkdtemp(join(tmpdir(),'threadterm-catalog-static-'));
  app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:15000});
  page=await app.firstWindow();page.setDefaultTimeout(6000);
  await page.addInitScript(installVisualFixture,{seed,theme:'light'});await page.addInitScript(extendCatalog);
  server=await startReadonlyReferenceServer(join(root,'desktop-dist/renderer'));await page.goto(server.origin+'/?theme=light');await page.locator('.proj-row').first().waitFor();
  const menu=()=>page.locator('.catalogue-popover');
  const more=async(selector,title)=>{const row=page.locator(selector).filter({hasText:title});await row.hover();await row.locator('.row-more').click();await menu().waitFor();};
  const choose=async(name)=>menu().getByRole('menuitem',{name,exact:true}).click();
  const confirm=async(name)=>page.getByRole('dialog').getByRole('button',{name,exact:true}).click();
  await caseOf('project-menu-keyboard-and-rename',async()=>{
    await more('.proj-row-wrap','orbit-web');await page.keyboard.press('ArrowDown');assert.ok(await menu().locator(':focus').count());await page.keyboard.press('Escape');assert.equal(await menu().count(),0);assert.ok(await page.locator('.row-more:focus').count());
    await more('.proj-row-wrap','orbit-web');await choose('重命名项目');await page.getByRole('dialog').locator('input').fill('orbit-renamed');await confirm('保存');await page.locator('.proj-row').filter({hasText:'orbit-renamed'}).waitFor();
  });
  await caseOf('active-session-archive-rejected',async()=>{
    await more('.sess-row-wrap','开发服务器');await choose('归档');await confirm('确认归档');await page.getByRole('dialog').getByRole('alert').filter({hasText:'请先结束'}).waitFor();await confirm('取消');assert.equal(await page.locator('.sess-row').filter({hasText:'开发服务器'}).count(),1);
  });
  await caseOf('session-archive-and-parent-restore',async()=>{
    await more('.sess-row-wrap','依赖升级巡检');await choose('归档');await confirm('确认归档');await page.locator('.sess-row').filter({hasText:'依赖升级巡检'}).waitFor({state:'detached'});
    const tree=page.locator('.proj-group').filter({has:page.locator('.proj-row').filter({hasText:'orbit-renamed'})}).locator('.tree-row-wrap').first();await tree.hover();await tree.locator('.row-more').click();await menu().getByRole('menuitem').filter({hasText:'依赖升级巡检'}).click();await page.locator('.sess-row').filter({hasText:'依赖升级巡检'}).waitFor();
  });
  await caseOf('tree-archive-and-project-restore',async()=>{
    await more('.tree-row-wrap','chore/demo-clean');await choose('归档');await confirm('确认归档');await page.locator('.tree-row').filter({hasText:'chore/demo-clean'}).waitFor({state:'detached'});
    await more('.proj-row-wrap','orbit-renamed');await menu().getByRole('menuitem').filter({hasText:'chore/demo-clean'}).click();await page.locator('.tree-row').filter({hasText:'chore/demo-clean'}).waitFor();
  });
  await caseOf('project-archive-global-filter-and-scope-restore',async()=>{
    await more('.proj-row-wrap','docs-site');await choose('归档');await confirm('确认归档');await page.locator('.proj-row').filter({hasText:'docs-site'}).waitFor({state:'detached'});
    await page.locator('.side-nav button').filter({hasText:'所有终端'}).click();await page.getByRole('button',{name:'终端页选项',exact:true}).click();await page.locator('.terminals-page-menu [role="combobox"]').click();await page.locator('.tt-select-menu [role="option"][data-value="archived"]').click();await page.getByRole('button',{name:'终端页选项',exact:true}).click();await page.locator('.t-card').filter({hasText:'navigation information architecture'}).waitFor();assert.equal(await page.locator('.t-card').filter({hasText:'navigation information architecture'}).count(),1);
    await page.locator('.side-scope').click();await menu().getByRole('menuitem').filter({hasText:'docs-site'}).click();await page.locator('.proj-row').filter({hasText:'docs-site'}).waitFor();
  });
  await caseOf('dirty-project-archive-preserves-draft',async()=>{
    await page.locator('.proj-row').filter({hasText:'docs-site'}).click();await page.getByRole('button',{name:'项目操作',exact:true}).click();await page.locator('.project-tools-menu').getByRole('button',{name:'浏览文件',exact:true}).click();
    // Standalone Files opens with its tools column (the shared workbench Explorer), so there is no empty-state
    // Browse files button any more; tree rows are treeitems and folders carry aria-expanded.
    const tree=page.locator('.tt-file-tree .wb-tree');await tree.locator('[role=treeitem]').first().waitFor();
    const file=tree.locator('[role=treeitem]:not([aria-expanded])');
    for(let attempt=0;attempt<10&&!await file.count();attempt++){await tree.locator('[role=treeitem][aria-expanded="false"]').first().click();await page.waitForTimeout(250);}
    await file.first().click();const editor=page.locator('.tt-editor-shell .cm-content');await editor.waitFor();await editor.click();await page.keyboard.press('Control+End');await page.keyboard.type(' QA_CATALOG_DRAFT');await page.locator('[data-testid="editor-dirty"]:not([hidden])').waitFor();
    const before=await page.evaluate(()=>window.__parityFixture.calls.filter(call=>call.method==='catalog.visibility.update').length);
    await more('.proj-row-wrap','docs-site');await choose('归档');await confirm('确认归档');await page.getByRole('dialog').getByRole('alert').filter({hasText:'保存或关闭'}).waitFor();await confirm('取消');
    assert.ok((await editor.innerText()).includes('QA_CATALOG_DRAFT'));assert.equal(await page.evaluate(()=>window.__parityFixture.calls.filter(call=>call.method==='catalog.visibility.update').length),before);
    await page.screenshot({path:join(out,'dirty-draft-preserved.png')});await page.reload();await page.locator('.proj-row').first().waitFor();
  });
  await caseOf('delete-only-catalogue-record',async()=>{
    await more('.sess-row-wrap','依赖升级巡检');await choose('删除');await confirm('确认删除');await page.locator('.sess-row').filter({hasText:'依赖升级巡检'}).waitFor({state:'detached'});
    const calls=await page.evaluate(()=>window.__parityFixture.calls);assert.ok(calls.some(call=>call.method==='catalog.visibility.update'&&call.params.visibility==='removed'));assert.ok(!calls.some(call=>['project.remove','worktree.remove','filesystem.write','session.stop'].includes(call.method)));
  });
  await page.screenshot({path:join(out,'complete.png'),animations:'disabled'});
}catch(error){report.errors.push(error.stack??String(error));}
finally{clearTimeout(deadline);await app?.close().catch(()=>{});await server?.close();report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,report},null,2));if(report.errors.length)process.exitCode=1;}
