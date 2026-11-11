import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSheetPath, officeKind } from './officeFiles';

test('Excel extensions map to the sheet viewer, any case', () => {
  for (const name of ['a.xlsx', 'a.XLSM', 'b.Xlsb', 'c.xls', 'd.ods']) assert.equal(officeKind(name), 'sheet', name);
  assert.equal(officeKind('C:\\docs\\Book 1.XLSX'), 'sheet');
  assert.equal(officeKind('/home/u/book.ods'), 'sheet');
});

test('Word extensions map to docx and legacy .doc stays out', () => {
  assert.equal(officeKind('report.docx'), 'docx');
  assert.equal(officeKind('REPORT.DOCM'), 'docx');
  assert.equal(officeKind('legacy.doc'), undefined);
});

test('other files, dotless names and trailing dots stay on the text path', () => {
  for (const name of ['notes.txt', 'a.xlsx.txt', 'Makefile', 'archive.xlsx.zip', '.xlsx', 'sheet', 'a.']) {
    assert.equal(officeKind(name), undefined, name);
  }
  assert.equal(officeKind(''), undefined);
});

test('sheet-only predicate matches the sheet kind', () => {
  assert.equal(isSheetPath('a.xlsx'), true);
  assert.equal(isSheetPath('a.docx'), false);
  assert.equal(isSheetPath('a.md'), false);
});
