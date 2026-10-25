import { useEffect, useRef, useState } from 'react';
import type { ChatItem, Session } from '@threadterm/protocol';
import { request } from '../bridge';
import { chatMarkdownExportBundle, type ChatExportMeta } from '../chatMarkdownExport';
import { loadAllChatPages } from '../chatPaging';
import { readUsageExport } from '../usageExport';
import { SurfaceDialog } from './SurfaceDialog';
type Props = { session: Session; copy: (en: string, zh: string) => string; onClose: () => void; items?: readonly ChatItem[]; meta?: ChatExportMeta; save?: (markdown: string) => Promise<string | null> };
export function ChatExportDialog({ session, copy, onClose, items, meta, save }: Props) {
  const [loaded, setLoaded] = useState(items), [includeThinking, setThinking] = useState(false), [busy, setBusy] = useState(false), [issue, setIssue] = useState('');
  const [usage, setUsage] = useState<ChatExportMeta['tokens']>(), [model, setModel] = useState<string>();
  const [usageReady, setUsageReady] = useState(items !== undefined);
  const generation = useRef(0), locked = useRef(false);
  useEffect(() => {
    const token = ++generation.current; setLoaded(items); setIssue(''); setUsageReady(items !== undefined); setUsage(undefined); setModel(undefined);
    if (!items) void loadAllChatPages(before => request('chat.snapshot', { sessionId: session.id, ...(before ? { before } : {}) })).then(all => { if (token === generation.current) setLoaded(all); }).catch(error => { if (token === generation.current) setIssue(String(error)); });
    if (!items) {
      const readUsage = readUsageExport(session, {
        ledgerSession: (provider, nativeSessionId) => request('usage.ledger.session', { filters: { scope: 'all', includeOutside: true }, provider, nativeSessionId }),
        legacySession: async sessionId => (await request('usage.query', { sessionId })).records,
      });
      void readUsage.then(next => {
        if (token !== generation.current) return;
        setModel(next.model); setUsage(next.tokens);
      }).catch(() => { /* Export remains available with explicitly unreported usage. */ }).finally(() => { if (token === generation.current) setUsageReady(true); });
    }
    return () => { generation.current++; };
  }, [items, session.id, session.nativeId, session.provider]);
  const close = () => { if (!locked.current) { generation.current++; onClose(); } };
  const exportMarkdown = async () => {
    if (!loaded || !usageReady || locked.current) return;
    locked.current = true; setBusy(true); setIssue(''); const token = generation.current;
    try {
      const locale = copy('en', 'zh-CN') as 'en' | 'zh-CN';
      const durations = new Map<string, number>();
      for (const item of loaded) if (item.elapsedMs !== undefined) durations.set(item.turnId ?? item.id, Math.max(durations.get(item.turnId ?? item.id) ?? 0, item.elapsedMs));
      const bundle = chatMarkdownExportBundle(loaded, { title: session.title, provider: session.provider, createdAt: session.createdAt, model, tokens: usage, durationMs: [...durations.values()].reduce((total, elapsed) => total + elapsed, 0) || undefined, ...meta, includeThinking, locale }, `__THREADTERM_CHAT_ASSETS_${crypto.randomUUID()}__`);
      await (save ? save(bundle.markdown) : window.threadterm.exportChatMarkdown?.({ title: session.title, ...bundle, locale }) ?? Promise.reject(new Error(copy('Markdown export is unavailable.', 'Markdown 导出不可用。'))));
      if (token === generation.current) onClose();
    } catch (error) { if (token === generation.current) setIssue(String(error)); }
    finally { locked.current = false; if (token === generation.current) setBusy(false); }
  };
  return <SurfaceDialog title={copy('Export as Markdown', '导出为 Markdown')} subtitle={session.title} onClose={close} size="sm" footer={<><button type="button" className="btn" disabled={busy} onClick={close}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-primary" disabled={busy || !loaded || !usageReady} onClick={() => void exportMarkdown()}>{busy ? copy('Saving…', '正在保存…') : copy('Save Markdown', '保存 Markdown')}</button></>}>
    {(!loaded || !usageReady) && !issue && <p role="status">{copy('Loading conversation…', '正在加载对话…')}</p>}
    <label><input type="checkbox" checked={includeThinking} disabled={busy} onChange={event => setThinking(event.target.checked)} /> {copy('Include thinking', '包含思考过程')}</label>
    <p className="note">{copy('Pasted images are saved in a companion folder and referenced from Markdown.', '粘贴的图片会保存到配套文件夹，并在 Markdown 中引用。')}</p>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </SurfaceDialog>;
}
