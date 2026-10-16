import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedTopLevelUrl, expiredHidden, lruVictims, normalizeBrowserUrl } from './policy.ts';

test('address normalization recognizes hosts, ports and IPv6 without introducing search', () => {
 for(const [input,expected] of [['example.test/a','https://example.test/a'],['localhost:3000','https://localhost:3000/'],['[::1]:3000','https://[::1]:3000/'],['127.0.0.1:8080','https://127.0.0.1:8080/'],['https://example.test/','https://example.test/'],['about:blank','about:blank']])assert.equal(normalizeBrowserUrl(input).url,expected,input);
 for(const input of ['hello','hello world','search terms',''])assert.ok(normalizeBrowserUrl(input).issue,input);
});

test('top-level policy refuses executable, local, custom and opaque blob documents', () => {
 for(const input of ['file:///secret','javascript:alert(1)','data:text/html,hello','custom:page','blob:null/id','blob:https://other.test/id'])assert.equal(allowedTopLevelUrl(input,'https://example.test'),false,input);
 for(const input of ['https://example.test/','http://localhost:3000/','about:blank','blob:https://example.test/id'])assert.equal(allowedTopLevelUrl(input,'https://example.test'),true,input);
 assert.equal(allowedTopLevelUrl('blob:https://example.test/id'),false);
});

test('LRU evicts hidden views in shown order, retaining every visible view', () => {
 const tabs=[{id:'a',visible:false,shownAt:2},{id:'b',visible:false,shownAt:1},{id:'c',visible:true,shownAt:0}];
 assert.deepEqual(lruVictims(tabs,2),['b']);assert.deepEqual(lruVictims(tabs,1),['b','a']);assert.deepEqual(lruVictims(tabs,6),[]);
 assert.deepEqual(lruVictims((function*(){yield* tabs;})(),2),['b']);
});

test('idle expiration honors the boundary and zero means never', () => {
 const tabs=[{id:'old',visible:false,hiddenAt:10},{id:'new',visible:false,hiddenAt:11},{id:'visible',visible:true,hiddenAt:0}];
 assert.deepEqual(expiredHidden(tabs,600010,10),['old']);assert.deepEqual(expiredHidden(tabs,600011,10),['old','new']);
 assert.deepEqual(expiredHidden(tabs,999999,0),[]);assert.deepEqual(expiredHidden(tabs,600009,10),[]);
});
