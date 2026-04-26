/**
 * ProjectSidebar — left pane showing a rollup of projects.
 *
 * Behaviour (Finder-style):
 *   • "All" row always at top — clicking clears the project filter
 *   • Each project below shows name + card count + optional unread dot
 *   • Click a project → set as filter, grid in the main area filters to it
 *   • Collapse toggle reduces the sidebar to an icon rail (w-12)
 *   • Open-dir button on hover uses @tauri-apps/plugin-shell
 *
 * No drag-and-drop, rename, or delete — keep surface small.
 */
import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Layers,
} from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useTranslation } from 'react-i18next';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProjectGroups } from './useProjectGroups';

interface ProjectSidebarProps {
  className?: string;
}

export function ProjectSidebar({ className = '' }: ProjectSidebarProps) {
  const { t } = useTranslation('terminal');
  const groups = useProjectGroups();
  const totalCards = useTerminalStore((s) => s.cards.length);
  const totalUnread = useTerminalStore(
    (s) => s.cards.filter((c) => c.unread).length,
  );
  const selectedPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectProject = useTerminalStore((s) => s.selectProject);

  const [collapsed, setCollapsed] = useState(false);

  const handleOpenDir = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isTauriEnv()) return;
    shellOpen(path).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[ProjectSidebar] open dir failed:', err);
    });
  };

  return (
    <aside
      className={[
        'flex h-full shrink-0 flex-col border-r border-border bg-muted/20 transition-all duration-200',
        collapsed ? 'w-12' : 'w-60',
        className,
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border px-2">
        {!collapsed && (
          <span className="pl-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('sidebar.projects')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* "All" pseudo-project */}
        <SidebarRow
          collapsed={collapsed}
          selected={selectedPath === null}
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t('sidebar.allTerminals')}
          count={totalCards}
          unread={totalUnread}
          onClick={() => selectProject(null)}
        />

        {groups.length > 0 && !collapsed && (
          <div className="mx-2 my-1.5 border-t border-border/60" />
        )}

        {groups.map((g) => (
          <SidebarRow
            key={g.path}
            collapsed={collapsed}
            selected={selectedPath === g.path}
            icon={
              selectedPath === g.path ? (
                <FolderOpen className="h-3.5 w-3.5" />
              ) : (
                <Folder className="h-3.5 w-3.5" />
              )
            }
            label={g.name}
            subLabel={g.path}
            count={g.cards.length}
            unread={g.unreadCount}
            onClick={() => selectProject(g.path)}
            onAux={(e) => handleOpenDir(g.path, e)}
            auxTitle={isTauriEnv() ? t('sidebar.openDir') : undefined}
          />
        ))}

        {groups.length === 0 && !collapsed && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t('sidebar.emptyLine1')}
            <br />
            {t('sidebar.emptyLine2')}
          </div>
        )}
      </nav>
    </aside>
  );
}

interface SidebarRowProps {
  collapsed: boolean;
  selected: boolean;
  icon: React.ReactNode;
  label: string;
  subLabel?: string;
  count: number;
  unread: number;
  onClick: () => void;
  onAux?: (e: React.MouseEvent) => void;
  auxTitle?: string;
}

function SidebarRow({
  collapsed,
  selected,
  icon,
  label,
  subLabel,
  count,
  unread,
  onClick,
  onAux,
  auxTitle,
}: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? `${label} (${count})` : undefined}
      className={[
        'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
        collapsed ? 'justify-center' : '',
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
      ].join(' ')}
      style={collapsed ? undefined : { marginLeft: 4, marginRight: 4, width: 'calc(100% - 8px)' }}
    >
      <span className="relative shrink-0">
        {icon}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
      </span>

      {!collapsed && (
        <>
          <span className="flex-1 min-w-0">
            <span className="block truncate font-medium">{label}</span>
            {subLabel && (
              <span
                className="block truncate text-[10px] text-muted-foreground"
                title={subLabel}
              >
                {subLabel}
              </span>
            )}
          </span>
          <span
            className={[
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums',
              selected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
            ].join(' ')}
          >
            {count}
          </span>
          {onAux && (
            <span
              role="button"
              tabIndex={0}
              onClick={onAux}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onAux(e as unknown as React.MouseEvent);
              }}
              title={auxTitle}
              className="opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            >
              <FolderOpen className="h-3 w-3" />
            </span>
          )}
        </>
      )}
    </button>
  );
}
