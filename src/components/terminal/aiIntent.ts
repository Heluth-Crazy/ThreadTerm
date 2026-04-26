import type { TerminalAiIntent } from '../../types/terminal';

export const AI_INTENTS: TerminalAiIntent[] = ['review', 'fix', 'research', 'test', 'docs'];

export const AI_INTENT_CLASS: Record<TerminalAiIntent, string> = {
  review: 'border-violet-500/30 bg-violet-500/10 text-violet-600',
  fix: 'border-red-500/30 bg-red-500/10 text-red-500',
  research: 'border-sky-500/30 bg-sky-500/10 text-sky-600',
  test: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  docs: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
};
