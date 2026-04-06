import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import type { Project, ProjectSession } from '../../types/app';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  selectedSession: ProjectSession | null;
  onSelectSession: (project: Project, session: ProjectSession) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
}

interface PaletteItem {
  id: string;
  type: 'session' | 'action';
  label: string;
  description?: string;
  provider?: 'claude' | 'codex';
  project?: Project;
  session?: ProjectSession;
  action?: () => void;
  icon?: string;
}

export default function CommandPalette({
  open,
  onClose,
  projects,
  selectedSession,
  onSelectSession,
  onNewSession,
  onOpenSettings,
  onOpenExtensions,
}: CommandPaletteProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const getStatus = useSessionStatusStore((s) => s.getStatus);

  // Build flat item list
  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // Actions
    items.push({
      id: 'action-new-session',
      type: 'action',
      label: t('overview.newSession', 'New Session'),
      icon: '＋',
      action: onNewSession,
    });
    items.push({
      id: 'action-settings',
      type: 'action',
      label: t('navigation.settings', 'Settings'),
      icon: '⚙',
      action: onOpenSettings,
    });
    items.push({
      id: 'action-extensions',
      type: 'action',
      label: 'Extensions',
      icon: '⧉',
      action: onOpenExtensions,
    });

    // Sessions from all projects
    for (const project of projects) {
      const sessions = [
        ...(project.sessions ?? []).map((s) => ({ ...s, __provider: s.__provider ?? ('claude' as const) })),
        ...(project.codexSessions ?? []).map((s) => ({ ...s, __provider: s.__provider ?? ('codex' as const) })),
      ];
      for (const session of sessions) {
        const provider = session.__provider ?? 'claude';
        const status = getStatus(session.id);
        const statusDot =
          status.status === 'needs_attention' ? '●' :
          status.status === 'processing' ? '⟳' :
          status.status === 'completed' ? '✓' : '○';
        items.push({
          id: `session-${session.id}`,
          type: 'session',
          label: session.title || session.name || session.id.slice(0, 8),
          description: `${statusDot} ${provider} • ${project.displayName || project.name}`,
          provider: provider as 'claude' | 'codex',
          project,
          session,
        });
      }
    }

    return items;
  }, [projects, getStatus, onNewSession, onOpenSettings, onOpenExtensions, t]);

  // Filter by query
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase();
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false),
    );
  }, [allItems, query]);

  // Reset index on query or open change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const el = container.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.type === 'action' && item.action) {
        item.action();
      } else if (item.type === 'session' && item.project && item.session) {
        onSelectSession(item.project, item.session);
      }
      onClose();
    },
    [onClose, onSelectSession],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(filtered.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[selectedIndex];
        if (item) execute(item);
      }
    },
    [filtered, selectedIndex, execute, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm pt-[15vh]"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border bg-background/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <svg className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions, actions..."
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-block">
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No results found</div>
          ) : (
            filtered.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                  idx === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-muted/50'
                } ${item.type === 'session' && selectedSession?.id === item.session?.id ? 'ring-1 ring-primary/30' : ''}`}
                onClick={() => execute(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                {item.type === 'action' ? (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs">
                    {item.icon}
                  </span>
                ) : (
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ${
                      item.provider === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
                    }`}
                  >
                    {item.provider === 'codex' ? 'CX' : 'CL'}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.label}</div>
                  {item.description ? (
                    <div className="truncate text-xs text-muted-foreground">{item.description}</div>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
