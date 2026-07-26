import type { TerminalAiIntent } from '../../types/terminal';

export const AI_INTENTS: TerminalAiIntent[] = ['review', 'fix', 'research', 'test', 'docs'];

export const AI_INTENT_CLASS: Record<TerminalAiIntent, string> = {
  review: 'border-violet-500/30 bg-violet-500/10 text-violet-600',
  fix: 'border-destructive/30 bg-destructive/10 text-destructive',
  research: 'border-info/30 bg-info/10 text-info',
  test: 'border-success/30 bg-success/10 text-success',
  docs: 'border-warning/30 bg-warning/10 text-warning',
};
