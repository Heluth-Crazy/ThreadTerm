import {
  AlertTriangle,
  Bell,
  Bookmark,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Eye,
  FolderGit2,
  FolderKanban,
  Play,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  CardMeta,
  MobileWorkbenchProjection,
  NotificationEntry,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { ConnectionBanner } from '../ConnectionBanner';
import { useI18n } from '../i18n';
import {
  AttentionCard,
  CompatibilityState,
  ExecutionGroupCard,
  FollowedTerminalCard,
  MobileProjectOverviewCard,
  SummaryCard,
  WorkbenchEmptyState,
} from './workbenchComponents';
import {
  ATTENTION_FILTERS,
  attentionMatchesGroup,
  attentionSearchText,
  cardMatchesGroup,
  cardSearchText,
  connectionLabel,
  groupSearchText,
  mobileProjectScopeId,
  mobileScopeOptionLabel,
  type AttentionFilter,
} from './workbenchPresentation';

export function WorkbenchScreen({
  cards,
  notifications,
  onOpenAttention,
  onOpenGroup,
  onOpenNewTerminal,
  onOpenNotifications,
  onOpenRules,
  onOpenTerminal,
  projection,
  warmingUp,
  wsStatus,
}: {
  cards: CardMeta[];
  notifications: NotificationEntry[];
  onOpenAttention: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onOpenNewTerminal: () => void;
  onOpenNotifications: () => void;
  onOpenRules: () => void;
  onOpenTerminal: (cardId: string) => void;
  projection: MobileWorkbenchProjection | null;
  warmingUp: boolean;
  wsStatus: BridgeConnectionState;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scopeId, setScopeId] = useState('all');
  const [filter, setFilter] = useState<AttentionFilter>('all');
  const [runningOnly, setRunningOnly] = useState(false);
  const unreadCount = notifications.filter((entry) => entry.read !== true).length;
  const groups = projection?.executionGroups ?? [];
  const projectOverviews = projection?.projectOverviews ?? [];
  const selectedGroup = groups.find((group) => group.id === scopeId) ?? null;
  const selectedProject =
    projectOverviews.find(
      (project) => mobileProjectScopeId(project.projectPath) === scopeId,
    ) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const scopedAttention = useMemo(
    () =>
      (projection?.attentionItems ?? []).filter((item) => {
        if (selectedGroup && !attentionMatchesGroup(item, selectedGroup)) {
          return false;
        }
        if (
          selectedProject &&
          item.projectPath !== selectedProject.projectPath
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return attentionSearchText(item).includes(normalizedQuery);
      }),
    [
      normalizedQuery,
      projection?.attentionItems,
      selectedGroup,
      selectedProject,
    ],
  );
  const visibleAttention = scopedAttention.filter(
    (item) => filter === 'all' || item.kind === filter,
  );
  const visibleGroups = groups.filter((group) => {
    if (selectedGroup && group.id !== selectedGroup.id) return false;
    if (
      selectedProject &&
      group.projectPath !== selectedProject.projectPath
    ) {
      return false;
    }
    if (runningOnly && group.status !== 'running') return false;
    if (!normalizedQuery) return true;
    return groupSearchText(group).includes(normalizedQuery);
  });
  const filterCounts = Object.fromEntries(
    ATTENTION_FILTERS.map(({ id }) => [
      id,
      id === 'all'
        ? scopedAttention.length
        : scopedAttention.filter((item) => item.kind === id).length,
    ]),
  ) as Record<AttentionFilter, number>;
  const visibleFollowedCards = useMemo(() => {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    return (projection?.followedCardIds ?? [])
      .map((cardId) => cardsById.get(cardId))
      .filter((card): card is CardMeta => Boolean(card))
      .filter((card) => {
        if (selectedGroup && !cardMatchesGroup(card, selectedGroup)) return false;
        if (
          selectedProject &&
          card.projectPath !== selectedProject.projectPath
        ) {
          return false;
        }
        return (
          !normalizedQuery || cardSearchText(card).includes(normalizedQuery)
        );
      });
  }, [
    cards,
    normalizedQuery,
    projection?.followedCardIds,
    selectedGroup,
    selectedProject,
  ]);
  const visibleProjectOverviews = projectOverviews.filter(
    (project) =>
      scopeId === 'all' &&
      (!normalizedQuery ||
        `${project.projectName} ${project.projectPath}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );

  useEffect(() => {
    if (scopeId === 'all' || selectedGroup || selectedProject) return;
    setScopeId('all');
  }, [scopeId, selectedGroup, selectedProject]);

  const summary = projection?.summary ?? {
    attention: 0,
    normalRunning: 0,
    review: 0,
    failed: 0,
  };

  return (
    <main className="mobile-root-screen">
      <header className="mobile-page-header safe-top">
        <div className="mobile-header-row">
          <div className="mobile-header-title">
            <h1>{zh ? '工作台' : 'Workbench'}</h1>
            <span>
              <i
                className={`online-dot ${wsStatus === 'open' ? '' : 'offline'}`}
              />
              {connectionLabel(wsStatus, zh)}
            </span>
          </div>
          <div className="mobile-header-actions">
            <button
              className="mobile-icon-button"
              type="button"
              aria-label={zh ? '搜索' : 'Search'}
              aria-pressed={searchOpen}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <Search size={20} />
            </button>
            <button
              className="mobile-icon-button notification-button"
              type="button"
              aria-label={zh ? '通知' : 'Notifications'}
              onClick={onOpenNotifications}
            >
              <Bell size={20} />
              {unreadCount > 0 && (
                <span className="notification-badge">{unreadCount}</span>
              )}
            </button>
          </div>
        </div>
        <label className="scope-select">
          <FolderGit2 size={15} />
          <span className="sr-only">
            {zh ? '项目与 Worktree 范围' : 'Project and worktree scope'}
          </span>
          <select
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="all">
              {zh ? '全部项目与 Worktree' : 'All projects and worktrees'}
            </option>
            {projectOverviews.map((project) => (
              <option
                key={mobileProjectScopeId(project.projectPath)}
                value={mobileProjectScopeId(project.projectPath)}
              >
                {project.projectName} ·{' '}
                {zh ? '全部工作树' : 'All worktrees'}
              </option>
            ))}
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {mobileScopeOptionLabel(group, zh)}
              </option>
            ))}
          </select>
        </label>
        {searchOpen && (
          <label className="mobile-search-field">
            <Search size={16} />
            <span className="sr-only">
              {zh ? '搜索工作台' : 'Search workbench'}
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                zh
                  ? '搜索事项、项目或 Worktree'
                  : 'Search signals, projects or worktrees'
              }
            />
            {query && (
              <button
                type="button"
                aria-label={zh ? '清空搜索' : 'Clear search'}
                onClick={() => setQuery('')}
              >
                <X size={15} />
              </button>
            )}
          </label>
        )}
      </header>

      <ConnectionBanner wsStatus={wsStatus} />

      <div className="mobile-page-content">
        {!projection && (
          <CompatibilityState warmingUp={warmingUp} zh={zh} />
        )}

        <section
          className="summary-grid"
          aria-label={zh ? '状态摘要' : 'Status summary'}
        >
          <SummaryCard
            active={!runningOnly && filter === 'all'}
            icon={<CircleAlert size={17} />}
            label={zh ? '需要处理' : 'Needs action'}
            tone="attention"
            value={summary.attention}
            onClick={() => {
              setRunningOnly(false);
              setFilter('all');
            }}
          />
          <SummaryCard
            active={runningOnly}
            icon={<Play size={17} />}
            label={zh ? '正常运行' : 'Running'}
            tone="running"
            value={summary.normalRunning}
            onClick={() => setRunningOnly(true)}
          />
          <SummaryCard
            active={!runningOnly && filter === 'review'}
            icon={<Eye size={17} />}
            label={zh ? '待复核' : 'Review'}
            tone="review"
            value={summary.review}
            onClick={() => {
              setRunningOnly(false);
              setFilter('review');
            }}
          />
          <SummaryCard
            active={!runningOnly && filter === 'failed'}
            icon={<AlertTriangle size={17} />}
            label={zh ? '异常' : 'Failed'}
            tone="failed"
            value={summary.failed}
            onClick={() => {
              setRunningOnly(false);
              setFilter('failed');
            }}
          />
        </section>
        <p className="summary-overlap-note">
          {zh
            ? '状态维度可能重叠，不代表会话总数。'
            : 'Status dimensions may overlap.'}
        </p>

        <section className="mobile-section mobile-followed-section">
          <div className="mobile-section-heading">
            <h2>
              {zh ? '关注终端' : 'Followed terminals'}
              <span className="count-badge">
                {visibleFollowedCards.length}
              </span>
            </h2>
            <span className="section-note">
              {zh ? '桌面端管理' : 'Managed on desktop'}
            </span>
          </div>
          <div className="mobile-stack">
            {visibleFollowedCards.length > 0 ? (
              visibleFollowedCards.map((card) => (
                <FollowedTerminalCard
                  card={card}
                  disabled={wsStatus !== 'open'}
                  key={card.id}
                  onOpen={() => onOpenTerminal(card.id)}
                  zh={zh}
                />
              ))
            ) : (
              <WorkbenchEmptyState
                icon={<Bookmark size={22} />}
                title={
                  normalizedQuery
                    ? zh
                      ? '没有匹配的关注终端'
                      : 'No matching followed terminals'
                    : zh
                      ? '还没有关注终端'
                      : 'No followed terminals'
                }
                copy={
                  zh
                    ? '请在桌面端把高频终端加入工作台；移动端保持只读。'
                    : 'Add frequent terminals on desktop. Mobile remains read-only.'
                }
              />
            )}
          </div>
        </section>

        <section className="mobile-section" id="mobile-attention-section">
          <div className="mobile-section-heading">
            <h2>
              {zh ? '需要处理' : 'Needs action'}
              <span className="count-badge">{scopedAttention.length}</span>
            </h2>
            <button className="text-action" type="button" onClick={onOpenRules}>
              <SlidersHorizontal size={15} />
              {zh ? '规则' : 'Rules'}
            </button>
          </div>
          <div
            className="filter-chip-row"
            aria-label={zh ? '注意事项分类' : 'Signal filters'}
          >
            {ATTENTION_FILTERS.map((entry) => (
              <button
                key={entry.id}
                className="filter-chip"
                type="button"
                aria-pressed={filter === entry.id}
                onClick={() => {
                  setRunningOnly(false);
                  setFilter(entry.id);
                }}
              >
                {zh ? entry.zh : entry.en}
                <span>{filterCounts[entry.id]}</span>
              </button>
            ))}
          </div>
          <div className="mobile-stack">
            {visibleAttention.length > 0 ? (
              visibleAttention.map((item) => (
                <AttentionCard
                  item={item}
                  key={item.id}
                  onOpen={() => onOpenAttention(item.id)}
                  zh={zh}
                />
              ))
            ) : (
              <WorkbenchEmptyState
                icon={
                  projection ? (
                    <CheckCircle2 size={22} />
                  ) : (
                    <Clock3 size={22} />
                  )
                }
                title={
                  normalizedQuery
                    ? zh
                      ? '没有匹配结果'
                      : 'No matching signals'
                    : projection
                      ? zh
                        ? '当前无需处理'
                        : 'Nothing needs action'
                      : zh
                        ? '等待工作台投影'
                        : 'Waiting for workbench data'
                }
                copy={
                  normalizedQuery
                    ? zh
                      ? '尝试更换关键词或项目范围。'
                      : 'Try another keyword or scope.'
                    : zh
                      ? '需要介入的真实信号会集中显示在这里。'
                      : 'Actionable signals will appear here.'
                }
              />
            )}
          </div>
        </section>

        {scopeId === 'all' && projectOverviews.length > 0 && (
          <section
            className="mobile-section"
            id="mobile-project-overview-section"
          >
            <div className="mobile-section-heading">
              <h2>
                {zh ? '项目总览' : 'Project overview'}
                <span className="count-badge">
                  {visibleProjectOverviews.length}
                </span>
              </h2>
              <span className="section-note">
                {zh ? '稳定排序' : 'Stable order'}
              </span>
            </div>
            <div className="mobile-stack">
              {visibleProjectOverviews.length > 0 ? (
                visibleProjectOverviews.map((project) => (
                  <MobileProjectOverviewCard
                    key={project.projectPath}
                    onOpen={() =>
                      setScopeId(mobileProjectScopeId(project.projectPath))
                    }
                    project={project}
                    zh={zh}
                  />
                ))
              ) : (
                <WorkbenchEmptyState
                  icon={<FolderKanban size={22} />}
                  title={zh ? '没有匹配的项目' : 'No matching projects'}
                  copy={
                    zh ? '请更换搜索关键词。' : 'Try another search term.'
                  }
                />
              )}
            </div>
          </section>
        )}

        <section className="mobile-section" id="mobile-groups-section">
          <div className="mobile-section-heading">
            <h2>
              {zh ? '执行上下文' : 'Execution contexts'}
              <span className="count-badge">{visibleGroups.length}</span>
            </h2>
            <span className="section-note">
              {zh ? '项目 + Worktree' : 'Project + worktree'}
            </span>
          </div>
          <div className="mobile-stack">
            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) => (
                <ExecutionGroupCard
                  group={group}
                  key={group.id}
                  onOpen={() => onOpenGroup(group.id)}
                  zh={zh}
                />
              ))
            ) : (
              <WorkbenchEmptyState
                icon={<SquareTerminal size={22} />}
                title={
                  runningOnly
                    ? zh
                      ? '没有正常运行的上下文'
                      : 'No running contexts'
                    : zh
                      ? '还没有终端'
                      : 'No terminals yet'
                }
                copy={
                  zh
                    ? '终端会按项目与 Worktree 自动聚合。'
                    : 'Terminals are grouped by project and worktree.'
                }
                actionLabel={
                  !warmingUp && cards.length === 0
                    ? zh
                      ? '新建终端'
                      : 'New terminal'
                    : undefined
                }
                onAction={onOpenNewTerminal}
              />
            )}
          </div>
        </section>

        <div className="mobile-info-card">
          <strong>
            {zh ? '确定性监管视图' : 'Deterministic supervision'}
          </strong>
          <span>
            {zh
              ? '工作台只展示桌面端已有信号，不推测任务进度；处理操作始终在对应终端中完成。'
              : 'Workbench shows desktop signals without inventing progress. Actions stay in the terminal.'}
          </span>
        </div>
      </div>
    </main>
  );
}
