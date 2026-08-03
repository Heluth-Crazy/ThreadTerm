import { describe, expect, it } from 'vitest';
import type { PrimaryView } from '../../lib/workbench/types';
import {
  resolveReturnPrimaryView,
  type ReturnPrimaryView,
} from './useTerminalNavigation';

describe('resolveReturnPrimaryView', () => {
  it.each<[
    current: PrimaryView,
    previous: ReturnPrimaryView,
    expected: ReturnPrimaryView,
  ]>([
    ['workbench', 'terminals', 'workbench'],
    ['terminals', 'workbench', 'terminals'],
    ['workspace', 'workbench', 'workbench'],
    ['workspace', 'terminals', 'terminals'],
  ])(
    'uses %s with previous %s as return destination %s',
    (current, previous, expected) => {
      expect(resolveReturnPrimaryView(current, previous)).toBe(expected);
    },
  );
});
