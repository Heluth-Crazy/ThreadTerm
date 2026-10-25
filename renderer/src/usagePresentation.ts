import { activeTimeText, dayHasUsage, type UsageLocale } from './usageFormat';
import type { UsageLedgerSeries } from '@threadterm/protocol';

export function usageDays(series: UsageLedgerSeries | undefined, from: string, to: string): number | undefined {
  if (!series || series.granularity !== 'day' || !series.from || !series.to || from < series.from || to > series.to) return undefined;
  return series.points.filter(point => point.start >= from && point.start < to && dayHasUsage(point)).length;
}

export function aggregateActiveTime(ms: number, requests: number, locale: UsageLocale): string {
  if (ms === 0 && requests > 0) return locale === 'zh-CN' ? '无法测量' : 'Not measured';
  return `≈ ${sessionActiveTime(ms, requests, locale)}`;
}

/** A recorded request can be shorter than the native timestamp resolution. */
export function sessionActiveTime(ms: number, requests: number, locale: UsageLocale): string {
  if (requests > 0 && ms >= 0 && ms < 60_000) return locale === 'zh-CN' ? '不到 1 分钟' : '< 1 min';
  return activeTimeText(ms, locale);
}

export type TipBounds = { left: number; top: number; width: number; height: number };

/** Keep chart details over the data, clear of section actions and the legend. */
export function chartTipPosition(x: number, y: number, width: number, height: number, bounds: TipBounds) {
  const left = Math.max(bounds.left, Math.min(x - width / 2, bounds.left + bounds.width - width));
  const above = y - height - 8;
  const top = Math.max(bounds.top, Math.min(above >= bounds.top ? above : y + 8, bounds.top + bounds.height - height));
  return { left, top };
}
