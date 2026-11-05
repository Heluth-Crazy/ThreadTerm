import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPath, isContained, validateReferencePath } from './paths.js';
test('path helpers reject portable traversal and preserve Windows display identity', () => {
 for(const path of ['','../x','a//b','a\\b','NUL','LPT1.txt','a.','a ']) assert.throws(()=>validateReferencePath(path));
 assert.deepEqual(validateReferencePath('src/main.ts'),['src','main.ts']);
 assert.equal(isContained('D:\\repo','D:\\repo\\src\\a.ts'),true); assert.equal(isContained('D:\\repo','D:\\other\\a.ts'),false);
 assert.equal(displayPath('\\\\?\\D:\\repo\\a.ts'),'D:\\repo\\a.ts'); assert.equal(displayPath('\\\\?\\UNC\\server\\share'),'\\\\server\\share');
});
