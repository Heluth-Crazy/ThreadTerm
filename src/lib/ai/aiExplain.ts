/**
 * Frontend wrapper around the Rust `ai_explain` Tauri command.
 *
 * Stage 6 — one-shot, non-interactive AI CLI invocation. Returns a tagged
 * `AiExplainResult` envelope so the inspector UI can render OK vs error
 * states without throwing.
 */
import { invoke } from '@tauri-apps/api/core';

export type AiExplainProvider = 'claude' | 'codex' | 'gemini';

export interface AiExplainOk {
  kind: 'ok';
  text: string;
  stderr: string;
}
export interface AiExplainError {
  kind: 'error';
  message: string;
  timedOut: boolean;
}
export type AiExplainResult = AiExplainOk | AiExplainError;

interface RawResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface ExplainArgs {
  provider: AiExplainProvider;
  prompt: string;
}

export async function explainWithAi({ provider, prompt }: ExplainArgs): Promise<AiExplainResult> {
  if (!prompt.trim()) {
    return { kind: 'error', message: 'prompt is empty', timedOut: false };
  }
  try {
    const raw = (await invoke('ai_explain', { provider, prompt })) as RawResult;
    if (raw.timed_out) {
      return { kind: 'error', message: 'AI provider timed out', timedOut: true };
    }
    if (raw.exit_code !== 0) {
      return {
        kind: 'error',
        message: raw.stderr.trim() || `provider exited with ${raw.exit_code}`,
        timedOut: false,
      };
    }
    const text = raw.stdout.trim();
    if (!text) {
      const stderr = raw.stderr.trim();
      return {
        kind: 'error',
        message: stderr
          ? `AI provider returned no answer. stderr: ${stderr}`
          : 'AI provider returned no answer.',
        timedOut: false,
      };
    }
    return { kind: 'ok', text, stderr: raw.stderr };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e), timedOut: false };
  }
}
