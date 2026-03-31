import { Blocks, ChevronRight, PlugZap, Plus, RefreshCw, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { formatTimeAgo } from '../../../utils/dateUtils';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { useExtensionsOverview } from './useExtensionsOverview';

type ExtensionsOverviewPageProps = {
  onOpenSkills: () => void;
  onCreateSkill: () => void;
  onOpenMcp: () => void;
  onCreateMcp: (provider?: 'claude' | 'codex') => void;
};

function OverviewCard({
  icon: Icon,
  title,
  description,
  badge,
  actions,
  children,
}: {
  icon: typeof Blocks;
  title: string;
  description: string;
  badge: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              {badge}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="hidden flex-shrink-0 items-center gap-1.5 lg:flex">{actions}</div>
      </div>

      <div className="mt-3.5">{children}</div>

      <div className="mt-3 flex flex-wrap gap-1.5 lg:hidden">{actions}</div>
    </section>
  );
}

function ActionButton({
  label,
  icon: Icon,
  onClick,
  variant = 'default',
}: {
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  variant?: 'default' | 'outline';
}) {
  return (
    <Button type="button" size="sm" variant={variant} onClick={onClick} className="h-8 rounded-lg px-2.5 text-[13px]">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

function StatPill({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

export default function ExtensionsOverviewPage({
  onOpenSkills,
  onCreateSkill,
  onOpenMcp,
  onCreateMcp,
}: ExtensionsOverviewPageProps) {
  const { t } = useTranslation('sidebar');
  const { isLoading, skills, mcp, hints, reload } = useExtensionsOverview();
  const currentTime = useMemo(() => new Date(), [skills.recentSkills]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-4 lg:px-6">
        <header className="flex flex-col gap-3 rounded-[22px] border border-border/60 bg-card/72 px-4 py-3.5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{t('workbench.extensionsOverview.title')}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('workbench.extensionsOverview.subtitle')}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void reload()} className="h-8 rounded-lg border-border/70 px-2.5 text-[13px]">
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading ? 'animate-spin' : '')} />
            {t('workbench.extensionsOverview.actions.refresh')}
          </Button>
        </header>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)]">
          <OverviewCard
            icon={Blocks}
            title={t('workbench.skills')}
            description={t('workbench.extensionsOverview.skills.description')}
            badge={<Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">{skills.totalCount}</Badge>}
            actions={(
              <>
                <ActionButton label={t('workbench.extensionsOverview.actions.openSkills')} icon={ChevronRight} onClick={onOpenSkills} variant="outline" />
                <ActionButton label={t('workbench.extensionsOverview.actions.newSkill')} icon={Plus} onClick={onCreateSkill} />
              </>
            )}
          >
            {skills.error ? (
              <div className="rounded-lg border border-red-300/50 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200">
                {skills.error}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <StatPill label={t('workbench.extensionsOverview.skills.countLabel')} value={skills.totalCount} />
                  <StatPill label={t('workbench.extensionsOverview.skills.writableRootsLabel')} value={skills.writableRootCount} />
                </div>

                <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {t('workbench.extensionsOverview.skills.recentTitle')}
                  </div>
                  {skills.recentSkills.length > 0 ? (
                    <div className="space-y-1.5">
                      {skills.recentSkills.map((skill) => (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={onOpenSkills}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-left transition-colors hover:bg-muted/45"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium leading-5 text-foreground">{skill.name}</span>
                              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                                {skill.provider}
                              </Badge>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                              <span className="truncate">{skill.rootLabel}</span>
                              <span className="text-muted-foreground/40">/</span>
                              <span className="truncate">{skill.slug}</span>
                            </div>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1.5 pl-2 text-[11px] text-muted-foreground">
                            <span>{formatTimeAgo(skill.updatedAt, currentTime, t)}</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground">
                      {t('workbench.extensionsOverview.skills.empty')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </OverviewCard>

          <OverviewCard
            icon={PlugZap}
            title={t('workbench.mcp')}
            description={t('workbench.extensionsOverview.mcp.description')}
            badge={<Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">{mcp.totalCount}</Badge>}
            actions={(
              <>
                <ActionButton label={t('workbench.extensionsOverview.actions.openMcp')} icon={ChevronRight} onClick={onOpenMcp} variant="outline" />
                <ActionButton label={t('workbench.extensionsOverview.actions.addMcp')} icon={Plus} onClick={() => onCreateMcp('claude')} />
              </>
            )}
          >
            <div className="space-y-3">
              {mcp.error ? (
                <div className="rounded-lg border border-red-300/50 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200">
                  {mcp.error}
                </div>
              ) : null}

              <div className="grid gap-2 sm:grid-cols-3">
                <StatPill label={t('workbench.extensionsOverview.mcp.totalLabel')} value={mcp.totalCount} />
                <StatPill label="Claude" value={mcp.claudeCount} />
                <StatPill label="Codex" value={mcp.codexCount} />
              </div>

              <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('workbench.extensionsOverview.mcp.summaryTitle')}
                </div>
                <div className="mt-1.5 text-sm font-medium text-foreground">
                  {mcp.totalCount > 0
                    ? t('workbench.extensionsOverview.mcp.readyTitle')
                    : t('workbench.extensionsOverview.mcp.emptyTitle')}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {mcp.totalCount > 0
                    ? t('workbench.extensionsOverview.mcp.ready')
                    : t('workbench.extensionsOverview.mcp.empty')}
                </p>
              </div>
            </div>
          </OverviewCard>
        </div>

        <section className="rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
          <div className="mb-2.5 flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-foreground">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('workbench.extensionsOverview.hints.title')}</h2>
              <p className="text-xs leading-5 text-muted-foreground">{t('workbench.extensionsOverview.hints.subtitle')}</p>
            </div>
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            {hints.map((hint) => (
              <div
                key={hint.id}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-sm leading-5',
                  hint.tone === 'warning'
                    ? 'border-amber-400/40 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-100'
                    : 'border-border/60 bg-background text-foreground/90',
                )}
              >
                {hint.message}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
