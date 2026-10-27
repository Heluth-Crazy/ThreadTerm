import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { attachedNativeBrowserPages, dismissBrowserNotifications, nativeBrowserContents } from './lib/native-browser.mjs';

function fixture(){
 const profile={},otherProfile={},events=[],scripts=[],debuggerCalls=[];let disposed=0,attached=false;
 const rect={x:12,y:20,width:100,height:40};
 const debuggerApi={isAttached:()=>attached,attach:()=>{attached=true;debuggerCalls.push('attach');},detach:()=>{attached=false;debuggerCalls.push('detach');},sendCommand:async(method,args)=>{events.push({method,...args});}};
 const make=(id,session=profile)=>({id,session,isDestroyed:()=>false,getURL:()=> 'http://127.0.0.1:1234/same',debugger:debuggerApi,
  executeJavaScript:async code=>{scripts.push(code);return runInNewContext(code,{document:{querySelector:selector=>selector==='#missing'?null:{getBoundingClientRect:()=>rect}},getComputedStyle:()=>({visibility:'visible',display:'block'})});},
  capturePage:async()=>({toPNG:()=>Buffer.from('native PNG')})});
 const a=make(2),b=make(3),foreign=make(4),renderer=make(1,otherProfile);
 const window={id:10,contentView:{children:[{webContents:b}]}},other={id:11,contentView:{children:[{webContents:foreign}]}};
 const electron={BrowserWindow:{getAllWindows:()=>[window,other],fromId:id=>[window,other].find(window=>window.id===id)},webContents:{getAllWebContents:()=>[renderer,a,b,foreign],fromId:id=>[renderer,a,b,foreign].find(contents=>contents.id===id)},session:{fromPartition:partition=>{assert.equal(partition,'persist:threadterm-browser');return profile;}}};
 const app={browserWindow:async()=>({evaluate:async fn=>fn(window),dispose:async()=>disposed++}),evaluate:async(fn,arg)=>runInNewContext(`(${fn.toString()})(electron,arg)`,{electron,arg}),context:()=>{throw Error('Playwright pages must not be used');}};
 return {app,a,b,window,events,scripts,debuggerCalls,get disposed(){return disposed;},set attached(value){attached=value;}};
}

test('native discovery works with no Playwright pages and scopes attachment to the renderer window',async()=>{
 const f=fixture(),contents=await nativeBrowserContents(f.app);assert.deepEqual(Array.from(contents,value=>value.id),[2,3,4]);
 const pages=await attachedNativeBrowserPages(f.app,{});assert.deepEqual(pages.map(page=>page.id),[3]);assert.equal(f.disposed,1);
 // Same URL remains distinct; changing attachment changes identity, never list order.
 f.window.contentView.children=[{webContents:f.a}];assert.deepEqual((await attachedNativeBrowserPages(f.app,{})).map(page=>page.id),[2]);
});

test('native selector geometry is read through the selected contents and safely quotes selectors',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});
 assert.deepEqual(JSON.parse(JSON.stringify(await page.boundingBox('#target'))),{x:12,y:20,width:100,height:40});
 assert.equal(await page.boundingBox('#missing'),null);await page.boundingBox('"`);throw Error("injected")//');assert.equal(f.scripts.length,3);
});

test('native clicks send trusted CDP mouse input to the exact contents without OS focus',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});await page.click('#target');
 assert.deepEqual(f.events.map(event=>event.type),['mouseMoved','mousePressed','mouseReleased']);
 assert.ok(f.events.every(event=>event.method==='Input.dispatchMouseEvent'&&event.x===62&&event.y===40));
 assert.deepEqual(f.debuggerCalls,['attach','detach']);assert.equal(f.events[1].buttons,1);assert.equal(f.events[2].buttons,0);
});

test('native right clicks dispatch the secondary button at the selected element without OS focus',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});await page.rightClick('#target');
 assert.deepEqual(f.events.map(event=>[event.type,event.x,event.y,event.buttons,event.button,event.clickCount]),[['mouseMoved',62,40,0,'none',0],['mousePressed',62,40,2,'right',1],['mouseReleased',62,40,0,'right',1]]);
 assert.deepEqual(f.debuggerCalls,['attach','detach']);
});

test('area drags preserve pressed mouse state across intermediate points',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});await page.drag({x:5,y:10},{x:65,y:40},3);
 assert.deepEqual(f.events.map(event=>[event.type,event.x,event.y,event.buttons]),[['mouseMoved',5,10,0],['mousePressed',5,10,1],['mouseMoved',25,20,1],['mouseMoved',45,30,1],['mouseMoved',65,40,1],['mouseReleased',65,40,0]]);
});

test('detached or navigated contents reject input instead of targeting a same-URL sibling',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});f.window.contentView.children=[{webContents:f.a}];await assert.rejects(page.click('#target'),/no longer attached/);
 f.window.contentView.children=[{webContents:f.b}];f.b.getURL=()=> 'http://127.0.0.1/changed';await assert.rejects(page.click('#target'),/navigated/);assert.equal(f.events.length,0);
});

test('missing selectors and debugger ownership fail explicitly without altering another debugger',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});await assert.rejects(page.click('#missing'),/not visible/);
 f.attached=true;await assert.rejects(page.click('#target'),/already has an Electron debugger/);assert.deepEqual(f.debuggerCalls,[]);
});

test('input failures release the helper debugger',async()=>{
 const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{});f.b.debugger.sendCommand=async()=>{throw Error('input failed');};await assert.rejects(page.click('#target'),/input failed/);assert.deepEqual(f.debuggerCalls,['attach','detach']);
});

test('native capture writes Electron PNG bytes using only approved D-drive scratch',async()=>{
 const scratch=await mkdtemp(join(resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir()), 'b1-native-helper-'));
 try{const f=fixture(),[page]=await attachedNativeBrowserPages(f.app,{}),path=join(scratch,'page.png');await page.screenshot({path});assert.equal(await readFile(path,'utf8'),'native PNG');}finally{await rm(scratch,{recursive:true,force:true});}
});


test('input preparation dismisses a fixture attention toast through its real close button',async()=>{
 let count=1,clicks=0;
 const page={locator:selector=>{assert.equal(selector,'.attention-toast button[aria-label]');return {count:async()=>count,first:()=>({click:async()=>{clicks++;count=0;}})};}};
 await dismissBrowserNotifications(page);await dismissBrowserNotifications(page);assert.equal(clicks,1);
});


test('occluded views yield no input target even when same-URL contents remain live',async()=>{
 const f=fixture();f.window.contentView.children=[];
 assert.equal((await nativeBrowserContents(f.app)).length,3);
 assert.deepEqual(await attachedNativeBrowserPages(f.app,{}),[]);assert.equal(f.disposed,1);assert.equal(f.events.length,0);
});
