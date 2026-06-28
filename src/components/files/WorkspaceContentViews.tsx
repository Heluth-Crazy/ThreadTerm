/**
 * Main-content workspace views opened from the right-side Files / Changes panel.
 *
 * These views own heavyweight text editing and diff rendering so the right
 * panel stays a compact navigator instead of squeezing an editor into a narrow
 * column.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, FileText, GitCompare, Loader2, RefreshCw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  git,
  workspaceFiles,
  type GitStatusEntry,
  type GitTextDiffSection,
  type WorkspaceFile,
} from '../../lib/tauri-bridge';
import { confirmDialog } from '../../lib/nativeDialog';
import { cn } from '../../lib/utils';
import { basename, type DirEntry } from './fileMeta';
import { WorkspaceCodeEditor, WorkspaceMergeDiffEditor } from './WorkspaceCodeEditor';

type TerminalTranslator = ReturnType<typeof useTranslation>['t'];

export interface WorkspaceFileEditorViewProps {
  rootPath: string;
  path: string;
  active: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface WorkspaceDiffViewProps {
  change: GitStatusEntry;
  active: boolean;
  onOpenFile: (rootPath: string, entry: DirEntry) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function WorkspaceFileEditorView({
  rootPath,
  path,
  active,
  onDirtyChange,
}: WorkspaceFileEditorViewProps) {
  const { t } = useTranslation('terminal');
  const [openFile, setOpenFile] = useState<WorkspaceFile | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const pendingContents = openFile ? normalizeDraftForSave(draft, openFile.contents) : draft;
  const isDirty = !!openFile && pendingContents !== openFile.contents;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setSaving(false);
    setError(null);
    setStatus(null);
    try {
      const file = await workspaceFiles.read(rootPath, path);
      setOpenFile(file);
      setDraft(file.contents);
    } catch (loadError) {
      setOpenFile(null);
      setDraft('');
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [path, rootPath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const saveFile = useCallback(async () => {
    if (!openFile || !isDirty) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await workspaceFiles.write(
        rootPath,
        openFile.path,
        pendingContents,
        openFile.modifiedUnixMs ?? null,
      );
      setOpenFile(saved);
      setDraft(saved.contents);
      setStatus(t('workspace.saved', { defaultValue: 'Saved.' }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [isDirty, openFile, pendingContents, rootPath, t]);

  const reloadFile = useCallback(async () => {
    if (isDirty) {
      const shouldDiscard = await confirmDialog(
        t('workspace.discardChangesConfirm', {
          defaultValue: 'Discard unsaved file changes?',
        }),
        t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
      );
      if (!shouldDiscard) return;
    }
    await loadFile();
  }, [isDirty, loadFile, t]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-[38px] items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-foreground/90">
            {openFile ? basename(openFile.path) : basename(path)}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground" title={path}>
            {path}
          </div>
        </div>
        {isDirty && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            {t('workspace.unsaved', { defaultValue: 'Unsaved' })}
          </span>
        )}
        <IconButton
          title={t('workspace.reload', { defaultValue: 'Reload' })}
          disabled={loading || saving}
          onClick={() => void reloadFile()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title={t('workspace.save', { defaultValue: 'Save' })}
          disabled={loading || saving || !isDirty}
          onClick={() => void saveFile()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </IconButton>
      </div>

      {loading ? (
        <PanelMessage icon={<Loader2 className="h-4 w-4 animate-spin" />} tone="muted">
          {t('workspace.loadingFile', { defaultValue: 'Loading file...' })}
        </PanelMessage>
      ) : error ? (
        <PanelMessage icon={<AlertTriangle className="h-4 w-4" />} tone="error">
          {error}
        </PanelMessage>
      ) : openFile ? (
        <>
          <WorkspaceCodeEditor
            value={draft}
            path={openFile.path}
            active={active}
            onChange={(nextDraft) => {
              setDraft(nextDraft);
              setStatus(null);
            }}
            onSave={saveFile}
          />
          <div className="flex items-center gap-2 border-t border-white/10 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>{formatBytes(openFile.sizeBytes)}</span>
            {openFile.modifiedUnixMs && (
              <span>{new Date(openFile.modifiedUnixMs).toLocaleString()}</span>
            )}
            {status && <span className="ml-auto text-emerald-400">{status}</span>}
          </div>
        </>
      ) : (
        <PanelMessage icon={<FileText className="h-4 w-4" />} tone="muted">
          {t('workspace.noFileSelected', { defaultValue: 'No file selected' })}
        </PanelMessage>
      )}
    </div>
  );
}

export function WorkspaceDiffView({
  change,
  active,
  onOpenFile,
  onDirtyChange,
}: WorkspaceDiffViewProps) {
  const { t } = useTranslation('terminal');
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof git.changes.textDiff>> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const sections = diff?.sections ?? [];
  const isDirty = useMemo(
    () =>
      sections.some((section) => {
        if (!section.editable) return false;
        const draft = drafts[sectionKey(section)] ?? section.currentContents;
        return normalizeDraftForSave(draft, section.currentContents) !== section.currentContents;
      }),
    [drafts, sections],
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const loadDiff = useCallback(async () => {
    setDiff(null);
    setLoading(true);
    setSaving(false);
    setError(null);
    setStatus(null);
    try {
      const nextDiff = await git.changes.textDiff(change.repositoryRoot, change.path);
      setDiff(nextDiff);
      setDrafts(
        Object.fromEntries(
          nextDiff.sections.map((section) => [sectionKey(section), section.currentContents]),
        ),
      );
    } catch (diffError) {
      setError(diffError instanceof Error ? diffError.message : String(diffError));
      setDrafts({});
    } finally {
      setLoading(false);
    }
  }, [change.path, change.repositoryRoot]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const saveDiff = useCallback(async () => {
    if (!diff || !isDirty) return;
    const dirtySection = diff.sections.find((section) => {
      if (!section.editable) return false;
      const draft = drafts[sectionKey(section)] ?? section.currentContents;
      return normalizeDraftForSave(draft, section.currentContents) !== section.currentContents;
    });
    if (!dirtySection) return;

    const draft = drafts[sectionKey(dirtySection)] ?? dirtySection.currentContents;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await workspaceFiles.write(
        change.repositoryRoot,
        change.absolutePath,
        normalizeDraftForSave(draft, dirtySection.currentContents),
        dirtySection.currentModifiedUnixMs ?? null,
      );
      await loadDiff();
      setStatus(t('workspace.saved', { defaultValue: 'Saved.' }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [change.absolutePath, change.repositoryRoot, diff, drafts, isDirty, loadDiff, t]);

  const reloadDiff = useCallback(async () => {
    if (isDirty) {
      const shouldDiscard = await confirmDialog(
        t('workspace.discardChangesConfirm', {
          defaultValue: 'Discard unsaved file changes?',
        }),
        t('workspace.unsavedTitle', { defaultValue: 'Unsaved changes' }),
      );
      if (!shouldDiscard) return;
    }
    await loadDiff();
  }, [isDirty, loadDiff, t]);

  const openFile = useCallback(() => {
    onOpenFile(change.repositoryRoot, {
      name: basename(change.absolutePath),
      path: change.absolutePath,
      isDir: false,
      isHidden: false,
    });
  }, [change.absolutePath, change.repositoryRoot, onOpenFile]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-[38px] items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <GitCompare className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-foreground/90">{basename(change.path)}</div>
          <div
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={`${change.path} · ${change.repositoryRoot}`}
          >
            {change.path} · {change.repositoryRoot}
          </div>
        </div>
        {isDirty && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            {t('workspace.unsaved', { defaultValue: 'Unsaved' })}
          </span>
        )}
        <button
          type="button"
          onClick={openFile}
          className="rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t('workspace.openFile', { defaultValue: 'Open file' })}
        </button>
        <IconButton
          title={t('workspace.reload', { defaultValue: 'Reload' })}
          disabled={loading || saving}
          onClick={() => void reloadDiff()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title={t('workspace.save', { defaultValue: 'Save' })}
          disabled={loading || saving || !isDirty}
          onClick={() => void saveDiff()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </IconButton>
      </div>

      {loading ? (
        <PanelMessage icon={<Loader2 className="h-4 w-4 animate-spin" />} tone="muted">
          {t('workspace.loadingDiff', { defaultValue: 'Loading diff...' })}
        </PanelMessage>
      ) : error ? (
        <PanelMessage icon={<AlertTriangle className="h-4 w-4" />} tone="error">
          {error}
        </PanelMessage>
      ) : diff?.isBinary ? (
        <PanelMessage icon={<AlertTriangle className="h-4 w-4" />} tone="muted">
          {t('workspace.binaryDiff', { defaultValue: 'Binary diff is not shown.' })}
        </PanelMessage>
      ) : sections.length > 0 ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <DiffSections
              active={active}
              drafts={drafts}
              sections={sections}
              path={change.path}
              t={t}
              onDraftChange={(section, draft) => {
                setDrafts((current) => ({ ...current, [sectionKey(section)]: draft }));
                setStatus(null);
              }}
              onSave={saveDiff}
              onStatus={setStatus}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-white/10 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>{t('workspace.diffDraftHint', { defaultValue: 'Diff edits are saved to the working tree.' })}</span>
            {status && <span className="ml-auto text-emerald-400">{status}</span>}
          </div>
        </>
      ) : (
        <PanelMessage icon={<GitCompare className="h-4 w-4" />} tone="muted">
          {change.isUntracked
            ? t('workspace.untrackedNoDiff', {
                defaultValue: 'Untracked files have no diff until staged.',
              })
            : t('workspace.emptyDiff', { defaultValue: 'No textual diff for this file.' })}
        </PanelMessage>
      )}
    </div>
  );
}

function DiffSections({
  active,
  drafts,
  sections,
  path,
  t,
  onDraftChange,
  onSave,
  onStatus,
}: {
  active: boolean;
  drafts: Record<string, string>;
  sections: GitTextDiffSection[];
  path: string;
  t: TerminalTranslator;
  onDraftChange: (section: GitTextDiffSection, draft: string) => void;
  onSave: () => void;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <DiffBlock
          key={sectionKey(section)}
          active={active}
          section={section}
          draft={drafts[sectionKey(section)] ?? section.currentContents}
          path={path}
          t={t}
          onDraftChange={(draft) => onDraftChange(section, draft)}
          onSave={onSave}
          onStatus={onStatus}
        />
      ))}
    </div>
  );
}

function DiffBlock({
  active,
  section,
  draft,
  path,
  t,
  onDraftChange,
  onSave,
  onStatus,
}: {
  active: boolean;
  section: GitTextDiffSection;
  draft: string;
  path: string;
  t: TerminalTranslator;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onStatus: (message: string) => void;
}) {
  const title =
    section.kind === 'staged'
      ? t('workspace.stagedDiff', { defaultValue: 'Staged diff' })
      : t('workspace.unstagedDiff', { defaultValue: 'Unstaged diff' });

  return (
    <section className="flex h-[min(72vh,760px)] min-h-[420px] flex-col overflow-hidden rounded border border-white/10 bg-black/15">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <span>{title}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', section.editable ? 'bg-emerald-500/10 text-emerald-300' : 'bg-muted/40 text-muted-foreground')}>
          {section.editable
            ? t('workspace.diffEditable', { defaultValue: 'Editable' })
            : t('workspace.diffReadOnly', { defaultValue: 'Read-only' })}
        </span>
      </div>
      <div className="grid grid-cols-2 border-b border-white/10 bg-muted/20 text-[10px] font-medium text-muted-foreground">
        <div className="border-r border-white/10 px-3 py-1">{section.baseLabel}</div>
        <div className="px-3 py-1">{section.currentLabel}</div>
      </div>
      <WorkspaceMergeDiffEditor
        path={path}
        baseValue={section.baseContents}
        currentValue={draft}
        editable={section.editable}
        active={active}
        labels={{
          editableDiff: t('workspace.diffEditableHint', {
            defaultValue: 'Right side is editable. Changes stay as a draft until saved.',
          }),
          readOnlyDiff: t('workspace.diffReadOnlyHint', {
            defaultValue: 'This diff section is read-only.',
          }),
          editLine: t('workspace.editLine', { defaultValue: 'Edit line' }),
          revertLine: t('workspace.revertLine', { defaultValue: 'Revert line' }),
          revertHunk: t('workspace.revertHunk', { defaultValue: 'Revert hunk' }),
          revertedLine: t('workspace.revertedLine', { defaultValue: 'Reverted line in draft.' }),
          revertedHunk: t('workspace.revertedHunk', { defaultValue: 'Reverted hunk in draft.' }),
          revertedHunkFallback: t('workspace.revertedHunkFallback', {
            defaultValue: 'Line mapping failed; reverted hunk in draft.',
          }),
        }}
        onCurrentChange={onDraftChange}
        onSave={onSave}
        onStatus={onStatus}
      />
    </section>
  );
}

function sectionKey(section: GitTextDiffSection): string {
  return section.kind;
}

function PanelMessage({
  icon,
  tone,
  children,
}: {
  icon: ReactNode;
  tone: 'muted' | 'error';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[160px] items-center justify-center gap-2 px-4 text-center text-[12px]',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground/75',
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeDraftForSave(draft: string, original: string): string {
  const crlfCount = (original.match(/\r\n/g) ?? []).length;
  const lfCount = (original.replace(/\r\n/g, '').match(/\n/g) ?? []).length;
  if (crlfCount > 0 && crlfCount >= lfCount) {
    return draft.replace(/\r?\n/g, '\r\n');
  }
  return draft;
}
