import assert from 'node:assert/strict';
import test from 'node:test';
import { commitGraph, refBadge } from '../renderer/src/workbench/gitGraph.ts';

const c = (hash, ...parents) => ({hash, parents});
const edges = (row, half) => row.edges.filter(edge => edge.half === half).map(({from, to}) => `${from}>${to}`).sort();

test('linear history stays in one column: tip has no top edge, root no bottom edge', () => {
 const {rows, width} = commitGraph([c('c', 'b'), c('b', 'a'), c('a')]);
 assert.equal(width, 1);
 assert.deepEqual(rows.map(row => row.node), [0, 0, 0]);
 assert.deepEqual(edges(rows[0], 'top'), []);
 assert.deepEqual(edges(rows[0], 'bottom'), ['0>0']);
 assert.deepEqual(edges(rows[2], 'top'), ['0>0']);
 assert.deepEqual(edges(rows[2], 'bottom'), []);
});

test('a merged branch opens a lane to the right and converges back where it forked; main keeps column 0', () => {
 // m merges f into main; f and c both branch from b.
 const {rows, width} = commitGraph([c('m', 'c', 'f'), c('f', 'b'), c('c', 'b'), c('b', 'a'), c('a')]);
 assert.equal(width, 2);
 assert.deepEqual(rows.map(row => row.node), [0, 1, 0, 0, 0]);
 assert.deepEqual(edges(rows[0], 'bottom'), ['0>0', '0>1']);
 assert.deepEqual(edges(rows[1], 'top'), ['0>0', '1>1']);
 assert.deepEqual(edges(rows[2], 'bottom'), ['0>0', '1>1']);
 // The fork point: the branch lane converges into main's column.
 assert.deepEqual(edges(rows[3], 'top'), ['0>0', '1>0']);
 assert.deepEqual(edges(rows[3], 'bottom'), ['0>0']);
 // Colours follow lines: main keeps its colour, the branch has another.
 assert.equal(rows[0].color, rows[2].color);
 assert.notEqual(rows[1].color, rows[0].color);
});

test('unrelated tips (all branches) take free columns and never reuse a live lane', () => {
 const {rows, width} = commitGraph([c('x', 'b'), c('y', 'b'), c('b', 'a'), c('a')]);
 assert.equal(width, 2);
 assert.deepEqual(rows.map(row => row.node), [0, 1, 0, 0]);
 assert.deepEqual(edges(rows[1], 'top'), ['0>0']);
 assert.deepEqual(edges(rows[2], 'top'), ['0>0', '1>0']);
 // After converging, the freed column is trimmed.
 assert.equal(rows[3].width, 1);
});

test('lanes still open at the end of a page run to the bottom edge (more commits follow)', () => {
 const {rows} = commitGraph([c('m', 'c', 'f'), c('c', 'b')]);
 assert.deepEqual(edges(rows[1], 'bottom'), ['0>0', '1>1']);
});

test('ref badges: HEAD, tags and real remote branches; local names may contain slashes', () => {
 const remotes = new Set(['origin/main']);
 assert.deepEqual(refBadge('HEAD -> main', remotes), {label:'main', kind:'head'});
 assert.deepEqual(refBadge('tag: v1.0', remotes), {label:'v1.0', kind:'tag'});
 assert.deepEqual(refBadge('origin/main', remotes), {label:'origin/main', kind:'remote'});
 assert.deepEqual(refBadge('origin/HEAD', remotes), {label:'origin/HEAD', kind:'remote'});
 assert.deepEqual(refBadge('qa/feature', remotes), {label:'qa/feature', kind:'branch'});
});
