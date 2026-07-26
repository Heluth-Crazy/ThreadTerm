export const CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/codex/device';

export function isCodexLoginCommand(command: unknown): command is string {
  return typeof command === 'string' && /\bcodex\s+login\b/i.test(command);
}
