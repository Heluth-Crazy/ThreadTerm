import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as browserAddress from '../renderer/src/browserAddress.ts';
import * as browserDevtools from '../renderer/src/browserDevtools.ts';
import * as browserRadius from '../renderer/src/browserRadius.ts';
import * as browserNewTab from '../renderer/src/browserNewTab.ts';
import * as browserPolicy from '../desktop/src/browser/policy.ts';

const ts=createRequire(import.meta.url)('typescript');
function mount(url){
 const states=[],refs=[],effects=[],commands=[],observations=[];let stateIndex=0,refIndex=0,listener;
 const react={useId:()=>':blank:',useState:initial=>{const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef:initial=>refs[refIndex++]??(refs[refIndex-1]={current:initial}),useEffect:effect=>effects.push(effect)};
 const bridge={browserCommand:command=>{commands.push(command);return Promise.resolve();},browserHandoff:()=>Promise.resolve({}),deletePageShots:()=>Promise.resolve(),onBrowserEvent:callback=>{listener=callback;return()=>{};},onBrowserHandoffEvent:()=>()=>{},onPageContextMenu:()=>()=>{},openExternal:()=>Promise.resolve()};
 const require=name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}:name==='react-dom'?{createPortal:value=>value}:name==='../bridge'?bridge:name==='../browserAddress'?browserAddress:name==='../browserDevtools'?browserDevtools:name==='../browserRadius'?browserRadius:name==='../browserNewTab'?browserNewTab:name==='../../../desktop/src/browser/policy'?browserPolicy:name==='../browserOcclusion'?{usePassiveBrowserOcclusion(){},watchBrowserOverlays:()=>()=>{}}:name==='../browserAgentUi'?{browserShareFence:()=>({}),browserControlOrigin:()=>undefined,canRequestBrowserControl:()=>false,createBrowserShareIntents:()=>({capture:()=>({}),current:()=>true,invalidate(){}}),createBrowserStateSequence:()=>({advance(){},reply:async(_,accept)=>accept(await _())}),prepareBrowserShareCommand:async()=>undefined,sameBrowserShareFence:()=>true}:name==='./PageComments'?{usePageCommentPreview:()=>({frameName:'preview',provenance:{},enabled:false}),PageCommentControls:()=>null,PageCommentForm:()=>null,PageHandoffDestination:()=>null,ScreenshotMarkup:()=>null}:name==='./FileComments'?{useReviewComments:()=>[],PendingComments:()=>null}:()=>null;
 const module={exports:{}};const compiled=ts.transpileModule(readFileSync('renderer/src/components/WebPreview.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(compiled,{require,module,exports:module.exports,requestAnimationFrame:callback=>callback(),ResizeObserver:class{observe(){}disconnect(){}unobserve(){}},addEventListener(){},removeEventListener(){},localStorage:{getItem:()=>null,setItem(){}},KeyboardEvent:class{},Node:class{},window:{dispatchEvent(){}}});
 const walk=(value,predicate)=>{if(!value)return; if(predicate(value))return value;const children=Array.isArray(value)?value:value.props?.children;for(const child of Array.isArray(children)?children:[children]){const found=walk(child,predicate);if(found)return found;}};
 const render=({visible=true,addressFocus}={})=>{stateIndex=0;refIndex=0;effects.length=0;const tree=module.exports.WebPreview({tabId:'blank-a',url,visible,zh:false,addressFocus,onNavigation:value=>observations.push(value)});const input=walk(tree,node=>node?.type==='input'&&node.props?.['aria-label']==='Address');const placeholder=walk(tree,node=>node?.props?.className==='tt-browser-view');input.props.ref.current={focus(){this.focused=true;},select(){this.selected=true;}};placeholder.props.ref.current={getBoundingClientRect:()=>({x:0,y:0,width:300,height:200}),closest:()=>null};return{input,placeholder};};
 return{render,effects,commands,observations,get listener(){return listener;}};
}

test('blank WebPreview never creates a native view until Enter normalizes an HTTP(S) address',async()=>{
 const f=mount(browserNewTab.BROWSER_NEW_TAB_URL),first=f.render({addressFocus:'new-request'});
 for(const effect of f.effects)effect();
 assert.equal(first.input.props.value,'');assert.equal(first.input.props.ref.current.focused,true);assert.equal(first.input.props.ref.current.selected,true);assert.equal(f.commands.some(command=>command.type==='show'),false,'blank tab emits no native show');assert.equal(first.placeholder.props['data-native-ready'],undefined);
 first.input.props.onChange({target:{value:'https://example.test/path'}});const typed=f.render();typed.input.props.onKeyDown({key:'Enter',preventDefault(){}});const second=f.render();for(const effect of f.effects)effect();
 assert.ok(f.commands.some(command=>command.type==='show'&&command.url==='https://example.test/path'),'Enter normalizes then activates native show');assert.equal(second.placeholder.props['data-native-ready'],undefined,'readiness waits for the native state event');
 for(const effect of f.effects)effect();f.listener({type:'state',state:{tabId:'blank-a',url:'https://example.test/path',title:'Example',loading:false,canGoBack:false,canGoForward:false,zoom:1,navigation:'load_observed',documentGeneration:1}});f.render();assert.ok(f.observations.some(value=>value.url==='https://example.test/path'&&value.navigation==='load_observed'),'persisted navigation observes the normalized URL');
});

test('forbidden blank-tab input leaves the page DOM-only',()=>{
 const f=mount(browserNewTab.BROWSER_NEW_TAB_URL),view=f.render();view.input.props.onChange({target:{value:'javascript:alert(1)'}});f.render().input.props.onKeyDown({key:'Enter',preventDefault(){}});f.render();for(const effect of f.effects)effect();assert.equal(f.commands.some(command=>command.type==='show'),false);
});

test('selected blank tabs retain tab-strip focus unless a one-shot address focus request is supplied',()=>{
 const f=mount(browserNewTab.BROWSER_NEW_TAB_URL),selected=f.render();for(const effect of f.effects)effect();assert.equal(selected.input.props.ref.current.focused,undefined,'ordinary blank-tab selection does not steal focus from its tab');
 const hidden=f.render({visible:false,addressFocus:'new-request'});for(const effect of f.effects)effect();assert.equal(hidden.input.props.ref.current.focused,undefined,'a queued focus request waits while hidden');
 const shown=f.render({visible:true,addressFocus:'new-request'});for(const effect of f.effects)effect();assert.equal(shown.input.props.ref.current.focused,true,'the request focuses and selects when shown');assert.equal(shown.input.props.ref.current.selected,true);
 const rerendered=f.render({visible:true,addressFocus:'new-request'});for(const effect of f.effects)effect();assert.equal(rerendered.input.props.ref.current.focused,undefined,'the same focus request is consumed once');
});
