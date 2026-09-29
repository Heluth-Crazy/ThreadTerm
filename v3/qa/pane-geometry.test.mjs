import assert from 'node:assert/strict';
import test from 'node:test';
import {paneGeometry,paneRectStyle,PANE_GAP,PANE_DIVIDER_SIZE} from '../renderer/src/paneGeometry.ts';
const pane=id=>({kind:'pane',id,tabs:[],activeTabId:null});
const split=(id,direction,ratio,first,second)=>({kind:'split',id,direction,ratio,first,second});
const measure=(rect,width=1000,height=800)=>Object.fromEntries(Object.entries(rect).map(([key,value])=>[key,value.fraction*(['left','width'].includes(key)?width:height)+value.pixels]));
test('root leaf fills the host and reuses its node identity',()=>{
 const leaf=pane('a');const result=paneGeometry(leaf);assert.equal(result.panes[0].node,leaf);assert.equal(result.splits.length,0);
 assert.deepEqual(measure(result.panes[0].rect),{left:0,top:0,width:1000,height:800});
});
test('nested geometry preserves both gaps and the divider without inherited ratios',()=>{
 const result=paneGeometry(split('root','horizontal',.6,split('nested','vertical',.25,pane('a'),pane('b')),pane('c')));
 const [a,b,c]=result.panes.map(item=>measure(item.rect));const spacing=PANE_GAP*2+PANE_DIVIDER_SIZE;
 assert.deepEqual(a,{left:0,top:0,width:(1000-spacing)*.6,height:(800-spacing)*.25});
 assert.equal(b.top,a.height+spacing);assert.equal(b.height,(800-spacing)*.75);
 assert.equal(c.left,a.width+spacing);assert.ok(Math.abs(c.width-(1000-spacing)*.4)<1e-9);assert.equal(c.height,800);
});
test('adding and collapsing split ancestors preserve the original leaf object',()=>{
 const leaf=pane('a');const nested=split('outer','horizontal',.3,pane('b'),split('inner','vertical',.4,leaf,pane('c')));
 assert.equal(paneGeometry(nested).panes.find(item=>item.node.id==='a').node,leaf);
 assert.equal(paneGeometry(leaf).panes[0].node,leaf);
});
test('CSS offsets support negative pixels and fractional/zoomed host sizes',()=>{
 const [first,second]=paneGeometry(split('root','horizontal',.4,pane('a'),pane('b'))).panes;
 assert.equal(paneRectStyle(first.rect).width,'max(0px, calc(40% - 4.800000000000001px))');
 const a=measure(first.rect,760.5),b=measure(second.rect,760.5);
 assert.ok(Math.abs(a.width+b.width+PANE_GAP*2+PANE_DIVIDER_SIZE-760.5)<1e-9);
 assert.ok(Math.abs(b.left+b.width-760.5)<1e-9);
});
