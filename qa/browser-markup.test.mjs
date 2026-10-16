import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript'),module={exports:{}};
const path=resolve('desktop/src/browser/markup.ts');
vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require});
const {markupPoint,markupRect,markupArrow,parseMarkup,serializeMarkup}=module.exports;
const plain=value=>JSON.parse(JSON.stringify(value));
test('pointer coordinates scale to the original image and clamp to its edges',()=>{
 assert.deepEqual(plain(markupPoint(100,50,400,100)),{x:.25,y:.5});
 assert.deepEqual(plain(markupPoint(-10,1000,400,100)),{x:0,y:1});
 for(const args of [[0,0,0,1],[0,0,1,NaN],[Infinity,0,1,1]])assert.throws(()=>markupPoint(...args),/geometry/);
});
test('reverse rectangle drags and arrows retain correct geometry on a non-square screenshot',()=>{
 assert.deepEqual(plain(markupRect({x:.8,y:.9},{x:.2,y:.1})),{x:.2,y:.1,width:.6000000000000001,height:.8});
 const tips=markupArrow({x:.1,y:.5},{x:.9,y:.5},800,400);
 assert.ok(tips.every(tip=>tip.x<.9));assert.ok(tips[0].y>.5&&tips[1].y<.5);
 assert.ok(Math.abs((tips[0].y-.5)*400-14*Math.sin(.55))<1e-8);
});
test('all four tools round-trip bounded marks using only theme tokens and inert text',()=>{
 const marks=[{tool:'rectangle',color:'--primary',points:[{x:0,y:0},{x:1,y:1}]},{tool:'arrow',color:'--danger',points:[{x:.1,y:.2},{x:.3,y:.4}]},{tool:'pen',color:'--text',points:[{x:.1,y:.1},{x:.2,y:.3},{x:.4,y:.5}]},{tool:'text',color:'--primary',points:[{x:.5,y:.5}],text:'<script>page data</script>'}];
 assert.deepEqual(plain(parseMarkup(serializeMarkup(marks))),marks);
});
test('serialization rejects malformed, unbounded or CSS-injecting marks',()=>{
 const mark={tool:'rectangle',color:'--primary',points:[{x:0,y:0},{x:1,y:1}]};
 for(const marks of [[{...mark,color:'red'}],[{...mark,color:'url(https://evil.test)'}],[{...mark,points:[{x:2,y:0},{x:1,y:1}]}],[{...mark,tool:'html'}],Array(101).fill(mark),[{...mark,tool:'text',points:[{x:0,y:0}],text:'x'.repeat(121)}],[{...mark,tool:'arrow',points:[]}],[{...mark,tool:'pen',points:Array(1001).fill({x:0,y:0})}]])assert.throws(()=>serializeMarkup(marks));
 assert.throws(()=>parseMarkup('x'.repeat(3*1024*1024+1)),/Too much/);
});
