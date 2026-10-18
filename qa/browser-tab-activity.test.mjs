import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const require=createRequire(resolve('package.json')),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const code=buildSync({entryPoints:['renderer/src/components/BrowserTabActivity.tsx'],bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},write:false,logLevel:'silent'}).outputFiles[0].text;
const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require,TextEncoder,URL});
const {BrowserTabActivity}=module.exports;
const tools=['browser_list_tabs','browser_snapshot','browser_screenshot','browser_console_messages','browser_navigate','browser_click','browser_type','browser_hover','browser_press_key','browser_select_option'];
const operation=(index=0)=>({operationId:`operation-${index}`,tool:tools[index%tools.length],callerSessionId:'chat-safe',phase:'running',admittedAtUnixMs:index,canStop:true});
const render=(operations,zh=false)=>renderToStaticMarkup(React.createElement(BrowserTabActivity,{operations,zh,onStop:async()=>{}}));

test('actual activity component renders only bounded source/caller labels for all ten tools',()=>{
 for(const tool of tools)for(const zh of [true,false]){
  const html=render([{...operation(),tool,origin:'https://source.test/<script>',title:'<script>source title</script>',
   arguments:{text:'PRIVATE',code:'PRIVATE',values:['PRIVATE'],url:'https://PRIVATE'},text:'PRIVATE',result:'PRIVATE',images:['data:image/png;base64,PRIVATE'],refs:['PRIVATE']}],zh);
  assert.equal(html.includes('PRIVATE'),false);assert.equal(html.includes('<script>'),false);
  assert.match(html,/https:\/\/source.test\/&lt;script&gt;/);assert.match(html,/title="&lt;script&gt;source title&lt;\/script&gt;"/);
  assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/<details><summary>/);assert.match(html,/data-operation-id="operation-0"/);
  assert.match(html,zh?/停止/:/Stop/);assert.equal(html.includes('<img'),false);
 }
});

test('actual activity component caps history at fifty and selects the newest active operation',()=>{
 const entries=Array.from({length:56},(_,index)=>({...operation(index),phase:'completed',canStop:false}));
 entries[51]={...entries[51],phase:'running',canStop:true};
 const html=render(entries);assert.equal((html.match(/data-operation-id=/g)??[]).length,50);
 assert.equal(html.includes('data-operation-id="operation-5"'),false);assert.match(html,/Recent operations \(50\)/);
 assert.ok(html.indexOf('data-operation-id="operation-55"')<html.indexOf('data-operation-id="operation-6"'));
 assert.match(html,/Read page<\/strong> · Running/);assert.equal((html.match(/>Stop<\/button>/g)??[]).length,2,'header and retained active row stop the same stable operation');
});

test('unknown and interrupted operations stay settled and never acquire a Stop or success label',()=>{
 for(const zh of [true,false])for(const phase of ['outcome_unknown','cancelled']){
  const html=render([{...operation(),phase,canStop:false,provenanceUnavailable:true}],zh);
  assert.match(html,zh?(phase==='outcome_unknown'?/操作结果未知/:/已中断/):(phase==='outcome_unknown'?/Outcome unknown/:/Interrupted/));
  assert.equal(html.includes('Completed'),false);assert.equal(html.includes('已完成'),false);assert.equal(html.includes('<button'),false);
  assert.match(html,zh?/页面来源信息不可用/:/Page provenance unavailable/);
 }
 assert.equal(render([]),'');
 const html=render([{...operation(),canStop:false}]);assert.equal(html.includes('<button'),false,'running alone cannot authorize Stop');
});

test('actual WebPreview defaults Control to unavailable until main publishes capability',()=>{
 const previewCode=buildSync({entryPoints:['renderer/src/components/WebPreview.tsx'],bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},write:false,logLevel:'silent'}).outputFiles[0].text;
 const previewModule={exports:{}};vm.runInNewContext(previewCode,{module:previewModule,exports:previewModule.exports,require,TextEncoder,URL,crypto:webcrypto});
 const html=renderToStaticMarkup(React.createElement(previewModule.exports.WebPreview,{tabId:'tab-a',url:'https://example.test',visible:true,zh:false,prepareBrowserShare:async()=>({id:'workspace',revision:1})}));
 assert.match(html,/aria-label="Agent access Control" aria-pressed="false" disabled=""/);
 assert.match(html,/aria-label="Agent access Off" aria-pressed="true"/);
 assert.equal(html.includes('Allow agents to control this page?'),false,'initial rendering cannot grant or open confirmation');
 assert.equal(html.includes('eval'),false);
 assert.match(html,/Control also allows page actions/);
});
