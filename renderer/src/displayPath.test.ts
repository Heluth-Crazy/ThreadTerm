import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPath } from './displayPath';

test('displayPath uses native Windows separators only for Windows absolute paths',()=>{
 assert.equal(displayPath('D:/outside/comments.ts'),'D:\\outside\\comments.ts');
 assert.equal(displayPath('//server/share/comments.ts'),'\\\\server\\share\\comments.ts');
 assert.equal(displayPath('/outside/comments.ts'),'/outside/comments.ts');
 assert.equal(displayPath('src/comments.ts'),'src/comments.ts');
});

test('displayPath hides Windows extended-length prefixes without changing a stored path',()=>{
 assert.equal(displayPath('\\\\?\\D:/outside/comments.ts'),'D:\\outside\\comments.ts');
 assert.equal(displayPath('\\\\?\\UNC\\server/share/comments.ts'),'\\\\server\\share\\comments.ts');
});
