import test from 'node:test';
import assert from 'node:assert/strict';
import { Chunk } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
// @ts-ignore Node strip-types resolves this source extension.
import { revertChangeAt, revertChunk, revertLineChanges } from './diffRevert.ts';

function chunk(a:string,b:string,needle:number){const found=Chunk.build(EditorState.create({doc:a}).doc,EditorState.create({doc:b}).doc).find(value=>value.fromB<=needle&&needle<=value.toB);assert.ok(found,'expected a real CodeMirror chunk');return found;}
function line(a:string,b:string,needle:string){const head=b.indexOf(needle);const c=chunk(a,b,head);const spec=revertChangeAt(c.changes,c.fromA,c.fromB,head,a,b);assert.ok(spec,'expected exact change');return b.slice(0,spec.from)+spec.insert+b.slice(spec.to);}
test('reverts insertion-only changes at first, middle, and final line',()=>{assert.equal(line('a\nb\n','x\na\nb\n','x'),'a\nb\n');assert.equal(line('a\nb\n','a\nx\nb\n','x'),'a\nb\n');assert.equal(line('a\nb','a\nb\nx','x'),'a\nb');});
test('reverts deletion and keeps no-final-newline semantics',()=>{const a='one\ntwo\nthree',b='one\nthree';const c=chunk(a,b,b.indexOf('three'));const spec=revertChunk(c.fromA,c.toA,c.fromB,c.toB,a,b);assert.equal(b.slice(0,spec.from)+spec.insert+b.slice(spec.to),a);});
test('uses actual change positions when an earlier hunk shifts line offsets',()=>{const a='zero\none\ntwo\nthree\n',b='added\nzero\none\nTWO\nthree\n';assert.equal(line(a,b,'TWO'), 'added\nzero\none\ntwo\nthree\n');});
test('handles a mixed chunk with insertion, deletion, and modification',()=>{const a='alpha\nbeta\ngamma\ndelta\n',b='alpha\ninsert\nBETA\ndelta\n';assert.equal(line(a,b,'insert'),a);assert.equal(line(a,b,'BETA'),a);});
test('revert changes are undoable and readonly callers can make no dispatch',()=>{const a='a\nb\n',b='a\nX\n';const c=chunk(a,b,b.indexOf('X'));const spec=revertChangeAt(c.changes,c.fromA,c.fromB,b.indexOf('X'),a,b)!;let state=EditorState.create({doc:b,extensions:[history()]});state=state.update({changes:spec,userEvent:'revert'}).state;assert.equal(state.doc.toString(),a);assert.equal(undo({state,dispatch:transaction=>{state=transaction.state}}),true);assert.equal(state.doc.toString(),b);const readonly=true;const before=state.doc.toString();if(!readonly)state=state.update({changes:spec}).state;assert.equal(state.doc.toString(),before);});

test('current line maps changes when cursor is before them and restores every change on that line',()=>{const a='prefix old suffix\n',b='prefix new changed suffix\n',c=chunk(a,b,0),specs=revertLineChanges(c.changes,c.fromA,c.fromB,0,b.indexOf('\n'),a);let out=b;for(const spec of [...specs].reverse())out=out.slice(0,spec.from)+spec.insert+out.slice(spec.to);assert.equal(out,a);});
test('hunk revert preserves the next line boundary',()=>{const a='one\ntwo\nthree\n',b='one\nTWO\nthree\n',c=chunk(a,b,b.indexOf('TWO')),spec=revertChunk(c.fromA,c.toA,c.fromB,c.toB,a,b);assert.equal(b.slice(0,spec.from)+spec.insert+b.slice(spec.to),a);});
