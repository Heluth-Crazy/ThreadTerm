/**
 * Settings › Agents (智能体): one line per agent, at most one primary button, everything else in ⋯ or the
 * expanded row (design: .trellis/tasks/11-12-agents-settings-astryx/design.md). Built with Astryx components inside
 * .astryx-scope; provider icons are the session-list AgentTile (owner rule). Lazy-loaded with its Astryx chunk.
 */
import './astryx-reset-scope.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './astryx-scope.css';
import './agents-settings.css';
import { useEffect, useRef, useState } from 'react';
import type { ProviderCapability, Session, Snapshot } from '@threadterm/protocol';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Item } from '@astryxdesign/core/Item';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { chooseDirectory, openExternal, operationId, request, subscribeEvents } from '../bridge';
import { IDLE_PROVIDER_REFRESH, observeProviderRefresh, providerRefreshText, type ProviderRefreshHandle, type ProviderRefreshState } from '../providerRefresh';
import { isRemoteFiles } from '../remoteFiles';
import { userErrorText } from '../runtimeError';
import { AgentTile } from './PrototypeIcon';
import { accountProviders, signInTerminal } from './providerSettings';

export type AgentRowState = 'missing' | 'signed-in' | 'signed-out' | 'unknown';

/** What a row shows: its state and its one primary action. Pure, for tests. */
export function agentRow(capability: ProviderCapability, remote = isRemoteFiles()): { state: AgentRowState; primary?: 'signIn' | 'homepage' } {
  if (!capability.installed) return { state: 'missing', primary: capability.homepage ? 'homepage' : undefined };
  if (capability.auth === 'authenticated') return { state: 'signed-in' };
  if (capability.auth === 'unauthenticated') return { state: 'signed-out', primary: signInTerminal(capability, remote) ? 'signIn' : undefined };
  return { state: 'unknown' };
}

