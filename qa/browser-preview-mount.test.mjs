import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as browserAgentUi from '../renderer/src/browserAgentUi.ts';
import * as browserAddress from '../renderer/src/browserAddress.ts';
import * as browserDevtools from '../renderer/src/browserDevtools.ts';
import * as browserRadius from '../renderer/src/browserRadius.ts';

const ts=createRequire(import.meta.url)('typescript');
const source=ts.createSourceFile('SessionWorkspace.tsx',readFileSync('renderer/src/components/SessionWorkspace.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
// Execute the real mount gate without importing Chat, Electron, or a browser.
const declarations=source.statements.filter(statement=>ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(value=>['visibleRect','waitForPreviewMount'].includes(value.name.getText(source)))).map(statement=>statement.getText(source)).join('\n');
assert.ok(declarations.includes('waitForPreviewMount'));
const code=ts.transpileModule(declarations,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 const frames=new Map(),timers=new Map();let id=0,now=0;
 const rect={x:0,y:0,top:0,left:0,right:400,bottom:600,width:400,height:600};
 const element=()=>({hidden:false,getBoundingClientRect:()=>rect,closest(){return this.hidden?{}:null;}});
 const chat=element(),placeholder=element(),preview=Object.assign(element(),{dataset:{previewId:'preview-a',documentId:'document-a',webTabId:'tab-a'},ready:false,querySelector(selector){return selector==='.tt-browser-view[data-native-ready="true"]'&&this.ready?placeholder:null;}});
 const context={document:{querySelectorAll:selector=>selector==='[data-content-id="session-owner-a"]'?[chat]:selector==='[data-preview-id]'?[preview]:[]},getComputedStyle:()=>({display:'flex',visibility:'visible'}),innerWidth:1440,innerHeight:920,performance:{now:()=>now},
  requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),clearTimeout:key=>timers.delete(key),window:{setTimeout:fn=>{timers.set(++id,fn);return id;}}};
 const wait=vm.runInNewContext(`${code}\nwaitForPreviewMount`,context);
 const paint=()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();};
 return {chat,preview,placeholder,frames,timers,paint,wait:cancelled=>wait('owner-a','preview-a','document-a','tab-a',cancelled??(()=>false)),expire(){now=2100;paint();}};
}

test('preview acknowledgement waits for native creation, accepts a pending page without an iframe, and cleans up',async()=>{
 const f=fixture();let settled=false;const pending=f.wait().then(value=>{settled=true;return value;});
 f.paint();await Promise.resolve();assert.equal(settled,false,'a toolbar and placeholder alone are not creation proof');
 f.preview.ready=true;f.paint();assert.equal(await pending,true);
 assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
});

test('preview mount gate rejects another tab/document, hidden Chat, and zero-sized native placeholder',async()=>{
 for(const mutate of [f=>{f.preview.dataset.webTabId='other-tab';},f=>{f.preview.dataset.documentId='other-document';},f=>{f.preview.dataset.previewId='other-preview';},f=>{f.chat.hidden=true;},f=>{f.placeholder.getBoundingClientRect=()=>({width:0,height:0});}]){
  const f=fixture();f.preview.ready=true;mutate(f);const pending=f.wait();f.paint();assert.equal(f.frames.size,1);f.expire();assert.equal(await pending,false);assert.equal(f.timers.size,0);
 }
});

test('preview cancellation releases its bounded paint wait',async()=>{
 const f=fixture();const pending=f.wait(()=>true);f.paint();assert.equal(await pending,false);assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
});

test('WebPreview gates creation and snapshot readiness, and ignores an obsolete show reply',async()=>{
 const states=[],refs=[],effects=[],frames=[],commands=[];let stateIndex=0,refIndex=0,listener,placeholder,finishShow;
 const react={useId:()=>':browser-preview-fixture:',useState:initial=>{const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef:initial=>refs[refIndex++]??(refs[refIndex-1]={current:initial}),useEffect:callback=>effects.push(callback)};
 const bridge={browserCommand:command=>{commands.push(command);return command.type==='show'?new Promise(resolve=>{finishShow=resolve;}):Promise.resolve();},onBrowserEvent:callback=>{listener=callback;return()=>{};}};
 const require=name=>{
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../bridge')return bridge;
  if(name==='../browserAgentUi')return browserAgentUi;
  if(name==='../browserAddress')return browserAddress;
  if(name==='../browserDevtools')return browserDevtools;
  if(name==='../browserRadius')return browserRadius;
  if(name==='../browserOcclusion')return {usePassiveBrowserOcclusion(){},watchBrowserOverlays:()=>()=>{}};
  if(name==='./PageComments')return {usePageCommentPreview:()=>({frameName:'tt-preview-native',provenance:{previewId:'preview-a'}})};
  if(name==='./FileComments')return {useReviewComments:()=>[]};
  return {};
 };
 const module={exports:{}};
 const compiled=ts.transpileModule(readFileSync('renderer/src/components/WebPreview.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(compiled,{require,module,exports:module.exports,requestAnimationFrame:callback=>frames.push(callback),ResizeObserver:class{observe(){}},addEventListener(){}});
 const render=(visible=true)=>{stateIndex=0;refIndex=0;effects.length=0;const tree=module.exports.WebPreview({tabId:'tab-a',url:'https://example.test/',visible,zh:false});placeholder=tree.props.children.flat().find(child=>child?.props?.className==='tt-browser-view').props;return placeholder['data-native-ready'];};
 assert.equal(render(),undefined);effects.find(effect=>String(effect).includes('onBrowserEvent'))();
 const state={tabId:'tab-a',url:'https://example.test/',title:'',loading:true,canGoBack:false,canGoForward:false,zoom:1,navigation:'pending',documentGeneration:0};
 listener({type:'state',state:{...state,tabId:'other-tab'}});assert.equal(render(),undefined,'another tab cannot establish readiness');
 listener({type:'state',state});assert.equal(render(),'true','pending navigation is enough after native creation');
 assert.equal(render(false),undefined,'hidden tabs cannot acknowledge a visible presentation');
 listener({type:'state',state:{...state,snapshot:'data:image/png;base64,c25hcHNob3Q=',snapshotGeneration:7}});render();
 const image=placeholder.children;assert.equal(image.type,'img');assert.equal(commands.length,0,'render alone cannot acknowledge an undecoded image');
 image.props.onLoad();assert.equal(commands.length,0,'image load schedules a paint before acknowledgement');
 frames.shift()();assert.equal(commands.length,0,'the loaded replacement gets a full paint opportunity');
 frames.shift()();assert.equal(commands.length,1);assert.equal(commands[0].type,'snapshotReady');assert.equal(commands[0].generation,7);assert.equal(commands[0].tabId,'tab-a');
 placeholder.ref.current={getBoundingClientRect:()=>({x:100,y:100,width:400,height:300}),closest:()=>null};effects.find(effect=>String(effect).includes('ResizeObserver'))();
 listener({type:'state',state:{...state,snapshot:'data:image/png;base64,bmV3',snapshotGeneration:8}});render();
 finishShow(state);await Promise.resolve();await Promise.resolve();render();
 assert.equal(placeholder.children.props.src,'data:image/png;base64,bmV3','a delayed show reply cannot erase the published snapshot');
 listener({type:'state',state:{...state,unloaded:true}});assert.equal(render(),undefined);
});
