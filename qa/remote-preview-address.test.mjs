import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as remoteBrowser from '../renderer/src/remoteBrowser.ts';
const ts=createRequire(import.meta.url)('typescript');
function fixture(remote){
 const states=[],commands=[];let index=0,cancellations=0;
 const react={lazy:()=>()=>null,Suspense:'suspense',useEffect(){},useState(initial){const slot=index++;if(!(slot in states))states[slot]=typeof initial==='function'?initial():initial;return[states[slot],value=>{states[slot]=typeof value==='function'?value(states[slot]):value;}];}};
 const preview={cancel(){cancellations++;},frameName:'tt-preview-address',iframe:{current:null}};
 const require=name=>{
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../bridge')return{browserCommand:async command=>commands.push(command)};
  if(name==='../remoteFiles')return{isRemoteFiles:()=>remote};
  if(name==='../remoteBrowser')return remoteBrowser;
  if(name==='./PageComments')return{usePageCommentPreview:()=>preview};
  if(name==='./FileComments')return{useReviewComments:()=>[]};
  return{};
 };
 const module={exports:{}};const code=ts.transpileModule(readFileSync('renderer/src/components/FilePreview.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require,document:{documentElement:{lang:'en'}},URL});
 const render=()=>{index=0;return module.exports.FilePreview({projectId:'host-project',path:'notes.txt',content:'',savedContent:''});};
 const nodes=tree=>{const out=[];function visit(value){if(Array.isArray(value)){value.forEach(visit);return;}if(value&&typeof value==='object'&&value.props){out.push(value);visit(value.props.children);}}visit(tree);return out;};
 return{render,nodes,commands,get cancellations(){return cancellations;}};
}
test('real FilePreview Preview address sends a remote panel command and never mounts its app iframe',async()=>{
 const f=fixture(true);let tree=f.render();f.nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'http://localhost:5173'}});tree=f.render();f.nodes(tree).find(node=>node.type==='button'&&node.props.children==='Preview address').props.onClick();await Promise.resolve();
 assert.equal(f.commands.length,1);assert.equal(f.commands[0].type,'open');assert.equal(f.commands[0].url,'http://localhost:5173/');assert.equal(f.nodes(f.render()).filter(node=>node.type==='iframe').length,0);
});
test('real local FilePreview retains the live iframe and does not send a panel command',()=>{
 const f=fixture(false);let tree=f.render();f.nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'http://localhost:5173'}});tree=f.render();f.nodes(tree).find(node=>node.type==='button'&&node.props.children==='Preview address').props.onClick();
 const frames=f.nodes(f.render()).filter(node=>node.type==='iframe');assert.equal(frames.length,1);assert.equal(frames[0].props.src,'http://localhost:5173/');assert.equal(frames[0].props.sandbox,'allow-scripts allow-forms');assert.equal(f.commands.length,0);
});

test('invalid local Preview address leaves the existing page pick untouched',()=>{
 const f=fixture(false);let tree=f.render();f.nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'file:///C:/fixture'}});tree=f.render();f.nodes(tree).find(node=>node.type==='button'&&node.props.children==='Preview address').props.onClick();assert.equal(f.cancellations,0);assert.equal(f.commands.length,0);assert.ok(f.nodes(f.render()).some(node=>node.props.role==='alert'));
});
