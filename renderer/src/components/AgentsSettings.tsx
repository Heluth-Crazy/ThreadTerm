/**
 * Settings › Agents (智能体): one line per agent, at most one primary button, everything else in ⋯ or the
 * expanded row (design: .trellis/tasks/11-12-agents-settings-astryx/design.md). Built with Astryx components inside
 * .astryx-scope; provider icons are the session-list AgentTile (owner rule).
 *
 * Install, update and "install Node.js" run the runtime's command verbatim in a background terminal: the renderer
 * never builds or edits a command line, and nothing runs before the confirm popover shows it.
 */
import './astryx-reset-scope.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './astryx-scope.css';
import './agents-settings.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderCapability, ProviderCommand, Session, Snapshot } from '@threadterm/protocol';
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

export type AgentRowState = 'missing' | 'node-missing' | 'installing' | 'install-failed' | 'signed-in' | 'signed-out' | 'unknown';
export type AgentPrimary = 'install' | 'node' | 'homepage' | 'signIn';
/** Which command the row is running: install, update, or getting Node.js first. */
export type InstallKind = 'install' | 'update' | 'node';
/** A background run this row is watching. `exitCode` is undefined while it runs. */
export type InstallRun = { kind: InstallKind; sessionId: string; exitCode?: number };

/** The command a run of this kind executes, when the capability still offers it (the retry needs it). */
export function runCommand(capability: ProviderCapability, kind: InstallKind): ProviderCommand | undefined {
  return kind === 'node' ? capability.nodeInstall : kind === 'update' ? capability.update : capability.install;
}

/** The retry action after a failed install or Node.js run: only when that command can be offered again. */
function retryPrimary(capability: ProviderCapability, kind: InstallKind): AgentPrimary | undefined {
  if (kind === 'node') return capability.nodeInstall ? 'node' : undefined;
  return capability.install ? 'install' : undefined;
}

/**
 * True when a finished run is no longer needed, because the capability shows what it was for: the agent is
 * installed (install), npm is found (Node.js), or the update exited 0. A failed install also settles when the
 * agent was installed some other way and Check found it. A failed update never settles by itself: the
 * capability cannot show it, so the row offers Retry and Dismiss. A run still in flight never settles.
 */
export function runSettled(capability: ProviderCapability | undefined, run: InstallRun): boolean {
  if (run.exitCode === undefined || !capability) return false;
  if (run.kind === 'update') return run.exitCode === 0;
  if (run.kind === 'node') return capability.installed || capability.installBlocked !== 'node_missing';
  return capability.installed;
}

/**
 * What a row shows: its state and its one primary action. Pure, for tests. A run in flight wins over
 * everything; a finished install or Node.js run only wins while it failed, because a successful one turns the
 * row into whatever the refreshed capability now says. A failed update leaves the row's own state (the agent
 * still works); its failure line is drawn below the row.
 */
export function agentRow(capability: ProviderCapability, options: { remote?: boolean; run?: InstallRun } = {}): { state: AgentRowState; primary?: AgentPrimary } {
  const remote = options.remote ?? isRemoteFiles();
  const run = options.run;
  if (run && run.exitCode === undefined) return { state: 'installing' };
  // A run that exited 0 keeps the row in progress until the refreshed capability arrives.
  if (run && run.exitCode === 0) return { state: 'installing' };
  if (run && run.exitCode !== undefined && run.kind !== 'update') {
    const primary = retryPrimary(capability, run.kind);
    return primary ? { state: 'install-failed', primary } : { state: 'install-failed' };
  }
  if (!capability.installed) {
    if (capability.installBlocked === 'node_missing' && capability.nodeInstall) return { state: 'node-missing', primary: 'node' };
    if (capability.install) return { state: 'missing', primary: 'install' };
    return { state: 'missing', ...(capability.homepage ? { primary: 'homepage' as const } : {}) };
  }
  if (capability.auth === 'authenticated') return { state: 'signed-in' };
  if (capability.auth === 'unauthenticated') return { state: 'signed-out', primary: signInTerminal(capability, remote) ? 'signIn' : undefined };
  return { state: 'unknown' };
}

/** Where a run is remembered: per computer and agent, so closing and reopening Settings keeps the state. */
export function installRunKey(agentId: string, machine = typeof window === 'undefined' ? 'local' : (window.threadterm as { machineId?: string })?.machineId ?? 'local'): string {
  return `threadterm.agents.install.${machine}.${agentId}`;
}

