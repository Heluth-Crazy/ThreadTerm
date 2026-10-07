import assert from 'node:assert/strict'; import test from 'node:test';
import { webContextMenuItems } from './webContextMenuItems';
const pick={url:'https://x/',title:'x',viewport:{width:1,height:1},target:{type:'element' as const,selector:'#x',tag:'p',label:'p',attributes:{},html:'<p>',text:'hello',rect:{x:0,y:0,width:1,height:1}}};
test('web menu orders target, navigation, then clipboard and keeps disabled comment',()=>{const items=webContextMenuItems({pick,zh:false,enabled:false,comment:()=>{},reload:()=>{},copy:()=>{}});assert.deepEqual(items.map(item=>item.testId),['web-preview-comment-element','web-preview-reload',undefined,'web-preview-copy-element-text']);assert.equal(items[0].disabled,true);});
