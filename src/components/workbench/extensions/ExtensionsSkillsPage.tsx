import { FilePlus2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../../lib/utils';
import SkillEditorPage from './SkillEditorPage';
import { useSkills } from './useSkills';

type ExtensionsSkillsPageProps = {
  createRequestToken?: number;
  onCreateRequestHandled?: () => void;
};

export default function ExtensionsSkillsPage({
  createRequestToken = 0,
  onCreateRequestHandled,
}: ExtensionsSkillsPageProps) {
  const { t } = useTranslation('sidebar');
  const {
    groupedSkills,
    roots,
    selectedSkill,
    selectedSkillId,
    isLoadingList,
    isLoadingSkill,
    isSaving,
    error,
    setError,
    setSelectedSkill,
    setSelectedSkillId,
    loadSkills,
    selectSkill,
    createSkill,
    updateSkill,
    deleteSkill,
  } = useSkills();
  const [search, setSearch] = useState('');
  const [createNonce, setCreateNonce] = useState(0);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const triggerCreate = useCallback(() => {
    setSelectedSkill(null);
    setSelectedSkillId(null);
    setError(null);
    setCreateNonce((value) => value + 1);
  }, [setError, setSelectedSkill, setSelectedSkillId]);

  useEffect(() => {
    if (!createRequestToken) {
      return;
    }

    triggerCreate();
    onCreateRequestHandled?.();
  }, [createRequestToken, onCreateRequestHandled, triggerCreate]);

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return groupedSkills;
    }

    return groupedSkills
      .map((group) => ({
        ...group,
        items: group.items.filter((skill) => {
          const haystack = `${skill.name} ${skill.slug} ${skill.description} ${skill.rootLabel}`.toLowerCase();
          return haystack.includes(query);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupedSkills, search]);

  const totalCount = groupedSkills.reduce((count, group) => count + group.items.length, 0);

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex h-full w-[328px] flex-shrink-0 flex-col border-r border-border/60 bg-card/50">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
              <h1 className="mt-1 text-base font-semibold text-foreground">{t('workbench.skills')}</h1>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('workbench.skillsPage.subtitle')}</p>
            </div>
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
              {totalCount}
            </Badge>
          </div>

          <div className="mt-3 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('workbench.skillsPage.searchPlaceholder')}
                className="h-8 rounded-lg border-border/70 bg-background pl-8 text-[13px]"
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => void loadSkills()}
              title={t('actions.refresh')}
              className="h-8 w-8 rounded-lg border-border/70"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          <Button type="button" className="mt-2 h-8 w-full justify-center rounded-lg text-[13px]" onClick={triggerCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            {t('workbench.skillsPage.newSkill')}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {isLoadingList ? (
            <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-muted-foreground">
              {t('workbench.skillsPage.loading')}
            </div>
          ) : null}

          <div className="space-y-3">
            {filteredGroups.map((group) => (
              <section key={group.root.id} className="space-y-1.5">
                <div className="flex items-start justify-between gap-3 px-1.5">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {group.root.label}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{group.root.path}</div>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                    {group.items.length}
                  </Badge>
                </div>

                <div className="space-y-1">
                  {group.items.map((skill) => {
                    const isSelected = selectedSkillId === skill.id;

                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => {
                          setCreateNonce(0);
                          void selectSkill(skill.id);
                        }}
                        className={cn(
                          'group relative w-full overflow-hidden rounded-xl border px-3 py-2 text-left transition-all',
                          isSelected
                            ? 'border-foreground/12 bg-background shadow-sm ring-1 ring-foreground/6'
                            : 'border-transparent bg-transparent hover:border-border/70 hover:bg-background/80',
                        )}
                      >
                        <div
                          className={cn(
                            'absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-transparent transition-colors',
                            isSelected ? 'bg-foreground/80' : 'group-hover:bg-border',
                          )}
                        />
                        <div className="flex items-start justify-between gap-2 pl-1">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium leading-5 text-foreground">{skill.name}</div>
                            <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{skill.slug}</div>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] uppercase',
                              isSelected ? 'border-foreground/15 bg-muted text-foreground' : '',
                            )}
                          >
                            {skill.provider}
                          </Badge>
                        </div>
                        <div className="mt-1 pl-1 text-[11px] leading-4 text-muted-foreground">
                          {skill.description || t('workbench.skillsPage.noDescription')}
                        </div>
                      </button>
                    );
                  })}

                  {group.items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/60 bg-background px-3 py-2.5 text-xs text-muted-foreground">
                      {t('workbench.skillsPage.noSkillsInRoot')}
                    </div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>

          {!isLoadingList && filteredGroups.length === 0 ? (
            <div className="mt-2 rounded-lg border border-dashed border-border/60 bg-background px-3.5 py-3 text-sm text-muted-foreground">
              {t('workbench.skillsPage.noMatching')}
            </div>
          ) : null}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 bg-background">
        {error ? (
          <div className="border-b border-red-300/50 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200">
            {error}
          </div>
        ) : null}
        <SkillEditorPage
          roots={roots}
          skill={selectedSkill}
          isLoading={isLoadingSkill}
          isSaving={isSaving}
          createNonce={createNonce}
          onCreate={async (payload) => {
            await createSkill(payload);
          }}
          onSave={async (skillId, content) => {
            await updateSkill(skillId, content);
          }}
          onDelete={async (skillId) => {
            await deleteSkill(skillId);
          }}
        />
      </main>
    </div>
  );
}
