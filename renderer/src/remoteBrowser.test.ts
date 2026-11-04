import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewAddress, remoteLoopbackUrl, isRemoteSignInUrl, terminalLinkOpensInPanel } from './remoteBrowser';
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

const signInCases: Array<[string, boolean]> = [
  ['https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback', true],
  ['https://auth.example/authorize?redirect_uri=http://localhost:1455/callback', true],
  ['https://auth.example/authorize?ReDiReCt_Url=https%3A%2F%2Fapp.localhost%3A443%2Fcallback', true],
  ['http://auth.example/?redirect_url=http://127.234.1.2:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://[::1]:3000/callback', true],
  ['https://auth.example/?redirect_uri=http%3A%2F%2F%5B%3A%3Affff%3A127.2.3.4%5D%3A3000%2Fcallback', true],
  ['https://auth.example/?redirect_uri=http://[::ffff:7f02:304]:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://LOCALHOST.:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://127.1/callback', true],
  ['https://auth.example/?redirect_uri=http://0x7f000001/callback', true],
  ['https://auth.example/?redirect_uri=https://public.example/callback', false],
  ['https://auth.example/device', false],
  ['https://auth.example/code?user_code=QA', false],
  ['https://auth.example/?redirect_uri=http://localhost.example.com/callback', false],
  ['https://auth.example/?redirect_uri=http://lvh.me/callback', false],
  ['https://accounts.google.com/o/oauth2/auth?redirect_uri=http://localhost:3000/callback', false],
  ['https://signin.google.com/?redirect_url=http://127.0.0.1/callback', false],
  ['https://GOOGLE.COM./?redirect_uri=http://localhost/callback', false],
  ['https://notgoogle.com/?redirect_uri=http://localhost/callback', true],
  ['https://google.com.example/?redirect_uri=http://localhost/callback', true],
  ['ftp://auth.example/?redirect_uri=http://localhost/callback', false],
  ['javascript:alert(1)?redirect_uri=http://localhost/callback', false],
  ['https://auth.example/?redirect_uri=file:///C:/callback', false],
  ['https://auth.example/?redirect_uri=ws://localhost/callback', false],
  ['not a URL', false],
  ['https://auth.example/?redirect_uri=%ZZ&redirect_url=http://localhost/callback', true],
];


test('sign-in links use literal HTTP callbacks and exclude Google, with matching renderer/desktop cases', () => {
  for (const [url, expected] of signInCases) assert.equal(isRemoteSignInUrl(url), expected, url);
});

test('remote link decision opens host callbacks in the panel and keeps local, Google and device-code actions', () => {
  for (const [url, expected] of signInCases) {
    assert.equal(terminalLinkOpensInPanel(url, true), expected, `remote ${url}`);
    assert.equal(terminalLinkOpensInPanel(url, false), false, `local ${url}`);
  }
  for (const url of ['http://localhost:5173/', 'http://127.234.1.2:3000/', 'http://[::ffff:127.2.3.4]/']) {
    assert.equal(terminalLinkOpensInPanel(url, true), true);
    assert.equal(terminalLinkOpensInPanel(url, false), false);
  }
});
