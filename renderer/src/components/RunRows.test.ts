import assert from 'node:assert/strict';
import test from 'node:test';
import { runCatalogReady } from './RunRows';

test('run commands wait for the initial repo catalog read', () => {
 assert.equal(runCatalogReady({loading:false,detecting:false,repoLoading:true}),false);
 assert.equal(runCatalogReady({loading:true,detecting:false,repoLoading:false}),false);
 assert.equal(runCatalogReady({loading:false,detecting:true,repoLoading:false}),false);
 assert.equal(runCatalogReady({loading:false,detecting:false,repoLoading:false}),true);
});
