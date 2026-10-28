import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictBlocks, conflictReplacement } from './conflictBlocks';

test('parses a two-way block with its marker range and raw side text', () => {
 const text = 'before\n<<<<<<< current branch\nours\n=======\ntheirs\n>>>>>>> incoming branch\nafter\n';
 const parsed = conflictBlocks(text);
 assert.equal(parsed.unparseable, false);
 assert.deepEqual(parsed.blocks, [{
  from:7, to:text.indexOf('after'), startLine:2, endLine:6, ours:'ours\n', theirs:'theirs\n',
 }]);
});

test('parses diff3 and zdiff3-shaped blocks, including an empty base', () => {
 const text = '<<<<<<< ours\ncurrent\n||||||| base\nbase\n=======\nincoming\n>>>>>>> theirs\n<<<<<<<\n|||||||\n=======\n>>>>>>>\n';
 const parsed = conflictBlocks(text);
 assert.equal(parsed.unparseable, false);
 assert.equal(parsed.blocks.length, 2);
 const second = text.indexOf('<<<<<<<\n', 1);
 assert.deepEqual(parsed.blocks[0], { from:0, to:second, startLine:1, endLine:7, ours:'current\n', base:'base\n', theirs:'incoming\n' });
 assert.deepEqual(parsed.blocks[1], { from:second, to:text.length, startLine:8, endLine:11, ours:'', base:'', theirs:'' });
});

test('preserves CRLF text and includes the closing marker newline in the range', () => {
 const text = 'x\r\n<<<<<<< ours\r\nleft\r\n=======\r\nright\r\n>>>>>>> theirs\r\ny\r\n';
 const parsed = conflictBlocks(text);
 assert.equal(parsed.unparseable, false);
 const block = parsed.blocks[0]!;
 assert.equal(block.from, 3);
 assert.equal(block.to, text.indexOf('y\r\n'));
 assert.equal(block.startLine, 2);
 assert.equal(block.endLine, 6);
 assert.equal(block.ours, 'left\r\n');
 assert.equal(block.theirs, 'right\r\n');
});

test('parses multiple blocks and permits a final closing marker at EOF', () => {
 const text = '<<<<<<< a\na\n=======\nb\n>>>>>>> b\nplain\n<<<<<<< c\nc\n=======\nd\n>>>>>>> d';
 const parsed = conflictBlocks(text);
 assert.equal(parsed.unparseable, false);
 assert.equal(parsed.blocks.length, 2);
 assert.deepEqual(parsed.blocks.map(block => [block.startLine, block.endLine, block.ours, block.theirs]), [[1, 5, 'a\n', 'b\n'], [7, 11, 'c\n', 'd\n']]);
 assert.equal(parsed.blocks[1]!.to, text.length);
});

test('creates replacements from raw side slices in every accept order', () => {
 const [block] = conflictBlocks('<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n').blocks;
 assert.ok(block);
 assert.equal(conflictReplacement(block, 'current'), 'current\n');
 assert.equal(conflictReplacement(block, 'incoming'), 'incoming\n');
 assert.equal(conflictReplacement(block, 'current-first'), 'current\nincoming\n');
 assert.equal(conflictReplacement(block, 'incoming-first'), 'incoming\ncurrent\n');
});

test('reports no guessed blocks for malformed, nested, and truncated marker sequences', () => {
 for(const text of [
  '<<<<<<< ours\nonly ours\n',
  '<<<<<<< ours\nleft\n=======\nright\n',
  '<<<<<<< ours\n<<<<<<< nested\n=======\nright\n>>>>>>> theirs\n',
  '<<<<<<< ours\nleft\n||||||| base\nbase\n>>>>>>> theirs\n',
  '<<<<<<< ours\nleft\n======= label\nright\n>>>>>>> theirs\n',
  '<<<<<<<\tours\nleft\n=======\nright\n>>>>>>> theirs\n',
  '>>>>>>> orphan\n',
 ]) {
  assert.deepEqual(conflictBlocks(text), { blocks:[], unparseable:true }, text);
 }
});

test('retains complete blocks before a separate malformed region', () => {
 const complete = '<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n';
 const parsed = conflictBlocks(complete + '<<<<<<< truncated\nvalue\n');
 assert.equal(parsed.unparseable, true);
 assert.equal(parsed.blocks.length, 1);
 assert.deepEqual(parsed.blocks[0], { from:0, to:complete.length, startLine:1, endLine:5, ours:'current\n', theirs:'incoming\n' });
});

test('parses a complete block after an orphan marker but not a nested malformed region', () => {
 const complete = '<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n';
 const afterOrphan = conflictBlocks('>>>>>>> orphan\n' + complete);
 assert.equal(afterOrphan.unparseable, true);
 assert.equal(afterOrphan.blocks.length, 1);
 assert.deepEqual(afterOrphan.blocks[0], { from:'>>>>>>> orphan\n'.length, to:'>>>>>>> orphan\n'.length + complete.length, startLine:2, endLine:6, ours:'current\n', theirs:'incoming\n' });
 const nested = conflictBlocks('<<<<<<< outer\n<<<<<<< inner\na\n=======\nb\n>>>>>>> inner\n');
 assert.deepEqual(nested, { blocks:[], unparseable:true });
});

test('treats unmatched standalone markers in code or strings as unparseable', () => {
 assert.deepEqual(conflictBlocks('```text\n<<<<<<< not a real conflict\n```\n'), { blocks:[], unparseable:true });
 assert.deepEqual(conflictBlocks('const marker = "<<<<<<< inline";\n'), { blocks:[], unparseable:false });
});
