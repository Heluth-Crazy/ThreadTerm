import assert from 'node:assert/strict';
// QA-only input receipts. DOM hit testing alone cannot see a native child view.
export function compareNativeInputBounds(renderer,native){
 const point={x:renderer.point.x*native.zoom,y:renderer.point.y*native.zoom};
 const button={x:renderer.button.x*native.zoom,y:renderer.button.y*native.zoom,width:renderer.button.width*native.zoom,height:renderer.button.height*native.zoom};
 return {...renderer,native:{...native,point,button,views:native.views.map(view=>({...view,containsClick:point.x>=view.bounds.x&&point.x<view.bounds.x+view.bounds.width&&point.y>=view.bounds.y&&point.y<view.bounds.y+view.bounds.height,overlapsButton:button.x<view.bounds.x+view.bounds.width&&button.x+button.width>view.bounds.x&&button.y<view.bounds.y+view.bounds.height&&button.y+button.height>view.bounds.y}))}};
}

export async function readBrowserInputGeometry(app,page,button,point){
 const renderer=await button.evaluate((element,point)=>{
  const rect=element.getBoundingClientRect(),box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const describe=node=>node?{tag:node.tagName,id:node.id,className:typeof node.className==='string'?node.className:'',label:node.getAttribute('aria-label'),rect:box(node)}:null;
  point??={x:rect.x+rect.width/2,y:rect.y+rect.height/2};const hit=document.elementFromPoint(point.x,point.y),preview=element.closest('.wb-web-preview');
  const captured=[...document.querySelectorAll('.pane-divider,button')].flatMap(node=>[...new Set([1,...(window.__ttBrowserHandoffInput?.pointerIds??[])])].filter(id=>node.hasPointerCapture(id)).map(id=>({pointerId:id,element:describe(node)})));
  return {point,button:box(element),placeholder:box(preview?.querySelector('.tt-browser-view')),toolbar:box(preview?.querySelector('.wb-browser-toolbar')),hit:describe(hit),hitIsButton:!!hit&&element.contains(hit),stack:document.elementsFromPoint(point.x,point.y).slice(0,8).map(describe),captured,connected:element.isConnected,disabled:element.disabled,pointerEvents:getComputedStyle(element).pointerEvents,devicePixelRatio:devicePixelRatio,viewport:{width:innerWidth,height:innerHeight}};
 },point);
 const owner=await app.browserWindow(page);let native;
 try{native=await owner.evaluate(window=>({zoom:window.webContents.getZoomFactor(),views:window.contentView.children.flatMap(view=>view.webContents?[{id:view.webContents.id,url:view.webContents.getURL(),bounds:view.getBounds()}]:[])}));}finally{await owner.dispose();}
 return compareNativeInputBounds(renderer,native);
}

export async function beginBrowserInputTrace(page){
 await page.evaluate(()=>{
  window.__ttBrowserHandoffInput?.stop();const events=[],pointerIds=[],nodeIds=new WeakMap();let nextNodeId=0;
  const describe=node=>node?{nodeId:nodeIds.get(node)??(nodeIds.set(node,++nextNodeId),nextNodeId),tag:node.tagName,id:node.id,className:typeof node.className==='string'?node.className:'',label:node.getAttribute?.('aria-label')}:null;
  const types=['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','mousedown','mouseup','click'];
  const listener=event=>{if(events.length>=100)return;if(Number.isInteger(event.pointerId)&&!pointerIds.includes(event.pointerId))pointerIds.push(event.pointerId);events.push({type:event.type,x:event.clientX,y:event.clientY,pointerId:event.pointerId,buttons:event.buttons,trusted:event.isTrusted,target:describe(event.target),control:describe(event.composedPath?.().find(node=>node.tagName==='BUTTON')),path:event.composedPath?.().slice(0,6).map(describe),hit:describe(document.elementFromPoint(event.clientX??0,event.clientY??0))});};
  for(const type of types)addEventListener(type,listener,true);
  window.__ttBrowserHandoffInput={events,pointerIds,stop:()=>{for(const type of types)removeEventListener(type,listener,true);}};
 });
}

export async function endBrowserInputTrace(page){
 return page.evaluate(()=>{const trace=window.__ttBrowserHandoffInput;if(!trace)return [];trace.stop();delete window.__ttBrowserHandoffInput;return trace.events;});
}

// Keep the drag in app chrome. A mid-page drag can enter the native view's old
// bounds while renderer layout and main-process bounds are catching up.
export function chromeDividerPoints(parent,divider,toolbar,endX){
 const top=Math.max(parent.y,divider.y,toolbar.y),bottom=Math.min(parent.y+parent.height,divider.y+divider.height,toolbar.y+toolbar.height);
 if(bottom-top<2)throw Error('Divider has no shared app-chrome strip');
 return {x:divider.x+divider.width/2,y:(top+bottom)/2,endX};
}

// A path disappearing between pointerdown and mousedown cancels Chromium's click.
export function assertBrowserButtonClick(events,label){
 const sequence=events.filter(event=>['pointerdown','mousedown','pointerup','mouseup','click'].includes(event.type));
 assert.deepEqual(sequence.map(event=>event.type),['pointerdown','mousedown','pointerup','mouseup','click'],`${label}: complete pointer/mouse/click sequence`);
 assert.ok(sequence.every(event=>event.trusted),`${label}: real trusted input`);
 const first=sequence[0];assert.ok(first.control?.nodeId&&first.target?.nodeId,`${label}: button and hit node identities recorded`);
 assert.ok(sequence.every(event=>event.control?.nodeId===first.control.nodeId),`${label}: pressed button stays mounted`);
 assert.ok(sequence.every(event=>event.target?.nodeId===first.target.nodeId),`${label}: pressed subtree stays mounted`);
}
