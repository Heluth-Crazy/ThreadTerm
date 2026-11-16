import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBinaryFileError, isPackageFile } from './packageFiles';

test('archives, packages and programs are package files whatever the case or folder', () => {
  for (const path of ['target/app-1.0.jar', 'D:\\build\\out\\Setup.EXE', 'dist/site.tar.gz', 'pkg.whl', 'C:/x/y/release.ZIP', 'app.apk']) {
    assert.equal(isPackageFile(path), true, path);
  }
});

test('text, images and documents are not package files', () => {
  for (const path of ['src/Main.java', 'README.md', 'logo.png', 'report.pdf', 'notes', '.gitignore', 'archive.jar.md', undefined, '']) {
    assert.equal(isPackageFile(path), false, String(path));
  }
});

test('a binary read failure is recognised from its code or its message', () => {
  assert.equal(isBinaryFileError(new Error('binary_file')), true);
  assert.equal(isBinaryFileError({ code: 'binary_file', message: 'not text' }), true);
  assert.equal(isBinaryFileError({ code: 'invalid_request', message: 'runtime: binary_file' }), true);
  assert.equal(isBinaryFileError(new Error('file_too_large')), false);
  assert.equal(isBinaryFileError('not_found'), false);
});
