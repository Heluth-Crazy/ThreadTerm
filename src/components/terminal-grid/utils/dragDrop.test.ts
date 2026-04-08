import { describe, it, expect } from 'vitest';
import {
  SESSION_DRAG_FORMATS,
  hasSessionDragData,
  parseSessionDragData,
} from './dragDrop';

/**
 * Helper to create a minimal mock DataTransfer.
 */
function createMockDataTransfer(data: Record<string, string> = {}): DataTransfer {
  const store: Record<string, string> = { ...data };
  return {
    types: Object.keys(store),
    getData: (format: string) => store[format] ?? '',
    setData: (format: string, value: string) => { store[format] = value; },
  } as unknown as DataTransfer;
}

describe('dragDrop utils', () => {
  describe('SESSION_DRAG_FORMATS', () => {
    it('should export expected MIME types', () => {
      expect(SESSION_DRAG_FORMATS).toContain('text/x-openwork-session');
      expect(SESSION_DRAG_FORMATS).toContain('application/json');
    });
  });

  describe('hasSessionDragData', () => {
    it('should return true when drag data contains a known format', () => {
      const dt = createMockDataTransfer({ 'text/x-openwork-session': '{}' });
      expect(hasSessionDragData(dt)).toBe(true);
    });

    it('should return false when no known format is present', () => {
      const dt = createMockDataTransfer({ 'text/plain': 'hello' });
      expect(hasSessionDragData(dt)).toBe(false);
    });

    it('should return true when application/json is present', () => {
      const dt = createMockDataTransfer({ 'application/json': '{}' });
      expect(hasSessionDragData(dt)).toBe(true);
    });
  });

  describe('parseSessionDragData', () => {
    it('should parse valid session data from known format', () => {
      const payload = JSON.stringify({ sessionId: 'abc-123', sessionName: 'Test' });
      const dt = createMockDataTransfer({ 'text/x-openwork-session': payload });
      const result = parseSessionDragData(dt);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('abc-123');
      expect(result!.sessionName).toBe('Test');
    });

    it('should return null when no valid data is present', () => {
      const dt = createMockDataTransfer({ 'text/plain': 'not json' });
      expect(parseSessionDragData(dt)).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const dt = createMockDataTransfer({ 'text/x-openwork-session': '{broken' });
      expect(parseSessionDragData(dt)).toBeNull();
    });

    it('should return null if parsed object lacks sessionId', () => {
      const dt = createMockDataTransfer({
        'text/x-openwork-session': JSON.stringify({ name: 'no-id' }),
      });
      expect(parseSessionDragData(dt)).toBeNull();
    });

    it('should fall back to application/json when first format empty', () => {
      const payload = JSON.stringify({ sessionId: 'fallback-id' });
      const dt = createMockDataTransfer({ 'application/json': payload });
      const result = parseSessionDragData(dt);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('fallback-id');
    });
  });
});
