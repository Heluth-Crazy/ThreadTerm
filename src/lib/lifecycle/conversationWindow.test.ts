import { describe, expect, it } from 'vitest';
import {
  deriveConversationWindow,
  getMountedConversationRowDiagnostics,
  MAX_MOUNTED_CONVERSATION_ROWS,
  publishMountedConversationRows,
} from './conversationWindow';

describe('conversation display window', () => {
  it('mounts only the fixed tail window for a 1000+ item history', () => {
    const items = Array.from({ length: 1_001 }, (_, index) => index);
    const page = deriveConversationWindow(items, null);

    expect(page.items).toHaveLength(MAX_MOUNTED_CONVERSATION_ROWS);
    expect(page.items[0]).toBe(841);
    expect(page.items.at(-1)).toBe(1_000);
    expect(page).toMatchObject({
      startIndex: 841,
      endIndex: 1_001,
      hasOlder: true,
      hasNewer: false,
      atLatest: true,
    });
  });

  it('moves to an older fixed-size page without growing mounted rows', () => {
    const items = Array.from({ length: 1_001 }, (_, index) => index);
    const older = deriveConversationWindow(items, 841);

    expect(older.items).toHaveLength(MAX_MOUNTED_CONVERSATION_ROWS);
    expect(older.items[0]).toBe(681);
    expect(older.items.at(-1)).toBe(840);
    expect(older).toMatchObject({ hasOlder: true, hasNewer: true, atLatest: false });
  });

  it('aggregates mounted rows by provider and unregisters views', () => {
    const stopClaude = publishMountedConversationRows('claude:a', {
      provider: 'claude',
      mountedCount: 160,
      totalCount: 1_001,
    });
    const stopCodex = publishMountedConversationRows('codex:b', {
      provider: 'codex',
      mountedCount: 80,
      totalCount: 80,
    });

    expect(getMountedConversationRowDiagnostics()).toMatchObject({
      mountedMessageRowCount: 240,
      claudeMountedMessageRowCount: 160,
      codexMountedMessageRowCount: 80,
      authoritativeMessageCount: 1_081,
      viewCount: 2,
      perViewLimit: 160,
    });

    stopClaude();
    stopCodex();
    expect(getMountedConversationRowDiagnostics().viewCount).toBe(0);
  });
});
