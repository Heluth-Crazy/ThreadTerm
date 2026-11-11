import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_FILE_APP_EXTENSIONS, canOpenWithSystemApp } from './openFileApp';
import { externalDocumentError, externalSheetError } from './externalFiles';
import { officeSheetError } from './workbench/errors';

function withMachine(machineId: string, run: () => void) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { threadterm: { machineId } } });
  try { run(); } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete (globalThis as { window?: unknown }).window;
  }
}

test('the system-app action exists for every D6 document extension and for .pdf/.pptx/.ppt', () => {
  withMachine('local', () => {
    for (const extension of OPEN_FILE_APP_EXTENSIONS) assert.equal(canOpenWithSystemApp(`D:\\files\\a${extension.toUpperCase()}`), true, extension);
    for (const path of ['D:\\files\\a.exe', 'D:\\files\\a.ps1', 'D:\\files\\a.lnk', 'D:\\files\\a.png', 'D:\\files\\README', '']) {
      assert.equal(canOpenWithSystemApp(path), false, path);
    }
  });
});

test('the action is hidden on a remote machine', () => {
  withMachine('office-pc', () => assert.equal(canOpenWithSystemApp('D:\\files\\a.xlsx'), false));
  withMachine('local', () => assert.equal(canOpenWithSystemApp('D:\\files\\a.xlsx'), true));
});

test('an older runtime on another computer gives the update line in both languages', () => {
  withMachine('office-pc', () => {
    for (const error of [new Error('unknown_method'), new Error('Unsupported runtime method filesystem.sheet.open')]) {
      assert.equal(officeSheetError(error, false), 'Update ThreadTerm on that computer.');
      assert.equal(officeSheetError(error, true), '请在那台电脑上更新 ThreadTerm。');
      assert.equal(externalSheetError(error, false), 'Update ThreadTerm on that computer.');
      assert.equal(externalDocumentError(error, true), '请在那台电脑上更新 ThreadTerm。');
    }
  });
  withMachine('local', () => {
    assert.doesNotMatch(officeSheetError(new Error('unknown_method'), false), /on that computer/);
    assert.doesNotMatch(externalDocumentError(new Error('unknown_method'), false), /on that computer/);
  });
});
