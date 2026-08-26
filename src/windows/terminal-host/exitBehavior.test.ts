import { describe, expect, it } from 'vitest';
import { shouldCloseForExit } from './exitBehavior';

describe('terminal-host exit behavior', () => {
  it.each([
    ['keep', 0, false],
    ['keep', 7, false],
    ['close-on-success', 0, true],
    ['close-on-success', 7, false],
    ['close-on-success', null, false],
    ['close-on-exit', 0, true],
    ['close-on-exit', 7, true],
    ['close-on-exit', null, true],
  ] as const)('%s with exit code %s closes=%s', (behavior, code, expected) => {
    expect(shouldCloseForExit(behavior, code)).toBe(expected);
  });
});
