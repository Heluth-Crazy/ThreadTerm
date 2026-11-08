// Focused browser QA for provider-driven mobile chat options using the isolated injected Expo app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root=process.cwd(), app=join(root,'mobile','qa','app'), out=join(app,'.qa-export'), shots=join(root,'.trellis','tasks','11-06-mobile-companion','qa-chat-options');
mkdirSync(shots,{recursive:true});
execFileSync(process.platform==='win32'?'cmd.exe':'npx',process.platform==='win32'?['/d','/s','/c','npx expo export --platform web --output-dir .qa-export']:['expo','export','--platform','web','--output-dir','.qa-export'],{cwd:app,stdio:'inherit',windowsHide:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2'};
const server=createServer((req,res)=>{const path=new URL(req.url??'/','http://qa').pathname;const file=normalize(join(out,path==='/'?'index.html':path.slice(1)));if(!file.startsWith(out)||!existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('content-type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:390,height:844},colorScheme:'light',locale:'en-US'}),errors=[];
page.setDefaultTimeout(12_000);page.on('pageerror',error=>errors.push(String(error)));
const overflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${label}: horizontal overflow`);
const shot=name=>page.screenshot({path:join(shots,name),fullPage:true,animations:'disabled'});
const calls=()=>page.evaluate(()=>globalThis.__TT_MOBILE_QA_CALLS__);
async function settleSheet(title) {
  const heading=page.getByText(title,{exact:true}).last();await heading.waitFor();
  await page.waitForTimeout(500);
  const before=await heading.boundingBox();
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const after=await heading.boundingBox();
  assert.ok(before&&after&&Math.abs(before.y-after.y)<1,`${title}: sheet animation settled`);
}
async function openChat(machine,project,session) {
  await page.getByRole('tab',{name:'Projects'}).click();
  await page.getByRole('button',{name:machine}).click();
  await page.getByRole('button',{name:project}).click();
  await page.getByRole('button',{name:session}).click();
  await page.getByRole('button',{name:'Session options'}).waitFor();
}
try {
  await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'networkidle'});
  await openChat('Control PC','Project alpha','Review alpha');
  await page.getByRole('button',{name:'Session options'}).click();
  await settleSheet('Session options');
  await page.getByText('Locked — unlock to change options.',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('radio',{name:'gpt-5.4',exact:true}).isDisabled(),true,'locked choices are disabled');
  await page.getByRole('button',{name:'Close'}).click();
  await page.getByRole('button',{name:'Close'}).waitFor({state:'hidden'});
  await page.waitForTimeout(350);
  await page.getByRole('button',{name:'Unlock'}).click();
  await page.getByRole('button',{name:'Session options'}).waitFor();
  await overflow('control composer');await shot('01-control-composer.png');
  await page.getByRole('button',{name:'Session options'}).click();
  await settleSheet('Session options');
  await page.getByRole('radio',{name:'gpt-5.4',exact:true}).waitFor();
  await overflow('control options');await shot('02-control-options.png');
  await page.getByRole('radio',{name:'gpt-5.3-codex',exact:true}).click();
  await page.getByRole('button',{name:'Session options'}).click();
  await settleSheet('Session options');
  await page.getByRole('radio',{name:'High',exact:true}).click();
  await page.getByRole('button',{name:'Session options'}).click();
  await settleSheet('Session options');
  await page.getByRole('radio',{name:'On',exact:true}).click();
  await page.waitForFunction(()=>globalThis.__TT_MOBILE_QA_CALLS__.filter(call=>call.method==='chat.option.set').length===3);
  const updates=(await calls()).filter(call=>call.method==='chat.option.set');
  assert.deepEqual(updates.map(call=>[call.id,call.params.sessionId,call.params.optionId,call.params.value,call.params.leaseEpoch]),[
    ['alpha','same-chat','model','gpt-5.3-codex',1],['alpha','same-chat','thinking','high',1],['alpha','same-chat','fast','true',1],
  ]);
  await page.getByRole('button',{name:'Session options'}).waitFor();
  await page.getByText('gpt-5.3-codex · High',{exact:true}).waitFor();

  await page.getByRole('button',{name:'Back'}).click();
  await page.getByRole('button',{name:'Back'}).click();
  await page.getByRole('button',{name:'Back'}).click();
  await openChat('Readonly PC','Project beta','Review beta');
  await page.getByRole('button',{name:'Session options'}).click();
  await settleSheet('Session options');
  await page.getByText('This computer allows viewing only.',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('radio',{name:'gpt-5.4-mini',exact:true}).isDisabled(),true,'view-only choices are disabled');
  await overflow('view-only options');await shot('03-view-only-options.png');
  assert.equal((await calls()).filter(call=>call.id==='beta'&&call.method==='chat.option.set').length,0,'view-only never dispatches an option write');

  await page.getByRole('button',{name:'Close'}).click();
  await page.getByRole('button',{name:'Close'}).waitFor({state:'hidden'});
  await page.waitForTimeout(350);
  await page.getByRole('button',{name:'Back'}).click();
  await page.getByRole('button',{name:'Back'}).click();
  await page.getByRole('button',{name:'Back'}).click();
  await page.getByRole('tab',{name:'Settings'}).click();
  await page.getByRole('button',{name:'Language'}).click();
  await page.emulateMedia({colorScheme:'dark'});
  await page.getByRole('tab',{name:'聊天'}).click();
  await page.getByRole('button',{name:'Review beta'}).click();
  await page.getByRole('button',{name:'会话选项'}).click();
  await settleSheet('会话选项');
  await page.getByText('此电脑仅允许查看。',{exact:true}).first().waitFor();
  await overflow('dark view-only options');await shot('04-dark-options-zh.png');
  await page.setViewportSize({width:375,height:844});await overflow('375 portrait');
  await page.setViewportSize({width:844,height:390});await overflow('landscape');
  assert.deepEqual(errors,[],`page errors:\n${errors.join('\n')}`);
  console.log('Mobile chat options QA passed: control model/effort/extra updates, view-only denial, dark/locale and narrow layouts.');
} catch(error) { console.error('Rendered text:',await page.locator('body').innerText());console.error('Page errors:',errors);throw error; }
finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
