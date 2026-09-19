import type { UsageCardModel, UsageMetric } from '../usageCard';
import './usage-card.css';

const LABELS: Record<string, [string, string]> = {
  contextUsed: ['Context used', '已用上下文'], contextLimit: ['Context limit', '上下文容量'],
  contextRemaining: ['Context remaining', '剩余上下文'], contextPercent: ['Context used', '上下文使用率'],
  inputTokens: ['Input tokens', '输入 token'], outputTokens: ['Output tokens', '输出 token'],
  totalTokens: ['Total tokens', '总 token'], cacheReadTokens: ['Cache read', '缓存读取 token'],
  cacheCreationTokens: ['Cache creation', '缓存写入 token'], reasoningTokens: ['Reasoning tokens', '推理 token'],
  modelCalls: ['Model calls', '模型调用'], turns: ['Turns', '轮次'], apiSeconds: ['API time', 'API 耗时'], costUsd: ['Cost', '费用'],
  'Used this month': ['Used this month', '本月费用'], 'Monthly limit': ['Monthly limit', '月度额度'], Balance: ['Balance', '余额'],
};
const NOTICES: Record<string, [string, string]> = {
  noCalls: ['No model calls yet in this session.', '本次会话尚无模型调用。'],
  loadingLimits: ['Loading usage limits…', '正在加载用量限制…'],
  limitsUnavailable: ['Usage limits are currently unavailable.', '暂时无法获取用量限制。'],
  statsUnavailable: ['Session statistics are currently unavailable.', '暂时无法获取会话统计。'],
  tokensUnavailable: ['Token counts have not been reported yet.', '暂未返回 token 统计。'],
};
const NATIVE_NOTICES: Record<string, string> = {
  'account data unavailable': '暂时无法获取账户信息', 'rate-limit data unavailable': '暂时无法获取用量限制',
  'OpenAI authentication required': '需要登录 OpenAI', 'context window is nearing its limit': '上下文窗口接近上限',
  'a usage limit is nearly exhausted': '部分用量接近上限',
};

function limitLabel(label: string, zh: boolean): string {
  if (!zh) return label;
  if (/5[\s-]?(?:h|hour)/i.test(label)) return '5 小时限额';
  if (/weekly/i.test(label)) return '每周限额';
  if (/daily/i.test(label)) return '每日限额';
  if (/monthly/i.test(label)) return '每月限额';
  if (/annual/i.test(label)) return '每年限额';
  if (label === 'Usage limit') return '用量限制';
  return label.replace(/(\d+)h limit/, '$1 小时限额').replace(/(\d+)m limit/, '$1 分钟限额');
}

function resetLabel(at: string | number | undefined, hint: string | undefined, zh: boolean): string | undefined {
  if (at !== undefined) {
    const date = new Date(typeof at === 'number' ? at * 1000 : at);
    if (Number.isFinite(date.getTime())) return `${zh ? '重置于' : 'Resets'} ${date.toLocaleString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  if (!hint || hint === 'Reset time unavailable') return undefined;
  if (!zh) return hint;
  if (hint === 'reset') return '已重置';
  const relative = hint.match(/^resets in (?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (relative) return [relative[1] && `${relative[1]} 天`, relative[2] && `${relative[2]} 小时`, relative[3] && `${relative[3]} 分钟`, relative[4] && `${relative[4]} 秒`].filter(Boolean).join(' ') + '后重置';
  return hint.replace(/^Resets:/, '重置于');
}

export function UsageCard({ model, zh }: { model: UsageCardModel; zh: boolean }) {
  const copy = (en: string, cn: string) => zh ? cn : en;
  const locale = zh ? 'zh-CN' : 'en-US';
  const format = (metric: UsageMetric) => {
    if (typeof metric.value === 'string') return metric.value === 'Unlimited' ? copy('Unlimited', '不限') : metric.value;
    if (metric.key === 'costUsd') return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(metric.value);
    const value = metric.value.toLocaleString(locale, { maximumFractionDigits: 2 });
    return metric.key === 'apiSeconds' ? `${value} ${copy('s', '秒')}` : metric.key === 'contextPercent' ? `${value}%` : value;
  };
  const context = model.metrics.find(metric => metric.key === 'contextUsed');
  const capacity = model.metrics.find(metric => metric.key === 'contextLimit');
  const percent = model.metrics.find(metric => metric.key === 'contextPercent');
  const metrics = model.metrics.filter(metric => !(context && ['contextUsed', 'contextLimit', 'contextPercent'].includes(metric.key)));
  return <div className="usage-card" data-testid="usage-card" data-usage-provider={model.provider.toLowerCase()}>
    <div className="usage-card-heading"><strong>{model.provider} {copy('usage', '用量')}</strong>{model.plan && <span className="usage-card-plan">{model.plan}</span>}</div>
    {model.limits.length > 0 && <section className="usage-card-section usage-card-limits" aria-label={copy('Usage limits', '用量限制')}>
      <h4>{copy('Usage limits', '用量限制')}</h4>
      {model.limits.map((limit, index) => {
        const label = limitLabel(limit.label, zh), reset = resetLabel(limit.resetAt, limit.resetHint, zh);
        const percentText = `${limit.percent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
        return <div className="usage-limit" key={`${limit.group ?? ''}-${limit.label}-${index}`}>
          <div className="usage-limit-heading"><span>{limit.group && <b>{limit.group === 'Extra usage' ? copy('Extra usage', '额外用量') : limit.group}<span aria-hidden="true"> · </span></b>}{label}</span><span className="usage-limit-value">{percentText} <small>{copy('used', '已用')}</small></span></div>
          <div className="usage-limit-meter" role="meter" aria-label={`${limit.group ?? model.provider} ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, limit.percent)} aria-valuetext={`${percentText} ${copy('used', '已用')}`}><span style={{ width: `${Math.min(100, limit.percent)}%` }} /></div>
          {(reset || limit.plan && limit.plan !== model.plan) && <div className="usage-limit-meta">{limit.plan && limit.plan !== model.plan && <span>{limit.plan}</span>}{reset && <span>{reset}</span>}</div>}
        </div>;
      })}
    </section>}
    {model.metrics.length > 0 && <section className="usage-card-section" aria-label={copy('Session statistics', '会话统计')}>
      <div className="usage-stat-heading"><h4>{copy('Session statistics', '会话统计')}</h4>{model.sinceResume && <span>{copy('Since start or last resume', '本次启动或恢复以来')}</span>}</div>
      <dl className="usage-card-stats">
        {context && <div className="usage-stat-context"><dt>{copy('Context window', '上下文窗口')}</dt><dd>{format(context)}{capacity ? ` / ${format(capacity)}` : ''} {copy('tokens', 'token')}{percent ? ` · ${format(percent)}` : ''}</dd></div>}
        {metrics.map((metric, index) => <div key={`${metric.key}-${index}`}><dt>{LABELS[metric.key]?.[zh ? 1 : 0] ?? metric.key}</dt><dd>{format(metric)}</dd></div>)}
      </dl>
    </section>}
    {model.notices.map((notice, index) => <p className={`usage-card-notice is-${notice.kind}`} key={`${notice.key}-${index}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {NOTICES[notice.key]?.[zh ? 1 : 0] ?? (zh ? notice.text?.split(';').map(part => NATIVE_NOTICES[part.trim()] ?? part.trim()).join('；') : notice.text)}
    </p>)}
  </div>;
}
