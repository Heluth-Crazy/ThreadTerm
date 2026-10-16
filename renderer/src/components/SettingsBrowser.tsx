import { useEffect, useState } from 'react';
import { browserCommand, type BrowserPreferences } from '../bridge';
import { Select } from './ui/Select';

const defaults: BrowserPreferences = { unloadAfterMinutes: 10, linkTarget: 'builtin' };

export function SettingsBrowser({ zh }: { zh: boolean }) {
  const [preferences, setPreferences] = useState<BrowserPreferences>(defaults);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const text = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => {
    let live = true;
    void browserCommand({ type: 'preferences' }).then(value => { if (live) setPreferences(value); }).catch(error => { if (live) setIssue(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, []);
  const save = (patch: Partial<BrowserPreferences>) => {
    if (busy) return;
    setBusy(true); setIssue(undefined);
    void browserCommand({ type: 'preferences', patch }).then(value => setPreferences(value)).catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  const clear = () => {
    if (busy) return;
    setBusy(true); setIssue(undefined);
    void browserCommand({ type: 'clearData' }).catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  const minutes = Math.max(0, Math.floor(preferences.unloadAfterMinutes || 0));
  return <>
    <h3>{text('浏览器', 'Browser')}</h3>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('闲置页面卸载', 'Unload inactive pages')}</div><p>{text('隐藏的页面会在指定分钟数后卸载。设置为 0 可一直保留。', 'Hidden pages unload after this many minutes. Set 0 to keep them loaded.')}</p></div><label><span className="sr-only">{text('卸载分钟数', 'Unload after minutes')}</span><input type="number" min="0" step="1" value={minutes} disabled={busy} onChange={event => setPreferences(value => ({ ...value, unloadAfterMinutes: Math.max(0, Number(event.target.value) || 0) }))} onBlur={() => save({ unloadAfterMinutes: minutes })} /></label></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('链接打开位置', 'Open links in')}</div><p>{text('终端和聊天中的 HTTP(S) 链接默认在内置浏览器中打开。', 'HTTP(S) links from terminals and Chat open here by default.')}</p></div><Select value={preferences.linkTarget} disabled={busy} aria-label={text('链接打开位置', 'Open links in')} onChange={event => save({ linkTarget: event.target.value as BrowserPreferences['linkTarget'] })}><option value="builtin">{text('内置浏览器', 'Built-in browser')}</option><option value="system">{text('系统浏览器', 'System browser')}</option></Select></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('清除浏览数据', 'Clear browsing data')}</div><p>{text('清除内置浏览器的 Cookie、网站存储和缓存。', 'Clear cookies, site storage, and cache from the built-in browser profile.')}</p></div><button type="button" className="btn" disabled={busy} onClick={clear}>{text('清除数据', 'Clear data')}</button></div></div>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}
