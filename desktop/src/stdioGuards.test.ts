import assert from 'node:assert/strict';
import test from 'node:test';
import { isBrokenPipeError } from './stdioGuards.js';

test('broken-pipe errors are the EPIPE family only', () => {
  assert.equal(isBrokenPipeError({ code: 'EPIPE' }), true);
  assert.equal(isBrokenPipeError({ code: 'ERR_STREAM_DESTROYED' }), true);
  assert.equal(isBrokenPipeError({ code: 'ENOENT' }), false);
  assert.equal(isBrokenPipeError(new Error('fail')), false);
  assert.equal(isBrokenPipeError(undefined), false);
});
