import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import type { CardMeta } from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import type { WorkspaceTab } from '@shared/lib/workspace/types';
import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import { ConnectionBanner } from '../ConnectionBanner';
import { MainTerminal } from '../MainTerminal';
import { InputBar } from '../input/InputBar';
import { useI18n } from '../i18n';
import type { ITheme } from '@xterm/xterm';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceTabStrip } from './WorkspaceTabStrip';
import { FileEditor } from './FileEditor';
import { DiffViewer } from './DiffViewer';
import { TerminalCloseSheet } from './TerminalCloseSheet';
import { DirtyFileCloseSheet } from './DirtyFileCloseSheet';
import { LeaseDialog } from './LeaseDialog';
import {
  draftMetaForTab,
  type DiffViewMode,
  type DirtyCloseChoice,
  type FileEditorModel,
  type DiffViewerModel,
  type TerminalCloseChoice,
} from './types';
import type { WorkspaceDraftMeta } from '@shared/lib/workspace/types';

export interface WorkspaceShellProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branchLabel?: string | null;
  tabs: WorkspaceTab[];
  /** Per-device active tab — does not mutate desktop active surface. */
  deviceActiveTabId: string;
  draftMetas?: WorkspaceDraftMeta[];
  cards: CardMeta[];
  permission: BridgeDevicePermission;
  secureReady: boolean;
  wsStatus: BridgeConnectionState;
  terminalTheme?: ITheme;
  recoveryNonce?: number;
  canSend: boolean;
  fileEditor?: FileEditorModel | null;
  diffViewer?: DiffViewerModel | null;
  onBack: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenTerminalCard: (cardId: string) => void;
  onNewTerminal?: () => void;
  onOpenFileBrowser?: () => void;
  onTerminalCloseChoice: (choice: TerminalCloseChoice, tabId: string, cardId: string | null) => void;
  onDirtyCloseChoice: (choice: DirtyCloseChoice, tabId: string) => void;
  onFileChange?: (contents: string, baseRevision: number) => void;
  onFileSave?: () => void;
  onRequestLease?: () => void;
  onLeaseAcquire?: () => void;
  onLeaseTakeover?: () => void;
  onDiffModeChange?: (mode: DiffViewMode) => void;
  onSendInput?: (data: string) => void;
  onActivateCard?: (cardId: string) => void;
}

