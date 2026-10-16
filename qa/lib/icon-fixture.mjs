import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url),ts=require('typescript');
export function loadIcons(transform=source=>source){
 const load=(path,dependencies={})=>{
  const module={exports:{}},source=transform(readFileSync(path,'utf8'));
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>dependencies[name]??require(name)});
  return module.exports;
 };
 const prototype=load('renderer/src/components/PrototypeIcon.tsx');
 return {...prototype,...load('renderer/src/workbench/icons.tsx',{'../components/PrototypeIcon':prototype})};
}

export const iconSamples=[
 ['Icon',{name:'back'}],['Icon',{name:'settings',className:'sample',width:18}],
 ['Icon',{name:'export'}],['Icon',{name:'missing-icon'}],
 ['WbIcon',{name:'refresh'}],['WbIcon',{name:'file-plus',className:'sample','data-test':'glyph'}],
 ['WbIcon',{name:'settings'}],['WbIcon',{name:'missing-icon'}],
 ['AgentIcon',{provider:'Codex',size:20}],['AgentIcon',{provider:'Claude Code'}],
 ['AgentIcon',{provider:'Gemini'}],['AgentIcon',{provider:'unknown'}],
];
