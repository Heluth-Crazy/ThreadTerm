import assert from 'node:assert/strict'; import test from 'node:test';
import { browserDevtoolsShortcut, clampDevtoolsHeight } from './browserDevtools';

const key=(key:string,overrides:Partial<{control:boolean;meta:boolean;shift:boolean;alt:boolean}>={})=>({key,control:false,meta:false,shift:false,alt:false,...overrides});

test('browser DevTools shortcuts select their intended action and panel',()=>{
 assert.deepEqual(browserDevtoolsShortcut(key('F12')),{action:'toggle'});
 assert.deepEqual(browserDevtoolsShortcut(key('I',{control:true,shift:true})),{action:'toggle'});
 assert.deepEqual(browserDevtoolsShortcut(key('J',{control:true,shift:true})),{action:'open',panel:'console'});
 assert.deepEqual(browserDevtoolsShortcut(key('C',{control:true,shift:true})),{action:'open',panel:'elements'});
 assert.deepEqual(browserDevtoolsShortcut(key('I',{meta:true,shift:true})),{action:'toggle'});
 assert.deepEqual(browserDevtoolsShortcut(key('j',{meta:true,shift:true})),{action:'open',panel:'console'});
 assert.deepEqual(browserDevtoolsShortcut(key('c',{meta:true,shift:true})),{action:'open',panel:'elements'});
});

test('browser DevTools shortcuts reject alt-modified and incomplete chords',()=>{
 assert.equal(browserDevtoolsShortcut(key('F12',{alt:true})),undefined);
 for(const value of ['I','J','C']){
  assert.equal(browserDevtoolsShortcut(key(value,{control:true,shift:true,alt:true})),undefined);
  assert.equal(browserDevtoolsShortcut(key(value,{meta:true,shift:true,alt:true})),undefined);
 }
 assert.equal(browserDevtoolsShortcut(key('I')),undefined);
 assert.equal(browserDevtoolsShortcut(key('I',{control:true})),undefined);
 assert.equal(browserDevtoolsShortcut(key('I',{shift:true})),undefined);
});

test('clampDevtoolsHeight reserves 120px for both page and DevTools',()=>{
 assert.equal(clampDevtoolsHeight(40,600),120);
 assert.equal(clampDevtoolsHeight(500,600),480);
 assert.equal(clampDevtoolsHeight(260,600),260);
 assert.equal(clampDevtoolsHeight(500,200),100);
 assert.equal(clampDevtoolsHeight(0,239),119.5);
 assert.equal(clampDevtoolsHeight(500,240),120);
 assert.equal(clampDevtoolsHeight(500,0),0);
});
