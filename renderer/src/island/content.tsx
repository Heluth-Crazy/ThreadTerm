import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { AgentTile } from '../components/PrototypeIcon';
import type { IslandItem } from './model';
import { clockText, islandAsk, type IslandWords } from './words';

/* The pieces drawn on the black island and what each activity shows (approved prototype, prototypes/task-island). */

export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
function Elapsed({ since, tone }: { since: number; tone?: 'needs' }) {
  const now = useNow();
  return <span className={`ti-time${tone ? ` ti-${tone}` : ''}`}>{clockText(now - since)}</span>;
}
type Badge = 'needs' | 'done' | 'failed';
function Glyph({ name }: { name: 'check' | 'cross' | 'chev' }) {
  const d = name === 'check' ? 'm5 12.5 4.2 4.2L19 7' : name === 'cross' ? 'M7 7l10 10M17 7 7 17' : 'm9 6 6 6-6 6';
  return <svg className="ti-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
}
export function Tile({ provider, size = 20, ring, badge }: { provider: string; size?: number; ring?: boolean; badge?: Badge }) {
  return <span className={`ti-tile${size >= 30 ? ' ti-tile-lg' : ''}`} style={{ '--ts': `${size}px` } as CSSProperties}>
    <AgentTile provider={provider} size={size} />
    {ring && <i className="ti-ring" />}
    {badge && <i className={`ti-badge ti-badge-${badge}`}>{badge === 'done' ? <Glyph name="check" /> : badge === 'failed' ? <Glyph name="cross" /> : null}</i>}
  </span>;
}
function TileStack({ providers, ring, badge }: { providers: string[]; ring?: boolean; badge?: Badge }) {
  return <span className="ti-stack">{providers.slice(0, 3).map((provider, index) => <span key={`${provider}${index}`} className="ti-stack-item" style={{ zIndex: 3 - index }}><Tile provider={provider} ring={ring && index === 0} badge={index === 0 ? badge : undefined} /></span>)}</span>;
}
function Lead({ icon, text, tone }: { icon: ReactNode; text: string; tone?: 'needs' | 'done' | 'failed' }) {
  return <span className="ti-lead">{icon}<span className={`ti-label${tone ? ` ti-${tone}` : ''}`}>{text}</span></span>;
}
function Bars() { return <span className="ti-bars" aria-hidden="true"><i /><i /><i /></span>; }
function Count({ n }: { n: number }) { return <span className="ti-count">{n}</span>; }
function Head({ icon, title, sub, tone }: { icon: ReactNode; title: string; sub: string; tone?: 'failed' }) {
  return <span className="ti-head">{icon}<span className="ti-head-text"><span className={`ti-h1${tone ? ` ti-${tone}` : ''}`}>{title}</span><span className="ti-h2">{sub}</span></span></span>;
}
function Button({ children, kind, onClick }: { children: ReactNode; kind?: 'needs' | 'light'; onClick?: () => void }) {
  return <button type="button" className={`ti-btn${kind ? ` ti-btn-${kind}` : ''}`} onClick={onClick}>{children}</button>;
}
function Row({ item, words, onOpen }: { item: IslandItem; words: IslandWords; onOpen: (key: string) => void }) {
  return <button type="button" className="ti-row" onClick={() => onOpen(item.key)}>
    <Tile provider={item.provider} size={26} ring />
    <span className="ti-row-text"><span className="ti-row-title">{item.title}</span><span className="ti-row-meta">{words.meta(item)}</span></span>
    <Elapsed since={item.since} />
    <Glyph name="chev" />
  </button>;
}

export interface Actions { open: (key: string) => void; later: () => void; openApp: () => void }

