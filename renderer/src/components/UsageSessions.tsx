import { useEffect, useMemo, useState } from 'react';
import type { ProviderId, Snapshot, UsageLedgerSession, UsageLedgerSessionDetail } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { useUsageSession, useUsageSessions, type UsageQuery } from '../usageLedger';
import {
  activeTimeText, compactTokens, costDisplay, dayText, fullNumber, localDayOf, type UsageLocale,
} from '../usageFormat';
import { clampOffset, modelLabel, pageCount, sessionHeading, sessionQuery, USAGE_SESSION_SORTS, type UsageSessionSort } from '../usageSessions';
import type { UsageCopy } from '../usageCopy';
import { AgentIcon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';
import { WbIcon } from '../workbench/icons';

type Props = {
  query: UsageQuery;
  data: Snapshot | undefined;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
  /** Bumped when a scan finishes, so the page re-reads its own slice. */
  version: number;
  onOpenSession?: (sessionId: string) => void;
  onImported?: () => void;
};

const rowKey = (session: Pick<UsageLedgerSession, 'provider' | 'nativeSessionId'>) => `${session.provider}\u0000${session.nativeSessionId}`;

/** The sessions list: search, sort, paging, a drawer per session and the existing history import for outside rows. */
export function UsageSessions({ query, data, locale, copy, providerName, version, onOpenSession, onImported }: Props) {
  const [sort, setSort] = useState<UsageSessionSort>('tokens');
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [openKey, setOpenKey] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [importing, setImporting] = useState<string>();

  // A new range, scope, filter or search starts at the first page again.
  useEffect(() => { setOffset(0); }, [query.from, query.to, query.scope, query.projectId, query.provider, query.model, search, sort, version]);

  const params = useMemo(() => sessionQuery({ sort, offset, search }), [sort, offset, search]);
  const { page, loading, error } = useUsageSessions(query, params, version);
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const pages = pageCount(total, params.limit);
  const current = Math.floor(clampOffset(offset, total, params.limit) / params.limit) + 1;
  const open = items.find(session => rowKey(session) === openKey);

  const titleFor = (session: UsageLedgerSession) => session.threadtermSessionId
    ? data?.sessions.find(candidate => candidate.id === session.threadtermSessionId)?.title
    : undefined;

  const submitSearch = () => setSearch(searchDraft.trim());
  const clearSearch = () => { setSearchDraft(''); setSearch(''); };

  const openRow = (session: UsageLedgerSession) => {
    if (session.threadtermSessionId && onOpenSession) onOpenSession(session.threadtermSessionId);
    else setOpenKey(rowKey(session));
  };

  const importSession = async (session: UsageLedgerSession) => {
    if (!session.cwd) return;
    setImporting(rowKey(session));
    setNotice(undefined);
    try {
      const capability = data?.providers.find(provider => provider.id === session.provider);
      const created = await request('history.import', {
        cwd: session.cwd,
        provider: session.provider as ProviderId,
        nativeId: session.nativeSessionId,
        mode: capability?.chat ? 'chat' : 'terminal',
        operationId: operationId(),
      });
      setNotice({ kind: 'ok', text: copy.sessions.imported });
      onImported?.();
      if (onOpenSession) onOpenSession(created.id);
    } catch (caught) {
      setNotice({ kind: 'error', text: `${copy.sessions.importFailed}${caught instanceof Error ? caught.message : String(caught)}` });
    } finally {
      setImporting(undefined);
    }
  };

  return <section className="usage-sessions" aria-label={copy.sessions.title}>
    <header className="usage-section-head">
      <h2>{copy.sessions.title}</h2>
      <div className="usage-search" role="search">
        <input
          type="search"
          className="usage-search-input"
          aria-label={copy.sessions.search}
          placeholder={copy.sessions.searchPlaceholder}
          value={searchDraft}
          onChange={event => setSearchDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') submitSearch(); if (event.key === 'Escape') clearSearch(); }}
        />
        {searchDraft
          ? <button type="button" className="icon-btn icon-btn-sm" aria-label={copy.sessions.clearSearch} title={copy.sessions.clearSearch} onClick={clearSearch}><WbIcon name="close" /></button>
          : <button type="button" className="icon-btn icon-btn-sm" aria-label={copy.sessions.searchAction} title={copy.sessions.searchAction} onClick={submitSearch}><WbIcon name="search" /></button>}
      </div>
      <label className="usage-sort">
        <span>{copy.sessions.sort}</span>
        <Select value={sort} aria-label={copy.sessions.sort} onChange={event => setSort(event.target.value as UsageSessionSort)}>
          {USAGE_SESSION_SORTS.map(value => <option key={value} value={value}>{sortLabel(value, copy)}</option>)}
        </Select>
      </label>
      <span className="usage-sessions-count">{copy.sessions.count(total)}</span>
    </header>
    {error ? <p className="surface-error" role="alert">{error}</p> : <>
      {notice && <p className={`usage-notice${notice.kind === 'error' ? ' is-error' : ''}`} role="status">{notice.text}</p>}
      {items.length === 0
        ? <p className="usage-empty">{loading ? copy.readingHistory : search ? copy.sessions.noMatch(search) : copy.sessions.empty}</p>
        : <ul className="usage-session-rows">
          {items.map(session => <SessionRow key={rowKey(session)} session={session} heading={sessionHeading(session, titleFor(session))}
            locale={locale} copy={copy} providerName={providerName}
            importing={importing === rowKey(session)} onOpen={() => openRow(session)} onDetails={() => setOpenKey(rowKey(session))}
            onImport={() => void importSession(session)} />)}
        </ul>}
      {total > params.limit && <div className="usage-page-actions">
        <span className="usage-page-meta">{copy.sessions.page(current, pages)}</span>
        <button type="button" className="btn btn-sm" disabled={current <= 1} onClick={() => setOffset(Math.max(0, (current - 2) * params.limit))}>{copy.sessions.previous}</button>
        <button type="button" className="btn btn-sm" disabled={current >= pages} onClick={() => setOffset((current) * params.limit)}>{copy.sessions.next}</button>
      </div>}
    </>}
    {open && <SessionDrawer session={open} query={query} version={version} locale={locale} copy={copy} providerName={providerName}
      heading={sessionHeading(open, titleFor(open))} onClose={() => setOpenKey(undefined)}
      canOpen={Boolean(open.threadtermSessionId && onOpenSession)} onOpenChat={() => { if (open.threadtermSessionId) onOpenSession?.(open.threadtermSessionId); }} />}
  </section>;
}

const sortLabel = (sort: UsageSessionSort, copy: UsageCopy) => sort === 'tokens' ? copy.sessions.sortTokens
  : sort === 'cost' ? copy.sessions.sortCost : sort === 'recent' ? copy.sessions.sortRecent : copy.sessions.sortActive;

function SessionRow({ session, heading, locale, copy, providerName, importing, onOpen, onDetails, onImport }: {
  session: UsageLedgerSession;
  heading: string | null;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
  importing: boolean;
  onOpen: () => void;
  onDetails: () => void;
  onImport: () => void;
}) {
  const provider = providerName(session.provider);
  const inThreadTerm = Boolean(session.threadtermSessionId);
  const model = modelLabel(session.models);
  const cost = costDisplay(session.cost, locale, session.pricingPending);
  const name = heading ?? (inThreadTerm ? copy.sessions.untitled : copy.breakdown.unknownModel);
  const day = localDayOf(session.lastOccurredAt);
  const meta = [
    model ? `${model.model}${model.extra > 0 ? ` ${copy.sessions.moreModels(model.extra)}` : ''}` : copy.breakdown.unknownModel,
    copy.sessions.requests(session.requests),
    compactTokens(session.tokens.total, locale),
    `${copy.cost.short} ${cost.text}`,
    activeTimeText(session.activeTimeMs, locale),
    day ? dayText(day, locale) : undefined,
  ].filter(Boolean).join(' · ');
  return <li className="usage-session-row">
    <button type="button" className="usage-session-main" onClick={onOpen} aria-label={`${provider} · ${name} · ${meta}`}>
      <span className="usage-session-line">
        <AgentIcon provider={session.provider} size={14} />
        <span className="usage-session-provider">{provider}</span>
        <b className="usage-session-name">{name}</b>
        <span className="chip flat">{inThreadTerm ? copy.sessions.inThreadTerm : copy.sessions.outside}</span>
        {session.subagentCount > 0 && <span className="usage-session-subagents">{copy.sessions.subagents(session.subagentCount)}</span>}
      </span>
      <span className="usage-session-meta tnum" title={cost.noPrice ? `${copy.cost.short} — ${copy.cost.noPrice}` : copy.cost.tooltip}>{meta}</span>
    </button>
    <span className="usage-session-actions">
      {inThreadTerm
        ? <>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={copy.sessions.drawerTitle} title={copy.sessions.drawerTitle} onClick={onDetails}><WbIcon name="chevR" /></button>
          <button type="button" className="btn btn-sm" onClick={onOpen}>{copy.sessions.openChat}</button>
        </>
        : <button type="button" className="btn btn-sm" disabled={importing || !session.cwd}
          title={session.cwd ? copy.sessions.importSession : copy.sessions.importNeedsFolder}
          onClick={onImport}>{importing ? copy.sessions.importing : copy.sessions.importSession}</button>}
    </span>
  </li>;
}

function SessionDrawer({ session, query, version, locale, copy, providerName, heading, onClose, canOpen, onOpenChat }: {
  session: UsageLedgerSession;
  query: UsageQuery;
  version: number;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
  heading: string | null;
  onClose: () => void;
  canOpen: boolean;
  onOpenChat: () => void;
}) {
  const { detail, loading, error } = useUsageSession(query, { provider: session.provider, nativeSessionId: session.nativeSessionId }, version);
  return <SurfaceDialog size="md" title={copy.sessions.drawerTitle}
    subtitle={copy.sessions.drawerSubtitle(providerName(session.provider), heading ?? session.nativeSessionId)}
    onClose={onClose}
    footer={<>
      {canOpen && <button type="button" className="btn" onClick={onOpenChat}>{copy.sessions.openChat}</button>}
      <button type="button" className="btn btn-primary" onClick={onClose}>{copy.sessions.close}</button>
    </>}>
    <div className="usage-drawer">
      <div className="usage-drawer-stats">
        <Stat label={copy.tiles.tokens} value={compactTokens(session.tokens.total, locale)} />
        <Stat label={copy.cost.short} value={costDisplay(session.cost, locale, session.pricingPending).text} title={session.cost.pricedTokens > 0 ? copy.cost.tooltip : copy.cost.noPrice} />
        <Stat label={copy.tiles.requests} value={fullNumber(session.requests, locale)} />
        <Stat label={copy.tiles.activeTime} value={activeTimeText(session.activeTimeMs, locale)} />
      </div>
      {error ? <p className="surface-error" role="alert">{error}</p> : loading && !detail ? <p className="usage-empty">{copy.readingHistory}</p> : <>
        <Detail detail={detail} session={session} locale={locale} copy={copy} providerName={providerName} />
      </>}
    </div>
  </SurfaceDialog>;
}

function Detail({ detail, session, locale, copy, providerName }: {
  detail: UsageLedgerSessionDetail | undefined;
  session: UsageLedgerSession;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
}) {
  const models = (detail?.models ?? session.models).filter(model => model.trim());
  const days = (detail?.days ?? []).filter(day => day.requests > 0);
  const subagents = detail?.subagents ?? [];
  return <>
    <section className="usage-drawer-section">
      <h3>{copy.sessions.modelsTitle}</h3>
      {models.length
        ? <p className="usage-drawer-chips">{models.map(model => <span key={model} className="chip flat">{model}</span>)}</p>
        : <p className="usage-drawer-quiet">{copy.sessions.noModels}</p>}
    </section>
    <section className="usage-drawer-section">
      <h3>{copy.sessions.days}</h3>
      {days.length ? <div className="usage-table-wrap">
        <table className="usage-table">
          <thead><tr><th scope="col">{copy.heatmap.date}</th><th scope="col">{copy.tiles.tokens}</th><th scope="col">{copy.cost.column}</th></tr></thead>
          <tbody>{days.map(day => <tr key={day.start}>
            <th scope="row">{dayText(day.start, locale)}</th>
            <td>{compactTokens(day.tokens.total, locale)}</td>
            <td title={day.cost.pricedTokens > 0 ? copy.cost.tooltip : copy.cost.noPrice}>{costDisplay(day.cost, locale, day.pricingPending).text}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="usage-drawer-quiet">{copy.sessions.noDays}</p>}
    </section>
    <section className="usage-drawer-section">
      <h3>{copy.sessions.subagentsTitle}</h3>
      {subagents.length
        ? <>
          <p className="usage-drawer-quiet">{copy.sessions.subagents(subagents.length)}</p>
          <ul className="usage-drawer-subagents">
            {subagents.map(child => {
              const model = modelLabel(child.models);
              const day = localDayOf(child.lastOccurredAt);
              return <li key={`${child.provider}\u0000${child.nativeSessionId}`}>
                <AgentIcon provider={child.provider} size={13} />
                <span className="usage-drawer-subagent-name">{sessionHeading(child) ?? child.nativeSessionId}</span>
                <span className="usage-drawer-quiet">{providerName(child.provider)}{model ? ` · ${model.model}` : ''}{day ? ` · ${dayText(day, locale)}` : ''}</span>
                <b className="tnum">{compactTokens(child.tokens.total, locale)}</b>
              </li>;
            })}
          </ul>
        </>
        : <p className="usage-drawer-quiet">{copy.sessions.noSubagents}</p>}
    </section>
  </>;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="usage-drawer-stat" title={title}>
    <span>{label}</span>
    <b className="tnum">{value}</b>
  </div>;
}
