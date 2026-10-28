import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewChangeSummary, reviewChangeTotals, reviewFileLineCounts } from './agentChangeCounts';

test('review file line counts format text files and identify binary files', () => {
 assert.deepEqual(reviewFileLineCounts({added:4,removed:2}), {binary:false,added:4,removed:2});
 assert.deepEqual(reviewFileLineCounts({}), {binary:false,added:0,removed:0});
 assert.deepEqual(reviewFileLineCounts({binary:true,added:4,removed:2}), {binary:true});
});

test('review totals exclude binary files and summaries use both locales', () => {
 const files=[{added:4,removed:2},{binary:true,added:100,removed:100},{removed:3}];
 assert.deepEqual(reviewChangeTotals(files), {added:4,removed:5});
 assert.equal(reviewChangeSummary(files,false), '3 files · +4 −5');
 assert.equal(reviewChangeSummary([{added:1}],true), '1 个文件 · +1 −0');
});
