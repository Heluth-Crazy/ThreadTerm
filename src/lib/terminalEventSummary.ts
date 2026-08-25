import type { TFunction } from 'i18next';
import type { TerminalEvent } from '../types/terminal';

const SENT_INPUT_SUMMARY_KEY = 'terminal:view.sentInput';

type TerminalEventSummary = Pick<TerminalEvent, 'summary' | 'summaryKey'>;

/** Resolve only backend-owned timeline keys; persisted text remains the fallback. */
export function resolveTerminalEventSummary(
  event: TerminalEventSummary,
  t: TFunction<'terminal'>,
): string {
  if (event.summaryKey !== SENT_INPUT_SUMMARY_KEY) return event.summary;
  const translated = t('view.sentInput', { defaultValue: event.summary });
  return typeof translated === 'string' && translated && translated !== 'view.sentInput'
    ? translated
    : event.summary;
}
