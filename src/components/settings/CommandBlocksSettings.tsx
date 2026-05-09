/**
 * CommandBlocksSettings — Stage 3 entry point for the OSC 133/6973 layer.
 *
 * Spec (IMPLEMENTATION_PLAN.md L92, L110):
 *   1. Default off; user must opt-in per shell from this panel.
 *   2. Show a unified diff of the rc file change before writing anything.
 *   3. Confirmation step is the diff itself; the user clicks Install only
 *      after seeing what would land in their `~/.zshrc` etc.
 *   4. Toggling install/uninstall flips the runtime parser switch in Rust
 *      so block events fire only when at least one shell is wired up.
 */
import { useEffect, useMemo, useState } from 'react';
import { Blocks, Eye, Power, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isTauriEnv,
  pty,
  shellIntegration,
  type ShellIntegrationPreview,
  type SupportedShell,
} from '../../lib/tauri-bridge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const ALL_SHELLS: SupportedShell[] = ['zsh', 'bash', 'fish', 'pwsh'];

type ActionState = 'idle' | 'busy' | 'failed';

interface ShellRowProps {
  shell: SupportedShell;
  detected: boolean;
  preview: ShellIntegrationPreview | null;
  installed: boolean;
  isBusy: boolean;
  onPreview: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

function ShellRow({
  shell,
  detected,
  preview,
  installed,
  isBusy,
  onPreview,
  onInstall,
  onUninstall,
}: ShellRowProps) {
  const { t } = useTranslation('settings');
  const status = installed
    ? t('commandBlocks.installed')
    : t('commandBlocks.notInstalled');

  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {t(`commandBlocks.shells.${shell}`)}
            <Badge variant={installed ? 'secondary' : 'outline'} className={installed ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20' : 'text-muted-foreground'}>
              {status}
            </Badge>
            {detected && (
              <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/20">
                {t('commandBlocks.detectedShellLabel')}
              </Badge>
            )}
          </div>
          {preview?.rcPath && (
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
              {t('commandBlocks.rcPathLabel')} {preview.rcPath}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onPreview}
            disabled={isBusy}
          >
            <Eye />
            {t('commandBlocks.preview')}
          </Button>
          {installed ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={onUninstall}
              disabled={isBusy}
            >
              {t('commandBlocks.uninstall')}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={onInstall}
              disabled={isBusy || !preview || preview.noChanges}
            >
              <Power />
              {t('commandBlocks.install')}
            </Button>
          )}
        </div>
      </div>

      {preview && (
        <div className="mt-3">
          {preview.noChanges ? (
            <p className="text-xs text-muted-foreground">
              {t('commandBlocks.noChanges')}
            </p>
          ) : (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('commandBlocks.diffTitle')}
              </div>
              <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border/60 bg-card/60 p-2 font-mono text-[11px] leading-5 text-foreground">
                {preview.diff}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CommandBlocksSettings() {
  const { t } = useTranslation('settings');

  const [detectedShell, setDetectedShell] = useState<SupportedShell | null>(null);
  const [previews, setPreviews] = useState<Partial<Record<SupportedShell, ShellIntegrationPreview>>>({});
  const [installedShells, setInstalledShells] = useState<Set<SupportedShell>>(new Set());
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isBusy = actionState === 'busy';

  const refreshAll = async () => {
    if (!isTauriEnv()) return;
    setError(null);

    try {
      const detected = await shellIntegration.detectShell();
      setDetectedShell(detected);

      // Refresh preview for every supported shell so we can derive
      // installed/not-installed state from `noChanges` (when the rc already
      // contains the integration block, `build_installed_content` is a
      // no-op and `noChanges === true`).
      const entries = await Promise.all(
        ALL_SHELLS.map(async (shell) => {
          try {
            const preview = await shellIntegration.preview(shell);
            return [shell, preview] as const;
          } catch {
            return [shell, null] as const;
          }
        }),
      );
      const next: Partial<Record<SupportedShell, ShellIntegrationPreview>> = {};
      const installed = new Set<SupportedShell>();
      for (const [shell, preview] of entries) {
        if (!preview) continue;
        next[shell] = preview;
        if (preview.noChanges && preview.before.includes('# >>> threadterm shell integration')) {
          installed.add(shell);
        }
      }
      setPreviews(next);
      setInstalledShells(installed);

      // Keep the runtime parser gated on whether at least one shell is
      // wired up. Without this we could leak block events from a previous
      // session where the user uninstalled mid-run.
      try {
        await pty.setCommandBlocksEnabled(installed.size > 0);
      } catch {
        // Non-fatal; the next install/uninstall will sync it.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    refreshAll();
  }, []);

  const handlePreview = async (shell: SupportedShell) => {
    setActionState('busy');
    setError(null);
    setSuccess(null);
    try {
      const preview = await shellIntegration.preview(shell);
      setPreviews((prev) => ({ ...prev, [shell]: preview }));
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const handleInstall = async (shell: SupportedShell) => {
    setActionState('busy');
    setError(null);
    setSuccess(null);
    try {
      await shellIntegration.install(shell);
      const nextInstalled = new Set(installedShells);
      nextInstalled.add(shell);
      setInstalledShells(nextInstalled);
      // Re-preview so the diff collapses to "no changes" and the user can
      // see the install actually landed.
      const refreshed = await shellIntegration.preview(shell);
      setPreviews((prev) => ({ ...prev, [shell]: refreshed }));
      await pty.setCommandBlocksEnabled(nextInstalled.size > 0);
      setSuccess(t('commandBlocks.installSuccess', { shell: t(`commandBlocks.shells.${shell}`) }));
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const handleUninstall = async (shell: SupportedShell) => {
    setActionState('busy');
    setError(null);
    setSuccess(null);
    try {
      await shellIntegration.uninstall(shell);
      const nextInstalled = new Set(installedShells);
      nextInstalled.delete(shell);
      setInstalledShells(nextInstalled);
      const refreshed = await shellIntegration.preview(shell);
      setPreviews((prev) => ({ ...prev, [shell]: refreshed }));
      await pty.setCommandBlocksEnabled(nextInstalled.size > 0);
      setSuccess(t('commandBlocks.uninstallSuccess', { shell: t(`commandBlocks.shells.${shell}`) }));
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const detectedLabel = useMemo(() => {
    if (!detectedShell) return t('commandBlocks.detectedShellUnknown');
    return t(`commandBlocks.shells.${detectedShell}`);
  }, [detectedShell, t]);

  return (
    <section className="rounded-xl border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Blocks className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('commandBlocks.title')}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('commandBlocks.description')}
          </p>
          {!isTauriEnv() && (
            <p className="mt-2 text-xs text-amber-600">
              {t('commandBlocks.desktopOnly')}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {t('commandBlocks.detectedShellLabel')}:
            </span>{' '}
            {detectedLabel}
          </p>
          {error && (
            <p className="mt-2 text-xs text-destructive">
              {t('commandBlocks.error', { message: error })}
            </p>
          )}
          {success && !error && (
            <p className="mt-2 text-xs text-green-600">{success}</p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={!isTauriEnv() || isBusy}
          className="shrink-0"
        >
          <RefreshCw className={isBusy ? "animate-spin" : ""} />
          {t('mobileAccess.refresh')}
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {ALL_SHELLS.map((shell) => (
          <ShellRow
            key={shell}
            shell={shell}
            detected={detectedShell === shell}
            preview={previews[shell] ?? null}
            installed={installedShells.has(shell)}
            isBusy={isBusy}
            onPreview={() => handlePreview(shell)}
            onInstall={() => handleInstall(shell)}
            onUninstall={() => handleUninstall(shell)}
          />
        ))}
      </div>
    </section>
  );
}
