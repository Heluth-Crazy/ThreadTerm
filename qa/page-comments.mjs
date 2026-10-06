// Real-app check of task 10-05-page-comments.  This deliberately uses the bundled Echo
// plugin and an isolated Electron profile: no installed agent executable can be started.
// node qa/page-comments.mjs [--rebuild] [--keep] [--scale=1.25]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const runtime=join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const keep=process.argv.includes('--keep'),delay=ms=>new Promise(done=>setTimeout(done,ms));
const scratch=await mkdtemp(join(tmpdir(),'tt-page-comments-'));
const plugins=join(scratch,'plugins'),work=join(scratch,'work'),appDir=join(root,'runtime/target-qa/page-comments-qa-app'),out=join(root,'qa/results/page-comments');
const report={passed:false,scratch,checks:[],notes:[],shots:[],errors:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
const note=text=>{report.notes.push(text);console.log(`NOTE ${text}`);};
let app,page,server;
let finalizing=false;
const failureText=error=>error instanceof Error?error.stack??error.message:String(error);
async function finalize(fatal){
 if(finalizing)return;finalizing=true;
 if(fatal){report.errors.push(failureText(fatal));report.passed=false;console.error(`FAIL ${failureText(fatal)}`);}
 await mkdir(out,{recursive:true}).catch(()=>{});
 if(page&&report.errors.length)await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});
 const cleanup=async(label,action)=>{try{await action();}catch(error){report.notes.push(`${label}: ${failureText(error)}`);}};
 if(page)await cleanup('runtime shutdown failed',()=>Promise.race([page.evaluate(()=>window.threadterm.request('runtime.shutdown',{operationId:crypto.randomUUID()})),delay(3000)]));
 else if(fatal)report.notes.push('Startup crashed before a renderer page was available; only the owned Electron child could be terminated.');
 if(app)await cleanup('owned Electron cleanup failed',async()=>{await Promise.race([app.evaluate(({app:electronApp})=>electronApp.exit(0)),delay(2000)]);await Promise.race([app.close(),delay(5000)]);try{app.process()?.kill();}catch{}});
 if(server)await cleanup('fixture server cleanup failed',()=>new Promise(done=>server.close(done)));
 if(!keep)await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:250}).catch(()=>{});
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
 if(report.passed&&!report.errors.length)console.log('PASS PAGE COMMENTS QA');else {console.log('PAGE COMMENTS QA FAILED');for(const error of report.errors)console.log(`FAIL ${error}`);}process.exitCode=report.passed&&!report.errors.length?0:1;
}
process.on('uncaughtException',error=>{void finalize(error);});
process.on('unhandledRejection',reason=>{void finalize(reason);});

