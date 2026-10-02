import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workspace=await readFile(new URL('../renderer/src/components/FileWorkspace.tsx',import.meta.url),'utf8');
const editor=await readFile(new URL('../renderer/src/components/CodeEditor.tsx',import.meta.url),'utf8');

test('direct reveal fixture is local to the matching document',()=>{
 assert.match(workspace,/document\.path === initialPath && reveal/);
 assert.match(workspace,/<CodeEditor[\s\S]*?reveal=\{editorReveal\}/);
 assert.match(editor,/reveal\.path !== path/);
 assert.match(editor,/\[reveal\?\.key, reveal\?\.path, path\]/);
 assert.doesNotMatch(workspace,/window\.(?:dispatchEvent|addEventListener)/);
});

test('scope-switch fixture remounts state and rejects stale async replies',()=>{
 assert.match(workspace,/function FileWorkspaceInstance/);
 assert.match(workspace,/key=\{`\$\{props\.projectId\}\\0\$\{props\.worktreePath \?\? ""\}`\}/);
 assert.match(workspace,/mounted\.current = false;\s*generation\.current\+\+;/);
 assert.match(workspace,/ticket !== generation\.current/);
 assert.match(workspace,/filesystem\.write", \{\s*\.\.\.scope,/);
});
