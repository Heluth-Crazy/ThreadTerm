import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash,webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const require=createRequire(resolve('package.json')),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const code=buildSync({stdin:{contents:`export {ChatApprovalCard} from './renderer/src/components/ChatApprovalCard';export {BrowserEvalCodeReview} from './renderer/src/components/BrowserEvalApprovalCard';export {SettingsBrowser} from './renderer/src/components/SettingsBrowser';export {ToolCard} from './renderer/src/components/ToolCards';export {HistoryTranscript} from './renderer/src/components/HistoryTranscript';export {I18nProvider} from './renderer/src/i18n';`,resolveDir:resolve('.')},bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},write:false,logLevel:'silent'}).outputFiles[0].text;
const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require,TextEncoder,URL,crypto:webcrypto});
const {ChatApprovalCard,BrowserEvalCodeReview,SettingsBrowser,ToolCard,HistoryTranscript,I18nProvider}=module.exports;
const snippet='  const title = "<script>PRIVATE</script>界😀";\r\n\ttitle;  ';
const summary={approvalId:'approval-a',operationId:'browser-operation',callerSessionId:'chat-a',tabId:'tab-a',origin:'https://source.test',codeHash:createHash('sha256').update(snippet).digest('hex'),codeByteLength:Buffer.byteLength(snippet),expiresAtUnixMs:Date.now()+60_000,settingsGeneration:'runtime:7'};
const rawImage='data:image/png;base64,UFJJVkFURQ==';
const part={type:'approval',approvalId:'approval-a',status:'pending',text:'PRIVATE',fileReferences:[{path:'D:/PRIVATE'}],data:{...summary,runtimeOwned:true,requestType:'threadterm.browser_eval',code:snippet,result:'PRIVATE',error:'PRIVATE',title:'PRIVATE',details:{code:snippet},images:[rawImage],choices:[{id:'approve_once',label:'PRIVATE'},{id:'deny',label:'PRIVATE'}]}};
const context={sessionId:'chat-a',turnId:'turn-a',leaseEpoch:2,generation:'runtime:connection',live:true,writable:true};
const copy=(en,zh)=>en;
const renderApproval=(candidate=part,...contexts)=>renderToStaticMarkup(React.createElement(ChatApprovalCard,{part:candidate,writable:true,browserEvalContext:contexts.length?contexts[0]:context,onChoose:()=>{throw new Error('eval must not use generic approval');},copy}));

test('actual runtime eval card routes before generic raw details and waits for verified targeted code',()=>{
 const html=renderApproval();assert.match(html,/Browser code approval/);assert.match(html,/https:\/\/source.test/);assert.match(html,/chat-a/);
 assert.match(html,/Loading exact code for review/);assert.match(html,/<button[^>]*disabled=""[^>]*>Approve once<\/button>/);
 assert.match(html,/>Deny<\/button>/);assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes(rawImage),false);
 assert.equal(html.includes('Request details'),false);assert.equal(html.includes('<script>'),false);assert.equal(html.includes('Always'),false);
});

test('actual history, settled, observer and mismatched-session approvals never render code or actionable controls',()=>{
 for(const status of ['resolved','expired','failed','outcomeUnknown','dismissed']){
  const html=renderApproval({...part,status});assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes('<button'),false);assert.match(html,/inactive/);
 }
 for(const guard of [undefined,{...context,writable:false},{...context,live:false},{...context,sessionId:'other'},{...context,leaseEpoch:0}]){
  const html=renderApproval(part,guard);assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes('<button'),false);assert.match(html,/inactive/);
 }
 const malformed=renderApproval({...part,data:{...part.data,codeHash:'invalid'}});assert.equal(malformed.includes('PRIVATE'),false);assert.equal(malformed.includes('<button'),false);
});

test('actual exact-code leaf displays escaped plaintext with whitespace and CRLF intact',()=>{
 const {callerSessionId,...metadata}=summary;
 const html=renderToStaticMarkup(React.createElement(BrowserEvalCodeReview,{review:{...metadata,status:'pending',code:snippet},copy}));
 assert.match(html,/<pre[^>]*tabindex="0"[^>]*aria-label="Exact code to review"/);
 assert.ok(html.includes('  const title = &quot;&lt;script&gt;PRIVATE&lt;/script&gt;界😀&quot;;\r\n\ttitle;  '));
 assert.equal(html.includes('<script>'),false);assert.match(html,new RegExp(summary.codeHash));assert.match(html,/bytes/);
});

test('actual eval tool cards and imported history hide scalar, exception, code, raw images and references',()=>{
 const candidate={type:'tool',toolName:'mcp__threadterm__browser_eval',status:'completed',text:'PRIVATE',fileReferences:[{path:'D:/PRIVATE'}],data:{server:'threadterm',tool:'browser_eval',input:{code:snippet},result:{scalar:'PRIVATE',error:'PRIVATE'},images:[rawImage],browserActivity:{tool:'browser_eval',outcome:'outcome_unknown',origin:'https://source.test',code:snippet,result:'PRIVATE',error:'PRIVATE',thumbnail:rawImage}}};
 for(const open of [false,true]){
  const html=renderToStaticMarkup(React.createElement(ToolCard,{entry:{id:'tool-a',itemId:'item-a',part:candidate},index:0,open,active:false,awaitingApproval:false,copy}));
  assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes(rawImage),false);assert.match(html,/Outcome unknown/);assert.equal(html.includes('Completed'),false);
 }
 for(const item of [candidate,part]){
  const html=renderToStaticMarkup(React.createElement(I18nProvider,{locale:'en'},React.createElement(HistoryTranscript,{items:[{id:'history-a',role:'assistant',createdAt:'',parts:[item]}]})));
  assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes(rawImage),false);assert.equal(html.includes('<button'),false);
 }
 const ordinary={...candidate,toolName:'mcp__foreign__browser_eval',data:{server:'foreign',tool:'browser_eval',input:{code:'ordinary foreign input'},result:'ordinary foreign output'}};
 const html=renderToStaticMarkup(React.createElement(ToolCard,{entry:{id:'tool-b',itemId:'item-b',part:ordinary},index:0,open:true,active:false,awaitingApproval:false,copy}));assert.match(html,/ordinary foreign input/);assert.match(html,/ordinary foreign output/);
});

test('runtime eval setting defaults off and accepts only main-confirmed strict Boolean',()=>{
 for(const value of [undefined,false,'true',1,null,true]){
  const html=renderToStaticMarkup(React.createElement(SettingsBrowser,{zh:false,settings:{revision:7,...(value===undefined?{}:{browserEvalEnabled:value})},update:async()=>{}}));
  const input=html.match(/<input[^>]*aria-label="Allow browser page code requests"[^>]*>/)?.[0];assert.ok(input);
  assert.equal(input.includes('checked=""'),value===true);assert.match(html,/Each exact snippet still requires approval once/);
  assert.match(html,/Off by default/);assert.match(html,/Turning this off invalidates pending code approvals/);
 }
});
