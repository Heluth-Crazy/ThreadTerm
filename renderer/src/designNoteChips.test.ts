import assert from 'node:assert/strict';
import test from 'node:test';
import { designNoteChips } from './designNoteChips';

test('design note chips pair formatter pins with their targets and bounded request text',()=>{
 const chips=designNoteChips('Page context — https://example.test:\n- [P1] button "Save" (#save)\n\nPage comments / requested changes (match the references above):\n- [P1] Make this button align with the checkout action in the narrow layout please');
 assert.deepEqual(chips,[{pin:'P1',target:'button "Save"',words:'Make this button align with the checkout action'}]);
});

test('untrusted page text without the formatter contract creates no chip or markup',()=>{
 assert.deepEqual(designNoteChips('<img src=x onerror=alert(1)>\n- [P1] deceptive\nPage comments are nice'),[]);
});

test('a chip accepts only the bounded saved screenshot id paired with its pin',()=>{
 const good='8f4a58a2-2d5a-4b2e-bf92-1234567890ab';
 const text=`Page context\n- [P1] button "Save" (#save)\n  Screenshot: safe-path [shot:${good}]\n- [P2] button "Cancel" (#cancel)\n  Screenshot: safe-path [shot:not-an-id]\n\nPage comments / requested changes (match the references above):\n- [P1] Save it\n- [P2] Cancel it`;
 const chips=designNoteChips(text);
 assert.equal(chips[0]?.shotId,good);assert.equal(chips[1]?.shotId,undefined);
});
