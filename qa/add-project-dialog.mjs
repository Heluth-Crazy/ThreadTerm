import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {installVisualFixture} from './parity/fixture.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const out=join(here,'results/add-project-dialog',new Date().toISOString().replace(/[:.]/g,'-'));
const report={startedAt:new Date().toISOString(),checks:[],errors:[]};
await mkdir(out,{recursive:true});
let app,page;
const deadline=setTimeout(()=>{report.errors.push('60s hard deadline');void app?.close().catch(()=>{});},60000);
try{
  const seed=JSON.parse(await readFile(join(here,'results/parity/2026-09-10T14-50-58-408Z/visual-fixture.json'),'utf8'));
  const profile=await mkdtemp(join(tmpdir(),'threadterm-add-project-'));
  app=await electron.launch({args:[join(here,'parity/electron-static.cjs')],env:{...process.env,TT_PARITY_PROFILE:profile},timeout:15000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);
  await page.addInitScript(installVisualFixture,{seed,theme:'light'});
  await page.goto('http://127.0.0.1:5173/?theme=light');
  await page.locator('.side-scope').waitFor();
  await page.locator('.side-scope').click();
  await page.getByRole('menuitem',{name:'添加项目'}).click();
  const dialog=page.getByRole('dialog',{name:'添加项目'});
  await dialog.waitFor();
  assert.ok(await dialog.evaluate(node=>node.classList.contains('create-dlg')),'dialog should use create-dlg');
  assert.equal(await dialog.locator('.dialog-form').count(),0);
  assert.equal(await dialog.locator('.create-browse').count(),1);
  assert.equal(await dialog.locator('.dlg-foot .btn-primary').count(),1);
  await dialog.getByText('目录路径').waitFor();
  await dialog.getByText('显示名称').waitFor();
  await page.screenshot({path:join(out,'dialog.png'),animations:'disabled'});
  report.checks.push({name:'add-project-create-dialog',passed:true});
}catch(error){
  report.errors.push(error.stack??String(error));
  await page?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
}finally{
  clearTimeout(deadline);
  await app?.close().catch(()=>{});
  report.completedAt=new Date().toISOString();
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,report},null,2));
  if(report.errors.length)process.exitCode=1;
}
