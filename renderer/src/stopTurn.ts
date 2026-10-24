/** A Stop is one contract for every provider: it interrupts the live turn, a
 * turn that already ended counts as stopped, and only a turn that is no longer
 * the live one is refused. The IPC hop drops `code`, so the runtime's refusal
 * also carries the `turn_not_active` marker (`STOP_TURN_NOT_ACTIVE` in
 * runtime/src/providers.rs). Every other Stop failure (a closed Chat, a lost
 * runtime) already has its own banner, so it stays out of the error bar. */
export function stopFailureMessage(caught: unknown, copy: (en: string, zh: string) => string): string | undefined {
  const record = caught && typeof caught === 'object' ? caught as { code?: unknown; message?: unknown } : undefined;
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = caught instanceof Error ? caught.message : String(caught ?? '');
  if (code === 'turn_not_active' || message.includes('turn_not_active')) {
    return copy('That turn already ended; the newer turn keeps running.', '该回合已结束，正在运行的是新的回合。');
  }
  return undefined;
}
