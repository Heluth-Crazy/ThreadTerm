import assert from 'node:assert/strict';
import test from 'node:test';
import { fullTitle } from './ContextTray';

test('external file and selection quote chip tooltips display native paths without changing context', () => {
  for (const kind of ['file', 'quote'] as const) {
    const chip = {kind, title:`${kind === 'file' ? 'File' : 'Quote'}: C:/outside/notes.ts:2-4`};
    assert.equal(fullTitle(chip, false), `${kind === 'file' ? 'File' : 'Quote'}: C:\\outside\\notes.ts:2-4`);
    assert.equal(fullTitle(chip, true), `${kind === 'file' ? '文件' : '引用'}： C:\\outside\\notes.ts:2-4`);
    assert.ok(chip.title.includes('C:/outside/notes.ts'), 'stored chip remains unchanged');
  }
  assert.equal(fullTitle({kind:'quote', title:'Quote: https://example.invalid/a/b'}, false), 'Quote: https://example.invalid/a/b');
  assert.equal(fullTitle({kind:'file', title:'File: /outside/notes.ts:2'}, false), 'File: /outside/notes.ts:2');
});
