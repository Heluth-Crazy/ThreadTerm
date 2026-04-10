import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, ChevronLeft } from 'lucide-react';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import ChatPanel from '../chat/ChatPanel';
import ErrorBoundary from '../shared/ErrorBoundary';
import FileTree from '../FileTree';
import GitPanel from '../GitPanel';
import { TerminalGrid } from '../terminal-grid';
import { Button } from '../ui/button';
import type { SessionLifecycleHandler } from '../main-content/types/types';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import { api } from '../../utils/api';

const AnyGitPanel = GitPanel as any;

export interface SessionFocusLayoutProps {
  projects: Project[];
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  sendMessage: (message: unknown) => boolean;
  latestMessage: unknown;
  messageSequence: number;
  getBufferedMessagesSince: (seq: number) => Array<{ sequence: number; message: unknown }>;
  externalMessageUpdate: number;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  processingSessions: Set<string>;
  onReplaceTemporarySession: SessionLifecycleHandler;
  onNavigateToSession: (targetSessionId: string) => void;
  onBackToOverview: () => void;
  onShowSettings: () => void;
  onRenameSession?: (projectName: string, sessionId: string, newTitle: string) => void;
  ws: WebSocket | null;
  isLoading: boolean;
}

type OverlayPanel = null | 'files' | 'git';

function useSplitPanel(initialPercent = 55) {
  const [splitPercent, setSplitPercent] = useState(initialPercent);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const pct = Math.min(80, Math.max(20, (x / rect.width) * 100));
      setSplitPercent(pct);
    };

    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return { splitPercent, containerRef, handleMouseDown };
}

