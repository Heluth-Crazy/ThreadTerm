import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { assertBrowserButtonClick, beginBrowserInputTrace, chromeDividerPoints, compareNativeInputBounds, endBrowserInputTrace, readBrowserInputGeometry } from './lib/browser-handoff-input.mjs';

const renderer={point:{x:1284.15,y:203.8},button:{x:1271.15,y:190.8,width:26,height:26}};
const native={zoom:1,views:[{id:2,bounds:{x:855,y:225,width:557,height:644}}]};

test('round 4 bounds do not put the native page over the screenshot button',()=>{
 const result=compareNativeInputBounds(renderer,native);
 assert.equal(result.native.views[0].containsClick,false);
 assert.equal(result.native.views[0].overlapsButton,false);
});

test('input receipts detect stale native bounds and account for renderer zoom, not display DPI',()=>{
 const result=compareNativeInputBounds({...renderer,devicePixelRatio:2},{zoom:1.25,views:[{id:2,bounds:{x:1500,y:250,width:300,height:600}}]});
 assert.deepEqual(result.native.point,{x:1605.1875,y:254.75});
 assert.equal(result.native.views[0].containsClick,true);
 assert.equal(result.native.views[0].overlapsButton,true);
 const edge=compareNativeInputBounds({point:{x:100,y:20},button:{x:80,y:0,width:20,height:20}},{zoom:1,views:[{bounds:{x:100,y:20,width:300,height:300}}]});
 assert.equal(edge.native.views[0].containsClick,true);
 assert.equal(edge.native.views[0].overlapsButton,false,'touching edges are not overlapping areas');
});

test('divider gesture stays in shared chrome instead of the native page vertical span',()=>{
 const parent={x:268,y:138,width:1144,height:730},divider={x:843,y:138,width:4,height:730},toolbar={x:855,y:182.8,width:557,height:42};
 const point=chromeDividerPoints(parent,divider,toolbar,847);
 assert.deepEqual(point,{x:845,y:203.8,endX:847});
 assert.ok(point.y<225,'entire horizontal drag is above the supplied native bounds');
 assert.ok(divider.y+divider.height/2>225,'old midpoint was inside the native page vertical span');
 assert.throws(()=>chromeDividerPoints(parent,divider,{...toolbar,y:900},847),/no shared app-chrome strip/);
});

test('bounded temporary trace records retargeted input and removes every listener',async()=>{
 const listeners=new Map(),hit={tagName:'BUTTON',id:'shot',className:'icon-btn',getAttribute:()=> 'Screenshot to Chat'},divider={tagName:'DIV',id:'',className:'pane-divider',getAttribute:()=>null};
 const context=vm.createContext({window:{},document:{elementFromPoint:()=>hit},addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener:(type,listener)=>{assert.equal(listeners.get(type),listener);listeners.delete(type);}});
 const page={evaluate:callback=>vm.runInContext(`(${callback.toString()})()`,context)};
 await beginBrowserInputTrace(page);
 for(const type of ['gotpointercapture','pointerdown','pointerup','lostpointercapture'])listeners.get(type)({type,clientX:1284,clientY:204,pointerId:1,buttons:1,isTrusted:true,target:divider});
 const events=await endBrowserInputTrace(page);
 assert.equal(events.length,4);assert.equal(events[1].target.className,'pane-divider');assert.equal(events[1].hit.label,'Screenshot to Chat','hit test and actual pointer recipient can disagree under capture');
 assert.equal(listeners.size,0);assert.equal(context.window.__ttBrowserHandoffInput,undefined);
 // Two identical-looking paths are distinct DOM nodes: detect the reported
 // replacement even when every event still traverses the same real button.
 await beginBrowserInputTrace(page);
 const oldPath={tagName:'path',getAttribute:()=>null},newPath={...oldPath};
 for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){const target=type==='pointerdown'?oldPath:newPath;listeners.get(type)({type,isTrusted:true,target,composedPath:()=>[target,hit]});}
 const replaced=Array.from(await endBrowserInputTrace(page),event=>structuredClone(event));assert.equal(replaced[0].control.nodeId,replaced[1].control.nodeId);assert.notEqual(replaced[0].target.nodeId,replaced[1].target.nodeId);
 assert.throws(()=>assertBrowserButtonClick(replaced,'Screenshot to Chat'),/subtree stays mounted/);assert.equal(listeners.size,0);
 await beginBrowserInputTrace(page);for(let index=0;index<150;index++)listeners.get('click')({type:'click',target:hit});
 assert.equal((await endBrowserInputTrace(page)).length,100);
 assert.equal(listeners.size,0);
});

test('native receipt binds to the renderer owner window and disposes its handle',async()=>{
 let disposed=false,ownerPage;
 const page={};const button={evaluate:async()=>renderer};
 const app={browserWindow:async input=>{ownerPage=input;return {evaluate:async()=>native,dispose:async()=>{disposed=true;}};}};
 const receipt=await readBrowserInputGeometry(app,page,button);
 assert.equal(ownerPage,page);assert.equal(disposed,true);assert.equal(receipt.native.views[0].overlapsButton,false);
});

test('geometry catches a divider capture retained before the new trace sees any pointer event',async()=>{
 const box={x:1271.15,y:190.8,width:26,height:26};
 const button={tagName:'BUTTON',id:'',className:'icon-btn',disabled:false,isConnected:true,getBoundingClientRect:()=>box,getAttribute:()=> 'Screenshot to Chat',contains:node=>node===button,closest:()=>null};
 const divider={tagName:'DIV',id:'',className:'pane-divider',getBoundingClientRect:()=>({x:843,y:138,width:4,height:730}),getAttribute:()=>null,hasPointerCapture:id=>id===1};
 const context=vm.createContext({element:button,window:{__ttBrowserHandoffInput:{pointerIds:[]}},document:{elementFromPoint:()=>button,elementsFromPoint:()=>[button],querySelectorAll:()=>[divider]},getComputedStyle:()=>({pointerEvents:'auto'}),devicePixelRatio:1.25,innerWidth:1440,innerHeight:900});
 const locator={evaluate:callback=>vm.runInContext(`(${callback.toString()})(element,{x:1284.15,y:203.8})`,context)};
 const app={browserWindow:async()=>({evaluate:async()=>native,dispose:async()=>{}})};
 const receipt=await readBrowserInputGeometry(app,{},locator);
 assert.equal(receipt.hitIsButton,true);assert.equal(receipt.connected,true);
 assert.equal(receipt.captured.length,1);assert.equal(receipt.captured[0].pointerId,1);assert.equal(receipt.captured[0].element.className,'pane-divider');
});


test('toolbar regression requires trusted down/up/click events on the same button and subtree',()=>{
 const events=['pointerdown','mousedown','pointerup','mouseup','click'].map(type=>({type,trusted:true,target:{nodeId:1},control:{nodeId:2}}));
 assert.doesNotThrow(()=>assertBrowserButtonClick(events,'Screenshot to Chat'));
 assert.throws(()=>assertBrowserButtonClick(events.slice(0,4),'Screenshot to Chat'),/complete pointer/);
 const replaced=structuredClone(events);replaced[1].target.nodeId=3;assert.throws(()=>assertBrowserButtonClick(replaced,'Screenshot to Chat'),/subtree stays mounted/);
 const remounted=structuredClone(events);remounted[2].control.nodeId=4;assert.throws(()=>assertBrowserButtonClick(remounted,'Page console'),/button stays mounted/);
 const synthetic=structuredClone(events);synthetic[4].trusted=false;assert.throws(()=>assertBrowserButtonClick(synthetic,'Page console'),/real trusted/);
});
