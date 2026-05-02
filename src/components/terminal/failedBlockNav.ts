/**
 * failedBlockNav — pure navigation helpers for jumping between failed blocks.
 *
 * Both functions operate on the ordered blocks array and return the id of the
 * target block, or `null` if there are no failed blocks.
 *
 * Keyboard wiring (Cmd/Ctrl+Shift+\ and Cmd/Ctrl+Shift+/) lives in
 * TerminalView via the `useFailedBlockNav` hook.
 */
import type { Block } from '../../types/terminal';

/**
 * Return the id of the previous failed block relative to `currentBlockId`.
 *
 * - If `currentBlockId` is `null`, returns the last failed block.
 * - If `currentBlockId` is the first failed block, wraps to the last.
 * - Returns `null` when there are no failed blocks.
 */
export function prevFailedBlock(blocks: Block[], currentBlockId: string | null): string | null {
  const failed = blocks.filter((b) => b.state === 'failed');
  if (failed.length === 0) return null;

  if (currentBlockId === null) return failed[failed.length - 1].id;

  const idx = failed.findIndex((b) => b.id === currentBlockId);
  if (idx <= 0) return failed[failed.length - 1].id;
  return failed[idx - 1].id;
}

/**
 * Return the id of the next failed block relative to `currentBlockId`.
 *
 * - If `currentBlockId` is `null`, returns the first failed block.
 * - If `currentBlockId` is the last failed block, wraps to the first.
 * - Returns `null` when there are no failed blocks.
 */
export function nextFailedBlock(blocks: Block[], currentBlockId: string | null): string | null {
  const failed = blocks.filter((b) => b.state === 'failed');
  if (failed.length === 0) return null;

  if (currentBlockId === null) return failed[0].id;

  const idx = failed.findIndex((b) => b.id === currentBlockId);
  if (idx === -1 || idx === failed.length - 1) return failed[0].id;
  return failed[idx + 1].id;
}
