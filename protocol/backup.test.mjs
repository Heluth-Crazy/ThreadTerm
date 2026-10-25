import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, validateResult } from './index.ts';

test('backup keeps the one-file contract and exposes typed verification', () => {
  validateRequest('data.backup', {targetPath:'backup.sqlite3', operationId:'backup'});
  validateRequest('data.backup', {targetPath:'backup.sqlite3', desktopDataRoot:'profile', operationId:'backup'});
  validateRequest('data.backup.verify', {path:'backup.sqlite3'});
  const verification={verified:true,files:3,sizeBytes:1024,checkedAt:'2026-10-25T00:00:00Z'};
  validateResult('data.backup', {path:'backup.sqlite3',sizeBytes:2048,format:'threadterm-sqlite-archive-v1',verification});
  validateResult('data.backup.verify', verification);
  assert.throws(()=>validateRequest('data.backup.verify', {path:'backup.sqlite3',operationId:'unexpected'}));
  assert.throws(()=>validateResult('data.backup.verify',{...verification,verified:'yes'}));
});

test('cookie staging and capture tokens are no longer accepted', () => {
  assert.throws(()=>validateRequest('data.backup.cookies.prepare', {paths:[],operationId:'prepare'}));
  assert.throws(()=>validateRequest('data.backup.cookies.release', {token:'opaque',operationId:'release'}));
  assert.throws(()=>validateRequest('data.backup', {targetPath:'backup.sqlite3',desktopCookieStageToken:'opaque',operationId:'backup'}));
});
