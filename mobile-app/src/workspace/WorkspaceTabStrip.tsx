import { FileCode2, GitCompare, Home, SquareTerminal, X } from 'lucide-react';
import type { WorkspaceTab, WorkspaceTabKind } from '@shared/lib/workspace/types';
import { useI18n } from '../i18n';

export interface WorkspaceTabStripProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  dirtyTabIds?: ReadonlySet<string>;
  canClose?: boolean;
  onSelect: (tabId: string) => void;
  onClose?: (tabId: string) => void;
}

function kindIcon(kind: WorkspaceTabKind) {
  switch (kind) {
    case 'home':
      return <Home size={14} aria-hidden />;
    case 'terminal':
      return <SquareTerminal size={14} aria-hidden />;
    case 'file':
      return <FileCode2 size={14} aria-hidden />;
    case 'diff':
      return <GitCompare size={14} aria-hidden />;
    default:
      return null;
  }
}

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  dirtyTabIds,
  canClose = true,
  onSelect,
  onClose,
}: WorkspaceTabStripProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const ordered = [...tabs].sort((a, b) => a.sharedOrder - b.sharedOrder);

  return (
    <div
      className="workspace-tab-strip"
      role="tablist"
      aria-label={zh ? '工作区标签' : 'Workspace tabs'}
      data-testid="workspace-tab-strip"
    >
      <div className="workspace-tab-strip-scroll">
        {ordered.map((tab) => {
          const selected = tab.id === activeTabId;
          const dirty = dirtyTabIds?.has(tab.id) ?? false;
          const closeable = tab.kind !== 'home' && canClose && Boolean(onClose);
          return (
            <div
              key={tab.id}
              className={`workspace-tab-chip ${selected ? 'active' : ''}`}
              role="tab"
              aria-selected={selected}
              data-tab-id={tab.id}
              data-tab-kind={tab.kind}
            >
              <button
                type="button"
                className="workspace-tab-main"
                onClick={() => onSelect(tab.id)}
              >
                {kindIcon(tab.kind)}
                <span className="workspace-tab-title">
                  {dirty && <i className="workspace-tab-dirty-dot" aria-label={zh ? '未保存' : 'Unsaved'} />}
                  {tab.title}
                </span>
              </button>
              {closeable && (
                <button
                  type="button"
                  className="workspace-tab-close"
                  aria-label={zh ? `关闭 ${tab.title}` : `Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose?.(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
