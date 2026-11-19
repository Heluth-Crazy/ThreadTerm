import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {installVisualFixture} from './parity/fixture.mjs';
import {startReadonlyReferenceServer} from './parity/reference-server.mjs';
import {productionRenderer,visualSeed} from './parity/catalog-fixture.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const out=join(here,'results/catalog-header-menu',new Date().toISOString().replace(/[:.]/g,'-'));
const report={startedAt:new Date().toISOString(),checks:[],errors:[]};
await mkdir(out,{recursive:true});
let app,page,server;
// The seed and the renderer come first: a fresh renderer build would run into the hard deadline below.
const seed=await visualSeed(electron),renderer=await productionRenderer();
const deadline=setTimeout(()=>{report.errors.push('60s hard deadline');void app?.close().catch(()=>{});},60000);
try{
  const profile=await mkdtemp(join(tmpdir(),'threadterm-catalog-header-'));
  app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:15000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);
  await page.addInitScript(installVisualFixture,{seed,theme:'light'});
  server=await startReadonlyReferenceServer(renderer.dir);
  await page.goto(server.origin+'/?theme=light');
  await page.locator('.side-scope').waitFor();
  const head=page.locator('.catalog-head');
  assert.equal(await head.locator('.catalog-manage').count(),0,'header more button should be gone');
  assert.equal(await head.locator('.side-scope').count(),1,'header keeps the one ⋯ menu opener');
  assert.equal(await head.locator('.catalog-view-seg button').count(),2,'header adds the Projects/Recent control');
  assert.deepEqual(await head.locator('.catalog-view-seg button').allInnerTexts(),['项目','最近']);
  assert.equal(await head.locator('button').count(),3,'label, two view buttons and one menu opener');
  assert.equal(await head.locator('.side-scope .ico').count(),1,'header should keep one trailing icon');
  await head.screenshot({path:join(out,'header.png')});
  await page.locator('.side-scope').click();
  const menu=page.locator('.catalogue-popover');
  await menu.waitFor();
  const names=await menu.getByRole('menuitem').allTextContents();
  assert.ok(names.some(name=>name.includes('添加项目')),`missing add project: ${names.join('|')}`);
  assert.ok(names.some(name=>name.includes('全部项目')),`missing all projects: ${names.join('|')}`);
  assert.ok(names.some(name=>name.includes('docs-site')),`missing project list: ${names.join('|')}`);
  for(const name of ['全部收起','只展开当前','全部展开'])assert.ok(names.some(item=>item.includes(name)),`missing fold control ${name}: ${names.join('|')}`);
  await page.screenshot({path:join(out,'menu.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(),0);
  const row=page.locator('.proj-row-wrap').filter({hasText:'orbit-web'});
  await row.hover();
  assert.equal(await row.locator('.row-more').count(),1,'row more menus must stay independent');
  report.checks.push({name:'merged-project-header-menu',passed:true,items:names});
}catch(error){
  report.errors.push(error.stack??String(error));
  await page?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
}finally{
  clearTimeout(deadline);
  await app?.close().catch(()=>{});await server?.close();await renderer.cleanup();
  report.completedAt=new Date().toISOString();
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,report},null,2));
  if(report.errors.length)process.exitCode=1;
}
