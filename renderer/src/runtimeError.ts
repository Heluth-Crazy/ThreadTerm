import { runtimeText } from './contextErrors';
import { runtimeErrorCode, runtimeErrorText } from './runtimeErrors';

/** Reader-language copy for a runtime code the UI can explain itself. The IPC
 * round trip drops typed fields, but the runtime repeats the code in the message
 * (`response_too_large: …`), so `runtimeErrorCode` still recovers it. */
const CODE_TEXT: Record<string, [string, string]> = {
  response_too_large: ['This part of the conversation is too large to load at once.', '此部分对话过大，无法一次加载。'],
};

/** What to show the user for a failed request: their own language, never the IPC wrapper. */
export function userErrorText(caught: unknown, fallback: string, zh: boolean): string {
  const typed = caught && typeof caught === 'object' ? (caught as { code?: unknown }).code : undefined;
  const code = typeof typed === 'string' && typed ? typed : runtimeErrorCode(caught);
  const known = code ? CODE_TEXT[code] : undefined;
  if (known) return known[zh ? 1 : 0];
  const message = runtimeText(runtimeErrorText(caught) ?? '', zh).trim();
  return message || fallback;
}
