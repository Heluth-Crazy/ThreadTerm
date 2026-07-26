import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  FolderGit2,
  GitBranch,
  Play,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  CardMeta,
  MobileAttentionItem,
  MobileExecutionGroup,
  MobileWorkbenchProjection,
  NotificationEntry,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { ConnectionBanner } from '../ConnectionBanner';
import { useI18n } from '../i18n';

type AttentionFilter =
  | 'all'
  | 'approval'
  | 'waiting_input'
  | 'failed'
  | 'review'
  | 'stalled';

const ATTENTION_FILTERS: Array<{ id: AttentionFilter; zh: string; en: string }> = [
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'approval', zh: '审批', en: 'Approval' },
  { id: 'waiting_input', zh: '待输入', en: 'Input' },
  { id: 'failed', zh: '异常', en: 'Failed' },
  { id: 'review', zh: '待复核', en: 'Review' },
  { id: 'stalled', zh: '无进展', en: 'Stalled' },
];

export function WorkbenchScreen({
  cards,
  notifications,
  onOpenAttention,
  onOpenGroup,
  onOpenNewTerminal,
  onOpenNotifications,
  onOpenRules,
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
  const selectedGroup = groups.find((group) => group.id === scopeId) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const scopedAttention = useMemo(
    () =>
      (projection?.attentionItems ?? []).filter((item) => {
        if (selectedGroup && !attentionMatchesGroup(item, selectedGroup)) return false;
        if (!normalizedQuery) return true;
        return attentionSearchText(item).includes(normalizedQuery);
      }),
    [normalizedQuery, projection?.attentionItems, selectedGroup],
  );
  const visibleAttention = scopedAttention.filter(
    (item) => filter === 'all' || item.kind === filter,
  );
  const visibleGroups = groups.filter((group) => {
    if (selectedGroup && group.id !== selectedGroup.id) return false;
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
              <i className={`online-dot ${wsStatus === 'open' ? '' : 'offline'}`} />
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
              {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
            </button>
          </div>
        </div>
        <label className="scope-select">
          <FolderGit2 size={15} />
          <span className="sr-only">{zh ? '项目与 Worktree 范围' : 'Project and worktree scope'}</span>
          <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
            <option value="all">{zh ? '全部项目与 Worktree' : 'All projects and worktrees'}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.projectName} · {worktreeLabel(group)}
              </option>
            ))}
          </select>
        </label>
        {searchOpen && (
          <label className="mobile-search-field">
            <Search size={16} />
            <span className="sr-only">{zh ? '搜索工作台' : 'Search workbench'}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? '搜索事项、项目或 Worktree' : 'Search signals, projects or worktrees'}
            />
            {query && (
              <button type="button" aria-label={zh ? '清空搜索' : 'Clear search'} onClick={() => setQuery('')}>
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

        <section className="summary-grid" aria-label={zh ? '状态摘要' : 'Status summary'}>
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
          {zh ? '状态维度可能重叠，不代表会话总数。' : 'Status dimensions may overlap.'}
        </p>

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
          <div className="filter-chip-row" aria-label={zh ? '注意事项分类' : 'Signal filters'}>
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
                icon={projection ? <CheckCircle2 size={22} /> : <Clock3 size={22} />}
                title={
                  normalizedQuery
                    ? (zh ? '没有匹配结果' : 'No matching signals')
                    : projection
                      ? (zh ? '当前无需处理' : 'Nothing needs action')
                      : (zh ? '等待工作台投影' : 'Waiting for workbench data')
                }
                copy={
                  normalizedQuery
                    ? (zh ? '尝试更换关键词或项目范围。' : 'Try another keyword or scope.')
                    : (zh ? '需要介入的真实信号会集中显示在这里。' : 'Actionable signals will appear here.')
                }
              />
            )}
          </div>
        </section>

        <section className="mobile-section" id="mobile-groups-section">
          <div className="mobile-section-heading">
            <h2>
              {zh ? '执行上下文' : 'Execution contexts'}
              <span className="count-badge">{visibleGroups.length}</span>
            </h2>
            <span className="section-note">{zh ? '项目 + Worktree' : 'Project + worktree'}</span>
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
                title={runningOnly ? (zh ? '没有正常运行的上下文' : 'No running contexts') : (zh ? '还没有终端' : 'No terminals yet')}
                copy={zh ? '终端会按项目与 Worktree 自动聚合。' : 'Terminals are grouped by project and worktree.'}
                actionLabel={!warmingUp && cards.length === 0 ? (zh ? '新建终端' : 'New terminal') : undefined}
                onAction={onOpenNewTerminal}
              />
            )}
          </div>
        </section>

        <div className="mobile-info-card">
          <strong>{zh ? '确定性监管视图' : 'Deterministic supervision'}</strong>
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

