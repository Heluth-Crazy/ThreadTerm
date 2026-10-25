import test from 'node:test';
import assert from 'node:assert/strict';
import {METHODS,validateRequest,validateResult} from './index.ts';

const draft={draftId:'comment-1',draft:{id:'comment-1',body:'Saved'},revision:1,deleted:false,updatedAt:'2026-10-25T00:00:00Z'};

test('revisioned review-draft requests and runtime-shaped results are bounded and typed',()=>{
 for(const method of ['reviewDrafts.list','reviewDrafts.upsert','reviewDrafts.delete','reviewDrafts.importLegacy','reviewDrafts.assetReferences']) assert.ok(METHODS.includes(method));
 validateRequest('reviewDrafts.list',{scopeProjectId:'project',scopeRoot:'root',after:'comment-0',limit:100});
 validateRequest('reviewDrafts.upsert',{draftId:'comment-1',draft:{id:'comment-1'},assetPaths:['shots/comment-1.png'],expectedRevision:0,operationId:'upsert'});
 validateRequest('reviewDrafts.delete',{draftId:'comment-1',expectedRevision:1,operationId:'delete'});
 validateRequest('reviewDrafts.importLegacy',{marker:'review-comments-local-storage-v1',drafts:[],complete:false,operationId:'partial'});
 validateRequest('reviewDrafts.assetReferences',{after:'shots/0.png',limit:100});
 validateResult('reviewDrafts.list',{drafts:[draft],nextAfter:'comment-1'});
 validateResult('reviewDrafts.upsert',{status:'conflict',draft});
 validateResult('reviewDrafts.delete',{status:'deleted',draftId:'comment-1',revision:2});
 validateResult('reviewDrafts.importLegacy',{imported:true,complete:false});
 validateResult('reviewDrafts.assetReferences',{paths:['shots/comment-1.png'],nextAfter:'shots/comment-1.png',legacyImportComplete:false});
 assert.throws(()=>validateResult('reviewDrafts.list',{drafts:[{...draft,scopeRoot:null}]}));
 assert.throws(()=>validateResult('reviewDrafts.assetReferences',{paths:[],nextAfter:null,legacyImportComplete:true}));
});
