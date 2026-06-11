import { describe, expect, it } from 'vitest';
import {
  computeReconnectDelay,
  countNewlines,
  formatExitBanner,
  shouldFollowOutput,
} from './shellBehavior';

describe('shouldFollowOutput', () => {
  it('follows when the viewport is at the bottom of the normal buffer', () => {
    expect(shouldFollowOutput({ type: 'normal', viewportY: 120, baseY: 120 })).toBe(true);
  });

  it('does not follow when the user scrolled up in the normal buffer', () => {
    expect(shouldFollowOutput({ type: 'normal', viewportY: 80, baseY: 120 })).toBe(false);
  });

  it('follows even one row above the bottom is treated as scrolled up', () => {
    expect(shouldFollowOutput({ type: 'normal', viewportY: 119, baseY: 120 })).toBe(false);
  });

  it('always follows on the alternate screen (full-screen TUI)', () => {
    expect(shouldFollowOutput({ type: 'alternate', viewportY: 0, baseY: 120 })).toBe(true);
  });

  it('follows on a fresh buffer with no scrollback', () => {
    expect(shouldFollowOutput({ type: 'normal', viewportY: 0, baseY: 0 })).toBe(true);
  });
});

describe('formatExitBanner', () => {
  it('uses green for exit code 0', () => {
    const banner = formatExitBanner(0, 'process exited with code 0');
    expect(banner).toContain('\x1b[32m');
    expect(banner).toContain('process exited with code 0');
    expect(banner).toContain('\x1b[0m');
  });

  it('uses red for non-zero exit codes', () => {
    const banner = formatExitBanner(127, 'process exited with code 127');
    expect(banner).toContain('\x1b[31m');
    expect(banner).toContain('127');
  });

  it('uses dim for null/undefined (deliberate kill)', () => {
    expect(formatExitBanner(null, 'session closed')).toContain('\x1b[2m');
    expect(formatExitBanner(undefined, 'session closed')).toContain('\x1b[2m');
  });

  it('starts and ends with CRLF so it lands on its own line', () => {
    const banner = formatExitBanner(0, 'done');
    expect(banner.startsWith('\r\n')).toBe(true);
    expect(banner.endsWith('\r\n')).toBe(true);
  });
});

describe('computeReconnectDelay', () => {
  it('doubles per retry starting at 1s', () => {
    expect(computeReconnectDelay(0)).toBe(1000);
    expect(computeReconnectDelay(1)).toBe(2000);
    expect(computeReconnectDelay(3)).toBe(8000);
  });

  it('caps at 30s', () => {
    expect(computeReconnectDelay(10)).toBe(30000);
  });
});

describe('countNewlines', () => {
  it('counts LF characters', () => {
    expect(countNewlines('a\nb\nc')).toBe(2);
    expect(countNewlines('no newline')).toBe(0);
    expect(countNewlines('\r\n\r\n')).toBe(2);
    expect(countNewlines('')).toBe(0);
  });
});
