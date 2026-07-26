import { describe, expect, it } from 'vitest';
import {
  createAnsiTailSanitizer,
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

  it('matches the full cleaner for large output without scanning discarded visible history', () => {
    const input = `${'\x1b[31moutput-line-0123456789\x1b[0m\r\n'.repeat(300_000)}tail`;

    expect(stripAnsiTail(input, 2_000)).toBe(stripAnsi(input).slice(-2_000));
  });

  it('keeps split colour and string controls out of consecutive output summaries', () => {
    const sanitizer = createAnsiTailSanitizer();

    expect(sanitizer.push('before\x1b[', 2_000)).toBe('before');
    expect(sanitizer.push('31mred\x1b]0;private', 2_000)).toBe('red');
    expect(sanitizer.push('-title\x07after\x1b', 2_000)).toBe('after');
    expect(sanitizer.push('[0mplain', 2_000)).toBe('plain');
  });

  it('does not retain a split string-control payload in memory', () => {
    const sanitizer = createAnsiTailSanitizer();

    expect(sanitizer.push('\x1b]0;', 2_000)).toBe('');
    expect(sanitizer.push('private-title-'.repeat(100_000), 2_000)).toBe('');
    expect(sanitizer.push('\x07visible', 2_000)).toBe('visible');
  });
});
