import { describe, expect, it } from 'vitest';
import { getCardFooterDensity } from './CardFooter';

describe('getCardFooterDensity', () => {
  it('keeps the default layout while width is not measurable', () => {
    expect(getCardFooterDensity(0)).toBe('wide');
  });

  it('keeps the full action row on wide cards', () => {
    expect(getCardFooterDensity(360)).toBe('wide');
    expect(getCardFooterDensity(420)).toBe('wide');
  });

  it('collapses optional actions on compact cards', () => {
    expect(getCardFooterDensity(300)).toBe('compact');
    expect(getCardFooterDensity(359)).toBe('compact');
  });

  it('keeps only core actions visible on narrow cards', () => {
    expect(getCardFooterDensity(299)).toBe('narrow');
    expect(getCardFooterDensity(240)).toBe('narrow');
  });
});
