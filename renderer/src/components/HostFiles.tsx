import { useEffect, useRef, useState } from 'react';
import type { RequestResult } from '@threadterm/protocol';
import { request } from '../bridge';
import { useTranslation } from '../i18n';
import type { HostFilesRequest, RemoteFilesBridge } from '../remoteFiles';
import { SurfaceDialog } from './SurfaceDialog';
import { Icon } from './PrototypeIcon';
import './host-files.css';

type Listing = RequestResult<'filesystem.browse'>;
type Entry = Listing['entries'][number];
const displayHostPath = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
export const hostPathKey = (path: string) => {
  const normalized = displayHostPath(path).replace(/\\/g, '/').replace(/\/$/, '');
  return /^(?:[a-z]:[/\\]|\\\\|\/\/)/i.test(path) ? normalized.toLowerCase() : normalized;
};

export function HostFileRows({ entries, mode, selected, busy, label = 'Files', onDirectory, onSelect }: { entries: Entry[]; mode: HostFilesRequest['mode']; selected: string[]; busy: boolean; label?: string; onDirectory(path: string): void; onSelect(path: string): void }) {
  return <div className="host-file-rows" role="group" aria-label={label}>{entries.filter(entry => mode !== 'directory' || entry.kind === 'directory').map(entry => <button type="button" key={entry.path} className={`cmd-row${selected.some(path => hostPathKey(path) === hostPathKey(entry.path)) ? ' active' : ''}`} disabled={busy} aria-pressed={entry.kind === 'file' ? selected.some(path => hostPathKey(path) === hostPathKey(entry.path)) : undefined} title={entry.path} data-host-path={entry.path} onClick={() => entry.kind === 'directory' ? onDirectory(entry.path) : onSelect(entry.path)}>
    <Icon name={entry.kind === 'directory' ? 'folder' : 'file'}/><b>{entry.name}</b><span>{entry.kind === 'file' ? `${Math.ceil(entry.size / 1024)} KB` : ''}</span>
  </button>)}</div>;
}

function HostFileBrowser({ value, close }: { value: HostFilesRequest; close(paths?: string[]): void }) {
  const { locale } = useTranslation(), zh = locale === 'zh-CN', text = (en: string, cn: string) => zh ? cn : en;
  const [listing, setListing] = useState<Listing>(), [path, setPath] = useState(value.path ?? ''), [location, setLocation] = useState(value.path ?? '');
  const [selected, setSelected] = useState<string[]>(value.selectedPath ? [value.selectedPath] : []), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const generation = useRef(0), rows = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const current = ++generation.current; let active = true; setBusy(true); setError(undefined);
    void request('filesystem.browse', path ? { path } : {}).then(next => {
      if (!active || current !== generation.current) return;
      setListing(next); setLocation(next.path ? displayHostPath(next.path) : '');
    }).catch(error => { if (active && current === generation.current) setError(String(error)); }).finally(() => { if (active && current === generation.current) setBusy(false); });
    return () => { active = false; };
  }, [path, attempt]);
  // Reveal shows its item: scroll the selected row into view once the folder is listed.
  useEffect(() => { if (listing) rows.current?.querySelector('.cmd-row.active')?.scrollIntoView({ block: 'nearest' }); }, [listing]);
  const navigate = (path: string) => { setSelected([]); setPath(path); setLocation(path); setAttempt(value => value + 1); };
  const contents = <>
    <form className="host-file-location" onSubmit={event => { event.preventDefault(); navigate(location.trim()); }}>
      <label htmlFor={`host-location-${value.id}`}>{text('Location', '位置')}</label><div><input className="create-input create-input-mono" autoFocus id={`host-location-${value.id}`} value={location} onChange={event => setLocation(event.target.value)} placeholder={text('Drives', '磁盘')} /><button className="btn btn-sm" type="submit" disabled={busy}>{text('Go', '转到')}</button></div>
    </form>
    <div className="host-file-navigation"><button className="btn btn-sm" type="button" disabled={busy || !path} onClick={() => navigate('')}>{text('Drives', '磁盘')}</button><button className="btn btn-sm" type="button" disabled={busy || !listing?.parent} onClick={() => navigate(listing!.parent!)}>{text('Up', '上一级')}</button><span role="status">{busy ? text('Loading…', '正在加载…') : ''}</span></div>
    {error && <p className="surface-error" role="alert">{error}</p>}
    <div ref={rows}><HostFileRows entries={listing?.entries ?? []} mode={value.mode} selected={selected} busy={busy} label={text('Files', '文件')} onDirectory={navigate} onSelect={path => setSelected(current => current.includes(path) ? current.filter(item => item !== path) : value.mode === 'files' ? [...current, path].slice(0, 10) : [path])}/></div>
    {!busy && listing && !listing.entries.length && <p className="palette-empty">{text('This folder is empty.', '此文件夹为空。')}</p>}
    {listing?.truncated && <p role="status">{text('Showing the first 1,000 entries. Enter a folder path to continue.', '仅显示前 1,000 项。输入文件夹路径以继续。')}</p>}
  </>;
  if (value.mode === 'reveal') return <aside className="wb-sidebar host-files-panel" data-testid="host-files-panel" aria-label={text('Files', '文件')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header className="wb-panel-head"><strong>{text('Files', '文件')}</strong><button type="button" className="icon-btn" aria-label={text('Close Files', '关闭文件')} onClick={() => close()}><Icon name="close"/></button></header><div className="host-files-body">{contents}</div>
  </aside>;
  return <SurfaceDialog title={value.mode === 'directory' ? text('Choose a folder', '选择文件夹') : text('Open files', '打开文件')} icon="folder" onClose={() => close()} className="host-files-dialog" footer={<><button className="btn" type="button" onClick={() => close()}>{text('Cancel', '取消')}</button><button type="button" className="btn btn-primary" disabled={busy || Boolean(error) || (value.mode === 'directory' ? !listing?.path : !selected.length)} onClick={() => close(value.mode === 'directory' ? [listing!.path!] : selected)}>{value.mode === 'directory' ? text('Choose this folder', '选择此文件夹') : text('Open', '打开')}</button></>}>{contents}</SurfaceDialog>;
}

/** Mounted only in a renderer bound to another computer. */
export function HostFiles() {
  const [value, setValue] = useState<HostFilesRequest>();
  const pending = useRef<HostFilesRequest | undefined>(undefined);
  const bridge = window.threadterm as typeof window.threadterm & RemoteFilesBridge;
  useEffect(() => bridge.onHostFiles(next => {
    const previous = pending.current;
    if (previous && previous.mode !== 'reveal') void bridge.completeHostFiles(previous.id, []);
    pending.current = next; setValue(next);
  }), []);
  return value ? <HostFileBrowser key={value.id} value={value} close={paths => { pending.current = undefined; setValue(undefined); if (value.mode !== 'reveal') void bridge.completeHostFiles(value.id, paths ?? []); }}/> : null;
}
