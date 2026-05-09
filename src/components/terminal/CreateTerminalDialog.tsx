/**
 * CreateTerminalDialog — modal for spawning a new terminal.
 *
 * Fields:
 *   • project name + absolute path (prefilled from recent projects chips)
 *   • terminal type (grid of type cards; icon + label)
 *   • optional initial command
 *
 * Validation is purposely lightweight: name + path required, path is taken
 * verbatim (no FS existence check here — PTY spawn will surface errors).
 */
import { useMemo, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Download, Folder, FolderOpen, Terminal, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { terminalTypeMeta } from './terminalTypeMeta';
import { isTauriEnv } from '../../lib/tauri-bridge';
import type { TerminalCreateOptions, TerminalType } from '../../types/terminal';

/** Extract the last path segment (works for both POSIX and Windows paths). */
function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]/);
  return segs[segs.length - 1] ?? '';
}

export interface RecentProject {
  path: string;
  name: string;
}

interface CreateTerminalDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (options: TerminalCreateOptions) => void;
  onImportWorkflow?: (projectPath: string, projectName: string) => void;
  recentProjects?: RecentProject[];
}

const typeList = Object.entries(terminalTypeMeta) as [TerminalType, typeof terminalTypeMeta[TerminalType]][];

export function CreateTerminalDialog({
  open,
  onClose,
  onCreate,
  onImportWorkflow,
  recentProjects = [],
}: CreateTerminalDialogProps) {
  const { t } = useTranslation('terminal');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [type, setType] = useState<TerminalType>('shell');
  const [command, setCommand] = useState('');

  const canSubmit = name.trim().length > 0 && path.trim().length > 0;
  const canImportWorkflow = path.trim().length > 0 && isTauriEnv();

  const uniqueProjects = useMemo(() => {
    const seen = new Set<string>();
    return recentProjects.filter((p) => {
      if (seen.has(p.path)) return false;
      seen.add(p.path);
      return true;
    });
  }, [recentProjects]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onCreate({
      projectName: name.trim(),
      projectPath: path.trim(),
      terminalType: type,
      command: command.trim() || undefined,
    });
    // Reset
    setName('');
    setPath('');
    setType('shell');
    setCommand('');
  };

  const pickRecent = (p: RecentProject) => {
    setName(p.name);
    setPath(p.path);
  };

  const nameWasManuallyEdited = useMemo(
    () => name.trim().length > 0 && name.trim() !== pathBasename(path),
    [name, path],
  );

  /** Apply a new path, auto-deriving the project name from its last segment
   *  unless the user has already typed a name that doesn't match. */
  const applyPath = (nextPath: string) => {
    setPath(nextPath);
    const derived = pathBasename(nextPath);
    if (!derived) return;
    if (!name.trim() || !nameWasManuallyEdited) {
      setName(derived);
    }
  };

  const handleBrowse = async () => {
    if (!isTauriEnv()) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t('dialog.chooseProjectDirectory'),
        defaultPath: path.trim() || undefined,
      });
      if (typeof picked === 'string' && picked) {
        applyPath(picked);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[CreateTerminalDialog] folder picker failed:', err);
    }
  };

  const handleImportWorkflow = () => {
    const projectPath = path.trim();
    if (!projectPath) return;
    onImportWorkflow?.(projectPath, name.trim() || pathBasename(projectPath));
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
      />

      {/* Dialog — flex-centered wrapper, motion only handles scale/opacity
          so framer's transform doesn't overwrite translate-x/y */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: 'spring', damping: 24, stiffness: 300 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-terminal-title"
          className="pointer-events-auto w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-background/80 backdrop-blur-2xl text-card-foreground shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)]"
        >
              <form onSubmit={handleSubmit}>
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Terminal className="h-4 w-4" />
                  </div>
                  <h2 id="create-terminal-title" className="text-base font-semibold">{t('dialog.title')}</h2>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1 hover:bg-accent hover:text-accent-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Body */}
              <div className="space-y-4 p-5">
                {/* Recent projects */}
                {uniqueProjects.length > 0 && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('dialog.recentProjects')}
                    </label>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {uniqueProjects.slice(0, 6).map((p) => (
                        <button
                          key={p.path}
                          type="button"
                          onClick={() => pickRecent(p)}
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] hover:bg-accent hover:text-accent-foreground"
                        >
                          <Folder className="h-3 w-3" />
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Project name + path */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('dialog.project')}</label>
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('dialog.projectNamePlaceholder')}
                    className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <div className="flex gap-1.5">
                    <input
                      value={path}
                      onChange={(e) => applyPath(e.target.value)}
                      placeholder={t('dialog.projectPathPlaceholder')}
                      className="flex-1 rounded-lg border border-white/10 bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      type="button"
                      onClick={handleBrowse}
                      disabled={!isTauriEnv()}
                      title={isTauriEnv() ? t('dialog.browseTitle') : t('dialog.browseDesktopOnly')}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-background px-2.5 py-2 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t('dialog.browse')}
                    </button>
                  </div>
                </div>

                {/* Type grid */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('dialog.type')}</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {typeList.map(([key, meta]) => {
                      const Icon = meta.Icon;
                      const selected = key === type;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setType(key)}
                          className={[
                            'flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10px] transition-colors',
                            selected
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-white/10 hover:border-primary/40 hover:bg-accent/40',
                          ].join(' ')}
                        >
                          <Icon className={`h-4 w-4 ${meta.accent}`} />
                          {t(`types.${key}`, meta.label)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Initial command */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">
                    {t('dialog.initialCommand')}{' '}
                    <span className="text-muted-foreground">({t('dialog.optional')})</span>
                  </label>
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={t('dialog.initialCommandPlaceholder')}
                    className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('dialog.defaultCommandHint')}
                    {terminalTypeMeta[type].defaultCommand && (
                      <>
                        {' '}
                        (<span className="font-mono">{terminalTypeMeta[type].defaultCommand}</span>)
                      </>
                    )}
                    .
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between gap-2 border-t border-white/10 bg-muted/30 px-5 py-3">
                <button
                  type="button"
                  onClick={handleImportWorkflow}
                  disabled={!canImportWorkflow || !onImportWorkflow}
                  title={
                    isTauriEnv()
                      ? t('workflow.importWorkflow', {
                          defaultValue: 'Import workflow from URL...',
                        })
                      : t('dialog.browseDesktopOnly')
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('workflow.importWorkflowShort', { defaultValue: 'Import workflow' })}
                </button>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    {t('dialog.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {t('dialog.create')}
                  </button>
                </div>
              </div>
              </form>
        </motion.div>
      </div>
    </>
  );
}
