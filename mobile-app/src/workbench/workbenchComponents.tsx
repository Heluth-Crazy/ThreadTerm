import {
  ChevronRight,
  FolderGit2,
  FolderKanban,
  GitBranch,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  CardMeta,
  MobileAttentionItem,
  MobileExecutionGroup,
  MobileProjectWorkbenchOverview,
} from '@shared/mobile/bridge/protocol';
import { useI18n } from '../i18n';
import {
  attentionKindLabel,
  formatRelativeTime,
  groupStatusLabel,
  mobileTerminalStatusLabel,
  pathLeaf,
  reasonLabel,
  worktreeLabel,
} from './workbenchPresentation';

export function DetailScaffold({
  children,
  footer,
  onBack,
  title,
  trailing,
}: {
  children: ReactNode;
  footer?: ReactNode;
  onBack: () => void;
  title: string;
  trailing?: ReactNode;
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
      <div className={`mobile-detail-content ${footer ? 'with-footer' : ''}`}>
        {children}
      </div>
      {footer && (
        <footer className="mobile-detail-footer safe-bottom">{footer}</footer>
      )}
    </main>
  );
}

export function SummaryCard({
  active,
  icon,
  label,
  onClick,
  tone,
  value,
}: {
  active: boolean;
  icon: ReactNode;
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
      <span>
        {label}
        {icon}
      </span>
      <strong>{value}</strong>
    </button>
  );
}

export function AttentionCard({
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
          <span className="semantic-pill">
            {attentionKindLabel(item.kind, zh)}
          </span>
          <time>{formatRelativeTime(item.occurredAt, zh)}</time>
        </span>
        <strong>{item.title}</strong>
        <small>{item.detail || reasonLabel(item.reasonCode, zh)}</small>
        <span className="attention-card-meta">
          <FolderGit2 size={14} />
          {item.projectName} ·{' '}
          {item.branchLabel || pathLeaf(item.worktreePath || item.projectPath)}
        </span>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

export function FollowedTerminalCard({
  card,
  disabled,
  onOpen,
  zh,
}: {
  card: CardMeta;
  disabled: boolean;
  onOpen: () => void;
  zh: boolean;
}) {
  return (
    <button
      className="mobile-followed-terminal-card"
      type="button"
      disabled={disabled}
      onClick={onOpen}
    >
      <span className="followed-terminal-icon">
        <SquareTerminal size={19} />
      </span>
      <span className="followed-terminal-copy">
        <span>
          <strong>{card.projectName || card.id}</strong>
          <span className={`status-badge status-badge-${card.status}`}>
            {mobileTerminalStatusLabel(card.status, zh)}
          </span>
        </span>
        <small>
          {card.branchLabel || pathLeaf(card.worktreePath || card.projectPath)}
          {' · '}
          {card.terminalType || 'shell'}
        </small>
        <span>
          {card.summaryLine || card.lastReplyPreview || card.projectPath}
        </span>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

export function MobileProjectOverviewCard({
  onOpen,
  project,
  zh,
}: {
  onOpen: () => void;
  project: MobileProjectWorkbenchOverview;
  zh: boolean;
}) {
  const metrics = [
    [zh ? '关注' : 'Followed', project.followedCount],
    [zh ? '运行' : 'Running', project.runningCount],
    [zh ? '处理' : 'Attention', project.attentionCount],
    [zh ? '复核' : 'Review', project.reviewCount],
    [zh ? '异常' : 'Failed', project.failedCount],
  ] as const;
  return (
    <button
      className="mobile-project-overview-card"
      type="button"
      onClick={onOpen}
    >
      <span className="project-overview-head">
        <span className="project-overview-icon">
          <FolderKanban size={19} />
        </span>
        <span>
          <strong>{project.projectName}</strong>
          <small>{project.projectPath}</small>
        </span>
        <ChevronRight size={17} />
      </span>
      <span className="project-overview-metrics">
        {metrics.map(([label, value]) => (
          <span key={label}>
            <strong>{value}</strong>
            <small>{label}</small>
          </span>
        ))}
      </span>
    </button>
  );
}

export function ExecutionGroupCard({
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
        <span className="execution-group-icon">
          <GitBranch size={19} />
        </span>
        <span>
          <strong>{group.projectName}</strong>
          <small>{worktreeLabel(group)}</small>
        </span>
        <ChevronRight size={17} />
      </span>
      <span className="execution-group-stats">
        <span className={`mini-status status-${group.status}`}>
          {groupStatusLabel(group.status, zh)}
        </span>
        <span>
          {group.terminalCount} {zh ? '个终端' : 'terminals'}
        </span>
        {group.attentionCount > 0 && (
          <span className="needs-attention">
            {group.attentionCount} {zh ? '项需关注' : 'signals'}
          </span>
        )}
        <span>{formatRelativeTime(group.lastActivity, zh)}</span>
      </span>
    </button>
  );
}

export function WorkbenchEmptyState({
  actionLabel,
  copy,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  copy: string;
  icon: ReactNode;
  onAction?: () => void;
  title: string;
}) {
  return (
    <div className="workbench-empty-state">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function CompatibilityState({
  warmingUp,
  zh,
}: {
  warmingUp: boolean;
  zh: boolean;
}) {
  return (
    <div className="mobile-info-card warning">
      <strong>
        {warmingUp
          ? zh
            ? '正在同步工作台'
            : 'Syncing Workbench'
          : zh
            ? '桌面端尚未提供工作台投影'
            : 'Workbench projection unavailable'}
      </strong>
      <span>
        {warmingUp
          ? zh
            ? '已建立连接，正在获取终端、通知和执行上下文快照。'
            : 'Connected and waiting for the recoverable snapshot.'
          : zh
            ? '请更新桌面端；移动端不会从终端文本降级猜测状态。'
            : 'Update desktop; mobile will not infer state from terminal text.'}
      </span>
    </div>
  );
}

export function RuleRow({
  enabled,
  label,
}: {
  enabled: boolean;
  label: string;
}) {
  return (
    <div className="mobile-settings-row static">
      <span>
        <strong>{label}</strong>
      </span>
      <span
        className={`readonly-switch ${enabled ? 'on' : ''}`}
        aria-label={`${label}: ${enabled ? 'on' : 'off'}`}
      >
        <i />
      </span>
    </div>
  );
}

export function DetailField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <strong>{value || '—'}</strong>
    </div>
  );
}
