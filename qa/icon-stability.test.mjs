import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { iconSamples, loadIcons } from './lib/icon-fixture.mjs';
import { iconDomHost } from './lib/icon-dom-host.mjs';

// Keep one installed React instance with the VM-loaded components even when
// the QA runner bundles this test with esbuild.
const require=createRequire(import.meta.url),{createElement}=require('react'),{flushSync}=require('react-dom'),{createRoot}=require('react-dom/client'),{renderToStaticMarkup}=require('react-dom/server');
const icons=loadIcons();
test('sample icon markup is byte-identical to the pre-round-6 output',()=>{
 const expected=JSON.parse(readFileSync('qa/fixtures/icon-markup.json','utf8'));
 assert.equal(expected.length,iconSamples.length);
 iconSamples.forEach(([name,props],index)=>assert.equal(renderToStaticMarkup(createElement(icons[name],props)),expected[index],`${name} ${JSON.stringify(props)}`));
});

test('resolved icon names share frozen innerHTML props, including aliases and fallbacks',()=>{
 for(const [component,names] of [[icons.Icon,['settings','gear']],[icons.Icon,['missing-a','missing-b','file']],[icons.WbIcon,['refresh','refresh']]]){
  const values=names.map(name=>component({name}).props.dangerouslySetInnerHTML);
  assert.ok(Object.isFrozen(values[0]));for(const value of values)assert.equal(value,values[0]);
 }
});

async function rerenderSample(components,name,props){
 const host=iconDomHost(),previousWindow=globalThis.window,previousDocument=globalThis.document;
 globalThis.window=host.window;globalThis.document=host.document;
 const root=createRoot(host.container);
 try{
  const render=props=>flushSync(()=>root.render(createElement(components[name],props)));
  render(props);const svg=host.container.firstChild,children=[...svg.childNodes],writes=svg.htmlWrites;
  assert.ok(children.length>0,'real React DOM mounted opaque SVG children');
  for(let index=0;index<3;index++){
   render({...props,...(name==='AgentIcon'?{size:20+index}:{className:`render-${index}`})});
   assert.equal(host.container.firstChild,svg,'SVG root survives an ordinary prop update');
   assert.equal(svg.childNodes.length,children.length);
   children.forEach((child,position)=>assert.ok(svg.childNodes[position]===child,'pressed SVG child survives React reconciliation'));
   assert.equal(svg.htmlWrites,writes,'React does not reset innerHTML');
  }
 }finally{flushSync(()=>root.unmount());await new Promise(resolve=>setImmediate(resolve));if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
}

for(const [name,props] of iconSamples)test(`${name} ${props.name??props.provider} retains child nodes across real React DOM re-renders`,()=>rerenderSample(icons,name,props));

test('identity regression detects the preceding fresh-innerHTML implementation',async()=>{
 const before=loadIcons(source=>source
  .replace('dangerouslySetInnerHTML={iconHtml[aliases[name]??name]??iconHtml.file}','dangerouslySetInnerHTML={{__html:icons[aliases[name]??name]??icons.file}}')
  .replace('dangerouslySetInnerHTML={brandHtml[name]}','dangerouslySetInnerHTML={{__html:body}}')
  .replace('dangerouslySetInnerHTML={glyphHtml[name]}','dangerouslySetInnerHTML={{__html:body}}'));
 for(const [name,props] of [['Icon',{name:'back'}],['WbIcon',{name:'refresh'}],['AgentIcon',{provider:'Codex'}]])await assert.rejects(()=>rerenderSample(before,name,props),/pressed SVG child survives React reconciliation/);
});
