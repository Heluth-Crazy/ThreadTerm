import assert from 'node:assert/strict';
import {test} from 'node:test';
import {changeFocusAfterToggle, orderedChangeRows, rovingChangeTarget, isKeyboardEditableTarget} from './scmKeyboard';

const groups={conflicts:[{path:'conflict'}],staged:[{path:'both'}],changes:[{path:'both'},{path:'next'},{path:'last'}],untracked:[{path:'new'}]};
test('roving rows follow visual groups and skip collapsed groups',()=>{
 const rows=orderedChangeRows(groups,new Set(['conflicts']));
 assert.deepEqual(rows.map(row=>`${row.group}:${row.path}`),['staged:both','changes:both','changes:next','changes:last','untracked:new']);
 assert.deepEqual(rovingChangeTarget(rows,rows[0],'ArrowDown'),rows[1]);
 assert.deepEqual(rovingChangeTarget(rows,rows[0],'ArrowUp'),rows[0]);
 assert.deepEqual(rovingChangeTarget(rows,rows[2],'Home'),rows[0]);
 assert.deepEqual(rovingChangeTarget(rows,rows[2],'End'),rows[4]);
});
test('stage focus stays in source group at same position or previous last row',()=>{
 const rows=orderedChangeRows(groups,new Set());
 assert.deepEqual(changeFocusAfterToggle(rows,{group:'changes',path:'both'}),{group:'changes',path:'next'});
 assert.deepEqual(changeFocusAfterToggle(rows,{group:'changes',path:'last'}),{group:'changes',path:'next'});
 assert.deepEqual(changeFocusAfterToggle([{group:'staged',path:'first'},{group:'staged',path:'second'},{group:'changes',path:'first'}],{group:'staged',path:'first'}),{group:'staged',path:'second'});
 assert.deepEqual(changeFocusAfterToggle(rows,{group:'staged',path:'both'}),{group:'conflicts',path:'conflict'});
 assert.deepEqual(changeFocusAfterToggle([{group:'staged',path:'only'}],{group:'staged',path:'only'}),undefined);
});
test('input filtering includes form controls, editable descendants and CodeMirror',()=>{
 const previous=globalThis.Element;
 class TestElement {constructor(private selector:string){} closest(selector:string){assert.match(selector,/input,textarea,select/);assert.match(selector,/contenteditable/);assert.match(selector,/cm-editor/);return this.selector?{}:null;}}
 try {
  Object.assign(globalThis,{Element:TestElement});
  for(const kind of ['input','textarea','select','editable child','CodeMirror'])assert.equal(isKeyboardEditableTarget(new TestElement(kind) as unknown as EventTarget),true);
  assert.equal(isKeyboardEditableTarget(new TestElement('') as unknown as EventTarget),false);
  assert.equal(isKeyboardEditableTarget(null),false);
 } finally {Object.assign(globalThis,{Element:previous});}
});
