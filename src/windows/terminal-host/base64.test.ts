import { describe, expect, it } from 'vitest';
import { decodeBase64Bytes, encodeBase64Bytes } from './base64';

describe('terminal-host base64 boundary', () => {
  it('round-trips every byte without decoding as text', () => {
    const source = new Uint8Array([0, 1, 127, 128, 255]);
    expect([...decodeBase64Bytes(encodeBase64Bytes(source))]).toEqual([...source]);
  });
});
