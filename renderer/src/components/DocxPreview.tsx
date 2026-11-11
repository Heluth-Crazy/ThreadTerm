import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browserCommand, openExternal, request } from '../bridge';
import { externalDocumentError, externalFileErrorCode } from '../externalFiles';
import { htmlPreview, onHtmlPreviewLink } from '../htmlPreviewBridge';
import { useThemeState } from '../themes';
import { SessionSurfaceContext } from './SessionSurfaceContext';
import './sandboxed-html-preview.css';

/** R5: a tab hidden this long releases its document grant and frame. */
const HIDDEN_RELEASE_MS = 5 * 60 * 1000;

/** Word preview (`design.md` §4.4): a document grant streamed into the sandboxed viewer.
 * No remote-content switch and no page comments; the frame has scripts only and no origin
 * token. The link row is the same explicit proposal the saved-HTML preview uses. */
export function DocxPreview({ projectId, worktreePath, path, externalId, zh, active, onIssue, onExternalChange }: {
  projectId: string;
  worktreePath?: string;
  path: string;
  externalId?: string;
  zh: boolean;
  active?: boolean;
  onIssue: (message?: string) => void;
  onExternalChange?: (file: { externalId: string; path: string }) => void;
}) {
  const surface = useContext(SessionSurfaceContext);
  const { theme } = useThemeState();
  const frameName = useRef(`tt-preview-doc-${crypto.randomUUID().replace(/[^a-z0-9]/g, '')}`).current;
  const iframe = useRef<HTMLIFrameElement>(null);
  const [grant, setGrant] = useState<{ id: string; url: string }>();
  const [pendingLink, setPendingLink] = useState<{ grantId: string; url: string }>();
  const [viewerState, setViewerState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [released, setReleased] = useState(false);
  const displayedGrant = useRef<string | undefined>(undefined);
  const pendingGrant = useRef<string | undefined>(undefined);
  const reportIssue = useRef(onIssue);
  reportIssue.current = onIssue;
  const externalChange = useRef(onExternalChange);
  externalChange.current = onExternalChange;

  useEffect(() => {
    if (active !== false) return;
    const timer = setTimeout(() => setReleased(true), HIDDEN_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [active]);
  useEffect(() => {
    if (active !== false && released) setReleased(false);
  }, [active, released]);

  useEffect(() => {
    if (released) {
      setGrant(undefined);
      setPendingLink(undefined);
      return;
    }
    let live = true;
    let resultId: string | undefined;
    setGrant(undefined);
    setPendingLink(undefined);
    setViewerState('loading');
    reportIssue.current(undefined);
    const ask = (id?: string) => htmlPreview(id
      ? { type: 'grantDocument', externalId: id, frameName }
      : { type: 'grantDocument', projectId, worktreePath, path, frameName });
    const open = async (): Promise<{ id: string; url: string } | undefined> => {
      try {
        return (await ask(externalId)) ?? undefined;
      } catch (error) {
        if (!externalId || externalFileErrorCode(error) !== 'external_file_unknown') throw error;
        // A forgotten registration reopens once by its stored path, as the text and sheet views do.
        const reopened = await request('filesystem.external.open', { path, source: 'recent' });
        if (!('file' in reopened)) throw error;
        externalChange.current?.({ externalId: reopened.file.id, path: reopened.file.path });
        return (await ask(reopened.file.id)) ?? undefined;
      }
    };
    void open().then(result => {
      if (!result) throw new Error('The desktop application did not create a document preview grant.');
      if (!live) {
        void htmlPreview({ type: 'revoke', id: result.id }).catch(() => undefined);
        return;
      }
      resultId = result.id;
      // State updates may be abandoned before React commits the iframe. Keep this grant revocable in that gap.
      pendingGrant.current = result.id;
      const query = `theme=${theme === 'dark' ? 'dark' : 'light'}&lang=${zh ? 'zh' : 'en'}`;
      setGrant({ id: result.id, url: `${result.url}${result.url.includes('?') ? '&' : '?'}${query}` });
    }).catch(error => {
      if (live) {
        setViewerState('error');
        reportIssue.current(externalDocumentError(error, zh));
      }
    });
    return () => {
      live = false;
      if (resultId && pendingGrant.current === resultId) {
        pendingGrant.current = undefined;
        void htmlPreview({ type: 'revoke', id: resultId }).catch(() => undefined);
      }
    };
  }, [projectId, worktreePath, path, externalId, frameName, theme, zh, released]);

  useLayoutEffect(() => {
    const previous = displayedGrant.current;
    displayedGrant.current = grant?.id;
    if (pendingGrant.current === grant?.id) pendingGrant.current = undefined;
    // After React commits the keyed iframe replacement, the old grant no longer has a frame.
    if (previous && previous !== grant?.id) void htmlPreview({ type: 'revoke', id: previous }).catch(() => undefined);
  }, [grant?.id]);

  useEffect(() => () => {
    const id = displayedGrant.current;
    if (id) void htmlPreview({ type: 'revoke', id }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const target = iframe.current?.contentWindow;
      if (!target || event.source !== target || !event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: unknown; state?: unknown };
      if (data.type !== 'tt-doc-viewer' || (data.state !== 'ready' && data.state !== 'error')) return;
      // An untrusted hint for the loading indicator only; a failure gets the damaged-file line.
      setViewerState(data.state);
      if (data.state === 'error') reportIssue.current(zh ? '无法读取此文件，它可能已损坏。' : 'Cannot read this file; it may be damaged.');
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [zh]);

  useEffect(() => onHtmlPreviewLink(({ frameName: from, grantId, url }) => {
    if (from !== frameName || grantId !== displayedGrant.current) return;
    // Preserve the exact URL the user sees until they explicitly choose Open or Dismiss.
    setPendingLink(current => current ?? { grantId, url });
  }), [frameName]);

  const openPendingLink = () => {
    if (!pendingLink || pendingLink.grantId !== displayedGrant.current) return;
    const url = pendingLink.url;
    setPendingLink(undefined);
    void browserCommand({ type: 'preferences' }).then(preferences => {
      if (preferences && 'linkTarget' in preferences && preferences.linkTarget === 'builtin' && surface?.openWeb) {
        surface.openWeb(url);
        return;
      }
      return openExternal(url);
    }).catch(error => onIssue(zh ? '无法打开链接。请检查浏览器设置后重试。' : error instanceof Error ? error.message : String(error)));
  };

  const text = (en: string, cn: string) => zh ? cn : en;
  // Only a loading document needs the status row: a ready one is its pages, and a failed one gets
  // the reason and "Open with system app" in the file view's issue line (one action, not two).
  const status = viewerState === 'loading' ? text('Loading document…', '正在加载文档…') : undefined;
  const pendingHost = pendingLink ? (() => { try { return new URL(pendingLink.url).host; } catch { return pendingLink.url; } })() : '';
  return <div className="sandboxed-html-preview">
    {status && <div className="sandboxed-html-preview-toolbar" role="toolbar" aria-label={text('Document preview controls', '文档预览控件')}>
      <span className="sandboxed-html-preview-status" role="status" title={status}><span>{status}</span></span>

    </div>}
    {pendingLink && <div className="sandboxed-html-preview-link" role="status"><span title={pendingLink.url}>{zh ? `打开 ${pendingHost}？` : `Open ${pendingHost}?`}</span><button type="button" className="btn btn-sm" title={pendingLink.url} onClick={openPendingLink}>{text('Open link', '打开链接')}</button><button type="button" className="btn btn-sm" onClick={() => setPendingLink(undefined)}>{text('Dismiss', '关闭')}</button></div>}
    {grant && <iframe key={grant.id} ref={iframe} name={frameName} className="tt-preview-frame" title={text('Word document preview', 'Word 文档预览')} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" src={grant.url} />}
  </div>;
}
