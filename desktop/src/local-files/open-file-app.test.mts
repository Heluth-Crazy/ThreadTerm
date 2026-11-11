import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPEN_FILE_APP_EXTENSIONS, canOpenFileWithSystemApp, createOpenFileDefaultAppHandler,
  parseOpenFileAppRequest, qaOpenFileAppRecordPath, resolveOpenFileAppPath,
  type OpenFileAppDependencies,
} from '../openFileApp.js';

const event = {} as never;
const trusted = () => {};
const local = () => {};

function dependencies(overrides: Partial<OpenFileAppDependencies> = {}): OpenFileAppDependencies & { opened: string[]; externalCalls: string[] } {
  const opened: string[] = [];
  const externalCalls: string[] = [];
  return {
    workspaceRoot: async () => 'C:\\work\\project',
    externalPath: async id => { externalCalls.push(id); return 'C:\\outside\\registered.xlsx'; },
    canonical: async path => path.replaceAll('/', '\\'),
    isFile: async () => true,
    openPath: async path => { opened.push(path); return ''; },
    opened,
    externalCalls,
    ...overrides,
  };
}

test('the system-app allow list is exactly the document extensions and never executable or script types', () => {
  for (const extension of OPEN_FILE_APP_EXTENSIONS) {
    assert.equal(canOpenFileWithSystemApp(`C:\\files\\report${extension.toUpperCase()}`), true, extension);
  }
  for (const path of [
    'C:\\files\\run.exe', 'C:\\files\\run.cmd', 'C:\\files\\run.bat', 'C:\\files\\run.ps1',
    'C:\\files\\run.js', 'C:\\files\\run.vbs', 'C:\\files\\run.lnk', 'C:\\files\\run.url',
    'C:\\files\\picture.png', 'C:\\files\\README', 'C:\\files\\.docx',
  ]) assert.equal(canOpenFileWithSystemApp(path), false, path);
});

test('a workspace path is canonicalized, containment is checked, and a path outside the project is refused', async () => {
  const deps = dependencies({ canonical: async path => path.includes('..') ? 'C:\\work\\elsewhere\\x.xlsx' : path.replaceAll('/', '\\') });
  assert.equal(await resolveOpenFileAppPath({ projectId: 'p', path: 'sheets/a.xlsx' }, deps), 'C:\\work\\project\\sheets\\a.xlsx');
  await assert.rejects(resolveOpenFileAppPath({ projectId: 'p', path: '..\\elsewhere\\x.xlsx' }, deps), /outside its project scope/);
  await assert.rejects(resolveOpenFileAppPath({ projectId: 'p', path: '..\\..\\Windows\\run.exe' }, deps), /outside its project scope|system app/);
  await assert.rejects(resolveOpenFileAppPath({ projectId: 'p', path: 'C:\\Windows\\a.xlsx' }, deps), /Invalid file path/);
  await assert.rejects(resolveOpenFileAppPath({ projectId: 'p', path: 'run.exe' }, deps), /system app/);
});

test('an external file must be a current registration, and its canonical path is checked too', async () => {
  const deps = dependencies();
  assert.equal(await resolveOpenFileAppPath({ externalId: 'ext-1' }, deps), 'C:\\outside\\registered.xlsx');
  assert.deepEqual(deps.externalCalls, ['ext-1'], 'the registration is resolved by id only');
  const unknown = dependencies({ externalPath: async () => { throw new Error('external_file_unknown'); } });
  await assert.rejects(resolveOpenFileAppPath({ externalId: 'gone' }, unknown), /external_file_unknown/);
  const executable = dependencies({ externalPath: async () => 'C:\\outside\\setup.exe' });
  await assert.rejects(resolveOpenFileAppPath({ externalId: 'ext-2' }, executable), /system app/);
  const directory = dependencies({ isFile: async () => false });
  await assert.rejects(resolveOpenFileAppPath({ externalId: 'ext-3' }, directory), /not a regular file/);
});

test('the handler refuses a remote machine before it resolves or opens anything', async () => {
  const deps = dependencies();
  const handler = createOpenFileDefaultAppHandler(deps, trusted, () => { throw new Error('Local machine only'); });
  await assert.rejects(handler(event, { projectId: 'p', path: 'a.xlsx' }), /Local machine only/);
  assert.deepEqual(deps.opened, []);
  assert.deepEqual(deps.externalCalls, []);
});

test('the handler refuses an untrusted renderer, opens the resolved path once, and reports openPath errors', async () => {
  const untrusted = dependencies();
  await assert.rejects(createOpenFileDefaultAppHandler(untrusted, () => { throw new Error('Untrusted'); }, local)(event, { externalId: 'x' }), /Untrusted/);
  assert.deepEqual(untrusted.externalCalls, []);
  const failing = dependencies({ openPath: async () => 'No application is associated with this file' });
  await assert.rejects(createOpenFileDefaultAppHandler(failing, trusted, local)(event, { externalId: 'x' }), /No application/);
  const deps = dependencies();
  await createOpenFileDefaultAppHandler(deps, trusted, local)(event, { projectId: 'p', worktreePath: 'C:\\work\\project', path: 'a.docx' });
  assert.deepEqual(deps.opened, ['C:\\work\\project\\a.docx']);
});

test('the request parser rejects extra keys, empty fields and control characters', () => {
  assert.deepEqual(parseOpenFileAppRequest({ externalId: 'id' }), { externalId: 'id' });
  assert.deepEqual(parseOpenFileAppRequest({ projectId: 'p', path: 'a.pdf', worktreePath: 'C:\\w' }), { projectId: 'p', path: 'a.pdf', worktreePath: 'C:\\w' });
  for (const input of [
    null, [], {}, { externalId: 'id', path: 'a.docx' }, { projectId: 'p' }, { projectId: 'p', path: '' },
    { projectId: 'p', path: 'a\u0000.docx' }, { projectId: 'p', path: 'a.docx', extra: true },
  ]) assert.throws(() => parseOpenFileAppRequest(input), /Invalid file request/);
});

test('the QA record path is absolute and is ignored by a packaged build', () => {
  assert.equal(qaOpenFileAppRecordPath('D:\\tmp\\opened.json', false), 'D:\\tmp\\opened.json');
  assert.equal(qaOpenFileAppRecordPath('D:\\tmp\\opened.json', true), undefined);
  assert.equal(qaOpenFileAppRecordPath('relative.json', false), undefined);
  assert.equal(qaOpenFileAppRecordPath('', false), undefined);
});