function useThemeMode(): 'light' | 'dark' {
  const read = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const [mode, setMode] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

export default function AgentsSettings({ data, zh, onSignInSession }: {
  data: Snapshot;
  zh: boolean;
  onSignInSession: (session: Session) => void | Promise<void>;
}) {
  const text = (en: string, cn: string) => zh ? cn : en;
  const refreshCopy = providerRefreshText(zh ? 'zh-CN' : 'en');
  const mode = useThemeMode();
  // Astryx's root Theme owns <html data-theme> while mounted and removes it when it unmounts; ThreadTerm owns that
  // attribute (its themes select on it), so put it back after both cleanups have run.
  const modeRef = useRef(mode); modeRef.current = mode;
  useEffect(() => () => {
    const root = document.documentElement, saved = modeRef.current;
    queueMicrotask(() => { if (!root.dataset.theme) root.dataset.theme = saved; });
  }, []);
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>(data.providers);
  const [refreshState, setRefreshState] = useState<ProviderRefreshState>(IDLE_PROVIDER_REFRESH);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const handle = useRef<ProviderRefreshHandle | undefined>(undefined);
  const autoChecked = useRef<ProviderCapability[] | undefined>(undefined);
  // An empty snapshot means detection is still running or failed: read the cache once per snapshot reference, as the
  // old accounts panel did, and keep the failure visible without replacing the app with a runtime error.
  useEffect(() => {
    setCapabilities(data.providers);
    if (data.providers.length) { autoChecked.current = data.providers; setDetectionFailed(false); return; }
    if (autoChecked.current === data.providers) return;
    autoChecked.current = data.providers;
    let cancelled = false;
    void request('provider.list', {}).then(next => {
      if (cancelled) return;
      setCapabilities(next);
      setDetectionFailed(false);
    }).catch(() => { if (!cancelled) setDetectionFailed(true); });
    return () => { cancelled = true; };
  }, [data.providers]);
  useEffect(() => {
    const next = observeProviderRefresh(() => request('provider.refresh', {}), subscribeEvents, setRefreshState);
    handle.current = next;
    return () => { if (handle.current === next) handle.current = undefined; next.dispose(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (refreshState.phase !== 'updated') return;
    const timer = setTimeout(() => setRefreshState(current => current.phase === 'updated' ? IDLE_PROVIDER_REFRESH : current), 4000);
    return () => clearTimeout(timer);
  }, [refreshState.phase]);
  const checking = refreshState.phase === 'checking' || refreshState.phase === 'timeout';
  const rows = accountProviders(capabilities).map(capability => ({ capability, ...agentRow(capability) }));
  const count = (state: AgentRowState) => rows.filter(row => row.state === state).length;
  const ready = count('signed-in') + count('unknown'), signedOut = count('signed-out'), missing = count('missing');

  const signIn = async (capability: ProviderCapability) => {
    const command = signInTerminal(capability);
    if (!command || busy) return;
    setBusy(capability.id); setIssue(undefined); setNotice(undefined);
    try {
      const project = data.projects[0];
      const cwd = project?.path ?? await chooseDirectory();
      if (!cwd) return;
      const session = await request('session.create', { cwd, projectId: project?.id, title: `${capability.name} ${text('sign-in', '登录')}`, provider: command.provider, mode: 'terminal', executable: command.executable, args: [...command.args], operationId: operationId() });
      await onSignInSession(session);
      setNotice(text(`${capability.name} sign-in terminal opened. Finish signing in there, then choose Check.`, `已打开 ${capability.name} 登录终端。在终端里完成登录后，点"检查"。`));
    } catch (error) {
      setIssue(userErrorText(error, text('This agent action could not be completed.', '无法完成这个智能体操作。'), zh));
    } finally { setBusy(undefined); }
  };
  const stateLabel = (state: AgentRowState) => ({ missing: text('Not installed', '未安装'), 'signed-in': text('Signed in', '已登录'), 'signed-out': text('Not signed in', '未登录'), unknown: text('Sign-in status unknown', '登录状态未知') })[state];
  const dot = (state: AgentRowState) => ({ missing: 'neutral', 'signed-in': 'success', 'signed-out': 'warning', unknown: 'neutral' } as const)[state];

  return <Theme theme={neutralTheme} mode={mode}>
    <section className="astryx-scope agents-settings" data-testid="agents-settings" aria-label={text('Agents', '智能体')}>
      <div className="agents-head">
        <div>
          <div className="agents-title">{text('Agents', '智能体')}</div>
          <div className="agents-summary" aria-live="polite">{[
            text(`${ready} ready`, `${ready} 个可用`),
            signedOut ? text(`${signedOut} need sign-in`, `${signedOut} 个需要登录`) : '',
            missing ? text(`${missing} not installed`, `${missing} 个未安装`) : '',
          ].filter(Boolean).join(' · ')}</div>
        </div>
        <span data-testid="agents-check"><Button label={checking ? refreshCopy.checking : text('Check', '检查')} variant="secondary" size="sm" isDisabled={checking} aria-busy={checking}
          onClick={() => { setIssue(undefined); void handle.current?.refresh().catch(error => setIssue(userErrorText(error, refreshCopy.failed, zh))); }} /></span>
      </div>
      {!rows.length && !detectionFailed && <div className="agents-note" role="status">{text('Detecting agents…', '正在检测智能体…')}</div>}
      {detectionFailed && <div className="surface-error" role="alert">{text('Agent detection failed. Choose Check to try again.', '智能体检测失败。点“检查”重试。')}</div>}
      <div className="agents-list" role="list" aria-label={text('Agents', '智能体')}>
        {rows.map(({ capability, state, primary }) => {
          const command = capability.installed ? signInTerminal(capability) : undefined;
          const expanded = open === capability.id;
          // Google's sign-in needs a browser on the host; the old accounts panel said so for the bundled Gemini plugin.
          const googleNote = capability.id === 'gemini' && capability.source === 'plugin' && isRemoteFiles();
          const menu: DropdownMenuOption[] = [
            ...(command ? [{ label: state === 'signed-in' ? text('Sign in again', '重新登录') : text('Sign in', '登录'), onClick: () => void signIn(capability) }] : []),
            ...(capability.signIn ? [{ label: text('Copy sign-in command', '复制登录命令'), onClick: () => void navigator.clipboard?.writeText(capability.signIn!.display) }] : []),
            ...(capability.homepage ? [{ label: text('Open homepage', '打开主页'), onClick: () => void openExternal(capability.homepage!) }] : []),
            { label: expanded ? text('Hide details', '收起详情') : text('Details', '详情'), onClick: () => setOpen(expanded ? undefined : capability.id) },
          ];
          return <div className={`agents-row${expanded ? ' is-open' : ''}`} role="listitem" key={capability.id} data-agent-row={capability.id} data-agent-state={state}>
            <div className="agents-row-line" onClick={() => setOpen(expanded ? undefined : capability.id)}>
            <Item layout="inline" startContent={<AgentTile provider={capability.id} size={22} />} label={capability.name}
              description={capability.installed ? capability.version : undefined}
              endContent={<span className="agents-row-end" onClick={event => event.stopPropagation()}>
                <span className={`agents-state is-${state}`} title={state === 'unknown' ? text(`ThreadTerm cannot read ${capability.name}'s sign-in status. If it works, nothing to do.`, `ThreadTerm 读不到 ${capability.name} 的登录状态。用起来正常就不用管。`) : undefined}>
                  <StatusDot variant={dot(state)} label={stateLabel(state)} />{stateLabel(state)}</span>
                {primary === 'signIn' && <span data-testid={`agent-sign-in-${capability.id}`}><Button label={busy === capability.id ? text('Opening…', '正在打开…') : text('Sign in', '登录')} variant="primary" size="sm" isDisabled={Boolean(busy)} onClick={() => void signIn(capability)} /></span>}
                {primary === 'homepage' && <span data-testid={`agent-install-${capability.id}`}><Button label={text('How to install', '安装说明')} variant="secondary" size="sm" onClick={() => void openExternal(capability.homepage!)} /></span>}
                <DropdownMenu items={menu} hasChevron={false} placement="below" alignment="end" button={{ label: text(`${capability.name} actions`, `${capability.name} 的更多操作`), variant: 'ghost', size: 'sm', children: '⋯' }} />
              </span>} />
            </div>
            {googleNote && <div className="agents-note agents-row-note">{text('Google sign-in can’t run in ThreadTerm’s browser. Use an API key, or sign in on that computer.', 'Google 登录无法在 ThreadTerm 浏览器中完成。请使用 API 密钥，或在那台电脑上登录。')}</div>}
            {expanded && <dl className="agents-detail">
              {capability.signIn && <><dt>{text('Sign-in command', '登录命令')}</dt><dd><code>{capability.signIn.display}</code></dd></>}
              {capability.reason && <><dt>{text('Note', '说明')}</dt><dd>{capability.reason}</dd></>}
              {capability.source === 'plugin' && <><dt>{text('Source', '来源')}</dt><dd>{text(`Plugin ${capability.pluginId ?? ''}`, `插件 ${capability.pluginId ?? ''}`)}</dd></>}
              <dt>{text('Works in', '可用于')}</dt><dd>{[capability.chat && text('Chat', '聊天'), capability.terminal && text('Terminal', '终端')].filter(Boolean).join(' · ') || '—'}</dd>
            </dl>}
          </div>;
        })}
      </div>
      {refreshState.phase === 'updated' && <div className="agents-note" role="status">{refreshCopy.updated}</div>}
      {refreshState.phase === 'failed' && <div className="agents-note" role="status">{refreshCopy.failed}</div>}
      {refreshState.phase === 'timeout' && <div className="agents-note" role="status">{refreshCopy.timeout}</div>}
      {notice && <div className="agents-note" role="status" aria-live="polite">{notice}</div>}
      {issue && <div className="surface-error" role="alert">{issue}</div>}
    </section>
  </Theme>;
}
