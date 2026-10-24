import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browserCommand, openExternal } from '../bridge';
import { htmlPreview, onHtmlPreviewLink } from '../htmlPreviewBridge';
import { SessionSurfaceContext } from './SessionSurfaceContext';
import { PageCommentControls, type usePageCommentPreview } from './PageComments';
import './sandboxed-html-preview.css';

type Preview = ReturnType<typeof usePageCommentPreview>;

export function SandboxedHtmlPreview({ projectId, worktreePath, path, savedContent, reload, onReload, preview, zh, onIssue }: {
  projectId: string;
  worktreePath?: string;
  path: string;
  savedContent: string;
  reload: number;
  onReload: () => void;
  preview: Preview;
  zh: boolean;
  onIssue: (message?: string) => void;
}) {
  const surface = useContext(SessionSurfaceContext);
  const [remote, setRemote] = useState(false);
  const [grant, setGrant] = useState<{ id: string; url: string }>();
  const [pendingLink, setPendingLink] = useState<{ grantId: string; url: string }>();
  const [compactStatus, setCompactStatus] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const displayedGrant = useRef<string | undefined>(undefined);
  const pendingGrant = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let resultId: string | undefined;
    setGrant(undefined);
    setPendingLink(undefined);
    onIssue(undefined);
    void htmlPreview({ type: 'grant', projectId, worktreePath, path, frameName: preview.frameName, remote }).then(result => {
      if (!result) throw new Error('The desktop application did not create an HTML preview grant.');
      if (!active) {
        void htmlPreview({ type: 'revoke', id: result.id }).catch(() => undefined);
        return;
      }
      resultId = result.id;
      // State updates may be abandoned before React commits the iframe. Keep this grant revocable in that gap.
      pendingGrant.current = result.id;
      setGrant({ id: result.id, url: `${result.url}${result.url.includes('?') ? '&' : '?'}reload=${reload}` });
    }).catch(error => {
      if (active) {
        const message = error instanceof Error ? error.message : String(error);
        onIssue(!zh ? message : message === 'Sandboxed HTML previews require the desktop application.' ? '沙箱 HTML 预览需要桌面应用程序。' : message === 'The HTML preview safety preload is unavailable. Rebuild the desktop application.' ? 'HTML 预览安全组件不可用。请重新构建桌面应用程序。' : '无法打开沙箱 HTML 预览。请确认项目和文件可访问，然后重新加载。');
      }
    });
    return () => {
      active = false;
      if (resultId && pendingGrant.current === resultId) {
        pendingGrant.current = undefined;
        void htmlPreview({ type: 'revoke', id: resultId }).catch(() => undefined);
      }
    };
  }, [projectId, worktreePath, path, savedContent, preview.frameName, remote, reload, onIssue]);

  useLayoutEffect(() => {
    const previous = displayedGrant.current;
    displayedGrant.current = grant?.id;
    if (pendingGrant.current === grant?.id) pendingGrant.current = undefined;
    // This runs after React has committed the keyed iframe replacement, so its old grant no longer has a frame.
    if (previous && previous !== grant?.id) void htmlPreview({ type: 'revoke', id: previous }).catch(() => undefined);
  }, [grant?.id]);

  useEffect(() => () => {
    const id = displayedGrant.current;
    if (id) void htmlPreview({ type: 'revoke', id }).catch(() => undefined);
  }, []);

  useEffect(() => onHtmlPreviewLink(({ frameName, grantId, url }) => {
    if (frameName !== preview.frameName || grantId !== displayedGrant.current) return;
    // Preserve the exact URL the user sees until they explicitly choose Open or Dismiss.
    setPendingLink(current => current ?? { grantId, url });
  }), [preview.frameName]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const update = () => {
      const style = getComputedStyle(element);
      const controls = [...element.querySelectorAll<HTMLButtonElement>('button')];
      const controlWidth = controls.reduce((total, control) => total + control.getBoundingClientRect().width, 0);
      // Always use the expanded gap so the compact layout cannot toggle itself at the threshold.
      const gap = 6;
      const padding = (Number.parseFloat(style.paddingInlineStart) || 0) + (Number.parseFloat(style.paddingInlineEnd) || 0);
      const remaining = element.clientWidth - padding - controlWidth - gap * controls.length;
      setCompactStatus(current => current === (remaining < 60) ? current : remaining < 60);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [remote, preview.picking, zh]);

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
  const status = remote ? text('Sandboxed preview · remote content allowed', '沙箱预览 · 已允许远程内容') : text('Sandboxed preview · remote content blocked', '沙箱预览 · 已阻止远程内容');
  const pendingHost = pendingLink ? (() => { try { return new URL(pendingLink.url).host; } catch { return pendingLink.url; } })() : '';
  const changeRemote = () => {
    // Remove the old frame in this render so a blocked status never accompanies an enabled remote frame.
    setGrant(undefined);
    setPendingLink(undefined);
    setRemote(value => !value);
  };
  return <div className="sandboxed-html-preview">
    <div ref={toolbar} className={`sandboxed-html-preview-toolbar${compactStatus ? ' is-compact' : ''}`} role="toolbar" title={preview.picking ? text('Click an element or drag an area · ↑ parent · Esc cancels', '点击元素或拖动选择区域 · ↑ 选择父级 · Esc 取消') : undefined} aria-label={text('Sandboxed HTML preview controls', '沙箱 HTML 预览控件')}>
      <span className={`sandboxed-html-preview-status${compactStatus ? ' is-compact' : ''}`} role="status" title={status}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13 3v3.8c0 3.3-2.1 6.2-5 7.7-2.9-1.5-5-4.4-5-7.7V3l5-1.5Zm0 4a1.5 1.5 0 0 0-1.5 1.5v2h3v-2A1.5 1.5 0 0 0 8 5.5Zm-2.5 3.2v2.5h5V8.7h-5Z" /></svg><span>{status}</span></span>
      <button type="button" className="btn btn-sm" aria-pressed={remote} title={text('The page can then load and send data over the internet. This resets when the preview closes.', '页面随后可通过互联网加载和发送数据。关闭预览后会重置。')} onClick={changeRemote}>{remote ? text('Block remote content', '阻止远程内容') : text('Allow remote content', '允许远程内容')}</button>
      <button type="button" className="btn btn-sm" onClick={onReload}>{text('Reload', '重新加载')}</button>
      <PageCommentControls preview={preview} zh={zh} hint={false} />
    </div>
    {pendingLink && <div className="sandboxed-html-preview-link" role="status"><span title={pendingLink.url}>{zh ? `打开 ${pendingHost}？` : `Open ${pendingHost}?`}</span><button type="button" className="btn btn-sm" title={pendingLink.url} onClick={openPendingLink}>{text('Open link', '打开链接')}</button><button type="button" className="btn btn-sm" onClick={() => setPendingLink(undefined)}>{text('Dismiss', '关闭')}</button></div>}
    {grant && <iframe key={grant.id} ref={preview.iframe} name={preview.frameName} className="tt-preview-frame" title={text('Saved HTML preview', '已保存的 HTML 预览')} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" allow="" src={grant.url} onLoad={() => { if (preview.pick || preview.picking) preview.cancel(); }} />}
  </div>;
}
