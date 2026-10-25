import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeErrorCode, runtimeErrorText } from './runtimeErrors';

const wrapped = (name: string, message: string) => new Error(`Error invoking remote method 'threadterm:request': ${name}: ${message}`);

test('the IPC wrapper and error name are stripped from the diagnostic code', () => {
 assert.equal(runtimeErrorCode(wrapped('RuntimeRequestError', 'revision_conflict')), 'revision_conflict');
 assert.equal(runtimeErrorCode(wrapped('Error', 'group_member_busy')), 'group_member_busy');
 assert.equal(runtimeErrorCode(wrapped('RuntimeRequestError', 'invalid_group_file: Choose a file inside the group folder.')), 'invalid_group_file');
 assert.equal(runtimeErrorCode(new Error("Error invoking remote method 'chat.steer': Error: The turn ended before the message was inserted")), undefined);
});

test('plain codes and detail forms keep their code', () => {
 assert.equal(runtimeErrorCode(new Error('revision_conflict')), 'revision_conflict');
 assert.equal(runtimeErrorCode('group_archived: This group is archived.'), 'group_archived');
 assert.equal(runtimeErrorCode('runtimeErrorCodeIsNotACode'), undefined);
 assert.equal(runtimeErrorCode('Runtime pipe closed'), undefined);
 assert.equal(runtimeErrorCode('消息未能插入。'), undefined);
 assert.equal(runtimeErrorCode(undefined), undefined);
 assert.equal(runtimeErrorCode({ code: 'revision_conflict' }), undefined);
});

test('a comma-separated wrapper is unwrapped too', () => {
 assert.equal(runtimeErrorCode(new Error("Error invoking remote method 'threadterm:request', RuntimeRequestError: group_member_busy")), 'group_member_busy');
});

test('readable text keeps the human message without the wrapper', () => {
 assert.equal(runtimeErrorText(wrapped('RuntimeUnavailableError', 'Runtime pipe closed')), 'Runtime pipe closed');
 assert.equal(runtimeErrorText(new Error('revision_conflict')), 'revision_conflict');
 assert.equal(runtimeErrorText(undefined), undefined);
});
