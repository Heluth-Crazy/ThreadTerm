import type { ChatItem } from '@threadterm/protocol';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const list = (value: unknown) => Array.isArray(value) ? value.map(record) : [];

export interface UsageLimit {
  label: string;
  group?: string;
  plan?: string;
  percent: number;
  resetAt?: string | number;
  resetHint?: string;
}
export interface UsageMetric { key: string; value: number | string; }
export interface UsageNotice { kind: 'info' | 'loading' | 'error'; key: string; text?: string; }
export interface UsageCardModel {
  provider: string;
  plan?: string;
  limits: UsageLimit[];
  metrics: UsageMetric[];
  notices: UsageNotice[];
  sinceResume?: boolean;
}

export function usagePlanName(value: unknown): string | undefined {
  const name = text(value);
  if (!name) return undefined;
  return ({ prolite: 'Pro Lite', self_serve_business_usage_based: 'Business', business: 'Business', enterprise: 'Enterprise', self_serve_business_prolite: 'Business Premium', self_serve: 'ChatGPT' } as Record<string, string>)[name.toLowerCase()] ?? name;
}

function windowLabel(minutes: unknown): string {
  const value = number(minutes);
  if (value === undefined) return 'Usage limit';
  if (value === 300) return '5-hour limit';
  if (value === 1440) return 'Daily limit';
  if (value === 10080) return 'Weekly limit';
  if (value === 43200) return 'Monthly limit';
  return value % 60 === 0 ? `${value / 60}h limit` : `${value}m limit`;
}

function codexUsage(data: RecordValue): UsageCardModel {
  const account = record(data.account), context = record(data.context);
  const model: UsageCardModel = { provider: 'Codex', plan: usagePlanName(account.planType), limits: [], metrics: [], notices: [] };
  for (const rate of list(data.rateLimits)) {
    model.plan ??= usagePlanName(rate.planType);
    for (const slot of ['primary', 'secondary']) {
      const window = record(rate[slot]), percent = number(window.usedPercent);
      if (percent === undefined) continue;
      model.limits.push({ label: windowLabel(window.windowDurationMins), group: text(rate.limitName) ?? text(rate.limitId), plan: usagePlanName(rate.planType), percent, resetAt: number(window.resetsAt) });
    }
  }
  for (const [source, key] of [['usedTokens', 'contextUsed'], ['modelContextWindow', 'contextLimit'], ['remainingTokens', 'contextRemaining'], ['percentUsed', 'contextPercent']]) {
    const value = number(context[source!]);
    if (value !== undefined) model.metrics.push({ key: key!, value });
  }
  const warning = text(data.warning);
  if (warning) model.notices.push({ kind: 'error', key: 'native', text: warning });
  else if (data.rateLimitsLoaded === false || data.accountLoaded === false) model.notices.push({ kind: 'loading', key: 'loadingLimits' });
  else if (!model.limits.length) model.notices.push({ kind: 'info', key: 'limitsUnavailable' });
  return model;
}

const NATIVE_METRICS: Record<string, string> = {
  'Input tokens': 'inputTokens', 'Output tokens': 'outputTokens', 'Total tokens': 'totalTokens',
  'Cache read tokens': 'cacheReadTokens', 'Cache creation tokens': 'cacheCreationTokens',
  'Reasoning tokens': 'reasoningTokens', 'Model calls': 'modelCalls', Turns: 'turns',
  'API time': 'apiSeconds', 'Cost (USD)': 'costUsd',
};

