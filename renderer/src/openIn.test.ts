import assert from 'node:assert/strict';
import test from 'node:test';
import { openInLabel, preferredEditor } from './openIn';

const editors = [{ id: 'terminal', label: 'Windows Terminal' }, { id: 'vscode', label: 'VS Code' }, { id: 'idea', label: 'IntelliJ IDEA' }];

test('Open uses the editor picked last while it is installed, else the first editor, never the terminal by default', () => {
  assert.equal(preferredEditor(editors, 'idea')?.id, 'idea');
  assert.equal(preferredEditor(editors, 'cursor')?.id, 'vscode', 'an editor that was uninstalled falls back');
  assert.equal(preferredEditor(editors, undefined)?.id, 'vscode');
  assert.equal(preferredEditor([editors[0]!], undefined)?.id, 'terminal', 'with only a terminal, the terminal');
  assert.equal(preferredEditor([], 'vscode'), undefined, 'nothing installed (or another computer): no button');
});

test('menu rows name the program; the terminal says what it does', () => {
  assert.equal(openInLabel({ id: 'vscode', label: 'VS Code' }, true), '在 VS Code 中打开');
  assert.equal(openInLabel({ id: 'idea', label: 'IntelliJ IDEA' }, false), 'Open in IntelliJ IDEA');
  assert.equal(openInLabel({ id: 'terminal', label: 'Windows Terminal' }, true), '在终端中打开');
});
