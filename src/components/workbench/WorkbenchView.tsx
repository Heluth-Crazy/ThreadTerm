import {
  ArrowLeft,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AttentionItem,
  ProjectWorkbenchOverview,
  WorkbenchAttentionFilter,
  WorkbenchSummary as WorkbenchSummaryData,
} from '../../lib/workbench/types';
import type { TerminalCard } from '../../types/terminal';
import { AttentionItemsDialog } from './AttentionItemsDialog';
import { FollowedTerminalSection } from './FollowedTerminalSection';
import { ProjectOverviewGrid } from './ProjectOverviewGrid';
import { RecallTerminalDialog } from './RecallTerminalDialog';
import { WorkbenchAttentionSection } from './WorkbenchAttentionSection';
import { WorkbenchEmptyTerminalState } from './WorkbenchEmptyTerminalState';
import { FollowedTerminalsDialog, TerminalsListDialog } from './WorkbenchListDialogs';
import { WorkbenchStalledSection } from './WorkbenchStalledSection';
import { WorkbenchStatStrip } from './WorkbenchStatStrip';
import {
  attentionSearchText,
  followedTerminalSearchText,
} from './workbenchPresentation';

interface WorkbenchViewProps {
  cards: readonly TerminalCard[];
  allCards: readonly TerminalCard[];
  attentionItems: readonly AttentionItem[];
  stalledItems: readonly AttentionItem[];
  followedCards: readonly TerminalCard[];
  followedCardIds: readonly string[];
  projectOverviews: readonly ProjectWorkbenchOverview[];
  summary: WorkbenchSummaryData;
  now: number;
  scopeLabel: string | null;
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
  onOpenTerminal: (cardId: string) => void;
  onAcknowledgeAttention: (item: AttentionItem) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onIgnoreAttention: (item: AttentionItem) => void;
  onOpenRules: () => void;
  onCreateTerminal: () => void;
  onFollowCards: (cardIds: readonly string[]) => void;
  onUnfollowCard: (cardId: string) => void;
  onSelectProject: (projectPath: string) => void;
  onShowAllProjects: () => void;
}