function nativeUsage(provider: string, item: ChatItem): UsageCardModel {
  const model: UsageCardModel = { provider: provider === 'grok' ? 'Grok' : 'Kimi', limits: [], metrics: [], notices: [] };
  const addMetric = (key: string, value: string) => {
    const parsed = Number(value.replaceAll(',', ''));
    if (number(parsed) !== undefined && !model.metrics.some(metric => metric.key === key)) model.metrics.push({ key, value: parsed });
  };
  for (const part of item.parts) {
    const data = record(part.data);
    if (data.kind === 'plan') {
      for (const row of list(data.rows)) {
        const percent = number(row.percent);
        if (percent !== undefined) model.limits.push({ label: text(row.label) ?? 'Usage limit', percent, resetAt: text(row.resetAt), resetHint: text(row.reset) });
      }
      const extra = record(data.extra), ratio = number(extra.ratio);
      if (ratio !== undefined) model.limits.push({ label: 'Monthly limit', group: 'Extra usage', percent: ratio * 100 });
      for (const row of list(extra.lines)) {
        const value = text(row.value) ?? number(row.value), label = text(row.label);
        if (value !== undefined && label) model.metrics.push({ key: label, value });
      }
      continue;
    }
    if (part.type === 'error') {
      model.notices.push({ kind: 'error', key: 'native', text: part.text });
      continue;
    }
    if (part.type !== 'text' || !part.text) continue;
    for (const raw of part.text.split('\n')) {
      const line = raw.trim().replace(/^[-*]\s+/, '');
      if (!line) continue;
      const title = line.match(/^Grok usage\s*[—–-]\s*(.+)$/);
      if (title) { model.plan = title[1]!.trim(); continue; }
      if (/^Grok session usage is unavailable/i.test(line)) { model.notices.push({ kind: 'error', key: 'statsUnavailable' }); continue; }
      if (/^Grok usage$|^Grok session usage/.test(line)) { if (line.includes('since start or last resume')) model.sinceResume = true; continue; }
      if (/^No model calls yet in this session\.|^Session total:\s*no (?:LLM|model) calls yet/i.test(line)) { model.notices.push({ kind: 'info', key: 'noCalls' }); continue; }
      if (/^(?:Account usage limits|Plan usage) (?:are|is).*unavailable/i.test(line)) { model.notices.push({ kind: 'error', key: 'limitsUnavailable' }); continue; }
      if (/^Token counts: not reported/i.test(line)) { model.notices.push({ kind: 'info', key: 'tokensUnavailable' }); continue; }
      const context = line.match(/^Context:\s*([\d,]+)(?:\s*\/\s*([\d,]+))?\s*tokens(?:\s*\(([\d.]+)%\))?/i);
      if (context) { addMetric('contextUsed', context[1]!); if (context[2]) addMetric('contextLimit', context[2]); if (context[3]) addMetric('contextPercent', context[3]); continue; }
      const total = line.match(/^Session total:\s*([\d,]+)\s+input,\s*([\d,]+)\s+output/i);
      if (total) { addMetric('inputTokens', total[1]!); addMetric('outputTokens', total[2]!); continue; }
      const metric = line.match(/^([^:]+):\s*\$?([\d,.]+)(?:\s*s)?$/);
      if (metric && NATIVE_METRICS[metric[1]!]) { addMetric(NATIVE_METRICS[metric[1]!]!, metric[2]!); continue; }
      // Preserve unrecognized native usage information inside the card instead
      // of discarding content or guessing what an unfamiliar number means.
      model.notices.push({ kind: 'info', key: 'native', text: line });
    }
  }
  return model;
}

/** Pure presentation adapter. Original persisted payloads are never mutated. */
export function usageCardsForItems(provider: string, items: ChatItem[]): Map<string, UsageCardModel> {
  const cards = new Map<string, UsageCardModel>();
  if (!['codex', 'kimi', 'grok'].includes(provider)) return cards;
  const commands = new Map<string, string>();
  let nearestCommand = '';
  for (const item of items) {
    if (item.role === 'user') {
      nearestCommand = item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim().split(/\s/)[0]?.toLowerCase() ?? '';
      if (item.turnId) commands.set(item.turnId, nearestCommand);
      continue;
    }
    if (item.role === 'system') { nearestCommand = ''; continue; }
    if (item.role !== 'assistant') continue;
    const command = item.turnId ? commands.get(item.turnId) : nearestCommand;
    const usageCommand = command === '/usage' || command === '/cost';
    if (provider === 'codex') {
      const status = item.parts.find(part => part.type === 'status' && record(part.data).kind !== 'providerRetry');
      if (!status) continue;
      const data = record(status.data);
      if (data.kind === 'usage' || (data.kind === undefined && usageCommand)) cards.set(item.id, codexUsage(data));
    } else {
      // Mixed replies still need the ordinary renderer for approvals, tools
      // and reasoning; a quota part alone must not swallow those controls.
      if (command && !usageCommand || item.parts.some(part => !['text', 'error'].includes(part.type))) continue;
      const native = item.parts.some(part => record(part.data).kind === 'plan' || /^Grok (?:session )?usage(?:$|\s+[—(])/m.test(part.text ?? '') || usageCommand && /^Context:.*tokens/m.test(part.text ?? ''));
      if (command !== '/status' && (native || usageCommand && item.parts.some(part => part.type === 'error' || /usage.*unavailable/i.test(part.text ?? '')))) cards.set(item.id, nativeUsage(provider, item));
    }
  }
  return cards;
}