function readRun(agentId: string): InstallRun | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(installRunKey(agentId)) ?? 'null') as InstallRun | null;
    return value && typeof value.sessionId === 'string' && ['install', 'update', 'node'].includes(value.kind) ? value : undefined;
  } catch { return undefined; }
}
function writeRun(agentId: string, run: InstallRun | undefined) {
  try {
    if (run) localStorage.setItem(installRunKey(agentId), JSON.stringify(run));
    else localStorage.removeItem(installRunKey(agentId));
  } catch { /* private mode: the row still works, it just forgets across openings. */ }
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

/** The one confirm popover for 安装 / 更新 / 安装 Node.js: the exact command, one sentence, 运行 + 取消. */
function ConfirmInstall({ anchor, title, command, note, warning, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  anchor: HTMLElement;
  title: string;
  command: string;
  note: string;
  warning?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const width = 340;
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    const height = panel.current?.offsetHeight ?? 150;
    // Below the button, or above it when the viewport has no room left.
    const top = box.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : box.bottom + 6;
    setPosition({ top, left });
    panel.current?.querySelector<HTMLElement>('[data-confirm-run]')?.focus();
  }, [anchor]);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof MouseEvent && panel.current?.contains(event.target as Node)) return;
      if (event instanceof MouseEvent && anchor.contains(event.target as Node)) return;
      onCancel();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } };
    // Capture phase: the drawer closes on Escape, and this popover is one step closer than the drawer.
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', key, true); };
  }, [anchor, onCancel]);
  return createPortal(<div ref={panel} className="astryx-scope agents-confirm" role="dialog" aria-modal="false" aria-label={title}
    data-testid="agents-confirm" style={position ? { top: position.top, left: position.left } : { visibility: 'hidden', top: 0, left: 0 }}>
    <div className="agents-confirm-title">{title}</div>
    <code className="agents-confirm-command" data-testid="agents-confirm-command">{command}</code>
    <div className="agents-confirm-note">{note}</div>
    {warning && <div className="agents-confirm-warning">{warning}</div>}
    <div className="agents-confirm-foot">
      <Button label={cancelLabel} variant="ghost" size="sm" onClick={onCancel} />
      <span data-confirm-run="true"><Button label={confirmLabel} variant="primary" size="sm" onClick={onConfirm} /></span>
    </div>
  </div>, document.body);
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
  const [runs, setRuns] = useState<Record<string, InstallRun>>({});
  const [confirm, setConfirm] = useState<{ agentId: string; kind: InstallKind; anchor: HTMLElement }>();
  const handle = useRef<ProviderRefreshHandle | undefined>(undefined);
  const autoChecked = useRef<ProviderCapability[] | undefined>(undefined);
  const archived = useRef(new Set<string>());
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

  // A run is remembered per computer and agent, so reopening Settings shows the same progress or failure.
  useEffect(() => {
    const restored: Record<string, InstallRun> = {};
    for (const capability of data.providers) {
      const run = readRun(capability.id);
      if (run) restored[capability.id] = run;
    }
    if (Object.keys(restored).length) setRuns(current => ({ ...restored, ...current }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setRun = useCallback((agentId: string, run: InstallRun | undefined) => {
    writeRun(agentId, run);
    setRuns(current => {
      const next = { ...current };
      if (run) next[agentId] = run; else delete next[agentId];
      return next;
    });
  }, []);

  const finish = useCallback(async (agentId: string, run: InstallRun, session: Session) => {
    if (run.exitCode !== 0) return;
    // Success: refresh provider status (the row then becomes what the new capability says) and archive the terminal
    // that has done its job. Exactly once per session, even when the snapshot updates again before the row changes.
    if (!archived.current.has(run.sessionId)) {
      archived.current.add(run.sessionId);
      void handle.current?.refresh().catch(() => undefined);
      void request('session.organize', { sessionId: run.sessionId, archived: true, expectedRevision: session.organizationRevision ?? 0, operationId: operationId() }).catch(() => undefined);
    }
    // A safety net for an older runtime whose refresh never lands.
    setTimeout(() => setRuns(current => {
      if (current[agentId]?.sessionId !== run.sessionId || current[agentId]?.exitCode !== 0) return current;
      writeRun(agentId, undefined);
      const next = { ...current }; delete next[agentId]; return next;
    }), 10_000);
  }, []);

  // Watch each remembered run through the snapshot: terminal exit is what decides success or the failure line.
  useEffect(() => {
    if (!Object.keys(runs).length) return;
    for (const [agentId, run] of Object.entries(runs)) {
      const session = data.sessions.find(candidate => candidate.id === run.sessionId);
      if (!session) continue;
      if (typeof session.exitCode === 'number' && session.exitCode !== run.exitCode) {
        setRun(agentId, { ...run, exitCode: session.exitCode });
        void finish(agentId, { ...run, exitCode: session.exitCode }, session);
      }
    }
  }, [data.sessions, runs, finish, setRun]);
  // The refreshed capability shows the run's goal reached (also after a failure fixed some other way): drop the run.
  useEffect(() => {
    for (const [agentId, run] of Object.entries(runs)) {
      if (runSettled(capabilities.find(candidate => candidate.id === agentId), run)) setRun(agentId, undefined);
    }
  }, [capabilities, runs, setRun]);

  const rows = accountProviders(capabilities).map(capability => ({ capability, ...agentRow(capability, { run: runs[capability.id] }) }));
  const count = (state: AgentRowState) => rows.filter(row => row.state === state).length;
  const ready = count('signed-in') + count('unknown'), signedOut = count('signed-out'), missing = count('missing') + count('node-missing');
  const installing = count('installing'), failed = count('install-failed');

  const announce = (message: string) => { setIssue(undefined); setNotice(message); };
  const fail = (error: unknown, fallback: string) => setIssue(userErrorText(error, fallback, zh));

  const present = async (run: InstallRun) => {
    const session = data.sessions.find(candidate => candidate.id === run.sessionId);
    if (!session) return;
    try { await onSignInSession(session); }
    catch (error) { fail(error, text('The terminal could not be shown.', '无法显示这个终端。')); }
  };

  const signIn = async (capability: ProviderCapability) => {
    const command = signInTerminal(capability);
    if (!command || busy) return;
    setBusy(capability.id); setIssue(undefined); setNotice(undefined);
    try {
      // The runtime resolves the command's folder (that computer's home) so the picker is only for older runtimes.
      const project = data.projects[0];
      const cwd = command.cwd ?? project?.path ?? await chooseDirectory();
      if (!cwd) return;
      const session = await request('session.create', { cwd, projectId: command.cwd ? undefined : project?.id, title: `${capability.name} ${text('sign-in', '登录')}`, provider: command.provider, mode: 'terminal', executable: command.executable, args: [...command.args], operationId: operationId() });
      await onSignInSession(session);
      setNotice(text(`${capability.name} sign-in terminal opened. Finish signing in there, then choose Check.`, `已打开 ${capability.name} 登录终端。在终端里完成登录后，点“检查”。`));
    } catch (error) {
      fail(error, text('This agent action could not be completed.', '无法完成这个智能体操作。'));
    } finally { setBusy(undefined); }
  };

  /** Runs a runtime command in a background terminal, without a project and without presenting it. */
  const run = async (capability: ProviderCapability, kind: InstallKind, command: ProviderCommand) => {
    setConfirm(undefined);
    if (busy) return;
    setBusy(capability.id); setIssue(undefined); setNotice(undefined);
    try {
      const project = data.projects[0];
      const cwd = command.cwd ?? project?.path ?? await chooseDirectory();
      if (!cwd) return;
      const title = kind === 'node' ? text('Install Node.js', '安装 Node.js') : kind === 'update' ? text(`Update ${capability.name}`, `更新 ${capability.name}`) : text(`Install ${capability.name}`, `安装 ${capability.name}`);
      const session = await request('session.create', {
        cwd, title, provider: 'shell', mode: 'terminal', executable: command.executable, args: [...command.args], operationId: operationId(),
      });
      setRun(capability.id, { kind, sessionId: session.id, ...(typeof session.exitCode === 'number' ? { exitCode: session.exitCode } : {}) });
    } catch (error) {
      fail(error, text('The command could not be started.', '无法启动这个命令。'));
    } finally { setBusy(undefined); }
  };

  const askToRun = (agentId: string, kind: InstallKind, anchor: HTMLElement) => setConfirm({ agentId, kind, anchor });
  const confirmTarget = confirm ? capabilities.find(candidate => candidate.id === confirm.agentId) : undefined;
  const confirmCommand = confirm && confirmTarget
    ? confirm.kind === 'node' ? confirmTarget.nodeInstall : confirm.kind === 'update' ? confirmTarget.update : confirmTarget.install
    : undefined;

  const stateLabel = (state: AgentRowState) => ({
    missing: text('Not installed', '未安装'),
    'node-missing': text('Not installed', '未安装'),
    installing: text('Installing…', '正在安装…'),
    'install-failed': text('Install failed', '安装失败'),
    'signed-in': text('Signed in', '已登录'),
    'signed-out': text('Not signed in', '未登录'),
    unknown: text('Sign-in status unknown', '登录状态未知'),
  })[state];
  const runningLabel = (kind: InstallKind) => kind === 'update' ? text('Updating…', '正在更新…') : kind === 'node' ? text('Installing Node.js…', '正在安装 Node.js…') : text('Installing…', '正在安装…');
  const failureText = (run: InstallRun) => (run.kind === 'update' ? text('Update failed', '更新失败') : run.kind === 'node' ? text('Node.js install failed', 'Node.js 安装失败') : text('Install failed', '安装失败'))
    + text(` (exit code ${run.exitCode}).`, `（退出码 ${run.exitCode}）。`);
  const dot = (state: AgentRowState) => ({
    missing: 'neutral', 'node-missing': 'neutral', installing: 'neutral', 'install-failed': 'error',
    'signed-in': 'success', 'signed-out': 'warning', unknown: 'neutral',
  } as const)[state];
  const sourceLabel = (source: ProviderCapability['installSource']) => source === 'npm' ? text('npm global install', 'npm 全局安装') : source === 'plugin' ? text('Plugin', '插件') : text('Vendor installer', '厂商安装程序');
  const runningSessions = (capability: ProviderCapability) => data.sessions.filter(session => session.provider === capability.id && !session.archived && ['starting', 'running', 'idle', 'waiting'].includes(session.status)).length;

  return <Theme theme={neutralTheme} mode={mode}>
    <section className="astryx-scope agents-settings" data-testid="agents-settings" aria-label={text('Agents', '智能体')}>
      <div className="agents-head">
        <div>
          <div className="agents-title">{text('Agents', '智能体')}</div>
          <div className="agents-summary" aria-live="polite">{[
            text(`${ready} ready`, `${ready} 个可用`),
            signedOut ? text(`${signedOut} need sign-in`, `${signedOut} 个需要登录`) : '',
            installing ? text(`${installing} installing`, `${installing} 个正在安装`) : '',
            failed ? text(`${failed} failed to install`, `${failed} 个安装失败`) : '',
            missing ? text(`${missing} not installed`, `${missing} 个未安装`) : '',
            // Said once here, not on every row: each blocked row's 安装 opens the Node.js step.
            count('node-missing') ? text('Node.js needed', '需要 Node.js') : '',
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
          const run = runs[capability.id];
          // A failed run of any kind draws one failure line; a failed update keeps the row's own state above it.
          const failedRun = run && run.exitCode !== undefined && run.exitCode !== 0 ? run : undefined;
          const label = state === 'installing' && run ? runningLabel(run.kind) : stateLabel(state);
          // Google's sign-in needs a browser on the host; the old accounts panel said so for the bundled Gemini plugin.
          const googleNote = capability.id === 'gemini' && capability.source === 'plugin' && isRemoteFiles();
          const menu: DropdownMenuOption[] = [
            ...(command ? [{ label: state === 'signed-in' ? text('Sign in again', '重新登录') : text('Sign in', '登录'), onClick: () => void signIn(capability) }] : []),
            ...(capability.update ? [{ label: text('Update', '更新'), onClick: () => askToRun(capability.id, 'update', document.querySelector<HTMLElement>(`[data-agent-row="${capability.id}"] button[aria-haspopup]`) ?? document.body) }] : []),
            ...(capability.install ? [{ label: text('Copy install command', '复制安装命令'), onClick: () => void navigator.clipboard?.writeText(capability.install!.display) }] : []),
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
                  <StatusDot variant={dot(state)} label={label} />{label}</span>
                {primary === 'signIn' && <span data-testid={`agent-sign-in-${capability.id}`}><Button label={busy === capability.id ? text('Opening…', '正在打开…') : text('Sign in', '登录')} variant="primary" size="sm" isDisabled={Boolean(busy)} onClick={() => void signIn(capability)} /></span>}
                {primary === 'homepage' && <span data-testid={`agent-homepage-${capability.id}`}><Button label={text('How to install', '安装说明')} variant="secondary" size="sm" onClick={() => void openExternal(capability.homepage!)} /></span>}
                {primary === 'install' && state !== 'install-failed' && <span data-testid={`agent-install-${capability.id}`}><Button label={text('Install', '安装')} variant="primary" size="sm" isDisabled={Boolean(busy)} onClick={event => askToRun(capability.id, 'install', event.currentTarget)} /></span>}
                {primary === 'node' && state !== 'install-failed' && <span data-testid={`agent-node-${capability.id}`}><Button label={text('Install', '安装')} variant="primary" size="sm" isDisabled={Boolean(busy)} onClick={event => askToRun(capability.id, 'node', event.currentTarget)} /></span>}
                {state === 'installing' && run && <><span className="agents-spin" aria-hidden="true" /><span data-testid={`agent-output-${capability.id}`}><Button label={text('View output', '查看输出')} variant="ghost" size="sm" onClick={() => void present(run)} /></span></>}
                <DropdownMenu items={menu} hasChevron={false} placement="below" alignment="end" button={{ label: text(`${capability.name} actions`, `${capability.name} 的更多操作`), variant: 'ghost', size: 'sm', children: '⋯' }} />
              </span>} />
            </div>
            {failedRun && <div className="agents-failure" role="alert" data-testid={`agent-failed-${capability.id}`}>
              <span>{failureText(failedRun)}</span>
              <span data-testid={`agent-failure-output-${capability.id}`}><Button label={text('View output', '查看输出')} variant="ghost" size="sm" onClick={() => void present(failedRun)} /></span>
              {runCommand(capability, failedRun.kind) && <span data-testid={`agent-retry-${capability.id}`}><Button label={text('Retry', '重试')} variant="secondary" size="sm" isDisabled={Boolean(busy)}
                onClick={event => askToRun(capability.id, failedRun.kind, event.currentTarget)} /></span>}
              <span data-testid={`agent-dismiss-${capability.id}`}><Button label={text('Dismiss', '忽略')} variant="ghost" size="sm" onClick={() => setRun(capability.id, undefined)} /></span>
            </div>}
            {googleNote && <div className="agents-note agents-row-note">{text('Google sign-in can’t run in ThreadTerm’s browser. Use an API key, or sign in on that computer.', 'Google 登录无法在 ThreadTerm 浏览器中完成。请使用 API 密钥，或在那台电脑上登录。')}</div>}
            {expanded && <dl className="agents-detail">
              {capability.executablePath && <><dt>{text('Executable', '可执行文件')}</dt><dd><code>{capability.executablePath}</code></dd></>}
              {capability.installSource && <><dt>{text('Installed with', '安装方式')}</dt><dd>{sourceLabel(capability.installSource)}</dd></>}
              {capability.signIn && <><dt>{text('Sign-in command', '登录命令')}</dt><dd><code>{capability.signIn.display}</code></dd></>}
              {capability.install && <><dt>{text('Install command', '安装命令')}</dt><dd><code>{capability.install.display}</code></dd></>}
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
      {confirm && confirmCommand && confirmTarget && <ConfirmInstall
        anchor={confirm.anchor}
        title={confirm.kind === 'node' ? text('Install Node.js first', '先安装 Node.js') : confirm.kind === 'update' ? text(`Update ${confirmTarget.name}`, `更新 ${confirmTarget.name}`) : text(`Install ${confirmTarget.name}`, `安装 ${confirmTarget.name}`)}
        command={confirmCommand.display}
        note={confirm.kind === 'node'
          ? text(`${confirmTarget.name} installs with npm, which comes with Node.js. This installs Node.js only; then choose Install again for ${confirmTarget.name}.`, `${confirmTarget.name} 用 npm 安装，npm 随 Node.js 提供。这一步只安装 Node.js，装好后再点“安装”安装 ${confirmTarget.name}。`)
          : confirm.kind === 'update'
            ? text('Updates the agent in a background terminal; you can open its output at any time.', '会在后台终端里更新，随时可以查看输出。')
            : text('Installs the agent globally in a background terminal; you can open its output at any time.', '会在后台终端里全局安装，随时可以查看输出。')}
        warning={confirm.kind === 'update' && runningSessions(confirmTarget) > 0
          ? text(`${runningSessions(confirmTarget)} ${confirmTarget.name} session(s) are running; Windows may not be able to replace files in use.`, `${runningSessions(confirmTarget)} 个 ${confirmTarget.name} 会话正在运行，Windows 可能无法替换正在使用的文件。`)
          : undefined}
        confirmLabel={text('Run', '运行')}
        cancelLabel={text('Cancel', '取消')}
        onConfirm={() => void run(confirmTarget, confirm.kind, confirmCommand)}
        onCancel={() => setConfirm(undefined)} />}
    </section>
  </Theme>;
}
