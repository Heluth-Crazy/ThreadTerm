import { useEffect, useState } from 'react';
import { browserCommand, browserHandoff, type BrowserPreferences } from '../bridge';
import { Select } from './ui/Select';
import type { Settings } from '@threadterm/protocol';

const defaults: BrowserPreferences = { unloadAfterMinutes: 10, linkTarget: 'builtin' };
const devServerPreferences = (patch?: { devServerOffers:boolean }) => browserHandoff({ type:'preferences', patch }).then(value => {
  if (!('devServerOffers' in value)) throw new Error('Invalid browser preferences response.');
  return value;
});

export function SettingsBrowser({ zh,settings,update }: { zh: boolean;settings?:Settings;update?:(patch:Record<string,unknown>)=>Promise<void> }) {
  const [preferences, setPreferences] = useState<BrowserPreferences>(defaults);
  const [devServerOffers, setDevServerOffers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const [evalBusy,setEvalBusy]=useState(false);
  const text = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => {
    let live = true;
    void browserCommand({ type: 'preferences' }).then(value => { if (live) setPreferences(value); }).catch(error => { if (live) setIssue(error instanceof Error ? error.message : String(error)); });
    void devServerPreferences().then(value => { if (live) setDevServerOffers(value.devServerOffers); }).catch(() => {});
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
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('浏览器页面代码执行','Browser page code execution')}</div><p>{text('默认关闭。开启后，具备支持能力的智能体可请求在已授权 Control 的页面中执行代码。每段确切代码仍需单独批准一次，且可能修改页面或产生外部影响。关闭会使待处理的代码审批失效。','Off by default. When enabled, supported agents can request code execution in pages already shared with Control. Each exact snippet still requires approval once and may change the page or have external effects. Turning this off invalidates pending code approvals.')}</p></div><label className="switch"><input type="checkbox" aria-label={text('允许请求浏览器页面代码执行','Allow browser page code requests')} checked={settings?.browserEvalEnabled===true} disabled={!settings||!update||evalBusy} onChange={event=>{if(!update||evalBusy)return;const enabled=event.target.checked;setEvalBusy(true);setIssue(undefined);void update({browserEvalEnabled:enabled}).catch(()=>setIssue(text('无法更新页面代码执行设置，请重试。','Could not update page code execution. Try again.'))).finally(()=>setEvalBusy(false));}}/><span>{text('开启','On')}</span></label></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('闲置页面卸载', 'Unload inactive pages')}</div><p>{text('隐藏的页面会在指定分钟数后卸载。设置为 0 可一直保留。', 'Hidden pages unload after this many minutes. Set 0 to keep them loaded.')}</p></div><label><span className="sr-only">{text('卸载分钟数', 'Unload after minutes')}</span><input type="number" min="0" step="1" value={minutes} disabled={busy} onChange={event => setPreferences(value => ({ ...value, unloadAfterMinutes: Math.max(0, Number(event.target.value) || 0) }))} onBlur={() => save({ unloadAfterMinutes: minutes })} /></label></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('链接打开位置', 'Open links in')}</div><p>{text('终端和聊天中的 HTTP(S) 链接默认在内置浏览器中打开。', 'HTTP(S) links from terminals and Chat open here by default.')}</p></div><Select value={preferences.linkTarget} disabled={busy} aria-label={text('链接打开位置', 'Open links in')} onChange={event => save({ linkTarget: event.target.value as BrowserPreferences['linkTarget'] })}><option value="builtin">{text('内置浏览器', 'Built-in browser')}</option><option value="system">{text('系统浏览器', 'System browser')}</option></Select></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('本地开发服务器提示', 'Local development server offers')}</div><p>{text('在终端输出本机开发服务器地址时显示可选的浏览器标签页操作。', 'Offer a browser-tab action when terminal output shows a loopback development server.')}</p></div><label className="switch"><input type="checkbox" aria-label={text('本地开发服务器提示', 'Local development server offers')} checked={devServerOffers} disabled={busy} onChange={event => { const enabled = event.target.checked; setBusy(true); setIssue(undefined); setDevServerOffers(enabled); void devServerPreferences({ devServerOffers:enabled }).then(value => setDevServerOffers(value.devServerOffers)).catch(error => { setDevServerOffers(!enabled); setIssue(error instanceof Error ? error.message : String(error)); }).finally(() => setBusy(false)); }} /><span>{text('开启', 'On')}</span></label></div></div>
    <div className="settings-card"><div className="settings-card-row"><div><div className="settings-card-title">{text('清除浏览数据', 'Clear browsing data')}</div><p>{text('清除内置浏览器的 Cookie、网站存储和缓存。', 'Clear cookies, site storage, and cache from the built-in browser profile.')}</p></div><button type="button" className="btn" disabled={busy} onClick={clear}>{text('清除数据', 'Clear data')}</button></div></div>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}
