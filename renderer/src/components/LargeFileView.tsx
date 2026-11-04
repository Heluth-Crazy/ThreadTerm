import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../bridge';
import { externalFileError, externalFileErrorCode } from '../externalFiles';
import { translate } from '../i18n';
import { workbenchError } from '../workbench/errors';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { createWindowLoader, LARGE_FILE_WINDOW_BYTES, percentOffset, windowOffset, type WindowState } from '../largeFileWindow';
import './large-file-view.css';

export function LargeFileView({ projectId, worktreePath, path, externalId, zh, active, onReload }: {
  projectId: string; worktreePath?: string; path: string; externalId?: string; zh: boolean;
  active?: boolean; onReload: () => void;
}) {
  const [state, setState] = useState<WindowState>({ busy: true });
  const [percent, setPercent] = useState('0');
  const percentEdited = useRef(false);
  const wasActive = useRef(active);
  const text = useRef<HTMLTextAreaElement>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(zh ? 'zh-CN' : 'en', key);
  const loader = useMemo(() => createWindowLoader((offset, changeToken) => {
    const range = { offset, maxBytes: LARGE_FILE_WINDOW_BYTES, ...(changeToken === undefined ? {} : { changeToken }) };
    return externalId
      ? request('filesystem.external.readWindow', { id: externalId, ...range })
      : request('filesystem.readWindow', { projectId, worktreePath, path, ...range });
  }, setState), [projectId, worktreePath, path, externalId]);
  useEffect(() => { void loader.load(0); return () => loader.dispose(); }, [loader]);
  const window = state.window;
  useEffect(() => {
    const activated = active && wasActive.current === false;
    wasActive.current = active;
    if (externalId && activated && window) void loader.load(window.start);
  }, [active, externalId, loader, window]);
  useEffect(() => {
    if (window) setPercent((window.size ? 100 * window.start / window.size : 0).toFixed(1));
    if (text.current) { text.current.scrollTop = 0; text.current.scrollLeft = 0; }
  }, [window]);
  const changed = externalFileErrorCode(state.error) === 'file_changed' || /\bfile_changed\b/.test(String(state.error));
  const error = changed ? t('largeFileChanged') : externalId ? externalFileError(state.error, zh) : workbenchError(state.error, zh);
  const move = (action: 'start' | 'previous' | 'next' | 'end') => { if (window) void loader.load(windowOffset(window, action)); };
  const jump = () => {
    if (!percentEdited.current) return;
    percentEdited.current = false;
    if (window && percent.trim() && Number.isFinite(Number(percent))) void loader.load(percentOffset(window.size, Number(percent)));
  };
  const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
  const position = window ? `${mib(window.start)}–${mib(window.end)} MiB ${t('largeFileOf')} ${mib(window.size)} MiB` : state.busy ? t('loading') : '';
  return <section className="large-file-view" aria-label={t('largeFileReadOnly')} aria-busy={state.busy}
    data-window-start={window?.start} data-window-end={window?.end} data-file-size={window?.size} data-file-path={path} data-window-source={externalId ? 'external' : 'project'}>
    <div className="large-file-toolbar">
      <span className="large-file-readonly" title={path}>{t('largeFileReadOnly')}</span>
      {(['start', 'previous', 'next', 'end'] as const).map(action => {
        const label = { start: t('largeFileStart'), previous: t('largeFilePrevious'), next: t('largeFileNext'), end: t('largeFileEnd') }[action];
        return <button type="button" className="icon-btn icon-btn-sm large-file-nav" title={label} aria-label={label} data-testid={`large-file-${action}`} key={action}
          disabled={state.busy || !window || ((action === 'start' || action === 'previous') ? window.start === 0 : window.end >= window.size)}
          onClick={() => move(action)}>{action === 'previous' || action === 'next' ? <Icon name={action === 'previous' ? 'back' : 'chevR'} /> :
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={action === 'start' ? 'M5 5v14M18 6l-6 6 6 6' : 'M19 5v14M6 6l6 6-6 6'} /></svg>}</button>;
      })}
      <label className="large-file-jump" title={t('largeFilePosition')}><input type="number" min="0" max="100" step="0.1"
        aria-label={t('largeFilePosition')} data-testid="large-file-position" value={percent} disabled={state.busy || !window}
        onChange={event => { percentEdited.current = true; setPercent(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } }} onBlur={jump} />%</label>
      <span className="large-file-position" role="status" title={position}>{position}</span>
      <button type="button" className={state.error ? 'btn btn-sm' : 'icon-btn icon-btn-sm large-file-nav'} title={t('largeFileReload')} aria-label={t('largeFileReload')} data-testid="large-file-reload" disabled={state.busy} onClick={onReload}>{state.error ? t('largeFileReload') : <WbIcon name="refresh" />}</button>
    </div>
    {state.error !== undefined && <div className="tt-editor-state" role="alert">{error}</div>}
    {window && <>
      {window.startsMidLine && <span className="large-file-clipped" role="note">{t('largeFileClipped')} ↑</span>}
      <textarea key={`${window.changeToken}:${window.start}:${window.end}`} ref={text} className="large-file-content" data-testid="large-file-content" aria-label={t('largeFileText')} readOnly spellCheck={false} wrap="off" value={window.content} />
      {window.endsMidLine && <span className="large-file-clipped" role="note">{t('largeFileClipped')} ↓</span>}
    </>}
  </section>;
}
