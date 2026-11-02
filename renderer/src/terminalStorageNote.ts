/**
 * A terminal whose durable output recording is degraded keeps its process and
 * live view; the surface only states that the record is incomplete (F23).
 */
export type TerminalStorageNote = { reason: string };

const OUTPUT_LOST = 'terminal_output_lost';
const outputWasLost = (note: TerminalStorageNote | undefined) => note?.reason === OUTPUT_LOST;

/** The note as the runtime reports it (`terminal.read` or a live event). */
type DegradedReport = { reason?: unknown } | undefined;

export function storageNoteFromRead(storageDegraded: DegradedReport): TerminalStorageNote | undefined {
  return typeof storageDegraded?.reason === 'string' && storageDegraded.reason
    ? { reason: storageDegraded.reason }
    : undefined;
}

/** Applies one `terminal.storage` event to a session's current note. */
export function applyStorageEvent(
  current: TerminalStorageNote | undefined,
  sessionId: string,
  event: { event: string; data: unknown },
): TerminalStorageNote | undefined {
  if (event.event !== 'terminal.storage') return current;
  const data = event.data as { sessionId?: unknown; degraded?: unknown; reason?: unknown } | undefined;
  if (data?.sessionId !== sessionId) return current;
  // A recovered live recorder cannot restore bytes lost before the terminal
  // stopped. Keep the historical warning through subsequent live events.
  if (outputWasLost(current)) return current;
  if (data.degraded !== true) return undefined;
  return typeof data.reason === 'string' && data.reason ? { reason: data.reason } : { reason: 'terminal_output_storage_failed' };
}

export function terminalStorageAttention(zh: boolean, reason?: string): string {
  if (reason === OUTPUT_LOST) {
    return zh
      ? 'ThreadTerm 关闭前有部分输出未能保存，历史记录不完整。'
      : 'Some output was not saved before ThreadTerm closed. History ends early.';
  }
  return zh
    ? '终端输出暂时无法写入磁盘，磁盘恢复前不会保存新的输出；进程仍在运行，画面继续更新。'
    : 'Terminal output cannot be saved to disk right now. The process keeps running and the screen stays live, but new output is not recorded until storage recovers.';
}

export function terminalStorageLabel(zh: boolean, reason?: string): string {
  if (reason === OUTPUT_LOST) return zh ? '输出不完整' : 'Output incomplete';
  return zh ? '输出未保存' : 'Not being saved';
}
