import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createVite } from 'vite';

export async function setupRemoteBrowserProbe(scratch) {
  const servers = [], sockets = new Set(), viteSockets = new Set(), hmrEvents=[];let hmrReady=false; let clientRequests = 0, streamClosed = false, streamOpened = false;
  const listen = async (server, host) => { server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); }); servers.push(server); return server.address().port; };
  const client = http.createServer((_req, res) => { clientRequests++; res.setHeader('Content-Type', 'text/html'); res.end('<h1>CLIENT</h1>'); });
  const port = await listen(client, '127.0.0.1');
  const host = http.createServer((req, res) => {
    if(req.url==='/icon.svg'){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#0a0"/></svg>');return;}
    if(req.url.startsWith('/stream')) { streamOpened = true; res.writeHead(200, {'Content-Type':'text/plain'}); res.write('HOST STREAM'); req.socket.once('close',()=>{streamClosed=true;});return; }
    res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end('<!doctype html><title>Host browser page</title><link rel="icon" href="/icon.svg"><h1>HOST</h1><button id="pick">Host comment target</button><script>window.loadToken=crypto.randomUUID()</script>');
  });
  let ipv6 = true, hostPort;
  try { hostPort = await listen(host, '::'); } catch { ipv6 = false; hostPort = await listen(host, '127.0.0.1'); }
  if(ipv6)try{await new Promise((resolve,reject)=>http.get(`http://[::1]:${hostPort}`,res=>{res.resume();resolve();}).on('error',reject));}catch{ipv6=false;}
  const clientVite = http.createServer((_req, res) => { clientRequests++;res.end('CLIENT VITE'); }); const vitePort = await listen(clientVite, '127.0.0.1');
  const viteRoot = join(scratch,'host-vite'); await mkdir(viteRoot);
  await writeFile(join(viteRoot,'index.html'), '<h1 id="hmr">HOST-v1</h1><script type="module" src="/main.js"></script>');
  await writeFile(join(viteRoot,'message.js'), "export const message='HOST-v1';");
  await writeFile(join(viteRoot,'main.js'), "import {message} from './message.js';window.loadToken=crypto.randomUUID();document.querySelector('#hmr').textContent=message;if(import.meta.hot){window.hmrEvents=[];import.meta.hot.on('vite:beforeUpdate',()=>window.hmrEvents.push('before'));import.meta.hot.on('vite:afterUpdate',()=>window.hmrEvents.push('after'));import.meta.hot.accept('./message.js',module=>document.querySelector('#hmr').textContent=module.message);import.meta.hot.send('qa-hmr-ready',{});}");
  const vite = await createVite({configFile:false,root:viteRoot,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:{clientPort:vitePort}}});vite.httpServer.on('connection',socket=>{viteSockets.add(socket);socket.once('close',()=>viteSockets.delete(socket));});await vite.listen();
  vite.ws.on('qa-hmr-ready',()=>{hmrReady=true;hmrEvents.push({kind:'ready',at:Date.now()});});
  vite.watcher.on('change',file=>hmrEvents.push({kind:'watcher-change',file,at:Date.now()}));
  // Delay the upgrade so this probe must fence the HMR update on client readiness.
  const upgrades=vite.httpServer.listeners('upgrade');vite.httpServer.removeAllListeners('upgrade');
  vite.httpServer.on('upgrade',(request,socket,head)=>{hmrEvents.push({kind:'upgrade-request',at:Date.now()});setTimeout(()=>{if(!socket.destroyed)for(const handler of upgrades)handler.call(vite.httpServer,request,socket,head);},1000);});
  const viteHostPort = vite.httpServer.address().port;
  return {hmrEvents,get hmrReady(){return hmrReady;},port,vitePort,viteRoot,ipv6,portMap:`${port}:${hostPort},${vitePort}:${viteHostPort}`,get viteConnections(){return viteSockets.size;},get clientRequests(){return clientRequests;},get streamClosed(){return streamClosed;},get streamOpened(){return streamOpened;},
    async stopHost(){host.closeAllConnections();await new Promise(resolve=>host.close(resolve));},
    async cleanup(){await vite.close();for(const socket of sockets)socket.destroy();for(const server of servers)await new Promise(resolve=>server.close(resolve));}
  };
}

