import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { conflictResolver } from './conflictEditor';
import { conflictBlocks } from '../workbench/conflictBlocks';
import { dominantLineSeparator, normalizeEditorText, serializeEditorText } from './editorTextSerialization';

test('normalization and output serialization handle every incoming line break without doubling CR', () => {
  const mixed = 'a\r\nb\nc\rd\r\n';
  assert.equal(normalizeEditorText(mixed), 'a\nb\nc\nd\n');
  assert.equal(serializeEditorText(mixed, '\r\n'), 'a\r\nb\r\nc\r\nd\r\n');
  assert.equal(serializeEditorText(mixed, '\n'), 'a\nb\nc\nd\n');
  assert.equal(serializeEditorText('', '\r\n'), '');
  assert.equal(serializeEditorText('no final newline', '\r\n'), 'no final newline');
});

test('the loaded dominant separator is chosen from mixed input with LF as the tie/default', () => {
  assert.equal(dominantLineSeparator('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(dominantLineSeparator('a\r\nb\nc\n'), '\n');
  assert.equal(dominantLineSeparator('a\r\nb\n'), '\n');
  assert.equal(dominantLineSeparator('single line'), '\n');
});

test('fresh CRLF input compares equal to the normalized buffer without emitting a dirty edit', () => {
  const loaded = 'a\r\nb\r\n';
  const state = EditorState.create({doc:loaded});
  assert.equal(state.doc.toString(), normalizeEditorText(loaded));
  assert.equal(state.facet(EditorState.lineSeparator), undefined);
  assert.equal(serializeEditorText(state.doc.toString(), dominantLineSeparator(loaded)), loaded);
});

test('LF clipboard conflict text splits into real lines in a CRLF-loaded editor with decorations', () => {
  const loaded = 'before\r\nafter\r\n';
  const separator = dominantLineSeparator(loaded);
  const state = EditorState.create({doc:loaded, extensions:[conflictResolver(false)]});
  const pasted = '<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n';
  const updated = state.update({changes:{from:state.doc.line(2).from, insert:pasted}}).state;
  assert.equal(updated.doc.lines, 8);
  assert.equal(conflictBlocks(updated.doc.toString()).blocks.length, 1);
  const saved = serializeEditorText(updated.doc.toString(), separator);
  assert.equal(saved, 'before\r\n' + pasted.replace(/\n/g, '\r\n') + 'after\r\n');
  assert.equal(saved.replace(/\r\n/g, '').includes('\n'), false);
});

test('newline replacements keep normalized offsets and serialize with the loaded mixed-EOL dominant format', () => {
  const loaded = 'target\r\nsecond\r\nthird\n';
  const separator = dominantLineSeparator(loaded);
  const state = EditorState.create({doc:loaded});
  const updated = state.update({changes:{from:0, to:6, insert:'one\ntwo'}}).state;
  assert.equal(updated.doc.lines, 5);
  assert.equal(serializeEditorText(updated.doc.toString(), separator), 'one\r\ntwo\r\nsecond\r\nthird\r\n');
});