async function prepare(){
 await mkdir(work,{recursive:true});cpSync(join(root,'examples/plugins/echo-acp'),join(plugins,'echo-acp'),{recursive:true});
 await writeFile(join(work,'preview.html'),'<!doctype html><title>Address preview fixture</title><p>Open Preview, then enter the local service address.</p>\n');
 if(process.argv.includes('--rebuild')||!existsSync(join(appDir,'renderer','index.html'))){
  console.log('building page-comments QA bundle…');await mkdir(appDir,{recursive:true});
  for(const name of ['main','preload'])await esbuild({entryPoints:[join(root,`desktop/src/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:join(appDir,`${name}.cjs`),logLevel:'error'});
  await viteBuild({configFile:join(root,'vite.config.ts'),logLevel:'warn',build:{outDir:join(appDir,'renderer'),emptyOutDir:true}});
  await writeFile(join(appDir,'package.json'),JSON.stringify({name:'threadterm-v3-page-comments-qa',version:'0.1.0',main:'main.cjs'}));
 }else console.log(`reusing ${appDir} (--rebuild after renderer/desktop changes)`);
 server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<!doctype html><title>Page comments QA</title><style>body{font:16px system-ui;margin:0;padding:36px;background:#f2f7ff}#counter{margin:18px 0;padding:14px 22px}.card{width:440px;height:180px;padding:24px;background:white;border:1px solid #abc}</style><h1>Shop app</h1><button id=counter onclick="document.querySelector('#count').textContent=String(+document.querySelector('#count').textContent+1)">Save changes</button><span id=count>0</span><div class=card data-inspector-relative-path="src/Card.tsx" data-inspector-line="27" data-inspector-column="4">Checkout card</div><input id=secret type=password value="do-not-leak-page-comment-secret"><div id=svelte>Meta target</div><script>document.querySelector('#svelte').__svelte_meta={loc:{file:'src/App.svelte',line:12,column:3}}</script>`);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
}
const request=(method,params={})=>page.evaluate(([method,params])=>window.threadterm.request(method,params),[method,params]);
async function until(test,label,timeout=30000){const end=Date.now()+timeout;for(;;){try{const value=await test();if(value)return value;}catch{}if(Date.now()>end)throw Error(`Timed out: ${label}`);await delay(200);}}
const shot=async name=>{await delay(200);await page.screenshot({path:join(out,name)});report.shots.push(name);};
const visible=selector=>page.locator(`.pane-tab-surface:not([hidden]) ${selector}`);
const strip=()=>page.locator('.pane-tab-surface:not([hidden]) .wb-review-comments').first();
const composer=id=>page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
async function enableEcho(){const listed=await request('plugin.list');const echo=listed.plugins.find(item=>item.id==='echo-acp');assert.ok(echo,'Echo plugin must be discovered');if(!echo.enabled)await request('plugin.setEnabled',{pluginId:'echo-acp',enabled:true,operationId:randomUUID()});await until(async()=> (await request('provider.list')).some(item=>item.id==='echo'),'Echo provider');}
async function openWebFromChat(chat,url){
 await composer(chat.id).fill(`Open ${url}`);await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-send[type=submit]`).click();
 await until(async()=> (await page.locator(`[data-testid="session-chat-${chat.id}"] .v3-chat-message.assistant`).allInnerTexts()).some(text=>text.includes(url)),'Echo URL reply');
 const link=page.locator(`[data-testid="session-chat-${chat.id}"] .v3-chat-message.assistant a[href="${url}"]`).last();await link.click();
 await page.getByRole('menuitem',{name:'Open in preview',exact:true}).click();const preview=page.locator('.wb-web-preview:visible').last();await preview.waitFor();await preview.locator('iframe').waitFor();return preview;
}
async function beginComment(host){const button=host.getByRole('button',{name:/^(Comment|评论)$/}).first();await button.waitFor();const iframe=host.locator('iframe').last(),name=await iframe.getAttribute('name');assert.match(name??'',/^tt-preview-/,'preview uses a stable picker frame name');await button.click();await until(async()=>await host.getByRole('button',{name:/^(Cancel|取消)$/}).count()===1,'renderer picker state');await host.locator('.wb-page-comment-hint').waitFor();await until(async()=>await page.frameLocator(`iframe[name="${name}"]`).locator('html').evaluate(()=>Boolean(window[Symbol.for('threadterm.pagePicker')])),'desktop picker controller installation');return {iframe,name};}
async function pointInFrame(name,selector){const target=page.frameLocator(`iframe[name="${name}"]`).locator(selector);await target.scrollIntoViewIfNeeded();const point=await target.boundingBox();assert.ok(point,`fixture target ${selector} must be visible inside iframe`);return {x:point.x+point.width/2,y:point.y+point.height/2};}
async function clickTarget(name,selector){const point=await pointInFrame(name,selector);await page.mouse.click(point.x,point.y);}
async function hoverTarget(name,selector){const point=await pointInFrame(name,selector);await page.mouse.move(point.x,point.y);return point;}
async function dragInFrame(iframe,a,b){const box=await iframe.boundingBox();assert.ok(box,'iframe must be visible');await page.mouse.move(box.x+a.x,box.y+a.y);await page.mouse.down();await page.mouse.move(box.x+b.x,box.y+b.y,{steps:8});await page.mouse.up();}
async function addPicked(host,body){const form=host.locator('.wb-page-comment-form, .wb-review-comment-form').filter({has:page.locator('textarea')}).last();await form.waitFor();assert.ok(await form.locator('img').count()>0,'page form renders thumbnail');await form.locator('textarea').fill(body);await form.locator('textarea').press('Control+Enter');await until(async()=>await form.count()===0,'page comment form closes');}
async function pageComment(host,{selector,area=false,body}){const preview=await beginComment(host);if(area)await dragInFrame(preview.iframe,{x:80,y:170},{x:320,y:300});else {assert.ok(selector,'element comment needs a fixture selector');await clickTarget(preview.name,selector);}await addPicked(host,body);return preview;}
const storedComments=()=>page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('threadterm.v3.file-comments:')).flatMap(([,value])=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:[];}catch{return[];}}));

try{
 assert.ok(existsSync(runtime),`missing ${runtime}; build runtime/target-qa first`);assert.ok(existsSync(join(root,'examples/plugins/echo-acp/threadterm-plugin.json')),'missing Echo fixture');
 await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});await prepare();
 const url=`http://127.0.0.1:${server.address().port}/page.html`;
 const dropped=/^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!dropped.test(name)));
 Object.assign(env,{Path:[dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:`\\\\.\\pipe\\tt-page-comments-${randomUUID()}`,THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_PLUGIN_DIRS:plugins,THREADTERM_CLAUDE_NODE:process.execPath,THREADTERM_ECHO_STORE_DIR:join(scratch,'echo')});
 const scale=process.argv.find(arg=>arg.startsWith('--scale='))?.slice(8)??'1';assert.ok(['1','1.25'].includes(scale),'supported QA scales: 1 and 1.25');
 app=await electron.launch({args:[appDir,`--force-device-scale-factor=${scale}`],cwd:root,env,timeout:60000});page=await app.firstWindow({timeout:45000});page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(`pageerror: ${error.message}`));page.on('console',message=>{if(message.type()==='error')report.errors.push(`console: ${message.text()}`);});
 await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 await enableEcho();const project=await request('project.add',{path:work,name:'Page comments QA',operationId:randomUUID()});const chat=await request('session.create',{projectId:project.id,cwd:work,title:'Echo page comments',provider:'echo',mode:'chat',operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm));await request('session.present',{sessionId:chat.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});await until(async()=>await composer(chat.id).isVisible()&&await composer(chat.id).isEnabled(),'Echo composer',60000);
 const preview=await openWebFromChat(chat,url);const frame=preview.locator('iframe');await page.frameLocator('.wb-web-preview:visible iframe').locator('#counter').waitFor();await until(async()=>await page.frameLocator('.wb-web-preview:visible iframe').locator('#svelte').evaluate(node=>Boolean(node.__svelte_meta?.loc?.file)),'fixture Svelte metadata');
 // First pick the real button, then use ↑ on that same exact target.  The mouse coordinates are obtained
 // from the iframe document, so this tests Electron's window-coordinate conversion at every DPI setting.
 await pageComment(preview,{selector:'#counter',body:'Make it the primary blue button.'});
 const directLabel=(await strip().locator('li').last().innerText()).trim();assert.match(directLabel,/Save changes|button/i,'clicking #counter labels the actual button');const directTarget=(await storedComments()).filter(item=>item.kind==='page').at(-1)?.target;
 const parentPick=await beginComment(preview);await hoverTarget(parentPick.name,'#counter');await page.keyboard.press('ArrowUp');const parentPoint=await pointInFrame(parentPick.name,'#counter');await page.mouse.click(parentPoint.x,parentPoint.y);const parentForm=preview.locator('.wb-page-comment-form').last();await parentForm.waitFor();assert.ok(await parentForm.locator('img').count()>0,'parent form renders thumbnail');await parentForm.locator('textarea').fill('Check the button container.');await parentForm.locator('textarea').press('Control+Enter');await until(async()=>await parentForm.count()===0,'parent form closes');const parentTarget=(await storedComments()).filter(item=>item.kind==='page').at(-1)?.target;assert.notDeepEqual(parentTarget,directTarget,'↑ changes the selected target to its parent');
 assert.equal(await page.frameLocator('.wb-web-preview:visible iframe').locator('#count').innerText(),'0','picker clicks never reach the button handler');check('web preview: real button picker, ↑ parent, thumbnail form, and prevented page click');
 const cancelRows=await strip().locator('li').count();await beginComment(preview);await preview.getByRole('button',{name:'Cancel',exact:true}).click();await until(async()=>await preview.getByRole('button',{name:'Comment',exact:true}).count()===1,'toolbar cancellation');assert.equal(await strip().locator('li').count(),cancelRows,'toolbar cancellation creates no comment');check('toolbar Cancel leaves picker without creating a comment');
 await pageComment(preview,{area:true,body:'Too much whitespace.'});
 await pageComment(preview,{selector:'.card',body:'Inspector source hint comment.'});
 await pageComment(preview,{selector:'#svelte',body:'Svelte source hint comment.'});
 // Keep a distinct shot solely for removal before Add to message clears the pending strip.
 await pageComment(preview,{selector:'.card',body:'Remove this screenshot before transfer.'});
 await until(async()=>await strip().locator('li').count()>=6,'page comment rows');assert.match(await strip().innerText(),/(Save changes|Area)/,'strip shows page labels');await shot('01-web-page-comments.png');check('web preview: dragged area plus inspector and Svelte targets add page comment rows');
 // Escape has to leave picker and must not create a row.
 const before=await strip().locator('.wb-page-comment-row').count();await beginComment(preview);await page.keyboard.press('Escape');await until(async()=>await preview.getByRole('button',{name:/^(Comment|评论)$/}).count()===1,'Comment button restored after Escape');assert.equal(await preview.locator('.wb-page-comment-form').count(),0,'Esc leaves no page comment form');assert.equal(await strip().locator('.wb-page-comment-row').count(),before,'Esc does not create a comment');check('Escape cancels picker');
 const lastStored=(await storedComments()).filter(item=>item.kind==='page'&&item.body==='Remove this screenshot before transfer.').at(-1);assert.ok(lastStored?.shot?.path,'removal fixture has a persisted screenshot path');assert.ok(existsSync(lastStored.shot.path),'removal fixture screenshot exists');await strip().locator('li').filter({has:page.locator('.wb-page-comment-row')}).last().getByRole('button',{name:'Remove comment',exact:true}).click();await until(async()=>!existsSync(lastStored.shot.path),'removed screenshot file');check('Remove deletes its page screenshot before transfer');
 // Flash a persisted row, then add all comments to the Echo composer and validate secure content/path handling.
 const fifthShot=(await storedComments()).filter(item=>item.kind==='page')[4]?.shot;assert.ok(fifthShot?.path,'path-only fifth screenshot exists');assert.ok(resolve(fifthShot.path).startsWith(resolve(scratch)+'\\'),'fifth screenshot belongs to QA profile');const fifthBytes=await readFile(fifthShot.path);await rm(fifthShot.path);await strip().getByRole('button',{name:'Add to message',exact:true}).click();await strip().getByRole('alert').waitFor();assert.equal(await strip().locator('li').count(),5,'missing fifth shot retains all pending comments');assert.equal(await composer(chat.id).inputValue(),'','missing path-only shot does not alter composer');await writeFile(fifthShot.path,fifthBytes);check('missing path-only fifth screenshot blocks transfer without losing comments');
 const beforeFlash=await preview.screenshot();await strip().locator('.wb-page-comment-row').first().click();await delay(120);const afterFlash=await preview.screenshot();assert.equal(beforeFlash.equals(afterFlash),false,'clicking a page row visibly flashes its open preview target');await shot('02-flash-row.png');
 const storeText=JSON.stringify(await storedComments());assert.doesNotMatch(storeText,/do-not-leak-page-comment-secret/,'password value is not stored in any page comment');assert.doesNotMatch(await page.locator('body').innerText(),/do-not-leak-page-comment-secret/,'password value is never rendered in the app UI');
 const pendingBeforeTransfer=JSON.parse(storeText).filter(comment=>comment.kind==='page');
 const contentTop=()=>page.locator('.runtime-workspace .ws-content:visible').first().evaluate(node=>node.getBoundingClientRect().top);const topBefore=await contentTop();
 await strip().getByRole('button',{name:'Add to message',exact:true}).click();await until(async()=>await composer(chat.id).isVisible()&&(await composer(chat.id).inputValue()).includes(url),'comments inserted into Echo composer');await until(async()=>await page.getByRole('status').filter({hasText:/path only|by path|截图.*路径/i}).count()>0,'path-only screenshot notice for Echo');
 assert.equal(await contentTop(),topBefore,'the path-only notice floats over the workspace instead of pushing the panes down');
 const message=await composer(chat.id).inputValue();assert.match(message,new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.match(message,/(Save changes|button)/);assert.match(message,/#counter/);assert.match(message,/src\/Card\.tsx:27/);assert.match(message,/src\/App\.svelte:12/);assert.doesNotMatch(message,/do-not-leak-page-comment-secret/);const paths=[...message.matchAll(/Screenshot:\s*(.+?\.(?:png|jpe?g))/gi)].map(match=>match[1].trim());assert.ok(paths.length>=5,'message includes every retained screenshot path');for(const path of paths){const info=await stat(path);assert.ok(info.size>200,`screenshot has plausible size: ${path}`);}check('Add to message: URL, labels, selector, both source hints and existing screenshot paths; password stays private');
 const instructionsHeading='Page comments / requested changes (match the references above):',instructionsIndex=message.indexOf(instructionsHeading);
 assert.ok(instructionsIndex>message.lastIndexOf('Screenshot:'),'all page instructions follow every screenshot reference');
 const expectedInstructions=pendingBeforeTransfer.flatMap((comment,index)=>{const [first,...rest]=comment.body.split(/\r?\n/);return [`- [P${index+1}] ${first}`,...rest.map(line=>`  ${line}`)];}).join('\n');
 assert.equal(message.slice(instructionsIndex+instructionsHeading.length).trim(),expectedInstructions,'composer preserves ordered comments as the final requested-changes section');check('page context precedes globally numbered comment instructions at the end of the generated message');
 // FilePreview's development-address branch: open the fixture through the actual Files surface, enter the address, repeat core pick/add.
 const files=page.locator('.wb-switcher').getByRole('button',{name:'Files',exact:true});if(await files.getAttribute('aria-pressed')!=='true')await files.click();await page.locator('.wb-tree-row[data-path="preview.html"]').click();const workspace=visible('.file-workspace').first();await workspace.waitFor();await workspace.getByRole('button',{name:'Preview',exact:true}).click();const file=visible('.file-preview').first();await file.waitFor();const address=file.getByRole('textbox',{name:'Development preview address'});await address.fill(url);await file.getByRole('button',{name:'Preview address',exact:true}).click();const addressFrame=file.locator('iframe[title="Development service preview"]');await addressFrame.waitFor();await page.frameLocator('.file-preview:visible iframe[title="Development service preview"]').locator('#counter').waitFor();await pageComment(file,{selector:'#counter',body:'Address-preview button.'});await until(async()=>await strip().locator('li').count()>0,'address preview page comment');await shot('03-address-preview.png');check('FilePreview development address supports the same picker and page comment form');
 const addressShot=(await storedComments()).filter(item=>item.kind==='page').at(-1)?.shot;assert.ok(addressShot?.path,'address comment has a shot');
 assert.ok(resolve(addressShot.path).startsWith(resolve(scratch)+ '\\'),'QA only removes a shot in its own temporary profile');await rm(addressShot.path);
 const beforeFailure=await composer(chat.id).inputValue();await strip().getByRole('button',{name:'Add to message',exact:true}).click();await strip().getByRole('alert').waitFor();assert.equal(await strip().locator('li').count(),1,'unreadable screenshot keeps the pending comment');assert.equal(await composer(chat.id).inputValue(),beforeFailure,'unreadable screenshot does not insert invalid paths');check('missing screenshot keeps pending comments and does not modify the receiver');
 await strip().getByRole('button',{name:'Clear',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Clear',exact:true}).click();await until(async()=>await strip().count()===0,'Clear removes page comments');check('Clear removes pending page comments');
 await pageComment(file,{selector:'#counter',body:'Clear must delete this screenshot.'});const clearShot=(await storedComments()).filter(item=>item.kind==='page').at(-1)?.shot;assert.ok(clearShot?.path&&existsSync(clearShot.path),'Clear fixture screenshot exists');await strip().getByRole('button',{name:'Clear',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Clear',exact:true}).click();await until(async()=>!existsSync(clearShot.path),'Clear deletes its screenshot');check('Clear deletes retained screenshot files');
 assert.deepEqual(report.errors,[],'the app emitted no page or console errors during the page-comments flow');report.passed=true;
}catch(error){await finalize(error);}finally{
 await finalize();
}
