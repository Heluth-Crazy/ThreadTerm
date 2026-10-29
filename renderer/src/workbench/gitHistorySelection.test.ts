import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultGitHistoryRovingCommit, resolveGitHistoryTarget} from './gitHistorySelection';

const hashes=['a1b2c3d4e5f6','b2c3d4e5f6a1'];
test('an explicit prefix collision is not resolved from a page containing only one match',()=>{
 const loaded=['abc123'],target='abc'; // Another repository commit, abc456, is outside this page.
 assert.equal(resolveGitHistoryTarget(target,loaded),undefined);
 assert.equal(resolveGitHistoryTarget(target,loaded,{target,hash:'abc456'}),undefined,'a backend-resolved commit outside the page selects no row');
 assert.equal(resolveGitHistoryTarget(target,loaded,{target,hash:'abc123'}),'abc123','only the backend result selects a row');
 assert.equal(resolveGitHistoryTarget(target,loaded,{target:'previous-target',hash:'abc123'}),undefined);
});
test('an explicit target outside the first page selects no unrelated row',()=>{
 const firstPage=Array.from({length:100},(_,index)=>`a${index.toString(16).padStart(39,'0')}`);
 assert.equal(resolveGitHistoryTarget('deadbeef',firstPage,{target:'deadbeef',hash:'deadbeef123'}),undefined);
});
test('only history without an explicit target defaults its roving row to the first loaded commit',()=>{
 assert.equal(defaultGitHistoryRovingCommit(undefined,undefined,hashes),hashes[0]);
 assert.equal(defaultGitHistoryRovingCommit(undefined,'deadbeef',hashes),undefined);
 assert.equal(defaultGitHistoryRovingCommit(hashes[1],undefined,hashes),hashes[1],'a user-selected row persists after the explicit target clears');
});