export function WorkbenchView({
  cards,
  allCards,
  attentionItems,
  stalledItems,
  followedCards,
  followedCardIds,
  projectOverviews,
  summary,
  now,
  scopeLabel,
  selectedProjectPath,
  selectedWorktreePath,
  onOpenTerminal,
  onAcknowledgeAttention,
  onOpenAttention,
  onIgnoreAttention,
  onOpenRules,
  onCreateTerminal,
  onFollowCards,
  onUnfollowCard,
  onSelectProject,
  onShowAllProjects,
}: WorkbenchViewProps) {
  const { t } = useTranslation('terminal');
  const [query, setQuery] = useState('');
  const [recallOpen, setRecallOpen] = useState(false);
  const [stalledExpanded, setStalledExpanded] = useState(false);
  const handleOpenAttentionItem = useCallback(
    (item: AttentionItem) => {
      onOpenTerminal(item.cardId);
      if (item.kind === 'review') {
        onAcknowledgeAttention(item);
      }
    },
    [onAcknowledgeAttention, onOpenTerminal],
  );
  // 需要处理卡片外不再带筛选；点统计条或「查看全部」时带着对应筛选打开弹窗
  const [attentionDialog, setAttentionDialog] = useState<{
    open: boolean;
    filter: WorkbenchAttentionFilter;
  }>({ open: false, filter: 'all' });
  const openAttentionDialog = useCallback(
    (filter: WorkbenchAttentionFilter = 'all') =>
      setAttentionDialog({ open: true, filter }),
    [],
  );
  const closeAttentionDialog = useCallback(
    () => setAttentionDialog((prev) => ({ ...prev, open: false })),
    [],
  );
  const [terminalsDialogOpen, setTerminalsDialogOpen] = useState(false);
  const [followedDialogOpen, setFollowedDialogOpen] = useState(false);
  const openRecall = useCallback(() => setRecallOpen(true), []);
  const closeRecall = useCallback(() => setRecallOpen(false), []);
  const setCardFollowed = useCallback(
    (cardId: string, followed: boolean) => {
      if (followed) onFollowCards([cardId]);
      else onUnfollowCard(cardId);
    },
    [onFollowCards, onUnfollowCard],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const followedIdSet = useMemo(
    () => new Set(followedCardIds),
    [followedCardIds],
  );

  const visibleItems = useMemo(
    () =>
      attentionItems.filter(
        (item) =>
          !normalizedQuery ||
          attentionSearchText(item).includes(normalizedQuery),
      ),
    [attentionItems, normalizedQuery],
  );
  const visibleFollowedCards = useMemo(
    () =>
      followedCards.filter(
        (card) =>
          !normalizedQuery || followedTerminalSearchText(card).includes(normalizedQuery),
      ),
    [followedCards, normalizedQuery],
  );
  const visibleProjectOverviews = useMemo(
    () =>
      projectOverviews.filter(
        (project) =>
          !normalizedQuery ||
          `${project.projectName} ${project.projectPath}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      ),
    [normalizedQuery, projectOverviews],
  );
  const visibleStalledItems = useMemo(
    () =>
      stalledItems.filter(
        (item) =>
          !normalizedQuery || attentionSearchText(item).includes(normalizedQuery),
      ),
    [normalizedQuery, stalledItems],
  );

  return (
    <div
      data-testid="workbench-view"
      className="h-full w-full overflow-y-auto bg-background/20"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-4 pb-8 pt-4 md:px-6 md:pt-5 xl:max-w-[1680px]">
        <header className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="text-[17px] font-semibold">
                {t('workbench.title', { defaultValue: 'Workbench' })}
              </h1>
              {scopeLabel && (
                <>
                  <span
                    title={scopeLabel}
                    className="max-w-48 truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                  >
                    {scopeLabel}
                  </span>
                  <button
                    type="button"
                    onClick={onShowAllProjects}
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-primary"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    {t('workbench.action.allProjects', {
                      defaultValue: 'All projects',
                    })}
                  </button>
                </>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t('workbench.subtitle', {
                defaultValue: 'Deterministic signals from your active terminals',
              })}
            </p>
          </div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:flex-initial">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card/70 px-3 focus-within:border-primary/50 sm:w-64">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="sr-only">
                {t('workbench.searchLabel', { defaultValue: 'Search workbench' })}
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.searchPlaceholder', {
                  defaultValue: 'Search project, branch, or output',
                })}
                className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <button
              type="button"
              onClick={onOpenRules}
              title={t('workbench.rules.title', { defaultValue: 'Attention rules' })}
              aria-label={t('workbench.rules.title', { defaultValue: 'Attention rules' })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card/70 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <WorkbenchStatStrip
          attentionCount={summary.attention}
          terminalCount={cards.length}
          followedCount={followedCards.length}
          onOpenAttention={() => openAttentionDialog('all')}
          onOpenTerminals={() => setTerminalsDialogOpen(true)}
          onOpenFollowed={() => setFollowedDialogOpen(true)}
        />

        {cards.length === 0 ? (
          <>
            <FollowedTerminalSection
              cards={visibleFollowedCards}
              totalCount={followedCards.length}
              now={now}
              queryActive={Boolean(normalizedQuery)}
              onOpenTerminal={onOpenTerminal}
              onUnfollowCard={onUnfollowCard}
              onOpenRecall={openRecall}
            />
            <WorkbenchEmptyTerminalState
              scopeLabel={scopeLabel}
              onCreateTerminal={onCreateTerminal}
            />
          </>
        ) : !selectedProjectPath ? (
          // 总工作台：左侧项目总览为主区，右侧列依次为需要处理 / 无进展 / 关注列表；
          // 卡片高度撑满可视区域（min-h-full + items-stretch），空态不塌缩。
          <div className="mt-5 grid flex-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-w-0 flex-col">
              <ProjectOverviewGrid
                className="flex-1"
                projects={visibleProjectOverviews}
                onSelectProject={onSelectProject}
              />
            </div>

            <aside className="flex min-h-0 flex-col gap-4">
              <WorkbenchAttentionSection
                className="flex-1"
                cardLayout="compact"
                items={visibleItems}
                followedCardIds={followedIdSet}
                now={now}
                queryActive={Boolean(normalizedQuery)}
                onOpenAll={() => openAttentionDialog('all')}
                onOpenItem={handleOpenAttentionItem}
                onOpenAttention={onOpenAttention}
                onIgnoreAttention={onIgnoreAttention}
                onSetCardFollowed={setCardFollowed}
              />
              <WorkbenchStalledSection
                cardLayout="compact"
                items={visibleStalledItems}
                expanded={stalledExpanded}
                followedCardIds={followedIdSet}
                now={now}
                onToggleExpanded={() => setStalledExpanded((value) => !value)}
                onOpenTerminal={onOpenTerminal}
                onOpenAttention={onOpenAttention}
                onIgnoreAttention={onIgnoreAttention}
                onSetCardFollowed={setCardFollowed}
              />
              <FollowedTerminalSection
                className="flex-1"
                cards={visibleFollowedCards}
                totalCount={followedCards.length}
                now={now}
                queryActive={Boolean(normalizedQuery)}
                onOpenTerminal={onOpenTerminal}
                onUnfollowCard={onUnfollowCard}
                onOpenRecall={openRecall}
              />
            </aside>
          </div>
        ) : (
          <div className="mt-5 grid flex-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col">
              <WorkbenchAttentionSection
                className="flex-1"
                items={visibleItems}
                followedCardIds={followedIdSet}
                now={now}
                queryActive={Boolean(normalizedQuery)}
                onOpenAll={() => openAttentionDialog('all')}
                onOpenItem={handleOpenAttentionItem}
                onOpenAttention={onOpenAttention}
                onIgnoreAttention={onIgnoreAttention}
                onSetCardFollowed={setCardFollowed}
              />
              <WorkbenchStalledSection
                items={visibleStalledItems}
                expanded={stalledExpanded}
                followedCardIds={followedIdSet}
                now={now}
                onToggleExpanded={() =>
                  setStalledExpanded((value) => !value)
                }
                onOpenTerminal={onOpenTerminal}
                onOpenAttention={onOpenAttention}
                onIgnoreAttention={onIgnoreAttention}
                onSetCardFollowed={setCardFollowed}
              />
            </div>

            <aside className="flex min-h-0 flex-col">
              <FollowedTerminalSection
                className="flex-1"
                cards={visibleFollowedCards}
                totalCount={followedCards.length}
                now={now}
                queryActive={Boolean(normalizedQuery)}
                onOpenTerminal={onOpenTerminal}
                onUnfollowCard={onUnfollowCard}
                onOpenRecall={openRecall}
              />
            </aside>
          </div>
        )}
      </div>
      <TerminalsListDialog
        open={terminalsDialogOpen}
        cards={cards}
        now={now}
        onClose={() => setTerminalsDialogOpen(false)}
        onOpenTerminal={(cardId) => {
          setTerminalsDialogOpen(false);
          onOpenTerminal(cardId);
        }}
      />
      <FollowedTerminalsDialog
        open={followedDialogOpen}
        cards={visibleFollowedCards}
        now={now}
        onClose={() => setFollowedDialogOpen(false)}
        onOpenTerminal={(cardId) => {
          setFollowedDialogOpen(false);
          onOpenTerminal(cardId);
        }}
        onUnfollowCard={onUnfollowCard}
        onOpenRecall={() => {
          setFollowedDialogOpen(false);
          openRecall();
        }}
      />
      <AttentionItemsDialog
        open={attentionDialog.open}
        items={visibleItems}
        followedCardIds={followedIdSet}
        now={now}
        queryActive={Boolean(normalizedQuery)}
        initialFilter={attentionDialog.filter}
        onClose={closeAttentionDialog}
        onOpenItem={handleOpenAttentionItem}
        onOpenAttention={onOpenAttention}
        onIgnoreAttention={onIgnoreAttention}
        onSetCardFollowed={setCardFollowed}
      />
      <RecallTerminalDialog
        open={recallOpen}
        cards={allCards}
        followedCardIds={followedCardIds}
        selectedProjectPath={selectedProjectPath}
        selectedWorktreePath={selectedWorktreePath}
        onClose={closeRecall}
        onConfirm={onFollowCards}
      />
    </div>
  );
}
