import { describe, expect, it } from 'vitest';
import {
  stripAnsi,
  stripAnsiAndControlCharacters,
  stripAnsiTail,
} from './ansiText';

describe('ansiText', () => {
  it('removes CSI, OSC, two-byte escapes, control bytes, and carriage returns', () => {
    const input = [
      '\x1b]0;secret title\x07',
      '\x1b[31mred\x1b[0m',
      '\x1b(B',
      '\x01safe\rtext\x7f',
    ].join('');

    expect(stripAnsi(input)).toBe('redsafetext');
    expect(stripAnsiAndControlCharacters('before\rafter')).toBe('before\rafter');
  });

  it('matches the full cleaner tail without allocating the full cleaned output', () => {
    const input = `${'prefix-'.repeat(2_000)}\x1b[31mRED\x1b[0m\r${'tail-'.repeat(1_000)}`;

    expect(stripAnsiTail(input, 2_000)).toBe(stripAnsi(input).slice(-2_000));
  });

  it('does not leak a long control payload whose opening escape is far before the tail', () => {
    const input = `before\x1b]0;${'private-title-'.repeat(20_000)}\x07VISIBLE-END`;

    expect(stripAnsiTail(input, 32)).toBe('beforeVISIBLE-END');
    expect(stripAnsiTail(input, 10)).toBe('ISIBLE-END');
  });
});
