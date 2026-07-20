import { describe, expect, it } from 'vitest';
import { createSynchronizedOutputFilter } from './synchronizedOutputFilter';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

describe('createSynchronizedOutputFilter', () => {
  it('preserves ordinary output and erase-display commands outside synchronized updates', () => {
    const filter = createSynchronizedOutputFilter();
    const output = 'before\x1b[2Jmiddle\x1b[3Jafter';

    expect(filter.write(output)).toBe(output);
  });

  it('strips ED2 and ED3 only while a DEC 2026 update is active', () => {
    const filter = createSynchronizedOutputFilter();

    expect(
      filter.write(
        `outside\x1b[2J${SYNC_START}frame\x1b[2Jnext\x1b[3J${SYNC_END}\x1b[2Jdone`,
      ),
    ).toBe(`outside\x1b[2J${SYNC_START}framenext${SYNC_END}\x1b[2Jdone`);
  });

  it('tracks sync markers and erase commands split across PTY chunks', () => {
    const filter = createSynchronizedOutputFilter();
    const chunks = [
      'prefix\x1b[?20',
      '26hframe\x1b[',
      '2Jnext\x1b[3',
      'J\x1b[?202',
      '6lsuffix',
    ];

    expect(chunks.map((chunk) => filter.write(chunk)).join('')).toBe(
      `prefix${SYNC_START}framenext${SYNC_END}suffix`,
    );
  });

  it('preserves lookalike controls and resets pending state between terminal epochs', () => {
    const filter = createSynchronizedOutputFilter();

    const inside = filter.write(`${SYNC_START}\x1b[20J\x1b[?25ltext${SYNC_END}`);
    expect(inside).toBe(`${SYNC_START}\x1b[20J\x1b[?25ltext${SYNC_END}`);

    filter.write(`${SYNC_START}\x1b[`);
    filter.reset();
    expect(filter.write('\x1b[2J')).toBe('\x1b[2J');
  });
});