export function runningContent(running: IslandItem[], split: boolean, words: IslandWords, actions: Actions) {
  const first = running[0]!, providers = running.map(item => item.provider);
  const compact = split
    ? { leading: <Tile provider={first.provider} ring />, trailing: running.length > 1 ? <Count n={running.length} /> : <Elapsed since={first.since} /> }
    : running.length === 1
      ? { leading: <Lead icon={<Tile provider={first.provider} ring />} text={first.title} />, trailing: <Elapsed since={first.since} /> }
      : { leading: <Lead icon={<TileStack providers={providers} ring />} text={words.tasks(running.length)} />, trailing: <Bars /> };
  return {
    compact,
    minimal: <Tile provider={first.provider} ring />,
    expanded: {
      leading: <span className="ti-list-head"><span className="ti-h1">{words.running}</span><span className="ti-list-count">{running.length}</span></span>,
      trailing: <button type="button" className="ti-link" onClick={actions.openApp}>{words.openApp}</button>,
      bottom: <span className="ti-list">{running.map(item => <Row key={item.key} item={item} words={words} onOpen={actions.open} />)}</span>,
    },
  };
}

export function waitingContent(waiting: IslandItem[], words: IslandWords, zh: boolean, actions: Actions) {
  const newest = waiting[waiting.length - 1]!, ask = islandAsk(newest.approval, zh);
  const oldest = waiting.reduce((a, b) => (a.since <= b.since ? a : b));
  const compact = waiting.length === 1
    ? { leading: <Lead icon={<Tile provider={newest.provider} badge="needs" />} text={words.waitingCompact(newest, ask)} tone="needs" />, trailing: <Elapsed since={newest.since} tone="needs" /> }
    : { leading: <Lead icon={<TileStack providers={[...waiting].reverse().map(item => item.provider)} badge="needs" />} text={words.waitingMany(waiting.length)} tone="needs" />, trailing: <Elapsed since={oldest.since} tone="needs" /> };
  const label = ask ? words.askLabel(ask) : '';
  return {
    compact,
    minimal: <Tile provider={newest.provider} badge="needs" />,
    expanded: {
      leading: <Head icon={<Tile provider={newest.provider} size={38} badge="needs" />} title={words.waitingTitle(newest, ask)} sub={words.place(newest)} />,
      trailing: <Elapsed since={newest.since} tone="needs" />,
      bottom: <span className="ti-card-body">
        {ask && (ask.kind === 'question'
          ? <span className="ti-detail ti-detail-q">“{ask.text}”</span>
          : <span className="ti-detail">{label && <span className="ti-detail-k">{label}</span>}{ask.kind === 'command' ? <code>{ask.text}</code> : <span className="ti-detail-text">{ask.text}</span>}</span>)}
        {waiting.length > 1 && <button type="button" className="ti-more" onClick={() => actions.open(oldest.key)}>{words.more(waiting.length - 1)} <Glyph name="chev" /></button>}
        <span className="ti-actions"><Button onClick={actions.later}>{words.later}</Button><Button kind="needs" onClick={() => actions.open(newest.key)}>{words.go(newest, ask)}</Button></span>
      </span>,
    },
  };
}

export function finishedContent(item: IslandItem, words: IslandWords, actions: Actions) {
  const ok = item.state === 'done', badge = ok ? 'done' : 'failed';
  const sub = [item.title, item.started ? words.took(item.since - item.started) : undefined].filter(Boolean).join(' · ');
  return {
    compact: { leading: <Lead icon={<Tile provider={item.provider} badge={badge} />} text={ok ? words.done : words.failed} tone={badge} />, trailing: <span className={`ti-mark ti-${badge}`}><Glyph name={ok ? 'check' : 'cross'} /></span> },
    minimal: <Tile provider={item.provider} badge={badge} />,
    expanded: {
      leading: <Head icon={<Tile provider={item.provider} size={38} badge={badge} />} title={words.finishedTitle(item)} sub={sub} tone={ok ? undefined : 'failed'} />,
      trailing: <Button kind="light" onClick={() => actions.open(item.key)}>{words.view}</Button>,
      bottom: <span className="ti-summary">{item.result ?? words.finishedFallback(item)}</span>,
    },
  };
}
