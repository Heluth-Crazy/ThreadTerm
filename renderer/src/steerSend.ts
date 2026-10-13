/** Split Send is only offered while a native-steer turn is already running. */
export function steerControlKind(live: boolean, steer: string | undefined, queueMode: boolean): 'send' | 'queue' | 'split' {
  if (live && steer === 'native' && queueMode) return 'split';
  return queueMode ? 'queue' : 'send';
}

/** `turn_changed` keeps the composer text and uses the bilingual sentence. */
export function steerFailureMessage(caught: unknown, copy: (en: string, zh: string) => string): string {
  const record = caught && typeof caught === 'object' ? caught as { code?: unknown; message?: unknown } : undefined;
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = caught instanceof Error ? caught.message : String(caught ?? '');
  if (code === 'turn_changed' || message.includes('turn_changed') || message.includes('The turn ended before the message was inserted')) {
    return copy('The turn ended before the message was inserted', '这一轮在插入前已经结束');
  }
  return message.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/, '') || copy('Message was not inserted.', '消息未能插入。');
}
