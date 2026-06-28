/**
 * One row of the workspace file tree. Directories expand lazily — the first
 * time a folder opens, it fetches its children via `read_directory`; collapsed
 * folders cost nothing, so even `node_modules` is cheap until opened.
 */
import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../lib/tauri-bridge';
import { cn } from '../../lib/utils';
import { type DirEntry, fileColorClass } from './fileMeta';

const INDENT_PX = 12;
const BASE_PAD_PX = 6;

interface FileTreeNodeProps {
  entry: DirEntry;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (entry: DirEntry) => void;
}

export function FileTreeNode({ entry, depth, selectedPath, onSelectFile }: FileTreeNodeProps) {
  const { t } = useTranslation('terminal');
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<DirEntry[]>('read_directory', { path: entry.path });
      setChildren(result ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [entry.path]);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      const next = !expanded;
      setExpanded(next);
      if (next && children === null) void loadChildren();
    } else {
      onSelectFile(entry);
    }
  }, [entry, expanded, children, loadChildren, onSelectFile]);

  const isSelected = !entry.isDir && selectedPath === entry.path;
  const childPad = (depth + 1) * INDENT_PX + BASE_PAD_PX;

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        title={entry.name}
        className={cn(
          'group flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12px] leading-tight transition-colors',
          isSelected
            ? 'bg-primary/15 text-foreground'
            : 'text-foreground/85 hover:bg-accent/60',
          entry.isHidden && !isSelected && 'opacity-55',
        )}
        style={{ paddingLeft: depth * INDENT_PX + BASE_PAD_PX }}
      >
        {entry.isDir ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden />
        )}
        {entry.isDir ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          )
        ) : (
          <File className={cn('h-3.5 w-3.5 shrink-0', fileColorClass(entry.name))} />
        )}
        <span className="truncate">{entry.name}</span>
        {loading && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
      </button>

      {expanded && (
        <div>
          {error && (
            <div className="py-1 text-[11px] text-destructive" style={{ paddingLeft: childPad }}>
              {error}
            </div>
          )}
          {!error && children?.length === 0 && !loading && (
            <div
              className="py-1 text-[11px] italic text-muted-foreground/70"
              style={{ paddingLeft: childPad }}
            >
              {t('workspace.emptyDirectory', { defaultValue: 'Empty directory' })}
            </div>
          )}
          {children?.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