export default function SessionFocusLayout({
  selectedProject,
  selectedSession,
  sendMessage,
  latestMessage,
  messageSequence,
  getBufferedMessagesSince,
  externalMessageUpdate,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
  onBackToOverview,
  onShowSettings,
  onRenameSession,
  isLoading,
}: SessionFocusLayoutProps) {
  const { t } = useTranslation('common');
  const [overlayPanel, setOverlayPanel] = useState<OverlayPanel>(null);
  const [focusView, setFocusView] = useState<'chat' | 'split' | 'terminal'>('split');
  const { splitPercent, containerRef, handleMouseDown } = useSplitPanel(55);
  const getStatus = useSessionStatusStore((s) => s.getStatus);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const provider = selectedSession?.__provider ?? 'claude';
  const statusEntry = selectedSession ? getStatus(selectedSession.id) : null;
  const sessionTitle = selectedSession?.title || selectedSession?.name || selectedSession?.id?.slice(0, 8) || '';

  const startRename = useCallback(() => {
    setRenameValue(sessionTitle);
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }, [sessionTitle]);

  const commitRename = useCallback(async () => {
    if (!selectedSession || !renameValue.trim()) {
      setIsRenaming(false);
      return;
    }
    try {
      await api.renameSession(selectedProject.name, selectedSession.id, renameValue.trim());
      onRenameSession?.(selectedProject.name, selectedSession.id, renameValue.trim());
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
    setIsRenaming(false);
  }, [selectedSession, selectedProject?.name, renameValue, onRenameSession]);

  const cancelRename = useCallback(() => {
    setIsRenaming(false);
  }, []);

  // Escape closes overlay
  useEffect(() => {
    if (!overlayPanel) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverlayPanel(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overlayPanel]);

  // Cycle view mode: Ctrl+` / ⌘+`
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault();
        setFocusView(v => v === 'chat' ? 'split' : v === 'split' ? 'terminal' : 'chat');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  if (!selectedSession) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Select a session from the sidebar to begin</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onBackToOverview}
            className="mt-3 gap-1 text-muted-foreground hover:text-foreground px-2 h-7"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('overview.backToOverview', 'Overview')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Focus header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/60 px-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBackToOverview}
          className="h-6 gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('overview.backToOverview', 'Overview')}
        </Button>
        <div className="h-3.5 w-px bg-border/60" />
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white ${
            provider === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
          }`}
        >
          {provider}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
            onBlur={commitRename}
            className="max-w-[200px] rounded-md border border-primary/50 bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground outline-none"
            placeholder={t('sessionRename.placeholder', 'Session name')}
          />
        ) : (
          <span className="group/title flex items-center gap-1 truncate">
            <span className="truncate text-xs font-medium text-foreground">{sessionTitle}</span>
            <button
              type="button"
              onClick={startRename}
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-all hover:text-foreground group-hover/title:opacity-100"
              title={t('actions.rename', 'Rename')}
            >
              <Pencil className="h-3 w-3" />
            </button>
          </span>
        )}
        <span className="text-xs text-muted-foreground/60">• {selectedProject.displayName || selectedProject.name}</span>
        {statusEntry ? (
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${
            statusEntry.status === 'needs_attention' ? 'bg-red-500 animate-pulse' :
            statusEntry.status === 'processing' ? 'bg-blue-500' :
            statusEntry.status === 'completed' ? 'bg-emerald-500' : 'bg-muted-foreground/40'
          }`} />
        ) : null}
        <div className="flex-1" />

        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setFocusView('chat')}
            className={`rounded px-2 py-0.5 transition-colors ${focusView === 'chat' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Chat only (⌘`)"
          >
            💬
          </button>
          <button
            type="button"
            onClick={() => setFocusView('split')}
            className={`rounded px-2 py-0.5 transition-colors ${focusView === 'split' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Split view (⌘`)"
          >
            ⊙
          </button>
          <button
            type="button"
            onClick={() => setFocusView('terminal')}
            className={`rounded px-2 py-0.5 transition-colors ${focusView === 'terminal' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Terminal only (⌘`)"
          >
            ⬜
          </button>
        </div>

        {/* Action buttons */}
        <button
          type="button"
          onClick={() => setOverlayPanel(overlayPanel === 'files' ? null : 'files')}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${overlayPanel === 'files' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
          title="Files"
        >
          📁
        </button>
        <button
          type="button"
          onClick={() => setOverlayPanel(overlayPanel === 'git' ? null : 'git')}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${overlayPanel === 'git' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
          title="Git"
        >
          ⎇
        </button>
        <button
          type="button"
          onClick={onShowSettings}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
          title="Settings"
        >
          ⚙
        </button>
      </div>

      {/* Split content */}
      <div ref={containerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Chat panel - hidden in terminal-only mode */}
        {focusView !== 'terminal' && (
          <div
            className="min-w-0 overflow-hidden border-r border-border/40"
            style={{ width: focusView === 'chat' ? '100%' : `${splitPercent}%` }}
          >
            <ErrorBoundary area="Chat">
              <ChatPanel
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                messageSequence={messageSequence}
                getBufferedMessagesSince={getBufferedMessagesSince}
                externalMessageUpdate={externalMessageUpdate}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
              />
            </ErrorBoundary>
          </div>
        )}

        {/* Draggable divider - only in split mode */}
        {focusView === 'split' && (
          <div
            className="relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30 transition-colors"
            onMouseDown={handleMouseDown}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        )}

        {/* Terminal panel - hidden in chat-only mode */}
        {focusView !== 'chat' && (
          <div className="min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary area="Terminal">
              <TerminalGrid project={selectedProject} session={selectedSession} />
            </ErrorBoundary>
          </div>
        )}

        {/* Slide-over overlay for Files / Git */}
        {overlayPanel ? (
          <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-border bg-background shadow-xl">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
              <span className="text-xs font-medium text-foreground">
                {overlayPanel === 'files' ? 'Files' : 'Source Control'}
              </span>
              <button
                type="button"
                onClick={() => setOverlayPanel(null)}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {overlayPanel === 'files' ? (
                <ErrorBoundary area="File Tree">
                  <FileTree selectedProject={selectedProject} onFileOpen={() => {}} />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary area="Git Panel">
                  <AnyGitPanel selectedProject={selectedProject} onFileOpen={() => {}} />
                </ErrorBoundary>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
