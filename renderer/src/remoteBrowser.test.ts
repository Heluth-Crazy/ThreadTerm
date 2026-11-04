import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewAddress, remoteLoopbackUrl } from './remoteBrowser';
test('Preview address opens the machine panel remotely and preserves the local iframe path',()=>{
 const panel:string[]=[],iframe:string[]=[];
 previewAddress('http://localhost:5173',true,url=>panel.push(url),url=>iframe.push(url));
 assert.deepEqual(panel,['http://localhost:5173/']);assert.equal(iframe.length,0);
 previewAddress('http://localhost:5173',false,url=>panel.push(url),url=>iframe.push(url));
 assert.deepEqual(iframe,['http://localhost:5173/']);assert.equal(panel.length,1);
 previewAddress('https://example.com/path',true,url=>panel.push(url),url=>iframe.push(url));assert.equal(panel[1],'https://example.com/path');
 assert.throws(()=>previewAddress('file:///C:/test',true,()=>assert.fail('panel'),()=>assert.fail('iframe')));
});
test('remote terminal loopback spellings route to the panel, while public URLs keep their normal action',()=>{
 for(const host of ['localhost','APP.localhost','127.0.0.1','127.234.1.2','127.1','0x7f000001','[::1]','localhost.','[::ffff:127.0.0.1]'])assert.ok(remoteLoopbackUrl(`http://${host}:5173/`),host);
 for(const url of ['https://example.com/','http://localhost.example.com/','file:///C:/test'])assert.ok(!remoteLoopbackUrl(url),url);
});
