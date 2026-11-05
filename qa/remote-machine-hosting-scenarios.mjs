import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function memory() {
  const free = Number(execFileSync('powershell.exe', ['-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], {encoding:'utf8',windowsHide:true}).trim()) / 1024 / 1024;
  assert.ok(free >= 8, `Electron probe requires 8 GB free, has ${free.toFixed(2)}`);
}

export class HostingProbe {
  constructor({ scratch, runtime, hostEnv, environment, rpc, until, pass, out, report }) {
    Object.assign(this,{scratch,runtime,hostEnv,environment,rpc,until,pass,out,report});
    this.pids = new Set(); this.children = []; this.apps = new Set(); this.peers = new Set();
  }
  async prepare(built) {
    this.entry = join(this.scratch,'hosting-electron.cjs'); this.built = built;
    // Capture only real runtime launches, without changing spawn's options or lifecycle.
    await writeFile(this.entry, `const electron=require('electron');
const cp=require('node:child_process');const original=cp.spawn;
globalThis.__hostingLaunches=[];
cp.spawn=function(command,...args){const child=original.call(this,command,...args);if(command===process.env.THREADTERM_V3_RUNTIME)globalThis.__hostingLaunches.push(child.pid);return child;};
const originalMenu=electron.Tray.prototype.setContextMenu;
electron.Tray.prototype.setContextMenu=function(menu){globalThis.__hostingMenu=menu;return originalMenu.call(this,menu);};
electron.app.setAppPath(${JSON.stringify(built.appDir)});
require(${JSON.stringify(join(built.appDir,'main.cjs'))});
`);
  }
  async launchHost(env, expectSpawn) {
    memory();
    const app = await electron.launch({args:[this.entry],env:{...env,THREADTERM_V3_QA_HOST_QUIT_CHOICE:'keep'},timeout:30000});
    this.apps.add(app);
    const page = await app.firstWindow(); await page.waitForFunction(()=>!!window.threadterm);
    await this.rpc(page,'runtime.snapshot');
    const launches = await app.evaluate(()=>globalThis.__hostingLaunches);
    assert.equal(launches.length,expectSpawn ? 1 : 0,'pipe reattach must never spawn a second runtime');
    for(const pid of launches)this.pids.add(pid);
    return {app,page,pid:launches[0]};
  }
  async startA(built) {
    await this.prepare(built);
    this.a = await this.launchHost(this.hostEnv,true); this.aPid = this.a.pid;
    this.report.hostRuntimeSpawn = {pid:this.aPid, launchedByElectron:true};
  }
  async quitHost(host, choice) {
    console.log(`HOSTING quit ${choice}: trigger`);
    const process = host.app.process();
    await host.app.evaluate((_,choice)=>{
      process.env.THREADTERM_V3_QA_HOST_QUIT_CHOICE=choice;
      const item=globalThis.__hostingMenu.items.find(item=>item.label==='Quit');
      if(!item)throw Error('Missing real tray Quit');item.click();
    },choice).catch(error=>{if(process.exitCode===null)throw error;});
    console.log(`HOSTING quit ${choice}: trigger returned`);
    await this.until(()=>process.exitCode!==null,'host Electron real Quit',20000);
    console.log(`HOSTING quit ${choice}: process exited`);
    // The process has already exited. A second Playwright close waits indefinitely here.
    host.exited = true; this.apps.delete(host.app);
  }
  async admin(env) {
    const peer = await this.until(async()=>{
      let peer;
      try { peer=await connectPeer(`${env.THREADTERM_V3_PIPE}-control`); await peer.auth((await readFile(join(env.THREADTERM_V3_DATA,'runtime.credential'),'utf8')).trim()); return peer; }
      catch {peer?.close();return false;}
    },'hosting admin pipe');
    this.peers.add(peer);return peer;
  }
  spawnRuntime(env) {
    const child=spawn(this.runtime,[],{env,windowsHide:true,stdio:'ignore'});
    assert.ok(child.pid);this.pids.add(child.pid);this.children.push(child);return child.pid;
  }
  async stopPid(pid) {
    if(alive(pid))process.kill(pid);
    await this.until(()=>!alive(pid),`runtime PID ${pid} exited`,10000);
  }
  async restartA(contract, crash=false) {
    assert.ok(!this.a || this.a.exited,'close host Electron before controlled restart');
    if(crash) await this.stopPid(this.aPid);
    else if(alive(this.aPid)) {
      await this.aPeer.request('runtime.shutdown',{operationId:randomUUID()});
      await this.until(()=>!alive(this.aPid),'old A exited before restart',10000);
    }
    this.aPeer.close(); this.peers.delete(this.aPeer);
    const env={...this.hostEnv};if(contract)env.THREADTERM_QA_PEER_CONTRACT=String(contract);
    this.aPid=this.spawnRuntime(env);this.aPeer=await this.admin(env);
  }
  async show(app,localPage,id,sessionId) {
    await localPage.evaluate(([id,sessionId])=>window.threadterm.machineShow(id,sessionId),[id,sessionId]);
    await this.until(async()=>await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()) === (id==='local'?'ThreadTerm':`ThreadTerm — ${id===this.machine.id?this.machine.name:'Host-B'}`),'machine shown');
    if(id==='local')return localPage;
    return this.until(async()=>{
      for(const page of app.context().pages())if(page!==localPage&&await page.evaluate(()=>window.threadterm?.machineId).catch(()=>undefined)===id)return page;
    },'hosting machine view');
  }
  async state(localPage,id,state,timeout=30000) {
    await this.until(async()=>(await localPage.evaluate(()=>window.threadterm.machineList())).machines.find(item=>item.id===id)?.state===state,`${id}: ${state}`,timeout);
  }
  async records(env) {
    try {return (await readFile(env.THREADTERM_QA_TRANSITION_LOG,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async send(page,sessionId,text) {
    const chat=page.getByTestId(`session-chat-${sessionId}`);
    await this.until(async()=>{
      if(await chat.locator('textarea').count() && await chat.locator('textarea').isEnabled().catch(()=>false))return true;
      const take=chat.getByRole('button',{name:/^(Take control|Reclaim control)$/});
      if(await take.isVisible().catch(()=>false)&&await take.isEnabled())await take.click();
      return false;
    },'Chat ready',45000);
    const before=await chat.getByText('TRANSITION-SAVED-ANSWER',{exact:true}).count();
    await chat.locator('textarea').fill(text);await chat.locator('button[type=submit]').click();
    await this.until(async()=>await chat.getByText('TRANSITION-SAVED-ANSWER',{exact:true}).count()>before,'new host Chat reply',30000);
    await this.until(async()=>{
      const snapshot=await this.rpc(page,'chat.snapshot',{sessionId});
      return !snapshot.items.some(item=>item.turnStatus==='inProgress');
    },'turn completed');
  }
  async pair(localPage,offer,name,color='#9166ff') {
    await localPage.evaluate(async({offer,name,color})=>{await window.threadterm.machinePrepare(offer);await window.threadterm.machineAdd({name,color});},{offer:offer.qrPayload,name,color});
    return (await localPage.evaluate(()=>window.threadterm.machineList())).machines.find(item=>item.name===name);
  }
  async run({app,localPage,remotePage,hostPeer,machine,session,hostProject}) {
    this.aPeer=hostPeer;this.peers.add(hostPeer);this.machine=machine;
    // Order: keep/relaunch/stop -> crash/recovery -> skew -> identity -> B source policy.
    this.report.hostingOrder=['keep','reattach','stop','crash/recover','mismatch/reselect','identity/re-pair','Tailscale-only'];
    const initialPid=this.aPid;
    await this.quitHost(this.a,'keep');
    assert.ok(alive(initialPid));
    await this.send(remotePage,session.id,'Still working after host desktop Quit.');
    assert.equal(this.aPid,initialPid);
    this.pass('real host tray Quit, keep running exits Electron; its own detached runtime survives with the same PID and remote Chat completes');
    this.a=await this.launchHost(this.hostEnv,false);
    assert.ok(alive(initialPid));
    assert.ok((await this.rpc(this.a.page,'runtime.snapshot')).sessions.some(row=>row.id===session.id));
    this.pass('host relaunch probes and reattaches without spawning a runtime; existing session list is intact');
    await this.quitHost(this.a,'stop');
    await this.until(()=>!alive(initialPid),'Stop everything ends A runtime');
    await this.state(localPage,machine.id,'disconnected');
    this.pass('real host tray Stop everything exits the runtime and disconnects A');
    await this.restartA();await this.state(localPage,machine.id,'connected');

    // B has its own root, pipe, provider log and fixture directory. Initially no desktop is paired.
    this.bEnv=this.environment('host-b');this.bWork=join(this.scratch,'host-b-project');await mkdir(this.bWork);
    this.bEnv.THREADTERM_QA_TRANSITION_CWD=this.bWork;
    const noPairs=await this.launchHost(this.bEnv,true), bBefore=await this.rpc(noPairs.page,'runtime.snapshot');
    await this.rpc(noPairs.page,'settings.update',{patch:{remoteMachines:{enabled:true},language:'en'},expectedRevision:bBefore.settings.revision,operationId:randomUUID()});
    assert.deepEqual(await this.rpc(noPairs.page,'device.list'),[]);
    await noPairs.page.getByRole('button',{name:'Local user',exact:true}).click();
    await noPairs.page.getByRole('button',{name:'Settings',exact:true}).click();
    await noPairs.page.getByRole('tab',{name:'Computers',exact:true}).click();
    const option='Only accept devices on my Tailscale network';
    const computersSwitch=noPairs.page.getByRole('switch',{name:option,exact:true});
    await this.until(()=>computersSwitch.isEnabled(),'Computers source switch loaded');await computersSwitch.click();
    await this.until(async()=>(await this.rpc(noPairs.page,'device.status')).tailscaleOnly,'Computers policy confirmed');
    await this.until(()=>computersSwitch.isChecked(),'Computers switch confirms on');
    await noPairs.page.screenshot({path:join(this.out,'computers-tailscale-setting.png')});
    await noPairs.page.getByRole('tab',{name:'Phones',exact:true}).click();
    const phonesSwitch=noPairs.page.getByRole('switch',{name:option,exact:true});
    await this.until(()=>phonesSwitch.isChecked(),'Phones sees the same persisted option');await phonesSwitch.click();
    await this.until(async()=>!(await this.rpc(noPairs.page,'device.status')).tailscaleOnly,'Phones policy confirmed off');
    await this.until(async()=>!await phonesSwitch.isChecked(),'Phones switch confirms off');
    await noPairs.page.screenshot({path:join(this.out,'phones-tailscale-setting.png')});
    await noPairs.page.getByRole('button',{name:'Close settings',exact:true}).click();
    this.pass('real This PC Computers and Phones switches share one persisted policy and hint');
    await this.quitHost(noPairs,'keep');await this.until(()=>!alive(noPairs.pid),'no-pair legacy shutdown');
    this.pass('with Computers enabled but no paired desktop, QA keep is ignored and the legacy quit path stops the runtime');
    this.bPid=this.spawnRuntime(this.bEnv);this.bPeer=await this.admin(this.bEnv);
    await this.bPeer.request('device.enable',{operationId:randomUUID()});
    const bProject=await this.bPeer.request('project.add',{path:this.bWork,name:'B-only project',operationId:randomUUID()});
    const offerB=await this.bPeer.request('device.pairing.create',{profile:'desktop',permission:'fullcontrol',operationId:randomUUID()});
    this.bMachine=await this.pair(localPage,offerB,'Host-B');assert.ok(this.bMachine);
    const bPage=await this.show(app,localPage,this.bMachine.id);
    const bSession=await this.rpc(bPage,'session.create',{projectId:bProject.id,cwd:this.bWork,provider:'codex',mode:'chat',title:'B Chat',operationId:randomUUID()});
    await this.rpc(bPage,'session.present',{sessionId:bSession.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
    await this.show(app,localPage,this.bMachine.id,bSession.id);
    console.log('HOSTING B: created/presented/selected', bSession.id);
    await bPage.screenshot({path:join(this.out,'b-before-chat.png')});
    try { await this.send(bPage,bSession.id,'B starts independently.'); }
    catch(error) {
      await bPage.screenshot({path:join(this.out,'b-chat-failure.png')}).catch(()=>{});
      const snapshot = await this.rpc(bPage,'runtime.snapshot').catch(()=>undefined);
      this.report.bFailure = { sessions: snapshot?.sessions, providers: snapshot?.providers.map(({id,auth,chat,reason})=>({id,auth,chat,reason})), connection: await this.rpc(bPage,'chat.connection',{sessionId:bSession.id}).catch(String) };
      await writeFile(join(this.out,'b-provider-failure.jsonl'),await readFile(this.bEnv.THREADTERM_QA_TRANSITION_LOG).catch(()=>''));
      throw error;
    }
    remotePage=await this.show(app,localPage,machine.id,session.id);

    // Hold the fake provider after turn/started and delta; crash recovery must mark, never resend, the turn.
    await writeFile(join(this.hostEnv.THREADTERM_QA_TRANSITION_CONTROL,'hold-hosting-turn'),'hold');
    const chat=remotePage.getByTestId(`session-chat-${session.id}`);
    await this.until(()=>chat.locator('textarea').isEnabled(),'A ready before crash');
    await chat.locator('textarea').fill('HOSTING-HELD-TURN');await chat.locator('button[type=submit]').click();
    await this.until(async()=>(await this.records(this.hostEnv)).some(row=>row.method==='held'),'fake host turn held');
    const held=(await this.records(this.hostEnv)).find(row=>row.method==='held');
    await this.until(async()=>{
      const snapshot=await this.rpc(remotePage,'chat.snapshot',{sessionId:session.id});
      const state=(await this.rpc(remotePage,'runtime.snapshot')).sessions.find(row=>row.id===session.id);
      this.report.heldBeforeKill={items:snapshot.items,session:state};
      return state?.activity?.state==='running' && snapshot.items.some(item=>JSON.stringify(item).includes('HOSTING-HELD-TURN')) && snapshot.items.some(item=>JSON.stringify(item).includes(held.params.turnId));
    },'held turn durably projected before PID kill');
    const sendCount=(await this.records(this.hostEnv)).filter(row=>row.direction==='in'&&row.method==='turn/start').length;
    await this.stopPid(this.aPid);await this.state(localPage,machine.id,'disconnected');
    await remotePage.screenshot({path:join(this.out,'host-crash-disconnected.png')});
    await rm(join(this.hostEnv.THREADTERM_QA_TRANSITION_CONTROL,'hold-hosting-turn'));
    // PID is already gone; reconnect the same root/port without sending work.
    await this.restartA();await this.state(localPage,machine.id,'connected');
    const recovered=await this.rpc(remotePage,'chat.snapshot',{sessionId:session.id});
    this.report.crashRecovery = {items:recovered.items, session:(await this.rpc(remotePage,'runtime.snapshot')).sessions.find(row=>row.id===session.id)};
    assert.ok(recovered.items.some(item=>item.turnStatus==='interrupted'),'held turn recovers as interrupted');
    await remotePage.getByText('Turn interrupted',{exact:true}).waitFor();
    await remotePage.screenshot({path:join(this.out,'host-crash-recovered-interrupted.png')});
    await new Promise(done=>setTimeout(done,500));
    assert.equal((await this.records(this.hostEnv)).filter(row=>row.direction==='in'&&row.method==='turn/start').length,sendCount,'uncertain turn is not resent');
    await this.send(remotePage,session.id,'A works again after crash recovery.');
    this.pass('killing host A by PID disconnects its view; same-root/port restart reconnects automatically, marks the held turn interrupted and never re-sends it');

    await this.restartA(987);await this.state(localPage,machine.id,'incompatible');
    const mismatch=remotePage.locator('.machine-failure');await mismatch.waitFor();
    const message=await mismatch.innerText();assert.match(message,/desktop 0\.1\.0/);assert.match(message,/computer 0\.1\.0/);assert.match(message,/contract 20/);assert.match(message,/contract 987/);assert.match(message,/Update one so they match/);
    await remotePage.screenshot({path:join(this.out,'version-mismatch.png')});
    await this.show(app,localPage,this.bMachine.id,bSession.id);await this.send(bPage,bSession.id,'B works while A versions differ.');
    await this.show(app,localPage,'local');assert.ok((await this.rpc(localPage,'runtime.snapshot')).projects.some(row=>row.name==='Client-only project'));
    await this.restartA();
    await new Promise(done=>setTimeout(done,600));await this.state(localPage,machine.id,'incompatible');
    remotePage=await this.show(app,localPage,machine.id,session.id);await this.state(localPage,machine.id,'connected');await this.send(remotePage,session.id,'Explicit sidebar selection retries matching A.');
    this.pass('A mismatch names both versions/contracts and stops retrying; B Chat and This PC work; selecting A after matching restart reconnects');

    await this.aPeer.request('device.identity.reset',{operationId:randomUUID()});await this.state(localPage,machine.id,'pin-mismatch');
    await remotePage.locator('.machine-failure').getByText('This computer’s identity changed',{exact:true}).waitFor();
    assert.match(await remotePage.locator('.machine-failure').innerText(),/Pair again/);await remotePage.screenshot({path:join(this.out,'identity-changed.png')});
    await this.show(app,localPage,this.bMachine.id,bSession.id);await this.send(bPage,bSession.id,'B works while A identity changed.');
    await this.show(app,localPage,'local');
    const newOffer=await this.aPeer.request('device.pairing.create',{permission:'fullcontrol',profile:'desktop',operationId:randomUUID()});
    await localPage.evaluate(async offer=>{await window.threadterm.machinePrepare(offer);await window.threadterm.machineAdd({name:'New identity offer name',color:'#ffffff'});},newOffer.qrPayload);
    const entries=(await localPage.evaluate(()=>window.threadterm.machineList())).machines;
    assert.equal(entries.length,3);const repaired=entries.find(row=>row.id===machine.id);assert.equal(repaired.name,machine.name);assert.equal(repaired.color,machine.color);
    remotePage=await this.show(app,localPage,machine.id,session.id);await this.state(localPage,machine.id,'connected');await this.send(remotePage,session.id,'A works after pairing its new identity.');
    this.pass('identity reset fences A while B works; pairing the same address replaces A in place with the same machine id, name and color');

    await this.show(app,localPage,this.bMachine.id,bSession.id);
    const start=Date.now();await this.bPeer.request('device.tailscaleOnly.set',{enabled:true,operationId:randomUUID()});
    await this.state(localPage,this.bMachine.id,'disconnected',2000);assert.ok(Date.now()-start<2000);
    assert.equal((await this.bPeer.request('device.status')).tailscaleOnly,true);
    await bPage.screenshot({path:join(this.out,'tailscale-loopback-refused.png')});
    await this.bPeer.request('device.tailscaleOnly.set',{enabled:false,operationId:randomUUID()});await this.state(localPage,this.bMachine.id,'connected');await this.send(bPage,bSession.id,'B reconnects after source policy is off.');
    this.pass('B Tailscale-only restarts the shared listener, disconnects loopback within 2 seconds, and reconnects automatically when off');
    remotePage=await this.show(app,localPage,machine.id,session.id);
    this.report.hosting = {initialPid, noSecondLaunch:true, recoveredInterrupted:true, sendCountBeforeCrash:sendCount, machineIdAfterRepair:machine.id};
    return {hostPeer:this.aPeer,remotePage};
  }
  async cleanup() {
    for(const app of this.apps) {
      const host={app};try {await this.quitHost(host,'stop');}catch(error){this.report.cleanup.push(`Host Electron normal quit failed: ${error}`);if(app.process().exitCode===null)await this.stopPid(app.process().pid);}
    }
    for(const peer of this.peers){try{await peer.request('runtime.shutdown',{operationId:randomUUID()});}catch{}peer.close();}
    for(const pid of this.pids)if(alive(pid))await this.stopPid(pid);
  }
}
