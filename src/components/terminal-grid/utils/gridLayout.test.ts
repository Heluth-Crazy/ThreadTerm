import { describe, it, expect } from 'vitest';
import { getVisibleCount, getGridClass } from './gridLayout';

describe('gridLayout utils', () => {
  describe('getVisibleCount', () => {
    it('should return 1 for 1x1 layout', () => {
      expect(getVisibleCount('1x1')).toBe(1);
    });

    it('should return 2 for 1x2 layout', () => {
      expect(getVisibleCount('1x2')).toBe(2);
    });

    it('should return 4 for 2x2 layout', () => {
      expect(getVisibleCount('2x2')).toBe(4);
    });
  });

  describe('getGridClass', () => {
    it('should return single col/row for 1x1', () => {
      expect(getGridClass('1x1')).toBe('grid-cols-1 grid-rows-1');
    });

    it('should return 2 cols / 1 row for 1x2', () => {
      expect(getGridClass('1x2')).toBe('grid-cols-2 grid-rows-1');
    });

    it('should return 2 cols / 2 rows for 2x2', () => {
      expect(getGridClass('2x2')).toBe('grid-cols-2 grid-rows-2');
    });

    it('should return consistent results across repeated calls', () => {
      expect(getGridClass('1x1')).toBe(getGridClass('1x1'));
      expect(getGridClass('2x2')).toBe(getGridClass('2x2'));
    });

    it('getVisibleCount and getGridClass should handle all defined layouts', () => {
      const layouts = ['1x1', '1x2', '2x2'] as const;
      for (const layout of layouts) {
        expect(typeof getVisibleCount(layout)).toBe('number');
        expect(typeof getGridClass(layout)).toBe('string');
      }
    });
  });
});
