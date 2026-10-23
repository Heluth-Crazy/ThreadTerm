import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeBrowserTitle } from '../renderer/src/browserTypes.ts';
import { validateLayout, validateRequest, validateResult } from '../protocol/index.ts';

const layout=title=>({kind:'pane',id:'pane',tabs:[{id:'web',kind:'web',url:'https://example.test/last-page',...(title===undefined?{}:{title})}],activeTabId:'web'});

test('page titles strip C0/C1 controls and truncate complete Unicode characters at 512 UTF-8 bytes',()=>{
 assert.equal(sanitizeBrowserTitle('A\0\n\t\u007f\u0085B'),'AB');
 assert.equal(sanitizeBrowserTitle('a'.repeat(513)),'a'.repeat(512));
 assert.equal(sanitizeBrowserTitle('😀'.repeat(129)),'😀'.repeat(128));
 assert.equal(sanitizeBrowserTitle('a'.repeat(511)+'😀'),'a'.repeat(511));
 assert.equal(sanitizeBrowserTitle('a'.repeat(510)+'é'+'x'),'a'.repeat(510)+'é');
 assert.equal(sanitizeBrowserTitle('\ud800'),'\ufffd');
});

test('web title is optional and validates UTF-8 bytes and controls at the saved-layout boundary',()=>{
 for(const title of [undefined,'','Title','a'.repeat(512),'😀'.repeat(128)])assert.doesNotThrow(()=>validateLayout(layout(title)));
 for(const title of [null,4,'a'.repeat(513),'😀'.repeat(129),'A\nB','A\u0085B','A\u007fB'])assert.throws(()=>validateLayout(layout(title)),/web tab title/i);
 for(const url of ['about:blank','blob:https://example.test/id']){const value=layout('Title');value.tabs[0].url=url;assert.throws(()=>validateLayout(value),/web tab/i);}
});

test('generated workspace request/result schemas carry the additive title',()=>{
 const value=layout('Saved title');
 validateRequest('workspace.save',{name:'Browser',layout:value,expectedRevision:0,operationId:'save-title'});
 validateResult('workspace.save',{id:'workspace',name:'Browser',layout:value,revision:1});
 const roundtrip=JSON.parse(JSON.stringify(value));assert.equal(roundtrip.tabs[0].title,'Saved title');assert.equal(roundtrip.tabs[0].url,'https://example.test/last-page');
});
