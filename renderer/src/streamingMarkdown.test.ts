import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatMarkdown } from './chatMath';
import { splitStreamingMarkdown } from './streamingMarkdown';

// Replies as agents write them, cut at every character the way a stream delivers them.
const corpus = [
  '## 结论\n\n运行时先把每一段输出写进数据库（见 `runtime/src/output.rs:120`），窗口再读回来。\n\n- 修改 `src/app.ts:12`\n- 第二点：**加粗** 和 *斜体*\n  续行\n\n1. 第一\n2. 第二\n\n   松散列表的段落\n\n3. 第三\n\n```ts\nconst value = compute(input);\n\nreturn value;\n```\n\n结尾。',
  'Display math:\n\n$$\nx^2 + y^2\n\n= z^2\n$$\n\nInline $a+b$ here.\n\n$$\nunfinished',
  '| 场景 | 改前 | 改后 |\n|---|:---:|---:|\n| 打字 | 84 ms | 31 ms |\n| 切换 | 70 ms | 23 ms |\n\nAfter the table.\n',
  'Setext heading\n===\n\nAnother\n---\n\nparagraph\nwith a break  \nand more\n\n***\n\n> quote line\nlazy continuation\n\n> second quote\n\nend',
  '- outer\n  - inner one\n  - inner two\n\n    indented para in item\n\n- outer two\n\n      code inside item\n\nText after list.\n\n    indented code block\n    second line\n\nDone.',
  'Links: [text](https://example.com "t"), <https://auto.link>, ![img](https://example.com/a.png), `code with $dollar$`, \\*escaped\\*.\n\n```\nopen fence with blank\n\nlines and $$ inside\n',
  '~~~json\n{"a": 1}\n~~~\n\n```mermaid\ngraph TD; A-->B\n```\n\n- [ ] task\n- [x] done\n\n1) paren list\n2) two\n\nfin',
  '\n\nleading blank lines\n\n\n\nmany blanks\n\n',
  'Windows line ends\r\n\r\n- one\r\n- two\r\n\r\ndone\r\n',
];

const html = (text: string) => String(parseChatMarkdown(text));

test('blocks add up to the text and render exactly like the whole text at every cut', () => {
  for (const doc of corpus) {
    for (let cut = 0; cut <= doc.length; cut++) {
      const text = doc.slice(0, cut);
      const split = splitStreamingMarkdown(text);
      assert.equal(split.kind, 'blocks', `no fallback needed at ${JSON.stringify(text)}`);
      if (split.kind !== 'blocks') continue;
      assert.equal(split.blocks.join(''), text.replace(/\r\n?/g, '\n'), `blocks add up at ${JSON.stringify(text)}`);
      assert.equal(split.blocks.map(html).join(''), html(text), `same HTML at ${JSON.stringify(text)}`);
    }
  }
});

test('ordinary replies split into several blocks', () => {
  const split = splitStreamingMarkdown(corpus[0]);
  assert.ok(split.kind === 'blocks' && split.blocks.length >= 5, 'one block per paragraph, list and fence');
  assert.deepEqual(splitStreamingMarkdown('just one line'), { kind: 'blocks', blocks: ['just one line'] });
  assert.deepEqual(splitStreamingMarkdown(''), { kind: 'blocks', blocks: [] });
});

test('a later delta can change an earlier block: an open display-math block swallows the paragraphs after it', () => {
  const before = splitStreamingMarkdown('$$\nx\n\ny');
  const after = splitStreamingMarkdown('$$\nx\n\ny\n$$\n\nz');
  assert.ok(before.kind === 'blocks' && after.kind === 'blocks');
  assert.notEqual(before.blocks[0], after.blocks[0]);
  assert.equal(after.blocks.map(html).join(''), html('$$\nx\n\ny\n$$\n\nz'));
});

test('text whose blocks cannot be rendered apart is rendered whole', () => {
  const whole = { kind: 'whole' };
  assert.deepEqual(splitStreamingMarkdown('see [x][ref]\n\n[ref]: https://a.b\n\nmore'), whole, 'reference definitions');
  assert.deepEqual(splitStreamingMarkdown('<details>\n\ninside\n\n</details>'), whole, 'block HTML');
  assert.deepEqual(splitStreamingMarkdown('a <b>bold\n\nnext</b> end'), whole, 'inline HTML across paragraphs');
  assert.deepEqual(splitStreamingMarkdown('- item <kbd>K</kbd>'), whole, 'inline HTML in a list item');
  assert.deepEqual(splitStreamingMarkdown('| a |\n|---|\n| <br> |'), whole, 'inline HTML in a table cell');
  const middle = splitStreamingMarkdown('- a\n- \n- b\n\nafter');
  if (middle.kind === 'blocks') assert.equal(middle.blocks.map(html).join(''), html('- a\n- \n- b\n\nafter'));
  else assert.deepEqual(middle, whole, 'an empty item inside a list');
});

test('inline display math inside a paragraph is read with extra line breaks, so the reply renders whole once a block follows', () => {
  // The lexer reports this paragraph's source as "Inline \n$$c\n$$ here." (the block extension's start splits it).
  const tail = splitStreamingMarkdown('a\n\nInline $$c$$ here.');
  assert.ok(tail.kind === 'blocks', 'as the last block it is the rest of the text');
  assert.equal(tail.blocks.map(html).join(''), html('a\n\nInline $$c$$ here.'));
  assert.deepEqual(splitStreamingMarkdown('a\n\nInline $$c$$ here.\n\nnext'), { kind: 'whole' });
});

test('blank lines before the first block belong to it, so no block renders empty', () => {
  const split = splitStreamingMarkdown('\n\n## Plan\n\ntext');
  assert.ok(split.kind === 'blocks');
  assert.deepEqual(split.blocks, ['\n\n## Plan\n\n', 'text']);
  assert.ok(split.blocks.every(block => html(block).trim()), 'every block has content');
  assert.deepEqual(splitStreamingMarkdown('\n\n'), { kind: 'blocks', blocks: ['\n\n'] });
});
