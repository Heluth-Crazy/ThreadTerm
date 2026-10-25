import { useState } from 'react';
import { rebuildUsageLedger, useUsageSources } from '../usageLedger';
import { dateTimeText, type UsageLocale } from '../usageFormat';
import {
  fileLine, humanizeProblem, problemCounts, reportedBuckets, sourceState, sourceTotals,
} from '../usageSources';
import type { UsageCopy } from '../usageCopy';
import type { UsageLedgerSource } from '@threadterm/protocol';
import { AgentIcon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { WbIcon } from '../workbench/icons';

type Props = {
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
  /** Bumped when a scan finishes, so an open panel shows the new cursors and problems. */
  version: number;
  /** A rebuild changed the index: the page re-reads its aggregates. */
  onRebuilt: () => void;
};

/** Where the numbers come from, collapsed by default, and the only place that offers a full rebuild. */
export function UsageSources({ locale, copy, providerName, version, onRebuilt }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  // The read happens on expand and after a scan, never while the panel is closed.
  const { sources, loading, error, read } = useUsageSources(version, expanded);
  const totals = sourceTotals(sources?.providers ?? []);

  const rebuild = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await rebuildUsageLedger();
      setNotice(copy.sources.rebuildStarted);
      setConfirm(false);
      read();
      onRebuilt();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return <section className={`usage-sources${expanded ? ' is-open' : ''}`} aria-label={copy.sources.title}>
    <header className="usage-section-head">
      <button type="button" className="usage-disclosure" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <WbIcon name={expanded ? 'chevD' : 'chevR'} />
        <h2>{copy.sources.title}</h2>
      </button>
      {expanded && sources && <span className="usage-sources-total">{copy.sources.total(totals.filesRead, totals.facts)}</span>}
      {expanded && sources && <span className="usage-sources-parser">{copy.sources.parser(sources.parserVersion)}</span>}
      <span className="usage-head-spacer" />
      {expanded && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirm(true)}>{busy ? copy.sources.rebuildStarted : copy.sources.rebuild}</button>}
    </header>
    {expanded && <div className="usage-sources-body">
      {error ? <p className="surface-error" role="alert">{copy.sources.loadFailed} {error}</p>
        : !sources ? <p className="usage-empty">{loading ? copy.sources.loading : copy.sources.loadFailed}</p>
          : <>
            {notice && <p className="usage-notice" role="status">{notice}</p>}
            <ul className="usage-source-rows">
              {sources.providers.map(source => <SourceRow key={source.provider} source={source} locale={locale} copy={copy} providerName={providerName} />)}
            </ul>
          </>}
    </div>}
    {confirm && <SurfaceDialog size="sm" title={copy.sources.rebuildTitle} onClose={() => { if (!busy) setConfirm(false); }}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>{copy.cancel}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void rebuild()}>{busy ? copy.sources.rebuildStarted : copy.sources.rebuildConfirm}</button>
      </>}>
      <p className="dlg-text">{copy.sources.rebuildBody}</p>
      {sources && <p className="note">{copy.sources.parser(sources.parserVersion)} · {copy.sources.total(totals.filesRead, totals.facts)}</p>}
    </SurfaceDialog>}
  </section>;
}

function SourceRow({ source, locale, copy, providerName }: {
  source: UsageLedgerSource;
  locale: UsageLocale;
  copy: UsageCopy;
  providerName: (id: string) => string;
}) {
  const state = sourceState(source.status);
  // Only a provider whose history was actually opened has files, a read time or reported buckets to show.
  const wasRead = state === 'found' || state === 'partial' || state === 'cancelled' || state === 'failed';
  const files = wasRead ? fileLine(source.stats) : null;
  const stateText = copy.sources.state[state] ?? state;
  const problemText = (problem: ReturnType<typeof problemCounts>[number]) => problem.label ? copy.sources.problemLabels[problem.label] ?? humanizeProblem(problem.kind) : humanizeProblem(problem.kind);
  // A single problem that only repeats the state chip ("Format not supported yet") adds nothing.
  const problems = problemCounts(source.stats?.problems).filter(problem => !(problem.count === 1 && problemText(problem).toLowerCase() === stateText.toLowerCase()));
  // The three cache-write buckets (5 m, 1 h, unknown TTL) read as one word, like the tiles.
  const buckets = wasRead ? [...new Set(reportedBuckets(source.bucketsReported).map(bucket => bucketLabel(bucket, copy)))] : [];
  const lastRead = wasRead ? dateTimeText(source.lastRead, locale) : null;
  const notRead = source.historyReadLabelKey === 'historyNotReadThreadtermOnly';
  return <li className={`usage-source-row is-${state}`}>
    <span className="usage-source-head">
      <AgentIcon provider={source.provider} size={14} />
      <b>{providerName(source.provider)}</b>
      <span className={`chip flat usage-source-state is-${state}`}>{stateText}</span>
      <span className="usage-source-meta">
        {files && <span>{copy.sources.files(files.read, files.found)}</span>}
        {lastRead && <span>{copy.sources.lastRead(lastRead)}</span>}
        {source.missingSources > 0 && <span className="usage-source-missing">{copy.sources.missing(source.missingSources)}</span>}
      </span>
    </span>
    {(buckets.length > 0 || problems.length > 0 || notRead) && <span className="usage-source-detail">
      {notRead && <span className="usage-source-quiet">{copy.sources.notReadNote(providerName(source.provider))}</span>}
      {buckets.length > 0 && <span className="usage-source-quiet">{copy.sources.buckets(buckets.join(' · '))}</span>}
      {problems.length > 0 && <span className="usage-source-problems">
        {problems.map(problem => <span key={problem.kind} className="chip flat is-warn" title={problem.label ? undefined : humanizeProblem(problem.kind)}>
          {copy.sources.count(problemText(problem), problem.count)}
        </span>)}
      </span>}
    </span>}
  </li>;
}

/** Bucket keys become the page's own token words, so a source row reads like the tiles. */
function bucketLabel(bucket: string, copy: UsageCopy): string {
  if (bucket === 'cacheWrite5m' || bucket === 'cacheWrite1h' || bucket === 'cacheWriteUnknown') return copy.buckets.cacheWrite;
  return (copy.buckets as Record<string, string>)[bucket] ?? bucket;
}
