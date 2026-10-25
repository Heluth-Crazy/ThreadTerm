import type { UsageLedgerBreakdown, UsageLedgerBreakdownItem } from '@threadterm/protocol';
import { providerSlots, PROVIDER_SLOT_ORDER } from '../usageSeries';
import { compactTokens, costDisplay, percentText, type UsageLocale } from '../usageFormat';
import type { UsageCopy } from '../usageCopy';

export type UsageBreakdownDimension = 'provider' | 'model' | 'project';

export type BreakdownFilter = { provider?: string; model?: string; projectId?: string };

type Props = {
  breakdowns: Partial<Record<UsageBreakdownDimension, UsageLedgerBreakdown>>;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
  loading: boolean;
  /** Current row filters, so the pressed row and the list it came from stay readable. */
  selected: BreakdownFilter;
  onFilter: (filter: BreakdownFilter) => void;
};

/** Three lists side by side: by provider, by model, by project. A row click filters the whole page. */
export function UsageBreakdowns({ breakdowns, locale, copy, providerName, loading, selected, onFilter }: Props) {
  // Provider colours follow the provider, not its rank: the fixed order wins even when a filter hides the others.
  const providerIds = [...PROVIDER_SLOT_ORDER, ...(breakdowns.provider?.items ?? []).map(item => item.key)];
  const slots = providerSlots(providerIds);
  return <section className="usage-breakdown" aria-label={copy.breakdown.title}>
    <List dimension="provider" title={copy.breakdown.byProvider} items={breakdowns.provider?.items}
      locale={locale} copy={copy} loading={loading}
      label={item => providerName(item.key)}
      swatch={item => slots.get(item.key)}
      selectedKey={selected.provider}
      onSelect={key => onFilter({ provider: key === selected.provider ? undefined : key })} />
    <List dimension="model" title={copy.breakdown.byModel} items={breakdowns.model?.items}
      locale={locale} copy={copy} loading={loading}
      label={item => itemLabel('model', item, copy)}
      selectedKey={selected.model}
      onSelect={key => onFilter({ model: key === selected.model ? undefined : key })} />
    <List dimension="project" title={copy.breakdown.byProject} items={breakdowns.project?.items}
      locale={locale} copy={copy} loading={loading}
      label={item => itemLabel('project', item, copy)}
      // "Other folders" is not a project id, so it cannot become a filter; the chip list would lie.
      selectable={item => item.key !== ''}
      selectedKey={selected.projectId}
      onSelect={key => onFilter({ projectId: key === selected.projectId ? undefined : key })} />
  </section>;
}

function itemLabel(dimension: 'model' | 'project', item: UsageLedgerBreakdownItem, copy: UsageCopy): string {
  if (item.labelKey === 'otherFolders') return copy.breakdown.otherFolders;
  if (item.labelKey === 'grokModelNotReported') return copy.breakdown.grokModelNotReported;
  if (item.labelKey === 'unknownModel') return copy.breakdown.unknownModel;
  if (dimension === 'model' && !item.key) return copy.breakdown.unknownModel;
  return item.label || item.key;
}

function List({ dimension, title, items, locale, copy, loading, label, swatch, selectedKey, selectable, onSelect }: {
  dimension: UsageBreakdownDimension;
  title: string;
  items: UsageLedgerBreakdownItem[] | undefined;
  locale: UsageLocale;
  copy: UsageCopy;
  loading: boolean;
  label: (item: UsageLedgerBreakdownItem) => string;
  swatch?: (item: UsageLedgerBreakdownItem) => number | undefined;
  selectedKey?: string;
  selectable?: (item: UsageLedgerBreakdownItem) => boolean;
  onSelect: (key: string) => void;
}) {
  const rows = items ?? [];
  const max = rows.reduce((top, item) => Math.max(top, item.tokens.total), 0);
  return <div className={`usage-bd-list usage-bd-${dimension}`}>
    <div className="usage-bd-title"><h2>{title}</h2><span className="usage-bd-cost-head" title={copy.cost.tooltip}>{copy.cost.column}</span></div>
    {rows.length === 0
      ? <p className="usage-bd-empty">{loading ? copy.readingHistory : copy.breakdown.empty}</p>
      : <ul className="usage-bd-rows">
        {rows.map(item => {
          const name = label(item);
          const outside = item.labelKey === 'otherFolders';
          const share = max > 0 ? item.tokens.total / max : 0;
          const cost = costDisplay(item.cost, locale, item.pricingPending);
          const slot = swatch?.(item);
          const selected = selectedKey !== undefined && selectedKey === item.key && item.key !== '';
          const clickable = selectable ? selectable(item) : item.key !== '';
          const content = <>
            <span className="usage-bd-name">
              {slot !== undefined && <i className={`usage-swatch sv-${slot}`} aria-hidden="true" />}
              <span className="usage-bd-label" title={name}>{name}</span>
              {outside && <span className="usage-bd-outside">{copy.breakdown.outside}</span>}
            </span>
            <span className="usage-bd-value tnum">{compactTokens(item.tokens.total, locale)}</span>
            <span className="usage-bd-track" aria-hidden="true"><i className={slot !== undefined ? `usage-swatch sv-${slot}` : undefined} style={{ width: `${share > 0 ? Math.max(share * 100, 2) : 0}%` }} /></span>
            <span className="usage-bd-cost tnum" title={cost.noPrice ? copy.cost.noPrice : copy.cost.tooltip}>{cost.text}</span>
          </>;
          const labelText = `${copy.breakdown.share(name + (outside ? ` ${copy.breakdown.outside}` : ''), compactTokens(item.tokens.total, locale), percentText(share, locale))} · ${copy.cost.column} ${cost.noPrice ? copy.cost.noPrice : cost.text}`;
          return <li key={`${dimension}-${item.key}`}>
            {clickable
              ? <button type="button" className={`usage-bd-row${selected ? ' is-selected' : ''}`} aria-pressed={selected} aria-label={labelText}
                title={copy.breakdown.filter(name)} onClick={() => onSelect(item.key)}>{content}</button>
              : <div className="usage-bd-row is-static" aria-label={labelText}>{content}</div>}
          </li>;
        })}
      </ul>}
  </div>;
}
