import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..');
const runId=new Date().toISOString().replace(/[:.]/g,'-'),out=join(here,'results','parity-actions',runId);
const report={startedAt:new Date().toISOString(),checks:[],errors:[]};
const note=(name,detail={})=>report.checks.push({name,...detail});
const openedApps=[];
const phase=name=>{report.phase=name;console.log(`[parity-actions] ${name}`);};
async function open(profile){phase(`launch ${profile}`);const app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:10000});openedApps.push(app);const page=await app.firstWindow({timeout:10000});page.setDefaultTimeout(10000);return {app,page};}
async function screenshot(page,name){await page.screenshot({path:join(out,`${name}.png`),animations:'disabled'});}
function fixtureExtensions(){
 const prior=window.threadterm.request.bind(window.threadterm),calls=window.__parityFixture.calls;
 window.threadterm.request=async(method,params)=>{try{return await prior(method,params);}catch(error){
  if(method==='settings.export')return {marker:'threadterm-v3-settings',version:1,theme:'light',language:'zh-CN'};
  if(method==='settings.import.preview'){try{JSON.parse(params.bundle);}catch{return {valid:false,issues:['Invalid JSON'],currentRevision:1,changes:[]};}return {valid:true,issues:[],currentRevision:1,changes:[{key:'theme',current:'light',incoming:'dark'}]};}
  if(method==='settings.import.apply')return window.threadterm.request('settings.update',{patch:{theme:'dark'},expectedRevision:params.expectedRevision,operationId:params.operationId});
  if(method==='data.relocation.cancel')return null;
  throw error;
 }};
 window.threadterm.chooseSavePath=async()=>null; window.threadterm.chooseDirectory=async()=>null;
 window.__parityFixture.actionCalls=calls;
}
async function run(){await mkdir(out,{recursive:true});const scratch=await mkdtemp(join(tmpdir(),'tt-actions-'));let server,prodServer,app;const deadline=setTimeout(()=>{report.errors.push('Hard deadline exceeded after 45 seconds.');for(const value of openedApps)void value.close().catch(()=>{});},120000);
 try{phase('start reference server');server=await startReadonlyReferenceServer(join(root,'reference'));const ref=await open(join(scratch,'ref'));await ref.page.goto(server.origin+'/prototype/',{timeout:10000});await ref.page.waitForFunction(()=>!!window.ThreadTermPrototype);const seed=await ref.page.evaluate(()=>{const a=window.ThreadTermPrototype;return {projects:a.projects,trees:a.trees,sessions:a.sessions(),store:a.store,fileContents:Object.fromEntries(Object.entries(a.projects).map(([id,p])=>[id,Object.fromEntries(p.files.map((path,i)=>[path,a.fileValue(a.sessions().find(x=>x.project===id),i)]))]))};});await ref.app.close();
  const prod=await open(join(scratch,'prod'));app=prod.app;const {page}=prod;await page.addInitScript(installVisualFixture,{seed,theme:'light'});await page.addInitScript(fixtureExtensions);prodServer=await startReadonlyReferenceServer(join(root,'desktop-dist/renderer'));phase('load production renderer');await page.goto(prodServer.origin+'/?theme=light',{timeout:10000});await page.locator('.proj-row').first().waitFor();
  const user=page.locator('.user-row');await user.focus();await user.press('Enter');await page.locator('.account-menu').waitFor();assert.equal(await page.locator('.account-menu').isVisible(),true);await page.keyboard.press('Escape');await assert.rejects(page.locator('.account-menu').waitFor({state:'visible',timeout:250}));assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('user-row')),true);note('account-menu-escape-focus');
  await page.getByLabel(/command palette|命令面板/i).click();const palette=page.locator('.palette');await palette.locator('input').fill('orbit');assert.ok(await palette.locator('.cmd-row').count()>0);await palette.locator('input').press('ArrowDown');await palette.locator('input').press('Escape');await assert.rejects(palette.waitFor({state:'visible',timeout:250}));note('palette-filter-navigation-escape');
  await user.click();await page.locator('.account-menu').getByText(/settings|设置/i).click();const settings=page.locator('.settings-panel');await settings.waitFor();await settings.getByRole('tab',{name:/appearance|外观/i}).click();await settings.locator('.theme-choice').filter({hasText:/dark|深色/i}).click();await page.waitForFunction(()=>window.__parityFixture.calls.some(x=>x.method==='settings.update'&&x.params.patch.theme==='dark'));await settings.getByText(/import theme|导入主题/i).click();await page.locator('.runtime-overlay .dialog').waitFor();await page.keyboard.press('Escape');await assert.rejects(page.locator('.runtime-overlay .dialog').waitFor({state:'visible',timeout:250}));assert.equal(await settings.isVisible(),true);await settings.getByRole('tab',{name:/shortcuts|快捷键/i}).click();await settings.getByText(/enable completion compatibility heuristic|启用补全兼容启发式/i).click();await page.waitForFunction(()=>window.__parityFixture.calls.some(x=>x.method==='settings.update'&&x.params.patch.terminalCompatibility));await settings.getByRole('tab',{name:/data|数据/i}).click();const downloadPath=join(out,'downloads','threadterm-settings.json');await mkdir(join(out,'downloads'),{recursive:true});await app.evaluate(({session},path)=>{globalThis.__parityDownloads=[];session.defaultSession.on('will-download',(_event,item)=>{globalThis.__parityDownloads.push({event:'will-download',name:item.getFilename()});item.setSavePath(path);item.once('done',(_done,state)=>globalThis.__parityDownloads.push({event:'done',state,path}));});},downloadPath);await settings.getByRole('button',{name:/download settings json|下载设置 json/i}).click();await page.waitForTimeout(250);const nativeDownloads=await app.evaluate(()=>globalThis.__parityDownloads);assert.ok(nativeDownloads.some(item=>item.event==='will-download'));assert.ok(nativeDownloads.some(item=>item.event==='done'&&item.state==='completed'));const bundle=JSON.parse(await readFile(downloadPath,'utf8'));assert.equal(bundle.marker,'threadterm-v3-settings');assert.equal(bundle.version,1);const ta=settings.locator('textarea').first();await ta.fill('{bad');await settings.getByText(/validate|验证/i).click();await settings.getByText(/invalid json/i).waitFor();await settings.locator('.import-preview').getByRole('button',{name:/cancel|取消/i}).click();await page.keyboard.press('Escape');await assert.rejects(settings.waitFor({state:'visible',timeout:250}));note('settings-theme-controls-export-invalid-import-cancel');
  await screenshot(page,'completed');
 }catch(error){report.errors.push(error.stack||String(error));try{if(app){const p=await app.firstWindow();await screenshot(p,'failure');}}catch{}process.exitCode=1;}finally{clearTimeout(deadline);for(const value of openedApps)await value.close().catch(()=>{});if(prodServer)await prodServer.close().catch(()=>{});if(server)await server.close().catch(()=>{});report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,report},null,2));}}
await run();
