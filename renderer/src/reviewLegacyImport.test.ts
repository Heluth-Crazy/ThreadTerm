import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalScopePath } from "./projectScope";
import { ensureReviewCommentsImported, loadReviewComments } from "./reviewComments";

test("legacy import is bounded, retryable, and removed only after the final acknowledgement", async () => {
  const scope={projectId:"legacy",root:join(tmpdir(),"threadterm-legacy-review")};
  const key=`threadterm.v3.file-comments:${scope.projectId}:${canonicalScopePath(scope.root)}`;
  const comments=Array.from({length:17},(_,index)=>({...scope,id:`legacy-${index}`,path:`src/${index}.ts`,version:{kind:"file"},side:"new",startLine:1,endLine:1,excerpt:"x",body:`comment ${index}`,createdAt:new Date(1700000000000+index).toISOString()}));
  const values=new Map([[key,JSON.stringify(comments)]]),rows=new Map<string,unknown>();
  const batches:Array<{ids:string[];complete:boolean}>=[];
  let failSecond=true, complete=false;
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null,getItem:(name:string)=>values.get(name)??null,removeItem:(name:string)=>values.delete(name)}});
  (globalThis as unknown as {window:unknown}).window={threadterm:{request:async(method:string,params:Record<string,unknown>)=>{
    if(method==="reviewDrafts.list")return {drafts:[...rows.values()]};
    assert.equal(method,"reviewDrafts.importLegacy");
    const batch=params.drafts as {draftId:string;draft:unknown;scopeProjectId:string;scopeRoot:string}[];
    batches.push({ids:batch.map(draft=>draft.draftId),complete:params.complete===true});
    assert.ok(values.has(key),"legacy key remains until all requests are acknowledged");
    assert.ok(batch.length<=8);
    if(failSecond&&batches.length===2){failSecond=false;throw new Error("interrupted import");}
    if(!complete)for(const draft of batch)if(!rows.has(draft.draftId))rows.set(draft.draftId,{...draft,revision:1,updatedAt:"now"});
    if(params.complete===true)complete=true;
    return {imported:true,complete};
  },onEvent:()=>()=>{}}};
  try {
    await assert.rejects(ensureReviewCommentsImported(),/interrupted import/);
    assert.equal(values.has(key),true);assert.equal(complete,false);assert.equal(rows.size,8);
    await ensureReviewCommentsImported();
    assert.deepEqual(batches.map(batch=>batch.ids.length),[8,8,8,8,1]);
    assert.deepEqual(batches.map(batch=>batch.complete),[false,false,false,false,true]);
    assert.equal(values.has(key),false);assert.equal(complete,true);assert.equal(rows.size,17);
    await ensureReviewCommentsImported();
    assert.equal(batches.length,5,"successful import runs only once per renderer lifecycle");
    assert.equal((await loadReviewComments(scope)).length,17);
  } finally {delete (globalThis as {localStorage?:unknown}).localStorage;}
});