export function WorkspaceShell({
  workspaceId,
  projectName,
  projectPath,
  worktreePath,
  branchLabel,
  tabs,
  deviceActiveTabId,
  draftMetas = [],
  cards,
  permission,
  secureReady,
  wsStatus,
  terminalTheme,
  recoveryNonce = 0,
  canSend,
  fileEditor = null,
  diffViewer = null,
  onBack,
  onSelectTab,
  onCloseTab,
  onOpenTerminalCard,
  onNewTerminal,
  onOpenFileBrowser,
  onTerminalCloseChoice,
  onDirtyCloseChoice,
  onFileChange,
  onFileSave,
  onRequestLease,
  onLeaseAcquire,
  onLeaseTakeover,
  onDiffModeChange,
  onSendInput,
  onActivateCard,
}: WorkspaceShellProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const readOnly = permission !== 'full';
  const connectionOpen = wsStatus === 'open';
  const canMutate = !readOnly && connectionOpen;

  const activeTab = tabs.find((tab) => tab.id === deviceActiveTabId) ?? tabs[0] ?? null;
  const dirtyTabIds = useMemo(
    () => new Set(draftMetas.filter((meta) => meta.dirty).map((meta) => meta.tabId)),
    [draftMetas],
  );

  const [terminalClose, setTerminalClose] = useState<{
    tabId: string;
    title: string;
    cardId: string | null;
  } | null>(null);
  const [dirtyClose, setDirtyClose] = useState<{ tabId: string; titles: string[]; conflict: boolean } | null>(
    null,
  );
  const [leaseOpen, setLeaseOpen] = useState(false);

  const requestClose = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind === 'home') return;
      const meta = draftMetaForTab(draftMetas, tabId);
      if (tab.kind === 'file' && meta?.dirty) {
        setDirtyClose({
          tabId,
          titles: [tab.title],
          conflict: meta.conflict !== 'none',
        });
        return;
      }
      if (tab.kind === 'terminal') {
        setTerminalClose({
          tabId,
          title: tab.title,
          cardId: tab.cardId ?? null,
        });
        return;
      }
      onCloseTab(tabId);
    },
    [draftMetas, onCloseTab, tabs],
  );

  const activeCard =
    activeTab?.kind === 'terminal' && activeTab.cardId
      ? cards.find((card) => card.id === activeTab.cardId) ?? null
      : null;

  const dualColumn =
    typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)')?.matches;

  return (
    <main className="workspace-shell" data-testid="workspace-shell" data-workspace-id={workspaceId}>
      <header className="workspace-shell-header safe-top">
        <button type="button" className="mobile-icon-button" onClick={onBack} aria-label={zh ? '返回' : 'Back'}>
          <ChevronLeft size={22} />
        </button>
        <div className="workspace-shell-identity">
          <h1>{projectName}</h1>
          <span>
            {branchLabel ? `${branchLabel} · ` : ''}
            {worktreePath}
          </span>
        </div>
        <span className="workspace-shell-status" title={wsStatus}>
          {connectionOpen ? <Wifi size={16} /> : <WifiOff size={16} />}
          {readOnly ? <ShieldCheck size={16} aria-label={zh ? '只读' : 'Read-only'} /> : null}
        </span>
      </header>

      <ConnectionBanner wsStatus={wsStatus} />

      <WorkspaceTabStrip
        tabs={tabs}
        activeTabId={activeTab?.id ?? 'home'}
        dirtyTabIds={dirtyTabIds}
        canClose={connectionOpen}
        onSelect={onSelectTab}
        onClose={requestClose}
      />

      <div className="workspace-shell-body">
        {(!activeTab || activeTab.kind === 'home') && (
          <WorkspaceHome
            projectName={projectName}
            worktreePath={worktreePath}
            branchLabel={branchLabel}
            cards={cards}
            tabs={tabs}
            draftMetas={draftMetas}
            secureReady={secureReady}
            canMutate={canMutate}
            readOnly={readOnly}
            onOpenTerminal={(cardId) => {
              const tab = tabs.find((item) => item.kind === 'terminal' && item.cardId === cardId);
              if (tab) onSelectTab(tab.id);
              else onOpenTerminalCard(cardId);
            }}
            onOpenTab={onSelectTab}
            onOpenFileBrowser={secureReady ? onOpenFileBrowser : undefined}
            onNewTerminal={canMutate ? onNewTerminal : undefined}
          />
        )}

        {activeTab?.kind === 'terminal' && activeCard && (
          <div className="workspace-terminal-pane" data-testid="workspace-terminal-pane">
            <MainTerminal
              activeCardId={activeCard.id}
              recoveryNonce={recoveryNonce}
              theme={terminalTheme}
            />
            <InputBar
              disabled={!canSend}
              ariaLabel={
                readOnly
                  ? zh
                    ? '只读设备'
                    : 'Read-only device'
                  : zh
                    ? '移动终端输入'
                    : 'Mobile terminal input'
              }
              onSend={(data) => onSendInput?.(data)}
            />
            {!canSend && activeCard && onActivateCard && permission === 'full' && (
              <button
                type="button"
                className="secondary-full-button"
                onClick={() => onActivateCard(activeCard.id)}
              >
                {zh ? '启动 / 恢复' : 'Start / resume'}
              </button>
            )}
          </div>
        )}

        {activeTab?.kind === 'file' && fileEditor && onFileChange && (
          <FileEditor
            model={fileEditor}
            onChange={onFileChange}
            onSave={onFileSave}
            onRequestLease={() => {
              setLeaseOpen(true);
              onRequestLease?.();
            }}
          />
        )}

        {activeTab?.kind === 'file' && !fileEditor && (
          <div className="mobile-info-card" data-testid="file-loading">
            <strong>{zh ? '正在从桌面加载文件…' : 'Loading file from desktop…'}</strong>
            <span>{activeTab.relativePath || activeTab.title}</span>
          </div>
        )}

        {activeTab?.kind === 'diff' && diffViewer && onDiffModeChange && (
          <DiffViewer model={diffViewer} onModeChange={onDiffModeChange} dualColumn={dualColumn} />
        )}

        {activeTab?.kind === 'diff' && !diffViewer && (
          <div className="mobile-info-card">
            <strong>{zh ? '正在加载 Diff…' : 'Loading diff…'}</strong>
          </div>
        )}
      </div>

      <TerminalCloseSheet
        open={Boolean(terminalClose)}
        title={terminalClose?.title ?? ''}
        canEndTerminal={canMutate}
        onChoose={(choice) => {
          if (terminalClose) {
            onTerminalCloseChoice(choice, terminalClose.tabId, terminalClose.cardId);
          }
          setTerminalClose(null);
        }}
      />

      <DirtyFileCloseSheet
        open={Boolean(dirtyClose)}
        titles={dirtyClose?.titles ?? []}
        conflict={dirtyClose?.conflict}
        canMutate={canMutate}
        onChoose={(choice) => {
          if (dirtyClose) {
            onDirtyCloseChoice(choice, dirtyClose.tabId);
          }
          setDirtyClose(null);
        }}
      />

      <LeaseDialog
        open={leaseOpen}
        tabTitle={activeTab?.title ?? ''}
        holderSurfaceId={fileEditor?.leaseHolder ?? null}
        canTakeover={canMutate}
        onAcquire={() => {
          onLeaseAcquire?.();
          setLeaseOpen(false);
        }}
        onTakeover={() => {
          onLeaseTakeover?.();
          setLeaseOpen(false);
        }}
        onCancel={() => setLeaseOpen(false)}
      />

      {/* projectPath kept for a11y / future breadcrumbs */}
      <span className="sr-only">{projectPath}</span>
    </main>
  );
}
