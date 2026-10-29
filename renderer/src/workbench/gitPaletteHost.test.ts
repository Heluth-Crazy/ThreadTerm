import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureGitPaletteHost,selectGitPaletteHost} from './gitPaletteHost';

const host=(key:string,focused=false,inOverlay=false)=>({key,focused,inOverlay});
test('the top modal Git host fences out a mounted session, including stale background focus',()=>{
 const session=host('session-a',true),modal=host('files-b',false,true);
 assert.equal(selectGitPaletteHost([session,modal],true),modal);
 assert.equal(selectGitPaletteHost([session],true),undefined,'a modal without a Git host must not target the session');
});
test('focus selects its owning host rather than the first visible repository',()=>{
 const session=host('session-a'),files=host('files-b',true);
 assert.equal(selectGitPaletteHost([session,files]),files);
 assert.equal(selectGitPaletteHost([files,session]),files);
});
test('two visible hosts without focus are ambiguous and disabled',()=>{
 assert.equal(selectGitPaletteHost([host('a'),host('b')]),undefined);
 assert.equal(selectGitPaletteHost([host('a',true),host('b',true)]),undefined);
 assert.equal(selectGitPaletteHost([]),undefined);
 const only=host('only');assert.equal(selectGitPaletteHost([only]),only);
});

// A small Document adapter exercises capture's DOM ownership and computed stacking without a browser dependency.
class HostElement {
 dataset:Record<string,string>={};
 parentElement:HostElement|null=null;
 order=0;
 constructor(readonly kind:'overlay'|'scrim'|'context'|'dialog'|'host'|'button',readonly zIndex='auto',readonly rect={left:0,top:0,right:800,bottom:600}){}
 within(parent:HostElement){this.parentElement=parent;return this;}
 contains(element:unknown):boolean{return element instanceof HostElement&&(element===this||this.contains(element.parentElement));}
 matches(selector:string){return selector.split(',').some(part=>part==='.overlay'?this.kind==='overlay':part==='.scrim'?this.kind==='scrim':part.startsWith('[role=')||part.startsWith('dialog')?this.kind==='dialog':false);}
 compareDocumentPosition(other:HostElement){return other===this?0:this.order<other.order?4:2;}
 closest(_selector:string){return null;}
 getClientRects(){return [this.rect];}
 checkVisibility(){return true;}
 getBoundingClientRect(){return this.rect;}
}
function captureFixture(layers:HostElement[],hosts:HostElement[],activeElement:HostElement|null=null){
 const nodes=new Set<HostElement>();
 for(const element of [...layers,...hosts]) {const ancestors:HostElement[]=[];for(let node:HostElement|null=element;node;node=node.parentElement)ancestors.unshift(node);for(const node of ancestors)nodes.add(node);}
 [...nodes].forEach((node,index)=>{node.order=index;});
 const doc={activeElement,defaultView:{getComputedStyle:(element:HostElement)=>({zIndex:element.zIndex,position:element.kind==='context'?'relative':'static'})},
  querySelectorAll:(selector:string)=>selector.startsWith('[role=')?layers.filter(layer=>layer.matches(selector)):hosts,
  elementsFromPoint:()=>{throw new Error('Host stacking must not sample overlap centres');}};
 return captureGitPaletteHost(doc as unknown as Document);
}
function domHost(key:string,parent?:HostElement){
 const element=new HostElement('host');element.dataset={gitWorkbenchHost:key,gitRepository:'true'};
 if(parent)element.within(parent);return element;
}
test('capture chooses the upper partial overlay despite stale focus in the lower layer',()=>{
 const lower=new HostElement('overlay','10'),upper=new HostElement('overlay','20',{left:600,top:0,right:900,bottom:240});
 const a=domHost('a',lower),b=domHost('b',upper);
 assert.equal(captureFixture([lower,upper],[a,b],a)?.key,'b');
 // Computed z-index wins even when the foreground overlay comes first in document order.
 assert.equal(captureFixture([upper,lower],[b,a],a)?.key,'b');
});
test('capture uses overlay document order for equal z-index before considering focus',()=>{
 const lower=new HostElement('overlay','10'),upper=new HostElement('overlay','10');
 const a=domHost('a',lower),b=domHost('b',upper);
 assert.equal(captureFixture([lower,upper],[a,b],a)?.key,'b');
});
test('capture disables two hosts in the same top layer without focus',()=>{
 const top=new HostElement('overlay','20');
 assert.equal(captureFixture([top],[domHost('a',top),domHost('b',top)]),undefined);
});
test('capture uses focus only among hosts in the top overlay layer',()=>{
 const lower=new HostElement('overlay','10'),top=new HostElement('overlay','20'),dialog=new HostElement('dialog').within(top);
 const background=domHost('background',lower),a=domHost('a',dialog),b=domHost('b',dialog),button=new HostElement('button').within(b);
 assert.equal(captureFixture([lower,top,dialog],[background,a,b],button)?.key,'b');
 assert.equal(captureFixture([lower,top,dialog],[background,a,b],background),undefined,'background focus cannot break a foreground tie');
});
test('capture normalizes an auto-z dialog to its foreground scrim at z60 above a Files overlay at z40',()=>{
 const files=new HostElement('overlay','40'),scrim=new HostElement('scrim','60'),dialog=new HostElement('dialog').within(scrim);
 const background=domHost('files',files),foreground=domHost('settings-files',dialog),button=new HostElement('button').within(foreground);
 assert.equal(captureFixture([files,scrim,dialog],[background,foreground],button)?.key,'settings-files');
 assert.equal(captureFixture([files,scrim,dialog],[background,foreground],background)?.key,'settings-files');
});
test('capture compares a portal ancestor stacking context instead of an inner auto-z dialog',()=>{
 const files=new HostElement('overlay','40'),portal=new HostElement('context','60'),dialog=new HostElement('dialog').within(portal);
 const background=domHost('files',files),foreground=domHost('portal-files',dialog);
 assert.equal(captureFixture([files,dialog],[background,foreground],foreground)?.key,'portal-files');
});
