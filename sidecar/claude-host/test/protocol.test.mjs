import { describe, expect, it } from 'vitest';
import { parseRequestLine, responseError, responseOk } from '../src/protocol.mjs';

describe('parseRequestLine', () => {
  it('ignores blank lines', () => {
    expect(parseRequestLine('   ')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(parseRequestLine('{nope').error).toMatch(/invalid JSON/);
  });

  it('rejects non-object payloads', () => {
    expect(parseRequestLine('[1,2]').error).toMatch(/JSON object/);
  });

  it('rejects a missing id', () => {
    expect(parseRequestLine('{"op":"host.ping"}').error).toMatch(/integer id/);
  });

  it('rejects an unknown op but keeps the id for the error response', () => {
    const parsed = parseRequestLine('{"id":7,"op":"nope"}');
    expect(parsed.id).toBe(7);
    expect(parsed.error).toMatch(/unknown op/);
  });

  it('accepts a well-formed request', () => {
    const parsed = parseRequestLine('{"id":1,"op":"host.ping"}');
    expect(parsed.request).toEqual({ id: 1, op: 'host.ping' });
  });
});

describe('response frames', () => {
  it('shapes ok and error frames', () => {
    expect(responseOk(3, { a: 1 })).toEqual({ id: 3, ok: { a: 1 } });
    expect(responseError(4, 'boom')).toEqual({ id: 4, error: { message: 'boom' } });
  });
});
