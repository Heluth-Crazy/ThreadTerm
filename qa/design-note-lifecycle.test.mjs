import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(){
 const states=[],refs=[],deps=[],effects=[],calls={added:0,sent:0};let si=0,ri=0,ei=0,save,inspect;
 const pick=id=>({url:'https://example.test',target:{type:'element',selector:`#${id}`,label:id},shot:{id}});
 const preview={pick:pick('old'),pickScopeKey:'scope',scopeKey:'scope',pending:[],provenance:{previewId:'preview'},host:{},batch:false,frameName:'frame',isCurrentPick:value=>preview.pick===value,added(){calls.added++;},resume(){}};
 const react={useState(initial){const index=si++;if(!(index in states))states[index]=initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef(initial){return refs[ri++]??(refs[ri-1]={current:initial});},useEffect(callback,next){const index=ei++;if(!deps[index]||next.some((value,i)=>value!==deps[index][i])){deps[index]=next;effects.push(callback);}}};
 const require=name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}:name==='../reviewComments'?{isPageComment:note=>note.kind==='page',MAX_REVIEW_COMMENT_BODY:4000,pageCommentLabel:target=>target.label,pageTargetRef:target=>({selector:target.selector}),addPageComment:()=>new Promise(resolve=>save=resolve)}:name==='../designDelivery'?{deliverDesignNotes:async()=>{calls.sent++;}}:name==='../bridge'?{inspectPageTarget:()=>new Promise(resolve=>inspect=resolve)}:name==='../browserOcclusion'?{useBrowserOcclusion(){}}:{};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('renderer/src/components/DesignMode.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require,requestAnimationFrame:callback=>callback()});
 const render=()=>{si=ri=ei=0;const tree=module.exports.DesignNoteCard({preview,scope:{projectId:'project',root:'C:/work'},zh:false});while(effects.length)effects.shift()();return tree;};
 const find=(node,predicate)=>{if(!node)return;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}};
 return {preview,calls,pick,render,find,resolveSave:()=>save([{kind:'page',id:'saved',body:'Old note',provenance:{previewId:'preview'}}]),resolveInspect:()=>inspect({styles:{color:'old-card-value'},cssEdits:[{property:'color',before:'old',after:'old-card-value'}]})};
}

test('a delayed save cannot send, clear, or leak the screenshot of a newer selection',async()=>{
 const f=fixture();let tree=f.render();f.find(tree,node=>node.type==='textarea').props.onChange({target:{value:'Old note'}});tree=f.render();f.find(tree,node=>node.props?.['aria-label']==='Send note').props.onClick();
 const next=f.pick('new');f.preview.pick=next;f.render();f.resolveSave();await tick();
 assert.equal(f.calls.sent,0);assert.equal(f.calls.added,0);assert.equal(f.preview.pick,next);assert.equal(f.preview.pick.shot.id,'new');
});

test('a delayed CSS inspector cannot replace the properties of a newer card',async()=>{
 const f=fixture();let tree=f.render();f.find(tree,node=>node.type==='button'&&node.props.children?.includes?.('CSS')).props.onClick();f.preview.pick=f.pick('new');f.render();f.resolveInspect();await tick();tree=f.render();
 assert.doesNotMatch(JSON.stringify(tree),/old-card-value/);
});
