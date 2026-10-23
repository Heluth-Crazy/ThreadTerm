import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {oc2VisualEntry} from './oc2-opencode-visual-fixture.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
test('OC2 visual TSX fixture compiles before Electron is needed',()=>{
  const result=ts.transpileModule(oc2VisualEntry(),{fileName:'oc2-fixture.tsx',reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
  assert.deepEqual(result.diagnostics?.filter(item=>item.category===ts.DiagnosticCategory.Error),[]);
  assert.match(result.outputText,/attachChatImages/);
});

test('OC2 visual bridge supplies a connection snapshot the production reducer accepts',async()=>{
  const window={};
  const fixture=ts.transpileModule(oc2VisualEntry(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(fixture,{exports:{},window,document:{getElementById:()=>({})},require:name=>name==='react-dom/client'?{createRoot:()=>({render(){}})}:{}});
  const module={exports:{}};
  const reducer=ts.transpileModule(readFileSync(resolve('renderer/src/chatConnection.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(reducer,{module,exports:module.exports,require:()=>({agentName:()=> 'OpenCode'})});
  const {emptyLink,reduceChatLink}=module.exports;
  for(const method of ['chat.connection','chat.connect']){
    const snapshot=await window.threadterm.request(method,{sessionId:'oc2-visual'});
    const next=reduceChatLink(emptyLink('oc2-visual'),{type:'snapshot',snapshot});
    assert.equal(next.connection.phase,'ready',`${method} must release the production connection fence`);
    assert.equal(next.connection.sessionId,'oc2-visual');assert.equal(next.connection.runtimeEpoch,'oc2-visual-epoch');
    assert.equal(next.connection.revision,1);assert.equal(next.connection.optionsLoadState,'ready');
  }
});