export async function runRemoteBrowserProbe({app,remotePage,localPage,rpc,until,pass,hostPeer,hostProject,session,hostWork,scratch,out,machine,note,fixtures}) {
  const partition=`persist:threadterm-browser-${machine.id}`,url=`http://localhost:${fixtures.port}`;
  const browser=()=>remotePage.locator('.wb-side-browser .wb-web-preview:visible');
  const native=async(selectedPartition=partition)=>app.evaluate(({webContents,session},partition)=>webContents.getAllWebContents().filter(wc=>!wc.isDestroyed()&&wc.session===session.fromPartition(partition)&&!wc.getURL().startsWith('devtools:')).map(wc=>({id:wc.id,url:wc.getURL()})),selectedPartition);
  const evaluate=async(id,source)=>app.evaluate(({webContents},{id,source})=>webContents.fromId(id).executeJavaScript(source),{id,source});
  const panel=async(target)=>{try{await remotePage.evaluate(url=>window.threadterm.openExternal(url),target);await browser().getByLabel('Address',{exact:true}).waitFor();return until(async()=>{const rows=await native(partition);for(const row of rows)if(row.url===new URL(target).href&&await evaluate(row.id,'document.body.innerText').catch(()=>undefined)==='HOST\nHost comment target')return row;},`HOST panel ${target}`);}catch(error){const rows=await native(partition);const detail=[];for(const row of rows)detail.push({...row,text:await evaluate(row.id,'document.body.innerText').catch(String)});const id=await browser().getAttribute('data-web-tab-id');const state=await remotePage.evaluate(tabId=>window.threadterm.browserCommand({type:'state',tabId}),id).catch(String);throw new Error(`${error.message}; ${JSON.stringify({detail,state})}`);}};
  await remotePage.evaluate(()=>window.threadterm.browserCommand({type:'preferences',patch:{linkTarget:'system'}}));
  for(const hostname of ['localhost','127.0.0.1','app.localhost',...(fixtures.ipv6?['[::1]']:[])]){await panel(`http://${hostname}:${fixtures.port}`);pass(`HOST reached via ${hostname}`);}
  if(!fixtures.ipv6)note('IPv6 unavailable on this PC (connect EACCES); [::1] probe skipped');
  assert.equal(fixtures.clientRequests,0);pass('remote panel shows HOST for every loopback spelling; client service receives zero requests; system link preference cannot bypass host routing');
  const proxyResolution=await app.evaluate(({session},partition)=>session.fromPartition(partition).resolveProxy('http://localhost:12345'),partition);assert.match(proxyResolution,/PROXY 127\.0\.0\.1:/);
  // A foreign process gets 407 from the loopback listener without the machine secret.
  const proxyPort=Number(/127\.0\.0\.1:(\d+)/.exec(proxyResolution)[1]);
  const status=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:proxyPort,path:url},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(status,407);pass('machine proxy rejects an unauthenticated local process with 407');

  const address=browser().getByLabel('Address',{exact:true});await address.fill(`http://localhost:${fixtures.vitePort}`);await address.press('Enter');
  const vitePage=await until(async()=>{const rows=await native(partition);for(const row of rows)if(row.url.startsWith(`http://localhost:${fixtures.vitePort}`)&&await evaluate(row.id,"document.querySelector('#hmr')?.textContent")==='HOST-v1')return row;},'Vite page');
  await until(()=>fixtures.hmrReady,'Vite client confirms its hot accept handler and authenticated WebSocket are ready');
  const token=await evaluate(vitePage.id,'window.loadToken');fixtures.hmrEvents.push({kind:'write-update',ready:fixtures.hmrReady,at:Date.now()});await writeFile(join(fixtures.viteRoot,'message.js'),"export const message='HOST-v2';");
  try{await until(async()=>await evaluate(vitePage.id,"document.querySelector('#hmr')?.textContent")==='HOST-v2','Vite HMR through authenticated WebSocket CONNECT',10000);}catch(error){throw new Error(`${error.message}; ${JSON.stringify({host:fixtures.hmrEvents,browser:await evaluate(vitePage.id,'window.hmrEvents'),token:await evaluate(vitePage.id,'window.loadToken')})}`);}assert.equal(await evaluate(vitePage.id,'window.loadToken'),token);assert.equal(fixtures.clientRequests,0);pass('Vite applies one HMR update through authenticated CONNECT without a reload');

  // Exercise the actual FilePreview control, not an app-partition iframe.
  await writeFile(join(hostWork,'preview.md'),'# Host preview file\n');
  await remotePage.locator('.ws-top .wb-switcher').getByRole('button',{name:'Files',exact:true}).click();
  assert.ok((await rpc(remotePage,'filesystem.list',{projectId:hostProject.id,path:''})).some(entry=>entry.name==='preview.md'));
  await remotePage.getByRole('button',{name:'Refresh',exact:true}).click();
  await remotePage.getByText('preview.md',{exact:true}).first().click();
  await remotePage.getByRole('button',{name:'Preview',exact:true}).click();
  await remotePage.getByLabel('Development preview address',{exact:true}).fill(url);await remotePage.getByRole('button',{name:'Preview address',exact:true}).click();
  const hostPage=await until(async()=>{const rows=await native(partition);return rows.find(row=>row.url===`${url}/`);},'Preview address opens host panel');
  assert.equal(await remotePage.locator('iframe[title="Development service preview"]').count(),0);assert.match(await evaluate(hostPage.id,'document.body.innerText'),/^HOST/);pass('remote FilePreview Preview address opens HOST in the panel with no live app iframe');
  await evaluate(hostPage.id,"document.cookie='remoteOnly=HOST;path=/';");

  // Open a normal workspace web tab for sharing/comments (the panel deliberately hides these controls).
  await remotePage.getByRole('button',{name:'Open as tab',exact:true}).click();
  const web=remotePage.locator('.wb-web-preview:visible').first();
  // Favicons are fetched by main outside the page; they rely on the session's proxy sign-in from the page load.
  await until(async()=>(await remotePage.locator('img.browser-page-favicon').first().getAttribute('src',{timeout:500}).catch(()=>null))?.startsWith('data:image/svg+xml'),'host favicon through the machine proxy');pass('the host page favicon loads through the machine proxy');
  await web.getByRole('button',{name:'Agent access Read',exact:true}).click();
  const tabId=await web.getAttribute('data-web-tab-id');await until(async()=>(await remotePage.evaluate(tabId=>window.threadterm.browserCommand({type:'state',tabId}),tabId)).sharing?.level==='read','remote browser sharing');
  const chat=remotePage.getByTestId(`session-chat-${session.id}`);
  const steps=[{tool:'browser_list_tabs'},{tool:'browser_navigate',target:'last',arguments:{url:`${url}/agent`}},{tool:'browser_snapshot',target:'last'}];
  const lease=await rpc(remotePage,'session.claim',{sessionId:session.id,clientId:'threadterm-renderer'});
  await rpc(remotePage,'chat.send',{sessionId:session.id,leaseEpoch:lease.leaseEpoch,text:`qa-browser ${JSON.stringify({id:'remote-host-tools',steps})}`,operationId:randomUUID()});
  const results=await until(async()=>{let rows;try{rows=(await readFile(join(scratch,'host-browser-events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{return false;}return rows.find(row=>row.event==='turn.result'&&row.detail.id==='remote-host-tools')?.detail.results;},'host MCP navigate and snapshot');
  assert.equal(results.length,3);assert.equal(results[0].isError,false);assert.equal(results[2].isError,false);assert.ok(results[2].refCount>0);assert.equal(results[2].provenance.origin,url);pass('host agent MCP snapshot drives the remote machine partition over the browser channel');if(results[1].isError){assert.match(results[1].error,/browser_control_required|browser_unavailable|browser_action_failed/);note('ordinary browser_navigate acceptance is BLOCKED: existing native controller has no proven action adapter; snapshot succeeds and Control policy stays unchanged',true);}else pass('host agent browser_navigate reaches the host page');
  await web.getByRole('button',{name:'Comment',exact:true}).click();
  const sharedNative=await until(async()=>{const rows=await native(partition);return rows.find(row=>row.url===(results[1].isError?`${url}/`:`${url}/agent`));},'agent page for comment');
  await app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id),point=await wc.executeJavaScript("(()=>{const r=document.querySelector('#pick').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");wc.debugger.attach('1.3');try{for(const type of ['mousePressed','mouseReleased'])await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});}finally{wc.debugger.detach();}},sharedNative.id);
  await web.locator('.wb-page-comment-form textarea').waitFor();await web.locator('.wb-page-comment-form textarea').fill('Host page comment');await web.getByRole('button',{name:'Add comment',exact:true}).click();await web.locator('.wb-page-comment-form').waitFor({state:'detached'});await web.locator('.wb-review-comments').getByText('Host page comment',{exact:true}).waitFor();pass('page-comment pick and persisted comment work on the host page');
  await remotePage.screenshot({path:join(out,'remote-host-browser.png')});
  const pagePng=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'),sharedNative.id);await writeFile(join(out,'remote-host-page.png'),Buffer.from(pagePng,'base64'));

  await localPage.evaluate(()=>window.threadterm.machineShow('local'));
  const localProject=(await rpc(localPage,'runtime.snapshot')).projects.find(project=>project.name==='Client-only project');
  const localSession=await rpc(localPage,'session.create',{projectId:localProject.id,cwd:localProject.path,provider:'shell',mode:'terminal',title:'Local browser regression',executable:'cmd.exe',args:['/Q','/K'],operationId:randomUUID()});
  await rpc(localPage,'session.present',{sessionId:localSession.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
  await localPage.locator('.ws-top .wb-switcher').getByRole('button',{name:'Browser',exact:true}).click();
  const localBrowser=localPage.locator('.wb-side-browser .wb-web-preview:visible');await localBrowser.getByLabel('Address',{exact:true}).fill(url);await localBrowser.getByLabel('Address',{exact:true}).press('Enter');
  const localNative=await until(async()=>{const rows=await native('persist:threadterm-browser');for(const row of rows)if(row.url===`${url}/`&&await evaluate(row.id,'document.body.innerText')==='CLIENT')return row;},'This PC still CLIENT');
  assert.ok(!(await evaluate(localNative.id,'document.cookie')).includes('remoteOnly'));pass('This PC browser still shows CLIENT and cannot see the remote partition cookie');
  await evaluate(localNative.id,"document.cookie='localOnly=CLIENT;path=/'");
  await remotePage.evaluate(()=>window.threadterm.browserCommand({type:'clearData'}));
  assert.ok((await evaluate(localNative.id,'document.cookie')).includes('localOnly=CLIENT'));
  assert.equal((await app.evaluate(({session},partition)=>session.fromPartition(partition).cookies.get({name:'remoteOnly'}),partition)).length,0);
  assert.equal((await remotePage.evaluate(tabId=>window.threadterm.browserCommand({type:'state',tabId}),tabId)).sharing.level,'off');
  await app.evaluate(({session},{partition,url})=>session.fromPartition(partition).cookies.set({url,name:'removeProof',value:'HOST'}),{partition,url});
  pass('remote clearData clears only its machine storage and sharing, leaving This PC cookies intact');
  const before=fixtures.clientRequests;
  await localPage.evaluate(id=>window.threadterm.machineShow(id),machine.id);
  await remotePage.evaluate(url=>window.threadterm.openExternal(url),url);
  await fixtures.stopHost();
  await browser().getByLabel('Address',{exact:true}).fill(`${url}/stopped`);await browser().getByLabel('Address',{exact:true}).press('Enter');
  await until(async()=>{const rows=await native(partition);for(const row of rows)if((await evaluate(row.id,'document.body.innerText').catch(()=>undefined))?.includes('Cannot reach Office-PC'))return true;},'named host 502');
  assert.equal(fixtures.clientRequests,before);pass('stopping the host service shows the named 502 page with zero client fallback');
  // Keep the Vite HMR TCP tunnel open for the harness's subsequent revoke.
  await browser().getByLabel('Address',{exact:true}).fill(`http://localhost:${fixtures.vitePort}`);await browser().getByLabel('Address',{exact:true}).press('Enter');
  await until(async()=>{for(const row of await native(partition))if(await evaluate(row.id,"document.querySelector('#hmr')?.textContent").catch(()=>undefined)==='HOST-v2')return true;},'Vite tunnel before revoke');
  await remotePage.evaluate(()=>window.threadterm.browserCommand({type:'preferences',patch:{linkTarget:'builtin'}}));
  await until(()=>fixtures.viteConnections>0,'open Vite tunnel before revoke');return {async afterRevoke(){await until(()=>fixtures.viteConnections===0,'revoke closes every Vite target socket');const result=await app.evaluate(({session},partition)=>session.fromPartition(partition).resolveProxy('http://localhost'),partition);assert.match(result,/PROXY/);pass('revoke closes the open Vite tunnel without changing its partition to a client-local route');},async afterLocalSwitch(){
    assert.equal((await app.evaluate(({session},partition)=>session.fromPartition(partition).cookies.get({name:'removeProof'}),partition)).length,1);
    await localPage.evaluate(id=>window.threadterm.machineRemove(id),machine.id);
    assert.equal((await app.evaluate(({session},partition)=>session.fromPartition(partition).cookies.get({name:'removeProof'}),partition)).length,0);
    pass('removing the computer clears its persisted browser partition storage');
  }};
}
