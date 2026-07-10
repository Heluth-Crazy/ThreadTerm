/**
 * Root of the workspace file tree. Loads the children of `rootPath` and
 * re-loads whenever it changes — so the tree follows the terminal's live cwd
 * (a `cd` in the shell updates the root here).
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type DirEntry } from './fileMeta';
import { FileTreeNode } from './FileTreeNode';
import {
  getCachedWorkspaceDirectory,
  loadWorkspaceDirectory,
} from './workspaceLoadCache';

interface FileTreeProps {
  rootPath: string;
  selectedPath: string | null;
  onSelectFile: (entry: DirEntry) => void;
}

export function FileTree({ rootPath, selectedPath, onSelectFile }: FileTreeProps) {
  const { t } = useTranslation('terminal');
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedWorkspaceDirectory(rootPath);
    setEntries(cached);
    setLoading(cached === null);
    setError(null);
    (async () => {
      try {
        const result = await loadWorkspaceDirectory(rootPath);
        if (!cancelled) setEntries(result ?? []);
      } catch (e) {
        if (!cancelled && cached === null) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('workspace.loadingDirectory', { defaultValue: 'Reading directory...' })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-[12px] text-destructive">
        {t('workspace.readDirectoryFailed', {
          error,
          defaultValue: 'Could not read directory: {{error}}',
        })}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] italic text-muted-foreground/70">
        {t('workspace.emptyDirectory', { defaultValue: 'Empty directory' })}
      </div>
    );
  }

  return (
    <div className="min-w-max py-1">
      {entries.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}
