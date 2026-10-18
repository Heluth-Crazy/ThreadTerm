import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as browserAgentUi from '../renderer/src/browserAgentUi.ts';

const ts=createRequire(import.meta.url)('typescript');
const capture={shot:{id:'00000000-0000-4000-8000-000000000000',path:'C:/shots/page.png',width:40,height:30,thumbnail:'data:image/jpeg;base64,AA=='},dataUrl:'data:image/png;base64,c25hcA==',url:'https://example.test/',documentGeneration:3,width:40,height:30};

function fixture(extra={}){
 const states=[],refs=[],effects=[],portals=[],commands=[];let stateIndex=0,refIndex=0,browserListener,resolveCapture,rejectCapture;
 const body={kind:'document-body'},placeholder={getBoundingClientRect:()=>({x:101.4,y:202.6,width:403.7,height:304.2})};
 const react={
  useId:()=>':browser-markup-fixture:',
  useState:initial=>{const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
  useRef:initial=>refs[refIndex++]??(refs[refIndex-1]={current:initial}),
  useEffect:callback=>effects.push(callback),
 };
 const bridge={
  browserCommand:value=>{commands.push(value);return Promise.resolve();},
  browserHandoff:value=>value.type==='capture'?new Promise((resolve,reject)=>{resolveCapture=resolve;rejectCapture=reject;}):Promise.resolve({entries:[],errors:0,warnings:0}),
  onBrowserEvent:listener=>{browserListener=listener;return()=>{};},onBrowserHandoffEvent:()=>()=>{},deletePageShots:()=>Promise.resolve(),openExternal:()=>Promise.resolve(),onPageContextMenu:()=>()=>{},
 };
 const ScreenshotMarkup=Symbol('ScreenshotMarkup');
 const require=name=>{
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='react-dom')return {createPortal:(child,target)=>{const portal={type:'portal',child,target};portals.push(portal);return portal;}};
  if(name==='../bridge')return bridge;
  if(name==='../browserAgentUi')return browserAgentUi;
  if(name==='../browserOcclusion')return {usePassiveBrowserOcclusion(){},watchBrowserOverlays:()=>()=>{},updateBrowserOverlayBounds(){}};
  if(name==='./PageComments')return {PageCommentControls:Symbol('PageCommentControls'),PageCommentForm:Symbol('PageCommentForm'),PageHandoffDestination:Symbol('PageHandoffDestination'),ScreenshotMarkup,usePageCommentPreview:()=>({frameName:'tt-preview-native',provenance:{previewId:'preview-a'},enabled:true,cancel(){},acceptPick(){}})};
  if(name==='./FileComments')return {PendingComments:Symbol('PendingComments'),useReviewComments:()=>[]};
  if(name==='./ContextMenu')return {showContextMenu(){}};
  if(name==='../webContextMenuItems')return {webContextMenuItems:()=>[]};
  if(name==='../pageShotDraft')return {addPageShotToDraft:async()=>{}};
  return {};
 };
 const module={exports:{}};
 const compiled=ts.transpileModule(readFileSync('renderer/src/components/WebPreview.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(compiled,{require,module,exports:module.exports,document:{body},window:{dispatchEvent(){}},Node:class{},KeyboardEvent:class{},Element:class{},ResizeObserver:class{observe(){}disconnect(){}},addEventListener(){},removeEventListener(){},requestAnimationFrame(){}});
 const render=(visible=true)=>{stateIndex=0;refIndex=0;effects.length=0;portals.length=0;const tree=module.exports.WebPreview({tabId:'tab-a',url:'https://example.test/',visible,zh:false,commentsHost:{},...extra});refs[0].current=placeholder;return tree;};
 const find=(node,predicate)=>{if(!node)return; if(predicate(node))return node;const children=node.props?.children;for(const child of Array.isArray(children)?children:[children]){const found=find(child,predicate);if(found)return found;}};
 return {render,find,effects,portals,commands,body,ScreenshotMarkup,get browserListener(){return browserListener;},get resolveCapture(){return resolveCapture;},get rejectCapture(){return rejectCapture;}};
}

function placeholderFrom(tree){
 const walk=node=>{if(!node)return; if(node.props?.className==='tt-browser-view')return node.props.ref?.current;const children=node.props?.children;for(const child of Array.isArray(children)?children:[children]){const found=walk(child);if(found)return found;}};
 return walk(tree);
}

test('screenshot markup remains mounted outside the native placeholder across an occlusion snapshot',async()=>{
 const f=fixture();let tree=f.render();
 // This subscription receives the snapshot emitted by native-page occlusion
 // immediately after the editor mounts.
 f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();assert.equal(typeof f.browserListener,'function');
 const button=f.find(tree,node=>node.props?.['aria-label']==='Screenshot to Chat');assert.ok(button,'real toolbar exposes Screenshot to Chat');
 button.props.onClick();assert.equal(typeof f.resolveCapture,'function','real capture IPC is pending');
 f.resolveCapture(capture);await new Promise(resolve=>setImmediate(resolve));tree=f.render();
 assert.equal(f.portals.length,1,'capture mounts one markup editor');
 let portal=f.portals[0];assert.equal(portal.child.type,f.ScreenshotMarkup,'portal records the real markup child');
 assert.notEqual(portal.target,placeholderFrom(tree),'editor cannot target the React-managed native placeholder');
 assert.equal(portal.target,f.body,'editor uses the stable app overlay host');
 assert.equal(portal.child.props.capture,capture,'capture payload reaches markup unchanged');
 assert.equal(JSON.stringify(portal.child.props.bounds),JSON.stringify({x:101.4,y:202.6,width:403.7,height:304.2}),'markup receives the visible page bounds for its overlay host');
 f.browserListener({type:'state',state:{tabId:'tab-a',url:capture.url,title:'',loading:false,canGoBack:false,canGoForward:false,zoom:1,navigation:'load_observed',documentGeneration:3,unloaded:false,snapshot:'data:image/png;base64,c25hcA==',snapshotGeneration:9}});
 tree=f.render();assert.equal(f.portals.length,1,'snapshot state keeps exactly one editor mounted');portal=f.portals[0];assert.equal(portal.target,f.body,'snapshot reconciliation preserves the independent overlay host');assert.equal(portal.child.props.capture,capture,'snapshot reconciliation retains the captured image');
 tree=f.render(false);assert.equal(f.portals.length,1,'hiding the browser tab keeps the editor state');portal=f.portals[0];assert.equal(portal.target,f.body);assert.equal(portal.child.type,f.ScreenshotMarkup);assert.equal(portal.child.props.capture,capture);assert.equal(portal.child.props.visible,false,'hidden tab disables the visible markup surface and its focus trap');
 tree=f.render(true);assert.equal(f.portals.length,1,'showing the browser tab restores the retained editor');portal=f.portals[0];assert.equal(portal.target,f.body);assert.equal(portal.child.type,f.ScreenshotMarkup);assert.equal(portal.child.props.capture,capture);assert.equal(portal.child.props.visible,true);
});

const loadedState={tabId:'tab-a',url:capture.url,title:'',loading:false,canGoBack:false,canGoForward:false,zoom:1,navigation:'load_observed',documentGeneration:3,unloaded:false};
test('capture errors remain visible across unrelated browser state events and clear on retry',async()=>{
 const f=fixture();f.render();f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();f.browserListener({type:'state',state:loadedState});let tree=f.render();
 const button=()=>f.find(tree,node=>node.props?.['aria-label']==='Screenshot to Chat');
 assert.equal(button().props.disabled,false);button().props.onClick();f.rejectCapture(new Error('Page screenshot save failed: EACCES'));
 await new Promise(resolve=>setImmediate(resolve));tree=f.render();
 const alert=()=>f.find(tree,node=>node.props?.['data-browser-handoff-error']!==undefined);
 assert.match(alert().props.children,/save failed: EACCES/);assert.equal(tree.props['data-handoff-state'],'error');assert.equal(f.portals.length,0);
 f.browserListener({type:'state',state:{...loadedState,zoom:1.1}});tree=f.render();assert.match(alert().props.children,/save failed: EACCES/,'an unrelated state event cannot erase the failed capture');
 button().props.onClick();tree=f.render();assert.equal(alert(),undefined);assert.equal(tree.props['data-handoff-state'],'capturing');assert.equal(button().props['aria-busy'],true);
 f.resolveCapture(capture);await new Promise(resolve=>setImmediate(resolve));tree=f.render();assert.equal(tree.props['data-handoff-state'],'markup');assert.equal(f.portals.length,1);
});
test('capture stays disabled until a document is observed and groups page actions for wrapping',()=>{
 const f=fixture();let tree=f.render();const button=()=>f.find(tree,node=>node.props?.['aria-label']==='Screenshot to Chat');
 assert.equal(button().props.disabled,true,'a pending page is not ready even before loading becomes true');
 f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();f.browserListener({type:'state',state:loadedState});tree=f.render();assert.equal(button().props.disabled,false);
 assert.equal(tree.props['data-document-generation'],3);const actions=f.find(tree,node=>node.props?.className==='wb-browser-actions');
 for(const label of ['Screenshot to Chat','Page console','Find in page','Open in browser'])assert.ok(f.find(actions,node=>node.props?.['aria-label']===label),`${label} belongs to the wrapping action group`);
});


test('browser toolbar glyphs and console/find controls survive unrelated renders',()=>{
 const f=fixture();f.render();f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();
 f.browserListener({type:'state',state:{...loadedState,canGoBack:true,canGoForward:true}});
 let tree=f.render();
 const labels=['Back','Forward','Reload','Screenshot to Chat','Find in page','Open in browser'];
 const icons=labels.map(label=>f.find(tree,node=>node.props?.['aria-label']===label).props.children.props.name);
 // Pane selection re-renders WebPreview with unchanged props; console/state
 // events can also land between pointerdown and mousedown.
 for(let index=0;index<3;index++){
  f.browserListener({type:'state',state:{...loadedState,title:`title ${index}`,canGoBack:true,canGoForward:true}});tree=f.render();
  labels.forEach((label,position)=>assert.equal(f.find(tree,node=>node.props?.['aria-label']===label).props.children.props.name,icons[position],`${label}: same glyph after state update`));
 }
 const consoleButton=()=>f.find(tree,node=>node.props?.['aria-label']==='Page console');
 assert.equal(consoleButton().props['aria-expanded'],false);consoleButton().props.onClick();tree=f.render();assert.equal(consoleButton().props['aria-expanded'],true);
 consoleButton().props.onClick();tree=f.render();assert.equal(consoleButton().props['aria-expanded'],false);
 const find=f.find(tree,node=>node.props?.['aria-label']==='Find in page');find.props.onClick();tree=f.render();
 const findIcons=['Previous match','Next match','Close find'].map(label=>f.find(tree,node=>node.props?.['aria-label']===label).props.children.props.name);
 tree=f.render();['Previous match','Next match','Close find'].forEach((label,index)=>assert.equal(f.find(tree,node=>node.props?.['aria-label']===label).props.children.props.name,findIcons[index]));
});

test('reload and stop still change glyphs when loading changes',()=>{
 const f=fixture();f.render();f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();f.browserListener({type:'state',state:loadedState});let tree=f.render();
 const glyph=label=>f.find(tree,node=>node.props?.['aria-label']===label).props.children.props.name;
 const reload=glyph('Reload');f.browserListener({type:'state',state:{...loadedState,loading:true}});tree=f.render();const stop=glyph('Stop');assert.notEqual(stop,reload);
 tree=f.render();assert.equal(glyph('Stop'),stop);f.browserListener({type:'state',state:loadedState});tree=f.render();assert.equal(glyph('Reload'),reload);
});

test('Read waits for saved scope and discards intent when the document changes during save',async()=>{
 for(const changed of [false,true]){
 let finishSave;const f=fixture({prepareBrowserShare:()=>new Promise(resolve=>{finishSave=resolve;})});f.render();f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();
 const sharing={level:'off',status:'idle',grantEpoch:7,viewGeneration:4,navigationEpoch:8,reading:false};
 f.browserListener({type:'state',state:{...loadedState,sharing}});let tree=f.render();f.find(tree,node=>node.props?.['aria-label']==='Agent access Read').props.onClick();
 assert.equal(f.commands.length,0,'a toolbar click cannot share an unsaved layout');
 if(changed){f.browserListener({type:'state',state:{...loadedState,documentGeneration:4,sharing:{...sharing,navigationEpoch:9}}});tree=f.render();}
 finishSave({id:'saved-workspace',revision:12});await new Promise(done=>setImmediate(done));
 assert.equal(JSON.stringify(f.commands),JSON.stringify(changed?[]:[{type:'share',tabId:'tab-a',level:'read',workspace:{id:'saved-workspace',revision:12},expected:{documentGeneration:3,navigationEpoch:8,viewGeneration:4,grantEpoch:7}}]),changed?'a changed document cancels the intent before native grant admission':'an unchanged document sends exactly its captured fence after save');
 }
});

test('Off cancels a delayed Read save without sending a later grant request',async()=>{
 let finishSave;const f=fixture({prepareBrowserShare:()=>new Promise(resolve=>{finishSave=resolve;})});f.render();f.effects.find(effect=>String(effect).includes('onBrowserEvent'))();
 f.browserListener({type:'state',state:{...loadedState,sharing:{level:'off',status:'idle',grantEpoch:0,viewGeneration:1,navigationEpoch:1,reading:false}}});let tree=f.render();f.find(tree,node=>node.props?.['aria-label']==='Agent access Read').props.onClick();tree=f.render();
 f.find(tree,node=>node.props?.['aria-label']==='Agent access Off').props.onClick();await new Promise(done=>setImmediate(done));finishSave({id:'workspace',revision:1});await new Promise(done=>setImmediate(done));
 assert.equal(JSON.stringify(f.commands),JSON.stringify([{type:'share',tabId:'tab-a',level:'off'}]));
});
