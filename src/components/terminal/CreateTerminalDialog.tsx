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
import { motion, AnimatePresence } from 'framer-motion';
import { Folder, Terminal, X } from 'lucide-react';
import { terminalTypeMeta } from './terminalTypeMeta';
import type { TerminalCreateOptions, TerminalType } from '../../types/terminal';

export interface RecentProject {
  path: string;
  name: string;
}

interface CreateTerminalDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (options: TerminalCreateOptions) => void;
  recentProjects?: RecentProject[];
}

const typeList = Object.entries(terminalTypeMeta) as [TerminalType, typeof terminalTypeMeta[TerminalType]][];

export function CreateTerminalDialog({
  open,
  onClose,
  onCreate,
  recentProjects = [],
}: CreateTerminalDialogProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [type, setType] = useState<TerminalType>('shell');
  const [command, setCommand] = useState('');

  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

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

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 20 }}
            transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl"
          >
            <form onSubmit={handleSubmit}>
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border px-5 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Terminal className="h-4 w-4" />
                  </div>
                  <h2 className="text-base font-semibold">New terminal</h2>
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
                      Recent projects
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
                  <label className="text-xs font-medium">Project</label>
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Project name"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/absolute/path/to/project"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                {/* Type grid */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Type</label>
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
                              : 'border-border hover:border-primary/40 hover:bg-accent/40',
                          ].join(' ')}
                        >
                          <Icon className={`h-4 w-4 ${meta.accent}`} />
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Initial command */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">
                    Initial command <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="e.g. npm run dev"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Leave empty to use the type&apos;s default command
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
              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-3 py-1.5 text-sm hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
