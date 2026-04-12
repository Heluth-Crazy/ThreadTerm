import React, { useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ShieldCheck, ShieldX } from 'lucide-react';

import SessionProviderLogo from '../../SessionProviderLogo';
import CardMessageList from './CardMessageList';
import MiniInputBar from './MiniInputBar';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useCardHistory } from '../../../hooks/useCardHistory';
import { getProviderBorderClass, getProviderDotClass } from '../../../utils/providerColors';
import { invoke } from '../../../lib/tauri-bridge';
import type { SessionRuntimeStatus } from '../../../stores/sessionStatusStore';
import type { MessageSnapshot } from '../../../stores/liveGridStore';

// Stable empty array to prevent Zustand selector from creating new references each render
const EMPTY_SNAPSHOTS: MessageSnapshot[] = [];

type LiveCardProps = {
  sessionId: string;
  projectId: string;
  provider: string;
  sessionTitle: string;
  projectPath: string;
  worktreePath?: string;
  onSend: (sessionId: string, text: string, projectPath: string, provider: string) => void;
  isFocused?: boolean;
};

function StatusDot({ status }: { status: SessionRuntimeStatus }) {
  switch (status) {
    case 'needs_attention':
      return <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" title="Needs attention" />;
    case 'processing':
      return (
        <span
          className="inline-block h-2 w-2 rounded-full border-[1.5px] border-emerald-500 border-t-transparent"
          style={{ animation: 'spin 0.8s linear infinite' }}
          title="Running"
        />
      );
    case 'completed':
      return <span className="inline-block h-2 w-2 rounded-full bg-gray-400" title="Completed" />;
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" title="Idle" />;
  }
}

function statusRingClass(status: SessionRuntimeStatus): string {
  switch (status) {
    case 'needs_attention':
      return 'ring-2 ring-red-500/50 animate-pulse';
    case 'processing':
      return 'ring-1 ring-blue-500/30';
    default:
      return '';
  }
}

function LiveCardInner({
  sessionId,
  projectId,
  provider,
  sessionTitle,
  projectPath,
  worktreePath,
  onSend,
  isFocused,
}: LiveCardProps) {
  const { t } = useTranslation('common');
  const cardRef = useRef<HTMLDivElement>(null);
  const removeCard = useLiveGridStore((s) => s.removeCard);
  const setFocusedCard = useLiveGridStore((s) => s.setFocusedCard);
  const snapshots: MessageSnapshot[] = useLiveGridStore(
    (s) => s.messageSnapshots[sessionId] ?? EMPTY_SNAPSHOTS,
  );

  // Load session history from API on mount (restores messages after refresh)
  useCardHistory(sessionId, projectId, provider);

  // Use direct selector on statuses to avoid calling get() inside a selector (which causes stale refs)
  const status: SessionRuntimeStatus = useSessionStatusStore(
    (s) => s.statuses[sessionId]?.status ?? 'idle',
  );
  const pendingPermission = useSessionStatusStore((s) => s.pendingPermissions[sessionId]);
  const clearPendingPermission = useSessionStatusStore((s) => s.clearPendingPermission);

  const handleDoubleClick = useCallback(() => {
    setFocusedCard(sessionId);
  }, [sessionId, setFocusedCard]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeCard(sessionId);
    },
    [sessionId, removeCard],
  );

  const handleSend = useCallback(
    (text: string) => {
      onSend(sessionId, text, projectPath, provider);
    },
    [sessionId, projectPath, provider, onSend],
  );

  const handlePermission = useCallback(
    async (approved: boolean) => {
      if (!pendingPermission) return;
      try {
        await invoke('ai_approve_tool', {
          sessionId,
          permissionId: pendingPermission.requestId,
          approved,
        });
        clearPendingPermission(sessionId);
      } catch {
        // Silently fail — status store will handle retry
      }
    },
    [pendingPermission, sessionId, clearPendingPermission],
  );

  const statusKey =
    status === 'needs_attention'
      ? 'liveGrid.status.needsAttention'
      : `liveGrid.status.${status}`;

  // Auto-scroll focused card into view
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isFocused]);

  return (
    <div
      ref={cardRef}
      className={`flex h-full flex-col overflow-hidden rounded-xl border border-border/60 border-l-4 ${getProviderBorderClass(provider)} bg-card/90 transition-shadow ${statusRingClass(status)} ${isFocused ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
      onDoubleClick={handleDoubleClick}
      tabIndex={isFocused ? 0 : -1}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5">
        <SessionProviderLogo provider={provider} className="h-4 w-4" />
        <span className={`inline-block h-2 w-2 rounded-full ${getProviderDotClass(provider)}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {sessionTitle}
        </span>
        {worktreePath && (
          <span className="truncate rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-500" title={worktreePath}>
            🌿 {worktreePath.split('/').pop()}
          </span>
        )}
        <StatusDot status={status} />
        <span className="text-[10px] text-muted-foreground">{t(statusKey)}</span>
        <button
          type="button"
          onClick={handleRemove}
          className="ml-1 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
          title={t('liveGrid.removeCard')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Message stream */}
      <CardMessageList snapshots={snapshots} />

      {/* Inline permission request */}
      {pendingPermission && (
        <div className="flex items-center gap-2 border-t border-border/40 bg-amber-500/5 px-2.5 py-1.5">
          <span className="flex-1 truncate text-[11px] text-amber-600">
            {pendingPermission.toolName}
          </span>
          <button
            type="button"
            onClick={() => handlePermission(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10"
          >
            <ShieldCheck className="h-3 w-3" /> Allow
          </button>
          <button
            type="button"
            onClick={() => handlePermission(false)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            <ShieldX className="h-3 w-3" /> Deny
          </button>
        </div>
      )}

      {/* Input */}
      <MiniInputBar onSend={handleSend} disabled={status === 'processing'} />
    </div>
  );
}

const LiveCard = React.memo(LiveCardInner);
export default LiveCard;
