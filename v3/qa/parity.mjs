import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';
import { compareMetrics, metricScript, selectorGroups } from './parity/metrics.mjs';
const here=dirname(fileURLToPath(import.meta.url)),v3Root=resolve(here,'..'),resultRoot=resolve(here,'results/parity');
const referenceOnly=process.argv.includes('--reference-only'),quick=process.argv.includes('--quick');
const viewports=quick?[[1440,900]]:[[1280,800],[1440,900],[1920,1080]],themes=quick?['light']:['light','dark'];
const routeArg=process.argv.find(value=>value.startsWith('--routes='));
const routes=routeArg?routeArg.slice(9).split(','):['project','terminals','inbox','settings'];
const runId=new Date().toISOString().replace(/[:.]/g,'-'),runRoot=join(resultRoot,runId);
const report={startedAt:new Date().toISOString(),visualFixture:true,backendVerified:false,scenarios:[],notes:[
  'Both legs use QA-only electron-static.cjs, which never loads production main/preload or any runtime.',
  'Production uses its actual built renderer with a QA-only memory bridge populated from the reference fixture. No production database is read or written.',
  'Reference normalization changes only the outer mock desktop/window. Production hides functional native titlebar for equal content-area comparison.',
  'Usage/native history remain empty in the visual fixture; their data values are excluded from equality claims.',
  'No aggregate percentage or automatic visual parity approval. Paired screenshots require visual review.'
]};
async function runBuild(){await new Promise((done,fail)=>{const p=spawn('npm',['run','build:renderer'],{cwd:v3Root,shell:process.platform==='win32',stdio:'inherit'});p.once('error',fail);p.once('exit',code=>code===0?done():fail(new Error('Renderer build failed: '+code)));});}
async function openStatic(profile){const app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:30000});return {app,page:await app.firstWindow()};}
const referenceFrame=`html,body,.desktop{width:100%!important;height:100%!important;overflow:hidden!important}.desktop{padding:0!important;background:none!important}.app-window{width:100%!important;max-width:none!important;height:100%!important;max-height:none!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important}.app-chrome{display:none!important}.app-stage{width:100%!important;max-width:none!important;height:100%!important}`;
const productionFrame=`.titlebar.app-chrome{display:none!important}.app-shell{grid-template-rows:minmax(0,1fr) 24px!important}.app-shell>.sidebar,.app-shell>.content.main{grid-row:1!important}.app-shell>.statusbar{grid-row:2!important}`;
async function referenceRoute(page,route,theme){
  await page.evaluate(({route,theme})=>{const api=window.ThreadTermPrototype;api.setTheme(theme);api.navigate(route==='terminals'?'#/terminals':route==='inbox'?'#/inbox':route.startsWith('workspace')?'#/workspace/orbit-shell':route==='presets'?'#/presets':route==='workbench'?'#/workbench':'#/project/orbit');},{route,theme});
  if(route.startsWith('settings')){await page.locator('.user-row[data-action="open-settings"]').click();await page.locator('[data-action="settings-open"]').click();await page.locator('.settings-panel').waitFor();await page.locator(`[data-action="settings-theme"][data-theme="${theme}"]`).click();if(route.includes('-'))await page.locator(`[data-action="settings-section"][data-section="${route.split('-')[1]}"]`).click();}
  if(route==='workspace-file'||route==='workspace-diff')await page.locator(`[data-action="ws-tab"][data-tab="${route.split('-')[1]}"]`).click();
  if(route==='creator')await page.locator('[data-action="open-create"]').first().click();
  if(route==='usage')await page.locator('[data-action="usage-details"]').click();
  if(route==='follow')await page.locator('[data-action="follow-add"]').click();
  if(route==='worktree')await page.locator('[data-action="new-tree"]').first().click();
}
async function productionRoute(page,route){
  if(route==='project'||route.startsWith('settings')||['usage','follow','worktree','creator'].includes(route))await diagnosticClick(page,page.locator('.proj-row').filter({hasText:'orbit-web'}));
  if(route==='terminals')await page.locator('.side-nav button').filter({hasText:'所有终端'}).click();
  if(route==='inbox')await diagnosticClick(page,page.locator('.side-nav button').filter({hasText:/收件箱|待处理/}).first());
  if(route.startsWith('settings')){await page.locator('.user-row').click();await page.locator('.account-menu .menu-item').filter({hasText:'设置'}).click();await page.locator('.settings-panel').waitFor();if(route.includes('-')){const names={controls:'快捷键',data:'数据',mobile:'移动',tools:'工具'};await page.locator('.settings-layout nav button').filter({hasText:names[route.split('-')[1]]}).click();}}
  if(route.startsWith('workspace')){await page.locator('.sess-row').filter({hasText:'开发服务器'}).click();await page.locator('.session-screen').waitFor();if(route.includes('-'))await page.locator('.ws-tabrow .tab').nth(route.endsWith('file')?1:2).click();}
  if(route==='presets')await page.locator('.side-nav button').filter({hasText:'工作预设'}).click();
  if(route==='creator')await page.locator('.nav-item.new').click();
  if(route==='usage')await page.locator('.usage-card-head .brief-head-btn').click();
  if(route==='follow')await page.locator('.brief-focus .brief-head-btn').click();
  if(route==='worktree')await page.locator('.page-actions button').filter({hasText:'新建工作树'}).click();
}
async function diagnosticClick(page,locator){try{await locator.click({timeout:2500});}catch(error){report.scenarios.at(-1).interactionErrors??=[];report.scenarios.at(-1).interactionErrors.push(error.message);await locator.evaluate(node=>node.click());}}
async function capture(page,path){await page.evaluate(()=>document.fonts.ready);await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});await page.screenshot({path,animations:'disabled'});const metrics=await page.evaluate(metricScript(),{selectors:selectorGroups});await writeFile(path.replace(/\.png$/,'.dom.json'),JSON.stringify(await page.evaluate(()=>({title:document.title,buttons:Array.from(document.querySelectorAll('button')).filter(n=>n.getClientRects().length).map(n=>({text:n.innerText,label:n.getAttribute('aria-label'),action:n.dataset.action,tab:n.dataset.tab})),text:document.body.innerText})),null,2));return metrics;}
await mkdir(join(runRoot,'reference'),{recursive:true});await mkdir(join(runRoot,'production'),{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'threadterm-static-parity-'));report.scratch=scratch;
let server,app,prodServer,prodApp;
try{
  if(process.argv.includes('--build')&&!referenceOnly)await runBuild();
  server=await startReadonlyReferenceServer(join(v3Root,'reference'));
  let refPage;({app,page:refPage}=await openStatic(join(scratch,'reference-profile')));
  await refPage.addInitScript(()=>localStorage.setItem('threadterm.app.v3',JSON.stringify({welcomeSeen:true,theme:'light'})));
  await refPage.goto(server.origin+'/prototype/');await refPage.waitForFunction(()=>!!window.ThreadTermPrototype);
  const seed=await refPage.evaluate(()=>{const api=window.ThreadTermPrototype;return {projects:api.projects,trees:api.trees,sessions:api.sessions(),store:api.store,fileContents:Object.fromEntries(Object.entries(api.projects).map(([id,p])=>[id,Object.fromEntries(p.files.map((path,index)=>[path,api.fileValue(api.sessions().find(item=>item.project===id),index)]))]))};});
  await writeFile(join(runRoot,'visual-fixture.json'),JSON.stringify(seed,null,2));
  let prodPage;
  if(!referenceOnly){prodServer=await startReadonlyReferenceServer(join(v3Root,'desktop-dist/renderer'));({app:prodApp,page:prodPage}=await openStatic(join(scratch,'production-profile')));await prodPage.addInitScript(installVisualFixture,{seed,theme:'light'});}
  for(const [width,height]of viewports)for(const theme of themes)for(const route of routes){
    const name=`${route}-${theme}-${width}x${height}.png`,scenario={route,theme,viewport:{width,height},reference:null,production:null,deviations:[]};report.scenarios.push(scenario);
    await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
    await refPage.goto(server.origin+'/prototype/');await refPage.waitForFunction(()=>!!window.ThreadTermPrototype);await refPage.addStyleTag({content:referenceFrame});await referenceRoute(refPage,route,theme);
    scenario.reference={screenshot:'reference/'+name,metrics:await capture(refPage,join(runRoot,'reference',name))};
    if(prodPage){
      await prodApp.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
      const errors=[],onError=e=>errors.push(e.message);prodPage.on('pageerror',onError);
      await prodPage.goto(prodServer.origin+'/?theme='+theme);await prodPage.addStyleTag({content:productionFrame});await prodPage.locator('.proj-row').first().waitFor();await prodPage.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await productionRoute(prodPage,route);
      scenario.production={screenshot:'production/'+name,metrics:await capture(prodPage,join(runRoot,'production',name)),errors,calls:await prodPage.evaluate(()=>window.__parityFixture.calls)};prodPage.off('pageerror',onError);scenario.deviations=compareMetrics(scenario.reference.metrics,scenario.production.metrics);
    }
    console.log(JSON.stringify({route,theme,width,height,deviations:scenario.deviations.length}));
  }
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{
  // Profiles stay available for inspection. This harness cannot start a daemon.
  if(prodApp)await prodApp.close().catch(()=>{});if(app)await app.close().catch(()=>{});if(prodServer)await prodServer.close();if(server)await server.close();
  report.completedAt=new Date().toISOString();await writeFile(join(runRoot,'parity-report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(resultRoot,'latest.json'),JSON.stringify({runId,report:join(runId,'parity-report.json')},null,2)+'\n');console.log(JSON.stringify({runRoot,error:report.error},null,2));
}