export function AttentionDetailScreen({
  item,
  onBack,
  onOpenTerminal,
  terminalAvailable,
  wsStatus,
}: {
  item: MobileAttentionItem | null;
  onBack: () => void;
  onOpenTerminal: (cardId: string) => void;
  terminalAvailable: boolean;
  wsStatus: BridgeConnectionState;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  if (!item) {
    return (
      <DetailScaffold title={zh ? '事项详情' : 'Signal details'} onBack={onBack}>
        <WorkbenchEmptyState
          icon={<CircleAlert size={22} />}
          title={zh ? '事项已消失' : 'Signal no longer exists'}
          copy={zh ? '它可能已在桌面端处理，请返回刷新当前快照。' : 'It may have been handled on desktop.'}
        />
      </DetailScaffold>
    );
  }

  const desktopRequired = item.sourceKind === 'structured_request';
  const canOpen = terminalAvailable && wsStatus === 'open' && item.capability.openTerminal;

  return (
    <DetailScaffold
      title={zh ? '事项详情' : 'Signal details'}
      onBack={onBack}
      footer={
        <div className="detail-footer">
          {desktopRequired && (
            <div className="mobile-info-card warning">
              <strong>{zh ? '需要桌面端确认' : 'Desktop confirmation required'}</strong>
              <span>
                {zh
                  ? '移动 Bridge 暂不直接响应结构化审批，可打开终端查看上下文。'
                  : 'Mobile Bridge does not answer structured approvals directly.'}
              </span>
            </div>
          )}
          <button
            className="primary-full-button"
            type="button"
            disabled={!canOpen}
            onClick={() => onOpenTerminal(item.cardId)}
          >
            <SquareTerminal size={18} />
            {canOpen
              ? (zh ? '打开终端处理' : 'Open terminal')
              : (zh ? '当前无法打开终端' : 'Terminal unavailable')}
          </button>
        </div>
      }
    >
      <article className={`detail-hero severity-${item.severity}`}>
        <span className={`semantic-pill kind-${item.kind}`}>{attentionKindLabel(item.kind, zh)}</span>
        <h2>{item.title}</h2>
        {item.detail && <p>{item.detail}</p>}
        <div className="detail-grid">
          <DetailField label={zh ? '来源' : 'Source'} value={sourceLabel(item.sourceKind, zh)} />
          <DetailField label={zh ? '出现时间' : 'Occurred'} value={formatRelativeTime(item.occurredAt, zh)} />
          <DetailField label={zh ? '项目' : 'Project'} value={item.projectName} />
          <DetailField label="Worktree" value={item.branchLabel || pathLeaf(item.worktreePath || item.projectPath)} />
        </div>
        <div className="evidence-box">
          <strong>{zh ? '确定性原因' : 'Deterministic reason'}</strong>
          <span>{reasonLabel(item.reasonCode, zh)}</span>
        </div>
      </article>
      <div className="mobile-info-card">
        <strong>{zh ? '处理边界' : 'Action boundary'}</strong>
        <span>
          {zh
            ? '这里仅展示证据并导航，不执行批准、输入、重启或文件写入。'
            : 'This view provides evidence and navigation only.'}
        </span>
      </div>
    </DetailScaffold>
  );
}

export function ExecutionGroupDetailScreen({
  cards,
  group,
  onBack,
  onOpenAttention,
  onOpenTerminal,
  relatedAttention,
}: {
  cards: CardMeta[];
  group: MobileExecutionGroup | null;
  onBack: () => void;
  onOpenAttention: (id: string) => void;
  onOpenTerminal: (cardId: string) => void;
  relatedAttention: MobileAttentionItem[];
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  if (!group) {
    return (
      <DetailScaffold title={zh ? '执行上下文' : 'Execution context'} onBack={onBack}>
        <WorkbenchEmptyState
          icon={<GitBranch size={22} />}
          title={zh ? '执行上下文已消失' : 'Context no longer exists'}
          copy={zh ? '返回工作台刷新当前快照。' : 'Return to Workbench to refresh.'}
        />
      </DetailScaffold>
    );
  }
  const groupCards = group.cardIds
    .map((id) => cards.find((card) => card.id === id))
    .filter((card): card is CardMeta => Boolean(card));

  return (
    <DetailScaffold title={zh ? '执行上下文' : 'Execution context'} onBack={onBack}>
      <article className="detail-hero">
        <span className={`semantic-pill status-${group.status}`}>{groupStatusLabel(group.status, zh)}</span>
        <h2>{group.projectName}</h2>
        <p className="breakable-path">{group.projectPath}</p>
        <div className="detail-grid">
          <DetailField label="Worktree" value={worktreeLabel(group)} />
          <DetailField label={zh ? '最近活动' : 'Last activity'} value={formatRelativeTime(group.lastActivity, zh)} />
          <DetailField label={zh ? '终端数量' : 'Terminals'} value={String(group.terminalCount)} />
          <DetailField label={zh ? '需关注' : 'Attention'} value={String(group.attentionCount)} />
        </div>
        {group.preview && <div className="evidence-box">{group.preview}</div>}
      </article>

      {relatedAttention.length > 0 && (
        <section className="mobile-section">
          <div className="mobile-section-heading">
            <h2>{zh ? '相关事项' : 'Related signals'} <span className="count-badge">{relatedAttention.length}</span></h2>
          </div>
          <div className="mobile-stack">
            {relatedAttention.map((item) => (
              <AttentionCard key={item.id} item={item} zh={zh} onOpen={() => onOpenAttention(item.id)} />
            ))}
          </div>
        </section>
      )}

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <h2>{zh ? '终端' : 'Terminals'} <span className="count-badge">{groupCards.length}</span></h2>
        </div>
        <div className="mobile-list-card">
          {groupCards.length > 0 ? (
            groupCards.map((card) => (
              <button className="detail-terminal-row" type="button" key={card.id} onClick={() => onOpenTerminal(card.id)}>
                <SquareTerminal size={20} />
                <span>
                  <strong>{card.projectName || card.id}</strong>
                  <small>{card.terminalType || 'shell'} · {card.summaryLine || card.lastReplyPreview || card.projectPath}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          ) : (
            <WorkbenchEmptyState
              icon={<SquareTerminal size={22} />}
              title={zh ? '没有可见终端' : 'No visible terminals'}
              copy={zh ? '终端可能已关闭。' : 'The terminal may have been closed.'}
            />
          )}
        </div>
      </section>
    </DetailScaffold>
  );
}

export function NotificationsScreen({
  notifications,
  onBack,
  onOpenTerminal,
}: {
  notifications: NotificationEntry[];
  onBack: () => void;
  onOpenTerminal: (cardId: string) => void;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  return (
    <DetailScaffold title={zh ? '通知' : 'Notifications'} onBack={onBack}>
      <div className="mobile-info-card">
        <strong>{zh ? '通知与工作台已合流' : 'Notifications feed Workbench'}</strong>
        <span>
          {zh
            ? '已读状态由桌面端管理；移动端当前提供完整历史和终端导航。'
            : 'Read state is managed on desktop; mobile provides history and terminal navigation.'}
        </span>
      </div>
      {notifications.length > 0 ? (
        <div className="notification-list">
          {notifications.map((entry) => (
            <button
              className={`notification-row ${entry.read === true ? 'read' : ''}`}
              type="button"
              key={entry.id}
              onClick={() => onOpenTerminal(entry.cardId)}
            >
              <i className="notification-unread-dot" />
              <span>
                <strong>{entry.title || notificationKindLabel(entry.kind, zh)}</strong>
                <small>{entry.body || entry.message}</small>
                <time>{formatRelativeTime(entry.createdAt, zh)}</time>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <WorkbenchEmptyState
          icon={<Bell size={22} />}
          title={zh ? '没有通知' : 'No notifications'}
          copy={zh ? '新的完成、异常和等待信号会出现在这里。' : 'New completion, failure and waiting signals appear here.'}
        />
      )}
    </DetailScaffold>
  );
}

export function RulesScreen({
  onBack,
  projection,
}: {
  onBack: () => void;
  projection: MobileWorkbenchProjection | null;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const rules = projection?.rules;
  return (
    <DetailScaffold title={zh ? '注意力规则' : 'Attention rules'} onBack={onBack}>
      <div className="mobile-info-card warning">
        <strong>{zh ? '由桌面端同步' : 'Synced from desktop'}</strong>
        <span>
          {zh
            ? '移动端只读展示当前生效规则，避免形成第二套判断。'
            : 'Mobile shows the active rules read-only to avoid a second source of truth.'}
        </span>
      </div>
      {rules ? (
        <>
          <section className="mobile-settings-group">
            <h2>{zh ? '信号来源' : 'Signal sources'}</h2>
            <div className="mobile-settings-list">
              <RuleRow enabled={rules.includeWaiting} label={zh ? '等待用户操作' : 'Waiting for user'} />
              <RuleRow enabled={rules.includeFailed} label={zh ? '异常未恢复' : 'Unrecovered failure'} />
              <RuleRow enabled={rules.includeCompletedReview} label={zh ? '完成待复核' : 'Completed review'} />
              <RuleRow enabled={rules.stalledEnabled} label={zh ? '无进展' : 'Stalled'} />
            </div>
          </section>
          <div className="detail-grid">
            <DetailField label={zh ? '无进展阈值' : 'Stalled threshold'} value={`${rules.stalledThresholdMinutes} ${zh ? '分钟' : 'min'}`} />
            <DetailField label={zh ? '排除会话' : 'Excluded sessions'} value={String(rules.stalledExcludedCount)} />
          </div>
        </>
      ) : (
        <WorkbenchEmptyState
          icon={<SlidersHorizontal size={22} />}
          title={zh ? '规则尚未同步' : 'Rules not synced yet'}
          copy={zh ? '等待桌面端发送 Workbench 投影。' : 'Waiting for the desktop Workbench projection.'}
        />
      )}
    </DetailScaffold>
  );
}

export function DetailScaffold({
  children,
  footer,
  onBack,
  title,
  trailing,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  onBack: () => void;
  title: string;
  trailing?: React.ReactNode;
}) {
  const { language } = useI18n();
  return (
    <main className="mobile-detail-screen">
      <header className="mobile-detail-header safe-top">
        <button className="mobile-back-button" type="button" onClick={onBack}>
          <ChevronRight className="back-chevron" size={21} />
          {language === 'zh' ? '返回' : 'Back'}
        </button>
        <h1>{title}</h1>
        <div className="mobile-detail-trailing">{trailing}</div>
      </header>
      <div className={`mobile-detail-content ${footer ? 'with-footer' : ''}`}>{children}</div>
      {footer && <footer className="mobile-detail-footer safe-bottom">{footer}</footer>}
    </main>
  );
}

function SummaryCard({
  active,
  icon,
  label,
  onClick,
  tone,
  value,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone: string;
  value: number;
}) {
  return (
    <button
      className={`summary-card tone-${tone}`}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{label}{icon}</span>
      <strong>{value}</strong>
    </button>
  );
}

function AttentionCard({
  item,
  onOpen,
  zh,
}: {
  item: MobileAttentionItem;
  onOpen: () => void;
  zh: boolean;
}) {
  return (
    <button
      className={`mobile-attention-card severity-${item.severity} kind-${item.kind}`}
      type="button"
      onClick={onOpen}
    >
      <i className="severity-line" />
      <span className="attention-card-content">
        <span className="attention-card-topline">
          <span className="semantic-pill">{attentionKindLabel(item.kind, zh)}</span>
          <time>{formatRelativeTime(item.occurredAt, zh)}</time>
        </span>
        <strong>{item.title}</strong>
        <small>{item.detail || reasonLabel(item.reasonCode, zh)}</small>
        <span className="attention-card-meta">
          <FolderGit2 size={14} />
          {item.projectName} · {item.branchLabel || pathLeaf(item.worktreePath || item.projectPath)}
        </span>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

function ExecutionGroupCard({
  group,
  onOpen,
  zh,
}: {
  group: MobileExecutionGroup;
  onOpen: () => void;
  zh: boolean;
}) {
  return (
    <button className="execution-group-card" type="button" onClick={onOpen}>
      <span className="execution-group-head">
        <span className="execution-group-icon"><GitBranch size={19} /></span>
        <span>
          <strong>{group.projectName}</strong>
          <small>{worktreeLabel(group)}</small>
        </span>
        <ChevronRight size={17} />
      </span>
      <span className="execution-group-stats">
        <span className={`mini-status status-${group.status}`}>{groupStatusLabel(group.status, zh)}</span>
        <span>{group.terminalCount} {zh ? '个终端' : 'terminals'}</span>
        {group.attentionCount > 0 && <span className="needs-attention">{group.attentionCount} {zh ? '项需关注' : 'signals'}</span>}
        <span>{formatRelativeTime(group.lastActivity, zh)}</span>
      </span>
    </button>
  );
}

function WorkbenchEmptyState({
  actionLabel,
  copy,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  copy: string;
  icon: React.ReactNode;
  onAction?: () => void;
  title: string;
}) {
  return (
    <div className="workbench-empty-state">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

function CompatibilityState({ warmingUp, zh }: { warmingUp: boolean; zh: boolean }) {
  return (
    <div className="mobile-info-card warning">
      <strong>
        {warmingUp
          ? (zh ? '正在同步工作台' : 'Syncing Workbench')
          : (zh ? '桌面端尚未提供工作台投影' : 'Workbench projection unavailable')}
      </strong>
      <span>
        {warmingUp
          ? (zh ? '已建立连接，正在获取终端、通知和执行上下文快照。' : 'Connected and waiting for the recoverable snapshot.')
          : (zh ? '请更新桌面端；移动端不会从终端文本降级猜测状态。' : 'Update desktop; mobile will not infer state from terminal text.')}
      </span>
    </div>
  );
}

function RuleRow({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div className="mobile-settings-row static">
      <span><strong>{label}</strong></span>
      <span className={`readonly-switch ${enabled ? 'on' : ''}`} aria-label={`${label}: ${enabled ? 'on' : 'off'}`}>
        <i />
      </span>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <strong>{value || '—'}</strong>
    </div>
  );
}

function attentionMatchesGroup(item: MobileAttentionItem, group: MobileExecutionGroup): boolean {
  return (
    item.projectPath === group.projectPath &&
    (item.worktreePath || item.projectPath) === group.worktreePath
  );
}

function attentionSearchText(item: MobileAttentionItem): string {
  return [
    item.title,
    item.detail,
    item.projectName,
    item.projectPath,
    item.worktreePath,
    item.branchLabel,
    item.terminalType,
    item.reasonCode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function groupSearchText(group: MobileExecutionGroup): string {
  return [
    group.projectName,
    group.projectPath,
    group.worktreePath,
    group.branchLabel,
    group.preview,
    ...group.terminalTypes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function attentionKindLabel(kind: MobileAttentionItem['kind'], zh: boolean): string {
  const labels = {
    approval: zh ? '审批' : 'Approval',
    waiting_input: zh ? '待输入' : 'Input',
    failed: zh ? '异常' : 'Failed',
    review: zh ? '待复核' : 'Review',
    stalled: zh ? '无进展' : 'Stalled',
  };
  return labels[kind];
}

function groupStatusLabel(status: MobileExecutionGroup['status'], zh: boolean): string {
  const labels = {
    failed: zh ? '异常' : 'Failed',
    attention: zh ? '需关注' : 'Attention',
    stalled: zh ? '无进展' : 'Stalled',
    running: zh ? '正常运行' : 'Running',
    review: zh ? '待复核' : 'Review',
    idle: zh ? '空闲' : 'Idle',
  };
  return labels[status];
}

function sourceLabel(source: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    structured_request: ['结构化请求', 'Structured request'],
    supervisor_alert: ['Supervisor 信号', 'Supervisor signal'],
    notification: ['未读通知', 'Unread notification'],
    terminal_state: ['终端状态', 'Terminal state'],
  };
  const label = labels[source];
  return label ? label[zh ? 0 : 1] : source.replace(/_/g, ' ');
}

function reasonLabel(reason: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    structured_approval: ['结构化请求正在等待桌面端审批', 'A structured request awaits desktop approval'],
    structured_input: ['结构化请求正在等待用户输入', 'A structured request awaits user input'],
    supervisor_prompt: ['Supervisor 检测到需要用户介入', 'Supervisor detected required intervention'],
    waiting_state: ['终端状态明确为等待输入', 'Terminal state is waiting for input'],
    failed_state: ['终端已进入失败状态', 'Terminal entered a failed state'],
    completed_unread: ['终端已完成且结果仍未读', 'Terminal completed with an unread result'],
    stalled_running: ['运行中的终端超过阈值没有活动', 'Running terminal exceeded the inactivity threshold'],
  };
  const label = labels[reason];
  return label ? label[zh ? 0 : 1] : reason.replace(/_/g, ' ');
}

function notificationKindLabel(kind: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    waiting: ['等待输入', 'Waiting for input'],
    completed: ['已完成', 'Completed'],
    failed: ['终端异常', 'Terminal failed'],
    attention: ['需要关注', 'Needs attention'],
  };
  const label = labels[kind];
  return label ? label[zh ? 0 : 1] : kind.replace(/_/g, ' ');
}

function connectionLabel(status: BridgeConnectionState, zh: boolean): string {
  if (status === 'open') return zh ? '已连接桌面端' : 'Desktop connected';
  if (status === 'connecting' || status === 'reconnecting') {
    return zh ? '正在重新连接' : 'Reconnecting';
  }
  if (status === 'revoked') return zh ? '设备权限已失效' : 'Device access ended';
  return zh ? '离线快照' : 'Offline snapshot';
}

function worktreeLabel(group: MobileExecutionGroup): string {
  return group.branchLabel || pathLeaf(group.worktreePath || group.projectPath);
}

function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || '—';
}

function formatRelativeTime(timestamp: number, zh: boolean): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}
